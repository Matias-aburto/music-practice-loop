/**
 * Práctica de audio — herramienta de estudio en el navegador
 * ------------------------------------------------------------
 * Secciones: config y DOM → utilidades → motores de reproducción → bucles y regiones → arranque
 */

import {
  ADVANCED_UI_STORAGE_KEY,
  MIDI_GLOBAL_ACTION_PLAY_PAUSE,
  MIDI_GLOBAL_ACTION_SPEED_PERCENT_KNOB,
  formatMidiBindingLabel,
  midiNoteBindingKey,
  midiCcBindingKey,
  readGlobalMidiBindings,
} from "./midi-common.js";
import {
  expandMidiDataToVoiceMessages,
  midiPortMapToArray,
  updateMidiStatusFromAccess,
  isWebMidiBlockedByContext,
  midiBytesToHexPreview,
} from "./midi-device.js";
import { t } from "./i18n.js";
import {
  clearLastLoadedTrack,
  persistLastLoadedTrack,
  readLastLoadedTrackAsFile,
} from "./last-track-session.js";

// =============================================================================
// CONFIG
// =============================================================================

/** CDN for pitch-preserving engine (ESM). Falls back to WaveSurfer playbackRate if import fails. */
const SOUNDTOUCH_MODULE =
  "https://cdn.jsdelivr.net/npm/soundtouchjs@0.1.30/dist/soundtouch.js";

/** Small time fudge (seconds) so loop wrap happens before the playhead overshoots the window. */
const LOOP_WRAP_EPSILON = 0.04;

/** When looping the tail of the file, jump slightly after loop start to reduce boundary clicks. */
const LOOP_SEEK_INSET = 0.002;

/** Tramo mínimo (s) al acotar el bucle para que los tiradores del region sean usables. */
const LOOP_UI_MIN_SEC = 0.45;

/** Objetivo de ancho (s) al activar bucle con toda la pista seleccionada (se acota al duración). */
const LOOP_UI_TARGET_WIDTH_SEC = 8;

/** Color de la región del bucle sobre el waveform (verdoso, solo si el bucle está activo). */
const LOOP_REGION_COLOR_ACTIVE = "rgba(52, 211, 168, 0.48)";

/**
 * Tiradores del bucle: WaveSurfer usa 2px por defecto; ensanchamos la zona clicable (handleStyle del plugin regions).
 */
const LOOP_REGION_HANDLE_STYLE = {
  left: {
    width: "14px",
    backgroundColor: "rgba(15, 18, 24, 0.72)",
  },
  right: {
    width: "14px",
    backgroundColor: "rgba(15, 18, 24, 0.72)",
  },
};

/** Parámetros de región al dibujar un tramo con el ratón (solo con bucle activo). */
const LOOP_DRAG_SELECTION_PARAMS = {
  color: LOOP_REGION_COLOR_ACTIVE,
  drag: true,
  resize: true,
  handleStyle: LOOP_REGION_HANDLE_STYLE,
};

/** Horizontal zoom of the waveform (WaveSurfer `minPxPerSec`). */
const ZOOM_MIN = 12;
const ZOOM_MAX = 480;
/** Zoom inicial: el mínimo (vista más alejada, menos px/s). */
const ZOOM_DEFAULT = ZOOM_MIN;
const ZOOM_FACTOR_STEP = 1.22;

/** localStorage key for saved loop presets per audio file. */
const LOOP_PRESETS_STORAGE_KEY = "music-practice-loop-presets-v1";

/** Per-file MIDI note bindings: fileKey → { "n-ch-note": presetId }. */
const MIDI_BINDINGS_STORAGE_KEY = "music-practice-midi-bindings-v1";

/** Minimum loop length (seconds) to allow saving as a preset. */
const MIN_PRESET_LOOP_SECONDS = 0.08;

/** Rango de velocidad para control continuo MIDI (%). */
const MIDI_SPEED_PERCENT_MIN = 50;
const MIDI_SPEED_PERCENT_MAX = 150;

/**
 * True while `refreshLoopRegion` is adding a region so we do not clear the active preset id.
 * @type {boolean}
 */
let regionProgrammaticUpdate = false;

// =============================================================================
// DOM REFERENCES
// =============================================================================

const el = {
  appRoot: document.querySelector(".app"),
  waveformPanelMain: document.getElementById("waveform-panel-main"),
  sessionRestoreSkeleton: document.getElementById("session-restore-skeleton"),
  fileInput: document.getElementById("file-input"),
  fileName: document.getElementById("file-name"),
  engineHint: document.getElementById("engine-hint"),
  waveform: document.getElementById("waveform"),
  waveformTimeline: document.getElementById("waveform-timeline"),
  zoomSlider: document.getElementById("zoom-slider"),
  btnZoomIn: document.getElementById("btn-zoom-in"),
  btnZoomOut: document.getElementById("btn-zoom-out"),
  chkFollowPlayhead: document.getElementById("chk-follow-playhead"),
  btnPlay: document.getElementById("btn-play"),
  loopActiveIndicator: document.getElementById("loop-active-indicator"),
  timeCurrent: document.getElementById("time-current"),
  timeTotal: document.getElementById("time-total"),
  loopIntervalReadout: document.getElementById("loop-interval-readout"),
  loopIntervalStart: document.getElementById("loop-interval-start"),
  loopIntervalEnd: document.getElementById("loop-interval-end"),
  speedKnobInput: document.getElementById("speed-knob-input"),
  speedKnobIndicator: document.getElementById("speed-knob-indicator"),
  speedKnobReadout: document.getElementById("speed-knob-readout"),
  loopStatus: document.getElementById("loop-status"),
  loopPresetLabel: document.getElementById("loop-preset-label"),
  btnSaveLoop: document.getElementById("btn-save-loop"),
  savedLoopsList: document.getElementById("saved-loops-list"),
  savedLoopsEmpty: document.getElementById("saved-loops-empty"),
  midiLearnDialog: document.getElementById("midi-learn-dialog"),
  midiLearnTitle: document.getElementById("midi-learn-title"),
  midiLearnBody: document.getElementById("midi-learn-body"),
  midiLearnHint: document.getElementById("midi-learn-hint"),
  btnMidiLearnCancel: document.getElementById("btn-midi-learn-cancel"),
};

// =============================================================================
// APP STATE
// =============================================================================

const state = {
  /** @type {'idle'|'pitch'|'simple'} */
  engine: "idle",
  wavesurfer: null,
  /** @type {AudioContext|null} */
  audioContext: null,
  /** @type {object|null} SoundTouch PitchShifter instance when engine === 'pitch' */
  pitchShifter: null,
  /** @type {File|null} */
  currentFile: null,
  /** @type {string|null} */
  blobUrl: null,
  duration: 0,
  loopStart: 0,
  loopEnd: 0,
  loopEnabled: false,
  /** Playback speed factor (0.5 … 1.5) */
  speed: 1,
  isPlaying: false,
  /** rAF handle for pitch-mode UI sync */
  rafId: 0,
  /** rAF handle for MediaElement mode (time + loop + cursor) */
  simpleRafId: 0,
  /** Last applied saved preset id (highlight in list); cleared when loop is edited manually. */
  activeSavedLoopId: null,
};

let midiAccess = null;
/** True while the learn dialog is open and waiting for the first note. */
let midiLearnWaiting = false;
/** @type {{ input: MIDIInput, handler: (e: Event) => void }[]} */
const midiInputBindings = [];

/** Last trigger time per binding key (debounce duplicate Note On). */
const midiLastTriggerMs = new Map();
const MIDI_TRIGGER_DEBOUNCE_MS = 180;

/** Reintentos de enumeración tras permiso (Windows a veces publica puertos unos ms después). */
let midiRewireTimeoutIds = [];

/** @type {{ kind: 'loop'; presetId?: string }} */
let midiLearnContext = { kind: "loop" };

// =============================================================================
// UTILITIES
// =============================================================================

/**
 * Format seconds as m:ss for display.
 * @param {number} sec
 * @returns {string}
 */
