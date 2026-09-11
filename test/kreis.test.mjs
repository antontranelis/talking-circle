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

test("Die Reihenfolge im Kreis lässt sich umstellen", () => {
  const kreis = new Circle();
  const anton = kreis.beitreten("Anton", 1, "a");
  const eva = kreis.beitreten("Eva", 2, "b");
  const timo = kreis.beitreten("Timo", 3, "c");
  kreis.gibMikrofonAn(eva);

  assert.equal(kreis.sortiere([timo, anton, eva]), true);
  assert.deepEqual(kreis.state.teilnehmende.map((t) => t.name), ["Timo", "Anton", "Eva"]);
  assert.equal(kreis.state.dran, eva, "das Mikrofon ist beim Sortieren weitergerutscht");
  assert.equal(kreis.naechster(), timo, "nach Eva kommt jetzt wieder Timo");
});

test("Eine Reihenfolge, die nicht zum Kreis passt, wird verworfen", () => {
  const kreis = new Circle();
  const anton = kreis.beitreten("Anton", 1, "a");
  const eva = kreis.beitreten("Eva", 2, "b");
  const urspruenglich = kreis.state.teilnehmende.map((t) => t.id);

  for (const [was, liste] of [
    ["jemand fehlt", [eva]],
    ["ein Fremder ist dabei", [anton, eva, "t99"]],
    ["einer steht doppelt", [anton, anton]],
    ["gar keine Liste", null],
  ]) {
    assert.equal(kreis.sortiere(liste), false, `${was}: die Liste wurde angenommen`);
    assert.deepEqual(kreis.state.teilnehmende.map((t) => t.id), urspruenglich, `${was}: der Kreis hat sich geändert`);
  }
});

// --- Anhalten und Fortsetzen ---------------------------------------------
//
// Der Halt ist kein Ende: Der Beitrag bleibt offen, nur Aufnahme und Uhr
// stehen still. Ohne Modell läuft kein Erkennungsstrom — geprüft wird der
// Kreis, nicht die Erkennung.

const laut = () => Float32Array.from({ length: 160 }, () => 0.4);

test("Anhalten lässt den Beitrag stehen und fortsetzen macht im selben weiter", async () => {
  const kreis = new Circle();
  const anton = kreis.beitreten("Anton", 1);
  kreis.gibMikrofonAn(anton);
  await kreis.beitragStarten("Anton");

  assert.equal(kreis.state.angehalten, false, "eine Runde beginnt nicht im Halt");
  assert.equal(kreis.anhalten(), true);
  assert.equal(kreis.state.angehalten, true);
  assert.ok(kreis.state.aktiv, "der Beitrag wurde beendet statt angehalten");
  assert.equal(kreis.state.beitraege.length, 0, "der Halt hat einen Beitrag abgelegt");
  assert.equal(kreis.anhalten(), false, "zweimal anhalten ist kein zweiter Halt");

  const begonnen = kreis.state.aktiv.begonnen;
  await warte(60);
  assert.equal(kreis.fortsetzen(), true);
  assert.equal(kreis.state.angehalten, false);
  assert.equal(kreis.state.aktiv.begonnen, begonnen, "es wurde ein neuer Beitrag begonnen");
  assert.ok(kreis.state.aktiv.pauseMs >= 50, `die Pausenzeit wurde nicht gemerkt: ${kreis.state.aktiv.pauseMs}`);
  assert.equal(kreis.fortsetzen(), false, "fortsetzen ohne Halt tut etwas");
});

test("Im Halt steht die Uhr — die Pause zählt nicht zur Redezeit", async () => {
  const kreis = new Circle();
  await kreis.beitragStarten("Anton");

  await warte(40);
  kreis.anhalten();
  const stand = kreis.verstricheneMs();
  await warte(80);
  assert.equal(kreis.verstricheneMs(), stand, "die Uhr ist im Halt weitergelaufen");

  kreis.fortsetzen();
  await warte(30);
  assert.ok(kreis.verstricheneMs() >= stand, "die Uhr läuft nach dem Fortsetzen nicht weiter");
  assert.ok(
    kreis.verstricheneMs() < Date.now() - new Date(kreis.state.aktiv.begonnen) - 50,
    "die Pausenzeit steckt weiter in der Redezeit",
  );
});

test("Im Halt wird der Ton verworfen", async () => {
  const kreis = new Circle();
  await kreis.beitragStarten("Anton");

  kreis.fuettern(laut());
  assert.ok(kreis.pegelJetzt > 0.2, "der Pegel kommt im Lauf nicht an");

  kreis.anhalten();
  assert.equal(kreis.pegelJetzt, 0, "der Pegel bleibt im Halt stehen");
  kreis.fuettern(laut());
  assert.equal(kreis.pegelJetzt, 0, "im Halt ist Ton angekommen");

  kreis.fortsetzen();
  kreis.fuettern(laut());
  assert.ok(kreis.pegelJetzt > 0.2, "nach dem Fortsetzen kommt kein Ton mehr an");
});

test("Weitergeben und Beenden heben den Halt auf", async () => {
  const kreis = new Circle();
  await kreis.beitragStarten("Anton");
  kreis.anhalten();

  await kreis.beitragStarten("Eva");
  assert.equal(kreis.state.angehalten, false, "der neue Beitrag beginnt im Halt");
  assert.equal(kreis.state.aktiv.sprecher, "Eva");
  assert.equal(kreis.state.aktiv.pauseMs, 0, "die Pausenzeit des Vorgängers hängt am neuen Beitrag");

  kreis.anhalten();
  await kreis.beitragBeenden();
  assert.equal(kreis.state.angehalten, false, "nach dem Beenden steht der Kreis im Halt");
  assert.equal(kreis.state.aktiv, null);
});
