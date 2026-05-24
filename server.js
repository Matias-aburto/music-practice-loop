/**
 * Servidor estático mínimo para servir la app por HTTP (recomendado para MP3 + módulos ES).
 * Depuración: GET /api/health
 *
 * Uso: node server.js
 * Puerto: PORT=4000 node server.js  o  npm start
 *
 * Si 3333 está ocupado (p. ej. otra ventana con npm start), se prueba 3334, 3335, …
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

const PREFERRED_PORT = Number(process.env.PORT) || 3333;
/** En Fly.io y similares no conviene saltar de puerto: el proxy espera el PORT inyectado. */
const IS_CONTAINER =
  Boolean(process.env.FLY_APP_NAME) || Boolean(process.env.K_SERVICE);
const MAX_PORT_TRIES = IS_CONTAINER ? 1 : 40;
const LISTEN_HOST = process.env.LISTEN_HOST || "0.0.0.0";
const ROOT = __dirname;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

function safePath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  const joined = path.normalize(path.join(ROOT, decoded));
  if (!joined.startsWith(ROOT)) return null;
  return joined;
}

function handleRequest(req, res) {
  const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);

  if (urlPath === "/api/health") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(
      JSON.stringify({
        ok: true,
        time: new Date().toISOString(),
        cwd: ROOT,
      })
    );
    return;
  }

  let filePath;
  if (urlPath === "/") {
    filePath = path.join(ROOT, "index.html");
  } else if (urlPath === "/settings/midi" || urlPath === "/settings/midi/") {
    filePath = path.join(ROOT, "settings", "midi", "index.html");
  } else {
    filePath = safePath(urlPath);
  }
  if (!filePath) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const type = MIME[ext] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": type });
    fs.createReadStream(filePath).pipe(res);
  });
}

function listenOnPort(port, triesLeft) {
  const server = http.createServer(handleRequest);

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE" && triesLeft > 1) {
      const next = port + 1;
      console.warn(
        `[server] Puerto ${port} en uso (EADDRINUSE). Probando ${next}…`
      );
      listenOnPort(next, triesLeft - 1);
      return;
    }
    console.error(err);
    process.exit(1);
  });

  server.listen(port, LISTEN_HOST, () => {
    if (port !== PREFERRED_PORT && !IS_CONTAINER) {
      console.warn(
        `[server] Usando puerto ${port} porque ${PREFERRED_PORT} estaba ocupado.`
      );
    }
    console.log(
      `Inverno → http://${LISTEN_HOST === "0.0.0.0" ? "localhost" : LISTEN_HOST}:${port}/`
    );
    console.log(`Estado (API) → /api/health`);
  });
}

listenOnPort(PREFERRED_PORT, MAX_PORT_TRIES);
