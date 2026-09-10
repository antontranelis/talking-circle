// Der Redekreis: eine Runde besteht aus Redebeiträgen ("turns"). Pro Beitrag
// läuft genau eine Streaming-Session des Modells — so bleibt der Kontext
// innerhalb eines Beitrags erhalten und endet sauber, wenn das Mikrofon
// weitergereicht wird.
import fs from "node:fs";
import path from "node:path";
import { TranscribeModel } from "transcribe-cpp";
import { resolveModel } from "./model.mjs";
import { alsJsonl, alsMarkdown, standardZone } from "./protokoll.mjs";

const TRANSCRIPTS = path.join(import.meta.dirname, "transcripts");
const VORRAT_MAX = 250; // ~30 s bei 128-ms-Blöcken
const SICHERN_MS = 3000; // Schreibabstand für den laufenden Beitrag
const STUMM_MS = 15000; // so lange darf gesprochen werden, ohne dass Text kommt
const SPRACHE_MIN_MS = 4000; // und so viel davon muss hörbar gesprochen worden sein
const PEGEL_SCHWELLE = 0.012; // darüber gilt ein Block als Sprache
const VORLAUF = 12; // ~1,5 s Ton vor dem Tastendruck, damit kein Satzanfang fehlt

const dateiName = (id) => `transcripts/${id}.md`;
// Lautstärke eines Blocks als quadratisches Mittel.
function pegel(pcm) {
  let summe = 0;
  for (let i = 0; i < pcm.length; i++) summe += pcm[i] * pcm[i];
  return Math.sqrt(summe / pcm.length);
}

const neueKennung = () => new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

export class Circle {
  #model = null;
  #session = null;
  #stream = null;
  #vorrat = null; // Ton, der eintrifft, während die Session noch aufgebaut wird
  #vorlauf = []; // die letzten Momente vor dem Beginn eines Beitrags
  #zuletztGesichert = 0; // Zeitpunkt der letzten Sicherung des laufenden Beitrags
  #letzterText = 0; // wann zuletzt Text kam
  #letzteSprache = 0; // wann zuletzt jemand hörbar gesprochen hat
  #spracheSeitText = 0; // wieviel hörbare Sprache seit dem letzten Text kam
  #takt = null; // schreibt den laufenden Beitrag auch dann fort, wenn gerade nichts kommt
  #queue = Promise.resolve();   // Feeds laufen streng nacheinander
  #wechsel = Promise.resolve();  // Beitragswechsel ebenso
  #onChange;

  constructor({ onChange = () => {} } = {}) {
    this.#onChange = onChange;
    this.state = {
      id: neueKennung(),
      titel: "Redekreis",
      begonnen: new Date().toISOString(),
      sprache: "de-DE",
      redezeitMs: 5 * 60 * 1000, // 0 = ohne Begrenzung
      attContextRight: 13, // 1040 ms Lookahead = beste Genauigkeit
      teilnehmende: [],
      aktiv: null, // { sprecher, begonnen, committed, tentative }
      beitraege: [],
      modell: null,
      datei: null,
      bereit: false,
    };
    this.state.datei = dateiName(this.state.id);
  }

  async laden() {
    const modelPath = resolveModel();
    this.state.modell = path.basename(modelPath);
    this.#model = await TranscribeModel.load(modelPath);
    this.#session = this.#model.createSession();
    this.state.bereit = true;
    // Auch eine lange Pause im Beitrag darf den Stand nicht auf der Kante lassen.
    this.#takt = setInterval(() => this.state.aktiv?.committed && this.sichern(), SICHERN_MS);
    this.#takt.unref?.();
    this.#onChange("state");
  }

  // --- Redebeiträge -------------------------------------------------------

  // Der Beitrag gilt sofort als begonnen; der Aufbau der Streaming-Session
  // dauert einen Moment, in dem eintreffender Ton zwischengehalten wird —
  // sonst fehlen die ersten Worte.
  // Start und Ende eines Beitrags laufen nacheinander ab, damit zwei rasch
  // aufeinanderfolgende Übergaben nicht zwei Sessions gleichzeitig öffnen.
  beitragStarten(sprecher) {
    return this.#nacheinander(() => this.#starten(sprecher));
  }

  beitragBeenden() {
    return this.#nacheinander(() => this.#beenden());
  }

