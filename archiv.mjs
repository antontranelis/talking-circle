// Das Archiv: alle aufgezeichneten Runden, ihre Bearbeitung und ihre
// Geschichte. Nichts wird überschrieben, ohne dass der vorherige Stand
// erhalten bleibt — jede Änderung ist rücknehmbar, auch das Löschen.
import fs from "node:fs";
import path from "node:path";
import { alsJsonl, alsMarkdown, ausMarkdown } from "./protokoll.mjs";

const WURZEL = path.join(import.meta.dirname, "transcripts");
const PAPIERKORB = path.join(WURZEL, "papierkorb");
const KENNUNG = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}$/;

const ordner = (geloescht) => (geloescht ? PAPIERKORB : WURZEL);
const pfad = (id, endung, geloescht) => path.join(ordner(geloescht), `${id}${endung}`);
const historieOrdner = (id, geloescht) => path.join(ordner(geloescht), `${id}.historie`);

export const gueltigeKennung = (id) => KENNUNG.test(id ?? "");

function lies(datei) {
  try {
    return JSON.parse(fs.readFileSync(datei, "utf8"));
  } catch {
    return null;
  }
}

// --- Lesen ----------------------------------------------------------------

export function ladeRunde(id, { geloescht = false } = {}) {
  if (!gueltigeKennung(id)) return null;
  return lies(pfad(id, ".json", geloescht));
}

function uebersicht(runde, id) {
  const beitraege = runde.beitraege ?? [];
  return {
    id: runde.id ?? id,
    titel: runde.titel ?? "Redekreis",
    begonnen: runde.begonnen,
    anzahl: beitraege.length + (runde.laufend ? 1 : 0),
    sprecher: [...new Set(beitraege.map((b) => b.sprecher))],
    zeichen: beitraege.reduce((n, b) => n + (b.text?.length ?? 0), 0),
    bearbeitet: historie(id, { geloescht: false }).length > 0,
  };
}

export function gespeicherteRunden({ geloescht = false } = {}) {
  const dir = ordner(geloescht);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((d) => d.endsWith(".json"))
    .map((d) => {
      const id = d.replace(/\.json$/, "");
      const runde = lies(path.join(dir, d));
      if (!runde) return null; // eine kaputte Datei soll das Archiv nicht sprengen
      return geloescht ? { ...uebersicht(runde, id), bearbeitet: false } : uebersicht(runde, id);
    })
    .filter(Boolean)
    .sort((a, b) => (a.begonnen < b.begonnen ? 1 : -1));
}

export const alsText = (runde, zeitzone) => alsMarkdown(runde, zeitzone);

// --- Historie -------------------------------------------------------------

export function historie(id, { geloescht = false } = {}) {
  if (!gueltigeKennung(id)) return [];
  return lies(path.join(historieOrdner(id, geloescht), "index.json")) ?? [];
}

// Hält den Stand VOR einer Änderung fest und gibt den Eintrag zurück.
function haltFest(id, aktion, beschreibung, { geloescht = false } = {}) {
  const vorher = ladeRunde(id, { geloescht });
  if (!vorher) return null;
  const ordnerPfad = historieOrdner(id, geloescht);
  fs.mkdirSync(ordnerPfad, { recursive: true });
  const bisher = historie(id, { geloescht });
  const nr = (bisher.at(-1)?.nr ?? 0) + 1;
  fs.writeFileSync(path.join(ordnerPfad, `${String(nr).padStart(4, "0")}.json`), JSON.stringify(vorher, null, 2));
  const eintrag = { nr, zeit: new Date().toISOString(), aktion, beschreibung };
  fs.writeFileSync(path.join(ordnerPfad, "index.json"), JSON.stringify([...bisher, eintrag], null, 2));
  return eintrag;
}

function standVor(id, nr, { geloescht = false } = {}) {
  return lies(path.join(historieOrdner(id, geloescht), `${String(nr).padStart(4, "0")}.json`));
}

