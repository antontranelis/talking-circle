// Der Kreis selbst, ohne Modell und ohne Server: Wer sitzt drin, wer ist da,
// wer bekommt das Mikrofon als Nächstes.
import { test } from "node:test";
import assert from "node:assert/strict";

// Kurze Karenzzeit, damit die Tests nicht 45 Sekunden warten. Muss vor dem
// Laden des Moduls stehen — die Konstante wird beim Import gelesen.
const KARENZ = 120;
process.env.TALKING_CIRCLE_KARENZ_MS = String(KARENZ);
const { Circle } = await import("../circle.mjs");

const warte = (ms) => new Promise((ok) => setTimeout(ok, ms));

test("Wer beitritt, sitzt im Kreis — auch mehrere Menschen an einem Gerät", () => {
  const kreis = new Circle();
  const anton = kreis.beitreten("Anton", 1);
  const eva = kreis.beitreten("Eva", 1);

  assert.notEqual(anton, eva, "zwei Menschen am selben Gerät brauchen eigene Kennungen");
  assert.deepEqual(
    kreis.state.teilnehmende.map((t) => [t.name, t.geraet, t.da]),
    [["Anton", 1, true], ["Eva", 1, true]],
  );
  // Ein leerer Name ist kein Beitritt.
  assert.equal(kreis.beitreten("   ", 1), null);
  assert.equal(kreis.state.teilnehmende.length, 2);
});

test("Ein getrenntes Gerät nimmt die Menschen nicht aus dem Kreis", () => {
  const kreis = new Circle();
  const anton = kreis.beitreten("Anton", 1);
  const eva = kreis.beitreten("Eva", 2);

  kreis.geraetGetrennt(2);
  const evaImKreis = kreis.state.teilnehmende.find((t) => t.id === eva);
  assert.equal(evaImKreis.da, false, "Eva ist weg, nicht gelöscht");
  assert.equal(evaImKreis.geraet, null);
  assert.deepEqual(kreis.anwesende().map((t) => t.name), ["Anton"]);

  // Abwesende werden beim Weiterreichen übersprungen.
  kreis.gibMikrofonAn(anton);
  assert.equal(kreis.naechster(), anton, "es ist nur noch einer da");

  // Und wer mit demselben Namen wiederkommt, bekommt seinen Platz zurück.
  const zurueck = kreis.beitreten("Eva", 3);
  assert.equal(zurueck, eva, "Eva hat eine neue Kennung bekommen");
  assert.equal(kreis.state.teilnehmende.length, 2, "Eva steht doppelt im Kreis");
  assert.equal(kreis.state.teilnehmende.find((t) => t.id === eva).geraet, 3);
  assert.deepEqual(kreis.anwesende().map((t) => t.name), ["Anton", "Eva"]);
});

test("Das Mikrofon wandert der Reihe nach und bleibt bei den Anwesenden", async () => {
  const kreis = new Circle();
  const anton = kreis.beitreten("Anton", 1);
  const eva = kreis.beitreten("Eva", 2);
  const timo = kreis.beitreten("Timo", 3);

  assert.equal(kreis.naechster(), anton, "ohne Vorgänger fängt der Erste an");
  assert.equal(kreis.gibMikrofonAn(anton).name, "Anton");
  assert.equal(kreis.naechster(), eva);
  kreis.gibMikrofonAn(eva);

  kreis.geraetGetrennt(3); // Timo ist weg
  assert.equal(kreis.naechster(), anton, "Timo wird übersprungen");

  await kreis.verlassen(eva);
  assert.equal(kreis.state.dran, null, "wer geht, hat das Mikrofon nicht mehr");
  assert.deepEqual(kreis.state.teilnehmende.map((t) => t.name), ["Anton", "Timo"]);
});

test("Eine neue Runde behält den Kreis und nimmt das Mikrofon zurück", async () => {
  const kreis = new Circle();
  const anton = kreis.beitreten("Anton", 1);
  kreis.gibMikrofonAn(anton);
  kreis.setzen({ titel: "Zweite Runde" });
  assert.deepEqual(kreis.state.teilnehmende.map((t) => t.name), ["Anton"], "setzen wirft den Kreis um");

  await kreis.neueRunde();
  assert.equal(kreis.state.dran, null);
  assert.deepEqual(kreis.state.teilnehmende.map((t) => t.name), ["Anton"]);
});