function formatTime(sec) {
  if (!isFinite(sec) || sec < 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** `mm:ss` con ceros a la izquierda (contador principal junto al play). */
function formatTransportTime(sec) {
  if (!isFinite(sec) || sec < 0) return "00:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/**
 * Ensure loopStart <= loopEnd; swap if needed and return a user-facing message if we fixed it.
 * @returns {string|null} warning text or null
 */
function normalizeLoopBounds() {
  if (state.loopEnd < state.loopStart) {
    const t = state.loopStart;
    state.loopStart = state.loopEnd;
    state.loopEnd = t;
    return t("loop.boundsSwapped");
  }
  return null;
}

function getAudioContextClass() {
  return window.AudioContext || window.webkitAudioContext;
}

/**
 * Decode file to AudioBuffer in a throwaway context (then closed).
 * Some MP3s fail here in a browser but still play via HTMLMediaElement.
 * @param {ArrayBuffer} arrayBuffer
 * @returns {Promise<AudioBuffer|null>}
 */
async function tryDecodeAudioBuffer(arrayBuffer) {
  const AC = getAudioContextClass();
  if (!AC) return null;
  const copy = arrayBuffer.slice(0);
  const ctx = new AC();
  try {
    const buffer = await ctx.decodeAudioData(copy);
    return buffer;
  } catch (e) {
    console.warn("decodeAudioData failed (MediaElement fallback will be used):", e);
    return null;
  } finally {
    await ctx.close().catch(() => {});
  }
}

/**
 * WaveSurfer sometimes never fires `ready` (network/CORS/blob issues). Always pair with `error`.
 * @param {object} ws WaveSurfer instance
 * @param {number} timeoutMs
 */
function waitForWavesurferReady(ws, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    if (ws.isReady) {
      resolve();
      return;
    }

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(t("errors.waveSurferTimeout")));
    }, timeoutMs);

    ws.once("ready", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    });

    ws.once("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const msg =
        err && (err.message || err.type || String(err)) ||
        t("errors.waveSurferGeneric");
      reject(new Error(t("errors.waveSurferDetail", { msg })));
    });
  });
}

// =============================================================================
// WAVESURFER FACTORY
// =============================================================================

/**
 * Escala de la regla según zoom (px de pantalla por segundo de audio), estilo editores tipo CapCut.
 * - step: segundos entre marcas (con o sin texto).
 * - primary: cada cuántos índices se muestra etiqueta (el resto son marcas cortas sin texto).
 * Sin secondary del plugin: evita solapar dos etiquetas en el mismo instante.
 * @param {number} pxPerSec
 */
function getTimelineScale(pxPerSec) {
  const p = pxPerSec;
  if (p < 0.28) return { step: 120, primary: 1 };
  if (p < 0.55) return { step: 60, primary: 1 };
  if (p < 1.1) return { step: 30, primary: 1 };
  if (p < 2.2) return { step: 15, primary: 2 };
  if (p < 4.5) return { step: 10, primary: 3 };
  if (p < 9) return { step: 10, primary: 1 };
  if (p < 18) return { step: 5, primary: 2 };
  if (p < 32) return { step: 2, primary: 5 };
  if (p < 55) return { step: 1, primary: 1 };
  if (p < 100) return { step: 0.5, primary: 2 };
  return { step: 0.1, primary: 10 };
}

/**
 * Texto de etiqueta en la regla; con mucho zoom muestra décimas en segundos.
 * @param {number} seconds
 * @param {number} pxPerSec
 */
function timelineFormatAdaptive(seconds, pxPerSec) {
  const x = Math.max(0, seconds);
  const m = Math.floor(x / 60);
  const sRem = x % 60;
  const sInt = Math.floor(sRem);
  if (pxPerSec >= 55 && x % 1 > 0.02) {
    const t = Math.min(9, Math.floor((sRem % 1) * 10 + 0.0001));
    return `${m}:${String(sInt).padStart(2, "0")}.${t}`;
  }
  return `${m}:${String(sInt).padStart(2, "0")}`;
}

/**
 * WaveSurfer + regions + timeline. Más píxeles por segundo en pantalla ancha (scroll horizontal).
 * @param {'WebAudio'|'MediaElement'} backend
 */
function createWavesurfer(backend) {
  const plugins = [
    WaveSurfer.regions.create({
      /** La selección arrastrando solo se activa con `syncLoopDragSelection()` al encender el bucle. */
      dragSelection: false,
    }),
  ];

  if (typeof WaveSurfer !== "undefined" && WaveSurfer.timeline) {
    plugins.push(
      WaveSurfer.timeline.create({
        container: el.waveformTimeline,
        height: 34,
        notchPercentHeight: 78,
        primaryColor: "rgba(91, 159, 212, 0.92)",
        secondaryColor: "rgba(130, 165, 205, 0.55)",
        unlabeledNotchColor: "rgba(220, 228, 245, 0.12)",
        primaryFontColor: "#e8ecf4",
        secondaryFontColor: "#a8b4c8",
        fontFamily: "Segoe UI, system-ui, sans-serif",
        fontSize: 12,
        labelPadding: 6,
        formatTimeCallback: (sec, px) => timelineFormatAdaptive(sec, px),
        timeInterval(pxPerSec) {
          return getTimelineScale(pxPerSec).step;
        },
        primaryLabelInterval(pxPerSec) {
          return getTimelineScale(pxPerSec).primary;
        },
        secondaryLabelInterval() {
          return 99999;
        },
      })
    );
  }

  return WaveSurfer.create({
    container: el.waveform,
    height: 192,
    normalize: true,
    waveColor: "#2a3544",
    progressColor: "#5b9fd4",
    cursorColor: "#f2f4f8",
    backend,
    autoplay: false,
    interact: true,
    fillParent: true,
    minPxPerSec: ZOOM_DEFAULT,
    scrollParent: true,
    /** false = la vista no se desplaza sola al avanzar (menos mareo); activar con «Seguir cursor». */
    autoCenter: el.chkFollowPlayhead.checked,
    hideScrollbar: false,
    plugins,
  });
}

// =============================================================================
// WAVEFORM ZOOM (WaveSurfer.zoom)
// =============================================================================

function getWaveformZoomPx() {
  if (!state.wavesurfer) return ZOOM_DEFAULT;
  const px = state.wavesurfer.params.minPxPerSec;
  return Math.round(Number.isFinite(px) ? px : ZOOM_DEFAULT);
}

function updateZoomUI(px) {
  const v = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(px)));
  el.zoomSlider.value = String(v);
  el.zoomSlider.setAttribute("aria-valuenow", String(v));
}

/**
 * @param {number} px pixels per second of audio
 */
function applyWaveformZoom(px) {
  if (!state.wavesurfer) return;
  const v = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(px)));
  state.wavesurfer.zoom(v);
  updateZoomUI(v);
  requestAnimationFrame(() => {
    refreshLoopRegion();
  });
}

function zoomWaveformIn() {
  applyWaveformZoom(getWaveformZoomPx() * ZOOM_FACTOR_STEP);
}

function zoomWaveformOut() {
  applyWaveformZoom(getWaveformZoomPx() / ZOOM_FACTOR_STEP);
}

// =============================================================================
// TEARDOWN
// =============================================================================

function stopPitchAnimationLoop() {
  if (state.rafId) {
    cancelAnimationFrame(state.rafId);
    state.rafId = 0;
  }
}

function stopSimpleAnimationLoop() {
  if (state.simpleRafId) {
    cancelAnimationFrame(state.simpleRafId);
    state.simpleRafId = 0;
  }
}

function teardownPitchEngine() {
  stopPitchAnimationLoop();
  if (state.pitchShifter) {
    try {
      state.pitchShifter.disconnect();
    } catch (_) {
      /* ignore */
    }
    state.pitchShifter = null;
  }
  if (state.audioContext) {
    state.audioContext.close().catch(() => {});
    state.audioContext = null;
  }
}

function teardownBlobUrl() {
  if (state.blobUrl) {
    URL.revokeObjectURL(state.blobUrl);
    state.blobUrl = null;
  }
}

function destroyWavesurfer() {
  if (state.wavesurfer) {
    state.wavesurfer.destroy();
    state.wavesurfer = null;
  }
}

function fullTeardown() {
  teardownPitchEngine();
  stopSimpleAnimationLoop();
  destroyWavesurfer();
  teardownBlobUrl();
  state.engine = "idle";
  state.duration = 0;
  state.isPlaying = false;
  state.loopEnabled = false;
  updateLoopActiveIndicator();
  updateLoopIntervalReadout();
}

