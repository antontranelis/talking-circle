// Beiträge umformen: teilen, einfügen, verbinden.
//
// Reine Funktionen: Sie bekommen die Liste und geben eine neue zurück, ohne
// die alte anzufassen. `null` heißt „so nicht" — dann bleibt alles, wie es
// war. Gerechnet wird in Millisekunden seit der Epoche, nie in Uhrzeiten:
// Eine Runde über Mitternacht ist damit kein Sonderfall.

const ms = (iso) => new Date(iso).getTime();
const iso = (ms) => new Date(ms).toISOString();
const sauber = (name) => String(name ?? "").trim().slice(0, 60);

// Ein Beitrag ohne Ende — von Hand eingetragen oder noch nicht abgeschlossen —
// bekommt eine Sekunde zugestanden. Das reicht, um die Reihenfolge zu wahren.
const OHNE_ENDE_MS = 1000;

const beitrag = ({ sprecher, begonnen, beendet, text }) => ({
  sprecher,
  begonnen,
  ...(beendet ? { beendet } : {}),
  text,
});

/**
 * Ein Beitrag wird an der Zeichenposition `stelle` in zwei geteilt.
 *
 * Der erste behält Sprecher und Beginn, der zweite bekommt den neuen Sprecher
 * und einen Beginn, der anteilig zwischen Beginn und Ende liegt — dort, wo der
 * Schnitt im Text liegt. Ohne Ende ist es eine Sekunde später.
 *
 * Ein Schnitt am Rand teilt nichts: Er ergäbe einen leeren Beitrag.
 */
export function teilen(beitraege, index, stelle, sprecher) {
  const b = beitraege[index];
  if (!b) return null;
  const text = String(b.text ?? "");
  const wo = Math.max(0, Math.min(text.length, Number(stelle) || 0));
  const vorn = text.slice(0, wo).trim();
  const hinten = text.slice(wo).trim();
  if (!vorn || !hinten) return null;

  const von = ms(b.begonnen);
  const bis = b.beendet ? ms(b.beendet) : null;
  const anteil = text.length ? wo / text.length : 0.5;
  const schnitt =
    bis === null
      ? von + OHNE_ENDE_MS
      : Math.min(bis, Math.max(von + 1, von + Math.round((bis - von) * anteil)));

  const neu = [...beitraege];
  neu.splice(
    index,
    1,
    beitrag({ sprecher: b.sprecher, begonnen: b.begonnen, beendet: bis === null ? null : iso(schnitt), text: vorn }),
    beitrag({
      sprecher: sauber(sprecher) || b.sprecher,
      begonnen: iso(schnitt),
      beendet: b.beendet,
      text: hinten,
    }),
  );
  return neu;
}

/**
 * Ein neuer Beitrag rückt an die Stelle `index` — zwischen zwei Nachbarn, vor
 * den ersten oder hinter den letzten. Seine Zeit liegt zwischen den Nachbarn;
 * am Rand eine Sekunde davor oder danach.
 */
export function einfuegen(beitraege, index, { sprecher, text = "" } = {}) {
  const wo = Math.max(0, Math.min(beitraege.length, Number(index) || 0));
  const vorher = beitraege[wo - 1];
  const nachher = beitraege[wo];
  const von = vorher ? ms(vorher.beendet ?? vorher.begonnen) : null;
  const bis = nachher ? ms(nachher.begonnen) : null;

  let zeit;
  if (von !== null && bis !== null) zeit = bis > von ? von + Math.round((bis - von) / 2) : von + OHNE_ENDE_MS;
  else if (von !== null) zeit = von + OHNE_ENDE_MS;
  else if (bis !== null) zeit = bis - OHNE_ENDE_MS;
  else zeit = Date.now();

  const neu = [...beitraege];
  neu.splice(wo, 0, beitrag({ sprecher: sauber(sprecher) || "Unbekannt", begonnen: iso(zeit), text: String(text ?? "") }));
  return neu;
}

/**
 * Ein Beitrag wandert in den vorigen: Der Text hängt sich mit einem Leerzeichen
 * an, Sprecher und Beginn bleiben die des vorigen. Das Ende ist das spätere
 * der beiden. Der erste Beitrag hat keinen vorigen — dann geschieht nichts.
 */
export function verbinden(beitraege, index) {
  const b = beitraege[index];
  const vor = beitraege[index - 1];
  if (!b || !vor) return null;

  const neu = [...beitraege];
  neu.splice(
    index - 1,
    2,
    beitrag({
      sprecher: vor.sprecher,
      begonnen: vor.begonnen,
      beendet: b.beendet ?? vor.beendet,
      text: [vor.text, b.text].map((t) => String(t ?? "").trim()).filter(Boolean).join(" "),
    }),
  );
  return neu;
}
