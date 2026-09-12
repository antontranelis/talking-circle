// Alle bisherigen Runden: links die Liste, rechts die gewählte Runde —
// zum Nachlesen, Korrigieren und, falls nötig, Zurücknehmen.
const $ = (id) => document.getElementById(id);
const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;

let gewaehlt = null;
let imPapierkorb = false;

const datum = (iso) =>
  new Date(iso).toLocaleString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
const uhrzeit = (iso) => new Date(iso).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });

function melde(text, art = "") {
  const feld = $("meldung");
  feld.textContent = text;
  feld.className = `status ${art}`.trim();
  feld.hidden = !text;
}

async function frage(pfad, optionen = {}) {
  const antwort = await fetch(pfad, {
    ...optionen,
    headers: optionen.body ? { "content-type": "application/json" } : undefined,
  });
  const inhalt = antwort.headers.get("content-type")?.includes("json") ? await antwort.json() : await antwort.text();
  if (!antwort.ok) throw new Error(inhalt?.fehler ?? "Das hat nicht geklappt");
  return inhalt;
}

// --- Anzeige --------------------------------------------------------------

function zeigeBeitraege(runde) {
  const beitraege = [...(runde.beitraege ?? [])];
  if (runde.laufend) beitraege.push({ ...runde.laufend, laufend: true });

  if (!beitraege.length) {
    $("gelesen").replaceChildren(
      Object.assign(document.createElement("p"), { className: "platzhalter", textContent: "Diese Runde ist leer." }),
    );
    return;
  }

  $("gelesen").replaceChildren(
    ...beitraege.map((b) => {
      const teil = document.createElement("article");
      const kopf = document.createElement("div");
      kopf.className = "eintrag-kopf";
      const wer = document.createElement("span");
      wer.className = "wer";
      wer.textContent = b.sprecher;
      const wann = document.createElement("span");
      wann.className = "wann";
      wann.textContent = uhrzeit(b.begonnen) + (b.laufend ? " · spricht noch" : "");
      kopf.append(wer, wann);
      const was = document.createElement("p");
      was.className = "was";
      was.textContent = b.text;
      teil.append(kopf, was);
      return teil;
    }),
  );
}

async function zeigeRunde(id) {
  const runde = await frage(`/runde/${id}.json`);
  gewaehlt = { id, runde };

  $("gelesen-titel").textContent = runde.titel;
  $("gelesen-titel").className = "runde-titel";
  $("gelesen-zeit").textContent = datum(runde.begonnen);
  $("gelesen-tag").hidden = !runde.bearbeitet;
  umbenennenAus();
  $("laden").href = `/runde/${id}.md?tz=${encodeURIComponent(zone)}`;
  $("werkzeuge").hidden = imPapierkorb;
  $("werkzeuge-papierkorb").hidden = !imPapierkorb;

  zeigeModus("lesen");
  melde("");
  zeigeBeitraege(runde);
  for (const li of $("runden").children) li.classList.toggle("dran", li.dataset.id === id);
}

