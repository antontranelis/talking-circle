// Der Redekreis: eine Runde besteht aus Redebeiträgen ("turns"). Pro Beitrag
// läuft genau eine Streaming-Session des Modells — so bleibt der Kontext
// innerhalb eines Beitrags erhalten und endet sauber, wenn das Mikrofon
// weitergereicht wird.
import fs from "node:fs";
import path from "node:path";
import { TranscribeModel } from "transcribe-cpp";
import { resolveModel } from "./model.mjs";
import { alsJsonl, alsMarkdown, standardZone } from "./protokoll.mjs";
// Wohin die Runden geschrieben werden, entscheidet das Archiv — es liest den
// Ordner aus der Umgebung.
import { WURZEL as TRANSCRIPTS } from "./archiv.mjs";

const VORRAT_MAX = 250; // ~30 s bei 128-ms-Blöcken
const SICHERN_MS = 3000; // Schreibabstand für den laufenden Beitrag
const STUMM_MS = 15000; // so lange darf gesprochen werden, ohne dass Text kommt
const SPRACHE_MIN_MS = 4000; // und so viel davon muss hörbar gesprochen worden sein
const PEGEL_SCHWELLE = 0.012; // darüber gilt ein Block als Sprache
const PEGEL_MS = 100; // höchstens zehnmal je Sekunde geht der Pegel hinaus
const VORLAUF = 12; // ~1,5 s Ton vor dem Tastendruck, damit kein Satzanfang fehlt
// So lange darf jemand weg sein, ohne den Kreis zu verlassen. 45 s reichen für
// ein Neuladen, den Wechsel zur Einrichtung und zurück oder einen kurzen
// Funkloch-Moment — und sind kurz genug, dass niemand ewig als Schatten im
// Kreis steht.
const KARENZ_MS = Number(process.env.TALKING_CIRCLE_KARENZ_MS ?? 45000);

