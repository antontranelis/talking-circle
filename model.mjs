// Auffinden der Modelldatei. Nemotron liegt in der Regel schon im HF-Cache,
// weil Handy es dort ablegt; sonst zieht der Nutzer sie einmalig selbst.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const REPO = "models--handy-computer--nemotron-3.5-asr-streaming-0.6b-gguf";
const PREFER = ["Q8_0", "Q6_K", "F16", "Q5_K_M", "Q4_K_M", "F32"];

function fromHfCache() {
  const hub = path.join(os.homedir(), ".cache", "huggingface", "hub", REPO, "snapshots");
  if (!fs.existsSync(hub)) return null;
  const found = [];
  for (const snap of fs.readdirSync(hub)) {
    const dir = path.join(hub, snap);
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith(".gguf")) found.push(path.join(dir, f));
    }
  }
  found.sort((a, b) => rank(a) - rank(b));
  return found[0] ?? null;
}

function rank(file) {
  const i = PREFER.findIndex((q) => file.includes(q));
  return i === -1 ? PREFER.length : i;
}

export function resolveModel() {
  const fromEnv = process.env.TALKING_CIRCLE_MODEL;
  if (fromEnv) {
    if (!fs.existsSync(fromEnv)) throw new Error(`TALKING_CIRCLE_MODEL zeigt ins Leere: ${fromEnv}`);
    return fromEnv;
  }
  const cached = fromHfCache();
  if (cached) return cached;
  throw new Error(
    "Kein Nemotron-Modell gefunden. Entweder einmal mit Handy laden lassen oder:\n" +
      "  huggingface-cli download handy-computer/nemotron-3.5-asr-streaming-0.6b-gguf " +
      "nemotron-3.5-asr-streaming-0.6b-Q8_0.gguf\n" +
      "und den Pfad in TALKING_CIRCLE_MODEL setzen.",
  );
}
