// Der Weg, den ein Mensch wirklich geht: Seite öffnen, Namen eintippen,
// beitreten, Leertaste drücken. Zwei Browser-Kontexte sind zwei Geräte.
//
// Braucht einen Chrome auf der Platte; ohne einen wird übersprungen (auf dem
// Bauserver gibt es keinen). Eigener Pfad über CHROME_PFAD.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const WURZEL = path.join(import.meta.dirname, "..");
const PORT = 8700 + Math.floor(Math.random() * 200);
const KARENZ_MS = 3000; // im Test kurz, damit das Gehen nicht 45 s dauert

const CHROME_PFADE = [
  process.env.CHROME_PFAD,
  "/home/fritz/.var/app/com.vscodium.codium/cache/ms-playwright/chromium-1208/chrome-linux64/chrome",
  "/usr/bin/chromium",
  "/usr/bin/google-chrome",
].filter(Boolean);
const CHROME = CHROME_PFADE.find((p) => fs.existsSync(p));

const MIKRO_STUB = () => {
  // Ohne das öffnet der Test das echte Mikrofon des Rechners.
  navigator.mediaDevices.getUserMedia = async () => new AudioContext().createMediaStreamDestination().stream;
  navigator.mediaDevices.enumerateDevices = async () => [
    { deviceId: "test-1", kind: "audioinput", label: "Test-Mikrofon", groupId: "g1", toJSON: () => ({}) },
  ];
};

async function starteServer(t, port) {
  const server = spawn(process.execPath, ["server.mjs"], {
    cwd: WURZEL,
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", TALKING_CIRCLE_KARENZ_MS: String(KARENZ_MS) },
    stdio: ["ignore", "pipe", "inherit"],
  });
  t.after(() => server.kill("SIGKILL"));
  await new Promise((ok, fehler) => {
    const frist = setTimeout(() => fehler(new Error("Modell wurde nicht rechtzeitig bereit")), 120_000);
    server.stdout.on("data", (d) => d.toString().includes("Modell bereit") && (clearTimeout(frist), ok()));
    server.on("exit", (code) => (clearTimeout(frist), fehler(new Error(`Server beendet mit ${code}`))));
  });
}

// Ein Gerät: eigener Browser-Kontext, also eigener Speicher und eigene Leitung.
async function geraet(browser, port) {
  const ctx = await browser.newContext();
  await ctx.addInitScript(MIKRO_STUB);
  const seite = await ctx.newPage();
  await seite.goto(`http://127.0.0.1:${port}/`, { waitUntil: "networkidle" });
  return { ctx, seite };
}

// Genau wie ein Mensch: Name ins Feld, Knopf drücken.
async function trittBei(seite, name) {
  // Sitzt hier schon jemand, ist das Feld eingeklappt.
  if (await seite.isHidden("#beitritt")) await seite.click("#noch-jemand");
  await seite.fill("#beitritt-name", name);
  await seite.click("#beitritt button[type=submit]");
  await seite.waitForFunction((n) => [...document.querySelectorAll("#runde .platz .nm")].some((b) => b.textContent === n), name, {
    timeout: 8000,
  });
}

const dran = (seite) => seite.evaluate(() => document.querySelector("#runde .platz.dran .nm")?.textContent ?? null);
// Der Aufnahmezustand steht nur noch am Punkt unten links: Klasse und Titel.
const aufnahme = (seite) =>
  seite.evaluate(() => ({
    zustand: document.getElementById("aufnahme").classList.contains("hier")
      ? "hier"
      : document.getElementById("aufnahme").classList.contains("fremd")
        ? "fremd"
        : "niemand",
    titel: document.getElementById("aufnahme").title,
  }));
const namen = (seite) => seite.$$eval("#runde .platz .nm", (ns) => ns.map((n) => n.textContent));
// Die Mitte eines Platzes auf dem Ring — dorthin zieht die Maus, dorthin tippt der Finger.
const platzMitte = async (seite, name) => {
  const kasten = await seite.locator("#runde .platz", { hasText: name }).first().boundingBox();
  return { x: kasten.x + kasten.width / 2, y: kasten.y + 24 };
};

