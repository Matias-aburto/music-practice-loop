import {
  ADVANCED_UI_STORAGE_KEY,
  MIDI_GLOBAL_ACTION_SPEED_PERCENT_KNOB,
  formatGlobalMidiActionLabel,
  formatMidiBindingLabel,
  midiCcBindingKey,
  midiNoteBindingKey,
  readGlobalMidiBindings,
  writeGlobalMidiBindings,
} from "./midi-common.js";
import {
  expandMidiDataToVoiceMessages,
  isWebMidiBlockedByContext,
  midiBytesToHexPreview,
  midiPortMapToArray,
  updateMidiStatusFromAccess,
} from "./midi-device.js";

const el = {
  chkAdvanced: document.getElementById("chk-advanced"),
  advancedContent: document.getElementById("advanced-content"),
  midiStatus: document.getElementById("midi-status"),
  btnMidiScan: document.getElementById("btn-midi-scan"),
  midiGlobalAssignMenu: document.getElementById("midi-global-assign-menu"),
  midiLearnDialog: document.getElementById("midi-learn-dialog"),
  midiLearnTitle: document.getElementById("midi-learn-title"),
  midiLearnBody: document.getElementById("midi-learn-body"),
  midiLearnHint: document.getElementById("midi-learn-hint"),
  btnMidiLearnCancel: document.getElementById("btn-midi-learn-cancel"),
};

let midiAccess = null;
let midiLearnWaiting = false;
/** @type {string|null} */
let midiLearnActionId = null;

/** @type {{ input: MIDIInput, handler: (e: Event) => void }[]} */
const midiInputBindings = [];

const midiRewireTimeoutIds = [];
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

function wireMidiInputs(access) {
  detachMidiInputs();
  const list = midiPortMapToArray(access.inputs);
  for (const input of list) {
    const handler = (e) => handleMidiMessage(e, input);
    input.addEventListener("midimessage", handler);
    midiInputBindings.push({ input, handler });
  }
}

function clearMidiRewireTimeouts() {
  midiRewireTimeoutIds.forEach((id) => clearTimeout(id));
  midiRewireTimeoutIds.length = 0;
}

function scheduleMidiPortRefresh(access) {
  clearMidiRewireTimeouts();
  const delays = [0, 120, 350, 800, 2000];
  delays.forEach((ms) => {
    const id = setTimeout(() => {
      if (!midiAccess || midiAccess !== access) return;
      wireMidiInputs(access);
      updateMidiStatusFromAccess(access, el.midiStatus);
    }, ms);
    midiRewireTimeoutIds.push(id);
  });
}

function onMidiStateChange() {
  if (!midiAccess) return;
  wireMidiInputs(midiAccess);
  updateMidiStatusFromAccess(midiAccess, el.midiStatus);
}

async function ensureMidiAccess() {
  if (isWebMidiBlockedByContext()) {
    const elSt = el.midiStatus;
    if (elSt) {
      elSt.classList.remove("is-ok", "is-warn");
      elSt.classList.add("is-err");
      elSt.textContent =
        "Este origen no es seguro para Web MIDI. Abre la app con http://localhost:… (npm start), no como file://.";
    }
    return null;
  }
  if (midiAccess) {
    wireMidiInputs(midiAccess);
    updateMidiStatusFromAccess(midiAccess, el.midiStatus);
    scheduleMidiPortRefresh(midiAccess);
    return midiAccess;
  }
  const req =
    typeof navigator !== "undefined" && navigator.requestMIDIAccess
      ? navigator.requestMIDIAccess({ sysex: false })
      : null;
  if (!req) {
    const elSt = el.midiStatus;
    if (elSt) {
      elSt.classList.remove("is-ok", "is-warn");
      elSt.classList.add("is-err");
      elSt.textContent =
        "Tu navegador no expone Web MIDI. Prueba Chrome o Edge en https o localhost.";
    }
    return null;
  }
  try {
    const access = await req;
    midiAccess = access;
    wireMidiInputs(access);
    access.onstatechange = onMidiStateChange;
    updateMidiStatusFromAccess(access, el.midiStatus);
    scheduleMidiPortRefresh(access);
    return access;
  } catch (e) {
    const elSt = el.midiStatus;
    if (elSt) {
      elSt.classList.remove("is-ok", "is-warn");
      elSt.classList.add("is-err");
      elSt.textContent =
        "No se pudo acceder al MIDI. Revisa permisos o vuelve a conectar el controlador.";
    }
    console.warn(e);
    return null;
  }
}