async function zeigeListe() {
  const [runden, papierkorb] = await Promise.all([frage("/api/runden"), frage("/api/papierkorb")]);
  const alle = imPapierkorb ? papierkorb : runden;
  const weg = imPapierkorb ? runden : papierkorb;
  $("quelle-runden").setAttribute("aria-checked", String(!imPapierkorb));
  $("quelle-papierkorb").setAttribute("aria-checked", String(imPapierkorb));
  $("anzahl").textContent =
    `${alle.length} ${alle.length === 1 ? "Runde" : "Runden"}` + (weg.length ? ` · ${weg.length} im Papierkorb` : "");

  if (!alle.length) {
    $("runden").replaceChildren(
      Object.assign(document.createElement("li"), {
        className: "platzhalter",
        textContent: imPapierkorb ? "Der Papierkorb ist leer." : "Noch keine Runde aufgezeichnet.",
      }),
    );
    $("gelesen").replaceChildren();
    $("gelesen-titel").textContent = "Keine Runde gewählt";
    $("gelesen-titel").className = "runde-titel still";
    $("gelesen-zeit").textContent = "";
    $("gelesen-tag").hidden = true;
    $("werkzeuge").hidden = true;
    $("werkzeuge-papierkorb").hidden = true;
    zeigeModus("lesen");
    return;
  }

  $("runden").replaceChildren(
    ...alle.map((r) => {
      const li = document.createElement("li");
      li.dataset.id = r.id;
      li.className = "runde-eintrag";
      const zeile = document.createElement("div");
      zeile.className = "titel-zeile";
      const titel = document.createElement("span");
      titel.className = "name";
      titel.textContent = r.titel;
      zeile.append(titel);
      if (r.bearbeitet) {
        const merkmal = document.createElement("span");
        merkmal.className = "tag";
        merkmal.textContent = "bearbeitet";
        zeile.append(merkmal);
      }
      const wann = document.createElement("div");
      wann.className = "meta";
      wann.textContent = `${datum(r.begonnen)} · ${r.anzahl} ${r.anzahl === 1 ? "Beitrag" : "Beiträge"}`;
      const leute = document.createElement("div");
      leute.className = "leute";
      leute.textContent = r.sprecher.join(", ");
      li.append(zeile, wann, leute);
      li.onclick = () => zeigeRunde(r.id).catch((e) => melde(e.message, "fehler"));
      return li;
    }),
  );

  const bleibt = alle.some((r) => r.id === gewaehlt?.id) ? gewaehlt.id : alle[0].id;
  await zeigeRunde(bleibt);
}

// --- Bearbeiten -----------------------------------------------------------

// Die Bühne zeigt genau eines: die Runde, den Editor oder den Verlauf.
// Jedes davon bekommt die volle Fläche — nichts wird an den Rand gequetscht.
let modus = "lesen";
function zeigeModus(neuerModus) {
  modus = neuerModus;
  $("gelesen").hidden = modus !== "lesen";
  $("werkstatt").hidden = modus !== "bearbeiten";
  $("verlauf-blatt").hidden = modus !== "verlauf";
  $("bearbeiten").classList.toggle("an", modus === "bearbeiten");
  $("verlauf-an").classList.toggle("an", modus === "verlauf");
  if (modus !== "lesen") umbenennenAus();
}

const ausBearbeitung = () => zeigeModus("lesen");

async function inBearbeitung() {
  const text = await frage(`/runde/${gewaehlt.id}.md?roh=1&tz=${encodeURIComponent(zone)}`);
  $("editor").value = text;
  $("editor-status").textContent = "";
  zeigeModus("bearbeiten");
  $("editor").focus();
}

$("bearbeiten").onclick = async () => {
  try {
    if (modus === "bearbeiten") zeigeModus("lesen");
    else await inBearbeitung();
  } catch (e) {
    melde(e.message, "fehler");
  }
};

$("abbrechen").onclick = () => {
  zeigeModus("lesen");
  melde("");
};

$("speichern").onclick = async () => {
  $("editor-status").textContent = "Wird gespeichert …";
  try {
    await frage(`/api/runde/${gewaehlt.id}`, {
      method: "PUT",
      body: JSON.stringify({ markdown: $("editor").value, zeitzone: zone }),
    });
    ausBearbeitung();
    await zeigeListe();
    melde("Gespeichert. Der vorherige Stand steht im Verlauf.", "gut");
  } catch (e) {
    $("editor-status").textContent = "";
    melde(e.message, "fehler");
  }
};

// Umbenennen geschieht an der Stelle, an der der Name steht — kein
// Browser-Kasten über der Runde.
function umbenennenAn() {
  $("titel-feld").value = gewaehlt.runde.titel;
  $("gelesen-titel").hidden = true;
  $("titel-feld").hidden = false;
  $("titel-hinweis").hidden = false;
  $("titel-feld").focus();
  $("titel-feld").select();
}