// Leertaste auf der Seite selbst, nicht in einem Eingabefeld.
async function leertaste(seite) {
  await seite.click("body", { position: { x: 20, y: 400 } });
  await seite.keyboard.press("Space");
}

test("Die Leertaste reicht das Mikrofon auf das andere Gerät weiter", async (t) => {
  if (!CHROME) return t.skip("kein Chrome gefunden");
  const { chromium } = await import("playwright-core");
  await starteServer(t, PORT);
  const browser = await chromium.launch({ executablePath: CHROME });
  t.after(() => browser.close());

  const a = await geraet(browser, PORT);
  const b = await geraet(browser, PORT);
  await trittBei(a.seite, "Anton");
  await trittBei(b.seite, "Eva");
  await a.seite.waitForFunction(() => document.querySelectorAll("#runde .platz").length === 2);

  await leertaste(a.seite);
  await a.seite.waitForFunction(() => document.querySelector("#runde .platz.dran .nm")?.textContent === "Anton");
  await b.seite.waitForFunction(() => document.querySelector("#runde .platz.dran .nm")?.textContent === "Anton");
  assert.equal((await aufnahme(a.seite)).zustand, "hier");
  assert.match((await aufnahme(b.seite)).titel, /Aufnahme bei Anton/);

  // Und jetzt der Fall, um den es geht: Die Aufnahme muss zu Eva wandern.
  await leertaste(a.seite);
  await b.seite.waitForFunction(() => document.querySelector("#runde .platz.dran .nm")?.textContent === "Eva", null, {
    timeout: 8000,
  });
  assert.equal(await dran(a.seite), "Eva", "das Mikrofon ist auf Gerät A hängen geblieben");
  assert.equal((await aufnahme(b.seite)).zustand, "hier", "die Aufnahme ist nicht mitgewandert");
  assert.match((await aufnahme(a.seite)).titel, /Aufnahme bei Eva/);

  // Und wieder zurück.
  await leertaste(a.seite);
  await a.seite.waitForFunction(() => document.querySelector("#runde .platz.dran .nm")?.textContent === "Anton");
  assert.equal((await aufnahme(a.seite)).zustand, "hier");
});

test("Ein zweiter Tab nimmt niemandem den Platz im Kreis", async (t) => {
  if (!CHROME) return t.skip("kein Chrome gefunden");
  const { chromium } = await import("playwright-core");
  await starteServer(t, PORT + 1);
  const browser = await chromium.launch({ executablePath: CHROME });
  t.after(() => browser.close());

  const a = await geraet(browser, PORT + 1);
  const b = await geraet(browser, PORT + 1);
  await trittBei(a.seite, "Anton");
  await trittBei(b.seite, "Eva");

  // Zweiter Tab am selben Gerät: tritt von selbst wieder als Eva bei. Die alte
  // Leitung geht erst danach zu — genau hier ging Eva vorher verloren.
  const zweiterTab = await b.ctx.newPage();
  await zweiterTab.goto(`http://127.0.0.1:${PORT + 1}/`, { waitUntil: "networkidle" });
  // Das × steht nur an den eigenen Leuten: Der zweite Tab hat Eva als seine erkannt.
  await zweiterTab.waitForFunction(() => document.querySelectorAll("#runde .platz-weg").length === 1);
  await b.seite.close();
  await a.seite.waitForTimeout(800);

  assert.deepEqual(await namen(a.seite), ["Anton", "Eva"], "Eva steht doppelt oder gar nicht im Kreis");
  assert.equal(
    await a.seite.evaluate(() => document.querySelectorAll("#runde .platz.weg").length),
    0,
    "Eva gilt als abwesend, obwohl ihr zweiter Tab offen ist",
  );

  await leertaste(a.seite);
  await leertaste(a.seite);
  await zweiterTab.waitForFunction(() => document.querySelector("#runde .platz.dran .nm")?.textContent === "Eva", null, {
    timeout: 8000,
  });
  assert.equal((await aufnahme(zweiterTab)).zustand, "hier", "die Aufnahme kam nicht beim zweiten Tab an");
});

