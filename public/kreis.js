// Die laufende Runde: der Kreis mit den Plätzen, darunter die Steuerung —
// und daneben der Verlauf, in dem der laufende Beitrag schon mitwächst.
import { verbinden, sende, sendeTon, offen } from "./verbindung.js";

const $ = (id) => document.getElementById(id);
let state = null;
let audio = null;
let meineKennung = null;
let uhrTimer = null;
let gongFuer = null; // für welchen Beitrag der Gong schon lief

// Wer an diesem Gerät sitzt. Die Namen bleiben im Browser, damit nach einem
// Neuladen niemand von Hand wieder beitreten muss.
const SPEICHER = "redekreis.meine";
const meineIds = new Set();
let meineNamen = [];
try {
  meineNamen = JSON.parse(localStorage.getItem(SPEICHER) ?? "[]").filter((n) => typeof n === "string");
} catch {
  meineNamen = [];
}

// Die Platzkarte dieses Browsers. Der Server erkennt daran, dass ein zweiter
// Tab oder eine neue Leitung derselbe Mensch ist — und nicht ein zweiter mit
// gleichem Namen, dem ein eigener Platz zusteht.
const schluessel = (() => {
  let wert = null;
  try {
    wert = localStorage.getItem("redekreis.geraet");
    if (!wert) {
      wert = crypto.randomUUID();
      localStorage.setItem("redekreis.geraet", wert);
    }
  } catch {
    wert ??= crypto.randomUUID(); // privates Fenster: gilt für diese Sitzung
  }
  return wert;
})();

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
    // Gesendet wird nur vom Gerät dessen, der dran ist. Dann aber durchgehend:
    // Der Server hält die letzten Sekunden vor, damit der Anfang eines Beitrags
    // auch dann steht, wenn die Übergabe einen Moment später kommt. Wie laut es
    // ist, sagt der Server allen zurück — daran atmet der Platz des Sprechers.
    if (offen() && ichNehmeAuf()) sendeTon(data.pcm.buffer);
  };
  ctx.createMediaStreamSource(spur).connect(knoten);
  audio = { ctx, spur };
}

// Das Mikrofon gehört dem Gerät, das gerade aufnimmt. Wandert die Aufnahme
// weiter, wird es hier geschlossen — sonst hört ein fremder Raum weiter mit.
function mikroSchliessen() {
  if (!audio) return;
  audio.spur.getTracks().forEach((t) => t.stop());
  audio.ctx.close();
  audio = null;
}

let mikroLaeuft = false; // ein Aufbau zur Zeit, sonst öffnen sich zwei Ströme
// Die Freigabe wird beim Beitritt geholt, nicht erst beim Drankommen: Der
// Browser fragt danach genau einmal, und zwar auf einen Tastendruck hin — so
// ist die Übergabe später sofort da, statt mitten im Satz nach Erlaubnis zu
// fragen. Der Strom bleibt offen, gesendet wird trotzdem nur, wer dran ist.
async function mikroFreigeben() {
  if (audio || mikroLaeuft) return;
  mikroLaeuft = true;
  try {
    await mikroOeffnen();
    melden("");
  } catch (err) {
    melden(`Ohne Mikrofon-Freigabe kann dieses Gerät nicht aufnehmen: ${err.message}`, true);
  } finally {
    mikroLaeuft = false;
  }
}

