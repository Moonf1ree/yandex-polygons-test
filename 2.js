"use strict";

const MOSCOW_CENTER = [55.751244, 37.618423];
const MOSCOW_ZOOM = 10.5; // дефолт, когда ни точки, ни контуров ещё нет
const POINT_ZOOM = 15; // применяется при первом появлении точки на карте
const STORAGE_KEY = "boundary-editor:snapshot";
const RING_VERTEX_LIMIT = 3; // после 3-й вершины контур завершается сам
const BOUNDARY_POLYGON_OPTIONS = {
  fillColor: "#2E7D3233",
  strokeColor: "#2E7D32",
  strokeWidth: 2,
};

/** Парсит число из строки, принимая как разделитель точку и запятую. */
function parseFlexibleNumber(raw) {
  if (typeof raw !== "string") return NaN;
  const normalized = raw.trim().replace(",", ".");
  if (normalized === "") return NaN;
  return Number(normalized);
}

/** Проверяет, является ли значение допустимой широтой. */
function isValidLat(value) {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= -90 &&
    value <= 90
  );
}

/** Проверяет, является ли значение допустимой долготой. */
function isValidLng(value) {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= -180 &&
    value <= 180
  );
}

/** Снимает дублирующую замыкающую точку, которой редактор Яндекса закрывает завершённые кольца. */
function dropClosingDuplicate(points) {
  if (points.length < 2) return points;
  const [firstLat, firstLng] = points[0];
  const [lastLat, lastLng] = points[points.length - 1];
  return firstLat === lastLat && firstLng === lastLng
    ? points.slice(0, -1)
    : points;
}

/**
 * Переводит внутренний формат колец ({ points: [[lat, lng], ...] }) в GeoJSON
 * Polygon/MultiPolygon (долгота, широта, RFC 7946) и обратно. Кольцо с
 * 1–2 точками — это ещё не area, а просто вершины; оно сериализуется как
 * незамкнутый массив координат и снова принимается при разборе.
 */
class GeoJsonCodec {
  /** Сериализует кольца в строку GeoJSON. */
  static ringsToGeoJson(rings, { includeIncomplete = false } = {}) {
    const usable = rings.filter(
      (r) => r.points.length >= (includeIncomplete ? 1 : 3),
    );
    const toCoords = (ring) =>
      ring.points.length >= 3
        ? GeoJsonCodec._ringToGeoCoords(ring)
        : ring.points.map(([lat, lng]) => [lng, lat]);
    const geometry =
      usable.length === 0
        ? { type: "MultiPolygon", coordinates: [] }
        : usable.length === 1
          ? { type: "Polygon", coordinates: [toCoords(usable[0])] }
          : {
              type: "MultiPolygon",
              coordinates: usable.map((r) => [toCoords(r)]),
            };
    return JSON.stringify(geometry, null, 2);
  }