// =============================================================================
// UI BINDINGS
// =============================================================================

function setControlsEnabled(loaded) {
  el.btnPlay.disabled = !loaded;
  el.loopPresetLabel.disabled = !loaded;
  el.btnSaveLoop.disabled = !loaded;
  el.zoomSlider.disabled = !loaded;
  el.btnZoomIn.disabled = !loaded;
  el.btnZoomOut.disabled = !loaded;
  el.chkFollowPlayhead.disabled = !loaded;
  if (el.speedKnobInput) {
    el.speedKnobInput.disabled = !loaded;
  }
}

function updatePlayButtonLabel() {
  el.btnPlay.classList.toggle("is-playing", state.isPlaying);
  el.btnPlay.setAttribute(
    "aria-label",
    state.isPlaying ? "Pausar" : "Reproducir"
  );
}

function updateLoopActiveIndicator() {
  const ind = el.loopActiveIndicator;
  if (!ind) return;
  const loaded = Boolean(state.wavesurfer);
  const on = Boolean(state.loopEnabled && loaded);

  ind.hidden = !loaded;
  ind.classList.toggle("is-active", on);
  ind.classList.toggle("is-off", loaded && !on);

  const textEl = ind.querySelector(".loop-on-text");
  if (textEl) {
    textEl.textContent = on ? "Bucle activo" : "Bucle apagado";
  }
  ind.title = on
    ? "Pulsa para desactivar el bucle"
    : "Pulsa para activar el bucle";
  ind.setAttribute(
    "aria-label",
    on
      ? "Bucle activo. Pulsa para desactivar."
      : "Bucle desactivado. Pulsa para activar."
  );
  ind.setAttribute("aria-pressed", on ? "true" : "false");

  if (ind instanceof HTMLButtonElement) {
    ind.disabled = !loaded;
  }
}

function updateLoopIntervalReadout() {
  const wrap = el.loopIntervalReadout;
  if (!wrap) return;
  const show =
    state.loopEnabled &&
    state.duration > 0 &&
    state.loopEnd > state.loopStart;
  wrap.hidden = !show;
  if (!show) return;
  if (el.loopIntervalStart) {
    el.loopIntervalStart.textContent = formatTransportTime(state.loopStart);
  }
  if (el.loopIntervalEnd) {
    el.loopIntervalEnd.textContent = formatTransportTime(state.loopEnd);
  }
}

function updateTimeLabels(currentSec, totalSec) {
  el.timeCurrent.textContent = formatTransportTime(currentSec);
  el.timeTotal.textContent = formatTransportTime(totalSec);
}

/** Progress 0–1 for WaveSurfer `recenter` (pitch + simple engines). */
function getPlaybackProgress01() {
  if (state.duration <= 0) return 0;
  if (state.engine === "pitch" && state.pitchShifter) {
    let t = (state.pitchShifter.percentagePlayed / 100) * state.duration;
    if (!isFinite(t)) t = state.pitchShifter.timePlayed;
    return Math.min(1, Math.max(0, t / state.duration));
  }
  if (state.engine === "simple" && state.wavesurfer) {
    return Math.min(1, Math.max(0, state.wavesurfer.getCurrentTime() / state.duration));
  }
  return 0;
}

/**
 * True si el intervalo de bucle abarca prácticamente todo el archivo (región a pantalla completa).
 */
function isLoopSpanNearlyFullFile() {
  if (state.duration <= 0) return false;
  const len = state.loopEnd - state.loopStart;
  const tol = Math.max(0.12, LOOP_WRAP_EPSILON * 4);
  return len >= state.duration - tol;
}

/**
 * Si el bucle es casi toda la pista, lo sustituye por un tramo corto centrado en el cursor de reproducción
 * para poder agarrar los bordes del region (y opcionalmente dibujar otro con dragSelection).
 * @returns {boolean} true si se acotó el intervalo
 */
function narrowLoopToEditableSpanIfWholeFile() {
  if (state.duration <= 0 || !isLoopSpanNearlyFullFile()) return false;

  if (state.duration <= LOOP_UI_MIN_SEC * 2) {
    return false;
  }

  const center = Math.min(
    state.duration,
    Math.max(0, getPlaybackProgress01() * state.duration)
  );

  const ideal = Math.min(
    LOOP_UI_TARGET_WIDTH_SEC,
    Math.max(LOOP_UI_MIN_SEC * 2, state.duration * 0.12)
  );
  let width = Math.min(ideal, state.duration * 0.92);
  width = Math.max(width, LOOP_UI_MIN_SEC * 2);

  // Al activar el bucle desde "toda la pista", fijamos el inicio exactamente
  // en la posición actual del reproductor y extendemos hacia adelante.
  let start = center;
  let end = Math.min(state.duration, start + width);
  if (end - start < LOOP_UI_MIN_SEC) {
    end = Math.min(
      state.duration,
      start + Math.max(LOOP_UI_MIN_SEC, width)
    );
    if (end - start < LOOP_UI_MIN_SEC) {
      start = Math.max(0, end - LOOP_UI_MIN_SEC);
    }
  }

  state.loopStart = start;
  state.loopEnd = end;
  normalizeLoopBounds();
  state.activeSavedLoopId = null;
  return true;
}

function applyFollowPlayheadSetting() {
  if (!state.wavesurfer || !state.wavesurfer.drawer) return;
  const on = el.chkFollowPlayhead.checked;
  state.wavesurfer.params.autoCenter = on;
  if (on) {
    state.wavesurfer.drawer.recenter(getPlaybackProgress01());
  }
}

/**
 * Centra el scroll horizontal del waveform en el intervalo de bucle actual
 * (útil si el tramo está al final y no estaba visible).
 */
function scrollWaveformToShowLoop() {
  if (!state.wavesurfer || !state.wavesurfer.drawer || state.duration <= 0) return;
  if (state.loopEnd <= state.loopStart) return;
  const mid = (state.loopStart + state.loopEnd) / 2;
  const p = Math.min(1, Math.max(0, mid / state.duration));
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (state.wavesurfer && state.wavesurfer.drawer) {
        state.wavesurfer.drawer.recenter(p);
      }
    });
  });
}

function setLoopStatus(message, isError = false) {
  el.loopStatus.textContent = message || "";
  el.loopStatus.classList.toggle("error", Boolean(isError && message));
}

function setEngineHint(text) {
  el.engineHint.textContent = text;
}

/**
 * Porcentaje entero 50–150 alineado con el rango del CC MIDI de velocidad.
 * @param {number} speedFactor
 */
function speedFactorToMidiPercent(speedFactor) {
  const raw = Math.round(Number(speedFactor) * 100);
  return Math.min(
    MIDI_SPEED_PERCENT_MAX,
    Math.max(MIDI_SPEED_PERCENT_MIN, raw)
  );
}

/**
 * Ángulo del indicador del knob: arco ~270° (mismo rango que 50–150%).
 * @param {number} percentInt
 */
function speedPercentToKnobDeg(percentInt) {
  const t =
    (percentInt - MIDI_SPEED_PERCENT_MIN) /
    (MIDI_SPEED_PERCENT_MAX - MIDI_SPEED_PERCENT_MIN);
  return -135 + t * 270;
}

/** Sincroniza knob + texto con `state.speed` (botones, MIDI, arrastre). */
function updateSpeedKnobUI() {
  const input = el.speedKnobInput;
  const readout = el.speedKnobReadout;
  const indicator = el.speedKnobIndicator;
  if (!input || !readout) return;

  const pct = speedFactorToMidiPercent(state.speed);
  input.value = String(pct);
  input.setAttribute("aria-valuenow", String(pct));
  readout.textContent = `${pct}%`;

  const deg = speedPercentToKnobDeg(pct);
  if (indicator) {
    indicator.style.setProperty("--knob-deg", `${deg}deg`);
  }
}

// =============================================================================
// LOOP REGION (VISUAL)
// =============================================================================

/**
 * Draw or refresh the highlighted loop interval on the waveform.
 */
