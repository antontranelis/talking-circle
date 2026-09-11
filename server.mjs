// Lokaler Server: liefert die Oberfläche aus und nimmt über WebSocket den
// Mikrofon-Ton entgegen. Alles bleibt auf diesem Rechner.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { WebSocketServer } from "ws";
import { Circle } from "./circle.mjs";
import { alsMarkdown } from "./protokoll.mjs";
import {
  benenneUm,
  gespeicherteRunden,
  gueltigeKennung,
  historie,
  ladeRunde,
  loesche,
  nimmZurueck,
  speichereMarkdown,
  stelleWiederHer,
} from "./archiv.mjs";

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
// Dieses hier ist das von Hand übernommene Gerät: das herumgereichte Mikrofon.
let aufnahmeClient = null;
// „Hier aufnehmen" gilt bis zur nächsten Übergabe. Ohne diese Frist ließe sich
// der Ton nie von dem Gerät zurückholen, an dem der Dranseiende sitzt.
let uebersteuert = false;
// Die Runde kann ein Gerät festlegen — das gilt, bis jemand es ändert oder das
// Gerät verschwindet. `null` heißt Automatik: Es nimmt auf, wer dran ist.
let aufnahmeWahl = null;
let naechsteKennung = 0;

const geraetVon = (kennung) => {
  for (const ws of clients) if (ws.kennung === kennung) return ws;
  return null;
};

// Wer das Mikrofon hat, nimmt auf seinem eigenen Gerät auf — das ist der Fall,
// wenn jeder mit seinem Telefon im Kreis sitzt. Ist er nicht erreichbar, oder
// hat jemand die Aufnahme ausdrücklich hergeholt, liefert das von Hand
// übernommene Gerät: das eine Mikrofon, das im Kreis herumgereicht wird.
function aufnahmeGeraet() {
  const vonHand = aufnahmeClient && clients.has(aufnahmeClient) ? aufnahmeClient.kennung : null;
  if (aufnahmeWahl !== null && geraetVon(aufnahmeWahl)) return aufnahmeWahl;
  if (uebersteuert && vonHand !== null) return vonHand;
  const dran = circle.state.teilnehmende.find((t) => t.id === circle.state.dran);
  if (dran?.da && geraetVon(dran.geraet)) return dran.geraet;
  return vonHand;
}

// Wer ist überhaupt verbunden — und wer sitzt an welchem Gerät? Daraus wählen
// die Einstellungen das Gerät aus, das den Ton liefert.
const geraeteListe = () =>
  [...clients].map((ws) => ({
    kennung: ws.kennung,
    namen: circle.state.teilnehmende.filter((t) => t.da && t.geraet === ws.kennung).map((t) => t.name),
  }));

const zustandMitAufnahme = () => ({
  ...circle.state,
  // Der Browser-Schlüssel ist die Platzkarte eines Geräts und bleibt dort.
  teilnehmende: circle.state.teilnehmende.map(({ schluessel, ...wer }) => wer),
  aufnahmeVon: aufnahmeGeraet(),
  aufnahmeWahl,
  geraete: geraeteListe(),
});

// Der Pegel reist mit dem Live-Text: So atmet der Platz des Sprechers auf
// jedem Gerät im Kreis, nicht nur auf dem, das gerade aufnimmt.
const live = () => ({ typ: "live", aktiv: circle.state.aktiv, pegel: circle.pegelJetzt });

const circle = new Circle({
  onChange: (art) => {
    if (art === "live" || art === "pegel") sendeAllen(live());
    else sendeAllen({ typ: "state", state: zustandMitAufnahme() });
  },
});

function sendeAllen(nachricht) {
  const roh = JSON.stringify(nachricht);
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) ws.send(roh);
  }
}

// Das Mikrofon wandert: an eine bestimmte Person oder an die nächste im Kreis.
// Der Beitrag der bisherigen Person wird dabei abgeschlossen.
async function mikrofonAn(id) {
  const teilnehmer = circle.gibMikrofonAn(id);
  if (!teilnehmer) return;
  uebersteuert = false; // ab hier nimmt wieder das Gerät dessen auf, der dran ist
  await circle.beitragStarten(teilnehmer.name);
}

const antworte = (res, code, daten) => {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(daten));
};

async function körper(req) {
  const stücke = [];
  for await (const teil of req) stücke.push(teil);
  try {
    return JSON.parse(Buffer.concat(stücke).toString() || "{}");
  } catch {
    return {};
  }
}