  /** Разбирает строку GeoJSON в массив колец; бросает Error при невалидном вводе. */
  static geoJsonToRings(text) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new Error("Невалидный JSON: " + err.message);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Ожидался объект GeoJSON (Polygon или MultiPolygon)");
    }
    const { type, coordinates } = parsed;
    if (
      type === "MultiPolygon" &&
      Array.isArray(coordinates) &&
      coordinates.length === 0
    ) {
      return [];
    }
    if (!Array.isArray(coordinates)) {
      throw new Error("В GeoJSON отсутствует поле coordinates");
    }
    if (type === "Polygon") {
      if (coordinates.length === 0)
        throw new Error("Polygon не содержит ни одного кольца");
      return [{ points: GeoJsonCodec._geoRingToPoints(coordinates[0]) }];
    }
    if (type === "MultiPolygon") {
      return coordinates.map((polygon, index) => {
        if (!Array.isArray(polygon) || polygon.length === 0) {
          throw new Error(
            `Полигон №${index + 1} в MultiPolygon не содержит колец`,
          );
        }
        return { points: GeoJsonCodec._geoRingToPoints(polygon[0]) };
      });
    }
    throw new Error("Поддерживаются только типы Polygon и MultiPolygon");
  }

  /** Переводит кольцо во внутреннем формате в замкнутый GeoJSON-ring. */
  static _ringToGeoCoords(ring) {
    const coords = ring.points.map(([lat, lng]) => [lng, lat]);
    const first = coords[0];
    const last = coords[coords.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1])
      coords.push([first[0], first[1]]);
    return coords;
  }

  /** Переводит GeoJSON-ring во внутренний формат точек, снимая замыкание. Меньше 3 точек — не area, а просто вершины. */
  static _geoRingToPoints(geoRing) {
    if (!Array.isArray(geoRing) || geoRing.length === 0) {
      throw new Error("Кольцо должно содержать хотя бы одну точку");
    }
    const points = geoRing.map((pair, index) => {
      if (
        !Array.isArray(pair) ||
        pair.length < 2 ||
        typeof pair[0] !== "number" ||
        typeof pair[1] !== "number"
      ) {
        throw new Error(
          `Точка №${index + 1} должна быть парой чисел [долгота, широта]`,
        );
      }
      const [lng, lat] = pair;
      if (!isValidLat(lat) || !isValidLng(lng)) {
        throw new Error(
          `Точка №${index + 1} вне допустимого диапазона координат`,
        );
      }
      return [lat, lng];
    });
    const first = points[0];
    const last = points[points.length - 1];
    if (points.length > 1 && first[0] === last[0] && first[1] === last[1])
      points.pop();
    return points;
  }
}

/** Чтение и запись снимка (точка + GeoJSON) в localStorage. */
class StorageService {
  /** Загружает сохранённый снимок; возвращает null, если его нет или он повреждён. */
  static load() {
    let raw;
    try {
      raw = window.localStorage.getItem(STORAGE_KEY);
    } catch (err) {
      return null;
    }
    if (!raw) return null;
    try {
      const data = JSON.parse(raw);
      if (
        !data ||
        typeof data.lat !== "number" ||
        typeof data.lng !== "number" ||
        typeof data.geojson !== "string"
      ) {
        return null;
      }
      return data;
    } catch (err) {
      return null;
    }
  }

  /** Сохраняет снимок в localStorage. */
  static save(snapshot) {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
      return true;
    } catch (err) {
      return false;
    }
  }
}

/** Простая шина событий. */
class EventEmitter {
  constructor() {
    this._listeners = new Map();
  }

  /** Подписывает обработчик на событие; возвращает функцию отписки. */
  on(event, handler) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(handler);
    return () => this._listeners.get(event).delete(handler);
  }

  /** Оповещает всех подписчиков события. */
  emit(event, payload) {
    const handlers = this._listeners.get(event);
    if (!handlers) return;
    handlers.forEach((handler) => handler(payload));
  }
}

/**
 * Единый источник правды: текущая точка, черновик контуров и последний
 * сохранённый снимок. Редактирование контуров на карте (BoundaryMap)
 * пишет сюда через setRings; остальные компоненты только читают.
 */
class AppState extends EventEmitter {
  constructor() {
    super();
    this.point = null;
    this.rings = [];
    this.saved = null;
  }

  /** Устанавливает текущую точку. */
  setPoint(lat, lng, meta = {}) {
    if (!isValidLat(lat) || !isValidLng(lng)) return false;
    this.point = { lat, lng };
    this.emit("point-changed", { point: this.point, ...meta });
    return true;
  }

  /** Заменяет текущий черновик колец. */
  setRings(rings, meta = {}) {
    this.rings = rings.map((r) => ({ points: r.points.map((p) => p.slice()) }));
    this.emit("rings-changed", { rings: this.rings, ...meta });
  }

  /** Фиксирует текущую точку и черновик как сохранённый снимок, пишет его в localStorage. */
  save() {
    if (!this.point) return false;
    this.saved = {
      point: { ...this.point },
      rings: this.rings.map((r) => ({
        points: r.points.map((p) => p.slice()),
      })),
    };
    const persisted = StorageService.save({
      lat: this.saved.point.lat,
      lng: this.saved.point.lng,
      geojson: GeoJsonCodec.ringsToGeoJson(this.saved.rings, {
        includeIncomplete: true,
      }),
    });
    this.emit("saved-changed", { saved: this.saved });
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
      rings = [];
    }
    this.setPoint(snapshot.lat, snapshot.lng, { source: "load" });
    this.setRings(rings, { source: "load" });
    this.saved = {
      point: { ...this.point },
      rings: this.rings.map((r) => ({
        points: r.points.map((p) => p.slice()),
      })),
    };
    return true;
  }
}