function refreshLoopRegion() {
  if (!state.wavesurfer || !state.wavesurfer.regions) {
    updateLoopIntervalReadout();
    return;
  }
  state.wavesurfer.clearRegions();
  if (!state.loopEnabled) {
    renderSavedLoopsList();
    updateLoopIntervalReadout();
    return;
  }
  if (state.duration <= 0 || state.loopEnd <= state.loopStart) {
    renderSavedLoopsList();
    updateLoopIntervalReadout();
    return;
  }

  regionProgrammaticUpdate = true;
  try {
    state.wavesurfer.addRegion({
      start: state.loopStart,
      end: state.loopEnd,
      color: LOOP_REGION_COLOR_ACTIVE,
      drag: true,
      resize: true,
      handleStyle: LOOP_REGION_HANDLE_STYLE,
    });
  } finally {
    regionProgrammaticUpdate = false;
  }
  renderSavedLoopsList();
  updateLoopIntervalReadout();
}

/**
 * Con bucle activo: permite dibujar un tramo arrastrando. Con bucle apagado: lo impide.
 */
function syncLoopDragSelection() {
  if (!state.wavesurfer) return;
  const ws = state.wavesurfer;
  if (
    typeof ws.enableDragSelection !== "function" ||
    typeof ws.disableDragSelection !== "function"
  ) {
    return;
  }
  if (state.loopEnabled) {
    ws.enableDragSelection({ ...LOOP_DRAG_SELECTION_PARAMS });
  } else {
    ws.disableDragSelection();
  }
}

/**
 * Wire region drag/resize to loop state.
 */
function attachRegionHandlers() {
  if (!state.wavesurfer) return;

  const applyRegion = (region) => {
    state.loopStart = region.start;
    state.loopEnd = region.end;
    const warn = normalizeLoopBounds();
    if (warn) {
      region.update({ start: state.loopStart, end: state.loopEnd });
      setLoopStatus(warn, true);
    } else {
      setLoopStatus("");
    }
    if (!regionProgrammaticUpdate) {
      state.activeSavedLoopId = null;
      renderSavedLoopsList();
    }
    updateLoopIntervalReadout();
  };

  state.wavesurfer.on("region-updated", (region) => {
    if (!state.loopEnabled || regionProgrammaticUpdate) return;
    state.loopStart = region.start;
    state.loopEnd = region.end;
    updateLoopIntervalReadout();
  });

  state.wavesurfer.on("region-created", (region) => {
    const plugin = state.wavesurfer.regions;
    if (plugin && plugin.list) {
      Object.keys(plugin.list).forEach((id) => {
        const r = plugin.list[id];
        if (r !== region) r.remove();
      });
    }
    applyRegion(region);
  });

  state.wavesurfer.on("region-update-end", (region) => {
    applyRegion(region);
  });
}

// =============================================================================
// PITCH ENGINE (SoundTouch — tempo preserves pitch)
// =============================================================================

function pitchModeSeekToSeconds(seconds) {
  if (!state.pitchShifter || state.duration <= 0) return;
  const p = Math.min(1, Math.max(0, seconds / state.duration));
  /** `percentagePlayed` setter expects 0–1 progress (despite the name). */
  state.pitchShifter.percentagePlayed = p;
}

/**
 * Called when SoundTouch reaches the end of the decoded buffer.
 */
function onPitchNaturalEnd() {
  if (state.loopEnabled) {
    const atFileEnd = state.loopEnd >= state.duration - LOOP_WRAP_EPSILON;
    if (atFileEnd) {
      pitchModeSeekToSeconds(state.loopStart + LOOP_SEEK_INSET);
      return;
    }
  }
  pausePlayback();
  pitchModeSeekToSeconds(0);
  updateTimeLabels(0, state.duration);
}

/**
 * Maintain section loop and sync waveform cursor while SoundTouch plays.
 */
function pitchPlaybackTick() {
  if (
    state.engine !== "pitch" ||
    !state.pitchShifter ||
    !state.audioContext ||
    state.audioContext.state !== "running"
  ) {
    state.rafId = 0;
    return;
  }

  let t = (state.pitchShifter.percentagePlayed / 100) * state.duration;
  if (!isFinite(t)) {
    t = state.pitchShifter.timePlayed;
  }

  if (state.loopEnabled && t >= state.loopEnd - LOOP_WRAP_EPSILON) {
    pitchModeSeekToSeconds(state.loopStart + LOOP_SEEK_INSET);
    t = state.loopStart + LOOP_SEEK_INSET;
  }

  const p = state.duration > 0 ? t / state.duration : 0;
  if (state.wavesurfer && state.wavesurfer.drawer) {
    state.wavesurfer.drawer.progress(Math.min(1, Math.max(0, p)));
  }
  updateTimeLabels(t, state.duration);

  state.rafId = requestAnimationFrame(pitchPlaybackTick);
}

async function startPitchPlayback() {
  if (!state.audioContext || !state.pitchShifter) return;
  await state.audioContext.resume();
  state.isPlaying = true;
  updatePlayButtonLabel();
  pitchPlaybackTick();
}

async function pausePitchPlayback() {
  stopPitchAnimationLoop();
  if (state.audioContext) await state.audioContext.suspend();
  state.isPlaying = false;
  updatePlayButtonLabel();
}

// =============================================================================
// SIMPLE ENGINE (MediaElement + playbackRate)
// =============================================================================

/**
 * Drive loop wrap, time labels, and waveform cursor while the MediaElement is
 * playing (WaveSurfer does not drive our time display in simple mode).
 */
function simplePlaybackTick() {
  if (
    !state.wavesurfer ||
    state.engine !== "simple" ||
    !state.wavesurfer.isPlaying()
  ) {
    state.simpleRafId = 0;
    return;
  }

  if (state.loopEnabled) {
    const ct = state.wavesurfer.getCurrentTime();
    if (ct >= state.loopEnd - LOOP_WRAP_EPSILON) {
      state.wavesurfer.setCurrentTime(state.loopStart + LOOP_SEEK_INSET);
    }
  }

  const t = state.wavesurfer.getCurrentTime();
  const p = state.duration > 0 ? t / state.duration : 0;
  if (state.wavesurfer.drawer) {
    state.wavesurfer.drawer.progress(Math.min(1, Math.max(0, p)));
  }
  updateTimeLabels(t, state.duration);

  state.simpleRafId = requestAnimationFrame(simplePlaybackTick);
}

async function startSimplePlayback() {
  if (!state.wavesurfer) return;
  try {
    await state.wavesurfer.play();
  } catch (e) {
    console.error(e);
    stopSimpleAnimationLoop();
    state.isPlaying = false;
    updatePlayButtonLabel();
    return;
  }
  state.isPlaying = true;
  updatePlayButtonLabel();
  stopSimpleAnimationLoop();
  simplePlaybackTick();
}

async function pauseSimplePlayback() {
  if (!state.wavesurfer) return;
  stopSimpleAnimationLoop();
  state.isPlaying = false;
  updatePlayButtonLabel();
  await Promise.resolve(state.wavesurfer.pause());
  const media = state.wavesurfer.backend && state.wavesurfer.backend.media;
  if (media instanceof HTMLMediaElement && !media.paused) {
    try {
      media.pause();
    } catch (_) {
      /* ignore */
    }
  }
}

// =============================================================================
// SHARED PLAYBACK API
// =============================================================================

async function togglePlayPause() {
  if (state.engine === "pitch") {
    const running =
      state.audioContext && state.audioContext.state === "running";
    if (running) await pausePitchPlayback();
    else await startPitchPlayback();
    return;
  }
  if (state.engine === "simple" && state.wavesurfer) {
    if (state.wavesurfer.isPlaying()) await pauseSimplePlayback();
    else await startSimplePlayback();
    return;
  }
}

/**
 * Seek to loop start (with inset) and ensure playback is running — for Space when loop is on.
 */
async function restartLoopFromStart() {
  if (!state.wavesurfer || state.duration <= 0 || !state.loopEnabled) return;
  const t = Math.min(
    state.duration - 1e-6,
    Math.max(0, state.loopStart + LOOP_SEEK_INSET)
  );
  seekToProgress(t / state.duration);

  if (state.engine === "pitch") {
    const running =
      state.audioContext && state.audioContext.state === "running";
    if (!running) await startPitchPlayback();
  } else if (state.engine === "simple") {
    if (!state.wavesurfer.isPlaying()) await startSimplePlayback();
  }
}

async function pausePlayback() {
  if (state.engine === "pitch") await pausePitchPlayback();
  else if (state.engine === "simple") await pauseSimplePlayback();
}

