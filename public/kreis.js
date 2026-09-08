// Die laufende Runde: links, was gerade gesagt wird — rechts, was schon steht.
import { verbinden, sende, sendeTon, offen } from "./verbindung.js";

const $ = (id) => document.getElementById(id);
let state = null;
let audio = null;
let meineKennung = null;
let dranIndex = -1;
let uhrTimer = null;
let gongGespielt = false; // je Beitrag höchstens ein Gong

// --- Mikrofon ------------------------------------------------------------

async function mikroOeffnen() {
  const geraeteId = localStorage.getItem("redekreis.mikro") || "";
  const spur = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: false, // ein herumgereichtes Mikro braucht keine Echo-Unterdrückung
      noiseSuppression: true,
      autoGainControl: true,
      ...(geraeteId ? { deviceId: { exact: geraeteId } } : {}),
    },
  });
  const ctx = new AudioContext({ sampleRate: 16000 });
  await ctx.audioWorklet.addModule("pcm-worklet.js");
  const knoten = new AudioWorkletNode(ctx, "pcm-worklet");
  knoten.port.onmessage = ({ data }) => {
    pegelZeigen(data.pegel);
    // Immer senden: der Server hält die letzten Sekunden vor, damit der Anfang
    // eines Beitrags auch dann steht, wenn die Taste einen Moment später kommt.
    if (offen()) sendeTon(data.pcm.buffer);
  };
  ctx.createMediaStreamSource(spur).connect(knoten);
  audio = { ctx, spur };
}

// Ein weicher Zweiklang, wenn die Redezeit voll ist — kein Alarm, ein Hinweis.
let klangCtx = null;
function gong() {
  klangCtx ??= new AudioContext();
  // Ohne vorherige Eingabe hält der Browser die Tonausgabe an.
  if (klangCtx.state === "suspended") klangCtx.resume();
  const jetzt = klangCtx.currentTime;
  for (const [i, hz] of [880, 587].entries()) {
    const ton = klangCtx.createOscillator();
    const huelle = klangCtx.createGain();
    ton.type = "sine";
    ton.frequency.value = hz;
    const start = jetzt + i * 0.28;
    huelle.gain.setValueAtTime(0.0001, start);
    huelle.gain.exponentialRampToValueAtTime(0.18, start + 0.02);
    huelle.gain.exponentialRampToValueAtTime(0.0001, start + 1.1);
    ton.connect(huelle).connect(klangCtx.destination);
    ton.start(start);
    ton.stop(start + 1.2);
  }
}

let pegelZiel = 0;
function pegelZeigen(rms) {
  pegelZiel = Math.max(pegelZiel * 0.75, Math.min(1, rms * 6));
  $("pegel").firstElementChild.style.width = `${pegelZiel * 100}%`;
}

// --- Kreislogik ----------------------------------------------------------

const namen = () => state?.teilnehmende ?? [];

function weitergeben() {
  const liste = namen();
  if (!liste.length) return;
  dranIndex = (dranIndex + 1) % liste.length;
  sende({ typ: "start", sprecher: liste[dranIndex] });
}

const anPerson = (i) => {
  dranIndex = i;
  sende({ typ: "start", sprecher: namen()[i] });
};

const beenden = () => sende({ typ: "stop" });

// --- Darstellung ---------------------------------------------------------

function zeichnen() {
  $("kopf-titel").textContent = state.titel;
  $("modell").textContent = state.bereit ? state.modell : "Modell lädt …";
  // Nichts geht verloren: die Datei wird während des Sprechens fortgeschrieben.
  $("datei").textContent = `sichert laufend nach ${state.datei}`;
  zeichneRunde();
  zeichneVerlauf();
  zeichneLive();
}

function zeichneRunde() {
  const gesprochen = new Set(state.beitraege.map((b) => b.sprecher));
  $("runde").replaceChildren(
    ...namen().map((name, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = name;
      if (state.aktiv?.sprecher === name) b.className = "dran";
      else if (gesprochen.has(name)) b.className = "war";
      b.onclick = () => anPerson(i);
      return b;
    }),
  );
}

function zeichneLive() {
  const aktiv = state.aktiv;
  const live = $("live");

  if (!aktiv) {
    $("sprecher").textContent = "Niemand spricht";
    $("sprecher").className = "sprecher still";
    $("uhr").textContent = "";
    $("uhr").className = "uhr";
    document.body.classList.remove("zeit-um");
    gongGespielt = false;
    clearInterval(uhrTimer);
    uhrTimer = null;
    live.replaceChildren(hinweis("Leertaste reicht das Mikrofon weiter."));
    zeichneRunde();
    return;
  }

  if ($("sprecher").textContent !== aktiv.sprecher || !uhrTimer) gongGespielt = false;
  $("sprecher").textContent = aktiv.sprecher;
  $("sprecher").className = "sprecher";
  if (!uhrTimer) uhrTimer = setInterval(uhrStellen, 1000);
  uhrStellen();

  if (!aktiv.committed && !aktiv.tentative) {
    live.replaceChildren(hinweis("… hört zu"));
  } else {
    const offen = document.createElement("span");
    offen.className = "offen";
    offen.textContent = (aktiv.committed && aktiv.tentative ? " " : "") + aktiv.tentative;
    live.replaceChildren(document.createTextNode(aktiv.committed), offen);
  }
  live.scrollTop = live.scrollHeight;
}

const hinweis = (text) =>
  Object.assign(document.createElement("span"), { className: "platzhalter", textContent: text });

