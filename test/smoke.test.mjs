// Ende-zu-Ende: Server starten, Ton wie das Browser-Worklet über WebSocket
// schicken, fertigen Beitrag im Protokoll prüfen.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
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

test("Redebeitrag wird aufgenommen, transkribiert und protokolliert", async (t) => {
  const server = spawn(process.execPath, ["server.mjs"], {
    cwd: WURZEL,
    env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1" },
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

  ws.send(JSON.stringify({ typ: "setzen", teilnehmende: ["Anton", "Eva"], sprache: "de-DE", titel: "Testrunde" }));

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
  ws.send(JSON.stringify({ typ: "start", sprecher: "Anton" }));
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

  const md = fs.readFileSync(path.join(WURZEL, "transcripts", `${letzter.state.id}.md`), "utf8");
  assert.match(md, /# Testrunde/);
  assert.match(md, /## Anton/);
  ws.close();
});

test("Neue Runde leert die Anzeige und lässt das Protokoll auf der Platte", async (t) => {
  const server = spawn(process.execPath, ["server.mjs"], {
    cwd: WURZEL,
    env: { ...process.env, PORT: String(PORT + 1), HOST: "127.0.0.1" },
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

  ws.send(JSON.stringify({ typ: "setzen", teilnehmende: ["Anton"], titel: "Erste Runde" }));
  const pcm = wavLesen(path.join(import.meta.dirname, "fixtures", "german.wav"));
  ws.send(JSON.stringify({ typ: "start", sprecher: "Anton" }));
  const teil = pcm.subarray(0, 16000 * 4);
  ws.send(Buffer.from(teil.buffer, teil.byteOffset, teil.byteLength));
  ws.send(JSON.stringify({ typ: "stop" }));
  const erste = await warten((s) => s.beitraege.length === 1);
  const protokoll = path.join(WURZEL, "transcripts", `${erste.id}.md`);
  assert.ok(fs.existsSync(protokoll), "Protokoll der ersten Runde fehlt");

  ws.send(JSON.stringify({ typ: "neueRunde" }));
  const zweite = await warten((s) => s.beitraege.length === 0);
  assert.notEqual(zweite.id, erste.id, "die neue Runde übernimmt die alte Kennung");
  assert.equal(zweite.beitraege.length, 0);
  assert.deepEqual(zweite.teilnehmende, ["Anton"], "die Namen bleiben stehen");
  assert.ok(fs.existsSync(protokoll), "das Protokoll der alten Runde wurde weggeräumt");
  assert.ok(!fs.existsSync(path.join(WURZEL, "transcripts", `${zweite.id}.md`)), "leere Runde schreibt eine Datei");
  ws.close();
});

test("Ein Export mitten im Beitrag enthält, was gerade gesagt wurde", async (t) => {
  const port = PORT + 2;
  const server = spawn(process.execPath, ["server.mjs"], {
    cwd: WURZEL,
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1" },
    stdio: ["ignore", "pipe", "inherit"],
  });
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

  ws.send(JSON.stringify({ typ: "setzen", teilnehmende: ["Anton"], titel: "Mittendrin" }));
  ws.send(JSON.stringify({ typ: "start", sprecher: "Anton" }));
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
  const datei = path.join(WURZEL, zustand.datei);
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
