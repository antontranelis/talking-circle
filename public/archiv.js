// Alle bisherigen Runden: links die Liste, rechts die gewählte Runde.
const $ = (id) => document.getElementById(id);
const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;

const datum = (iso) =>
  new Date(iso).toLocaleString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
const uhrzeit = (iso) => new Date(iso).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });

async function zeigeRunde(id) {
  const runde = await fetch(`/runde/${id}.json`).then((r) => (r.ok ? r.json() : null));
  if (!runde) return;

  $("gelesen-titel").textContent = runde.titel;
  $("gelesen-titel").className = "sprecher";
  $("gelesen-zeit").textContent = datum(runde.begonnen);
  $("laden").hidden = false;
  $("laden").href = `/runde/${id}.md?tz=${encodeURIComponent(zone)}`;

  const beitraege = [...(runde.beitraege ?? [])];
  if (runde.laufend) beitraege.push({ ...runde.laufend, laufend: true });

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
  for (const li of $("runden").children) li.classList.toggle("dran", li.dataset.id === id);
}

const runden = await fetch("/api/runden").then((r) => r.json());
$("anzahl").textContent = runden.length === 1 ? "1 Runde" : `${runden.length} Runden`;

if (!runden.length) {
  $("runden").replaceChildren(
    Object.assign(document.createElement("span"), { className: "platzhalter", textContent: "Noch keine Runde aufgezeichnet." }),
  );
} else {
  $("runden").replaceChildren(
    ...runden.map((r) => {
      const li = document.createElement("li");
      li.dataset.id = r.id;
      li.className = "runde-eintrag";
      const titel = document.createElement("div");
      titel.className = "wer";
      titel.textContent = r.titel;
      const wann = document.createElement("div");
      wann.className = "wann";
      wann.textContent =
        `${datum(r.begonnen)} · ${r.anzahl} ${r.anzahl === 1 ? "Beitrag" : "Beiträge"}` +
        (r.sprecher.length ? ` · ${r.sprecher.join(", ")}` : "");
      li.append(titel, wann);
      li.onclick = () => zeigeRunde(r.id);
      return li;
    }),
  );
  zeigeRunde(runden[0].id);
}