function applySpeed() {
  if (state.engine === "pitch" && state.pitchShifter) {
    /** SoundTouch: `tempo` changes speed while keeping pitch stable. */
    state.pitchShifter.tempo = state.speed;
    state.pitchShifter.rate = 1;
  } else if (state.engine === "simple" && state.wavesurfer) {
    state.wavesurfer.setPlaybackRate(state.speed);
  }
  updateSpeedKnobUI();
}

/**
 * Mapea valor CC 0..127 a porcentaje entero dentro del rango permitido.
 * Ej.: 100% = velocidad normal.
 */
function midiCcToSpeedPercent(ccValue) {
  const v = Math.min(127, Math.max(0, Number(ccValue) || 0));
  const pct =
    MIDI_SPEED_PERCENT_MIN +
    (v / 127) * (MIDI_SPEED_PERCENT_MAX - MIDI_SPEED_PERCENT_MIN);
  return Math.round(pct);
}

function seekToProgress(progress01) {
  const p = Math.min(1, Math.max(0, progress01));
  const seconds = p * state.duration;

  if (state.engine === "pitch") {
    pitchModeSeekToSeconds(seconds);
    if (state.wavesurfer) {
      state.wavesurfer.seekTo(p);
    }
    updateTimeLabels(seconds, state.duration);
  } else if (state.engine === "simple" && state.wavesurfer) {
    state.wavesurfer.seekTo(p);
    updateTimeLabels(seconds, state.duration);
  }
}

// =============================================================================
// LOAD FILE
// =============================================================================

/**
 * Pitch-preserving path: pre-decoded buffer, WaveSurfer(WebAudio) for display, SoundTouch for audio.
 * @param {AudioBuffer} audioBuffer
 * @param {object} PitchShifter SoundTouch PitchShifter constructor
 */
async function loadPitchPathFromBuffer(audioBuffer, PitchShifter) {
  const AC = getAudioContextClass();
  if (!AC) throw new Error(t("errors.webAudioUnsupported"));

  state.audioContext = new AC();

  state.wavesurfer = createWavesurfer("WebAudio");
  state.wavesurfer.loadDecodedBuffer(audioBuffer);

  await waitForWavesurferReady(state.wavesurfer);

  state.pitchShifter = new PitchShifter(
    state.audioContext,
    audioBuffer,
    4096,
    onPitchNaturalEnd
  );
  state.pitchShifter.node.connect(state.audioContext.destination);
  state.pitchShifter.tempo = state.speed;
  state.pitchShifter.rate = 1;

  /**
   * Tras elegir archivo el navegador suele dejar el AudioContext en "running".
   * Si no lo suspendemos, SoundTouch (ScriptProcessor) reproduce sola: se oye audio
   * pero no corre nuestro pitchPlaybackTick hasta el primer Play explícito.
   */
  if (state.audioContext.state === "running") {
    await state.audioContext.suspend();
  }

  state.engine = "pitch";
  state.duration = audioBuffer.duration;
  if (!isFinite(state.duration) || state.duration <= 0) {
    throw new Error(t("errors.decodedDurationInvalid"));
  }
  state.loopStart = 0;
  state.loopEnd = state.duration;
  setEngineHint("");

  wireWavesurferSeekSync();
  attachRegionHandlers();
  refreshLoopRegion();
}

/**
 * Fallback: MediaElement backend — `playbackRate` changes pitch with speed.
 */
async function loadSimplePath(file) {
  teardownBlobUrl();
  state.blobUrl = URL.createObjectURL(file);

  state.wavesurfer = createWavesurfer("MediaElement");
  state.wavesurfer.load(state.blobUrl);

  await waitForWavesurferReady(state.wavesurfer);

  /** Evitar reproducción automática rara de algunos navegadores al cargar el blob. */
  try {
    if (state.wavesurfer.isPlaying()) {
      await Promise.resolve(state.wavesurfer.pause());
    }
    const media = state.wavesurfer.backend && state.wavesurfer.backend.media;
    if (media instanceof HTMLMediaElement) {
      media.pause();
      media.currentTime = 0;
    }
    state.wavesurfer.seekTo(0);
  } catch (_) {
    /* ignore */
  }

  state.engine = "simple";
  state.duration = state.wavesurfer.getDuration();
  if (!isFinite(state.duration) || state.duration <= 0) {
    throw new Error(t("errors.durationReadFailed"));
  }
  state.loopStart = 0;
  state.loopEnd = state.duration;
  state.wavesurfer.setPlaybackRate(state.speed);

  setEngineHint("");

  wireWavesurferSeekSync();
  attachRegionHandlers();
  refreshLoopRegion();

  state.wavesurfer.on("pause", () => {
    stopSimpleAnimationLoop();
    state.isPlaying = false;
    updatePlayButtonLabel();
  });
  state.wavesurfer.on("finish", () => {
    stopSimpleAnimationLoop();
    state.isPlaying = false;
    updatePlayButtonLabel();
  });
}

/**
 * When user clicks the waveform, WaveSurfer seeks — mirror that in the pitch engine.
 */
function wireWavesurferSeekSync() {
  state.wavesurfer.on("seek", (progress) => {
    if (state.engine === "pitch" && state.pitchShifter) {
      state.pitchShifter.percentagePlayed = progress;
    }
    const t = progress * state.duration;
    updateTimeLabels(t, state.duration);
  });
}

async function loadFile(file) {
  fullTeardown();
  state.speed = 1;
  state.currentFile = file;
  el.fileName.textContent = file.name;
  if (el.fileName instanceof HTMLElement) {
    el.fileName.title = file.name;
  }
  setEngineHint("");
  setControlsEnabled(false);
  setLoopStatus("");

  let arrayBuffer;
  try {
    arrayBuffer = await file.arrayBuffer();
  } catch (e) {
    el.fileName.textContent = t("file.readFailed");
    if (el.fileName instanceof HTMLElement) el.fileName.title = "";
    setEngineHint(String(e && e.message ? e.message : e));
    return;
  }

  /** Prefer pitch path only when WebAudio decode works (many MP3s need MediaElement instead). */
  const decoded = await tryDecodeAudioBuffer(arrayBuffer);

  if (decoded) {
    try {
      const { PitchShifter } = await import(SOUNDTOUCH_MODULE);
      await loadPitchPathFromBuffer(decoded, PitchShifter);
    } catch (err) {
      console.warn("Ruta SoundTouch/WebAudio falló, usando MediaElement:", err);
      fullTeardown();
      try {
        await loadSimplePath(file);
        setEngineHint("");
      } catch (err2) {
        console.error(err2);
        el.fileName.textContent = t("file.loadFailed");
        if (el.fileName instanceof HTMLElement) el.fileName.title = "";
        setEngineHint(String(err2.message || err2));
        setControlsEnabled(false);
        return;
      }
    }
  } else {
    try {
      await loadSimplePath(file);
    } catch (err) {
      console.error(err);
      el.fileName.textContent = t("file.loadFailed");
      if (el.fileName instanceof HTMLElement) el.fileName.title = "";
      setEngineHint(String(err.message || err));
      setControlsEnabled(false);
      return;
    }
  }

  setControlsEnabled(true);
  updateTimeLabels(0, state.duration);
  updateSpeedKnobUI();
  state.isPlaying = false;
  updatePlayButtonLabel();
  state.activeSavedLoopId = null;
  renderSavedLoopsList();
  updateZoomUI(getWaveformZoomPx());
  updateLoopActiveIndicator();
  updateLoopIntervalReadout();
  syncLoopDragSelection();
  if (isMidiAdvancedEnabled()) {
    ensureMidiAccess().catch(() => {});
  }

  await persistLastLoadedTrack(arrayBuffer.slice(0), {
    name: file.name,
    lastModified: file.lastModified,
    type: file.type || "",
  });
}

/**
 * Comprueba IndexedDB y restaura la última pista; el skeleton del panel se oculta al terminar.
 */
