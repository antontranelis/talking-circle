// Das Protokollbuch: ein Text, an dem alle zugleich schreiben — und der
// trotzdem die Runde bleibt.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { Protokollbuch, ausDokument, dokumentText } from "../editor.mjs";

const zone = "Europe/Berlin";
const zeit = (hhmm) => new Date(`2026-09-12T${hhmm}:00+02:00`).toISOString();

const runde = () => ({
  id: "2026-09-12T14-00-00",
  titel: "Traumkreis im Garten",
  begonnen: zeit("14:00"),
  beitraege: [
    { sprecher: "Holger", begonnen: zeit("14:02"), text: "Mein Traum ist kleiner: eine Werkstatt." },
    { sprecher: "Agnes", begonnen: zeit("14:09"), text: "Ich sehe uns im Frühjahr, mit zwanzig Leuten." },
  ],
  aktiv: { sprecher: "Janosch", begonnen: zeit("14:16"), committed: "Ich habe den Traum noch nicht zu Ende gedacht.", tentative: "und wenn ich" },
});

test("Das Dokument trägt die ganze Runde — und liest sich unverändert zurück", () => {
  const state = runde();
  const md = dokumentText(state, zone);
  assert.match(md, /^# Traumkreis im Garten\n\n## Holger · 14:02\n\nMein Traum/);
  assert.ok(!md.includes("und wenn ich"), "der vorläufige Text gehört nicht ins Dokument");

  const zurueck = ausDokument(md, state, zone);
  assert.equal(zurueck.titel, "Traumkreis im Garten");
  assert.deepEqual(
    zurueck.beitraege.map((b) => [b.sprecher, b.text]),
    [
      ["Holger", "Mein Traum ist kleiner: eine Werkstatt."],
      ["Agnes", "Ich sehe uns im Frühjahr, mit zwanzig Leuten."],
    ],
  );
  assert.deepEqual(zurueck.beitraege.map((b) => b.begonnen), [state.beitraege[0].begonnen, state.beitraege[1].begonnen]);
  assert.deepEqual(zurueck.laufend, { sprecher: "Janosch", text: state.aktiv.committed });
});

test("Ein aufgeteilter Beitrag wird zu zweien, der laufende bleibt der laufende", () => {
  const state = runde();
  const md = dokumentText(state, zone).replace(
    "Ich sehe uns im Frühjahr, mit zwanzig Leuten.",
    "Ich sehe uns im Frühjahr.\n\n## Emil · 14:12\n\nUnd ich war lange still.",
  );
  const zurueck = ausDokument(md, state, zone);
  assert.deepEqual(zurueck.beitraege.map((b) => b.sprecher), ["Holger", "Agnes", "Emil"]);
  assert.equal(zurueck.beitraege[2].text, "Und ich war lange still.");
  assert.equal(zurueck.laufend.sprecher, "Janosch");
});

// Ein Kreis, der nur so tut: kein Modell, kein Ton — aber dieselben Felder.
function kreisAttrappe() {
  const state = runde();
  return {
    state,
    uebernommen: [],
    async uebernehmen({ titel, beitraege, laufend }) {
      state.titel = titel;
      state.beitraege = beitraege;
      if (state.aktiv && laufend) {
        state.aktiv.committed = laufend.text;
        state.aktiv.sprecher = laufend.sprecher;
      }
      this.uebernommen.push({ titel, beitraege, laufend });
    },
  };
}

test("Was die Erkennung festschreibt, hängt ans Ende — auch wenn oben getippt wird", async () => {
  const kreis = kreisAttrappe();
  const schritte = [];
  const buch = new Protokollbuch(kreis, { zeitzone: zone, onUebernahme: (b) => schritte.push(b) });

  // Jemand tippt oben im Dokument einen Tippfehler weg.
  const gerät = new Y.Doc();
  Y.applyUpdate(gerät, buch.stand());
  const text = gerät.getText("protokoll");
  const stelle = text.toString().indexOf("Werkstatt.");
  gerät.transact(() => {
    text.delete(stelle, "Werkstatt.".length);
    text.insert(stelle, "Werkstatt mit Licht.");
  });
  buch.vonAussen(Y.encodeStateAsUpdate(gerät), "gerät");

  // Und währenddessen spricht Janosch weiter.
  kreis.state.aktiv.committed = "Ich habe den Traum noch nicht zu Ende gedacht. Er hängt am Garten.";
  buch.nachziehen();

  const md = buch.markdown();
  assert.match(md, /Werkstatt mit Licht\./, "die Korrektur wurde überschrieben");
  assert.match(md, /Er hängt am Garten\.\s*$/, "der neue Text hängt nicht am Ende");
  assert.equal(md.match(/Er hängt am Garten/g).length, 1, "der Text steht doppelt im Dokument");

  // Und die Übernahme trägt beides in die Runde.
  await buch.uebernehmen();
  assert.equal(kreis.state.beitraege[0].text, "Mein Traum ist kleiner: eine Werkstatt mit Licht.");
  assert.equal(kreis.state.aktiv.committed, "Ich habe den Traum noch nicht zu Ende gedacht. Er hängt am Garten.");
  assert.equal(schritte.length, 1, "die Übernahme steht nicht in der Historie");
  buch.schliessen();
});

test("Was jemand in den laufenden Beitrag tippt, steht danach nur einmal da", async () => {
  // Der Fehler, den das hier abfängt: Die Übernahme meldet den Kreis weiter,
  // das Buch zog nach — und hängte den eben getippten Satz ein zweites Mal an.
  const kreis = kreisAttrappe();
  kreis.state.aktiv.committed = "";
  const buch = new Protokollbuch(kreis, { zeitzone: zone });
  // Der Kreis meldet sich nach jeder Übernahme — wie im Betrieb.
  const alt = kreis.uebernehmen.bind(kreis);
  kreis.uebernehmen = async (was) => {
    await alt(was);
    buch.nachziehen();
  };

  const gerät = new Y.Doc();
  Y.applyUpdate(gerät, buch.stand());
  const text = gerät.getText("protokoll");
  gerät.transact(() => text.insert(text.length, "Und das habe ich getippt."));
  buch.vonAussen(Y.encodeStateAsUpdate(gerät), "gerät");
  await buch.uebernehmen();

  assert.equal(kreis.state.aktiv.committed, "Und das habe ich getippt.");
  assert.equal(
    buch.markdown().match(/Und das habe ich getippt\./g).length,
    1,
    "der getippte Satz steht doppelt im Protokoll",
  );
  buch.schliessen();
});

test("Ein anderer Name über dem laufenden Beitrag wird übernommen — auch ohne neuen Text", async () => {
  // Der Fehler, den das hier abfängt: Nur der Text des laufenden Beitrags
  // wurde verglichen. Wer bloß den Sprecher korrigierte, sah nichts passieren.
  const kreis = kreisAttrappe();
  const buch = new Protokollbuch(kreis, { zeitzone: zone });

  const gerät = new Y.Doc();
  Y.applyUpdate(gerät, buch.stand());
  const text = gerät.getText("protokoll");
  const stelle = text.toString().indexOf("## Janosch");
  gerät.transact(() => {
    text.delete(stelle + 3, "Janosch".length);
    text.insert(stelle + 3, "Der echte Emil");
  });
  buch.vonAussen(Y.encodeStateAsUpdate(gerät), "gerät");
  await buch.uebernehmen();

  assert.equal(kreis.state.aktiv.sprecher, "Der echte Emil");
  buch.schliessen();
});

test("Zwei Geräte sehen dieselbe Änderung", () => {
  const kreis = kreisAttrappe();
  const hinaus = [];
  const buch = new Protokollbuch(kreis, { zeitzone: zone, onUpdate: (u, herkunft) => hinaus.push({ u, herkunft }) });

  const a = new Y.Doc();
  const b = new Y.Doc();
  for (const doc of [a, b]) Y.applyUpdate(doc, buch.stand());

  // A schreibt, der Server verteilt.
  a.getText("protokoll").insert(0, "");
  const vorher = hinaus.length;
  a.transact(() => a.getText("protokoll").insert(a.getText("protokoll").toString().indexOf("# ") + 2, "Neuer "));
  buch.vonAussen(Y.encodeStateAsUpdate(a), "a");

  const fuerB = hinaus.slice(vorher).filter((n) => n.herkunft === "a");
  assert.ok(fuerB.length, "der Server hat die Änderung nicht weitergereicht");
  for (const n of fuerB) Y.applyUpdate(b, n.u);
  assert.equal(b.getText("protokoll").toString(), a.getText("protokoll").toString());
  assert.match(b.getText("protokoll").toString(), /^# Neuer Traumkreis/);
  buch.schliessen();
});

test("Ein Titel aus den Einstellungen steht auch im Protokoll", () => {
  const kreis = kreisAttrappe();
  const buch = new Protokollbuch(kreis, { zeitzone: zone });
  assert.match(buch.markdown(), /^# Traumkreis im Garten/);

  kreis.state.titel = "Probelauf am Dienstag";
  buch.nachziehen();
  assert.match(buch.markdown(), /^# Probelauf am Dienstag/);
  assert.match(buch.markdown(), /## Holger/, "der Rest des Protokolls ist verloren gegangen");
  buch.schliessen();
});

test("Ohne laufenden Beitrag wird auch der letzte Abschnitt ein Beitrag", () => {
  const state = runde();
  state.aktiv = null;
  const md = dokumentText(state, zone);
  const zurueck = ausDokument(md, state, zone);
  assert.equal(zurueck.laufend, null);
  assert.deepEqual(zurueck.beitraege.map((b) => b.sprecher), ["Holger", "Agnes"]);
});
