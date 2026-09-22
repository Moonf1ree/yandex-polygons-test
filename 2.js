'use strict';

/*
 * Редактор границ локации.
 *
 * Архитектура (SOLID/DRY, без сборщика — обычный скрипт, без модулей ES,
 * чтобы страница открывалась и по file://):
 *
 *  - GeoJsonCodec   — единственное место, где GeoJSON превращается в наш
 *                      внутренний формат колец и обратно (SRP).
 *  - RingOps        — чистые функции редактирования колец (добавить точку,
 *                      подвинуть вершину, стереть последнюю). Используются
 *                      и картой, и кнопками — одна логика, один источник
 *                      правды (DRY).
 *  - StorageService — чтение/запись снимка в localStorage.
 *  - EventEmitter    — простая шина событий.
 *  - AppState        — единственный источник правды о текущей точке,
 *                      черновике границ и последнем сохранённом снимке.
 *                      Всё остальное только реагирует на её события.
 *  - PinMap          — верхняя карта: живая булавка + статичная картинка
 *                      последнего сохранённого контура.
 *  - BoundaryMap     — нижняя карта: редактируемый черновик контуров.
 *  - UiController    — связывает поля/кнопки формы с AppState.
 *  - App             — точка сборки всего вместе.
 */

/* ============================== Константы ============================== */

// Ключ Яндекс.Карт указывается в 1.html, в src подключаемого <script> —
// см. TODO рядом с ним. Здесь он не нужен: к моменту выполнения этого файла
// API уже загружено с этим ключом.

const MOSCOW_CENTER = [55.751244, 37.618423]; // центр Москвы
const MOSCOW_ZOOM = 10; // примерно по границе МКАД
const ZOOM_AFTER_RESTORE = 15; // масштаб при восстановлении сохранённой точки

const STORAGE_KEY = 'boundary-editor:snapshot';

// Насколько близко (в пикселях экрана) нужно кликнуть к первой вершине
// кольца, чтобы замкнуть его и начать рисовать новый полигон.
const CLOSE_RING_PIXEL_DISTANCE = 12;

/* ============================== Утилиты ============================== */

/** Принимает "55,75" или "55.75" — в русской локали часто вводят запятую. */
function parseFlexibleNumber(raw) {
  if (typeof raw !== 'string') return NaN;
  const normalized = raw.trim().replace(',', '.');
  if (normalized === '') return NaN;
  return Number(normalized);
}

function isValidLat(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= -90 && value <= 90;
}

function isValidLng(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= -180 && value <= 180;
}

function cloneRing(ring) {
  return { points: ring.points.map((p) => p.slice()), closed: ring.closed };
}

function cloneRings(rings) {
  return rings.map(cloneRing);
}

/* ============================== GeoJsonCodec ============================== */

/**
 * Переводит наш внутренний формат колец (широта, долгота — порядок,
 * который использует Яндекс.Карты) в GeoJSON Polygon/MultiPolygon
 * (долгота, широта — порядок RFC 7946) и обратно.
 *
 * Внутреннее кольцо: { points: [[lat, lng], ...], closed: boolean }.
 * closed управляет только тем, продолжает ли клик по карте это кольцо —
 * на итоговый GeoJSON не влияет: экспортируются все кольца с 3+ точками.
 */
class GeoJsonCodec {
  static ringsToGeoJson(rings) {
    const exportable = rings.filter((r) => r.points.length >= 3);
    const geometry =
      exportable.length === 0
        ? { type: 'MultiPolygon', coordinates: [] }
        : exportable.length === 1
        ? { type: 'Polygon', coordinates: [GeoJsonCodec._ringToGeoCoords(exportable[0])] }
        : {
            type: 'MultiPolygon',
            coordinates: exportable.map((r) => [GeoJsonCodec._ringToGeoCoords(r)]),
          };
    return JSON.stringify(geometry, null, 2);
  }