test("Wer geht, verlässt den Kreis — von Hand sofort, nach einer Trennung mit Karenz", async (t) => {
  if (!CHROME) return t.skip("kein Chrome gefunden");
  const { chromium } = await import("playwright-core");
  await starteServer(t, PORT + 2);
  const browser = await chromium.launch({ executablePath: CHROME });
  t.after(() => browser.close());

  const a = await geraet(browser, PORT + 2);
  const b = await geraet(browser, PORT + 2);
  await trittBei(a.seite, "Anton");
  await trittBei(a.seite, "Timo"); // zwei Menschen an einem Gerät
  await trittBei(b.seite, "Eva");
  await a.seite.waitForFunction(() => document.querySelectorAll("#runde .platz").length === 3);

  // Gerät B geht zu: Eva bleibt zunächst gedimmt stehen …
  await b.ctx.close();
  await a.seite.waitForFunction(() => document.querySelector("#runde .platz.weg") !== null, null, { timeout: 8000 });
  assert.deepEqual(await namen(a.seite), ["Anton", "Timo", "Eva"]);

  // … und ist nach der Karenzzeit aus dem Kreis.
  await a.seite.waitForFunction(() => document.querySelectorAll("#runde .platz").length === 2, null, {
    timeout: 15_000,
  });
  assert.deepEqual(await namen(a.seite), ["Anton", "Timo"], "Eva steht weiter im Kreis");

  // Von Hand geht es sofort — und der Name ist auch nach dem Neuladen weg.
  await a.seite.locator("#runde .platz", { hasText: "Timo" }).first().locator(".platz-weg").click();
  await a.seite.waitForFunction(() => document.querySelectorAll("#runde .platz").length === 1);
  assert.deepEqual(await namen(a.seite), ["Anton"]);
  await a.seite.reload({ waitUntil: "networkidle" });
  await a.seite.waitForTimeout(1200);
  assert.deepEqual(await namen(a.seite), ["Anton"], "Timo ist beim Neuladen wieder aufgetaucht");
});

test("Die Reihenfolge im Kreis lässt sich ziehen — und alle sehen sie", async (t) => {
  if (!CHROME) return t.skip("kein Chrome gefunden");
  const { chromium } = await import("playwright-core");
  await starteServer(t, PORT + 3);
  const browser = await chromium.launch({ executablePath: CHROME });
  t.after(() => browser.close());

  const a = await geraet(browser, PORT + 3);
  const b = await geraet(browser, PORT + 3);
  await trittBei(a.seite, "Anton");
  await trittBei(a.seite, "Timo");
  await trittBei(b.seite, "Eva");
  for (const s of [a.seite, b.seite]) {
    await s.waitForFunction(() => document.querySelectorAll("#runde .platz").length === 3);
  }
  assert.deepEqual(await namen(a.seite), ["Anton", "Timo", "Eva"]);

  // Anton auf Evas Platz ziehen: Maus auf seinen Platz, halten, hinüber. Der
  // Platz, über dem der Zeiger steht, ist das Ziel — Anton übernimmt ihn, die
  // anderen rutschen nach.
  const anton = await platzMitte(a.seite, "Anton");
  const eva = await platzMitte(a.seite, "Eva");
  await a.seite.mouse.move(anton.x, anton.y);
  await a.seite.mouse.down();
  await a.seite.mouse.move(anton.x + 20, anton.y + 20, { steps: 3 });
  await a.seite.mouse.move(eva.x, eva.y, { steps: 8 });
  await a.seite.mouse.up();

  const zuletztAnton = () =>
    [...document.querySelectorAll("#runde .platz .nm")].map((c) => c.textContent)[2] === "Anton";
  for (const seite of [b.seite, a.seite]) await seite.waitForFunction(zuletztAnton, null, { timeout: 8000 });
  assert.deepEqual(await namen(a.seite), ["Timo", "Eva", "Anton"], "das ziehende Gerät zeigt die alte Reihe");
  assert.deepEqual(await namen(b.seite), ["Timo", "Eva", "Anton"], "das andere Gerät hat die neue Reihe nicht bekommen");

  // Und das Weiterreichen folgt der neuen Reihe: nach Timo kommt Eva.
  await leertaste(a.seite);
  await a.seite.waitForFunction(() => document.querySelector("#runde .platz.dran .nm")?.textContent === "Timo");
  await leertaste(a.seite);
  await a.seite.waitForFunction(() => document.querySelector("#runde .platz.dran .nm")?.textContent === "Eva", null, {
    timeout: 8000,
  });

  // Ein Klick ohne Ziehen gibt weiterhin den Redestab weiter (auf den Platz,
  // nicht auf das × daneben).
  const antonJetzt = await platzMitte(a.seite, "Anton");
  await a.seite.mouse.click(antonJetzt.x, antonJetzt.y);
  await a.seite.waitForFunction(() => document.querySelector("#runde .platz.dran .nm")?.textContent === "Anton", null, {
    timeout: 8000,
  });
});