// Ein Gerät, an dem niemand sitzt, soll auch kein Mikrofon offen halten —
// außer es hat die Aufnahme von Hand übernommen.
async function mikroPruefen() {
  if (meineIds.size || ichNehmeAuf()) return mikroFreigeben();
  mikroSchliessen();
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

// --- Kreislogik ----------------------------------------------------------

const kreis = () => state?.teilnehmende ?? [];

// Wer als Nächstes dran ist, bestimmt der Server: Er kennt alle Geräte und
// überspringt, wer gerade nicht da ist.
const weitergeben = () => sende({ typ: "weiter" });
const anPerson = (id) => sende({ typ: "dran", id });
const beenden = () => sende({ typ: "stop" });
// Anhalten ist kein Beenden: Der Beitrag bleibt offen, nur Aufnahme und Uhr
// stehen still.
const anhalten = () => sende({ typ: state?.angehalten ? "fortsetzen" : "pause" });

// --- Beitreten -----------------------------------------------------------

function beitreten(name) {
  const sauber = name.trim().slice(0, 60);
  if (!sauber) return;
  sende({ typ: "beitreten", name: sauber, schluessel });
}

function beigetreten({ id, name }) {
  meineIds.add(id);
  namenMerken(meineNamen.includes(name) ? meineNamen : [...meineNamen, name]);
  zeichneBeitritt();
  // Sitzt sonst niemand am Ton, übernimmt dieses Gerät die Aufnahme. So geht
  // der Anfang des ersten Beitrags nicht verloren.
  if (state?.aufnahmeVon === null) sende({ typ: "aufnehmen" });
}

function namenMerken(liste) {
  meineNamen = liste;
  try {
    localStorage.setItem(SPEICHER, JSON.stringify(meineNamen));
  } catch {}
}

// Kreis verlassen: Der Platz wird freigegeben und der Name vergessen — sonst
// säße man nach dem nächsten Neuladen wieder drin.
function verlassen(id) {
  const wer = kreis().find((t) => t.id === id);
  meineIds.delete(id);
  if (wer) namenMerken(meineNamen.filter((n) => n !== wer.name));
  sende({ typ: "verlassen", id });
  zeichneBeitritt();
}

// Solange von diesem Gerät niemand im Kreis sitzt, steht das Namensfeld offen;
// danach reicht ein leiser Knopf für den Nächsten, der sich dazusetzt. Beides
// gleichzeitig gibt es nie.
function zeichneBeitritt(feldOffen = meineIds.size === 0) {
  $("beitritt").hidden = !feldOffen;
  $("noch-jemand").hidden = feldOffen || meineIds.size === 0;
  $("beitritt-ab").hidden = meineIds.size === 0;
}

// --- Darstellung ---------------------------------------------------------

function zeichnen() {
  $("kopf-titel").textContent = state.titel;
  document.title = `${state.titel} · Redekreis`;
  zeichneRing();
  zeichneVerlauf();
  zeichneSteuerung();
  uhrStellen();
}

// --- Der Ring -------------------------------------------------------------
//
// Leere Mitte, Plätze auf der Bahn, dahinter der Schweif des Sprechers. Die
// Maße richten sich nach dem Platz, den die Kreisspalte übrig lässt.

const platzNodes = new Map(); // id → Element, damit das Ziehen nicht neu baut
let masse = null; // die zuletzt gerechnete Ringgeometrie

function ringMasse() {
  const spalte = document.querySelector(".kreisspalte");
  const steuerung = document.querySelector(".steuerung");
  const breite = spalte.clientWidth;
  const hoehe = spalte.clientHeight - steuerung.offsetHeight - 18;
  const n = Math.max(kreis().length, 1);
  const S = Math.max(200, Math.min(breite, hoehe, 620));
  // Der Platz darf nicht größer werden, als der Abstand auf der Bahn zulässt.
  // Am Telefon darf der Platz nicht unter Fingergröße fallen, am Beamer nicht
  // ins Riesige wachsen. Ohne Text ist der Kreis das einzige Bild im Raum —
  // dann dürfen die Plätze größer werden.
  const fokus = document.body.classList.contains("ohne-text");
  const grob = Math.max(44, Math.min(fokus ? 96 : 72, S * (fokus ? 0.19 : 0.15)));
  const abstand = (2 * Math.PI * ((S - grob - 26) / 2)) / n;
  const av = Math.max(30, Math.min(grob, abstand * 0.72));
  return { S, av, R: (S - av - 26) / 2, n, abstand };
}

function zeichneRing() {
  if (ziehtGerade) return; // mitten im Ziehen würde ein Neuaufbau den Griff abreißen
  const ring = $("runde");
  const leute = kreis();
  masse = ringMasse();
  const { S, av } = masse;
  ring.style.width = `${S}px`;
  ring.style.height = `${S}px`;

  const gesprochen = new Set(state.beitraege.map((b) => b.sprecher));
  platzNodes.clear();
  const stuecke = [bahn(masse), schweif(masse), marke(masse)];

  for (const t of leute) {
    const platz = document.createElement("div");
    platz.className = "platz";
    platz.dataset.id = t.id;
    if (state.dran === t.id) platz.classList.add("dran");
    else if (gesprochen.has(t.name)) platz.classList.add("war");
    if (!t.da) platz.classList.add("weg");
    if (meineIds.has(t.id)) platz.classList.add("ich");
    platz.style.width = `${Math.round(Math.min(masse.abstand * 0.95, av * 1.8))}px`;
    platz.title = t.da ? "Den Redestab hierher geben" : `${t.name} ist gerade nicht verbunden`;

    const av_ = document.createElement("span");
    av_.className = "av";
    av_.style.width = av_.style.height = `${Math.round(av)}px`;
    av_.style.fontSize = `${Math.round(av * 0.34)}px`;
    av_.textContent = [...t.name][0] ?? "?";
    if (meineIds.has(t.id)) {
      const punkt = Object.assign(document.createElement("i"), { className: "punkt" });
      // Auf die Kante des Kreises, nicht in die Ecke seines Kastens: sonst
      // schwebt der Punkt bei großen Plätzen frei daneben.
      punkt.style.top = punkt.style.right = `${Math.round(av * 0.146 - 4.5)}px`;
      av_.append(punkt);
    }

    const nm = document.createElement("span");
    nm.className = "nm";
    nm.style.fontSize = `${Math.max(11, Math.min(19, Math.round(av * 0.24)))}px`;
    nm.textContent = t.name;

    platz.append(av_, nm);
    if (!t.da) platz.append(Object.assign(document.createElement("span"), { className: "weg-hinweis", textContent: "nicht da" }));

    // Nur für die eigenen Leute: Wer hier sitzt, kann auch wieder aufstehen.
    if (meineIds.has(t.id)) {
      const weg = document.createElement("button");
      weg.type = "button";
      weg.className = "platz-weg";
      weg.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
      weg.title = `${t.name} verlässt den Kreis`;
      weg.onclick = (e) => (e.stopPropagation(), verlassen(t.id));
      platz.append(weg);
    }
    platz.addEventListener("pointerdown", ziehenBeginnen);
    // Langes Drücken öffnet in Android Chrome sonst das Auswahlmenü.
    platz.addEventListener("contextmenu", (e) => e.preventDefault());
    platzNodes.set(t.id, platz);
    stuecke.push(platz);
  }

  ring.replaceChildren(...stuecke);
  stelleAuf(leute.map((t) => t.id));
  pulsSetzen();
}

// Die Bahn selbst: ein Pixel, zwölf Prozent — mehr braucht der Kreis nicht.
function bahn({ S, R }) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "ring-bahn");
  svg.setAttribute("viewBox", `0 0 ${S} ${S}`);
  svg.setAttribute("aria-hidden", "true");
  const c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  c.setAttribute("cx", S / 2);
  c.setAttribute("cy", S / 2);
  c.setAttribute("r", R.toFixed(1));
  c.setAttribute("fill", "none");
  c.setAttribute("stroke", "#f2ece6");
  c.setAttribute("stroke-opacity", "0.12");
  c.setAttribute("stroke-width", "1");
  svg.append(c);
  return svg;
}