  static geoJsonToRings(text) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new Error('Невалидный JSON: ' + err.message);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Ожидался объект GeoJSON (Polygon или MultiPolygon)');
    }
    const { type, coordinates } = parsed;
    if (type === 'MultiPolygon' && Array.isArray(coordinates) && coordinates.length === 0) {
      return [];
    }
    if (!Array.isArray(coordinates)) {
      throw new Error('В GeoJSON отсутствует поле coordinates');
    }
    if (type === 'Polygon') {
      if (coordinates.length === 0) throw new Error('Polygon не содержит ни одного кольца');
      return [{ points: GeoJsonCodec._geoRingToPoints(coordinates[0]), closed: true }];
    }
    if (type === 'MultiPolygon') {
      return coordinates.map((polygon, index) => {
        if (!Array.isArray(polygon) || polygon.length === 0) {
          throw new Error(`Полигон №${index + 1} в MultiPolygon не содержит колец`);
        }
        return { points: GeoJsonCodec._geoRingToPoints(polygon[0]), closed: true };
      });
    }
    throw new Error('Поддерживаются только типы Polygon и MultiPolygon');
  }

  static _ringToGeoCoords(ring) {
    const coords = ring.points.map(([lat, lng]) => [lng, lat]);
    const first = coords[0];
    const last = coords[coords.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) coords.push([first[0], first[1]]);
    return coords;
  }

  static _geoRingToPoints(geoRing) {
    if (!Array.isArray(geoRing) || geoRing.length < 3) {
      throw new Error('Кольцо полигона должно содержать не менее 3 точек');
    }
    const points = geoRing.map((pair, index) => {
      if (!Array.isArray(pair) || pair.length < 2 || typeof pair[0] !== 'number' || typeof pair[1] !== 'number') {
        throw new Error(`Точка №${index + 1} должна быть парой чисел [долгота, широта]`);
      }
      const [lng, lat] = pair;
      if (!isValidLat(lat) || !isValidLng(lng)) {
        throw new Error(`Точка №${index + 1} вне допустимого диапазона координат`);
      }
      return [lat, lng];
    });
    const first = points[0];
    const last = points[points.length - 1];
    if (points.length > 1 && first[0] === last[0] && first[1] === last[1]) points.pop();
    if (points.length < 3) throw new Error('Кольцо полигона должно содержать не менее 3 уникальных точек');
    return points;
  }
}

/* ============================== RingOps ============================== */

/**
 * Чистые функции редактирования колец. Не знают ни о карте, ни о DOM —
 * их использует и BoundaryMap (клики/перетаскивание), и кнопки формы.
 */
const RingOps = {
  /**
   * Добавляет точку в последнее незамкнутое кольцо либо начинает новое.
   * distanceToFirstVertexPx — функция (firstPoint) => расстояние в пикселях
   * от места клика до первой вершины активного кольца; если она достаточно
   * мала и в кольце уже есть минимум 3 точки, кольцо замыкается вместо
   * добавления новой точки.
   */
  addPoint(rings, point, distanceToFirstVertexPx) {
    const next = cloneRings(rings);
    const last = next[next.length - 1];
    if (!last || last.closed) {
      next.push({ points: [point], closed: false });
      return next;
    }
    if (last.points.length >= 3 && typeof distanceToFirstVertexPx === 'function') {
      const distance = distanceToFirstVertexPx(last.points[0]);
      if (distance !== null && distance <= CLOSE_RING_PIXEL_DISTANCE) {
        last.closed = true;
        return next;
      }
    }
    last.points.push(point);
    return next;
  },

  moveVertex(rings, ringIndex, vertexIndex, point) {
    const next = cloneRings(rings);
    if (next[ringIndex] && next[ringIndex].points[vertexIndex]) {
      next[ringIndex].points[vertexIndex] = point;
    }
    return next;
  },

  removeLastVertex(rings) {
    if (rings.length === 0) return rings;
    const next = cloneRings(rings);
    const last = next[next.length - 1];
    last.points.pop();
    last.closed = false;
    if (last.points.length === 0) next.pop();
    return next;
  },
};

/* ============================== StorageService ============================== */

class StorageService {
  static load() {
    let raw;
    try {
      raw = window.localStorage.getItem(STORAGE_KEY);
    } catch (err) {
      return null; // localStorage недоступен (приватный режим и т.п.)
    }
    if (!raw) return null;
    try {
      const data = JSON.parse(raw);
      if (
        !data ||
        typeof data.lat !== 'number' ||
        typeof data.lng !== 'number' ||
        typeof data.geojson !== 'string'
      ) {
        return null;
      }
      return data;
    } catch (err) {
      return null;
    }
  }

  static save(snapshot) {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
      return true;
    } catch (err) {
      return false;
    }
  }
}

/* ============================== EventEmitter ============================== */

class EventEmitter {
  constructor() {
    this._listeners = new Map();
  }

  on(event, handler) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(handler);
    return () => this._listeners.get(event).delete(handler);
  }

  emit(event, payload) {
    const handlers = this._listeners.get(event);
    if (!handlers) return;
    handlers.forEach((handler) => handler(payload));
  }
}

/* ============================== AppState ============================== */

