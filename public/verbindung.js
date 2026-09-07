// Gemeinsame Leitung zum Server für beide Seiten.
let ws = null;
const horcher = new Set();

export function verbinden(beiNachricht) {
  horcher.add(beiNachricht);
  if (ws) return;
  // Hinter HTTPS muss die Leitung wss: sein — sonst blockiert der Browser sie
  // als unsicheren Inhalt und die Seite bleibt stumm.
  const schema = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${schema}//${location.host}`);
  ws.binaryType = "arraybuffer";
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    for (const h of horcher) h(m);
  });
  ws.addEventListener("close", () => {
    for (const h of horcher) h({ typ: "fehler", text: "Verbindung verloren — Seite neu laden." });
  });
}

export const sende = (m) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m));
export const sendeTon = (puffer) => ws?.readyState === WebSocket.OPEN && ws.send(puffer);
export const offen = () => ws?.readyState === WebSocket.OPEN;