// Der Schweif: ein Komet hinter dem, der dran ist. Ein einziger Farbverlauf auf
// der Kreisbahn — als conic-gradient ab dem Winkel des Sprecherplatzes, auf die
// Bahn maskiert. Keine Segmente: so gibt es keine Kappen und keine Perlen.
function schweif({ S, R, av, n }) {
  const div = document.createElement("div");
  div.className = "schweif";
  div.setAttribute("aria-hidden", "true");
  div.style.width = div.style.height = `${S}px`;
  const wer = kreis().findIndex((t) => t.id === state.dran);
  if (wer < 0) return div; // niemand dran: keine Spur

  const halt = Boolean(state.angehalten);
  const dick = Math.max(4, av * 0.08);
  const stufen = [];
  for (let i = 0; i <= 16; i++) {
    const u = i / 16;
    // Quadratisch von null auf voll über 344 Grad — vorn der Sprecher, hinten
    // läuft die Spur aus.
    stufen.push(`rgba(229, 160, 92, ${(u * u * (halt ? 0.42 : 1)).toFixed(3)}) ${(16 + u * 344).toFixed(1)}deg`);
  }
  const innen = R - dick / 2;
  const aussen = R + dick / 2;
  const maske =
    `radial-gradient(circle at 50% 50%, transparent ${(innen - 0.5).toFixed(1)}px, #000 ${(innen + 0.5).toFixed(1)}px, ` +
    `#000 ${(aussen - 0.5).toFixed(1)}px, transparent ${(aussen + 0.5).toFixed(1)}px)`;
  div.style.background =
    `conic-gradient(from ${((360 / n) * wer).toFixed(1)}deg at 50% 50%, ` +
    `rgba(229, 160, 92, 0) 0deg, rgba(229, 160, 92, 0) 16deg, ${stufen.join(", ")})`;
  div.style.webkitMask = maske;
  div.style.mask = maske;
  return div;
}

// Die kleine Spitze unten an der Bahn zeigt, wohin der Redestab wandert.
function marke({ S, R }) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "marke");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "12");
  svg.setAttribute("viewBox", "0 0 16 12");
  svg.setAttribute("aria-hidden", "true");
  svg.style.left = `${(S / 2 - 8).toFixed(1)}px`;
  svg.style.top = `${(S / 2 + R - 6).toFixed(1)}px`;
  const pfad = document.createElementNS("http://www.w3.org/2000/svg", "path");
  pfad.setAttribute("d", "M11 1 L4 6 L11 11 Z");
  pfad.setAttribute("fill", "#e5a05c");
  svg.append(pfad);
  return svg;
}

// Setzt die Plätze einer Reihenfolge auf die Bahn. Beim Ziehen ist das eine
// vorläufige Reihe — der gezogene Platz hängt am Zeiger, seine Lücke steht auf
// der Bahn.
function stelleAuf(ordnung, gezogen = null, zeiger = null) {
  if (!masse) return;
  const { S, R } = masse;
  const c = S / 2;
  const n = Math.max(ordnung.length, 1);
  ordnung.forEach((id, i) => {
    const platz = platzNodes.get(id);
    if (!platz) return;
    const a = ((360 / n) * i * Math.PI) / 180;
    const x = c + R * Math.sin(a);
    const y = c - R * Math.cos(a);
    if (id === gezogen) {
      const kasten = $("runde").getBoundingClientRect();
      platz.style.left = `${zeiger.x - kasten.left}px`;
      platz.style.top = `${zeiger.y - kasten.top}px`;
      luecke(x, y);
      return;
    }
    platz.style.left = `${x.toFixed(1)}px`;
    platz.style.top = `${y.toFixed(1)}px`;
  });
}

// Die gestrichelte Lücke zeigt, wo der gezogene Platz landet.
let lueckeNode = null;
function luecke(x, y) {
  if (!lueckeNode) {
    lueckeNode = document.createElement("div");
    lueckeNode.className = "luecke";
    $("runde").append(lueckeNode);
  }
  const gr = Math.round(masse.av);
  lueckeNode.style.width = lueckeNode.style.height = `${gr}px`;
  lueckeNode.style.left = `${x.toFixed(1)}px`;
  lueckeNode.style.top = `${(y - gr * 0.2).toFixed(1)}px`;
}