// Die laufende Runde wird alle paar Sekunden fortgeschrieben — eine Bearbeitung
// im Archiv wäre nach dem nächsten Wort wieder weg.
const laeuftGerade = (id) => id === circle.state.id;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const teile = url.pathname.split("/").filter(Boolean);

  // --- Archiv ---
  if (url.pathname === "/api/runden") {
    return antworte(res, 200, gespeicherteRunden());
  }
  if (url.pathname === "/api/papierkorb") {
    return antworte(res, 200, gespeicherteRunden({ geloescht: true }));
  }

  // /api/runde/<id>[/<was>]
  if (teile[0] === "api" && teile[1] === "runde" && teile[2]) {
    const id = decodeURIComponent(teile[2]);
    const was = teile[3];
    if (!gueltigeKennung(id)) return antworte(res, 404, { fehler: "Runde nicht gefunden" });

    if (req.method === "GET" && was === "historie") {
      return antworte(res, 200, historie(id));
    }
    if (req.method === "POST" && was === "wiederherstellen") {
      const { fehler, runde } = stelleWiederHer(id);
      return antworte(res, fehler ? 404 : 200, fehler ? { fehler } : { runde });
    }
    if (laeuftGerade(id) && req.method !== "GET") {
      return antworte(res, 409, {
        fehler: "Diese Runde läuft gerade. Beende sie erst mit „Neue Runde“, dann lässt sie sich bearbeiten.",
      });
    }
    if (req.method === "PUT" && !was) {
      const { markdown, zeitzone } = await körper(req);
      const { fehler, runde } = speichereMarkdown(id, markdown ?? "", { zeitzone });
      return antworte(res, fehler ? 404 : 200, fehler ? { fehler } : { runde });
    }
    if (req.method === "POST" && was === "umbenennen") {
      const { titel } = await körper(req);
      const { fehler, runde } = benenneUm(id, titel);
      return antworte(res, fehler ? 400 : 200, fehler ? { fehler } : { runde });
    }
    if (req.method === "POST" && was === "zurueck") {
      const { nr } = await körper(req);
      const { fehler, runde } = nimmZurueck(id, nr);
      return antworte(res, fehler ? 400 : 200, fehler ? { fehler } : { runde });
    }
    if (req.method === "DELETE" && !was) {
      const { fehler } = loesche(id);
      return antworte(res, fehler ? 404 : 200, fehler ? { fehler } : { ok: true });
    }
  }

  if (url.pathname === "/export.md") {
    res.writeHead(200, {
      "content-type": "text/markdown; charset=utf-8",
      "content-disposition": `attachment; filename="${circle.state.id}.md"`,
    });
    // Der Browser sagt, in welcher Zeitzone er sitzt.
    return res.end(circle.markdown(url.searchParams.get("tz") ?? undefined));
  }

  // Eine gespeicherte Runde einzeln — als Markdown zum Laden oder Bearbeiten,
  // als JSON für die Anzeige.
  const einzeln = url.pathname.match(/^\/runde\/([^/]+)\.(md|json)$/);
  if (einzeln) {
    const id = decodeURIComponent(einzeln[1]);
    const runde = ladeRunde(id) ?? ladeRunde(id, { geloescht: true });
    if (!runde) {
      res.writeHead(404);
      return res.end("Runde nicht gefunden");
    }
    if (einzeln[2] === "json") {
      return antworte(res, 200, runde);
    }
    const kopf = { "content-type": "text/markdown; charset=utf-8" };
    // Zum Bearbeiten wird der Text gelesen, nicht heruntergeladen.
    if (!url.searchParams.has("roh")) kopf["content-disposition"] = `attachment; filename="${id}.md"`;
    res.writeHead(200, kopf);
    return res.end(alsMarkdown(runde, url.searchParams.get("tz") ?? undefined));
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
  // Ein Gerät mehr im Raum: Das gehört in die Geräteliste aller Ansichten.
  sendeAllen({ typ: "state", state: zustandMitAufnahme() });

  ws.on("message", async (daten, istBinaer) => {
    if (istBinaer) {
      // Ton nur vom aufnehmenden Gerät; alles andere wird verworfen.
      if (ws.kennung !== aufnahmeGeraet()) return;
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
          uebersteuert = true;
          aufnahmeWahl = null; // von Hand geholt sticht die Festlegung
          sendeAllen({ typ: "state", state: zustandMitAufnahme() });
          break;
        // Die Einstellungen legen das Gerät fest; `null` ist wieder Automatik.
        case "aufnahmeGeraet":
          aufnahmeWahl = Number.isInteger(m.kennung) ? m.kennung : null;
          uebersteuert = false;
          sendeAllen({ typ: "state", state: zustandMitAufnahme() });
          break;
        case "beitreten": {
          // Mehrere Menschen dürfen an einem Gerät sitzen, deshalb antwortet der
          // Server dem Absender mit der Kennung genau dieses Menschen.
          const id = circle.beitreten(m.name, ws.kennung, m.schluessel);
          if (!id) break;
          const teilnehmer = circle.state.teilnehmende.find((t) => t.id === id);
          ws.send(JSON.stringify({ typ: "beigetreten", id, name: teilnehmer.name }));
          sendeAllen({ typ: "state", state: zustandMitAufnahme() });
          break;
        }
        case "verlassen":
          await circle.verlassen(m.id);
          break;
        case "reihenfolge":
          if (!circle.sortiere(m.ids)) {
            ws.send(
              JSON.stringify({
                typ: "fehler",
                text: "Der Kreis hat sich inzwischen geändert — die Reihenfolge wurde nicht übernommen.",
              }),
            );
          }
          break;
        case "weiter":
          await mikrofonAn(circle.naechster());
          break;
        case "dran":
          await mikrofonAn(m.id);
          break;
        case "neueRunde":
          await circle.neueRunde();
          break;
        case "setzen":
          circle.setzen(m);
          break;
        case "start": // ohne Kreis: ein Beitrag unter freiem Namen
          await circle.beitragStarten(m.sprecher ?? "Unbekannt");
          break;
        case "stop":
          await circle.beitragBeenden();
          break;
        // Anhalten ist kein Beenden: Aufnahme und Uhr stehen, der Beitrag
        // bleibt offen und läuft beim Fortsetzen weiter.
        case "pause":
          circle.anhalten();
          break;
        case "fortsetzen":
          circle.fortsetzen();
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
    // Die Menschen bleiben im Kreis, nur ihr Gerät ist weg — sie kommen mit
    // demselben Namen an denselben Platz zurück.
    circle.geraetGetrennt(ws.kennung);
    if (aufnahmeClient === ws) {
      aufnahmeClient = null;
      uebersteuert = false;
    }
    // Ein Gerät, das geht, kommt mit neuer Kennung wieder — die Festlegung
    // darf nicht auf eine tote Nummer zeigen.
    if (aufnahmeWahl === ws.kennung) aufnahmeWahl = null;
    sendeAllen({ typ: "state", state: zustandMitAufnahme() });
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