async function bootstrapSessionRestore() {
  try {
    const snapshot = await readLastLoadedTrackAsFile();
    if (!snapshot || snapshot.size === 0) return;

    setEngineHint(t("session.restoring"));
    await loadFile(snapshot);
    setEngineHint("");
    if (!state.wavesurfer) {
      await clearLastLoadedTrack();
    }
  } catch (err) {
    console.error(err);
  } finally {
    el.appRoot?.classList.add("session-ready");
    el.waveformPanelMain?.setAttribute("aria-busy", "false");
    if (el.sessionRestoreSkeleton) {
      el.sessionRestoreSkeleton.setAttribute("aria-busy", "false");
      el.sessionRestoreSkeleton.setAttribute("aria-hidden", "true");
    }
  }
}

// =============================================================================
// SAVED LOOP PRESETS (per file, localStorage)
// =============================================================================

/**
 * Stable id for the current File (name + size + lastModified).
 * @param {File|null} file
 */
function getFileKey(file) {
  if (!file) return "";
  return `${file.name}::${file.size}::${file.lastModified}`;
}

function readAllLoopPresets() {
  try {
    const raw = localStorage.getItem(LOOP_PRESETS_STORAGE_KEY);
    if (!raw) return {};
    const data = JSON.parse(raw);
    return data && typeof data === "object" ? data : {};
  } catch (_) {
    return {};
  }
}

function writeAllLoopPresets(map) {
  try {
    localStorage.setItem(LOOP_PRESETS_STORAGE_KEY, JSON.stringify(map));
  } catch (e) {
    console.warn("localStorage:", e);
    setLoopStatus(t("loop.saveStorageFailed"), true);
  }
}

function getPresetsForCurrentFile() {
  const key = getFileKey(state.currentFile);
  if (!key) return [];
  const all = readAllLoopPresets();
  const list = all[key];
  return Array.isArray(list) ? list : [];
}