// --- Reihenfolge ziehen ---------------------------------------------------
//
// Mit Zeigern statt HTML5-Ziehen: Telefone kennen `dragstart` nicht, und sie
// sind der Hauptfall. Erst ab einer Schwelle gilt es als Ziehen — darunter
// bleibt es ein Antippen, das den Redestab weitergibt.
const ZIEH_SCHWELLE = 6; // px
let ziehtGerade = false;

// Welcher Platz auf der Bahn liegt dem Zeiger am nächsten? Der Winkel
// entscheidet, nicht die Entfernung: So lässt sich auch weit außen ziehen.
function slotBei(x, y, n) {
  const kasten = $("runde").getBoundingClientRect();
  const cx = kasten.left + kasten.width / 2;
  const cy = kasten.top + kasten.height / 2;
  let grad = (Math.atan2(x - cx, -(y - cy)) * 180) / Math.PI;
  if (grad < 0) grad += 360;
  return Math.min(n - 1, Math.round(grad / (360 / n)) % n);
}

function ziehenBeginnen(ev) {
  if (ev.target.closest(".platz-weg")) return; // das × ist kein Griff
  if (ev.pointerType === "mouse" && ev.button !== 0) return;
  const platz = ev.currentTarget;
  const id = platz.dataset.id;
  const start = { x: ev.clientX, y: ev.clientY };
  const reihe = kreis().map((t) => t.id);
  let ordnung = null;

  // Am Finger fängt der Browser sonst beim längeren Drücken an, Text zu
  // markieren oder sein eigenes Menü zu öffnen — und nimmt die Geste mit
  // einem `pointercancel` an sich. Danach ließe sich nichts mehr ziehen.
  if (ev.pointerType !== "mouse") ev.preventDefault();

  const bewegen = (e) => {
    if (!ziehtGerade) {
      if (Math.hypot(e.clientX - start.x, e.clientY - start.y) < ZIEH_SCHWELLE) return;
      ziehtGerade = true;
      // Erst jetzt den Zeiger einfangen, nicht schon beim Aufsetzen: sonst
      // ginge auch das einfache Antippen durch die Ziehgeste verloren.
      try {
        platz.setPointerCapture(e.pointerId);
      } catch {
        // Kennt der Browser den Zeiger nicht mehr, reichen die Listener am
        // Dokument — das Ziehen läuft weiter.
      }
      platz.classList.add("zieht");
    }
    const andere = reihe.filter((x) => x !== id);
    andere.splice(slotBei(e.clientX, e.clientY, reihe.length), 0, id);
    ordnung = andere;
    stelleAuf(ordnung, id, { x: e.clientX, y: e.clientY });
  };

  const aufraeumen = () => {
    document.removeEventListener("pointermove", bewegen);
    document.removeEventListener("pointerup", loslassen);
    document.removeEventListener("pointercancel", abbrechen);
    platz.classList.remove("zieht");
    lueckeNode?.remove();
    lueckeNode = null;
    const gezogen = ziehtGerade;
    ziehtGerade = false;
    return gezogen;
  };

  // Nimmt der Browser die Geste doch an sich, bleibt die Reihe, wie sie war —
  // hängen bleiben darf der Zug auf keinen Fall.
  const abbrechen = () => {
    if (aufraeumen()) zeichneRing();
  };

  const loslassen = () => {
    const neu = ordnung;
    const gezogen = aufraeumen();
    // Kurzes Antippen ohne Bewegung gibt den Redestab weiter. Das passiert
    // hier und nicht im Klick: Am Finger schluckt das `preventDefault` von
    // oben den Klick, der sonst darauf folgen würde.
    if (!gezogen) return anPerson(id);
    if (neu && neu.join() !== reihe.join()) sende({ typ: "reihenfolge", ids: neu });
    else zeichneRing();
  };

  // Am Dokument, nicht am Platz: Vor dem Einfangen wandert der Zeiger sonst aus
  // dem Platz heraus und das Ziehen bliebe stecken.
  document.addEventListener("pointermove", bewegen);
  document.addEventListener("pointerup", loslassen);
  document.addEventListener("pointercancel", abbrechen);
}

// --- Steuerung und Uhr ----------------------------------------------------

function zeichneSteuerung() {
  const laeuft = Boolean(state.aktiv);
  const halt = Boolean(state.angehalten);
  $("beenden").disabled = !laeuft;
  $("pause").disabled = !laeuft;
  $("pause").classList.toggle("halt", halt);
  $("pause").title = halt ? "Fortsetzen — Aufnahme und Uhr laufen weiter" : "Pause — Aufnahme und Uhr anhalten";
  $("pause").setAttribute("aria-label", halt ? "Fortsetzen" : "Pause");
  // SVG-Elemente kennen die `hidden`-Eigenschaft nicht — nur das Attribut.
  $("ikon-pause").toggleAttribute("hidden", halt);
  $("ikon-play").toggleAttribute("hidden", !halt);
}

// Was von der Redezeit verstrichen ist — ohne das, was im Halt verging.
function verstrichen() {
  const aktiv = state?.aktiv;
  if (!aktiv) return 0;
  const bis = aktiv.haltSeit ? new Date(aktiv.haltSeit).getTime() : Date.now();
  return Math.max(0, bis - new Date(aktiv.begonnen).getTime() - (aktiv.pauseMs ?? 0));
}

const mmss = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

