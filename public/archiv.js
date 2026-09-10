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
  $("gelesen-titel").className = "sprecher";
  $("gelesen-zeit").textContent = datum(runde.begonnen);
  $("laden").href = `/runde/${id}.md?tz=${encodeURIComponent(zone)}`;
  $("werkzeuge").hidden = imPapierkorb;
  $("werkzeuge-papierkorb").hidden = !imPapierkorb;

  zeigeModus("lesen");
  melde("");
  zeigeBeitraege(runde);
  for (const li of $("runden").children) li.classList.toggle("dran", li.dataset.id === id);
}

async function zeigeListe() {
  const runden = await frage(imPapierkorb ? "/api/papierkorb" : "/api/runden");
  $("listen-titel").textContent = imPapierkorb ? "Papierkorb" : "Runden";
  $("papierkorb-an").textContent = imPapierkorb ? "Zurück zum Archiv" : "Papierkorb";
  $("anzahl").textContent = runden.length === 1 ? "1 Runde" : `${runden.length} Runden`;

  if (!runden.length) {
    $("runden").replaceChildren(
      Object.assign(document.createElement("li"), {
        className: "platzhalter",
        textContent: imPapierkorb ? "Der Papierkorb ist leer." : "Noch keine Runde aufgezeichnet.",
      }),
    );
    $("gelesen").replaceChildren();
    $("gelesen-titel").textContent = "Keine Runde gewählt";
    $("gelesen-titel").className = "sprecher still";
    $("gelesen-zeit").textContent = "";
    $("werkzeuge").hidden = true;
    $("werkzeuge-papierkorb").hidden = true;
    return;
  }

  $("runden").replaceChildren(
    ...runden.map((r) => {
      const li = document.createElement("li");
      li.dataset.id = r.id;
      li.className = "runde-eintrag";
      const titel = document.createElement("div");
      titel.className = "wer";
      titel.textContent = r.titel;
      if (r.bearbeitet) {
        const merkmal = document.createElement("span");
        merkmal.className = "bearbeitet";
        merkmal.textContent = "bearbeitet";
        titel.append(" ", merkmal);
      }
      const wann = document.createElement("div");
      wann.className = "wann";
      wann.textContent =
        `${datum(r.begonnen)} · ${r.anzahl} ${r.anzahl === 1 ? "Beitrag" : "Beiträge"}` +
        (r.sprecher.length ? ` · ${r.sprecher.join(", ")}` : "");
      li.append(titel, wann);
      li.onclick = () => zeigeRunde(r.id).catch((e) => melde(e.message, "fehler"));
      return li;
    }),
  );

  const bleibt = runden.some((r) => r.id === gewaehlt?.id) ? gewaehlt.id : runden[0].id;
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

$("umbenennen").onclick = async () => {
  const titel = prompt("Neuer Name der Runde:", gewaehlt.runde.titel);
  if (titel === null) return;
  try {
    await frage(`/api/runde/${gewaehlt.id}/umbenennen`, { method: "POST", body: JSON.stringify({ titel }) });
    await zeigeListe();
    melde("Umbenannt.", "gut");
  } catch (e) {
    melde(e.message, "fehler");
  }
};

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

$("papierkorb-an").onclick = async () => {
  imPapierkorb = !imPapierkorb;
  gewaehlt = null;
  await zeigeListe();
};

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
            const was = document.createElement("span");
            was.className = "wer";
            was.textContent = s.aktion;
            const wann = document.createElement("span");
            wann.className = "wann";
            wann.textContent = datum(s.zeit);
            const knopf = document.createElement("button");
            knopf.type = "button";
            knopf.className = "klein";
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
            kopf.append(was, wann, knopf);
            const text = document.createElement("p");
            text.className = "was";
            text.textContent = s.beschreibung;
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