// Im Fuß steht, wohin gesichert wird — kurz, wenn es der übliche Ordner ist.
const ANZEIGE = process.env.TALKING_CIRCLE_TRANSCRIPTS ? TRANSCRIPTS : "transcripts";
const dateiName = (id) => `${ANZEIGE}/${id}.md`;
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
  #letzteTeilnehmerNr = 0;
  #karenz = new Map(); // id → laufende Karenzzeit nach einer Trennung
  #letzterText = 0; // wann zuletzt Text kam
  #letzteSprache = 0; // wann zuletzt jemand hörbar gesprochen hat
  #spracheSeitText = 0; // wieviel hörbare Sprache seit dem letzten Text kam
  #takt = null; // schreibt den laufenden Beitrag auch dann fort, wenn gerade nichts kommt
  #haltSeit = null; // seit wann der laufende Beitrag angehalten ist
  #pegelGesendet = 0; // wann der Pegel zuletzt hinausging
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
      teilnehmende: [], // { id, name, geraet, da }
      dran: null, // Kennung dessen, der das Mikrofon hat
      aktiv: null, // { sprecher, begonnen, committed, tentative, pauseMs }
      angehalten: false, // Aufnahme und Uhr stehen, der Beitrag bleibt offen
      beitraege: [],
      modell: null,
      datei: null,
      bereit: false,
    };
    // Der Pegel des aufnehmenden Geräts — daran atmet der Platz des Sprechers.
    this.pegelJetzt = 0;
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
      pauseMs: 0, // was im Halt verstrichen ist, zählt nicht zur Redezeit
      haltSeit: null,
    };
    this.state.aktiv = aktiv;
    this.state.angehalten = false; // ein neuer Beitrag beginnt im Lauf
    this.#haltSeit = null;
    this.#letzterText = Date.now();
    this.#spracheSeitText = 0;
    this.#vorrat = this.#vorlauf.splice(0);
    this.#onChange("state");
    // Ohne geladenes Modell gibt es keinen Erkennungsstrom — der Kreis läuft
    // trotzdem, nur eben stumm. Das ist der Weg der Tests.
    if (!this.#session) return;

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
    // Im Halt wird nichts mitgeschrieben: Der Ton fällt weg, statt später als
    // Nachschlag im Beitrag zu landen.
    if (this.state.angehalten) return;
    const jetztPegel = pegel(pcm);
    this.pegelJetzt = jetztPegel;
    // Alle Geräte sollen den Platz des Sprechers atmen sehen — gedrosselt,
    // damit aus 8 Blöcken je Sekunde keine Flut wird.
    if (Date.now() - this.#pegelGesendet >= PEGEL_MS) {
      this.#pegelGesendet = Date.now();
      this.#onChange("pegel");
    }
    if (jetztPegel > PEGEL_SCHWELLE) {
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
    this.state.angehalten = false;
    this.#haltSeit = null;
    this.pegelJetzt = 0;
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

  // --- Anhalten -----------------------------------------------------------
  //
  // Ein Halt ist kein Ende: Der Beitrag bleibt offen, nur Aufnahme und Uhr
  // stehen still. Wer fortsetzt, redet im selben Beitrag weiter — im Protokoll
  // ist von der Unterbrechung nichts zu sehen.
  anhalten() {
    if (!this.state.aktiv || this.state.angehalten) return false;
    this.state.angehalten = true;
    this.#haltSeit = Date.now();
    this.state.aktiv.haltSeit = new Date(this.#haltSeit).toISOString();
    this.pegelJetzt = 0;
    this.sichern();
    this.#onChange("state");
    return true;
  }

  fortsetzen() {
    if (!this.state.angehalten) return false;
    const aktiv = this.state.aktiv;
    if (aktiv) {
      aktiv.pauseMs = (aktiv.pauseMs ?? 0) + (Date.now() - this.#haltSeit);
      aktiv.haltSeit = null;
    }
    this.state.angehalten = false;
    this.#haltSeit = null;
    // Die Stille des Halts ist kein hängender Strom — der Wachhund fängt neu an
    // zu zählen, sonst setzt er gleich nach dem Fortsetzen den Strom neu auf.
    this.#letzterText = Date.now();
    this.#spracheSeitText = 0;
    this.#onChange("state");
    return true;
  }

  // Die Redezeit des laufenden Beitrags, ohne das, was im Halt verstrichen ist.
  verstricheneMs() {
    const aktiv = this.state.aktiv;
    if (!aktiv) return 0;
    const bis = this.#haltSeit ?? Date.now();
    return bis - new Date(aktiv.begonnen).getTime() - (aktiv.pauseMs ?? 0);
  }

  // --- Bearbeiten ---------------------------------------------------------

  // Was im Protokollbuch steht, gilt: Titel, Beiträge und der laufende Beitrag
  // werden übernommen, wie sie dort stehen.
  async uebernehmen({ titel, beitraege, laufend }) {
    if (typeof titel === "string" && titel.trim()) this.state.titel = titel.trim();
    if (Array.isArray(beitraege)) this.state.beitraege = beitraege;
    if (this.state.aktiv && laufend) await this.neuFassen(laufend.text, laufend.sprecher);
    this.sichern();
    this.#onChange("state");
  }

  // Der laufende Beitrag wird neu gefasst. Der Erkennungsstrom fängt dabei von
  // vorn an — sonst hinge sein bisheriger Text ein zweites Mal hinter der
  // Korrektur, sobald das nächste Wort festgeschrieben wird.
  async neuFassen(text, sprecher) {
    const aktiv = this.state.aktiv;
    if (!aktiv) return false;
    if (typeof sprecher === "string" && sprecher.trim()) aktiv.sprecher = sprecher.trim();
    // Im Takt der Feeds: So wartet der Ton, der währenddessen ankommt, auf den
    // neuen Strom, statt ins Leere zu laufen.
    // Was der Strom jetzt schon festgeschrieben hat, steht im Buch. Alles,
    // was bis zum Abschluss noch dazukommt, ist neu.
    const bisher = this.#stream?.text.committed ?? "";
    this.#queue = this.#queue.then(async () => {
      if (this.state.aktiv !== aktiv) return;
      const stream = this.#stream;
      aktiv.vorher = String(text ?? "").trim();
      aktiv.committed = aktiv.vorher;
      aktiv.tentative = "";
      if (!stream) return;
      this.#stream = null;
      try {
        // Was der alte Strom beim Abschluss noch festschreibt, war schon
        // gesprochen — es gehört hinter die Korrektur, nicht in den Papierkorb.
        await stream.finalize();
        const rest = stream.text.committed.slice(bisher.length).trim();
        if (rest) aktiv.vorher = aktiv.committed = `${aktiv.vorher} ${rest}`.trim();
      } catch (err) {
        console.error("Finalisieren beim Neufassen fehlgeschlagen:", err.message);
      }
      try {
        stream.reset();
      } catch {}
      if (this.state.aktiv !== aktiv || !this.#session) return;
      this.#stream = await this.#session.stream({
        language: this.state.sprache,
        commitPolicy: "stable_prefix",
        family: { kind: "parakeet", attContextRight: this.state.attContextRight },
      });
    });
    await this.#queue.catch(() => {});
    return true;
  }

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
    this.state.dran = null;
    this.#onChange("state");
  }

  // --- Wer ist da ---------------------------------------------------------

  // Beitritt: Ein Mensch trägt seinen Namen ein und sitzt ab sofort im Kreis.
  // Mehrere Menschen können dasselbe Gerät benutzen.
  //
  // Der Platz gehört dem Namen an einem Browser (`schluessel`), nicht der
  // Leitung: Ein Neuladen, ein zweiter Tab oder ein Netzwackler bindet den
  // vorhandenen Platz an die neue Leitung. Sonst meldet der `close` der alten
  // Leitung den Menschen ab, nachdem er längst wieder da ist — dann steht er
  // als abwesend im Kreis und wird beim Weiterreichen übersprungen.
  beitreten(name, geraet, schluessel = null) {
    const sauber = String(name ?? "").trim().slice(0, 60);
    if (!sauber) return null;

    const gleichenNamens = this.state.teilnehmende.filter((t) => t.name === sauber);
    const eigener =
      gleichenNamens.find((t) => schluessel && t.schluessel === schluessel) ??
      // Wer sein Gerät verloren hat, bekommt seinen Platz auch von einem
      // anderen Browser aus zurück — es sitzt ja niemand darauf.
      gleichenNamens.find((t) => !t.da);
    if (eigener) {
      eigener.geraet = geraet;
      eigener.schluessel = schluessel ?? eigener.schluessel;
      eigener.da = true;
      this.#karenzLoeschen(eigener.id);
      this.#onChange("state");
      return eigener.id;
    }
    // Zwei Menschen, ein Name, beide erreichbar: Der Zweite braucht einen
    // eigenen Platz — sonst stünde im Protokoll der Falsche als Sprecher.
    const frei = gleichenNamens.length ? this.#freierName(sauber) : sauber;

    const teilnehmer = {
      id: `t${++this.#letzteTeilnehmerNr}`,
      name: frei,
      geraet,
      schluessel,
      da: true,
    };
    this.state.teilnehmende.push(teilnehmer);
    this.#onChange("state");
    return teilnehmer.id;
  }

  // „Anton", „Anton (2)", „Anton (3)" — der nächste freie Zusatz.
  #freierName(name) {
    const belegt = new Set(this.state.teilnehmende.map((t) => t.name));
    for (let n = 2; ; n++) {
      if (!belegt.has(`${name} (${n})`)) return `${name} (${n})`;
    }
  }

  // Jemand geht endgültig: von Hand über „Kreis verlassen" oder weil die
  // Karenzzeit nach einer Trennung abgelaufen ist.
  async verlassen(id) {
    if (!this.state.teilnehmende.some((t) => t.id === id)) return;
    // War er dran, wird sein Beitrag sauber abgeschlossen. Das Mikrofon liegt
    // danach in der Mitte: Von selbst weiterzuspringen wäre überraschend.
    if (this.state.dran === id) await this.beitragBeenden();
    this.#karenzLoeschen(id);
    this.state.teilnehmende = this.state.teilnehmende.filter((t) => t.id !== id);
    if (this.state.dran === id) this.state.dran = null;
    this.#onChange("state");
  }

  // Ein Gerät ist weg: Die Menschen bleiben zunächst im Kreis, aber abwesend.
  // Ob sie nur kurz weg sind oder gegangen, sagt niemand — das entscheidet die
  // Karenzzeit.
  geraetGetrennt(geraet) {
    let geaendert = false;
    for (const t of this.state.teilnehmende) {
      if (t.geraet === geraet) {
        t.geraet = null;
        t.da = false;
        this.#karenzStarten(t.id);
        geaendert = true;
      }
    }
    if (geaendert) this.#onChange("state");
  }

  // Kommt innerhalb der Karenzzeit kein Beitritt mit demselben Namen, war es
  // kein Wackler, sondern ein Gehen — dann verlässt der Mensch den Kreis.
  #karenzStarten(id) {
    this.#karenzLoeschen(id);
    const uhr = setTimeout(() => {
      this.#karenz.delete(id);
      this.verlassen(id).catch((err) => console.error("Hinausbegleiten fehlgeschlagen:", err.message));
    }, KARENZ_MS);
    uhr.unref?.(); // darf den Server am Beenden nicht hindern
    this.#karenz.set(id, uhr);
  }

  #karenzLoeschen(id) {
    const uhr = this.#karenz.get(id);
    if (!uhr) return;
    clearTimeout(uhr);
    this.#karenz.delete(id);
  }

  // Die Reihenfolge im Kreis ist eine Absprache, keine Beitrittsliste — sie
  // lässt sich umstellen. Angenommen wird nur eine vollständige Liste: Hat in
  // der Zwischenzeit jemand den Kreis verlassen oder ist einer dazugekommen,
  // wäre die gezogene Reihenfolge veraltet und würde jemanden verschlucken.
  sortiere(ids) {
    if (!Array.isArray(ids) || ids.length !== this.state.teilnehmende.length) return false;
    const offen = new Map(this.state.teilnehmende.map((t) => [t.id, t]));
    const neu = [];
    for (const id of ids) {
      const teilnehmer = offen.get(id);
      if (!teilnehmer) return false; // fremd oder doppelt
      offen.delete(id);
      neu.push(teilnehmer);
    }
    // `dran` bleibt derselbe Mensch; nur wer nach ihm kommt, ändert sich.
    this.state.teilnehmende = neu;
    this.#onChange("state");
    return true;
  }

  anwesende() {
    return this.state.teilnehmende.filter((t) => t.da);
  }

  // Der Nächste im Kreis — Abwesende werden übersprungen.
  naechster() {
    const da = this.anwesende();
    if (!da.length) return null;
    const jetzt = da.findIndex((t) => t.id === this.state.dran);
    return da[(jetzt + 1) % da.length].id;
  }

  // Wer das Mikrofon hat. Bestimmt zugleich, welches Gerät aufnimmt.
  gibMikrofonAn(id) {
    const teilnehmer = this.state.teilnehmende.find((t) => t.id === id);
    if (!teilnehmer) return null;
    this.state.dran = id;
    return teilnehmer;
  }

  // Was für die ganze Runde gilt. Wer im Kreis sitzt, steht hier nicht drin —
  // das entscheidet der Beitritt.
  setzen({ titel, sprache, attContextRight, redezeitMs }) {
    if (Number.isFinite(redezeitMs)) this.state.redezeitMs = Math.max(0, redezeitMs);
    if (typeof titel === "string") this.state.titel = titel;
    if (typeof sprache === "string") this.state.sprache = sprache;
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
    const { aktiv, bereit, angehalten, teilnehmende, ...rest } = this.state;
    // Der Browser-Schlüssel ist die Platzkarte eines Geräts — er gehört weder
    // ins Protokoll noch auf andere Geräte.
    rest.teilnehmende = teilnehmende.map(({ schluessel, ...wer }) => wer);
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
    for (const id of [...this.#karenz.keys()]) this.#karenzLoeschen(id);
    await this.beitragBeenden();
    this.#session?.dispose();
    this.#model?.dispose();
  }
}