function umbenennenAus() {
  $("gelesen-titel").hidden = false;
  $("titel-feld").hidden = true;
  $("titel-hinweis").hidden = true;
}

async function umbenennen(titel) {
  try {
    await frage(`/api/runde/${gewaehlt.id}/umbenennen`, { method: "POST", body: JSON.stringify({ titel }) });
    umbenennenAus();
    await zeigeListe();
    melde("Umbenannt.", "gut");
  } catch (e) {
    melde(e.message, "fehler");
  }
}

$("umbenennen").onclick = () => ($("titel-feld").hidden ? umbenennenAn() : umbenennenAus());
$("titel-feld").onkeydown = (ev) => {
  if (ev.key === "Enter") umbenennen($("titel-feld").value.trim());
  if (ev.key === "Escape") umbenennenAus();
};
$("titel-feld").onblur = umbenennenAus;

$("loeschen").onclick = async () => {
  const anzahl = gewaehlt.runde.beitraege?.length ?? 0;
  if (!confirm(`„${gewaehlt.runde.titel}" mit ${anzahl} Beiträgen in den Papierkorb legen?`)) return;
  try {
    await frage(`/api/runde/${gewaehlt.id}`, { method: "DELETE" });
    gewaehlt = null;
    await zeigeListe();
    melde("In den Papierkorb gelegt. Von dort lässt sie sich zurückholen.", "gut");
  } catch (e) {
    melde(e.message, "fehler");
  }
};

$("zurueckholen").onclick = async () => {
  try {
    await frage(`/api/runde/${gewaehlt.id}/wiederherstellen`, { method: "POST" });
    imPapierkorb = false;
    await zeigeListe();
    melde("Wiederhergestellt.", "gut");
  } catch (e) {
    melde(e.message, "fehler");
  }
};

async function quelleWechseln(korb) {
  if (imPapierkorb === korb) return;
  imPapierkorb = korb;
  gewaehlt = null;
  await zeigeListe();
}
$("quelle-runden").onclick = () => quelleWechseln(false).catch((e) => melde(e.message, "fehler"));
$("quelle-papierkorb").onclick = () => quelleWechseln(true).catch((e) => melde(e.message, "fehler"));

// --- Verlauf --------------------------------------------------------------

$("verlauf-an").onclick = async () => {
  if (modus === "verlauf") {
    zeigeModus("lesen");
    return;
  }
  try {
    const schritte = await frage(`/api/runde/${gewaehlt.id}/historie`);
    $("schritte").replaceChildren(
      ...(schritte.length
        ? [...schritte].reverse().map((s) => {
            const li = document.createElement("li");
            const kopf = document.createElement("div");
            kopf.className = "eintrag-kopf";
            const wann = document.createElement("span");
            wann.className = "wann";
            wann.textContent = datum(s.zeit);
            const knopf = document.createElement("button");
            knopf.type = "button";
            knopf.className = "btn";
            knopf.textContent = "Zurücknehmen";
            knopf.onclick = async () => {
              if (!confirm(`Den Stand von vor „${s.aktion}" wiederherstellen?`)) return;
              try {
                await frage(`/api/runde/${gewaehlt.id}/zurueck`, {
                  method: "POST",
                  body: JSON.stringify({ nr: s.nr }),
                });
                await zeigeListe();
                melde("Zurückgenommen.", "gut");
              } catch (e) {
                melde(e.message, "fehler");
              }
            };
            kopf.append(wann, knopf);
            const text = document.createElement("p");
            text.className = "was";
            text.textContent = `${s.aktion} — ${s.beschreibung}`;
            li.append(kopf, text);
            return li;
          })
        : [
            Object.assign(document.createElement("li"), {
              className: "platzhalter",
              textContent: "Diese Runde ist unverändert, so wie sie aufgezeichnet wurde.",
            }),
          ]),
    );
    zeigeModus("verlauf");
  } catch (e) {
    melde(e.message, "fehler");
  }
};

zeigeListe().catch((e) => melde(e.message, "fehler"));
