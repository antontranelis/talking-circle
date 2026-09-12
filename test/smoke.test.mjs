// Ende-zu-Ende: Server starten, Ton wie das Browser-Worklet über WebSocket
// schicken, fertigen Beitrag im Protokoll prüfen.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";

const WURZEL = path.join(import.meta.dirname, "..");
const PORT = 8200 + Math.floor(Math.random() * 400);

function wavLesen(p) {
  const b = fs.readFileSync(p);
  let off = 12, daten = null, rate = 0, kanaele = 1;
  while (off + 8 <= b.length) {
    const id = b.toString("ascii", off, off + 4);
    const groesse = b.readUInt32LE(off + 4);
    if (id === "fmt ") { kanaele = b.readUInt16LE(off + 10); rate = b.readUInt32LE(off + 12); }
    if (id === "data") daten = b.subarray(off + 8, off + 8 + groesse);
    off += 8 + groesse + (groesse % 2);
  }
  assert.equal(rate, 16000, "Testton muss 16 kHz sein");
  const n = daten.length / 2 / kanaele;
  const pcm = new Float32Array(n);
  for (let i = 0; i < n; i++) pcm[i] = daten.readInt16LE(i * 2 * kanaele) / 32768;
  return pcm;
}

// Ein Ordner nur für diese Prüfung — das echte Archiv geht sie nichts an.
function probenOrdner(t) {
  const ordner = fs.mkdtempSync(path.join(os.tmpdir(), "redekreis-probe-"));
  t.after(() => fs.rmSync(ordner, { recursive: true, force: true }));
  return ordner;
}

