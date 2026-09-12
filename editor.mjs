// Das Protokollbuch: die laufende Runde als ein Text, an dem alle zugleich
// schreiben können.
//
// Der Text ist ein Yjs-Dokument — jedes Gerät hält eine Kopie, die Änderungen
// fließen über dieselbe WebSocket-Leitung wie alles andere. Zwei Richtungen
// treffen sich darin:
//
//   Die Erkennung schreibt ans Ende. Immer nur ans Ende, nie mitten hinein —
//   sonst risse sie dem, der weiter oben tippt, den Satz unter dem Finger weg.
//
//   Die Menschen schreiben überall. Was sie hinterlassen, liest der Server
//   gedrosselt zurück und übernimmt es in die Runde.
import * as Y from "yjs";
import { ausMarkdown, gueltigeZone, standardZone } from "./protokoll.mjs";

const UEBERNAHME_MS = 1200; // so lange darf getippt werden, bevor gelesen wird

const zeitTeil = (zone) => (gueltigeZone(zone) ? { timeZone: zone } : {});
const uhrzeit = (iso, zone) =>
  new Date(iso).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", ...zeitTeil(zone) });

// Die Runde als Markdown, so wie sie auch im Archiv steht: Titel, dann je
// Beitrag eine Überschrift und der Text. Der laufende Beitrag steht am Ende.
export function dokumentText(state, zeitzone = standardZone()) {
  const teile = [`# ${state.titel}`, ""];
  for (const b of state.beitraege ?? []) {
    teile.push(`## ${b.sprecher} · ${uhrzeit(b.begonnen, zeitzone)}`, "", b.text, "");
  }
  const aktiv = state.aktiv;
  if (aktiv) teile.push(`## ${aktiv.sprecher} · ${uhrzeit(aktiv.begonnen, zeitzone)}`, "", aktiv.committed.trim(), "");
  return teile.join("\n");
}

// Und zurück: Der letzte Abschnitt gehört dem, der gerade spricht — er wird
// nicht zum abgeschlossenen Beitrag, sondern fasst den laufenden neu.
export function ausDokument(markdown, state, zeitzone = standardZone()) {
  const gelesen = ausMarkdown(markdown, { runde: state, zeitzone });
  const beitraege = gelesen.beitraege.filter((b) => b.text.trim());
  let laufend = null;
  if (state.aktiv) {
    // Auch ohne Text gehört die letzte Überschrift dem laufenden Beitrag.
    const letzte = gelesen.beitraege.at(-1);
    if (letzte) {
      laufend = { sprecher: letzte.sprecher, text: letzte.text.trim() };
      if (beitraege.at(-1) === letzte) beitraege.pop();
    }
  }
  return { titel: gelesen.titel, beitraege, laufend };
}

export class Protokollbuch {
  #circle;
  #doc = new Y.Doc();
  #text;
  #angehaengt = ""; // was von der Erkennung schon im Dokument steht
  #titelStand = null; // welcher Titel im Dokument steht
  #laufendSeit = null; // welcher Beitrag gerade am Ende hängt
  #uhr = null;
  #onUpdate;
  #onUebernahme;
  #zone;

