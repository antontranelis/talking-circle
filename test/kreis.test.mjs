// Der Kreis selbst, ohne Modell und ohne Server: Wer sitzt drin, wer ist da,
// wer bekommt das Mikrofon als Nächstes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Circle } from "../circle.mjs";

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

test("Das Mikrofon wandert der Reihe nach und bleibt bei den Anwesenden", () => {
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

  kreis.verlassen(eva);
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