function teardownMidiIfDisabled() {
  clearMidiRewireTimeouts();
  detachMidiInputs();
  if (midiAccess) {
    midiAccess.onstatechange = null;
  }
  midiAccess = null;
  midiLearnWaiting = false;
  midiLearnActionId = null;
  if (el.midiStatus) {
    el.midiStatus.textContent = "";
    el.midiStatus.classList.remove("is-ok", "is-warn", "is-err");
  }
}

function refreshGlobalMidiLabels() {
  const all = readGlobalMidiBindings();
  const menu = el.midiGlobalAssignMenu;
  if (menu) {
    menu.querySelectorAll("[data-midi-binding-label]").forEach((span) => {
      const action = span.dataset.midiBindingLabel;
      if (!action) return;
      const key = all[action];
      span.textContent = key
        ? `Asignado: ${formatMidiBindingLabel(key)}`
        : "Sin asignar";
    });
  }
  syncMidiActionButtons();
}

function saveGlobalMidiBindingForAction(actionId, bindingKey) {
  if (!actionId || !bindingKey) return;
  const all = readGlobalMidiBindings();
  for (const a of Object.keys(all)) {
    if (all[a] === bindingKey) delete all[a];
  }
  all[actionId] = bindingKey;
  writeGlobalMidiBindings(all);
  refreshGlobalMidiLabels();
}

function clearGlobalMidiAction(actionId) {
  if (!actionId) return;
  const all = readGlobalMidiBindings();
  delete all[actionId];
  writeGlobalMidiBindings(all);
  refreshGlobalMidiLabels();
}

function syncMidiActionButtons() {
  const adv = el.chkAdvanced && el.chkAdvanced.checked;
  if (el.btnMidiScan) el.btnMidiScan.disabled = !adv;
  const menu = el.midiGlobalAssignMenu;
  const g = readGlobalMidiBindings();
  if (menu) {
    menu.querySelectorAll("[data-midi-learn-global]").forEach((btn) => {
      btn.disabled = !adv;
    });
    menu.querySelectorAll("[data-midi-clear-global]").forEach((btn) => {
      const action = btn.dataset.midiClearGlobal;
      btn.disabled = !adv || !action || !g[action];
    });
  }
}

function refreshMidiIdleHint() {
  const elSt = el.midiStatus;
  if (!elSt || !el.chkAdvanced || !el.chkAdvanced.checked) return;
  if (isWebMidiBlockedByContext()) {
    elSt.classList.remove("is-ok", "is-warn");
    elSt.classList.add("is-err");
    elSt.textContent =
      "Web MIDI requiere contexto seguro: usa npm start y abre http://localhost:3333 (no abras el HTML como archivo desde el disco).";
    return;
  }
  if (midiAccess) {
    updateMidiStatusFromAccess(midiAccess, elSt);
    return;
  }
  elSt.classList.remove("is-ok", "is-err");
  elSt.classList.add("is-warn");
  elSt.textContent =
    "Pulsa «Buscar teclado MIDI» para conectar. Luego usa «Aprender…» para reproducir / pausar o el knob de velocidad (CC).";
}

function setAdvancedSectionVisible(on) {
  if (el.advancedContent) {
    el.advancedContent.hidden = !on;
  }
  try {
    localStorage.setItem(ADVANCED_UI_STORAGE_KEY, on ? "1" : "0");
  } catch (_) {
    /* ignore */
  }
  if (on) {
    refreshMidiIdleHint();
    refreshGlobalMidiLabels();
  } else {
    closeMidiLearnDialog();
    teardownMidiIfDisabled();
  }
  syncMidiActionButtons();
}

function closeMidiLearnDialog() {
  midiLearnWaiting = false;
  midiLearnActionId = null;
  if (el.midiLearnDialog && el.midiLearnDialog.open) {
    el.midiLearnDialog.close();
  }
}

