/**
 * Claves y helpers MIDI globales compartidos entre la app principal y /settings/midi.
 */

export const ADVANCED_UI_STORAGE_KEY = "music-practice-advanced-ui-v1";

export const MIDI_GLOBAL_BINDINGS_KEY = "music-practice-midi-global-v1";

export const MIDI_GLOBAL_ACTION_PLAY_PAUSE = "playPause";
export const MIDI_GLOBAL_ACTION_SPEED_PERCENT_KNOB = "speedPercentKnob";
export const MIDI_GLOBAL_ACTION_VOLUME_PERCENT_KNOB = "volumePercentKnob";

export function isContinuousCcMidiAction(actionId) {
  return (
    actionId === MIDI_GLOBAL_ACTION_SPEED_PERCENT_KNOB ||
    actionId === MIDI_GLOBAL_ACTION_VOLUME_PERCENT_KNOB
  );
}

export function midiNoteBindingKey(channel, note) {
  return `n-${channel}-${note}`;
}

export function midiCcBindingKey(channel, cc) {
  return `c-${channel}-${cc}`;
}

export function formatMidiBindingLabel(bindingKey) {
  let m = /^n-(\d+)-(\d+)$/.exec(bindingKey);
  if (m) {
    const ch = parseInt(m[1], 10) + 1;
    const note = parseInt(m[2], 10);
    return `Canal ${ch}, nota ${note}`;
  }
  m = /^c-(\d+)-(\d+)$/.exec(bindingKey);
  if (m) {
    const ch = parseInt(m[1], 10) + 1;
    const cc = parseInt(m[2], 10);
    return `Canal ${ch}, control ${cc} (CC)`;
  }
  return bindingKey;
}

export function formatGlobalMidiActionLabel(actionId) {
  if (actionId === MIDI_GLOBAL_ACTION_PLAY_PAUSE) return "Reproducir / Pausa";
  if (actionId === MIDI_GLOBAL_ACTION_SPEED_PERCENT_KNOB) {
    return "Velocidad continua (knob %)";
  }
  if (actionId === MIDI_GLOBAL_ACTION_VOLUME_PERCENT_KNOB) {
    return "Volumen continuo (knob %)";
  }
  return actionId;
}

export function readGlobalMidiBindings() {
  try {
    const raw = localStorage.getItem(MIDI_GLOBAL_BINDINGS_KEY);
    if (!raw) return {};
    const data = JSON.parse(raw);
    return data && typeof data === "object" ? data : {};
  } catch (_) {
    return {};
  }
}

export function writeGlobalMidiBindings(map) {
  try {
    if (!map || Object.keys(map).length === 0) {
      localStorage.removeItem(MIDI_GLOBAL_BINDINGS_KEY);
    } else {
      localStorage.setItem(MIDI_GLOBAL_BINDINGS_KEY, JSON.stringify(map));
    }
  } catch (e) {
    console.warn("MIDI global bindings:", e);
  }
}