function uhrStellen() {
  if (!state) return;
  const strahl = $("zeitstrahl");
  const grenze = state.redezeitMs;

  if (!state.aktiv) {
    clearInterval(uhrTimer);
    uhrTimer = null;
    gongFuer = null;
    $("uhr").textContent = "00:00";
    $("uhr-grenze").textContent = grenze ? mmss(grenze) : "";
    $("balken").style.width = "0%";
    strahl.className = "zeitstrahl";
    document.body.classList.remove("zeit-um");
    return;
  }

  if (!uhrTimer) uhrTimer = setInterval(uhrStellen, 1000);
  const aktiv = state.aktiv;
  const ms = verstrichen();
  const rest = grenze - ms;
  $("uhr").textContent = mmss(ms);
  $("uhr-grenze").textContent = !grenze ? "" : rest <= 0 ? `+${mmss(-rest)}` : mmss(grenze);
  $("balken").style.width = `${grenze ? Math.min(100, (ms / grenze) * 100) : 0}%`;

  // Letzte Minute warm, danach deutlich — und einmal ein Gong.
  strahl.className = state.angehalten
    ? "zeitstrahl halt"
    : !grenze
      ? "zeitstrahl"
      : rest <= 0
        ? "zeitstrahl ueber"
        : rest <= 60_000
          ? "zeitstrahl bald"
          : "zeitstrahl";
  document.body.classList.toggle("zeit-um", Boolean(grenze) && rest <= 0);
  if (grenze && rest <= 0 && gongFuer !== aktiv.begonnen && !state.angehalten) {
    gongFuer = aktiv.begonnen;
    // Es gongt das Gerät, das den Ton liefert — dort steht das Mikrofon im
    // Raum. Wer das nicht will, schaltet es in den Einstellungen ab.
    if (gongErlaubt() && ichNehmeAuf()) gong();
  }
}

// --- Der Platz des Sprechers atmet mit dem Pegel --------------------------

let pegelZiel = 0;

// Der Pegel kommt vom Server, also von dem Gerät, das gerade aufnimmt — so
// atmet der Platz auf allen Geräten im Kreis gleich.
function pegelGemeldet(rms) {
  pegelZiel = !state?.aktiv || state.angehalten ? 0 : Math.max(pegelZiel * 0.55, Math.min(1, rms * 7));
  pulsSetzen();
}

function pulsSetzen() {
  const platz = state?.dran ? platzNodes.get(state.dran) : null;
  const av = platz?.querySelector(".av");
  if (!av) return;
  const stufe = state?.angehalten ? 0 : pegelZiel;
  av.style.transform = `scale(${(1 + stufe * 0.09).toFixed(3)})`;
  av.style.boxShadow =
    `0 0 0 ${(6 + stufe * 6).toFixed(1)}px rgba(229, 160, 92, ${(0.1 + stufe * 0.03).toFixed(3)}), ` +
    `0 0 ${(20 + stufe * 16).toFixed(0)}px rgba(229, 160, 92, ${(0.2 + stufe * 0.14).toFixed(3)})`;
}

// --- Verlauf --------------------------------------------------------------

let karteNode = null; // die Karte des laufenden Beitrags

function zeichneVerlauf() {
  const ol = $("beitraege");
  karteNode = null;
  const stuecke = state.beitraege.map((b, i) => eintrag(b, i));
  if (state.aktiv) stuecke.push((karteNode = laufendeKarte(state.aktiv)));
  $("anzahl").textContent = state.beitraege.length === 1 ? "1 Beitrag" : `${state.beitraege.length} Beiträge`;
  if (!stuecke.length) {
    ol.replaceChildren(
      hinweis(
        kreis().length
          ? "Noch nichts gesagt — die Leertaste gibt den Redestab weiter."
          : "Noch ist niemand im Kreis — trag oben deinen Namen ein.",
      ),
    );
    return;
  }
  ol.replaceChildren(...stuecke);
  ol.scrollTop = ol.scrollHeight;
}

function kopfzeile(name, zeit) {
  const kopf = document.createElement("div");
  kopf.className = "eintrag-kopf";
  const wer = document.createElement("span");
  wer.className = "wer";
  wer.textContent = name;
  const wann = document.createElement("span");
  wann.className = "wann";
  wann.textContent = new Date(zeit).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
  kopf.append(wer, wann);
  return kopf;
}

function eintrag(b, i) {
  const li = document.createElement("li");
  const kopf = kopfzeile(b.sprecher, b.begonnen);

  const weg = document.createElement("button");
  weg.type = "button";
  weg.className = "weg";
  weg.title = "Beitrag löschen";
  weg.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  weg.onclick = () => sende({ typ: "loeschen", index: i });
  kopf.append(weg);

  const was = document.createElement("p");
  was.className = "was";
  was.contentEditable = "plaintext-only";
  was.textContent = b.text;
  was.onblur = () => {
    if (was.textContent !== b.text) sende({ typ: "aendern", index: i, text: was.textContent });
  };

  li.append(kopf, was);
  return li;
}

// Der laufende Beitrag steht in einer gefassten Karte — innen formatiert wie
// jeder andere Eintrag. Im Halt verliert der Rahmen sein Bernstein.
function laufendeKarte(aktiv) {
  const li = document.createElement("li");
  li.className = "laufend";
  li.dataset.begonnen = aktiv.begonnen;
  li.append(kopfzeile(aktiv.sprecher, aktiv.begonnen));
  karteFuellen(li, aktiv);
  return li;
}