function openMidiGlobalLearnDialog(actionId) {
  const dlg = el.midiLearnDialog;
  if (!dlg || typeof dlg.showModal !== "function") return;
  midiLearnActionId = actionId;
  if (el.midiLearnTitle) {
    el.midiLearnTitle.textContent = `MIDI: ${formatGlobalMidiActionLabel(actionId)}`;
  }
  if (el.midiLearnBody) {
    el.midiLearnBody.textContent =
      actionId === MIDI_GLOBAL_ACTION_SPEED_PERCENT_KNOB
        ? "Mueve un knob/fader (CC) para usar velocidad continua en porcentaje."
        : "Pulsa el control de tu teclado MIDI (nota o CC) que quieras usar para esta acción.";
  }
  if (el.midiLearnHint) {
    el.midiLearnHint.textContent =
      actionId === MIDI_GLOBAL_ACTION_SPEED_PERCENT_KNOB
        ? "Esperando un mensaje CC de knob/fader…"
        : "Pulsa una tecla, pad o mueve un knob…";
  }
  midiLearnWaiting = true;
  dlg.showModal();
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

  const learnOpen =
    midiLearnWaiting && el.midiLearnDialog && el.midiLearnDialog.open;
  const actionId = midiLearnActionId;

  if (learnOpen && el.midiLearnHint && msgs.length === 0) {
    const fb = data[0];
    if (fb >= 0xf8) {
      el.midiLearnHint.textContent =
        "Solo reloj MIDI en este paquete; pulsa una tecla, un pad o mueve un knob.";
    } else {
      el.midiLearnHint.textContent = `Paquete sin nota/CC reconocible. Hex: ${midiBytesToHexPreview(
        data
      )}`;
    }
  }

  if (!learnOpen || !actionId) return;

  for (const m of msgs) {
    const { cmd, channel, d1, d2 } = m;
    const isNoteOn = cmd === 0x90 && d2 > 0;
    const isCc = cmd === 0xb0 && d2 > 0;

    if (actionId === MIDI_GLOBAL_ACTION_SPEED_PERCENT_KNOB && isNoteOn) {
      if (el.midiLearnHint) {
        el.midiLearnHint.textContent =
          "Para velocidad continua usa un knob/fader (CC), no una nota.";
      }
      continue;
    }

    if (isNoteOn) {
      const bKey = midiNoteBindingKey(channel, d1);
      saveGlobalMidiBindingForAction(actionId, bKey);
      if (el.midiLearnHint) {
        el.midiLearnHint.textContent = `Asignado a ${formatGlobalMidiActionLabel(
          actionId
        )}: ${formatMidiBindingLabel(bKey)}`;
      }
      midiLearnWaiting = false;
      midiLearnActionId = null;
      if (el.midiLearnDialog && typeof el.midiLearnDialog.close === "function") {
        el.midiLearnDialog.close();
      }
      return;
    }
    if (isCc) {
      const bKey = midiCcBindingKey(channel, d1);
      saveGlobalMidiBindingForAction(actionId, bKey);
      if (el.midiLearnHint) {
        el.midiLearnHint.textContent = `Asignado a ${formatGlobalMidiActionLabel(
          actionId
        )}: ${formatMidiBindingLabel(bKey)}`;
      }
      midiLearnWaiting = false;
      midiLearnActionId = null;
      if (el.midiLearnDialog && typeof el.midiLearnDialog.close === "function") {
        el.midiLearnDialog.close();
      }
      return;
    }
  }
}

async function onMidiLearnGlobalActionClick(id) {
  if (!id) return;
  const access = await ensureMidiAccess();
  if (!access) return;
  openMidiGlobalLearnDialog(id);
}

function restoreAdvancedToggle() {
  if (!el.chkAdvanced) return;
  let on = false;
  try {
    on = localStorage.getItem(ADVANCED_UI_STORAGE_KEY) === "1";
  } catch (_) {
    on = false;
  }
  el.chkAdvanced.checked = on;
  setAdvancedSectionVisible(on);
}

if (el.chkAdvanced) {
  el.chkAdvanced.addEventListener("change", () => {
    setAdvancedSectionVisible(el.chkAdvanced.checked);
  });
}
if (el.btnMidiScan) {
  el.btnMidiScan.addEventListener("click", () => {
    ensureMidiAccess().catch((err) => console.error(err));
  });
}
if (el.midiGlobalAssignMenu) {
  el.midiGlobalAssignMenu.addEventListener("click", (e) => {
    const learnBtn = e.target.closest("[data-midi-learn-global]");
    if (learnBtn) {
      const id = learnBtn.dataset.midiLearnGlobal;
      onMidiLearnGlobalActionClick(id).catch((err) => console.error(err));
      return;
    }
    const clearBtn = e.target.closest("[data-midi-clear-global]");
    if (clearBtn) {
      const id = clearBtn.dataset.midiClearGlobal;
      if (id) clearGlobalMidiAction(id);
    }
  });
}
if (el.btnMidiLearnCancel) {
  el.btnMidiLearnCancel.addEventListener("click", () => closeMidiLearnDialog());
}
if (el.midiLearnDialog) {
  el.midiLearnDialog.addEventListener("close", () => {
    midiLearnWaiting = false;
    midiLearnActionId = null;
  });
}

restoreAdvancedToggle();