test("Am Telefon zieht der Finger den Chip, statt den Namen zu markieren", async (t) => {
  if (!CHROME) return t.skip("kein Chrome gefunden");
  const { chromium } = await import("playwright-core");
  await starteServer(t, PORT + 4);
  const browser = await chromium.launch({ executablePath: CHROME });
  t.after(() => browser.close());

  // Ein Telefon: Touch statt Maus, schmaler Bildschirm.
  const handy = await browser.newContext({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 390, height: 844 },
  });
  await handy.addInitScript(MIKRO_STUB);
  const telefon = await handy.newPage();
  await telefon.goto(`http://127.0.0.1:${PORT + 4}/`, { waitUntil: "networkidle" });
  const zweites = await geraet(browser, PORT + 4);

  await trittBei(telefon, "Anton");
  await trittBei(telefon, "Timo");
  await trittBei(zweites.seite, "Eva");
  await telefon.waitForFunction(() => document.querySelectorAll("#runde .platz").length === 3);
  assert.deepEqual(await namen(telefon), ["Anton", "Timo", "Eva"]);

  // Echte Berührungen, nicht nachgebaute Ereignisse: nur so verhält sich der
  // Browser wie am Telefon — samt Auswahl beim längeren Drücken.
  const cdp = await handy.newCDPSession(telefon);
  const finger = (type, x, y) =>
    cdp.send("Input.dispatchTouchEvent", {
      type,
      touchPoints: type === "touchEnd" ? [] : [{ x, y, radiusX: 12, radiusY: 12, force: 1, id: 1 }],
    });

  const anton = await platzMitte(telefon, "Anton");
  const timo = await platzMitte(telefon, "Timo");
  await finger("touchStart", anton.x, anton.y);
  await telefon.waitForTimeout(700); // genau das lange Drücken, das vorher markiert hat
  for (const [i, punkt] of [
    { x: anton.x + 14, y: anton.y + 14 },
    { x: (anton.x + timo.x) / 2, y: (anton.y + timo.y) / 2 },
    timo,
    timo,
  ].entries()) {
    await finger("touchMove", punkt.x, punkt.y);
    await telefon.waitForTimeout(60);
  }
  const gezogen = await telefon.evaluate(() => document.querySelectorAll("#runde .platz.zieht").length);
  await finger("touchEnd", 0, 0);

  assert.equal(gezogen, 1, "der Finger hat den Chip nicht angehoben");
  for (const seite of [telefon, zweites.seite]) {
    await seite.waitForFunction(
      () => [...document.querySelectorAll("#runde .platz .nm")].map((b) => b.textContent)[0] === "Timo",
      null,
      { timeout: 8000 },
    );
  }
  assert.deepEqual(await namen(telefon), ["Timo", "Anton", "Eva"]);
  assert.equal(
    await telefon.evaluate(() => window.getSelection().toString()),
    "",
    "das lange Drücken hat Text markiert statt zu ziehen",
  );

  // Und ein kurzes Antippen reicht den Redestab weiter.
  const eva = await platzMitte(telefon, "Eva");
  await finger("touchStart", eva.x, eva.y);
  await finger("touchEnd", 0, 0);
  await telefon.waitForFunction(() => document.querySelector("#runde .platz.dran .nm")?.textContent === "Eva", null, {
    timeout: 8000,
  });
});

