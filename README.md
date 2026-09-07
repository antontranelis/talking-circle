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

Beim ersten Aufruf landet ihr auf der **Einrichtung**: Titel, Namen in der
Reihenfolge des Kreises, Mikrofon, Sprache, Verzögerung. Danach läuft die Runde
auf einer Seite ohne Scrollen — links, was gerade gesagt wird, rechts der
Verlauf.

- **Leertaste** reicht das Mikrofon an die nächste Person weiter: der laufende
  Beitrag wird abgeschlossen, der neue beginnt. Ein Klick auf einen Namen
  springt direkt zu dieser Person.
- **Esc** beendet den Beitrag, ohne einen neuen zu beginnen.
- **Einrichtung** ändert Namen, Titel, Mikrofon oder Sprache mitten in der
  Runde; die bisherigen Beiträge bleiben stehen.
- **Neue Runde** schließt das Protokoll ab und fängt leer an. Die alte Runde
  bleibt als eigene Datei liegen.
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

## Verzögerung

Nemotron ist auf vier Latenzstufen trainiert; die Auswahl steht auf der
Startseite. `1,0 s` liefert exakt den Text der Offline-Erkennung, `sofort`
schreibt schneller mit, korrigiert sich dafür öfter. Für einen Redekreis, in
dem gelesen statt reagiert wird, ist die genaueste Stufe meist die richtige.

## Zweiter Bildschirm

Der Server hört auf allen Schnittstellen (`HOST`, `PORT` setzbar). Weitere
Geräte im selben Netz können `http://<rechner>:8123` öffnen und sehen dieselbe
Runde mit — aufnehmen darf allerdings nur der Rechner, der die Seite über
`localhost` öffnet, weil Browser das Mikrofon sonst sperren.

## Aufbau

| Datei | Rolle |
|---|---|
| `server.mjs` | HTTP + WebSocket, verteilt den Zustand an alle Ansichten |
| `circle.mjs` | Der Kreis: Beiträge, Streaming-Sessions, Protokoll auf Platte |
| `model.mjs` | Findet die Modelldatei |
| `public/einrichtung.html/.js` | Eigene Seite für Namen, Mikrofon, Sprache |
| `public/index.html`, `kreis.js` | Die laufende Runde: Bühne links, Verlauf rechts |
| `public/verbindung.js` | Gemeinsame WebSocket-Leitung beider Seiten |
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
der Browser es täte und prüft drei Dinge: Live-Text, Satzanfang aus dem Vorlauf
und vollständiges Beitragsende; eine neue Runde ohne Verlust der alten; einen
Export mitten im laufenden Beitrag.