/**
 * Единственный источник правды. Все компоненты меняют состояние только
 * через её методы и узнают об изменениях только через её события —
 * это исключает циклы обновлений между картами, полями и текстом.
 *
 * meta.source указывает, кто инициировал изменение ('pin-map',
 * 'boundary-map', 'inputs', 'textarea', 'buttons', 'load'), чтобы
 * инициатор не перерисовывал сам себя.
 */
class AppState extends EventEmitter {
  constructor() {
    super();
    this.point = null; // { lat, lng } | null
    this.rings = []; // черновик контуров, редактируется на нижней карте
    this.saved = null; // { point, rings } | null — последний сохранённый снимок
  }

  setPoint(lat, lng, meta = {}) {
    if (!isValidLat(lat) || !isValidLng(lng)) return false;
    this.point = { lat, lng };
    this.emit('point-changed', { point: this.point, ...meta });
    return true;
  }

  setRings(rings, meta = {}) {
    this.rings = cloneRings(rings);
    this.emit('rings-changed', { rings: this.rings, ...meta });
  }

  eraseLastVertex(meta = {}) {
    this.setRings(RingOps.removeLastVertex(this.rings), meta);
  }

  eraseAll(meta = {}) {
    this.setRings([], meta);
  }

  /** Фиксирует текущую точку и черновик как сохранённый снимок. */
  save() {
    if (!this.point) return false;
    this.saved = { point: { ...this.point }, rings: cloneRings(this.rings) };
    const persisted = StorageService.save({
      lat: this.saved.point.lat,
      lng: this.saved.point.lng,
      geojson: GeoJsonCodec.ringsToGeoJson(this.saved.rings),
    });
    this.emit('saved-changed', { saved: this.saved });
    return persisted;
  }

  /** Восстанавливает состояние из localStorage, если снимок есть. */
  restoreFromStorage() {
    const snapshot = StorageService.load();
    if (!snapshot) return false;
    let rings = [];
    try {
      rings = GeoJsonCodec.geoJsonToRings(snapshot.geojson);
    } catch (err) {
      rings = []; // повреждённый снимок — не роняем страницу
    }
    this.setPoint(snapshot.lat, snapshot.lng, { source: 'load' });
    this.setRings(rings, { source: 'load' });
    this.saved = { point: { ...this.point }, rings: cloneRings(rings) };
    this.emit('saved-changed', { saved: this.saved });
    return true;
  }
}

/* ============================== PinMap (верхняя карта) ============================== */

/**
 * «Где это место»: живая перетаскиваемая булавка (state.point) поверх
 * статичной картинки последнего сохранённого контура (state.saved).
 */
class PinMap {
  constructor(containerId, state) {
    this._state = state;
    this._map = new ymaps.Map(containerId, {
      center: MOSCOW_CENTER,
      zoom: MOSCOW_ZOOM,
      controls: ['zoomControl', 'typeSelector'],
    });
    this._pin = null;
    this._savedContour = null;

    this._map.events.add('click', (e) => {
      const coords = e.get('coords');
      this._state.setPoint(coords[0], coords[1], { source: 'pin-map' });
    });

    this._state.on('point-changed', (payload) => this._onPointChanged(payload));
    this._state.on('saved-changed', (payload) => this._renderSavedContour(payload.saved));
  }

  _onPointChanged({ point }) {
    if (!point) return;
    if (!this._pin) {
      this._pin = new ymaps.Placemark(
        [point.lat, point.lng],
        {},
        { draggable: true, preset: 'islands#redDotIcon' }
      );
      this._pin.events.add('dragend', () => {
        const coords = this._pin.geometry.getCoordinates();
        this._state.setPoint(coords[0], coords[1], { source: 'pin-map' });
      });
      this._map.geoObjects.add(this._pin);
    } else {
      // Координаты выставляем безусловно, вне зависимости от источника
      // изменения: перерисовка — не источник новых событий состояния,
      // зациклиться здесь нечем (в отличие от полей ввода/текста).
      this._pin.geometry.setCoordinates([point.lat, point.lng]);
    }
    this._map.setCenter([point.lat, point.lng]);
  }

  _renderSavedContour(saved) {
    if (this._savedContour) {
      this._map.geoObjects.remove(this._savedContour);
      this._savedContour = null;
    }
    const rings = (saved && saved.rings) || [];
    const exportable = rings.filter((r) => r.points.length >= 3);
    if (exportable.length === 0) return;

    const toClosedYandexRing = (ring) => {
      const coords = ring.points.map((p) => p.slice());
      const first = coords[0];
      const last = coords[coords.length - 1];
      if (first[0] !== last[0] || first[1] !== last[1]) coords.push(first.slice());
      return coords;
    };

    const geometry =
      exportable.length === 1
        ? { type: 'Polygon', coordinates: [toClosedYandexRing(exportable[0])] }
        : { type: 'MultiPolygon', coordinates: exportable.map((r) => [toClosedYandexRing(r)]) };

    this._savedContour = new ymaps.GeoObject(
      { geometry },
      {
        fillColor: '#1E90FF33',
        strokeColor: '#1E90FF',
        strokeWidth: 2,
        interactivityModel: 'default#opaque',
      }
    );
    this._map.geoObjects.add(this._savedContour);
  }
}

