// Sammelt den Mikrofon-Ton in Blöcken von 128 ms und schickt sie an den
// Haupt-Thread. Der AudioContext läuft bereits mit 16 kHz, es muss also
// nichts umgerechnet werden.
const BLOCK = 2048; // 128 ms bei 16 kHz

class PcmWorklet extends AudioWorkletProcessor {
  constructor() {
    super();
    this.puffer = new Float32Array(BLOCK);
    this.fuell = 0;
  }

  process(inputs) {
    const kanal = inputs[0]?.[0];
    if (!kanal) return true;
    let gelesen = 0;
    while (gelesen < kanal.length) {
      const n = Math.min(BLOCK - this.fuell, kanal.length - gelesen);
      this.puffer.set(kanal.subarray(gelesen, gelesen + n), this.fuell);
      this.fuell += n;
      gelesen += n;
      if (this.fuell === BLOCK) {
        let summe = 0;
        for (let i = 0; i < BLOCK; i++) summe += this.puffer[i] * this.puffer[i];
        this.port.postMessage(
          { pcm: this.puffer.slice(), pegel: Math.sqrt(summe / BLOCK) },
          [],
        );
        this.fuell = 0;
      }
    }
    return true;
  }
}

registerProcessor("pcm-worklet", PcmWorklet);
