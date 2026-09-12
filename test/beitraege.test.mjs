// Beiträge teilen, einfügen, verbinden — ohne Server, ohne Modell.
import { test } from "node:test";
import assert from "node:assert/strict";
import { einfuegen, teilen, verbinden } from "../beitraege.mjs";

const zeit = (hhmm, ss = "00") => new Date(`2026-09-12T${hhmm}:${ss}+02:00`).toISOString();

const runde = () => [
  { sprecher: "Holger", begonnen: zeit("14:00"), beendet: zeit("14:10"), text: "Mein Traum ist kleiner. Und ich bin Agnes und rede schon weiter." },
  { sprecher: "Jonathan", begonnen: zeit("14:12"), beendet: zeit("14:20"), text: "Die Kostenfrage gehört nach vorn." },
];

const uhr = (b) => new Date(b.begonnen).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Berlin" });

test("Geteilt wird an der Stelle im Text — der zweite bekommt Sprecher und anteilige Zeit", () => {
  const alt = runde();
  const stelle = alt[0].text.indexOf("Und ich bin Agnes");
  const neu = teilen(alt, 0, stelle, "Agnes");

  assert.equal(neu.length, 3);
  assert.deepEqual(neu.map((b) => b.sprecher), ["Holger", "Agnes", "Jonathan"]);
  assert.equal(neu[0].text, "Mein Traum ist kleiner.");
  assert.equal(neu[1].text, "Und ich bin Agnes und rede schon weiter.");

  // Der erste behält seinen Beginn, der zweite fängt beim Schnitt an — und der
  // erste hört genau dort auf.
  assert.equal(neu[0].begonnen, alt[0].begonnen);
  assert.equal(neu[0].beendet, neu[1].begonnen);
  assert.equal(neu[1].beendet, alt[0].beendet);

  // Anteilig: Der Schnitt liegt im ersten Drittel des Textes, also auch der
  // ersten Minuten der zehn.
  const anteil = (new Date(neu[1].begonnen) - new Date(alt[0].begonnen)) / (10 * 60 * 1000);
  assert.ok(anteil > 0.15 && anteil < 0.45, `der Schnitt liegt bei ${anteil}`);

  // Die alte Liste bleibt, wie sie war.
  assert.equal(alt.length, 2);
  assert.equal(alt[0].text, runde()[0].text);
});

test("Ohne Ende liegt der zweite Teil eine Sekunde später", () => {
  const alt = [{ sprecher: "Eva", begonnen: zeit("23:59", "30"), text: "Erster Satz. Zweiter Satz." }];
  const neu = teilen(alt, 0, "Erster Satz.".length, "Timo");
  assert.equal(neu[1].begonnen, zeit("23:59", "31"));
  assert.ok(!("beendet" in neu[0]), "aus dem Nichts darf kein Ende entstehen");
  assert.ok(!("beendet" in neu[1]));
});

test("Über Mitternacht geteilt bleibt die Reihenfolge stehen", () => {
  const alt = [
    {
      sprecher: "Eva",
      begonnen: zeit("23:58"),
      beendet: new Date("2026-09-13T00:04:00+02:00").toISOString(),
      text: "Vor Mitternacht gesagt. Danach weitergeredet.",
    },
  ];
  const neu = teilen(alt, 0, "Vor Mitternacht gesagt.".length, "Timo");
  const schnitt = new Date(neu[1].begonnen);
  assert.ok(schnitt > new Date(alt[0].begonnen) && schnitt < new Date(alt[0].beendet));
  assert.equal(uhr(neu[1]), "00:01", "der Schnitt liegt nicht auf dem neuen Tag");
});

test("Ein Schnitt am Rand teilt nichts", () => {
  const alt = runde();
  assert.equal(teilen(alt, 0, 0, "Agnes"), null);
  assert.equal(teilen(alt, 0, alt[0].text.length, "Agnes"), null);
  const mitLeerraum = [{ sprecher: "Eva", begonnen: zeit("14:00"), text: "   Nur Leerzeichen davor." }];
  assert.equal(teilen(mitLeerraum, 0, 2, "Agnes"), null, "vor dem Schnitt steht nur Leerraum");
  assert.equal(teilen(alt, 7, 5, "Agnes"), null, "diesen Beitrag gibt es nicht");
});

test("Ohne neuen Namen bleibt der zweite Teil beim alten Sprecher", () => {
  const alt = runde();
  const neu = teilen(alt, 0, alt[0].text.indexOf("Und ich"), "   ");
  assert.equal(neu[1].sprecher, "Holger");
});

test("Eingefügt wird zwischen den Nachbarn — und am Rand daneben", () => {
  const alt = runde();

  const mitte = einfuegen(alt, 1, { sprecher: "Agnes", text: "Dazwischen gesagt." });
  assert.deepEqual(mitte.map((b) => b.sprecher), ["Holger", "Agnes", "Jonathan"]);
  assert.equal(uhr(mitte[1]), "14:11", "die Zeit liegt nicht zwischen 14:10 und 14:12");
  assert.ok(!("beendet" in mitte[1]));

  const vorn = einfuegen(alt, 0, { sprecher: "Eva", text: "Ganz am Anfang." });
  assert.equal(vorn[0].sprecher, "Eva");
  assert.equal(new Date(vorn[0].begonnen).getTime(), new Date(alt[0].begonnen).getTime() - 1000);

  const hinten = einfuegen(alt, 2, { sprecher: "Eva", text: "Ganz am Ende." });
  assert.equal(hinten[2].sprecher, "Eva");
  assert.equal(new Date(hinten[2].begonnen).getTime(), new Date(alt[1].beendet).getTime() + 1000);

  assert.equal(alt.length, 2, "die alte Liste wurde angefasst");
});

test("Ein eingefügter Beitrag darf leer sein und bekommt notfalls einen Namen", () => {
  const neu = einfuegen([], 0, {});
  assert.equal(neu.length, 1);
  assert.equal(neu[0].sprecher, "Unbekannt");
  assert.equal(neu[0].text, "");
});

test("Verbunden hängt der Text an den vorigen — Sprecher und Beginn bleiben dessen", () => {
  const alt = runde();
  const neu = verbinden(alt, 1);
  assert.equal(neu.length, 1);
  assert.equal(neu[0].sprecher, "Holger");
  assert.equal(neu[0].begonnen, alt[0].begonnen);
  assert.equal(neu[0].beendet, alt[1].beendet, "das spätere Ende gilt");
  assert.equal(neu[0].text, `${alt[0].text} ${alt[1].text}`);
  assert.equal(alt.length, 2);
});

test("Der erste Beitrag hat keinen vorigen", () => {
  assert.equal(verbinden(runde(), 0), null);
  assert.equal(verbinden(runde(), 9), null);
});