/**
 * Верхняя карта: живая перетаскиваемая булавка (state.point, стандартная
 * иконка Яндекса) поверх статичной картинки последнего сохранённого
 * контура (state.saved).
 */
class PinMap {
  /** Создаёт карту и подписывает её на изменения состояния. */
  constructor(containerId, state) {
    this._state = state;
    this._map = new ymaps.Map(containerId, {
      center: MOSCOW_CENTER,
      zoom: MOSCOW_ZOOM,
      controls: ["zoomControl", "typeSelector"],
    });
    this._pin = null;
    this._savedContour = null;

    this._map.events.add("click", (e) => {
      const coords = e.get("coords");
      this._state.setPoint(coords[0], coords[1], { source: "pin-map" });
    });

    this._state.on("point-changed", (payload) => this._onPointChanged(payload));
    this._state.on("saved-changed", (payload) =>
      this._renderSavedContour(payload.saved),
    );
  }

  /** Создаёт или двигает булавку; при первом появлении точки приближает карту. */
  _onPointChanged({ point }) {
    if (!point) return;
    if (!this._pin) {
      this._pin = new ymaps.Placemark(
        [point.lat, point.lng],
        {},
        { draggable: true, preset: "islands#redDotIcon" },
      );
      this._pin.events.add("dragend", () => {
        const coords = this._pin.geometry.getCoordinates();
        this._state.setPoint(coords[0], coords[1], { source: "pin-map" });
      });
      this._map.geoObjects.add(this._pin);
      this._map.setZoom(POINT_ZOOM);
    } else {
      this._pin.geometry.setCoordinates([point.lat, point.lng]);
    }
    this._map.setCenter([point.lat, point.lng]);
  }

  /** Перерисовывает статичную картинку последнего сохранённого контура. */
  _renderSavedContour(saved) {
    if (this._savedContour) {
      this._map.geoObjects.remove(this._savedContour);
      this._savedContour = null;
    }
    const rings = (saved && saved.rings) || [];
    const exportable = rings.filter((r) => r.points.length >= 3);
    if (exportable.length === 0) return;

    // ymaps.GeoObject рисует геометрию только "простых" типов
    // (Point/LineString/Polygon/Rectangle/Circle), MultiPolygon напрямую не
    // поддерживает — поэтому несколько контуров рисуются отдельными
    // Polygon-объектами внутри GeoObjectCollection.
    this._savedContour = new ymaps.GeoObjectCollection(null, {
      fillColor: "#1E90FF33",
      strokeColor: "#1E90FF",
      strokeWidth: 2,
      interactivityModel: "default#opaque",
    });
    exportable.forEach((ring) => {
      this._savedContour.add(
        new ymaps.Polygon([ring.points.map((p) => p.slice())]),
      );
    });
    this._map.geoObjects.add(this._savedContour);
  }
}

/**
 * Нижняя карта: контуры границ (state.rings) строятся кликами по карте
 * собственной рукописной логикой, а не через ymaps.Polygon.editor.startDrawing().
 * Плюс неперетаскиваемая булавка по текущей точке — ориентир для обводки.
 *
 * Каждый контур — это "запись" (entry): { points, polygon, markers }.
 *   - Пока в контуре меньше RING_VERTEX_LIMIT вершин, это "черновик":
 *     каждая вершина — отдельный перетаскиваемый Placemark, полигона ещё
 *     нет. Клик по карте всегда достраивает именно такой, самый последний,
 *     черновик (а если его нет — создаёт новый).
 *   - Как только вершин становится ровно RING_VERTEX_LIMIT, черновик
 *     превращается в полноценный ymaps.Polygon в режиме редактирования
 *     (polygon.editor.startEditing()): вершины можно таскать мышью, но
 *     дальнейшие клики по карте на этот контур больше не влияют — они
 *     уходят в новый контур.
 *
 * «Стереть точку» всегда снимает последнюю вершину последнего непустого
 * контура. Если контур был готовым (RING_VERTEX_LIMIT вершин) и после
 * стирания стал короче, он возвращается в режим черновика — следующие
 * клики снова достраивают именно его, пока в нём опять не наберётся
 * RING_VERTEX_LIMIT точек. Иными словами, "черновик это или готовая
 * область" всегда решается одним числом — длиной массива точек контура,
 * а не отдельным флагом или состоянием редактора.
 */
