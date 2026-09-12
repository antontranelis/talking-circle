// Der Worklet rechnet den Mikrofonton auf 16 kHz um. Hier ohne Browser:
// die Umrechnung ist eine reine Klasse und lässt sich direkt prüfen.
import { test } from "node:test";
import assert from "node:assert/strict";

import { Umrechner } from "../public/pcm-worklet.js";

function sinus(rate, hz, sekunden) {
  const n = Math.round(rate * sekunden);
  return Float32Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * hz * i) / rate));
}

test("48 kHz werden zu 16 kHz, in Blöcken von 2048", () => {
  const bloecke = [];
  const u = new Umrechner(48000);
  // In Stücken von 128 Werten, wie der Browser sie liefert.
  const ton = sinus(48000, 440, 1);
  for (let i = 0; i < ton.length; i += 128) u.fuettern(ton.subarray(i, i + 128), (b) => bloecke.push(b));

  assert.equal(bloecke.length, Math.floor(16000 / 2048));
  assert.ok(bloecke.every((b) => b.length === 2048));

  // Der Ton bleibt ein 440-Hz-Sinus: Nulldurchgänge pro Sekunde ≈ 880.
  const alle = Float32Array.from(bloecke.flatMap((b) => [...b]));
  let wechsel = 0;
  for (let i = 1; i < alle.length; i++) if (alle[i - 1] < 0 !== alle[i] < 0) wechsel++;
  const dauer = alle.length / 16000;
  assert.ok(Math.abs(wechsel / dauer - 880) < 10, `${wechsel / dauer} Wechsel/s`);
});

test("Bei 16 kHz kommt der Ton unverändert durch", () => {
  const u = new Umrechner(16000);
  const ton = sinus(16000, 300, 0.5);
  const raus = [];
  u.fuettern(ton, (b) => raus.push(b));
  assert.equal(raus.length, 3);
  for (let i = 0; i < 2048; i++) assert.ok(Math.abs(raus[0][i] - ton[i]) < 1e-6);
});

test("Der Pegel ist der Effektivwert des Blocks", () => {
  const u = new Umrechner(16000);
  let pegel;
  u.fuettern(new Float32Array(4096).fill(0.5), (_, p) => (pegel ??= p));
  assert.ok(Math.abs(pegel - 0.5) < 1e-6);
});
