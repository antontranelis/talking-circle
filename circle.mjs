// Der Redekreis: eine Runde besteht aus Redebeiträgen ("turns"). Pro Beitrag
// läuft genau eine Streaming-Session des Modells — so bleibt der Kontext
// innerhalb eines Beitrags erhalten und endet sauber, wenn das Mikrofon
// weitergereicht wird.
import fs from "node:fs";
import path from "node:path";
import { TranscribeModel } from "transcribe-cpp";
import { resolveModel } from "./model.mjs";

const TRANSCRIPTS = path.join(import.meta.dirname, "transcripts");
const VORRAT_MAX = 250; // ~30 s bei 128-ms-Blöcken
const SICHERN_MS = 3000; // Schreibabstand für den laufenden Beitrag
const VORLAUF = 12; // ~1,5 s Ton vor dem Tastendruck, damit kein Satzanfang fehlt

const dateiName = (id) => `transcripts/${id}.md`;
const neueKennung = () => new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

export class Circle {
  #model = null;
  #session = null;
  #stream = null;
  #vorrat = null; // Ton, der eintrifft, während die Session noch aufgebaut wird
  #vorlauf = []; // die letzten Momente vor dem Beginn eines Beitrags
  #zuletztGesichert = 0; // Zeitpunkt der letzten Sicherung des laufenden Beitrags
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
    };
    this.state.aktiv = aktiv;
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
    // Stream und Beitrag werden festgehalten: noch wartender Ton wird auch dann
    // fertig verarbeitet, wenn das Mikrofon inzwischen weitergereicht wurde.
    const stream = this.#stream;
    const aktiv = this.state.aktiv;
    this.#queue = this.#queue
      .then(async () => {
        await stream.feed(pcm);
        const { committed, tentative } = stream.text;
        if (aktiv.committed === committed && aktiv.tentative === tentative) return;
        aktiv.committed = committed;
        aktiv.tentative = tentative;
        this.sichernGedrosselt();
        if (this.state.aktiv === aktiv) this.#onChange("live");
      })
      .catch((err) => {
        console.error("Feed fehlgeschlagen:", err.message);
      });
    return this.#queue;
  }

  async #beenden() {
    if (!this.state.aktiv) return null;
    const aktiv = this.state.aktiv;
    const stream = this.#stream;
    this.state.aktiv = null;
    this.#stream = null;
    this.#vorrat = null;
    this.#vorlauf.length = 0;
    await this.#queue.catch(() => {});
    let text = aktiv.committed;
    if (stream) {
      try {
        await stream.finalize();
        text = stream.text.committed || stream.text.full || text;
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
  }

  markdown() {
    const s = this.state;
    const zeit = (iso) => new Date(iso).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
    const anzahl = s.beitraege.length + (s.aktiv?.committed ? 1 : 0);
    const kopf = [`# ${s.titel}`, "", `${new Date(s.begonnen).toLocaleString("de-DE")} · ${anzahl} Beiträge`, ""];
    const koerper = s.beitraege.map((b) => `## ${b.sprecher} · ${zeit(b.begonnen)}\n\n${b.text}\n`);
    // Wer gerade spricht, steht mit dabei — ein Export mittendrin verliert nichts.
    if (s.aktiv?.committed) {
      koerper.push(`## ${s.aktiv.sprecher} · ${zeit(s.aktiv.begonnen)} · spricht noch\n\n${s.aktiv.committed.trim()}\n`);
    }
    return [...kopf, ...koerper].join("\n");
  }

  pfade() {
    return { json: this.#pfad(".json"), md: this.#pfad(".md") };
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
