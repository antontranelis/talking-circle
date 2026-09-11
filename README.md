# Redekreis

Mitschrift für einen Talking Circle: ein Mikrofon wandert im Kreis, der Text
erscheint in Echtzeit an der Wand. Alles läuft lokal — kein Ton verlässt den
Rechner.

Erkennung: **NVIDIA Nemotron 3.5 ASR Streaming 0.6B** über
[transcribe.cpp](https://github.com/handy-computer/transcribe.cpp), cache-aware
Streaming mit nativer Interpunktion und Großschreibung.

## Starten

```bash
npm install
npm start          # http://localhost:8123
```

Beim Start wird das Modell gesucht:

1. `TALKING_CIRCLE_MODEL` (Pfad zu einer `.gguf`), sonst
2. der Hugging-Face-Cache unter `~/.cache/huggingface/hub` — dort liegt es
   bereits, wenn Handy es einmal geladen hat.

Sonst einmalig holen:

```bash
huggingface-cli download handy-computer/nemotron-3.5-asr-streaming-0.6b-gguf \
  nemotron-3.5-asr-streaming-0.6b-Q8_0.gguf
```

## Mit Docker

```bash
docker run -p 8123:8123 \
  -v redekreis-modelle:/models \
  -v "$PWD/transcripts":/app/transcripts \
  ghcr.io/antontranelis/talking-circle:latest
```

Beim ersten Start lädt der Container das Sprachmodell (rund 700 MB) nach
`/models`; mit dem Volume passiert das genau einmal. Die Protokolle landen im
gemounteten Ordner auf der Platte. `docker compose up` tut dasselbe, die
`docker-compose.yml` liegt bei.

Stellschrauben:

| Variable | Standard | Bedeutung |
|---|---|---|
| `PORT` / `HOST` | `8123` / `0.0.0.0` | wo der Server hört |
| `MODELL_QUANT` | `Q8_0` | `Q6_K` und `Q4_K_M` sind kleiner und etwas ungenauer |
| `TZ` | UTC | Zeitzone der Uhrzeiten in der Datei auf der Platte |
| `TALKING_CIRCLE_MODEL` | – | Pfad zu einer eigenen `.gguf`; überspringt das Laden |

Das Abbild ist rund 320 MB groß, enthält kein Modell und läuft auf `amd64` und
`arm64`. Das Mikrofon liefert der Browser: `http://localhost:8123` funktioniert
direkt, andere Geräte im Netz sehen die Runde mit, dürfen aber nicht aufnehmen
(Browser geben das Mikrofon nur über `localhost` oder HTTPS frei).

## Auf einem Server

`deploy/docker-compose.server.yml` ist die Vorlage für den Betrieb hinter
Traefik mit automatischem Zertifikat und Auto-Update über Watchtower.

Zwei Dinge sind dabei nicht optional:

- **HTTPS.** Browser geben das Mikrofon nur über `localhost` oder eine
  gesicherte Verbindung frei. Ohne Zertifikat siehst du die Seite, kannst aber
  nicht aufnehmen.
- **Eine Anmeldung davor.** Die App selbst kennt keine Benutzer: wer die
  Adresse hat, liest die laufende Runde mit und kann sie steuern. In der
  Vorlage erledigt das eine Basis-Anmeldung in Traefik.

Gemessen auf einem 4-vCPU-Xeon (Skylake): **3,3x Echtzeit**, langsamster
Encoder-Durchgang 633 ms bei 1120 ms Budget, 1,3 GB Arbeitsspeicher. Vier
Kerne sind die sinnvolle Untergrenze, zwei reichen nur ohne Puffer.

## Ablauf einer Runde

Die Seite öffnen und **mit dem eigenen Namen beitreten** — mehr braucht es
nicht. Oben steht ein Namensfeld; wer ihn einträgt, sitzt im Kreis und
erscheint bei allen als Name in der Reihe. **Noch jemand an diesem Gerät**
setzt den Nächsten dazu, der am selben Rechner sitzt. Der Browser merkt sich,
wer an diesem Gerät saß: Nach einem Neuladen sind dieselben Menschen wieder da,
ohne Doppelgänger im Kreis.

Danach läuft die Runde auf einer Seite ohne Scrollen — links, was gerade gesagt
wird, rechts der Verlauf.

- **Leertaste** reicht das Mikrofon an die nächste Person weiter: der laufende
  Beitrag wird abgeschlossen, der neue beginnt. Wessen Gerät gerade weg ist,
  wird dabei übersprungen. Ein Klick auf einen Namen springt direkt zu dieser
  Person.
- **Die Reihenfolge lässt sich ziehen**: Einen Namen anfassen und an seinen
  Platz schieben — eine gestrichelte Lücke zeigt, wo er landet. Das geht mit
  der Maus wie mit dem Finger, und alle Geräte sehen die neue Reihe sofort.
- **Esc** beendet den Beitrag, ohne einen neuen zu beginnen.
- **Einrichtung** ändert Titel, Mikrofon, Sprache, Verzögerung oder Redezeit —
  auch mitten in der Runde; die bisherigen Beiträge bleiben stehen. Wer im
  Kreis sitzt, steht dort nicht: Das entscheidet der Beitritt.
- **Neue Runde** schließt das Protokoll ab und fängt leer an. Der Kreis bleibt
  bestehen, das Mikrofon liegt wieder in der Mitte. Die alte Runde bleibt als
  eigene Datei liegen.
- Beiträge im Verlauf lassen sich direkt anklicken und korrigieren.

Der Live-Text zeigt zwei Zustände: heller Text steht fest, grauer Text ist die
noch schwankende Vermutung des Modells.

## Redezeit

In der Einrichtung steht die **Redezeit** je Beitrag, standardmäßig fünf
Minuten; `0` schaltet sie ab. Die Uhr färbt sich in der letzten Minute warm,
danach kräftig, und die Bühne bekommt einen deutlichen Rand. Genau beim
Überschreiten läuft ein weicher Zweiklang — einmal pro Beitrag, kein Alarm.
Weitergereicht wird trotzdem von Hand: die Zeit mahnt, sie unterbricht nicht.

## Ablenkungsfrei

**Nur Sprecher** blendet Live-Text und Verlauf aus: es bleiben der Name in
groß, die Uhr und der Pegel. Mitgeschrieben und gesichert wird unverändert
weiter, ihr seht es nur nicht. Der Modus bleibt im Browser gemerkt, auch über
das Neuladen hinweg, und lässt sich mit demselben Knopf (**Mit Text**) wieder
aufmachen. Zusammen mit **Vollbild** ist das die Ansicht für den Beamer oder
für ein Gerät, das nur die Runde führt.

## Nichts geht verloren

Die Runde wird fortlaufend nach `transcripts/<runde>.md` und `.json`
geschrieben — nach jedem Beitrag und während des Sprechens alle drei Sekunden,
auch wenn gerade niemand redet. Der Fußzeilen-Hinweis nennt die Datei.

**Protokoll laden** holt den Stand jederzeit als Markdown, inklusive des
Beitrags, der gerade läuft (im Export als *spricht noch* markiert). Ihr könnt
also mitten im Kreis exportieren, ohne jemanden zu unterbrechen.

Die Uhrzeiten im Download stehen in der Zeitzone des Geräts, das ihn holt — der
Browser schickt sie mit. Für die Datei, die nebenher auf die Platte geschrieben
wird, entscheidet `TZ` auf dem Server; ohne Angabe ist das im Container UTC.

## Archiv in der App

**Archiv** oben rechts — und **Frühere Runden** auf der Einrichtungsseite, damit
man auch ohne laufenden Kreis hinkommt — zeigt alle bisherigen Runden: links die Liste mit Datum,
Anzahl der Beiträge und den Namen, rechts die gewählte Runde zum Nachlesen.
**Als Markdown laden** holt sie einzeln herunter — in der Zeitzone des Geräts,
das sie abruft.

Gelesen wird direkt aus `transcripts/`. Eine Runde, die noch läuft, ist mit
dabei; der laufende Beitrag ist als *spricht noch* gekennzeichnet.

### Korrigieren

**Bearbeiten** öffnet das ganze Protokoll als Markdown. Überschriften der Form
`## Name · 14:37` trennen die Beiträge — eine zusätzliche Überschrift teilt
einen Block auf. Damit lässt sich der häufigste Fall reparieren: Die Leertaste
kam zu spät, zwei Menschen stecken in einem Beitrag, und einer fehlt im
Protokoll ganz.

Zeitstempel bleiben erhalten, wo Überschrift und bisheriger Beitrag
zusammenpassen. Neue Beiträge bekommen ihre Zeit aus der Überschrift, am
richtigen Kalendertag, auch wenn die Runde über Mitternacht ging.

**Umbenennen** ändert den Titel, **Löschen** legt die Runde in den Papierkorb —
von dort holt sie **Wiederherstellen** zurück.

### Änderungen zurücknehmen

**Verlauf** zeigt jede Änderung an einer Runde mit Zeitpunkt und Beschreibung.
Vor jeder Änderung wird der vorherige Stand vollständig gesichert, und
**Zurücknehmen** stellt ihn wieder her. Die Rücknahme ist selbst ein Schritt im
Verlauf — die Geschichte bleibt vollständig, nichts geht verloren.

Die laufende Runde lässt sich nicht bearbeiten: Sie wird alle drei Sekunden
fortgeschrieben und würde die Korrektur überschreiben. Erst **Neue Runde**,
dann steht sie im Archiv zur Bearbeitung bereit.

## Ins Session-Archiv

Neben `.md` und `.json` schreibt jede Runde eine `.jsonl` im Format des
[Session-Archivs](https://github.com/antontranelis/session-archive): eine Runde
wird zu einer Sitzung, **jeder Sprecher zu einer Rolle**, die erste Zeile trägt
den Titel. Damit landet ein Redekreis in Volltextsuche, Zusammenfassung und
Wissensgraph neben den Claude- und Codex-Sessions — ohne Änderung am Archiv.

```bash
./scripts/ins-archiv.sh                      # ./transcripts → Archiv auf Elis Server
./scripts/ins-archiv.sh /pfad/zu/transcripts eli@host:/pfad/
```

Damit das Archiv die Runden auch anzeigt, braucht es dort einen eigenen Nutzer,
etwa `redekreis:/app/archive/redekreis` in dessen `USERS`.

## Verzögerung

Nemotron ist auf vier Latenzstufen trainiert; die Auswahl steht auf der
Startseite. `1,0 s` liefert exakt den Text der Offline-Erkennung, `sofort`
schreibt schneller mit, korrigiert sich dafür öfter. Für einen Redekreis, in
dem gelesen statt reagiert wird, ist die genaueste Stufe meist die richtige.

## Mehrere Geräte

Alle geöffneten Geräte sehen dieselbe Runde live: Sprecher, laufenden Text und
Verlauf. Weiterreichen und Korrigieren kann jedes davon.

**Den Ton liefert genau ein Gerät** — und zwar das Gerät dessen, der das
Mikrofon gerade hat. Wird weitergereicht, wandert die Aufnahme mit: Das
bisherige Gerät schließt sein Mikrofon, das nächste öffnet seins. Niemand muss
etwas umstellen, und im Fuß steht, woran man ist: *„dieses Gerät nimmt auf"*
oder *„Aufnahme bei Eva"*.

Das ist keine Bequemlichkeit, sondern Bedingung: Vorher schickte jedes offene
Gerät seinen eigenen Ton in denselben Erkennungsstrom. Zwei Geräte bedeuteten
gemessen **vierfache Rechenlast** und zerhackten Text bis hin zu gar keinem.

Beide Fälle funktionieren damit ohne Umschalten:

- **Ein Mikrofon wandert herum, alle sitzen an einem Rechner.** Alle treten an
  diesem Gerät bei, also nimmt es durchgehend auf, egal wer dran ist.
- **Jeder mit dem eigenen Telefon.** Die Aufnahme folgt dem Mikrofon durch den
  Kreis.

**Die Mikrofon-Freigabe wird beim Beitritt geholt, nicht erst beim
Drankommen.** Der Browser fragt genau einmal — auf den Knopfdruck hin, mit dem
man beitritt —, und der Tonstrom bleibt danach offen. So ist die Übergabe
sofort da, statt dass mitten im Satz eine Nachfrage aufgeht und der Anfang
fehlt. Der Pegel zappelt auf jedem beigetretenen Gerät, gesendet wird trotzdem
nur vom Gerät dessen, der dran ist. Der Preis dafür: Der Browser zeigt auf
allen beigetretenen Geräten das Mikrofon-Symbol an, auch auf denen, die gerade
nichts schicken. Wird die Freigabe verweigert, steht es im Fuß — dieses Gerät
kann dann nicht aufnehmen.

**Hier aufnehmen** im Fuß holt den Ton von Hand auf das eigene Gerät. Das ist
der Rückfall für das herumgereichte Mikrofon: Ist der Dranseiende gerade nicht
verbunden — Telefon zugeklappt, Verbindung weg —, liefert weiter das Gerät, das
die Aufnahme zuletzt übernommen hat. Bei der nächsten Übergabe gilt wieder die
Regel, dass das Gerät des Dranseienden aufnimmt.

## Kommen und Gehen

Der Platz im Kreis gehört dem Namen an einem Browser, nicht der Verbindung.
Neuladen, ein zweiter Tab, der Weg über die Einrichtung und zurück, ein
Funkloch — jedes Mal bindet sich derselbe Mensch an seinen Platz zurück, ohne
Doppelgänger und ohne dass er beim Weiterreichen übersprungen wird.

Tragen zwei Menschen an verschiedenen Geräten denselben Namen ein, bekommt der
Zweite **„Name (2)"** und damit einen eigenen Platz. Sonst stünde im Protokoll
der Falsche als Sprecher.

Geht ein Gerät verloren, bleibt der Mensch daran zunächst gedimmt im Kreis
stehen und wird beim Weiterreichen übersprungen. Kommt er **innerhalb von 45
Sekunden** nicht zurück, war es kein Wackler, sondern ein Gehen: Er verlässt
den Kreis. War er gerade dran, wird sein Beitrag abgeschlossen und das Mikrofon
liegt wieder in der Mitte — weitergereicht wird von Hand, ein Sprung zum
Nächsten von selbst wäre überraschend. (`TALKING_CIRCLE_KARENZ_MS` stellt die
Zeit um, die Tests laufen mit wenigen Sekunden.)

Wer bewusst geht, drückt das **×** am eigenen Namen: Der Platz ist sofort frei,
und der Name wird auch im Browser vergessen — sonst säße man nach dem nächsten
Neuladen wieder im Kreis.

## Zweiter Bildschirm

Der Server hört auf allen Schnittstellen (`HOST`, `PORT` setzbar). Weitere
Geräte im selben Netz können `http://<rechner>:8123` öffnen und sehen dieselbe
Runde mit — beitreten und weiterreichen können sie auch. Aufnehmen kann
allerdings nur der Rechner, der die Seite über `localhost` öffnet, weil Browser
das Mikrofon sonst sperren; für alle anderen braucht es HTTPS.

## Aufbau

| Datei | Rolle |
|---|---|
| `server.mjs` | HTTP + WebSocket, verteilt den Zustand an alle Ansichten |
| `circle.mjs` | Der Kreis: Beiträge, Streaming-Sessions, Protokoll auf Platte |
| `model.mjs` | Findet die Modelldatei |
| `public/einrichtung.html/.js` | Eigene Seite für Titel, Mikrofon, Sprache, Redezeit |
| `public/index.html`, `kreis.js` | Die laufende Runde: Bühne links, Verlauf rechts |
| `public/verbindung.js` | Gemeinsame WebSocket-Leitung beider Seiten |
| `protokoll.mjs` | Eine Runde als Markdown — und aus Markdown zurück |
| `archiv.mjs` | Gespeicherte Runden: bearbeiten, umbenennen, löschen, Historie |
| `public/pcm-worklet.js` | Nimmt 16-kHz-Mono in 128-ms-Blöcken ab |

## Lizenz

MIT, siehe [LICENSE](LICENSE). Das Sprachmodell steht unter
[OpenMDW-1.1](https://huggingface.co/nvidia/nemotron-3.5-asr-streaming-0.6b)
und wird nicht mitgeliefert, sondern zur Laufzeit geladen.

## Test

```bash
npm test
```

Startet den echten Server, schickt eine Beispielaufnahme über den WebSocket wie
der Browser es täte und prüft den ganzen Weg: Live-Text, Satzanfang aus dem
Vorlauf und vollständiges Beitragsende; eine neue Runde ohne Verlust der alten;
einen Export mitten im laufenden Beitrag; Archiv und Korrekturen.

Für den Kreis mit mehreren Geräten laufen zwei Leitungen nebeneinander: Nur der
Ton vom Gerät des Dranseienden darf im Protokoll landen, während das andere
Rauschen schickt. Geprüft werden alle drei Fälle — zwei Geräte, zwei Menschen an
einem Gerät, und der Dranseiende ohne Verbindung. `test/kreis.test.mjs` prüft
den Kreis selbst, ohne Modell: Beitritt, Wiederkommen ohne Doppelgänger, die
Reihenfolge über Abwesende hinweg und die Karenzzeit beim Gehen.

`test/ui.test.mjs` geht den Weg, den ein Mensch wirklich geht: zwei Browser als
zwei Geräte, Namen ins Feld tippen, beitreten, **Leertaste** — und prüft, dass
`dran` und die Aufnahme zwischen den Geräten wechseln, dass ein zweiter Tab
niemandem den Platz nimmt, dass das Gehen im Kreis ankommt und dass ein
gezogener Name auf beiden Geräten an seinem neuen Platz steht. Er braucht einen
Chrome auf der Platte (`CHROME_PFAD` setzt den Pfad) und wird übersprungen,
wenn keiner da ist.
