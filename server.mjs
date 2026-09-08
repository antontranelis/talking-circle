// Lokaler Server: liefert die Oberfläche aus und nimmt über WebSocket den
// Mikrofon-Ton entgegen. Alles bleibt auf diesem Rechner.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { WebSocketServer } from "ws";
import { Circle } from "./circle.mjs";

const PORT = Number(process.env.PORT ?? 8123);
const HOST = process.env.HOST ?? "0.0.0.0";
const PUBLIC = path.join(import.meta.dirname, "public");

const TYPEN = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

const clients = new Set();
// Genau ein Gerät liefert den Ton. Alle anderen sehen zu — sonst mischen sich
// mehrere Mikrofone in denselben Erkennungsstrom und das Ergebnis ist Kauderwelsch.
let aufnahmeClient = null;
let naechsteKennung = 0;

const zustandMitAufnahme = () => ({
  ...circle.state,
  aufnahmeVon: aufnahmeClient?.kennung ?? null,
});

const circle = new Circle({
  onChange: (art) => {
    if (art === "live") sendeAllen({ typ: "live", aktiv: circle.state.aktiv });
    else sendeAllen({ typ: "state", state: zustandMitAufnahme() });
  },
});

function sendeAllen(nachricht) {
  const roh = JSON.stringify(nachricht);
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) ws.send(roh);
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/export.md") {
    res.writeHead(200, {
      "content-type": "text/markdown; charset=utf-8",
      "content-disposition": `attachment; filename="${circle.state.id}.md"`,
    });
    return res.end(circle.markdown());
  }
  const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const datei = path.join(PUBLIC, rel);
  if (!datei.startsWith(PUBLIC) || !fs.existsSync(datei)) {
    res.writeHead(404);
    return res.end("nicht gefunden");
  }
  res.writeHead(200, { "content-type": TYPEN[path.extname(datei)] ?? "application/octet-stream" });
  fs.createReadStream(datei).pipe(res);
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  ws.kennung = ++naechsteKennung;
  clients.add(ws);
  ws.send(JSON.stringify({ typ: "du", kennung: ws.kennung }));
  ws.send(JSON.stringify({ typ: "state", state: zustandMitAufnahme() }));

  ws.on("message", async (daten, istBinaer) => {
    if (istBinaer) {
      // Ton nur vom aufnehmenden Gerät; alles andere wird verworfen.
      if (ws !== aufnahmeClient) return;
      const kopie = new Float32Array(daten.buffer.slice(daten.byteOffset, daten.byteOffset + daten.byteLength));
      circle.fuettern(kopie);
      return;
    }
    let m;
    try {
      m = JSON.parse(daten.toString());
    } catch {
      return;
    }
    try {
      switch (m.typ) {
        case "aufnehmen":
          aufnahmeClient = ws;
          sendeAllen({ typ: "state", state: zustandMitAufnahme() });
          break;
        case "start":
          await circle.beitragStarten(m.sprecher ?? "Unbekannt");
          break;
        case "stop":
          await circle.beitragBeenden();
          break;
        case "neueRunde":
          await circle.neueRunde();
          break;
        case "setzen":
          circle.setzen(m);
          break;
        case "aendern":
          circle.beitragAendern(m.index, m);
          break;
        case "loeschen":
          circle.beitragLoeschen(m.index);
          break;
      }
    } catch (err) {
      console.error(`Befehl "${m.typ}" fehlgeschlagen:`, err.message);
      ws.send(JSON.stringify({ typ: "fehler", text: err.message }));
    }
  });

  ws.on("close", () => {
    clients.delete(ws);
    if (aufnahmeClient === ws) {
      aufnahmeClient = null;
      sendeAllen({ typ: "state", state: zustandMitAufnahme() });
    }
  });
});

server.listen(PORT, HOST, async () => {
  console.log(`Redekreis läuft:  http://localhost:${PORT}`);
  console.log("Lade Nemotron 3.5 ASR Streaming …");
  const t0 = Date.now();
  try {
    await circle.laden();
    console.log(`Modell bereit (${((Date.now() - t0) / 1000).toFixed(1)} s): ${circle.state.modell}`);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    console.log("\nRunde wird gesichert …");
    await circle.schliessen();
    console.log(`Protokoll: ${circle.pfade().md}`);
    process.exit(0);
  });
}