/* ============================== BoundaryMap (нижняя карта) ============================== */

/**
 * «Чья это земля»: редактируемые контуры (state.rings) плюс
 * неперетаскиваемая булавка по текущей точке — ориентир для обводки.
 */
class BoundaryMap {
  constructor(containerId, state) {
    this._state = state;
    this._map = new ymaps.Map(containerId, {
      center: MOSCOW_CENTER,
      zoom: MOSCOW_ZOOM,
      controls: ['zoomControl', 'typeSelector'],
    });
    this._pin = null;
    this._shapes = []; // ymaps.Polygon / Polyline для колец
    this._vertexMarks = []; // ymaps.Placemark для вершин

    this._map.events.add('click', (e) => {
      // Игнорируем клики, которые на самом деле попали в вершину/полигон,
      // а не в пустое место карты — иначе перетаскивание вершины добавит лишнюю точку.
      if (e.get('target') !== this._map) return;
      const coords = e.get('coords');
      const point = [coords[0], coords[1]];
      const distanceToFirstVertexPx = (firstPoint) => {
        const clickPx = this._map.converter.globalToPage(this._map.converter.geoToGlobal(coords));
        const firstPx = this._map.converter.globalToPage(this._map.converter.geoToGlobal(firstPoint));
        const dx = clickPx[0] - firstPx[0];
        const dy = clickPx[1] - firstPx[1];
        return Math.sqrt(dx * dx + dy * dy);
      };
      const nextRings = RingOps.addPoint(this._state.rings, point, distanceToFirstVertexPx);
      this._state.setRings(nextRings, { source: 'boundary-map' });
    });

    this._state.on('point-changed', (payload) => this._onPointChanged(payload));
    this._state.on('rings-changed', (payload) => {
      if (payload.source === 'boundary-map') return; // уже отрисовано локально
      this._renderRings(payload.rings);
    });
  }

  _onPointChanged({ point }) {
    if (!point) return;
    if (!this._pin) {
      this._pin = new ymaps.Placemark([point.lat, point.lng], {}, { preset: 'islands#redDotIcon' });
      this._map.geoObjects.add(this._pin);
    } else {
      this._pin.geometry.setCoordinates([point.lat, point.lng]);
    }
    this._map.setCenter([point.lat, point.lng]);
  }

  _renderRings(rings) {
    this._shapes.forEach((shape) => this._map.geoObjects.remove(shape));
    this._vertexMarks.forEach((mark) => this._map.geoObjects.remove(mark));
    this._shapes = [];
    this._vertexMarks = [];

    rings.forEach((ring, ringIndex) => {
      if (ring.points.length === 0) return;

      if (ring.points.length >= 3) {
        const shape = new ymaps.Polygon(
          [ring.points.map((p) => p.slice())],
          {},
          { fillColor: '#2E7D3233', strokeColor: '#2E7D32', strokeWidth: 2 }
        );
        this._map.geoObjects.add(shape);
        this._shapes.push(shape);
      } else if (ring.points.length === 2) {
        const shape = new ymaps.Polyline(
          ring.points.map((p) => p.slice()),
          {},
          { strokeColor: '#2E7D32', strokeWidth: 2 }
        );
        this._map.geoObjects.add(shape);
        this._shapes.push(shape);
      }

      ring.points.forEach((point, vertexIndex) => {
        const mark = new ymaps.Placemark(
          point.slice(),
          {},
          { draggable: true, preset: 'islands#greenCircleIcon' }
        );
        mark.events.add('dragend', () => {
          const coords = mark.geometry.getCoordinates();
          const nextRings = RingOps.moveVertex(this._state.rings, ringIndex, vertexIndex, [
            coords[0],
            coords[1],
          ]);
          this._state.setRings(nextRings, { source: 'boundary-map' });
        });
        this._map.geoObjects.add(mark);
        this._vertexMarks.push(mark);
      });
    });
  }
}

/* ============================== UiController ============================== */