function saveCurrentLoopPreset() {
  const key = getFileKey(state.currentFile);
  if (!key || !state.duration) return;

  normalizeLoopBounds();
  const start = state.loopStart;
  const end = state.loopEnd;
  if (end - start < MIN_PRESET_LOOP_SECONDS) {
    setLoopStatus(
      t("loop.saveMinSeconds", { sec: MIN_PRESET_LOOP_SECONDS }),
      true
    );
    return;
  }

  let label = el.loopPresetLabel.value.trim();
  if (!label) {
    label = t("loop.defaultName", {
      n: getPresetsForCurrentFile().length + 1,
    });
  }

  const id =
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : `lp-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  const preset = { id, label, start, end };
  const all = readAllLoopPresets();
  const prev = Array.isArray(all[key]) ? all[key] : [];
  all[key] = [...prev, preset];
  writeAllLoopPresets(all);
  el.loopPresetLabel.value = "";
  setLoopStatus(t("loop.saveOk", { label }));
  state.activeSavedLoopId = id;
  renderSavedLoopsList();
}

function deleteLoopPreset(id) {
  const key = getFileKey(state.currentFile);
  if (!key) return;
  removeMidiBindingsForPreset(key, id);
  const all = readAllLoopPresets();
  const list = Array.isArray(all[key]) ? all[key] : [];
  all[key] = list.filter((p) => p.id !== id);
  if (all[key].length === 0) delete all[key];
  writeAllLoopPresets(all);
  if (state.activeSavedLoopId === id) state.activeSavedLoopId = null;
  renderSavedLoopsList();
}

function applyLoopPreset(preset) {
  if (!preset || !state.wavesurfer || state.duration <= 0) return;
  state.loopStart = preset.start;
  state.loopEnd = preset.end;
  normalizeLoopBounds();
  state.activeSavedLoopId = preset.id;
  state.loopEnabled = true;
  refreshLoopRegion();
  const p = state.duration > 0 ? state.loopStart / state.duration : 0;
  seekToProgress(Math.min(1, Math.max(0, p)));
  setLoopStatus(t("loop.loadedPreset", { label: preset.label }));
  updateLoopActiveIndicator();
  scrollWaveformToShowLoop();
  syncLoopDragSelection();
}

function isMidiAdvancedEnabled() {
  try {
    return localStorage.getItem(ADVANCED_UI_STORAGE_KEY) === "1";
  } catch (_) {
    return false;
  }
}

function applyMidiAdvancedFromStorage() {
  teardownMidiIfIdle();
  if (state.wavesurfer) renderSavedLoopsList();
}

/**
 * Render the list of saved presets for the current file.
 */
function renderSavedLoopsList() {
  const key = getFileKey(state.currentFile);
  const presets = key ? getPresetsForCurrentFile() : [];
  el.savedLoopsList.innerHTML = "";

  const showEmpty = !key || presets.length === 0;
  el.savedLoopsEmpty.hidden = !showEmpty;

  for (const preset of presets) {
    const li = document.createElement("li");
    li.className = "saved-loop-item";
    if (preset.id === state.activeSavedLoopId) {
      li.classList.add("active");
      if (state.loopEnabled) {
        li.classList.add("active-loop-live");
      }
    }

    const meta = document.createElement("div");
    meta.className = "saved-loop-meta";

    const title = document.createElement("div");
    title.className = "saved-loop-label";
    title.textContent = preset.label;

    const times = document.createElement("div");
    times.className = "saved-loop-times";
    times.textContent = `${formatTime(preset.start)} → ${formatTime(preset.end)}`;

    meta.appendChild(title);
    meta.appendChild(times);

    const showMidiHints = isMidiAdvancedEnabled();
    const fKey = getFileKey(state.currentFile);
    if (showMidiHints && fKey) {
      const bindKey = findBindingKeyForPreset(fKey, preset.id);
      if (bindKey) {
        const midiLine = document.createElement("div");
        midiLine.className = "saved-loop-midi muted small";
        midiLine.textContent = `MIDI: ${formatMidiBindingLabel(bindKey)}`;
        meta.appendChild(midiLine);
      }
    }

    const actions = document.createElement("div");
    actions.className = "saved-loop-actions";

    const btnApply = document.createElement("button");
    btnApply.type = "button";
    btnApply.className = "btn btn-compact";
    btnApply.textContent = t("ui.use");
    btnApply.dataset.applyId = preset.id;

    const btnDel = document.createElement("button");
    btnDel.type = "button";
    btnDel.className = "btn btn-compact btn-danger-outline";
    btnDel.textContent = t("ui.delete");
    btnDel.dataset.deleteId = preset.id;

    actions.appendChild(btnApply);
    if (showMidiHints) {
      const btnMidiRow = document.createElement("button");
      btnMidiRow.type = "button";
      btnMidiRow.className = "btn btn-compact";
      btnMidiRow.textContent = t("ui.learnMidi");
      btnMidiRow.dataset.midiLearnPreset = preset.id;
      btnMidiRow.title = t("midi.rowLearnTitle");
      actions.appendChild(btnMidiRow);
    }
    actions.appendChild(btnDel);
    li.appendChild(meta);
    li.appendChild(actions);
    el.savedLoopsList.appendChild(li);
  }
}

// =============================================================================
// MIDI (Web MIDI API — advanced)
// =============================================================================

function readMidiBindingsRoot() {
  try {
    const raw = localStorage.getItem(MIDI_BINDINGS_STORAGE_KEY);
    if (!raw) return {};
    const data = JSON.parse(raw);
    return data && typeof data === "object" ? data : {};
  } catch (_) {
    return {};
  }
}

function writeMidiBindingsRoot(map) {
  try {
    localStorage.setItem(MIDI_BINDINGS_STORAGE_KEY, JSON.stringify(map));
  } catch (e) {
    console.warn("MIDI bindings localStorage:", e);
  }
}

function tryApplyGlobalMidiBinding(bKey, midiMessage = null) {
  const all = readGlobalMidiBindings();
  for (const [action, bound] of Object.entries(all)) {
    if (bound !== bKey) continue;

    if (action === MIDI_GLOBAL_ACTION_SPEED_PERCENT_KNOB) {
      if (!midiMessage || midiMessage.cmd !== 0xb0) return true;
      const percent = midiCcToSpeedPercent(midiMessage.d2);
      state.speed = percent / 100;
      applySpeed();
      return true;
    }

    const debKey = `global:${action}`;
    const now =
      typeof performance !== "undefined" ? performance.now() : Date.now();
    const last = midiLastTriggerMs.get(debKey) || 0;
    if (now - last < MIDI_TRIGGER_DEBOUNCE_MS) return true;
    midiLastTriggerMs.set(debKey, now);
    if (action === MIDI_GLOBAL_ACTION_PLAY_PAUSE) {
      togglePlayPause().catch(() => {});
      return true;
    }
  }
  return false;
}

function getBindingsForFileKey(fileKey) {
  if (!fileKey) return {};
  const root = readMidiBindingsRoot();
  const b = root[fileKey];
  return b && typeof b === "object" ? { ...b } : {};
}

function setBindingsForFileKey(fileKey, bindings) {
  const root = readMidiBindingsRoot();
  if (!fileKey) return;
  if (!bindings || Object.keys(bindings).length === 0) delete root[fileKey];
  else root[fileKey] = bindings;
  writeMidiBindingsRoot(root);
}

function removeMidiBindingsForPreset(fileKey, presetId) {
  if (!fileKey || !presetId) return;
  const cur = getBindingsForFileKey(fileKey);
  let changed = false;
  for (const k of Object.keys(cur)) {
    if (cur[k] === presetId) {
      delete cur[k];
      changed = true;
    }
  }
  if (changed) setBindingsForFileKey(fileKey, cur);
}

/** Preset id → binding key (first match) for display. */
function findBindingKeyForPreset(fileKey, presetId) {
  const cur = getBindingsForFileKey(fileKey);
  for (const k of Object.keys(cur)) {
    if (cur[k] === presetId) return k;
  }
  return null;
}

function saveMidiNoteToPreset(fileKey, channel, note, presetId) {
  if (!fileKey || !presetId) return;
  const key = midiNoteBindingKey(channel, note);
  const cur = getBindingsForFileKey(fileKey);
  cur[key] = presetId;
  setBindingsForFileKey(fileKey, cur);
}

function saveMidiCcToPreset(fileKey, channel, cc, presetId) {
  if (!fileKey || !presetId) return;
  const key = midiCcBindingKey(channel, cc);
  const cur = getBindingsForFileKey(fileKey);
  cur[key] = presetId;
  setBindingsForFileKey(fileKey, cur);
}

/**
 * Running status: algunos drivers (p. ej. Windows) envían paquetes donde solo el primer mensaje
 * lleva byte de estado; el resto son datos. Sin esto, data[0] puede ser < 0x80 y se ignora todo.
 * @type {Map<string, number>}
 */
const midiRunningStatusByInputId = new Map();

function detachMidiInputs() {
  while (midiInputBindings.length) {
    const row = midiInputBindings.pop();
    try {
      row.input.removeEventListener("midimessage", row.handler);
    } catch (_) {
      /* ignore */
    }
  }
}

function clearMidiRewireTimeouts() {
  midiRewireTimeoutIds.forEach((id) => clearTimeout(id));
  midiRewireTimeoutIds = [];
}

function scheduleMidiPortRefresh(access) {
  clearMidiRewireTimeouts();
  const delays = [0, 120, 350, 800, 2000];
  delays.forEach((ms) => {
    const id = setTimeout(() => {
      if (!midiAccess || midiAccess !== access) return;
      wireMidiInputs(access);
      updateMidiStatusFromAccess(access, null);
    }, ms);
    midiRewireTimeoutIds.push(id);
  });
}

function wireMidiInputs(access) {
  detachMidiInputs();
  const list = midiPortMapToArray(access.inputs);
  for (const input of list) {
    const handler = (e) => handleMidiMessage(e, input);
    input.addEventListener("midimessage", handler);
    midiInputBindings.push({ input, handler });
  }
}

function onMidiStateChange() {
  if (!midiAccess) return;
  wireMidiInputs(midiAccess);
  updateMidiStatusFromAccess(midiAccess, null);
}

async function ensureMidiAccess() {
  if (isWebMidiBlockedByContext()) {
    return null;
  }
  if (midiAccess) {
    wireMidiInputs(midiAccess);
    updateMidiStatusFromAccess(midiAccess, null);
    scheduleMidiPortRefresh(midiAccess);
    return midiAccess;
  }
  const req =
    typeof navigator !== "undefined" && navigator.requestMIDIAccess
      ? navigator.requestMIDIAccess({ sysex: false })
      : null;
  if (!req) {
    return null;
  }
  try {
    const access = await req;
    midiAccess = access;
    wireMidiInputs(access);
    access.onstatechange = onMidiStateChange;
    updateMidiStatusFromAccess(access, null);
    scheduleMidiPortRefresh(access);
    return access;
  } catch (e) {
    console.warn(e);
    return null;
  }
}

function teardownMidiIfIdle() {
  if (isMidiAdvancedEnabled()) return;
  clearMidiRewireTimeouts();
  detachMidiInputs();
  if (midiAccess) {
    midiAccess.onstatechange = null;
  }
  midiAccess = null;
  midiLearnWaiting = false;
}

function tryApplyBindingTrigger(fileKey, bKey) {
  if (!fileKey || !state.wavesurfer) return;
  const bindings = getBindingsForFileKey(fileKey);
  const presetId = bindings[bKey];
  if (!presetId) return;
  const now = typeof performance !== "undefined" ? performance.now() : Date.now();
  const last = midiLastTriggerMs.get(bKey) || 0;
  if (now - last < MIDI_TRIGGER_DEBOUNCE_MS) return;
  midiLastTriggerMs.set(bKey, now);
  const preset = getPresetsForCurrentFile().find((p) => p.id === presetId);
  if (preset) applyLoopPreset(preset);
}

function handleMidiMessage(e, inputPort) {
  const data = e.data;
  if (!data || data.length === 0) return;

  const inputId =
    inputPort && inputPort.id != null ? String(inputPort.id) : "default";
  const msgs = expandMidiDataToVoiceMessages(
    midiRunningStatusByInputId,
    inputId,
    data
  );
  const fileKey = getFileKey(state.currentFile);
  const learnOpen =
    midiLearnWaiting && el.midiLearnDialog && el.midiLearnDialog.open;

  if (learnOpen && el.midiLearnHint && msgs.length === 0) {
    const fb = data[0];
    if (fb >= 0xf8) {
      el.midiLearnHint.textContent = t("midi.learnClockOnly");
    } else {
      el.midiLearnHint.textContent = t("midi.learnUnrecognized", {
        hex: midiBytesToHexPreview(data),
      });
    }
  }

  for (const m of msgs) {
    const { cmd, channel, d1, d2 } = m;
    const isNoteOn = cmd === 0x90 && d2 > 0;
    const isCc = cmd === 0xb0;

    if (learnOpen) {
      const presetId =
        midiLearnContext.kind === "loop" && midiLearnContext.presetId
          ? midiLearnContext.presetId
          : "";
      if (!presetId || !fileKey) {
        closeMidiLearnDialog();
        return;
      }
      if (isNoteOn) {
        saveMidiNoteToPreset(fileKey, channel, d1, presetId);
        if (el.midiLearnHint) {
          el.midiLearnHint.textContent = t("midi.learnAssigned", {
            detail: formatMidiBindingLabel(midiNoteBindingKey(channel, d1)),
          });
        }
        midiLearnWaiting = false;
        renderSavedLoopsList();
        if (el.midiLearnDialog && typeof el.midiLearnDialog.close === "function") {
          el.midiLearnDialog.close();
        }
        return;
      }
      if (isCc) {
        saveMidiCcToPreset(fileKey, channel, d1, presetId);
        if (el.midiLearnHint) {
          el.midiLearnHint.textContent = t("midi.learnAssigned", {
            detail: formatMidiBindingLabel(midiCcBindingKey(channel, d1)),
          });
        }
        midiLearnWaiting = false;
        renderSavedLoopsList();
        if (el.midiLearnDialog && typeof el.midiLearnDialog.close === "function") {
          el.midiLearnDialog.close();
        }
        return;
      }
      continue;
    }

    if (isNoteOn) {
      const bKey = midiNoteBindingKey(channel, d1);
      if (tryApplyGlobalMidiBinding(bKey, m)) continue;
      tryApplyBindingTrigger(fileKey, bKey);
    } else if (isCc) {
      const bKey = midiCcBindingKey(channel, d1);
      if (tryApplyGlobalMidiBinding(bKey, m)) continue;
      tryApplyBindingTrigger(fileKey, bKey);
    }
  }
}

function closeMidiLearnDialog() {
  midiLearnWaiting = false;
  midiLearnContext = { kind: "loop" };
  if (el.midiLearnDialog && el.midiLearnDialog.open) {
    el.midiLearnDialog.close();
  }
}

function openMidiLearnDialogForLoop(presetId) {
  const presets = getPresetsForCurrentFile();
  const preset = presets.find((p) => p.id === presetId);
  const dlg = el.midiLearnDialog;
  if (!dlg || typeof dlg.showModal !== "function") return;
  if (!preset) {
    setLoopStatus(t("midi.presetNotFound"), true);
    return;
  }
  const fileKey = getFileKey(state.currentFile);
  if (!fileKey) {
    setLoopStatus(t("midi.needAudioFile"), true);
    return;
  }

  midiLearnContext = { kind: "loop", presetId };
  if (el.midiLearnTitle) {
    el.midiLearnTitle.textContent = t("midi.dialogTitleLoop", {
      label: preset.label,
    });
  }
  if (el.midiLearnBody) {
    el.midiLearnBody.textContent = t("midi.dialogBodyLoop");
  }
  if (el.midiLearnHint) {
    el.midiLearnHint.textContent = t("midi.dialogHintWaiting");
  }
  midiLearnWaiting = true;
  dlg.showModal();
}

async function onMidiLearnLoopRowClick(presetId) {
  const access = await ensureMidiAccess();
  if (!access) return;
  openMidiLearnDialogForLoop(presetId);
}

// =============================================================================
// LOOP CONTROLS
// =============================================================================

function enableLoop() {
  state.loopEnabled = true;
  const seeded = narrowLoopToEditableSpanIfWholeFile();
  setLoopStatus(
    seeded ? t("loop.enableSeeded") : t("loop.enablePlain")
  );
  refreshLoopRegion();
  updateLoopActiveIndicator();
  syncLoopDragSelection();
}

function disableLoop() {
  state.loopEnabled = false;
  syncLoopDragSelection();
  setLoopStatus(t("loop.disabled"));
  refreshLoopRegion();
  updateLoopActiveIndicator();
}

function toggleLoop() {
  if (state.loopEnabled) disableLoop();
  else enableLoop();
}

// =============================================================================
// KEYBOARD
// =============================================================================

/**
 * Space debe reservarse para escribir o para el comportamiento nativo del control
 * (p. ej. checkbox); en el resto (botones, slider, enlaces) forzamos play/pausa.
 * @param {EventTarget|null} target
 */
function isSpaceReservedForTypingOrToggle(target) {
  const el = target && /** @type {HTMLElement} */ (target);
  if (!el || !el.tagName) return false;
  const tag = el.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") {
    const type = (el.type || "").toLowerCase();
    if (type === "checkbox" || type === "radio") return true;
    const textLike = new Set([
      "text",
      "search",
      "email",
      "url",
      "tel",
      "password",
      "number",
      "date",
      "time",
      "datetime-local",
      "month",
      "week",
    ]);
    if (textLike.has(type)) return true;
    return false;
  }
  if (el.isContentEditable) return true;
  return false;
}

function onKeyDown(e) {
  if (e.code !== "Space") return;
  if (el.midiLearnDialog && el.midiLearnDialog.open) return;
  if (isSpaceReservedForTypingOrToggle(e.target)) return;

  e.preventDefault();
  if (!state.wavesurfer) return;
  if (state.loopEnabled) {
    restartLoopFromStart().catch((err) => console.error(err));
  } else {
    togglePlayPause().catch((err) => console.error(err));
  }
}

// =============================================================================
// EVENT LISTENERS (BOOTSTRAP)
// =============================================================================

function fileDragHasFiles(dt) {
  return !!(dt && dt.types && [...dt.types].includes("Files"));
}

function isAudioFile(file) {
  if (!file || typeof file.name !== "string") return false;
  if (file.type && file.type.startsWith("audio/")) return true;
  return /\.(mp3|wav|ogg|m4a|aac|flac|webm|opus)$/i.test(file.name);
}

function runLoadFromUserFile(file) {
  if (!file) return;
  loadFile(file).catch((err) => {
    console.error(err);
    el.fileName.textContent = t("file.loadFailedShort");
    if (el.fileName instanceof HTMLElement) el.fileName.title = "";
    setEngineHint(String(err.message || err));
    setControlsEnabled(false);
  });
}

el.fileInput.addEventListener("change", (e) => {
  const input = e.target;
  const file = input.files && input.files[0];
  input.value = "";
  runLoadFromUserFile(file);
});

document.addEventListener(
  "dragover",
  (e) => {
    if (!fileDragHasFiles(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  },
  true
);

window.addEventListener("dragenter", (e) => {
  if (fileDragHasFiles(e.dataTransfer)) {
    document.body.classList.add("app-file-drag-over");
  }
});

window.addEventListener("dragend", () => {
  document.body.classList.remove("app-file-drag-over");
});

document.addEventListener(
  "drop",
  (e) => {
    document.body.classList.remove("app-file-drag-over");
    if (!fileDragHasFiles(e.dataTransfer)) return;
    const list = e.dataTransfer.files;
    if (!list || !list.length) return;
    const file = Array.from(list).find(isAudioFile);
    if (!file) return;
    e.preventDefault();
    e.stopPropagation();
    runLoadFromUserFile(file);
  },
  true
);

el.btnPlay.addEventListener("click", () => {
  if (isMidiAdvancedEnabled()) {
    ensureMidiAccess().catch(() => {});
  }
  togglePlayPause().catch((e) => console.error(e));
});

el.zoomSlider.addEventListener("input", () => {
  applyWaveformZoom(parseFloat(el.zoomSlider.value));
});

el.btnZoomIn.addEventListener("click", () => zoomWaveformIn());
el.btnZoomOut.addEventListener("click", () => zoomWaveformOut());

el.chkFollowPlayhead.addEventListener("change", () => {
  applyFollowPlayheadSetting();
});

if (el.speedKnobInput) {
  el.speedKnobInput.addEventListener("input", () => {
    if (el.speedKnobInput.disabled) return;
    const v = parseInt(el.speedKnobInput.value, 10);
    if (!Number.isFinite(v)) return;
    const clamped = Math.min(
      MIDI_SPEED_PERCENT_MAX,
      Math.max(MIDI_SPEED_PERCENT_MIN, v)
    );
    state.speed = clamped / 100;
    applySpeed();
  });
}

el.loopActiveIndicator.addEventListener("click", () => {
  if (state.wavesurfer) toggleLoop();
});

el.btnSaveLoop.addEventListener("click", () => saveCurrentLoopPreset());

el.savedLoopsList.addEventListener("click", (e) => {
  const delBtn = e.target.closest("[data-delete-id]");
  const applyBtn = e.target.closest("[data-apply-id]");
  const midiLearnBtn = e.target.closest("[data-midi-learn-preset]");
  if (delBtn) {
    deleteLoopPreset(delBtn.dataset.deleteId);
    return;
  }
  if (midiLearnBtn) {
    const id = midiLearnBtn.dataset.midiLearnPreset;
    if (id) {
      onMidiLearnLoopRowClick(id).catch((err) => console.error(err));
    }
    return;
  }
  if (applyBtn) {
    const id = applyBtn.dataset.applyId;
    const preset = getPresetsForCurrentFile().find((p) => p.id === id);
    if (preset) applyLoopPreset(preset);
  }
});

/** Captura: evita que Space active el botón/enlace/slider enfocado antes que play/pausa. */
window.addEventListener("keydown", onKeyDown, true);

window.addEventListener("storage", (e) => {
  if (e.key === ADVANCED_UI_STORAGE_KEY) applyMidiAdvancedFromStorage();
});

if (el.btnMidiLearnCancel) {
  el.btnMidiLearnCancel.addEventListener("click", () => closeMidiLearnDialog());
}
if (el.midiLearnDialog) {
  el.midiLearnDialog.addEventListener("close", () => {
    midiLearnWaiting = false;
    midiLearnContext = { kind: "loop" };
  });
}

// Initial UI
setControlsEnabled(false);
setEngineHint("");
updatePlayButtonLabel();
updateLoopActiveIndicator();
updateLoopIntervalReadout();
updateZoomUI(ZOOM_DEFAULT);
updateSpeedKnobUI();
renderSavedLoopsList();
applyMidiAdvancedFromStorage();
bootstrapSessionRestore().catch((err) => console.error(err));