  constructor(circle, { onUpdate = () => {}, onUebernahme = () => {}, zeitzone = standardZone() } = {}) {
    this.#circle = circle;
    this.#zone = zeitzone;
    this.#onUpdate = onUpdate;
    this.#onUebernahme = onUebernahme;
    this.#text = this.#doc.getText("protokoll");
    this.#doc.on("update", (update, herkunft) => {
      this.#onUpdate(update, herkunft);
      // Nur was von außen kommt, will gelesen werden. Was der Server selbst
      // anhängt, steht ohnehin schon in der Runde.
      if (herkunft !== "server") this.#planen();
    });
    this.neuAufsetzen();
  }

  // Der ganze Stand für ein Gerät, das gerade dazukommt.
  stand() {
    return Y.encodeStateAsUpdate(this.#doc);
  }

  markdown() {
    return this.#text.toString();
  }

  // Eine Änderung von einem Gerät.
  vonAussen(update, herkunft) {
    Y.applyUpdate(this.#doc, update, herkunft);
  }

  // Neue Runde: Das Buch fängt leer an.
  neuAufsetzen() {
    this.#schreiben(() => {
      this.#text.delete(0, this.#text.length);
      this.#text.insert(0, dokumentText(this.#circle.state, this.#zone));
    });
    const aktiv = this.#circle.state.aktiv;
    this.#laufendSeit = aktiv?.begonnen ?? null;
    this.#angehaengt = aktiv?.committed.trim() ?? "";
    this.#titelStand = this.#circle.state.titel;
    clearTimeout(this.#uhr);
    this.#uhr = null;
  }

  // Die Erkennung ist weitergekommen: Was dazugekommen ist, wandert ans Ende.
  nachziehen() {
    this.#titelNachziehen();
    const aktiv = this.#circle.state.aktiv;
    if (!aktiv) {
      this.#laufendSeit = null;
      this.#angehaengt = "";
      return;
    }
    if (this.#laufendSeit !== aktiv.begonnen) {
      // Ein neuer Beitrag: seine Überschrift bekommt das Dokument ans Ende.
      // Blieb der vorige ohne ein Wort, verschwindet seine Überschrift — sie
      // stünde sonst als leerer Absatz im Protokoll.
      this.#leereUeberschriftEntfernen();
      const kopf = `## ${aktiv.sprecher} · ${uhrzeit(aktiv.begonnen, this.#zone)}\n\n`;
      const bisher = this.#text.toString();
      this.#anhaengen((bisher.endsWith("\n\n") ? "" : bisher.endsWith("\n") ? "\n" : "\n\n") + kopf);
      this.#laufendSeit = aktiv.begonnen;
      this.#angehaengt = "";
    }
    const fest = aktiv.committed.trim();
    if (fest === this.#angehaengt) return;
    const roh = this.#text.toString();
    const rumpf = this.#laufenderRumpf(roh);
    if (this.#angehaengt && !fest.startsWith(this.#angehaengt)) {
      // Der Strom hat sich neu gefasst. Steht im Dokument noch genau das, was
      // die Erkennung zuletzt geschrieben hat, wird es ersetzt. Hat jemand
      // darin getippt, bleibt sein Text stehen — die Übernahme gleicht ab.
      if (rumpf && rumpf.text.trim() === this.#angehaengt) {
        this.#schreiben(() => {
          this.#text.delete(rumpf.von, rumpf.text.length);
          this.#text.insert(rumpf.von, fest);
        });
      }
      this.#angehaengt = fest;
      return;
    }
    const dazu = fest.slice(this.#angehaengt.length);
    const warLeer = this.#angehaengt === "";
    this.#angehaengt = fest;
    if (!dazu.trim()) return;
    // Das neue Wort gehört hinter das letzte Wort, nicht hinter die Leerzeile
    // darunter. Beim ersten Wort eines Beitrags aber genau dorthin: unter die
    // Überschrift.
    const stelle = warLeer ? roh.length : roh.replace(/\s+$/, "").length;
    this.#schreiben(() => this.#text.insert(stelle, warLeer ? dazu.trimStart() : dazu));
  }

  #leereUeberschriftEntfernen() {
    if (this.#laufendSeit === null || this.#angehaengt) return;
    const roh = this.#text.toString();
    const rumpf = this.#laufenderRumpf(roh);
    if (!rumpf || rumpf.text.trim()) return;
    const kopf = roh.lastIndexOf("\n## ");
    this.#schreiben(() => this.#text.delete(kopf + 1, roh.length - kopf - 1));
  }

  // Der Text unter der letzten Überschrift — das ist der laufende Beitrag.
  #laufenderRumpf(roh) {
    const kopf = roh.lastIndexOf("\n## ");
    if (kopf === -1) return null;
    const zeilenende = roh.indexOf("\n", kopf + 1);
    if (zeilenende === -1) return null;
    let von = zeilenende + 1;
    while (roh[von] === "\n") von++; // die Leerzeile unter der Überschrift bleibt
    return { von, text: roh.slice(von).replace(/\s+$/, "") };
  }

  // Der Titel kann auch aus den Einstellungen kommen — dann gehört er in die
  // erste Zeile des Dokuments, ohne dass jemand dort tippen musste.
  #titelNachziehen() {
    const titel = this.#circle.state.titel;
    if (titel === this.#titelStand) return;
    this.#titelStand = titel;
    const roh = this.#text.toString();
    const treffer = roh.match(/^# (.*)$/m);
    this.#schreiben(() => {
      if (treffer) {
        this.#text.delete(treffer.index, treffer[0].length);
        this.#text.insert(treffer.index, `# ${titel}`);
      } else {
        this.#text.insert(0, `# ${titel}\n\n`);
      }
    });
  }

  #anhaengen(stueck) {
    this.#schreiben(() => this.#text.insert(this.#text.length, stueck));
  }

  #schreiben(fn) {
    this.#doc.transact(fn, "server");
  }

  #planen() {
    clearTimeout(this.#uhr);
    this.#uhr = setTimeout(() => {
      this.#uhr = null;
      this.uebernehmen().catch((err) => console.error("Übernahme fehlgeschlagen:", err.message));
    }, UEBERNAHME_MS);
    this.#uhr.unref?.();
  }

  // Was im Buch steht, wird zur Runde.
  async uebernehmen() {
    const state = this.#circle.state;
    const { titel, beitraege, laufend } = ausDokument(this.markdown(), state, this.#zone);
    const vorher = state.beitraege;
    const gleich =
      titel === state.titel &&
      vorher.length === beitraege.length &&
      vorher.every((b, i) => b.text === beitraege[i].text && b.sprecher === beitraege[i].sprecher) &&
      (!state.aktiv ||
        ((laufend?.text ?? "") === state.aktiv.committed.trim() &&
          (laufend?.sprecher ?? state.aktiv.sprecher) === state.aktiv.sprecher));
    if (gleich) return null;

    const beschreibung =
      vorher.length === beitraege.length
        ? `${beitraege.length} ${beitraege.length === 1 ? "Beitrag" : "Beiträge"} im Kreis überarbeitet`
        : `Beiträge ${vorher.length} → ${beitraege.length}${beitraege.length > vorher.length ? " (aufgeteilt)" : " (zusammengefasst)"}`;
    this.#onUebernahme(beschreibung);
    // Erst merken, dann übernehmen: Die Übernahme meldet den Kreis weiter, und
    // wer dann nachzieht, dürfte den Text nicht ein zweites Mal anhängen.
    this.#angehaengt = laufend?.text ?? "";
    this.#titelStand = titel;
    await this.#circle.uebernehmen({ titel, beitraege, laufend });
    return beschreibung;
  }

  schliessen() {
    clearTimeout(this.#uhr);
    this.#doc.destroy();
  }
}