class BoundaryMap {
  /** Создаёт карту и строит контуры из текущего состояния. */
  constructor(containerId, state) {
    this._state = state;
    this._map = new ymaps.Map(containerId, {
      center: MOSCOW_CENTER,
      zoom: MOSCOW_ZOOM,
      controls: ["zoomControl", "typeSelector"],
    });
    this._pin = null;
    this._entries = [];

    this._map.events.add("click", (e) => this._onMapClick(e));

    this._state.on("point-changed", (payload) => this._onPointChanged(payload));
    this._state.on("rings-changed", (payload) => {
      if (payload.source !== "boundary-map")
        this._rebuildFromRings(payload.rings);
    });

    this._rebuildFromRings(state.rings);
  }

  /** Создаёт или двигает ориентир-булавку; при первом появлении точки приближает карту. */
  _onPointChanged({ point }) {
    if (!point) return;
    if (!this._pin) {
      this._pin = new ymaps.Placemark(
        [point.lat, point.lng],
        {},
        { preset: "islands#redDotIcon" },
      );
      this._map.geoObjects.add(this._pin);
      this._map.setZoom(POINT_ZOOM);
    } else {
      this._pin.geometry.setCoordinates([point.lat, point.lng]);
    }
    this._map.setCenter([point.lat, point.lng]);
  }

  /** Клик по карте добавляет вершину в последний черновик (или начинает новый). */
  _onMapClick(e) {
    const coords = e.get("coords").slice();
    let entry = this._entries[this._entries.length - 1];
    if (!entry || entry.points.length >= RING_VERTEX_LIMIT) {
      entry = this._createDraftEntry();
      this._entries.push(entry);
    }
    entry.points.push(coords);
    if (entry.points.length >= RING_VERTEX_LIMIT) this._completeEntry(entry);
    else this._renderDraftEntry(entry);
    this._syncStateFromEntries();
  }

  /** Убирает последнюю вершину последнего непустого контура. */
  eraseLastVertex() {
    const entry = this._lastNonEmptyEntry();
    if (!entry) return;
    entry.points.pop();
    if (entry.points.length === 0) {
      this._removeEntry(entry);
    } else if (entry.points.length < RING_VERTEX_LIMIT) {
      // Готовая область перестала быть готовой — возвращаем в черновик,
      // чтобы следующий клик по карте снова достраивал именно её.
      this._revertEntryToDraft(entry);
    } else if (entry.polygon) {
      entry.polygon.geometry.setCoordinates([
        entry.points.map((p) => p.slice()),
      ]);
    } else {
      this._completeEntry(entry);
    }
    this._syncStateFromEntries();
  }

  /** Удаляет все контуры. */
  eraseAll() {
    this._entries.forEach((entry) => this._clearEntry(entry));
    this._entries = [];
    this._syncStateFromEntries();
  }

  /** Создаёт пустую запись контура. */
  _createDraftEntry() {
    return { points: [], polygon: null, markers: [] };
  }

  /** Перерисовывает черновой контур маркерами вершин (это ещё не area). */
  _renderDraftEntry(entry) {
    entry.markers.forEach((m) => this._map.geoObjects.remove(m));
    entry.markers = entry.points.map((point, index) => {
      const marker = new ymaps.Placemark(
        point.slice(),
        {},
        { draggable: true, preset: "islands#greenDotIcon" },
      );
      marker.events.add("dragend", () => {
        entry.points[index] = marker.geometry.getCoordinates().slice();
        this._syncStateFromEntries();
      });
      this._map.geoObjects.add(marker);
      return marker;
    });
  }