function karteFuellen(li, aktiv) {
  li.classList.toggle("im-halt", Boolean(state.angehalten));
  const alt = li.querySelector(".was, .tippt");
  // Solange nichts gesagt ist: drei Punkte, sonst nichts.
  if (!aktiv.committed && !aktiv.tentative) {
    if (alt?.classList.contains("tippt")) return;
    const punkte = document.createElement("span");
    punkte.className = "tippt";
    punkte.setAttribute("aria-label", `${aktiv.sprecher} ist dran und sagt noch nichts`);
    punkte.innerHTML = "<i></i><i></i><i></i>";
    alt ? alt.replaceWith(punkte) : li.append(punkte);
    return;
  }
  const was = alt?.classList.contains("was") ? alt : document.createElement("p");
  was.className = "was";
  const offenerText = document.createElement("span");
  offenerText.className = "offen";
  offenerText.textContent = (aktiv.committed && aktiv.tentative ? " " : "") + aktiv.tentative;
  was.replaceChildren(document.createTextNode(aktiv.committed), offenerText);
  if (was !== alt) (alt ? alt.replaceWith(was) : li.append(was));
}

function zeichneLive() {
  const aktiv = state.aktiv;
  if (!aktiv || !karteNode || karteNode.dataset.begonnen !== aktiv.begonnen) {
    zeichneVerlauf();
  } else {
    karteFuellen(karteNode, aktiv);
    const ol = $("beitraege");
    ol.scrollTop = ol.scrollHeight;
  }
  uhrStellen();
}

const hinweis = (text) =>
  Object.assign(document.createElement("li"), { className: "platzhalter", textContent: text });

function melden(text, fehler = false) {
  $("status").textContent = text;
  $("status").classList.toggle("fehler", fehler);
}

// --- Aufnahme: ein Punkt, drei Zustände -----------------------------------

const ichNehmeAuf = () => state?.aufnahmeVon !== null && state?.aufnahmeVon === meineKennung;

function zeichneAufnahme() {
  const knopf = $("aufnahme");
  const dort = kreis().filter((t) => t.da && t.geraet === state.aufnahmeVon).map((t) => t.name);
  const titel = ichNehmeAuf()
    ? "Dieses Gerät nimmt auf"
    : state.aufnahmeVon === null
      ? "Hier aufnehmen"
      : dort.length
        ? `Aufnahme bei ${dort.join(", ")} — antippen holt sie her`
        : "Ein anderes Gerät nimmt auf — antippen holt die Aufnahme her";
  // Im Halt geht kein Ton hinaus: Der Punkt sagt es leiser.
  const gedimmt = state.angehalten ? " gedimmt" : "";
  knopf.className = `rec-griff ${ichNehmeAuf() ? "hier" : state.aufnahmeVon === null ? "" : "fremd"}${gedimmt}`;
  knopf.title = titel;
  knopf.setAttribute("aria-label", titel);
}

// --- Einstellungen: ein Blatt über dem Kreis ------------------------------
//
// Zwei Gruppen, die sich nicht vermischen: Was für die ganze Runde gilt, geht
// an den Server; was nur hier gilt, bleibt im Browser.

const gongErlaubt = () => {
  try {
    return localStorage.getItem("redekreis.gong") !== "0";
  } catch {
    return true;
  }
};

let einstOffen = false;

function einstellungenOeffnen() {
  menueZeigen(false);
  einstOffen = true;
  $("einstellungen").hidden = false;
  $("einst-schatten").hidden = false;
  einstFuellen();
  mikrofoneAuflisten();
}

function einstellungenSchliessen() {
  einstOffen = false;
  $("einstellungen").hidden = true;
  $("einst-schatten").hidden = true;
}

// Was in der Runde gilt, steht im Zustand — beim Öffnen wird es abgeschrieben.
function einstFuellen() {
  $("einst-titel").value = state.titel;
  $("einst-sprache").value = state.sprache;
  latenzSetzen(state.attContextRight);
  redezeitSetzen(Math.round(state.redezeitMs / 60000));
  $("einst-gong").setAttribute("aria-checked", String(gongErlaubt()));
  $("einst-datei").textContent = state.datei;
  $("einst-modell").textContent = state.bereit ? state.modell : "Modell lädt …";
  einstGeraete();
  einstNamen();
}

function latenzSetzen(wert) {
  for (const knopf of $("einst-latenz").children) {
    knopf.setAttribute("aria-checked", String(Number(knopf.dataset.wert) === Number(wert)));
  }
}
const latenzWert = () =>
  Number([...$("einst-latenz").children].find((k) => k.getAttribute("aria-checked") === "true")?.dataset.wert ?? 13);

function redezeitSetzen(minuten) {
  $("einst-redezeit").textContent = String(Math.max(0, Math.min(60, minuten)));
}
const redezeitWert = () => Number($("einst-redezeit").textContent);

