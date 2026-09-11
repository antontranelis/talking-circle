// Tests für Archiv und Protokollbearbeitung. Brauchen weder Modell noch
// Server und laufen deshalb in Millisekunden.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import os from "node:os";

import { alsMarkdown, ausMarkdown } from "../protokoll.mjs";

// Das Archiv liest den Ordner aus der Umgebung — die Prüfung bekommt einen
// eigenen, damit sie nicht in echten Runden herumfuhrwerkt. Muss vor dem Laden
// des Moduls stehen.
const WURZEL = fs.mkdtempSync(path.join(os.tmpdir(), "redekreis-archiv-"));
process.env.TALKING_CIRCLE_TRANSCRIPTS = WURZEL;
process.on("exit", () => fs.rmSync(WURZEL, { recursive: true, force: true }));
const {
  benenneUm,
  gespeicherteRunden,
  historie,
  ladeRunde,
  loesche,
  nimmZurueck,
  speichereMarkdown,
  stelleWiederHer,
} = await import("../archiv.mjs");
const ZONE = "Europe/Berlin";

// Jede Prüfung legt ihre eigene Runde an und räumt sie hinterher weg.
let zaehler = 0;
function legeRundeAn(t, beitraege, titel = "Probe") {
  const stunde = String(10 + (zaehler % 9)).padStart(2, "0");
  const id = `2011-03-0${(zaehler % 9) + 1}T${stunde}-00-00`;
  zaehler++;
  const runde = {
    id,
    titel,
    begonnen: `2011-03-0${(id.slice(9, 10) | 0) || 1}T09:00:00.000Z`,
    sprache: "de-DE",
    beitraege,
    laufend: null,
  };
  fs.mkdirSync(WURZEL, { recursive: true });
  fs.writeFileSync(path.join(WURZEL, `${id}.json`), JSON.stringify(runde, null, 2));
  t.after(() => {
    for (const endung of [".json", ".md", ".jsonl"]) {
      fs.rmSync(path.join(WURZEL, `${id}${endung}`), { force: true });
      fs.rmSync(path.join(WURZEL, "papierkorb", `${id}${endung}`), { force: true });
    }
    fs.rmSync(path.join(WURZEL, `${id}.historie`), { recursive: true, force: true });
    fs.rmSync(path.join(WURZEL, "papierkorb", `${id}.historie`), { recursive: true, force: true });
  });
  return runde;
}

const beitrag = (sprecher, iso, text) => ({ sprecher, begonnen: iso, beendet: iso, text });

test("Markdown hin und zurück lässt Sprecher, Text und Zeitstempel unverändert", () => {
  const runde = {
    titel: "Sonntagskreis",
    begonnen: "2026-09-07T10:11:39.000Z",
    beitraege: [
      beitrag("Holger", "2026-09-07T10:16:00.000Z", "Also was ich mir erhoffe."),
      beitrag("Agnes", "2026-09-07T10:17:30.000Z", "Meine Vision.\n\nZweiter Absatz."),
    ],
  };
  const zurueck = ausMarkdown(alsMarkdown(runde, ZONE), { runde, zeitzone: ZONE });

  assert.equal(zurueck.titel, "Sonntagskreis");
  assert.deepEqual(
    zurueck.beitraege.map((b) => [b.sprecher, b.begonnen, b.text]),
    runde.beitraege.map((b) => [b.sprecher, b.begonnen, b.text]),
  );
});

test("Ein vergessener Sprecher lässt sich nachträglich herausteilen", () => {
  // Der häufige Fall: die Leertaste kam zu spät, zwei Menschen stecken in
  // einem Beitrag. Beim Korrigieren wird daraus eine zweite Überschrift.
  const runde = {
    titel: "Kreis",
    begonnen: "2026-09-07T10:00:00.000Z",
    beitraege: [beitrag("Holger", "2026-09-07T10:16:00.000Z", "Teil von Holger. Und dann redet Agnes weiter.")],
  };
  const bearbeitet = [
    "# Kreis",
    "",
    "## Holger · 12:16",
    "",
    "Teil von Holger.",
    "",
    "## Agnes · 12:21",
    "",
    "Und dann redet Agnes weiter.",
    "",
  ].join("\n");

  const neu = ausMarkdown(bearbeitet, { runde, zeitzone: ZONE });
  assert.equal(neu.beitraege.length, 2);
  assert.deepEqual(neu.beitraege.map((b) => b.sprecher), ["Holger", "Agnes"]);
  // Holger behält seinen echten Zeitstempel, Agnes bekommt einen aus der Uhrzeit.
  assert.equal(neu.beitraege[0].begonnen, "2026-09-07T10:16:00.000Z");
  assert.equal(neu.beitraege[1].begonnen, "2026-09-07T10:21:00.000Z");
  assert.ok(new Date(neu.beitraege[1].begonnen) > new Date(neu.beitraege[0].begonnen));
});

test("Eine Runde über Mitternacht bekommt den richtigen Tag", () => {
  const runde = {
    titel: "Lange Nacht",
    begonnen: "2026-09-07T21:00:00.000Z", // 23:00 in Berlin
    beitraege: [beitrag("Timo", "2026-09-07T21:30:00.000Z", "Vor Mitternacht.")],
  };
  const bearbeitet = "# Lange Nacht\n\n## Timo · 23:30\n\nVor Mitternacht.\n\n## Emil · 00:20\n\nDanach.\n";
  const neu = ausMarkdown(bearbeitet, { runde, zeitzone: ZONE });

  assert.equal(neu.beitraege[1].sprecher, "Emil");
  assert.equal(neu.beitraege[1].begonnen, "2026-09-07T22:20:00.000Z"); // 00:20 am Folgetag
  assert.ok(new Date(neu.beitraege[1].begonnen) > new Date(neu.beitraege[0].begonnen));
});