test("Die Einstellungen stehen im Sheet — die eigene Seite ist weg", async (t) => {
  if (!CHROME) return t.skip("kein Chrome gefunden");
  const { chromium } = await import("playwright-core");
  await starteServer(t, PORT + 5);
  const browser = await chromium.launch({ executablePath: CHROME });
  t.after(() => browser.close());

  const a = await geraet(browser, PORT + 5);
  await trittBei(a.seite, "Anton");

  // Die alte Seite gibt es nicht mehr.
  const antwort = await a.seite.request.get(`http://127.0.0.1:${PORT + 5}/einrichtung.html`);
  assert.equal(antwort.status(), 404, "die Einrichtungsseite liegt noch da");

  // Mehr → Einstellungen öffnet das Blatt.
  await a.seite.click("#mehr");
  await a.seite.click("#einstellungen-auf");
  await a.seite.waitForSelector("#einstellungen:not([hidden])");

  await a.seite.fill("#einst-titel", "Probelauf am Dienstag");
  await a.seite.click("#einst-redezeit-mehr"); // 5 → 6 Minuten
  await a.seite.click("#einst-latenz button:nth-child(2)"); // 0,5 s
  await a.seite.click("#einst-uebernehmen");
  await a.seite.waitForSelector("#einstellungen", { state: "hidden" });

  await a.seite.waitForFunction(() => document.getElementById("kopf-titel").textContent === "Probelauf am Dienstag");
  const stand = await a.seite.evaluate(() => document.getElementById("uhr-grenze").textContent);
  assert.equal(stand, "06:00", "die Redezeit ist nicht angekommen");

  // Das Gerät entscheidet den Gong für sich allein.
  await a.seite.click("#mehr");
  await a.seite.click("#einstellungen-auf");
  await a.seite.waitForSelector("#einstellungen:not([hidden])");
  assert.equal(await a.seite.getAttribute("#einst-gong", "aria-checked"), "true");
  await a.seite.click("#einst-gong");
  assert.equal(await a.seite.getAttribute("#einst-gong", "aria-checked"), "false");
  assert.equal(await a.seite.evaluate(() => localStorage.getItem("redekreis.gong")), "0");

  // Und die eigenen Namen stehen hier, samt Weg hinaus.
  assert.deepEqual(await a.seite.$$eval("#einst-namen .name span", (n) => n.map((e) => e.textContent)), ["Anton"]);
  await a.seite.click("#einst-namen .name button");
  await a.seite.waitForFunction(() => document.querySelectorAll("#runde .platz").length === 0);
});

test("Nur Sprecher gibt dem Kreis die ganze Fläche — und der Weg zurück steht im Kopf", async (t) => {
  if (!CHROME) return t.skip("kein Chrome gefunden");
  const { chromium } = await import("playwright-core");
  await starteServer(t, PORT + 6);
  const browser = await chromium.launch({ executablePath: CHROME });
  t.after(() => browser.close());

  const a = await geraet(browser, PORT + 6);
  await trittBei(a.seite, "Anton");
  const platzGroesse = () =>
    a.seite.evaluate(() => document.querySelector("#runde .platz .av").getBoundingClientRect().width);
  const vorher = await platzGroesse();
  assert.equal(await a.seite.isVisible(".verlauf"), true);

  await a.seite.click("#mehr");
  await a.seite.click("#fokus");
  await a.seite.waitForSelector(".verlauf", { state: "hidden" });
  assert.ok((await platzGroesse()) > vorher, "die Plätze sind im Fokus nicht gewachsen");
  // Zurück geht es ohne Umweg über das Menü.
  assert.equal(await a.seite.isVisible("#mit-text"), true, "der Weg zurück fehlt im Kopf");

  // Und er hält über das Neuladen.
  await a.seite.reload({ waitUntil: "networkidle" });
  await a.seite.waitForSelector(".verlauf", { state: "hidden" });
  await a.seite.click("#mit-text");
  await a.seite.waitForSelector(".verlauf", { state: "visible" });
  assert.equal(await a.seite.isVisible("#mit-text"), false);
});
