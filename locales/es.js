/**
 * Cadenas de interfaz (español).
 * Para otro idioma: añade p. ej. locales/en.js con la misma forma y en i18n.js
 * importa ese módulo y llama a setLocale(en).
 */
export default {
  errors: {
    waveSurferTimeout:
      "No se pudo preparar la onda a tiempo. Prueba a recargar o con otro archivo.",
    waveSurferGeneric: "Error del visor de onda",
    waveSurferDetail: "Error del visor: {msg}",
    webAudioUnsupported: "Este navegador no admite Web Audio.",
    decodedDurationInvalid: "Audio decodificado pero duración inválida.",
    durationReadFailed:
      "No se pudo leer la duración del audio (¿archivo corrupto o no es audio?)",
  },
  file: {
    readFailed: "No se pudo leer el archivo",
    loadFailed: "Error al cargar audio",
    loadFailedShort: "Error al cargar",
  },
  loop: {
    boundsSwapped:
      "El final del bucle era anterior al inicio; se han intercambiado los tiempos.",
    disabled: "Bucle desactivado.",
    loadedPreset: "Bucle cargado: «{label}» (bucle activo).",
    defaultName: "Bucle {n}",
    saveMinSeconds: "Define inicio y fin con al menos {sec}s de diferencia.",
    saveOk: "Guardado: «{label}».",
    saveStorageFailed:
      "No se pudo guardar (almacenamiento lleno o privado).",
    enableSeeded:
      "Arrastra los bordes de la zona verde para acortar o alargar el bucle. También puedes dibujar otro tramo: clic en la onda, mantén pulsado y arrastra (sustituye el anterior).",
    enablePlain:
      "Bucle activo. Ajusta el tramo arrastrando los bordes de la zona verde.",
  },
  midi: {
    learnClockOnly:
      "Solo reloj MIDI en este paquete; pulsa una tecla, un pad o mueve un knob.",
    learnUnrecognized: "Paquete sin nota/CC reconocible. Hex: {hex}",
    learnAssigned: "Asignado: {detail}",
    dialogTitleLoop: "MIDI: «{label}»",
    dialogBodyLoop:
      "Pulsa la tecla, pad o knob (nota o CC) que quieras usar para saltar a este bucle.",
    dialogHintWaiting: "Pulsa una tecla, pad o mueve un knob…",
    presetNotFound: "No se encontró ese bucle.",
    needAudioFile: "Carga un archivo de audio primero.",
    rowLearnTitle:
      "Asigna una tecla, pad o knob del controlador a este bucle",
  },
  ui: {
    use: "Usar",
    delete: "Eliminar",
    learnMidi: "Aprender MIDI",
  },
  session: {
    restoring: "Restaurando la última pista…",
  },
};