test("Beiträge zusammenfassen geht genauso", () => {
  const runde = {
    titel: "Kreis",
    begonnen: "2026-09-07T10:00:00.000Z",
    beitraege: [
      beitrag("Anton", "2026-09-07T10:16:00.000Z", "Erster Teil."),
      beitrag("Anton", "2026-09-07T10:18:00.000Z", "Zweiter Teil."),
    ],
  };
  const neu = ausMarkdown("# Kreis\n\n## Anton · 12:16\n\nErster Teil. Zweiter Teil.\n", { runde, zeitzone: ZONE });
  assert.equal(neu.beitraege.length, 1);
  assert.equal(neu.beitraege[0].text, "Erster Teil. Zweiter Teil.");
});

test("Speichern schreibt alle drei Formate und legt einen Schritt in die Historie", (t) => {
  const runde = legeRundeAn(t, [beitrag("Anton", "2011-03-01T09:16:00.000Z", "Ursprünglich.")]);
  const md = "# Neuer Titel\n\n## Anton · 10:16\n\nKorrigiert.\n";
  const { runde: neu, fehler } = speichereMarkdown(runde.id, md, { zeitzone: ZONE });

  assert.equal(fehler, undefined);
  assert.equal(neu.titel, "Neuer Titel");
  assert.equal(ladeRunde(runde.id).beitraege[0].text, "Korrigiert.");
  assert.match(fs.readFileSync(path.join(WURZEL, `${runde.id}.md`), "utf8"), /Korrigiert\./);
  assert.match(fs.readFileSync(path.join(WURZEL, `${runde.id}.jsonl`), "utf8"), /"role":"Anton"/);

  const schritte = historie(runde.id);
  assert.equal(schritte.length, 1);
  assert.equal(schritte[0].aktion, "bearbeitet");
});

test("Umbenennen ändert nur den Titel und ist rücknehmbar", (t) => {
  const runde = legeRundeAn(t, [beitrag("Eva", "2011-03-02T09:16:00.000Z", "Text.")], "Alter Name");
  benenneUm(runde.id, "Neuer Name");
  assert.equal(ladeRunde(runde.id).titel, "Neuer Name");

  const schritt = historie(runde.id).at(-1);
  assert.equal(schritt.aktion, "umbenannt");
  assert.match(schritt.beschreibung, /Alter Name/);

  nimmZurueck(runde.id, schritt.nr);
  assert.equal(ladeRunde(runde.id).titel, "Alter Name");
  // Die Rücknahme ist selbst ein Schritt — die Geschichte bleibt vollständig.
  assert.equal(historie(runde.id).at(-1).aktion, "zurückgenommen");
  assert.equal(historie(runde.id).length, 2);
});

test("Ein leerer Titel wird abgelehnt", (t) => {
  const runde = legeRundeAn(t, [beitrag("Eva", "2011-03-03T09:16:00.000Z", "Text.")], "Bleibt");
  const { fehler } = benenneUm(runde.id, "   ");
  assert.match(fehler, /leer/);
  assert.equal(ladeRunde(runde.id).titel, "Bleibt");
});

test("Löschen legt in den Papierkorb und lässt sich zurückholen", (t) => {
  const runde = legeRundeAn(t, [beitrag("Timo", "2011-03-04T09:16:00.000Z", "Text.")], "Verschwindet");
  loesche(runde.id);

  assert.equal(ladeRunde(runde.id), null, "die Runde liegt noch am alten Platz");
  assert.ok(!gespeicherteRunden().some((r) => r.id === runde.id));
  assert.ok(gespeicherteRunden({ geloescht: true }).some((r) => r.id === runde.id), "nicht im Papierkorb");

  stelleWiederHer(runde.id);
  assert.equal(ladeRunde(runde.id).titel, "Verschwindet");
  assert.ok(!gespeicherteRunden({ geloescht: true }).some((r) => r.id === runde.id));
  assert.equal(historie(runde.id).at(-1).aktion, "wiederhergestellt");
});

test("Eine Bearbeitung lässt sich vollständig zurücknehmen", (t) => {
  const runde = legeRundeAn(t, [beitrag("Holger", "2011-03-05T09:16:00.000Z", "Der echte Wortlaut.")]);
  speichereMarkdown(runde.id, "# Probe\n\n## Holger · 10:16\n\nVersehentlich überschrieben.\n", { zeitzone: ZONE });
  assert.equal(ladeRunde(runde.id).beitraege[0].text, "Versehentlich überschrieben.");

  const schritt = historie(runde.id).at(-1);
  nimmZurueck(runde.id, schritt.nr);
  assert.equal(ladeRunde(runde.id).beitraege[0].text, "Der echte Wortlaut.");
});

test("Unsinnige Kennungen erreichen keine Dateien", () => {
  for (const boese of ["../package", "..%2Fpackage", "", null, "2026-13-99T99-99-99/../x"]) {
    assert.equal(ladeRunde(boese), null, `${boese} wurde geladen`);
    assert.deepEqual(historie(boese), []);
    assert.ok(speichereMarkdown(boese, "# x").fehler, `${boese} wurde gespeichert`);
  }
});