// Jeder Test fährt einen eigenen Server hoch, damit die Runden sich nicht
// gegenseitig ins Protokoll reden — und schreibt in einen eigenen Ordner, der
// hinterher verschwindet. Das echte Archiv geht die Prüfung nichts an.
async function starteServer(t, port, zusatz = {}) {
  const ordner = probenOrdner(t);
  const server = spawn(process.execPath, ["server.mjs"], {
    cwd: WURZEL,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      TALKING_CIRCLE_TRANSCRIPTS: ordner,
      ...zusatz,
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  server.ordner = ordner;
  t.after(() => server.kill("SIGKILL"));
  await new Promise((ok, fehler) => {
    const frist = setTimeout(() => fehler(new Error("Modell wurde nicht rechtzeitig bereit")), 120_000);
    server.stdout.on("data", (d) => d.toString().includes("Modell bereit") && (clearTimeout(frist), ok()));
    server.on("exit", (code) => (clearTimeout(frist), fehler(new Error(`Server beendet mit ${code}`))));
  });
  return server;
}

// Ein Gerät: eine WebSocket-Leitung samt allem, was über sie hereinkommt.
async function verbinde(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const eingang = [];
  ws.on("message", (roh) => eingang.push(JSON.parse(roh.toString())));
  await new Promise((ok) => ws.on("open", ok));
  return { ws, eingang };
}

const warteAuf = async (pruefen, was, ms = 20_000) => {
  const frist = Date.now() + ms;
  while (Date.now() < frist) {
    const ergebnis = pruefen();
    if (ergebnis) return ergebnis;
    await new Promise((ok) => setTimeout(ok, 50));
  }
  throw new Error(`${was} kam nicht rechtzeitig`);
};

const letzterZustand = (eingang) => eingang.filter((m) => m.typ === "state").at(-1)?.state;

// Ein Mensch tritt von diesem Gerät aus bei; der Server antwortet mit seiner Kennung.
async function trittBei(ws, eingang, name) {
  ws.send(JSON.stringify({ typ: "beitreten", name }));
  const m = await warteAuf(
    () => eingang.find((m) => m.typ === "beigetreten" && m.name === name),
    `Beitritt von ${name}`,
    5000,
  );
  return m.id;
}

const meineKennung = async (eingang) =>
  (await warteAuf(() => eingang.find((m) => m.typ === "du"), "eigene Kennung", 5000)).kennung;

test("Redebeitrag wird aufgenommen, transkribiert und protokolliert", async (t) => {
  const ordner = probenOrdner(t);
  const server = spawn(process.execPath, ["server.mjs"], {
    cwd: WURZEL,
    env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", TALKING_CIRCLE_TRANSCRIPTS: ordner },
    stdio: ["ignore", "pipe", "inherit"],
  });
  t.after(() => server.kill("SIGKILL"));

  await new Promise((ok, fehler) => {
    const frist = setTimeout(() => fehler(new Error("Modell wurde nicht rechtzeitig bereit")), 120_000);
    server.stdout.on("data", (d) => {
      process.stdout.write(d.toString().replace(/^/gm, "  [server] "));
      if (d.toString().includes("Modell bereit")) {
        clearTimeout(frist);
        ok();
      }
    });
    server.on("exit", (code) => {
      clearTimeout(frist);
      fehler(new Error(`Server beendet mit ${code}`));
    });
  });

  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  const zustaende = [];
  ws.on("message", (roh) => zustaende.push(JSON.parse(roh.toString())));
  await new Promise((ok) => ws.on("open", ok));
  ws.send(JSON.stringify({ typ: "aufnehmen" })); // dieses Gerät liefert den Ton

  ws.send(JSON.stringify({ typ: "setzen", sprache: "de-DE", titel: "Testrunde" }));
  const anton = await trittBei(ws, zustaende, "Anton");
  await trittBei(ws, zustaende, "Eva");

  const pcm = wavLesen(path.join(import.meta.dirname, "fixtures", "german.wav"));
  const BLOCK = 2048; // wie das Worklet: 128 ms
  const senden = async (von, bis) => {
    for (let i = von; i < bis; i += BLOCK) {
      const teil = pcm.subarray(i, Math.min(i + BLOCK, bis));
      ws.send(Buffer.from(teil.buffer, teil.byteOffset, teil.byteLength));
      await new Promise((ok) => setTimeout(ok, 8));
    }
  };

  // Anton redet schon los, bevor die Übergabe bestätigt ist: der Vorlauf-Puffer
  // muss den Satzanfang trotzdem in den Beitrag holen.
  const VORLAUF = 8 * BLOCK; // ~1 s
  await senden(0, VORLAUF);
  ws.send(JSON.stringify({ typ: "dran", id: anton }));
  await senden(VORLAUF, pcm.length);

  // Auf einen Live-Zwischenstand warten — das ist der Sinn der Sache.
  const bisLive = Date.now() + 30_000;
  while (Date.now() < bisLive && !zustaende.some((m) => m.typ === "live" && m.aktiv?.committed)) {
    await new Promise((ok) => setTimeout(ok, 100));
  }
  const live = zustaende.filter((m) => m.typ === "live" && m.aktiv?.committed);
  assert.ok(
    live.length > 0,
    `es kam kein Live-Text an; empfangen: ${JSON.stringify(zustaende.slice(-4))}`,
  );

  ws.send(JSON.stringify({ typ: "stop" }));
  const bisFertig = Date.now() + 30_000;
  let letzter;
  while (Date.now() < bisFertig) {
    letzter = zustaende.filter((m) => m.typ === "state").at(-1);
    if (letzter?.state.beitraege.length) break;
    await new Promise((ok) => setTimeout(ok, 100));
  }

  const beitraege = letzter.state.beitraege;
  assert.equal(beitraege.length, 1);
  assert.equal(beitraege[0].sprecher, "Anton");
  // Anfang: kam aus dem Vorlauf-Puffer. Ende: darf beim Weitergeben nicht
  // verworfen werden, während noch Ton in der Verarbeitung steckt.
  assert.match(beitraege[0].text, /^Am Strand der Badeanzug/i, "der Satzanfang aus dem Vorlauf fehlt");
  assert.match(beitraege[0].text, /Wellen\.?$/i, "das Ende des Beitrags wurde beim Weitergeben verworfen");
  console.log(`  → "${beitraege[0].text}"`);

  const md = fs.readFileSync(path.join(ordner, `${letzter.state.id}.md`), "utf8");
  assert.match(md, /# Testrunde/);
  assert.match(md, /## Anton/);
  ws.close();
});

test("Neue Runde leert die Anzeige und lässt das Protokoll auf der Platte", async (t) => {
  const ordner = probenOrdner(t);
  const server = spawn(process.execPath, ["server.mjs"], {
    cwd: WURZEL,
    env: { ...process.env, PORT: String(PORT + 1), HOST: "127.0.0.1", TALKING_CIRCLE_TRANSCRIPTS: ordner },
    stdio: ["ignore", "pipe", "inherit"],
  });
  t.after(() => server.kill("SIGKILL"));
  await new Promise((ok, fehler) => {
    const frist = setTimeout(() => fehler(new Error("Modell wurde nicht rechtzeitig bereit")), 120_000);
    server.stdout.on("data", (d) => d.toString().includes("Modell bereit") && (clearTimeout(frist), ok()));
    server.on("exit", (code) => (clearTimeout(frist), fehler(new Error(`Server beendet mit ${code}`))));
  });

  const ws = new WebSocket(`ws://127.0.0.1:${PORT + 1}`);
  const zustaende = [];
  ws.on("message", (roh) => zustaende.push(JSON.parse(roh.toString())));
  await new Promise((ok) => ws.on("open", ok));
  ws.send(JSON.stringify({ typ: "aufnehmen" })); // dieses Gerät liefert den Ton

  const letzterZustand = () => zustaende.filter((m) => m.typ === "state").at(-1)?.state;
  const warten = async (pruefen) => {
    const frist = Date.now() + 20_000;
    while (Date.now() < frist) {
      const jetzt = letzterZustand();
      if (jetzt && pruefen(jetzt)) return jetzt;
      await new Promise((ok) => setTimeout(ok, 50));
    }
    throw new Error("Zustand kam nicht rechtzeitig");
  };

  ws.send(JSON.stringify({ typ: "setzen", titel: "Erste Runde" }));
  await trittBei(ws, zustaende, "Anton");
  const pcm = wavLesen(path.join(import.meta.dirname, "fixtures", "german.wav"));
  ws.send(JSON.stringify({ typ: "weiter" }));
  const teil = pcm.subarray(0, 16000 * 4);
  ws.send(Buffer.from(teil.buffer, teil.byteOffset, teil.byteLength));
  ws.send(JSON.stringify({ typ: "stop" }));
  const erste = await warten((s) => s.beitraege.length === 1);
  const protokoll = path.join(ordner, `${erste.id}.md`);
  assert.ok(fs.existsSync(protokoll), "Protokoll der ersten Runde fehlt");

  ws.send(JSON.stringify({ typ: "neueRunde" }));
  const zweite = await warten((s) => s.beitraege.length === 0);
  assert.notEqual(zweite.id, erste.id, "die neue Runde übernimmt die alte Kennung");
  assert.equal(zweite.beitraege.length, 0);
  assert.deepEqual(zweite.teilnehmende.map((t) => t.name), ["Anton"], "der Kreis bleibt stehen");
  assert.equal(zweite.dran, null, "die neue Runde fängt ohne Mikrofon an");
  assert.ok(fs.existsSync(protokoll), "das Protokoll der alten Runde wurde weggeräumt");
  assert.ok(!fs.existsSync(path.join(ordner, `${zweite.id}.md`)), "leere Runde schreibt eine Datei");
  ws.close();
});

test("Ein Export mitten im Beitrag enthält, was gerade gesagt wurde", async (t) => {
  const port = PORT + 2;
  const server = await starteServer(t, port);

  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const zustaende = [];
  ws.on("message", (roh) => zustaende.push(JSON.parse(roh.toString())));
  await new Promise((ok) => ws.on("open", ok));
  ws.send(JSON.stringify({ typ: "aufnehmen" })); // dieses Gerät liefert den Ton

  ws.send(JSON.stringify({ typ: "setzen", titel: "Mittendrin" }));
  await trittBei(ws, zustaende, "Anton");
  ws.send(JSON.stringify({ typ: "weiter" }));
  const pcm = wavLesen(path.join(import.meta.dirname, "fixtures", "german.wav"));
  const teil = pcm.subarray(0, 16000 * 12);
  for (let i = 0; i < teil.length; i += 2048) {
    const block = teil.subarray(i, Math.min(i + 2048, teil.length));
    ws.send(Buffer.from(block.buffer, block.byteOffset, block.byteLength));
    await new Promise((ok) => setTimeout(ok, 8));
  }

  // Der Beitrag läuft weiter — es wird kein "stop" geschickt.
  const frist = Date.now() + 20_000;
  let live;
  while (Date.now() < frist) {
    live = zustaende.filter((m) => m.typ === "live" && m.aktiv?.committed).at(-1);
    if (live) break;
    await new Promise((ok) => setTimeout(ok, 50));
  }
  assert.ok(live, "es kam kein Live-Text an");
  const gesagt = live.aktiv.committed.split(" ").slice(0, 3).join(" ");

  const md = await fetch(`http://127.0.0.1:${port}/export.md`).then((r) => r.text());
  assert.match(md, /# Mittendrin/);
  assert.match(md, /spricht noch/, "der laufende Beitrag fehlt im Export");
  assert.ok(md.includes(gesagt), `der Export enthält "${gesagt}" nicht`);

  // Auf der Platte darf der Stand höchstens einen Takt hinterherhinken.
  const zustand = zustaende.filter((m) => m.typ === "state").at(-1).state;
  const datei = path.resolve(WURZEL, zustand.datei);
  const bisGeschrieben = Date.now() + 8000;
  let aufPlatte = "";
  while (Date.now() < bisGeschrieben) {
    aufPlatte = fs.existsSync(datei) ? fs.readFileSync(datei, "utf8") : "";
    if (aufPlatte.includes(gesagt)) break;
    await new Promise((ok) => setTimeout(ok, 200));
  }
  assert.ok(aufPlatte.includes(gesagt), "der laufende Beitrag steht nicht auf der Platte");
  ws.close();
});

test("Eine Runde über viele Übergaben hinweg bleibt sprechfähig", async (t) => {
  // Der Fehler, den das hier abfängt: ohne stream.reset() nimmt die Sitzung
  // nach wenigen Beiträgen keinen neuen mehr an — stumm, ohne Fehlermeldung.
  const port = PORT + 3;
  const server = await starteServer(t, port);

  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const zustaende = [];
  ws.on("message", (roh) => zustaende.push(JSON.parse(roh.toString())));
  await new Promise((ok) => ws.on("open", ok));
  ws.send(JSON.stringify({ typ: "aufnehmen" })); // dieses Gerät liefert den Ton

  const namen = ["Anton", "Eva", "Emil", "Agnes", "Timo", "Holger", "Jonathan", "Janosch"];
  ws.send(JSON.stringify({ typ: "setzen", titel: "Lange Runde" }));
  for (const name of namen) await trittBei(ws, zustaende, name);

  const pcm = wavLesen(path.join(import.meta.dirname, "fixtures", "german.wav"));
  const stueck = pcm.subarray(0, 16000 * 5); // fünf Sekunden je Beitrag

  const UEBERGABEN = 8;
  for (let n = 0; n < UEBERGABEN; n++) {
    ws.send(JSON.stringify({ typ: "weiter" })); // der Reihe nach durch den Kreis
    for (let i = 0; i < stueck.length; i += 2048) {
      const block = stueck.subarray(i, Math.min(i + 2048, stueck.length));
      ws.send(Buffer.from(block.buffer, block.byteOffset, block.byteLength));
      await new Promise((ok) => setTimeout(ok, 4));
    }
    ws.send(JSON.stringify({ typ: "stop" }));
    const frist = Date.now() + 25_000;
    while (Date.now() < frist) {
      const s = zustaende.filter((m) => m.typ === "state").at(-1)?.state;
      if (s && s.beitraege.length === n + 1) break;
      await new Promise((ok) => setTimeout(ok, 50));
    }
  }

  const beitraege = zustaende.filter((m) => m.typ === "state").at(-1).state.beitraege;
  assert.equal(beitraege.length, UEBERGABEN, "nicht jede Übergabe hat einen Beitrag ergeben");
  assert.deepEqual(beitraege.map((b) => b.sprecher), namen, "das Mikrofon ist nicht der Reihe nach gewandert");
  const stumm = beitraege.map((b, i) => [i + 1, b.text]).filter(([, t]) => !/Badeanzug/i.test(t));
  assert.deepEqual(stumm, [], `diese Beiträge blieben ohne Text: ${JSON.stringify(stumm)}`);
  ws.close();
});

test("Verstummt die Erkennung, setzt der Server sie selbst neu auf", async (t) => {
  const port = PORT + 4;
  const server = spawn(process.execPath, ["server.mjs"], {
    cwd: WURZEL,
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", TALKING_CIRCLE_TRANSCRIPTS: probenOrdner(t) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Beim Neuaufsetzen darf kein Ton verloren gehen — er gehört in den neuen Strom.
  let fehlerausgabe = "";
  server.stderr.on("data", (d) => (fehlerausgabe += d.toString()));
  t.after(() => server.kill("SIGKILL"));
  await new Promise((ok, fehler) => {
    const frist = setTimeout(() => fehler(new Error("Modell wurde nicht rechtzeitig bereit")), 120_000);
    server.stdout.on("data", (d) => d.toString().includes("Modell bereit") && (clearTimeout(frist), ok()));
    server.on("exit", (code) => (clearTimeout(frist), fehler(new Error(`Server beendet mit ${code}`))));
  });

  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const zustaende = [];
  ws.on("message", (roh) => zustaende.push(JSON.parse(roh.toString())));
  await new Promise((ok) => ws.on("open", ok));
  ws.send(JSON.stringify({ typ: "aufnehmen" })); // dieses Gerät liefert den Ton
  ws.send(JSON.stringify({ typ: "setzen", titel: "Wachhund" }));
  await trittBei(ws, zustaende, "Anton");
  ws.send(JSON.stringify({ typ: "weiter" }));

  // Rauschen: hat Pegel, ist aber keine Sprache — das Modell liefert nichts.
  // Der Wachhund muss das als hängenden Strom erkennen. In Echtzeit gefüttert,
  // weil seine Frist an der Uhr hängt.
  // Schneller als Echtzeit gefüttert, damit sich — wie auf dem Server unter
  // Last — Ton in der Warteschlange staut, während der Wachhund zuschlägt.
  const rauschen = new Float32Array(2048);
  const bisNeuaufsetzer = Date.now() + 40_000;
  let neuaufsetzer = 0;
  while (Date.now() < bisNeuaufsetzer && neuaufsetzer === 0) {
    for (let i = 0; i < rauschen.length; i++) rauschen[i] = (Math.random() - 0.5) * 0.2;
    ws.send(Buffer.from(rauschen.buffer, rauschen.byteOffset, rauschen.byteLength));
    await new Promise((ok) => setTimeout(ok, 20));
    neuaufsetzer = zustaende.filter((m) => m.typ === "state").at(-1)?.state.neuaufsetzer ?? 0;
  }
  assert.ok(neuaufsetzer >= 1, "der Wachhund hat nicht angeschlagen");

  // Nach dem Neuaufsetzen muss echte Sprache wieder ankommen.
  const pcm = wavLesen(path.join(import.meta.dirname, "fixtures", "german.wav"));
  const stueck = pcm.subarray(0, 16000 * 8);
  for (let i = 0; i < stueck.length; i += 2048) {
    const block = stueck.subarray(i, Math.min(i + 2048, stueck.length));
    ws.send(Buffer.from(block.buffer, block.byteOffset, block.byteLength));
    await new Promise((ok) => setTimeout(ok, 6));
  }
  ws.send(JSON.stringify({ typ: "stop" }));

  const frist = Date.now() + 30_000;
  let beitraege = [];
  while (Date.now() < frist) {
    beitraege = zustaende.filter((m) => m.typ === "state").at(-1)?.state.beitraege ?? [];
    if (beitraege.length) break;
    await new Promise((ok) => setTimeout(ok, 100));
  }
  assert.equal(beitraege.length, 1);
  assert.match(beitraege[0].text, /Badeanzug/i, "nach dem Neuaufsetzen kam kein Text mehr");
  assert.doesNotMatch(
    fehlerausgabe,
    /Feed fehlgeschlagen/,
    `beim Neuaufsetzen ging Ton verloren:\n${fehlerausgabe}`,
  );
  ws.close();
});

test("Nur das aufnehmende Gerät liefert Ton, Zuschauer stören nicht", async (t) => {
  // Vorher kippten alle verbundenen Browser ihr Mikrofon in denselben
  // Erkennungsstrom: doppelte Rechenlast und zerhackter Text.
  const port = PORT + 5;
  const server = await starteServer(t, port);

  const aufnehmer = await verbinde(port);
  const zuschauer = await verbinde(port);
  aufnehmer.ws.send(JSON.stringify({ typ: "aufnehmen" }));
  aufnehmer.ws.send(JSON.stringify({ typ: "setzen", titel: "Zwei Geräte" }));
  await trittBei(aufnehmer.ws, aufnehmer.eingang, "Anton");
  aufnehmer.ws.send(JSON.stringify({ typ: "weiter" }));

  const pcm = wavLesen(path.join(import.meta.dirname, "fixtures", "german.wav"));
  const rauschen = new Float32Array(2048);
  for (let i = 0; i < pcm.length; i += 2048) {
    const block = pcm.subarray(i, Math.min(i + 2048, pcm.length));
    aufnehmer.ws.send(Buffer.from(block.buffer, block.byteOffset, block.byteLength));
    // Der Zuschauer hat sein Mikrofon offen und schickt munter mit.
    for (let k = 0; k < rauschen.length; k++) rauschen[k] = (Math.random() - 0.5) * 0.4;
    zuschauer.ws.send(Buffer.from(rauschen.buffer, rauschen.byteOffset, rauschen.byteLength));
    await new Promise((ok) => setTimeout(ok, 5));
  }
  aufnehmer.ws.send(JSON.stringify({ typ: "stop" }));

  const frist = Date.now() + 30_000;
  let beitraege = [];
  while (Date.now() < frist) {
    beitraege = aufnehmer.eingang.filter((m) => m.typ === "state").at(-1)?.state.beitraege ?? [];
    if (beitraege.length) break;
    await new Promise((ok) => setTimeout(ok, 100));
  }
  assert.equal(beitraege.length, 1);
  assert.match(beitraege[0].text, /^Am Strand der Badeanzug/i, "der Zuschauer hat die Aufnahme verdorben");
  assert.match(beitraege[0].text, /Wellen\.?$/i, "der Zuschauer hat die Aufnahme verdorben");

  // Und der Zuschauer sieht trotzdem alles mit.
  const beimZuschauer = zuschauer.eingang.filter((m) => m.typ === "state").at(-1)?.state.beitraege ?? [];
  assert.equal(beimZuschauer.length, 1, "der Zuschauer sieht die Runde nicht");
  aufnehmer.ws.close();
  zuschauer.ws.close();
});

test("Das heruntergeladene Protokoll zeigt die Zeit der eigenen Zeitzone", async (t) => {
  // Der Container läuft auf UTC; ohne Zeitzone stünden im Protokoll Uhrzeiten,
  // die zwei Stunden neben der Runde liegen.
  const port = PORT + 6;
  const server = await starteServer(t, port, { TZ: "UTC" });

  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const zustaende = [];
  ws.on("message", (roh) => zustaende.push(JSON.parse(roh.toString())));
  await new Promise((ok) => ws.on("open", ok));
  ws.send(JSON.stringify({ typ: "aufnehmen" }));
  ws.send(JSON.stringify({ typ: "setzen", titel: "Zeitzone" }));
  await trittBei(ws, zustaende, "Anton");
  ws.send(JSON.stringify({ typ: "weiter" }));

  const pcm = wavLesen(path.join(import.meta.dirname, "fixtures", "german.wav"));
  const teil = pcm.subarray(0, 16000 * 5);
  for (let i = 0; i < teil.length; i += 2048) {
    const block = teil.subarray(i, Math.min(i + 2048, teil.length));
    ws.send(Buffer.from(block.buffer, block.byteOffset, block.byteLength));
    await new Promise((ok) => setTimeout(ok, 5));
  }
  ws.send(JSON.stringify({ typ: "stop" }));
  const frist = Date.now() + 30_000;
  while (Date.now() < frist) {
    if (zustaende.filter((m) => m.typ === "state").at(-1)?.state.beitraege.length) break;
    await new Promise((ok) => setTimeout(ok, 100));
  }

  const hole = async (tz) =>
    fetch(`http://127.0.0.1:${port}/export.md${tz ? `?tz=${encodeURIComponent(tz)}` : ""}`).then((r) => r.text());
  const stunde = (md) => Number(md.match(/^## Anton · (\d{2}):/m)[1]);

  const utc = stunde(await hole("UTC"));
  const berlin = stunde(await hole("Europe/Berlin"));
  const tokio = stunde(await hole("Asia/Tokyo"));
  const versatz = (a, b) => (a - b + 24) % 24;

  assert.equal(versatz(berlin, utc), 2, "Berlin liegt im Sommer zwei Stunden vor UTC");
  assert.equal(versatz(tokio, utc), 9, "Tokio liegt neun Stunden vor UTC");
  // Unsinnige Angaben dürfen den Abruf nicht sprengen.
  assert.match(await hole("Kein/Ort"), /## Anton · \d{2}:\d{2}/);
  ws.close();
});

test("Jede Runde liegt auch im Zeilenformat des Session-Archivs vor", async (t) => {
  const port = PORT + 7;
  const server = await starteServer(t, port);

  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const zustaende = [];
  ws.on("message", (roh) => zustaende.push(JSON.parse(roh.toString())));
  await new Promise((ok) => ws.on("open", ok));
  ws.send(JSON.stringify({ typ: "aufnehmen" }));
  ws.send(JSON.stringify({ typ: "setzen", titel: "Archivprobe" }));
  for (const name of ["Agnes", "Emil"]) await trittBei(ws, zustaende, name);

  const pcm = wavLesen(path.join(import.meta.dirname, "fixtures", "german.wav"));
  const teil = pcm.subarray(0, 16000 * 5);
  for (const sprecher of ["Agnes", "Emil"]) {
    ws.send(JSON.stringify({ typ: "weiter" }));
    for (let i = 0; i < teil.length; i += 2048) {
      const block = teil.subarray(i, Math.min(i + 2048, teil.length));
      ws.send(Buffer.from(block.buffer, block.byteOffset, block.byteLength));
      await new Promise((ok) => setTimeout(ok, 5));
    }
    ws.send(JSON.stringify({ typ: "stop" }));
    const frist = Date.now() + 25_000;
    while (Date.now() < frist) {
      const n = zustaende.filter((m) => m.typ === "state").at(-1)?.state.beitraege.length ?? 0;
      if (n === (sprecher === "Agnes" ? 1 : 2)) break;
      await new Promise((ok) => setTimeout(ok, 50));
    }
  }

  const zustand = zustaende.filter((m) => m.typ === "state").at(-1).state;
  const datei = path.resolve(WURZEL, zustand.datei.replace(/\.md$/, ".jsonl"));
  const zeilen = fs.readFileSync(datei, "utf8").trim().split("\n").map((z) => JSON.parse(z));

  // Erste Zeile ist der Titel — daraus baut das Archiv den Sessionnamen.
  assert.equal(zeilen[0].message.role, "user");
  assert.match(zeilen[0].message.content, /^Redekreis: Archivprobe · 2 Beiträge · mit Agnes, Emil/);

  // Danach je Beitrag eine Zeile, der Sprecher steht als Rolle darin.
  assert.deepEqual(zeilen.slice(1).map((z) => z.message.role), ["Agnes", "Emil"]);
  for (const z of zeilen.slice(1)) {
    assert.equal(z.type, "user", "das Archiv liest nur user/assistant/summary");
    assert.match(z.message.content, /Badeanzug/i);
    assert.ok(!Number.isNaN(Date.parse(z.timestamp)), "Zeitstempel nicht lesbar");
  }
  ws.close();
});

test("Das Archiv listet frühere Runden und gibt sie einzeln heraus", async (t) => {
  const port = PORT + 8;
  const server = await starteServer(t, port);

  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const zustaende = [];
  ws.on("message", (roh) => zustaende.push(JSON.parse(roh.toString())));
  await new Promise((ok) => ws.on("open", ok));
  ws.send(JSON.stringify({ typ: "aufnehmen" }));
  ws.send(JSON.stringify({ typ: "setzen", titel: "Archivrunde" }));
  await trittBei(ws, zustaende, "Timo");
  ws.send(JSON.stringify({ typ: "weiter" }));

  const pcm = wavLesen(path.join(import.meta.dirname, "fixtures", "german.wav"));
  const teil = pcm.subarray(0, 16000 * 5);
  for (let i = 0; i < teil.length; i += 2048) {
    const block = teil.subarray(i, Math.min(i + 2048, teil.length));
    ws.send(Buffer.from(block.buffer, block.byteOffset, block.byteLength));
    await new Promise((ok) => setTimeout(ok, 5));
  }
  ws.send(JSON.stringify({ typ: "stop" }));
  const frist = Date.now() + 25_000;
  while (Date.now() < frist) {
    if (zustaende.filter((m) => m.typ === "state").at(-1)?.state.beitraege.length) break;
    await new Promise((ok) => setTimeout(ok, 50));
  }
  const id = zustaende.filter((m) => m.typ === "state").at(-1).state.id;

  const liste = await fetch(`http://127.0.0.1:${port}/api/runden`).then((r) => r.json());
  const meine = liste.find((r) => r.id === id);
  assert.ok(meine, "die Runde fehlt im Archiv");
  assert.equal(meine.titel, "Archivrunde");
  assert.deepEqual(meine.sprecher, ["Timo"]);
  assert.equal(meine.anzahl, 1);
  assert.ok(liste.every((r, i) => i === 0 || liste[i - 1].begonnen >= r.begonnen), "nicht jüngste zuerst");

  const einzeln = await fetch(`http://127.0.0.1:${port}/runde/${id}.json`).then((r) => r.json());
  assert.match(einzeln.beitraege[0].text, /Badeanzug/i);

  const md = await fetch(`http://127.0.0.1:${port}/runde/${id}.md?tz=Asia/Tokyo`);
  assert.equal(md.headers.get("content-disposition"), `attachment; filename="${id}.md"`);
  const text = await md.text();
  assert.match(text, /^# Archivrunde/);
  assert.match(text, /## Timo · \d{2}:\d{2}/);

  // Über die Kennung darf kein anderer Pfad erreichbar sein.
  for (const boese of ["..%2F..%2Fpackage", "nicht-vorhanden", "2026-01-01T00-00-00"]) {
    const r = await fetch(`http://127.0.0.1:${port}/runde/${boese}.json`);
    assert.equal(r.status, 404, `${boese} haette nicht ausgeliefert werden duerfen`);
  }
  ws.close();
});

test("Protokolle lassen sich über die Schnittstelle korrigieren und zurücknehmen", async (t) => {
  const port = PORT + 9;
  const server = await starteServer(t, port, { TZ: "Europe/Berlin" });

  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const zustaende = [];
  ws.on("message", (roh) => zustaende.push(JSON.parse(roh.toString())));
  await new Promise((ok) => ws.on("open", ok));
  ws.send(JSON.stringify({ typ: "aufnehmen" }));
  ws.send(JSON.stringify({ typ: "setzen", titel: "Korrekturrunde" }));
  for (const name of ["Anton", "Eva"]) await trittBei(ws, zustaende, name);
  ws.send(JSON.stringify({ typ: "weiter" }));

  const pcm = wavLesen(path.join(import.meta.dirname, "fixtures", "german.wav"));
  const teil = pcm.subarray(0, 16000 * 6);
  for (let i = 0; i < teil.length; i += 2048) {
    const block = teil.subarray(i, Math.min(i + 2048, teil.length));
    ws.send(Buffer.from(block.buffer, block.byteOffset, block.byteLength));
    await new Promise((ok) => setTimeout(ok, 5));
  }
  ws.send(JSON.stringify({ typ: "stop" }));
  const frist = Date.now() + 25_000;
  while (Date.now() < frist) {
    if (zustaende.filter((m) => m.typ === "state").at(-1)?.state.beitraege.length) break;
    await new Promise((ok) => setTimeout(ok, 50));
  }
  const id = zustaende.filter((m) => m.typ === "state").at(-1).state.id;
  const url = `http://127.0.0.1:${port}`;
  const json = (p, o) => fetch(`${url}${p}`, o).then(async (r) => ({ status: r.status, daten: await r.json() }));

  // Die laufende Runde darf nicht bearbeitet werden — sie würde sich selbst überschreiben.
  const gesperrt = await json(`/api/runde/${id}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ markdown: "# Nein", zeitzone: "Europe/Berlin" }),
  });
  assert.equal(gesperrt.status, 409, "die laufende Runde war bearbeitbar");

  // Nach dem Rundenwechsel ist sie es.
  ws.send(JSON.stringify({ typ: "neueRunde" }));
  await new Promise((ok) => setTimeout(ok, 600));

  // Der typische Fall: ein Beitrag enthält zwei Sprecher und wird geteilt.
  const roh = await fetch(`${url}/runde/${id}.md?roh=1&tz=Europe/Berlin`).then((r) => r.text());
  const kopfZeile = roh.match(/^## .*$/m)[0];
  const uhr = kopfZeile.match(/(\d{2}:\d{2})/)[1];
  const geteilt = `# Korrekturrunde\n\n${kopfZeile}\n\nErster Teil.\n\n## Eva · ${uhr}\n\nZweiter Teil von Eva.\n`;
  const gespeichert = await json(`/api/runde/${id}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ markdown: geteilt, zeitzone: "Europe/Berlin" }),
  });
  assert.equal(gespeichert.status, 200);
  assert.deepEqual(gespeichert.daten.runde.beitraege.map((b) => b.sprecher), ["Anton", "Eva"]);

  // Umbenennen
  await json(`/api/runde/${id}/umbenennen`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ titel: "Umbenannt" }),
  });
  const nachher = await json(`/runde/${id}.json`);
  assert.equal(nachher.daten.titel, "Umbenannt");

  // Der Verlauf kennt beide Schritte, jüngster zuletzt.
  const schritte = (await json(`/api/runde/${id}/historie`)).daten;
  assert.deepEqual(schritte.map((s) => s.aktion), ["bearbeitet", "umbenannt"]);

  // Zurücknehmen der Bearbeitung stellt den Originaltext wieder her.
  await json(`/api/runde/${id}/zurueck`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ nr: schritte[0].nr }),
  });
  const zurueck = (await json(`/runde/${id}.json`)).daten;
  assert.equal(zurueck.beitraege.length, 1);
  assert.match(zurueck.beitraege[0].text, /Badeanzug/i);

  // Löschen und Wiederherstellen
  await fetch(`${url}/api/runde/${id}`, { method: "DELETE" });
  assert.ok(!(await json("/api/runden")).daten.some((r) => r.id === id));
  assert.ok((await json("/api/papierkorb")).daten.some((r) => r.id === id));
  await json(`/api/runde/${id}/wiederherstellen`, { method: "POST" });
  assert.ok((await json("/api/runden")).daten.some((r) => r.id === id));
  ws.close();
});

test("Das Mikrofon wandert auf das Gerät dessen, der dran ist", async (t) => {
  // Zwei Menschen, zwei Geräte: Beim Weiterreichen muss die Aufnahme mitgehen,
  // sonst redet der Nächste in ein Mikrofon, das anderswo im Raum liegt.
  const port = PORT + 10;
  await starteServer(t, port);
  const a = await verbinde(port);
  const b = await verbinde(port);
  const kennungA = await meineKennung(a.eingang);
  const kennungB = await meineKennung(b.eingang);

  a.ws.send(JSON.stringify({ typ: "setzen", titel: "Zwei Geräte, zwei Menschen" }));
  await trittBei(a.ws, a.eingang, "Anton");
  await trittBei(b.ws, b.eingang, "Eva");

  const pcm = wavLesen(path.join(import.meta.dirname, "fixtures", "german.wav"));
  const stueck = pcm.subarray(0, 16000 * 6);
  const rauschen = new Float32Array(2048);
  // Beide Geräte haben ihr Mikrofon offen; nur eines darf zählen.
  const reden = async (redner, stiller) => {
    for (let i = 0; i < stueck.length; i += 2048) {
      const block = stueck.subarray(i, Math.min(i + 2048, stueck.length));
      redner.ws.send(Buffer.from(block.buffer, block.byteOffset, block.byteLength));
      for (let k = 0; k < rauschen.length; k++) rauschen[k] = (Math.random() - 0.5) * 0.4;
      stiller.ws.send(Buffer.from(rauschen.buffer, rauschen.byteOffset, rauschen.byteLength));
      await new Promise((ok) => setTimeout(ok, 5));
    }
  };

  a.ws.send(JSON.stringify({ typ: "weiter" }));
  await warteAuf(() => letzterZustand(b.eingang)?.aufnahmeVon === kennungA, "Aufnahme auf Antons Gerät");
  await reden(a, b);

  b.ws.send(JSON.stringify({ typ: "weiter" }));
  await warteAuf(() => letzterZustand(a.eingang)?.aufnahmeVon === kennungB, "Aufnahme auf Evas Gerät");
  await reden(b, a);
  b.ws.send(JSON.stringify({ typ: "stop" }));

  const beitraege = await warteAuf(
    () => {
      const liste = letzterZustand(a.eingang)?.beitraege;
      return liste?.length === 2 ? liste : null;
    },
    "beide Beiträge",
    30_000,
  );
  assert.deepEqual(beitraege.map((x) => x.sprecher), ["Anton", "Eva"]);
  for (const beitrag of beitraege) {
    assert.match(beitrag.text, /Badeanzug/i, `bei ${beitrag.sprecher} kam der Ton vom falschen Gerät`);
  }
  a.ws.close();
  b.ws.close();
});

test("Zwei Menschen an einem Gerät: der Sprecher wechselt, die Aufnahme bleibt", async (t) => {
  // Der alte Fall — ein Mikrofon wandert von Hand — muss ohne jedes Zutun
  // weiterlaufen: beide sitzen am selben Gerät, also nimmt es durchgehend auf.
  const port = PORT + 11;
  await starteServer(t, port);
  const geraet = await verbinde(port);
  const kennung = await meineKennung(geraet.eingang);

  geraet.ws.send(JSON.stringify({ typ: "setzen", titel: "Ein Gerät, zwei Menschen" }));
  await trittBei(geraet.ws, geraet.eingang, "Anton");
  await trittBei(geraet.ws, geraet.eingang, "Eva");

  const pcm = wavLesen(path.join(import.meta.dirname, "fixtures", "german.wav"));
  const stueck = pcm.subarray(0, 16000 * 5);
  const reden = async () => {
    for (let i = 0; i < stueck.length; i += 2048) {
      const block = stueck.subarray(i, Math.min(i + 2048, stueck.length));
      geraet.ws.send(Buffer.from(block.buffer, block.byteOffset, block.byteLength));
      await new Promise((ok) => setTimeout(ok, 5));
    }
  };

  // Niemand hat „Hier aufnehmen" gedrückt: Die Aufnahme folgt allein daraus,
  // dass der Dranseiende an diesem Gerät sitzt.
  geraet.ws.send(JSON.stringify({ typ: "weiter" }));
  await warteAuf(() => letzterZustand(geraet.eingang)?.aufnahmeVon === kennung, "Aufnahme an diesem Gerät");
  await reden();
  geraet.ws.send(JSON.stringify({ typ: "weiter" }));
  await warteAuf(() => letzterZustand(geraet.eingang)?.aktiv?.sprecher === "Eva", "Übergabe an Eva");
  assert.equal(letzterZustand(geraet.eingang).aufnahmeVon, kennung, "die Aufnahme ist weggewandert");
  await reden();
  geraet.ws.send(JSON.stringify({ typ: "stop" }));

  const beitraege = await warteAuf(
    () => {
      const liste = letzterZustand(geraet.eingang)?.beitraege;
      return liste?.length === 2 ? liste : null;
    },
    "beide Beiträge",
    30_000,
  );
  assert.deepEqual(beitraege.map((x) => x.sprecher), ["Anton", "Eva"]);
  for (const beitrag of beitraege) assert.match(beitrag.text, /Badeanzug/i);
  geraet.ws.close();
});

test("Wer kein Gerät mehr hat, bekommt das herumgereichte Mikrofon", async (t) => {
  // Eva hat ihr Telefon zugeklappt, sitzt aber weiter im Kreis. Wenn sie dran
  // ist, muss der Ton von dem Gerät kommen, das die Aufnahme in der Hand hat.
  const port = PORT + 12;
  await starteServer(t, port);
  const a = await verbinde(port);
  const b = await verbinde(port);
  const kennungA = await meineKennung(a.eingang);

  a.ws.send(JSON.stringify({ typ: "aufnehmen" })); // dieses Gerät hat das Mikrofon
  a.ws.send(JSON.stringify({ typ: "setzen", titel: "Herumgereicht" }));
  await trittBei(a.ws, a.eingang, "Anton");
  const eva = await trittBei(b.ws, b.eingang, "Eva");

  b.ws.close();
  await warteAuf(
    () => letzterZustand(a.eingang)?.teilnehmende.find((x) => x.id === eva)?.da === false,
    "Evas Gerät als getrennt gemeldet",
  );

  a.ws.send(JSON.stringify({ typ: "dran", id: eva }));
  await warteAuf(() => letzterZustand(a.eingang)?.aktiv?.sprecher === "Eva", "Übergabe an Eva");
  assert.equal(letzterZustand(a.eingang).aufnahmeVon, kennungA, "die Aufnahme ist ins Leere gewandert");

  const pcm = wavLesen(path.join(import.meta.dirname, "fixtures", "german.wav"));
  const stueck = pcm.subarray(0, 16000 * 5);
  for (let i = 0; i < stueck.length; i += 2048) {
    const block = stueck.subarray(i, Math.min(i + 2048, stueck.length));
    a.ws.send(Buffer.from(block.buffer, block.byteOffset, block.byteLength));
    await new Promise((ok) => setTimeout(ok, 5));
  }
  a.ws.send(JSON.stringify({ typ: "stop" }));

  const beitraege = await warteAuf(
    () => {
      const liste = letzterZustand(a.eingang)?.beitraege;
      return liste?.length === 1 ? liste : null;
    },
    "Evas Beitrag",
    30_000,
  );
  assert.equal(beitraege[0].sprecher, "Eva");
  assert.match(beitraege[0].text, /Badeanzug/i, "der Ton des herumgereichten Mikrofons kam nicht an");
  a.ws.close();
});

test("Das Aufnahmegerät lässt sich festlegen — und wieder auf Automatik stellen", async (t) => {
  // Der Fall aus dem Raum: Das eine herumgereichte Mikrofon hängt am Laptop,
  // die Menschen sitzen mit ihren Telefonen im Kreis. Dann soll der Laptop
  // liefern, auch wenn der Dranseiende an einem anderen Gerät sitzt.
  const port = PORT + 11;
  await starteServer(t, port);
  const a = await verbinde(port);
  const b = await verbinde(port);
  const kennung = async (k) => (await warteAuf(() => k.eingang.find((m) => m.typ === "du"), "eigene Kennung", 5000)).kennung;
  const kennungA = await kennung(a);
  const kennungB = await kennung(b);

  await trittBei(a.ws, a.eingang, "Anton");
  a.ws.send(JSON.stringify({ typ: "weiter" })); // Anton ist dran, also nimmt sein Gerät auf
  await warteAuf(() => letzterZustand(a.eingang)?.aufnahmeVon === kennungA, "Aufnahme bei Antons Gerät");

  // Die Runde legt das Gerät fest.
  b.ws.send(JSON.stringify({ typ: "aufnahmeGeraet", kennung: kennungB }));
  const fest = await warteAuf(() => {
    const s = letzterZustand(a.eingang);
    return s?.aufnahmeVon === kennungB ? s : null;
  }, "festgelegtes Aufnahmegerät");
  assert.equal(fest.aufnahmeWahl, kennungB, "die Wahl steht nicht im Zustand");
  assert.deepEqual(
    fest.geraete.map((g) => g.kennung).sort(),
    [kennungA, kennungB].sort(),
    "die Geräteliste fehlt oder ist unvollständig",
  );
  assert.deepEqual(fest.geraete.find((g) => g.kennung === kennungA).namen, ["Anton"]);

  // Und sie bleibt über die Übergabe hinweg stehen.
  a.ws.send(JSON.stringify({ typ: "weiter" }));
  await new Promise((ok) => setTimeout(ok, 300));
  assert.equal(letzterZustand(a.eingang).aufnahmeVon, kennungB, "die Übergabe hat die Wahl überschrieben");

  // Zurück auf Automatik: wieder das Gerät dessen, der dran ist.
  a.ws.send(JSON.stringify({ typ: "aufnahmeGeraet", kennung: null }));
  await warteAuf(() => letzterZustand(a.eingang)?.aufnahmeVon === kennungA, "Automatik");
  assert.equal(letzterZustand(a.eingang).aufnahmeWahl, null);
  a.ws.send(JSON.stringify({ typ: "stop" }));
  a.ws.close();
  b.ws.close();
});