// Welches Gerät liefert den Ton: Automatik oder ein bestimmtes.
function einstGeraete() {
  const auswahl = $("einst-aufnahme");
  const geraete = state.geraete ?? [];
  auswahl.replaceChildren(
    Object.assign(document.createElement("option"), {
      value: "",
      textContent: "Automatisch — wer dran ist",
    }),
    ...geraete.map((g) =>
      Object.assign(document.createElement("option"), {
        value: String(g.kennung),
        textContent:
          (g.kennung === meineKennung ? "Dieses Gerät" : g.namen.length ? g.namen.join(", ") : `Gerät ${g.kennung}`) +
          (g.kennung === state.aufnahmeVon ? " · nimmt auf" : ""),
      }),
    ),
  );
  auswahl.value = state.aufnahmeWahl === null || state.aufnahmeWahl === undefined ? "" : String(state.aufnahmeWahl);
}

// Wer an diesem Gerät sitzt — und der Weg hinaus.
function einstNamen() {
  const leute = kreis().filter((t) => meineIds.has(t.id));
  if (!leute.length) {
    $("einst-namen").replaceChildren(
      Object.assign(document.createElement("p"), {
        className: "leer",
        textContent: "An diesem Gerät sitzt noch niemand im Kreis.",
      }),
    );
    return;
  }
  $("einst-namen").replaceChildren(
    ...leute.map((t) => {
      const zeile = document.createElement("div");
      zeile.className = "name";
      const punkt = document.createElement("i");
      const wer = document.createElement("span");
      wer.textContent = t.name;
      const raus = document.createElement("button");
      raus.type = "button";
      raus.className = "btn";
      raus.textContent = "Verlassen";
      raus.onclick = () => {
        verlassen(t.id);
        einstNamen();
      };
      zeile.append(punkt, wer, raus);
      return zeile;
    }),
  );
}

// Die Gerätenamen gibt der Browser erst nach einer Freigabe preis; wer schon im
// Kreis sitzt, hat sie längst gegeben.
async function mikrofoneAuflisten() {
  let geraete = [];
  try {
    geraete = (await navigator.mediaDevices.enumerateDevices()).filter((g) => g.kind === "audioinput");
  } catch {
    return;
  }
  if (!geraete.some((g) => g.label)) return; // ohne Freigabe stehen dort nur leere Namen
  let gemerkt = "";
  try {
    gemerkt = localStorage.getItem("redekreis.mikro") ?? "";
  } catch {}
  $("einst-mikro").replaceChildren(
    Object.assign(document.createElement("option"), { value: "", textContent: "Standard" }),
    ...geraete.map((g, i) =>
      Object.assign(document.createElement("option"), {
        value: g.deviceId,
        textContent: g.label || `Mikrofon ${i + 1}`,
      }),
    ),
  );
  $("einst-mikro").value = gemerkt;
}

$("einstellungen-auf").onclick = einstellungenOeffnen;
$("einst-zu").onclick = einstellungenSchliessen;
$("einst-zurueck").onclick = einstellungenSchliessen;
$("einst-schatten").onclick = einstellungenSchliessen;
$("einst-redezeit-weniger").onclick = () => redezeitSetzen(redezeitWert() - 1);
$("einst-redezeit-mehr").onclick = () => redezeitSetzen(redezeitWert() + 1);
$("einst-latenz").onclick = (ev) => {
  const knopf = ev.target.closest("button");
  if (knopf) latenzSetzen(knopf.dataset.wert);
};

// Was nur hier gilt, wirkt sofort — es geht ja niemanden sonst etwas an.
$("einst-gong").onclick = () => {
  const an = $("einst-gong").getAttribute("aria-checked") !== "true";
  $("einst-gong").setAttribute("aria-checked", String(an));
  try {
    localStorage.setItem("redekreis.gong", an ? "1" : "0");
  } catch {}
};
$("einst-mikro").onchange = () => {
  try {
    localStorage.setItem("redekreis.mikro", $("einst-mikro").value);
  } catch {}
  // Das offene Mikrofon ist das alte — neu aufmachen, sonst gilt die Wahl erst
  // nach dem Neuladen.
  mikroSchliessen();
  mikroPruefen();
};

$("einst-uebernehmen").onclick = () => {
  sende({
    typ: "setzen",
    titel: $("einst-titel").value.trim() || "Redekreis",
    sprache: $("einst-sprache").value,
    attContextRight: latenzWert(),
    redezeitMs: redezeitWert() * 60000,
  });
  const wahl = $("einst-aufnahme").value;
  sende({ typ: "aufnahmeGeraet", kennung: wahl === "" ? null : Number(wahl) });
  einstellungenSchliessen();
};

// --- Bedienung -----------------------------------------------------------

$("aufnahme").onclick = () => sende({ typ: "aufnehmen" });
$("weiter").onclick = weitergeben;
$("beenden").onclick = beenden;
$("pause").onclick = anhalten;
$("export").onclick = () => {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  window.open(`/export.md?tz=${encodeURIComponent(zone)}`, "_blank");
  menueZeigen(false);
};
$("neu").onclick = () => {
  menueZeigen(false);
  if (state.beitraege.length && !confirm(`${state.beitraege.length} Beiträge sind gesichert. Neue Runde beginnen?`)) return;
  sende({ typ: "neueRunde" });
};

$("beitritt").onsubmit = (ev) => {
  ev.preventDefault();
  beitreten($("beitritt-name").value);
  $("beitritt-name").value = "";
  // Noch in der Geste des Absendens: iOS Safari gibt das Mikrofon nur so frei.
  mikroFreigeben();
};
$("noch-jemand").onclick = () => {
  zeichneBeitritt(true);
  $("beitritt-name").focus();
};
$("beitritt-ab").onclick = () => zeichneBeitritt(false);

