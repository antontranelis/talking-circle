// Eigene Seite für alles, was vor dem Kreis feststeht: Titel, Namen,
// Mikrofon, Sprache, Verzögerung.
import { verbinden, sende } from "./verbindung.js";

const $ = (id) => document.getElementById(id);
let gefuellt = false;

function melden(text, fehler = false) {
  $("status").textContent = text;
  $("status").classList.toggle("fehler", fehler);
}

verbinden((m) => {
  if (m.typ === "fehler") return melden(m.text, true);
  if (m.typ !== "state" || gefuellt) return;
  gefuellt = true;
  const s = m.state;
  $("titel").value = s.titel;
  $("namen").value = s.teilnehmende.join("\n");
  $("sprache").value = s.sprache;
  $("latenz").value = String(s.attContextRight);
  $("redezeit").value = String(Math.round(s.redezeitMs / 60000));
  if (s.teilnehmende.length) {
    // Der Kreis läuft schon — dann ist das hier eine Änderung, kein Anfang.
    $("los").textContent = "Übernehmen";
    $("zurueck").hidden = false;
  }
});

// Die Gerätenamen gibt der Browser erst nach einer Freigabe preis, deshalb
// einmal kurz aufmachen und sofort wieder schließen.
async function mikrofoneAuflisten() {
  try {
    const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
    probe.getTracks().forEach((t) => t.stop());
  } catch {
    return melden("Ohne Mikrofon-Freigabe kann nichts mitgeschrieben werden.", true);
  }
  const geraete = (await navigator.mediaDevices.enumerateDevices()).filter((g) => g.kind === "audioinput");
  const gemerkt = localStorage.getItem("redekreis.mikro") ?? "";
  $("mikro").replaceChildren(
    ...geraete.map((g, i) =>
      Object.assign(document.createElement("option"), {
        value: g.deviceId,
        textContent: g.label || `Mikrofon ${i + 1}`,
        selected: g.deviceId === gemerkt,
      }),
    ),
  );
}

$("form").onsubmit = (ev) => {
  ev.preventDefault();
  const liste = $("namen").value.split("\n").map((z) => z.trim()).filter(Boolean);
  if (!liste.length) return melden("Bitte mindestens einen Namen eintragen.", true);
  localStorage.setItem("redekreis.mikro", $("mikro").value);
  sende({
    typ: "setzen",
    titel: $("titel").value.trim() || "Redekreis",
    sprache: $("sprache").value,
    teilnehmende: liste,
    attContextRight: Number($("latenz").value),
    redezeitMs: Math.max(0, Number($("redezeit").value) || 0) * 60000,
  });
  location.href = "/";
};

mikrofoneAuflisten();