test("Ein zweiter Tab nimmt niemandem den Platz weg", async () => {
  // Der Fehler, den das hier abfängt: Der neue Tab trat bei, danach erst kam
  // der `close` des alten — der Mensch stand als abwesend im Kreis und wurde
  // beim Weiterreichen übersprungen, obwohl er vor dem Bildschirm saß.
  const kreis = new Circle();
  const anton = kreis.beitreten("Anton", 1, "browser-a");
  const eva = kreis.beitreten("Eva", 2, "browser-b");

  const nochmal = kreis.beitreten("Eva", 3, "browser-b"); // zweiter Tab
  assert.equal(nochmal, eva, "der zweite Tab hat einen neuen Platz bekommen");
  kreis.geraetGetrennt(2); // erst jetzt geht die alte Leitung zu

  const evaImKreis = kreis.state.teilnehmende.find((t) => t.id === eva);
  assert.equal(evaImKreis.da, true, "die alte Leitung hat Eva abgemeldet");
  assert.equal(evaImKreis.geraet, 3);
  kreis.gibMikrofonAn(anton);
  assert.equal(kreis.naechster(), eva, "Eva wird beim Weiterreichen übersprungen");
});

test("Zwei Menschen mit demselben Namen bekommen eigene Plätze", () => {
  const kreis = new Circle();
  const ersterAnton = kreis.beitreten("Anton", 1, "browser-a");
  const zweiterAnton = kreis.beitreten("Anton", 2, "browser-b");

  assert.notEqual(zweiterAnton, ersterAnton, "der Zweite hat den Platz des Ersten übernommen");
  assert.deepEqual(kreis.state.teilnehmende.map((t) => t.name), ["Anton", "Anton (2)"]);
  // Und der Dritte bekommt wieder einen eigenen.
  kreis.beitreten("Anton", 3, "browser-c");
  assert.deepEqual(kreis.state.teilnehmende.map((t) => t.name), ["Anton", "Anton (2)", "Anton (3)"]);
});

test("Wer nicht zurückkommt, verlässt nach der Karenzzeit den Kreis", async () => {
  const kreis = new Circle();
  kreis.beitreten("Anton", 1, "browser-a");
  const eva = kreis.beitreten("Eva", 2, "browser-b");

  kreis.geraetGetrennt(2);
  assert.equal(kreis.state.teilnehmende.length, 2, "sofort hinaus ist zu schnell");
  await warte(KARENZ * 3);
  assert.deepEqual(kreis.state.teilnehmende.map((t) => t.name), ["Anton"], "Eva sitzt immer noch im Kreis");
  assert.equal(kreis.beitreten("Eva", 4, "browser-b") !== null, true, "Eva kann wiederkommen");
});

test("Wer rechtzeitig wiederkommt, behält seinen Platz — und die Uhr läuft nicht weiter", async () => {
  const kreis = new Circle();
  const eva = kreis.beitreten("Eva", 2, "browser-b");

  kreis.geraetGetrennt(2);
  await warte(KARENZ / 3);
  assert.equal(kreis.beitreten("Eva", 3, "browser-b"), eva, "Eva hat einen neuen Platz bekommen");

  await warte(KARENZ * 3);
  assert.deepEqual(kreis.state.teilnehmende.map((t) => t.name), ["Eva"], "die alte Karenzzeit hat zugeschlagen");
  assert.equal(kreis.state.teilnehmende[0].da, true);
});

test("Wer dran war und geht, gibt das Mikrofon zurück in die Mitte", async () => {
  const kreis = new Circle();
  const anton = kreis.beitreten("Anton", 1, "browser-a");
  const eva = kreis.beitreten("Eva", 2, "browser-b");
  kreis.gibMikrofonAn(eva);

  kreis.geraetGetrennt(2);
  await warte(KARENZ * 3);
  assert.deepEqual(kreis.state.teilnehmende.map((t) => t.id), [anton]);
  // Nicht von selbst weiterspringen: Wer weitergibt, entscheidet der Kreis.
  assert.equal(kreis.state.dran, null);
});
