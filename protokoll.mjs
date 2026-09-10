// Eine Runde als Text und zurück. Das Markdown ist das, was die Menschen
// lesen und korrigieren — deshalb muss es sich verlustarm zurücklesen lassen.

export const standardZone = () => process.env.TZ || undefined;

export function gueltigeZone(zone) {
  if (!zone) return false;
  try {
    new Intl.DateTimeFormat("de-DE", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

const zonenTeil = (zone) => (gueltigeZone(zone) ? { timeZone: zone } : {});

// --- hin ------------------------------------------------------------------

export function alsMarkdown(runde, zeitzone) {
  const zone = zonenTeil(zeitzone);
  const zeit = (iso) =>
    new Date(iso).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", ...zone });
  const beitraege = [...(runde.beitraege ?? [])];
  const laufend = runde.aktiv?.committed
    ? { sprecher: runde.aktiv.sprecher, begonnen: runde.aktiv.begonnen, text: runde.aktiv.committed.trim() }
    : runde.laufend;
  const kopf = [
    `# ${runde.titel}`,
    "",
    `${new Date(runde.begonnen).toLocaleString("de-DE", zone)} · ${beitraege.length + (laufend ? 1 : 0)} Beiträge`,
    "",
  ];
  const koerper = beitraege.map((b) => `## ${b.sprecher} · ${zeit(b.begonnen)}\n\n${b.text}\n`);
  // Wer gerade spricht, steht mit dabei — ein Export mittendrin verliert nichts.
  if (laufend) {
    koerper.push(`## ${laufend.sprecher} · ${zeit(laufend.begonnen)} · spricht noch\n\n${laufend.text}\n`);
  }
  return [...kopf, ...koerper].join("\n");
}

export function alsJsonl(runde) {
  const zeile = (rolle, text, zeitpunkt) =>
    JSON.stringify({
      type: "user",
      message: { role: rolle, content: text },
      timestamp: zeitpunkt,
      quelle: "redekreis",
    });

  const beitraege = [...(runde.beitraege ?? [])];
  const laufend = runde.aktiv?.committed
    ? { sprecher: runde.aktiv.sprecher, begonnen: runde.aktiv.begonnen, text: runde.aktiv.committed.trim() }
    : runde.laufend;
  if (laufend) beitraege.push(laufend);

  const wer = [...new Set(beitraege.map((b) => b.sprecher))];
  const kopf =
    `Redekreis: ${runde.titel} · ${beitraege.length} Beiträge` + (wer.length ? ` · mit ${wer.join(", ")}` : "");

  return (
    [zeile("user", kopf, runde.begonnen), ...beitraege.map((b) => zeile(b.sprecher, b.text, b.begonnen))].join("\n") +
    "\n"
  );
}

// --- und zurück -----------------------------------------------------------

// Wieviel liegt die Zone zu diesem Zeitpunkt vor UTC?
function zonenVersatz(msUtc, zone) {
  const teile = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(new Date(msUtc))
      .map((t) => [t.type, t.value]),
  );
  const alsWaere = Date.UTC(
    Number(teile.year),
    Number(teile.month) - 1,
    Number(teile.day),
    Number(teile.hour) % 24,
    Number(teile.minute),
    Number(teile.second),
  );
  return alsWaere - msUtc;
}

// Kalendertag der Runde in der Zone, in der das Protokoll gelesen wurde.
function tagIn(iso, zone) {
  const teile = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      ...zonenTeil(zone),
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(new Date(iso))
      .map((t) => [t.type, t.value]),
  );
  return { jahr: Number(teile.year), monat: Number(teile.month), tag: Number(teile.day) };
}

// Aus „14:37" wird ein echter Zeitpunkt — am Kalendertag der Runde, in ihrer Zone.
function zeitpunktAus(hhmm, { begonnen, zone, nichtVor }) {
  const [stunde, minute] = hhmm.split(":").map(Number);
  const { jahr, monat, tag } = tagIn(begonnen, zone);
  for (let plusTage = 0; plusTage < 3; plusTage++) {
    const roh = Date.UTC(jahr, monat - 1, tag + plusTage, stunde, minute);
    const ms = gueltigeZone(zone) ? roh - zonenVersatz(roh, zone) : roh;
    // Eine Runde kann über Mitternacht laufen: dann gehört die Zeit auf den Folgetag.
    if (!nichtVor || ms >= nichtVor) return new Date(ms).toISOString();
  }
  return new Date(nichtVor + 1000).toISOString();
}

/**
 * Liest ein bearbeitetes Protokoll zurück in eine Runde.
 *
 * Zeitstempel bleiben erhalten, wo Überschrift und bisheriger Beitrag
 * zusammenpassen. Neu entstandene Beiträge — etwa wenn jemand einen Block in
 * zwei Sprecher aufteilt — bekommen ihre Zeit aus der Überschrift.
 */
export function ausMarkdown(markdown, { runde, zeitzone } = {}) {
  const alt = runde?.beitraege ?? [];
  const zone = gueltigeZone(zeitzone) ? zeitzone : standardZone();
  const zeilen = String(markdown).replace(/\r\n/g, "\n").split("\n");

  let titel = runde?.titel ?? "Redekreis";
  const roh = [];
  let offen = null;

  for (const zeile of zeilen) {
    const ueberschrift = zeile.match(/^##\s+(.*)$/);
    if (ueberschrift) {
      if (offen) roh.push(offen);
      const teile = ueberschrift[1].split("·").map((t) => t.trim());
      const uhrzeit = teile.find((t) => /^\d{1,2}:\d{2}$/.test(t));
      offen = { sprecher: teile[0] || "Unbekannt", uhrzeit, zeilen: [] };
      continue;
    }
    const haupt = zeile.match(/^#\s+(.*)$/);
    if (haupt && !offen) {
      titel = haupt[1].trim() || titel;
      continue;
    }
    if (offen) offen.zeilen.push(zeile);
  }
  if (offen) roh.push(offen);

  // Zeitstempel aus dem bisherigen Stand übernehmen, wo es passt.
  const uebrig = [...alt];
  const beitraege = [];
  let zuletzt = 0;
  for (const eintrag of roh) {
    const text = eintrag.zeilen.join("\n").trim();
    if (!text && !eintrag.sprecher) continue;

    const passtIndex = uebrig.findIndex(
      (b) =>
        b.sprecher === eintrag.sprecher &&
        (!eintrag.uhrzeit ||
          new Date(b.begonnen).toLocaleTimeString("de-DE", {
            hour: "2-digit",
            minute: "2-digit",
            ...zonenTeil(zone),
          }) === eintrag.uhrzeit),
    );

    let begonnen;
    let beendet;
    if (passtIndex !== -1) {
      const treffer = uebrig.splice(passtIndex, 1)[0];
      begonnen = treffer.begonnen;
      beendet = treffer.beendet;
    } else if (eintrag.uhrzeit) {
      begonnen = zeitpunktAus(eintrag.uhrzeit, {
        begonnen: runde?.begonnen ?? new Date().toISOString(),
        zone,
        nichtVor: zuletzt,
      });
    } else {
      begonnen = new Date(zuletzt + 1000).toISOString();
    }
    zuletzt = Math.max(zuletzt, new Date(begonnen).getTime());
    beitraege.push({ sprecher: eintrag.sprecher, begonnen, ...(beendet ? { beendet } : {}), text });
  }

  return { ...(runde ?? {}), titel, beitraege, laufend: null };
}