function uhrStellen() {
  if (!state.aktiv) return;
  const ms = Date.now() - new Date(state.aktiv.begonnen);
  const s = Math.floor(ms / 1000);
  const uhr = $("uhr");
  uhr.textContent = `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

  const grenze = state.redezeitMs;
  const rest = grenze - ms;
  // Letzte Minute warm, danach deutlich — und einmal ein Gong.
  uhr.className = !grenze ? "uhr" : rest <= 0 ? "uhr ueber" : rest <= 60_000 ? "uhr bald" : "uhr";
  document.body.classList.toggle("zeit-um", Boolean(grenze) && rest <= 0);
  if (grenze && rest <= 0 && !gongGespielt) {
    gongGespielt = true;
    gong();
  }
}

function zeichneVerlauf() {
  const ol = $("beitraege");
  if (!state.beitraege.length) {
    ol.replaceChildren(hinweis("Noch nichts gesagt."));
    return;
  }
  ol.replaceChildren(
    ...state.beitraege.map((b, i) => {
      const li = document.createElement("li");

      const kopf = document.createElement("div");
      kopf.className = "eintrag-kopf";
      const wer = document.createElement("span");
      wer.className = "wer";
      wer.textContent = b.sprecher;
      const wann = document.createElement("span");
      wann.className = "wann";
      wann.textContent = new Date(b.begonnen).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
      const weg = document.createElement("button");
      weg.type = "button";
      weg.className = "weg";
      weg.title = "Beitrag löschen";
      weg.textContent = "×";
      weg.onclick = () => sende({ typ: "loeschen", index: i });
      kopf.append(wer, wann, weg);

      const was = document.createElement("div");
      was.className = "was";
      was.contentEditable = "plaintext-only";
      was.textContent = b.text;
      was.onblur = () => {
        if (was.textContent !== b.text) sende({ typ: "aendern", index: i, text: was.textContent });
      };

      li.append(kopf, was);
      return li;
    }),
  );
  ol.scrollTop = ol.scrollHeight;
}

function melden(text, fehler = false) {
  $("status").textContent = text;
  $("status").classList.toggle("fehler", fehler);
}

// --- Bedienung -----------------------------------------------------------

$("aufnahme").onclick = aufnahmeUebernehmen;
$("weiter").onclick = weitergeben;
$("pause").onclick = beenden;
$("export").onclick = () => {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  window.open(`/export.md?tz=${encodeURIComponent(zone)}`, "_blank");
};
$("neu").onclick = () => {
  if (state.beitraege.length && !confirm(`${state.beitraege.length} Beiträge sind gesichert. Neue Runde beginnen?`)) return;
  dranIndex = -1;
  sende({ typ: "neueRunde" });
};
// Ablenkungsfrei: nur Sprecher, Uhr und Weitergeben. Mitgeschrieben und
// gesichert wird weiter, der Text ist nur nicht zu sehen.
function fokusSetzen(an) {
  document.body.classList.toggle("ohne-text", an);
  $("fokus").textContent = an ? "Mit Text" : "Nur Sprecher";
  localStorage.setItem("redekreis.fokus", an ? "1" : "0");
}
$("fokus").onclick = () => fokusSetzen(!document.body.classList.contains("ohne-text"));
fokusSetzen(localStorage.getItem("redekreis.fokus") === "1");

$("vollbild").onclick = () =>
  document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();

document.addEventListener("keydown", (ev) => {
  if (ev.target.isContentEditable || ["INPUT", "TEXTAREA"].includes(ev.target.tagName)) return;
  if (ev.code === "Space") {
    ev.preventDefault();
    weitergeben();
  } else if (ev.code === "Escape") {
    beenden();
  }
});

const ichNehmeAuf = () => state?.aufnahmeVon !== null && state?.aufnahmeVon === meineKennung;

// Nur ein Gerät liefert den Ton. Wer zusieht, lässt sein Mikrofon zu — sonst
// mischen sich mehrere Aufnahmen in denselben Erkennungsstrom.
async function aufnahmeUebernehmen() {
  sende({ typ: "aufnehmen" });
  if (audio) return;
  try {
    await mikroOeffnen();
    melden("");
  } catch (err) {
    melden(`Kein Zugriff aufs Mikrofon: ${err.message}`, true);
  }
}

function zeichneAufnahme() {
  const knopf = $("aufnahme");
  if (ichNehmeAuf()) {
    knopf.hidden = true;
    $("aufnahme-hinweis").textContent = "dieses Gerät nimmt auf";
    return;
  }
  knopf.hidden = false;
  knopf.textContent = state.aufnahmeVon === null ? "Hier aufnehmen" : "Aufnahme hierher holen";
  $("aufnahme-hinweis").textContent =
    state.aufnahmeVon === null ? "kein Gerät nimmt auf" : "ein anderes Gerät nimmt auf";
}

verbinden(async (m) => {
  if (m.typ === "fehler") return melden(m.text, true);
  if (m.typ === "du") {
    meineKennung = m.kennung;
    return;
  }
  if (m.typ === "live" && state) {
    state.aktiv = m.aktiv;
    return zeichneLive();
  }
  if (m.typ !== "state") return;

  const ersteAntwort = state === null;
  state = m.state;
  // Ohne Kreis gibt es nichts anzuzeigen — dann zuerst einrichten.
  if (ersteAntwort && !state.teilnehmende.length) return location.replace("/einrichtung.html");
  zeichnen();
  zeichneAufnahme();
  // Nimmt noch niemand auf, übernimmt das erste Gerät die Aufnahme.
  if (ersteAntwort && state.aufnahmeVon === null) await aufnahmeUebernehmen();
});