/** Связывает поля формы (координаты, GeoJSON, кнопки) с AppState. */
class UiController {
  constructor(state, elements) {
    this._state = state;
    this._el = elements;

    this._el.latInput.addEventListener('change', () => this._onCoordsInputChanged());
    this._el.lngInput.addEventListener('change', () => this._onCoordsInputChanged());
    this._el.geojsonText.addEventListener('input', () => this._onGeojsonInputChanged());

    this._el.eraseVertexBtn.addEventListener('click', () => {
      this._state.eraseLastVertex({ source: 'buttons' });
    });
    this._el.eraseAllBtn.addEventListener('click', () => {
      this._state.eraseAll({ source: 'buttons' });
    });
    this._el.saveBtn.addEventListener('click', () => this._onSaveClicked());

    this._state.on('point-changed', (payload) => this._onStatePointChanged(payload));
    this._state.on('rings-changed', (payload) => this._onStateRingsChanged(payload));
  }

  _onCoordsInputChanged() {
    const lat = parseFlexibleNumber(this._el.latInput.value);
    const lng = parseFlexibleNumber(this._el.lngInput.value);
    if (!isValidLat(lat) || !isValidLng(lng)) return; // ждём, пока оба поля станут валидны
    this._state.setPoint(lat, lng, { source: 'inputs' });
  }

  _onGeojsonInputChanged() {
    const text = this._el.geojsonText.value.trim();
    if (text === '') {
      this._setGeojsonError('');
      this._state.setRings([], { source: 'textarea' });
      return;
    }
    try {
      const rings = GeoJsonCodec.geoJsonToRings(text);
      this._setGeojsonError('');
      this._state.setRings(rings, { source: 'textarea' });
    } catch (err) {
      this._setGeojsonError(err.message);
      // нижняя карта и state.rings намеренно не трогаются — держим последний валидный контур
    }
  }

  _onSaveClicked() {
    if (!this._state.point) {
      this._setSaveStatus('Сначала укажите точку на верхней карте или впишите координаты', true);
      return;
    }
    const ok = this._state.save();
    this._setSaveStatus(ok ? 'Сохранено' : 'Не удалось сохранить в localStorage', !ok);
  }

  _onStatePointChanged({ point, source }) {
    if (source === 'inputs') return; // поле уже содержит то, что ввёл человек
    this._el.latInput.value = point ? point.lat.toFixed(6) : '';
    this._el.lngInput.value = point ? point.lng.toFixed(6) : '';
  }

  _onStateRingsChanged({ rings, source }) {
    if (source === 'textarea') return; // не перезаписываем то, что человек сейчас печатает
    this._el.geojsonText.value = GeoJsonCodec.ringsToGeoJson(rings);
    this._setGeojsonError('');
  }

  _setGeojsonError(message) {
    this._el.geojsonError.textContent = message;
    this._el.geojsonError.hidden = message === '';
  }

  _setSaveStatus(message, isError) {
    this._el.saveStatus.textContent = message;
    this._el.saveStatus.classList.toggle('status-error', Boolean(isError));
  }
}

/* ============================== App ============================== */

class App {
  constructor() {
    this._state = new AppState();
  }

  start() {
    const restored = this._state.restoreFromStorage();

    const pinMap = new PinMap('pin-map', this._state);
    const boundaryMap = new BoundaryMap('boundary-map', this._state);
    const ui = new UiController(this._state, {
      latInput: document.getElementById('lat-input'),
      lngInput: document.getElementById('lng-input'),
      geojsonText: document.getElementById('geojson-text'),
      geojsonError: document.getElementById('geojson-error'),
      eraseVertexBtn: document.getElementById('erase-vertex-btn'),
      eraseAllBtn: document.getElementById('erase-all-btn'),
      saveBtn: document.getElementById('save-btn'),
      saveStatus: document.getElementById('save-status'),
    });

    // Первичная отрисовка формы/карт из восстановленного (или пустого) состояния.
    if (restored) {
      pinMap._map.setZoom(ZOOM_AFTER_RESTORE, { checkZoomRange: true });
      boundaryMap._map.setZoom(ZOOM_AFTER_RESTORE, { checkZoomRange: true });
    }
    document.getElementById('geojson-text').value = GeoJsonCodec.ringsToGeoJson(this._state.rings);
    if (this._state.point) {
      document.getElementById('lat-input').value = this._state.point.lat.toFixed(6);
      document.getElementById('lng-input').value = this._state.point.lng.toFixed(6);
    }
    // Достроить редактируемый контур и сохранённую картинку по восстановленным данным.
    boundaryMap._renderRings(this._state.rings);
    if (this._state.saved) pinMap._renderSavedContour(this._state.saved);
  }
}

ymaps.ready(() => new App().start());