// --- Mehr-Menü ------------------------------------------------------------

function menueZeigen(an) {
  $("menue").hidden = !an;
  $("mehr").setAttribute("aria-expanded", String(an));
}
$("mehr").onclick = (ev) => {
  ev.stopPropagation();
  menueZeigen($("menue").hidden);
};
document.addEventListener("click", (ev) => {
  if (!$("menue").hidden && !ev.target.closest("#menue")) menueZeigen(false);
});

// Ablenkungsfrei: nur der Kreis, kein Verlauf. Mitgeschrieben und gesichert
// wird weiter, der Text ist nur nicht zu sehen.
function fokusSetzen(an) {
  document.body.classList.toggle("ohne-text", an);
  $("fokus").querySelector(".wort").textContent = an ? "Mit Text" : "Nur Sprecher";
  $("mit-text").hidden = !an;
  try {
    localStorage.setItem("redekreis.fokus", an ? "1" : "0");
  } catch {}
  if (state) zeichneRing();
}
$("fokus").onclick = () => {
  fokusSetzen(!document.body.classList.contains("ohne-text"));
  menueZeigen(false);
};
$("mit-text").onclick = () => fokusSetzen(false);

function vollbildUmschalten() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen().catch(() => {});
}
$("vollbild").onclick = () => {
  vollbildUmschalten();
  menueZeigen(false);
};
document.addEventListener("fullscreenchange", () => {
  $("vollbild").querySelector(".wort").textContent = document.fullscreenElement ? "Vollbild beenden" : "Vollbild";
});

// --- Kreis oder Text: zwei Vollansichten am Telefon -----------------------

function ansichtSetzen(was) {
  document.body.classList.toggle("ansicht-kreis", was === "kreis");
  document.body.classList.toggle("ansicht-text", was === "text");
  $("tab-kreis").setAttribute("aria-selected", String(was === "kreis"));
  $("tab-text").setAttribute("aria-selected", String(was === "text"));
  try {
    localStorage.setItem("redekreis.ansicht", was);
  } catch {}
  if (state) zeichneRing();
}
$("tab-kreis").onclick = () => ansichtSetzen("kreis");
$("tab-text").onclick = () => ansichtSetzen("text");

// Wischen quer tut dasselbe wie die Pille.
let wischStart = null;
document.querySelector(".tafel").addEventListener("touchstart", (ev) => {
  wischStart = ev.touches.length === 1 ? { x: ev.touches[0].clientX, y: ev.touches[0].clientY } : null;
}, { passive: true });
document.querySelector(".tafel").addEventListener("touchend", (ev) => {
  if (!wischStart || ziehtGerade) return;
  const ende = ev.changedTouches[0];
  const dx = ende.clientX - wischStart.x;
  const dy = ende.clientY - wischStart.y;
  wischStart = null;
  if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.6) return;
  ansichtSetzen(dx < 0 ? "text" : "kreis");
}, { passive: true });

document.addEventListener("keydown", (ev) => {
  if (ev.target.isContentEditable || ["INPUT", "TEXTAREA"].includes(ev.target.tagName)) return;
  // Steht das Blatt offen, gehören die Tasten ihm — nur Escape schließt es.
  if (!$("einstellungen").hidden && ev.code !== "Escape") return;
  if (ev.code === "Space") {
    ev.preventDefault();
    weitergeben();
  } else if (ev.code === "Escape") {
    if (!$("einstellungen").hidden) einstellungenSchliessen();
    else if (!$("menue").hidden) menueZeigen(false);
    else beenden();
  } else if (ev.key === "f") {
    vollbildUmschalten();
  } else if (ev.key === "p") {
    anhalten();
  }
});

// Ändert sich der Platz — Fenstergröße, Fokus, Vollbild —, wird der Ring neu
// aufgesetzt.
new ResizeObserver(() => state && zeichneRing()).observe(document.querySelector(".kreisspalte"));

try {
  fokusSetzen(localStorage.getItem("redekreis.fokus") === "1");
  ansichtSetzen(localStorage.getItem("redekreis.ansicht") === "text" ? "text" : "kreis");
} catch {
  fokusSetzen(false);
  ansichtSetzen("kreis");
}

verbinden(async (m) => {
  if (m.typ === "fehler") return melden(m.text, true);
  if (m.typ === "du") {
    meineKennung = m.kennung;
    return;
  }
  if (m.typ === "beigetreten") return beigetreten(m);
  if (m.typ === "live" && state) {
    state.aktiv = m.aktiv;
    pegelGemeldet(m.pegel ?? 0);
    return zeichneLive();
  }
  if (m.typ !== "state") return;

  const ersteAntwort = state === null;
  state = m.state;
  zeichnen();
  zeichneAufnahme();
  if (einstOffen) {
    einstGeraete();
    einstNamen();
    $("einst-datei").textContent = state.datei;
  }
  // Nach einem Neuladen sitzen dieselben Menschen an diesem Gerät wie vorher.
  if (ersteAntwort) {
    for (const name of meineNamen) beitreten(name);
    zeichneBeitritt();
  }
  // Das Mikrofon geht genau dann auf, wenn dieses Gerät aufnehmen soll.
  await mikroPruefen();
});