// --- Schreiben ------------------------------------------------------------

function schreibe(id, runde) {
  fs.mkdirSync(WURZEL, { recursive: true });
  fs.writeFileSync(pfad(id, ".json"), JSON.stringify(runde, null, 2));
  fs.writeFileSync(pfad(id, ".md"), alsMarkdown(runde));
  fs.writeFileSync(pfad(id, ".jsonl"), alsJsonl(runde));
}

export function speichereMarkdown(id, markdown, { zeitzone } = {}) {
  const runde = ladeRunde(id);
  if (!runde) return { fehler: "Runde nicht gefunden" };

  const neu = ausMarkdown(markdown, { runde, zeitzone });
  const vorher = runde.beitraege?.length ?? 0;
  const nachher = neu.beitraege.length;
  const beschreibung =
    vorher === nachher
      ? `${nachher} Beiträge überarbeitet`
      : `Beiträge ${vorher} → ${nachher}${nachher > vorher ? " (aufgeteilt)" : " (zusammengefasst)"}`;

  haltFest(id, "bearbeitet", beschreibung);
  schreibe(id, neu);
  return { runde: neu };
}

export function benenneUm(id, titel) {
  const runde = ladeRunde(id);
  if (!runde) return { fehler: "Runde nicht gefunden" };
  const sauber = String(titel ?? "").trim();
  if (!sauber) return { fehler: "Der Titel darf nicht leer sein" };
  if (sauber === runde.titel) return { runde };

  haltFest(id, "umbenannt", `„${runde.titel}" → „${sauber}"`);
  const neu = { ...runde, titel: sauber };
  schreibe(id, neu);
  return { runde: neu };
}

// Löschen heißt hierher: in den Papierkorb, mitsamt Geschichte.
export function loesche(id) {
  const runde = ladeRunde(id);
  if (!runde) return { fehler: "Runde nicht gefunden" };
  haltFest(id, "gelöscht", `„${runde.titel}" in den Papierkorb`);
  fs.mkdirSync(PAPIERKORB, { recursive: true });
  for (const endung of [".json", ".md", ".jsonl"]) {
    if (fs.existsSync(pfad(id, endung))) fs.renameSync(pfad(id, endung), pfad(id, endung, true));
  }
  if (fs.existsSync(historieOrdner(id))) fs.renameSync(historieOrdner(id), historieOrdner(id, true));
  return { ok: true };
}

export function stelleWiederHer(id) {
  const runde = ladeRunde(id, { geloescht: true });
  if (!runde) return { fehler: "Im Papierkorb nicht gefunden" };
  for (const endung of [".json", ".md", ".jsonl"]) {
    if (fs.existsSync(pfad(id, endung, true))) fs.renameSync(pfad(id, endung, true), pfad(id, endung));
  }
  if (fs.existsSync(historieOrdner(id, true))) fs.renameSync(historieOrdner(id, true), historieOrdner(id));
  haltFest(id, "wiederhergestellt", `„${runde.titel}" aus dem Papierkorb`);
  schreibe(id, runde);
  return { runde };
}

// Rückgängig: der Stand von vor der gewählten Änderung wird zum neuen Stand.
// Die Rücknahme ist selbst eine Änderung — die Geschichte bleibt vollständig.
export function nimmZurueck(id, nr) {
  const runde = ladeRunde(id);
  if (!runde) return { fehler: "Runde nicht gefunden" };
  const eintraege = historie(id);
  const eintrag = eintraege.find((e) => e.nr === Number(nr));
  if (!eintrag) return { fehler: "Diesen Schritt gibt es nicht" };
  const alt = standVor(id, eintrag.nr);
  if (!alt) return { fehler: "Der frühere Stand fehlt" };

  haltFest(id, "zurückgenommen", `Schritt ${eintrag.nr} (${eintrag.aktion}) rückgängig gemacht`);
  schreibe(id, alt);
  return { runde: alt };
}
