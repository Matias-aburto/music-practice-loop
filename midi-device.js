/**
 * Web MIDI: parsing de mensajes (running status), listado de puertos y texto de estado.
 * Compartido entre la app principal y /settings/midi.
 */

/**
 * @param {Map<string, number>} runningStatusByInputId
 * @param {string} inputId
 * @param {Uint8Array|DataView} data
 * @returns {{ cmd: number, channel: number, d1: number, d2: number }[]}
 */
export function expandMidiDataToVoiceMessages(runningStatusByInputId, inputId, data) {
  const messages = [];
  if (!data || data.length === 0) return messages;

  const bytes = new Uint8Array(
    data.buffer,
    data.byteOffset,
    data.byteLength
  );
  let running = runningStatusByInputId.get(inputId);

  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i];

    if (b >= 0xf8) {
      i += 1;
      continue;
    }

    if (b === 0xf0) {
      while (i < bytes.length && bytes[i] !== 0xf7) i += 1;
      if (i < bytes.length) i += 1;
      running = undefined;
      runningStatusByInputId.delete(inputId);
      continue;
    }
    if (b === 0xf7) {
      i += 1;
      running = undefined;
      runningStatusByInputId.delete(inputId);
      continue;
    }

    if (b === 0xf1 || b === 0xf3) {
      running = undefined;
      runningStatusByInputId.delete(inputId);
      i = Math.min(i + 2, bytes.length);
      continue;
    }
    if (b === 0xf2) {
      running = undefined;
      runningStatusByInputId.delete(inputId);
      i = Math.min(i + 3, bytes.length);
      continue;
    }
    if (b >= 0xf4 && b <= 0xf6) {
      running = undefined;
      runningStatusByInputId.delete(inputId);
      i += 1;
      continue;
    }

    if (b >= 0x80 && b <= 0xef) {
      running = b;
      runningStatusByInputId.set(inputId, running);
      i += 1;
      continue;
    }

    if (running === undefined || running < 0x80) {
      i += 1;
      continue;
    }

    const cmd = running & 0xf0;
    const channel = running & 0x0f;

    const oneDataByte = cmd === 0xc0 || cmd === 0xd0;
    if (i + (oneDataByte ? 1 : 2) > bytes.length) break;

    const d1 = bytes[i];
    i += 1;
    let d2 = 0;
    if (!oneDataByte) {
      d2 = bytes[i];
      i += 1;
    }

    if (d1 >= 0x80) continue;

    messages.push({ cmd, channel, d1, d2 });
  }

  return messages;
}

/**
 * @param {MIDIInputMap|MIDIOutputMap|undefined|null} portMap
 * @returns {MIDIPort[]}
 */
export function midiPortMapToArray(portMap) {
  const arr = [];
  if (!portMap) return arr;
  try {
    if (typeof portMap.forEach === "function") {
      portMap.forEach((port) => {
        arr.push(port);
      });
    }
  } catch (_) {
    /* ignore */
  }
  if (arr.length === 0) {
    try {
      if (typeof portMap.values === "function") {
        for (const p of portMap.values()) arr.push(p);
      }
    } catch (_) {
      /* ignore */
    }
  }
  return arr;
}

export function describeMidiInputPort(port) {
  const name = (port.name || "").trim();
  const mfr = (port.manufacturer || "").trim();
  const id = (port.id || "").trim();
  let main = name || id || "Entrada sin nombre";
  if (mfr && !main.toLowerCase().includes(mfr.toLowerCase())) {
    main = `${main} — ${mfr}`;
  }
  return main;
}

/**
 * @param {MIDIAccess|null} access
 * @param {HTMLElement|null} elSt
 */
export function updateMidiStatusFromAccess(access, elSt) {
  if (!elSt) return;
  elSt.classList.remove("is-ok", "is-warn", "is-err");
  if (!access) {
    elSt.textContent = "";
    return;
  }
  const allIn = midiPortMapToArray(access.inputs);
  const allOut = midiPortMapToArray(access.outputs);

  const connected = allIn.filter((p) => p.state === "connected");
  const disconnected = allIn.filter((p) => p.state === "disconnected");
  const unknownState = allIn.filter(
    (p) => p.state !== "connected" && p.state !== "disconnected"
  );

  if (connected.length > 0) {
    const lines = connected.map((p) => `• ${describeMidiInputPort(p)}`);
    const head =
      connected.length === 1
        ? "Dispositivo MIDI detectado:\n"
        : `${connected.length} dispositivos MIDI detectados:\n`;
    elSt.textContent = head + lines.join("\n");
    elSt.classList.add("is-ok");
    return;
  }

  if (unknownState.length > 0) {
    const lines = unknownState.map(
      (p) => `• ${describeMidiInputPort(p)} (estado: ${String(p.state)})`
    );
    elSt.textContent =
      "Entradas MIDI listadas (estado raro; probando escuchar igualmente):\n" +
      lines.join("\n");
    elSt.classList.add("is-warn");
    return;
  }

  if (disconnected.length > 0) {
    const lines = disconnected.map(
      (p) => `• ${describeMidiInputPort(p)} (desconectado)`
    );
    elSt.textContent =
      "Ninguna entrada conectada ahora. El navegador conoce estos puertos:\n" +
      lines.join("\n") +
      "\nEnciende el teclado o revisa el USB y vuelve a pulsar «Buscar teclado MIDI».";
    elSt.classList.add("is-warn");
    return;
  }

  let msg =
    "MIDI autorizado, pero Chrome/Edge no lista ninguna ENTRADA (solo el teclado por USB debería crear una).\n\n";
  if (allOut.length > 0) {
    msg +=
      "Salidas que sí ve el navegador (el Akai no suele bastar con esto para mandar notas a la web):\n";
    msg += allOut.map((p) => `• ${describeMidiInputPort(p)}`).join("\n");
    msg += "\n\n";
  }
  msg +=
    "Prueba: 1) Cierra Guitar Rig y cualquier DAW. 2) Desenchufa y vuelve a enchufar el USB (otro puerto). 3) Chrome o Edge actualizado. 4) La tecla «1» del teclado del PC no es MIDI: tienes que pulsar la tecla 1 del teclado/controlador USB.\n\n";
  msg +=
    "Windows: Configuración → Bluetooth y dispositivos → Dispositivos MIDI; o Panel de control → Sonido, y revisa que el dispositivo no esté «en uso exclusivo» por otra app.";
  elSt.textContent = msg;
  elSt.classList.add("is-warn");

  if (typeof console !== "undefined" && console.info) {
    console.info(
      "[MIDI] Entradas:",
      allIn.length,
      "Salidas:",
      allOut.length,
      "(si entradas=0 el navegador no puede recibir notas del teclado)"
    );
  }
}

export function isWebMidiBlockedByContext() {
  if (typeof window === "undefined") return true;
  return window.isSecureContext !== true;
}

export function midiBytesToHexPreview(data, maxBytes = 14) {
  if (!data || !data.length) return "";
  const n = Math.min(data.byteLength, maxBytes);
  const u = new Uint8Array(data.buffer, data.byteOffset, n);
  return Array.from(u)
    .map((x) => x.toString(16).padStart(2, "0"))
    .join(" ");
}
