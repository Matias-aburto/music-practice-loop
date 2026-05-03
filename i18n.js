/**
 * Internacionalización mínima: un objeto de mensajes y función t().
 * Por defecto: español. Para cambiar de idioma: setLocale(otroModulo).
 */
import es from "./locales/es.js";

let active = es;

/**
 * @param {string} path p.ej. "loop.disabled"
 * @param {Record<string, string | number>} [vars] placeholders {clave} en la cadena
 */
export function t(path, vars = {}) {
  const keys = path.split(".");
  let cur = active;
  for (const k of keys) {
    if (cur == null || typeof cur !== "object") return path;
    cur = cur[k];
  }
  if (typeof cur !== "string") return path;
  return cur.replace(/\{(\w+)\}/g, (_, name) =>
    vars[name] != null ? String(vars[name]) : `{${name}}`
  );
}

/** @param {typeof es} localeModule export default del fichero de idioma */
export function setLocale(localeModule) {
  active = localeModule;
}

export function getLocale() {
  return active;
}