  /** Превращает черновик, набравший RING_VERTEX_LIMIT точек, в редактируемый полигон. */
  _completeEntry(entry) {
    entry.markers.forEach((m) => this._map.geoObjects.remove(m));
    entry.markers = [];
    entry.polygon = new ymaps.Polygon(
      [entry.points.map((p) => p.slice())],
      {},
      BOUNDARY_POLYGON_OPTIONS,
    );
    this._map.geoObjects.add(entry.polygon);
    entry.polygon.geometry.events.add("change", () => {
      entry.points = dropClosingDuplicate(
        (entry.polygon.geometry.getCoordinates()[0] || []).map((p) =>
          p.slice(),
        ),
      );
      this._syncStateFromEntries();
    });
    entry.polygon.editor.startEditing();
  }

  /** Возвращает готовый полигон обратно в черновик из маркеров вершин. */
  _revertEntryToDraft(entry) {
    if (entry.polygon) {
      entry.polygon.editor.stopEditing();
      this._map.geoObjects.remove(entry.polygon);
      entry.polygon = null;
    }
    this._renderDraftEntry(entry);
  }

  /** Снимает с карты и полигон, и маркеры записи (не трогая саму запись в массиве). */
  _clearEntry(entry) {
    entry.markers.forEach((m) => this._map.geoObjects.remove(m));
    if (entry.polygon) {
      entry.polygon.editor.stopEditing();
      this._map.geoObjects.remove(entry.polygon);
    }
  }

  /** Полностью убирает запись с карты и из списка контуров. */
  _removeEntry(entry) {
    this._clearEntry(entry);
    this._entries = this._entries.filter((e) => e !== entry);
  }

  /** Последний (по порядку создания) контур, у которого ещё есть вершины. */
  _lastNonEmptyEntry() {
    for (let i = this._entries.length - 1; i >= 0; i -= 1) {
      if (this._entries[i].points.length > 0) return this._entries[i];
    }
    return null;
  }

  /** Полностью пересоздаёт контуры на карте из массива колец состояния. */
  _rebuildFromRings(rings) {
    this._entries.forEach((entry) => this._clearEntry(entry));
    this._entries = rings
      .map((r) => r.points.map((p) => p.slice()))
      .filter((points) => points.length > 0)
      .map((points) => {
        const entry = this._createDraftEntry();
        entry.points = points;
        if (points.length >= RING_VERTEX_LIMIT) this._completeEntry(entry);
        else this._renderDraftEntry(entry);
        return entry;
      });
    this._syncStateFromEntries();
  }

  /** Читает текущие точки всех контуров и пишет их в состояние. */
  _syncStateFromEntries() {
    const rings = this._entries
      .filter((e) => e.points.length > 0)
      .map((e) => ({ points: e.points.map((p) => p.slice()) }));
    this._state.setRings(rings, { source: "boundary-map" });
  }
}

/** Связывает поля формы (координаты, GeoJSON, кнопки) с AppState и BoundaryMap. */
class UiController {
  /** Навешивает обработчики на форму и подписывается на состояние. */
  constructor(state, boundaryMap, elements) {
    this._state = state;
    this._boundaryMap = boundaryMap;
    this._el = elements;

    this._el.latInput.addEventListener("change", () =>
      this._onCoordsInputChanged(),
    );
    this._el.lngInput.addEventListener("change", () =>
      this._onCoordsInputChanged(),
    );
    this._el.geojsonText.addEventListener("input", () =>
      this._onGeojsonInputChanged(),
    );

    this._el.eraseVertexBtn.addEventListener("click", () =>
      this._boundaryMap.eraseLastVertex(),
    );
    this._el.eraseAllBtn.addEventListener("click", () =>
      this._boundaryMap.eraseAll(),
    );
    this._el.saveBtn.addEventListener("click", () => this._onSaveClicked());

    this._state.on("point-changed", (payload) =>
      this._onStatePointChanged(payload),
    );
    this._state.on("rings-changed", (payload) =>
      this._onStateRingsChanged(payload),
    );
  }