  #nacheinander(fn) {
    const naechster = this.#wechsel.then(fn, fn);
    this.#wechsel = naechster.then(
      () => {},
      () => {},
    );
    return naechster;
  }

  async #starten(sprecher) {
    if (this.state.aktiv) await this.#beenden();
    const aktiv = {
      sprecher,
      begonnen: new Date().toISOString(),
      committed: "",
      tentative: "",
      vorher: "", // Text aus einem vorherigen Strom desselben Beitrags
    };
    this.state.aktiv = aktiv;
    this.#letzterText = Date.now();
    this.#spracheSeitText = 0;
    this.#vorrat = this.#vorlauf.splice(0);
    this.#onChange("state");

    const stream = await this.#session.stream({
      language: this.state.sprache,
      commitPolicy: "stable_prefix",
      family: { kind: "parakeet", attContextRight: this.state.attContextRight },
    });

    if (this.state.aktiv !== aktiv) {
      // Der Beitrag wurde beendet, bevor die Session stand.
      this.#vorrat = null;
      await stream.finalize().catch(() => {});
      stream.reset(); // gibt die Sitzung frei — sonst bleibt sie im Streaming-Zustand
      return;
    }
    this.#stream = stream;
    const vorrat = this.#vorrat ?? [];
    this.#vorrat = null;
    for (const pcm of vorrat) this.fuettern(pcm);
  }

  // PCM: Float32Array, 16 kHz mono. Feeds laufen streng nacheinander, weil
  // die Streaming-Session nicht nebenläufig gefüttert werden darf.
  fuettern(pcm) {
    if (pegel(pcm) > PEGEL_SCHWELLE) {
      this.#letzteSprache = Date.now();
      this.#spracheSeitText += (pcm.length / 16000) * 1000;
    }
    if (!this.state.aktiv) {
      // Zwischen zwei Beiträgen: die letzten Momente mitlaufen lassen. Wer
      // schon spricht, bevor die Übergabe bestätigt ist, geht so nicht verloren.
      this.#vorlauf.push(pcm);
      if (this.#vorlauf.length > VORLAUF) this.#vorlauf.shift();
      return;
    }
    if (!this.#stream) {
      // Session noch im Aufbau: Ton sammeln, aber nicht unbegrenzt (max. 30 s).
      if (this.#vorrat && this.#vorrat.length < VORRAT_MAX) this.#vorrat.push(pcm);
      return;
    }
    // Festgehalten wird der Beitrag, nicht der Strom: Setzt der Wachhund
    // dazwischen einen neuen auf, läuft der wartende Ton dort hinein statt
    // verloren zu gehen. Und nach dem Weiterreichen wird zu Ende verarbeitet.
    const aktiv = this.state.aktiv;
    this.#queue = this.#queue
      .then(async () => {
        const stream = this.#stream;
        if (!stream || this.state.aktiv !== aktiv) return;
        await stream.feed(pcm);
        const { committed, tentative } = stream.text;
        const ganz = aktiv.vorher ? `${aktiv.vorher} ${committed}`.trim() : committed;
        if (aktiv.committed === ganz && aktiv.tentative === tentative) {
          await this.#wachhund(aktiv, stream);
          return;
        }
        aktiv.committed = ganz;
        aktiv.tentative = tentative;
        this.#letzterText = Date.now();
        this.#spracheSeitText = 0;
        this.sichernGedrosselt();
        if (this.state.aktiv === aktiv) this.#onChange("live");
      })
      .catch((err) => {
        console.error("Feed fehlgeschlagen:", err.message);
      });
    return this.#queue;
  }

  // Es wird gesprochen, aber es kommt kein Text: dann ist der Erkennungsstrom
  // hängen geblieben. Neu aufsetzen und weitermachen, statt still zu bleiben.
  async #wachhund(aktiv, stream) {
    const jetzt = Date.now();
    if (this.#stream !== stream || this.state.aktiv !== aktiv) return;
    if (jetzt - this.#letzteSprache > 1500) return; // gerade spricht niemand
    if (jetzt - this.#letzterText < STUMM_MS) return;
    // Ein bisschen Rauschen reicht nicht: es muss auch wirklich geredet worden sein.
    if (this.#spracheSeitText < SPRACHE_MIN_MS) return;

    console.error(
      `Erkennung stumm: ${Math.round((jetzt - this.#letzterText) / 1000)} s ohne Text ` +
        `bei ${(this.#spracheSeitText / 1000).toFixed(1)} s Sprache — Strom wird neu aufgesetzt`,
    );
    this.#letzterText = jetzt;
    this.#spracheSeitText = 0;
    this.#stream = null;
    try {
      await stream.finalize();
      const rest = stream.text.committed;
      if (rest) aktiv.vorher = aktiv.vorher ? `${aktiv.vorher} ${rest}`.trim() : rest;
    } catch (err) {
      console.error("Finalisieren beim Neuaufsetzen fehlgeschlagen:", err.message);
    }
    try {
      stream.reset();
    } catch {}
    if (this.state.aktiv !== aktiv) return;
    this.#stream = await this.#session.stream({
      language: this.state.sprache,
      commitPolicy: "stable_prefix",
      family: { kind: "parakeet", attContextRight: this.state.attContextRight },
    });
    this.state.neuaufsetzer = (this.state.neuaufsetzer ?? 0) + 1;
    this.#onChange("state");
  }

  async #beenden() {
    if (!this.state.aktiv) return null;
    const aktiv = this.state.aktiv;
    // Erst den wartenden Ton fertig verarbeiten — er gehört noch zu diesem
    // Beitrag —, dann schließen.
    await this.#queue.catch(() => {});
    const stream = this.#stream;
    this.state.aktiv = null;
    this.#stream = null;
    this.#vorrat = null;
    this.#vorlauf.length = 0;
    let text = aktiv.committed;
    if (stream) {
      try {
        await stream.finalize();
        const ende = stream.text.committed || stream.text.full || "";
        text = aktiv.vorher ? `${aktiv.vorher} ${ende}`.trim() : ende || text;
      } catch (err) {
        console.error("Finalisieren fehlgeschlagen:", err.message);
      }
      // Ohne reset() bleibt die Sitzung nach jedem Beitrag im Streaming-Zustand;
      // über eine lange Runde summiert sich das.
      stream.reset();
    }
    const beitrag = {
      sprecher: aktiv.sprecher,
      begonnen: aktiv.begonnen,
      beendet: new Date().toISOString(),
      text: text.trim(),
    };
    if (beitrag.text) this.state.beitraege.push(beitrag);
    this.sichern();
    this.#onChange("state");
    return beitrag;
  }

  // --- Bearbeiten ---------------------------------------------------------

  beitragAendern(index, { text, sprecher }) {
    const b = this.state.beitraege[index];
    if (!b) return;
    if (typeof text === "string") b.text = text;
    if (typeof sprecher === "string") b.sprecher = sprecher;
    this.sichern();
    this.#onChange("state");
  }

  beitragLoeschen(index) {
    if (!this.state.beitraege[index]) return;
    this.state.beitraege.splice(index, 1);
    this.sichern();
    this.#onChange("state");
  }

  // Neue Runde: der laufende Beitrag wird abgeschlossen, das bisherige
  // Protokoll bleibt auf der Platte liegen, die Anzeige fängt leer an.
  async neueRunde() {
    await this.beitragBeenden();
    this.state.id = neueKennung();
    this.state.datei = dateiName(this.state.id);
    this.state.begonnen = new Date().toISOString();
    this.state.beitraege = [];
    this.#onChange("state");
  }

  setzen({ titel, sprache, teilnehmende, attContextRight, redezeitMs }) {
    if (Number.isFinite(redezeitMs)) this.state.redezeitMs = Math.max(0, redezeitMs);
    if (typeof titel === "string") this.state.titel = titel;
    if (typeof sprache === "string") this.state.sprache = sprache;
    if (Array.isArray(teilnehmende)) this.state.teilnehmende = teilnehmende;
    if (Number.isInteger(attContextRight)) this.state.attContextRight = attContextRight;
    this.sichern();
    this.#onChange("state");
  }

  // --- Ablage -------------------------------------------------------------

  // Während jemand spricht, wird höchstens alle paar Sekunden geschrieben —
  // oft genug, dass bei einem Absturz nichts Nennenswertes fehlt.
  sichernGedrosselt() {
    if (Date.now() - this.#zuletztGesichert < SICHERN_MS) return;
    this.sichern();
  }

  sichern() {
    // Eine Runde ohne jeden Text hinterlässt keine Datei — außer sie hatte
    // schon welche und der letzte Beitrag wurde gerade gelöscht.
    const hatText = this.state.beitraege.length || this.state.aktiv?.committed;
    if (!hatText && !fs.existsSync(this.#pfad(".json"))) return;
    this.#zuletztGesichert = Date.now();
    fs.mkdirSync(TRANSCRIPTS, { recursive: true });
    const { aktiv, bereit, ...rest } = this.state;
    const laufend = aktiv?.committed
      ? { sprecher: aktiv.sprecher, begonnen: aktiv.begonnen, text: aktiv.committed.trim() }
      : null;
    fs.writeFileSync(this.#pfad(".json"), JSON.stringify({ ...rest, laufend }, null, 2));
    fs.writeFileSync(this.#pfad(".md"), this.markdown());
    fs.writeFileSync(this.#pfad(".jsonl"), this.jsonl());
  }

  // Die Zeitzone kommt von dem, der das Protokoll abruft — der Server selbst
  // läuft im Container auf UTC, und die Uhrzeit soll zur Runde passen.
  markdown(zeitzone = standardZone()) {
    return alsMarkdown(this.state, zeitzone);
  }

  // Dieselbe Runde in dem Zeilenformat, das das Session-Archiv einliest.
  jsonl() {
    return alsJsonl(this.state);
  }

  pfade() {
    return { json: this.#pfad(".json"), md: this.#pfad(".md"), jsonl: this.#pfad(".jsonl") };
  }

  #pfad(ext) {
    return path.join(TRANSCRIPTS, `${this.state.id}${ext}`);
  }

  async schliessen() {
    clearInterval(this.#takt);
    await this.beitragBeenden();
    this.#session?.dispose();
    this.#model?.dispose();
  }
}