  /** Читает поля широты/долготы и обновляет точку в состоянии. */
  _onCoordsInputChanged() {
    const lat = parseFlexibleNumber(this._el.latInput.value);
    const lng = parseFlexibleNumber(this._el.lngInput.value);
    if (!isValidLat(lat) || !isValidLng(lng)) return;
    this._state.setPoint(lat, lng, { source: "inputs" });
  }

  /** Разбирает текст GeoJSON и обновляет контуры в состоянии либо показывает ошибку. */
  _onGeojsonInputChanged() {
    const text = this._el.geojsonText.value.trim();
    if (text === "") {
      this._setGeojsonError("");
      this._state.setRings([], { source: "textarea" });
      return;
    }
    try {
      const rings = GeoJsonCodec.geoJsonToRings(text);
      this._setGeojsonError("");
      this._state.setRings(rings, { source: "textarea" });
    } catch (err) {
      this._setGeojsonError(err.message);
    }
  }

  /** Обрабатывает нажатие кнопки «Сохранить». */
  _onSaveClicked() {
    if (!this._state.point) {
      this._setSaveStatus(
        "Сначала укажите точку на верхней карте или впишите координаты",
        true,
      );
      return;
    }
    const ok = this._state.save();
    this._setSaveStatus(
      ok ? "Сохранено" : "Не удалось сохранить в localStorage",
      !ok,
    );
  }

  /** Отражает изменение точки в полях широты/долготы. */
  _onStatePointChanged({ point, source }) {
    if (source === "inputs") return;
    this._el.latInput.value = point ? point.lat.toFixed(6) : "";
    this._el.lngInput.value = point ? point.lng.toFixed(6) : "";
  }

  /** Отражает изменение контуров в текстовом поле GeoJSON. */
  _onStateRingsChanged({ rings, source }) {
    if (source === "textarea") return;
    this._el.geojsonText.value = GeoJsonCodec.ringsToGeoJson(rings, {
      includeIncomplete: true,
    });
    this._setGeojsonError("");
  }

  /** Показывает или скрывает сообщение об ошибке разбора GeoJSON. */
  _setGeojsonError(message) {
    this._el.geojsonError.textContent = message;
    this._el.geojsonError.hidden = message === "";
  }

  /** Показывает статус операции сохранения. */
  _setSaveStatus(message, isError) {
    this._el.saveStatus.textContent = message;
    this._el.saveStatus.classList.toggle("status-error", Boolean(isError));
  }
}

/** Собирает состояние, карты и форму вместе и запускает приложение. */
class App {
  constructor() {
    this._state = new AppState();
  }

  /** Восстанавливает состояние, создаёт карты и форму, выполняет первичную отрисовку. */
  start() {
    this._state.restoreFromStorage();

    const pinMap = new PinMap("pin-map", this._state);
    const boundaryMap = new BoundaryMap("boundary-map", this._state);
    new UiController(this._state, boundaryMap, {
      latInput: document.getElementById("lat-input"),
      lngInput: document.getElementById("lng-input"),
      geojsonText: document.getElementById("geojson-text"),
      geojsonError: document.getElementById("geojson-error"),
      eraseVertexBtn: document.getElementById("erase-vertex-btn"),
      eraseAllBtn: document.getElementById("erase-all-btn"),
      saveBtn: document.getElementById("save-btn"),
      saveStatus: document.getElementById("save-status"),
    });

    if (this._state.point) {
      pinMap._onPointChanged({ point: this._state.point });
      boundaryMap._onPointChanged({ point: this._state.point });
      document.getElementById("lat-input").value =
        this._state.point.lat.toFixed(6);
      document.getElementById("lng-input").value =
        this._state.point.lng.toFixed(6);
    }
    if (this._state.saved) pinMap._renderSavedContour(this._state.saved);
    document.getElementById("geojson-text").value = GeoJsonCodec.ringsToGeoJson(
      this._state.rings,
      {
        includeIncomplete: true,
      },
    );
  }
}

ymaps.ready(() => new App().start());
