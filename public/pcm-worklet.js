// Sammelt den Mikrofon-Ton in Blöcken von 128 ms (bei 16 kHz) und schickt sie
// an den Haupt-Thread. Der AudioContext läuft mit der Rate des Mikrofons —
// meist 44,1 oder 48 kHz –, denn Firefox verbindet kein Mikrofon mit einem
// Kontext anderer Rate. Umgerechnet wird deshalb hier, linear interpoliert.
const ZIEL_RATE = 16000;
const BLOCK = 2048; // 128 ms bei 16 kHz

// Rechnet einen Strom beliebiger Rate auf 16 kHz um und liefert fertige Blöcke.
export class Umrechner {
  constructor(quellRate) {
    this.schritt = quellRate / ZIEL_RATE;
    this.pos = 1; // Leseposition; Index 0 ist der letzte Wert des vorigen Stücks
    this.letzter = 0;
    this.puffer = new Float32Array(BLOCK);
    this.fuell = 0;
  }

  // Nimmt ein Stück Quellton, ruft `aus(block, pegel)` für jeden vollen Block.
  fuettern(kanal, aus) {
    // Gedacht als Reihe [letzter, ...kanal]: So wird auch der Übergang
    // zwischen zwei Stücken ohne Sprung interpoliert.
    const wert = (i) => (i === 0 ? this.letzter : kanal[i - 1]);
    while (this.pos < kanal.length) {
      const i = Math.floor(this.pos);
      const t = this.pos - i;
      const a = wert(i);
      this.puffer[this.fuell++] = a + (wert(i + 1) - a) * t;
      this.pos += this.schritt;
      if (this.fuell === BLOCK) {
        let summe = 0;
        for (let k = 0; k < BLOCK; k++) summe += this.puffer[k] * this.puffer[k];
        aus(this.puffer.slice(), Math.sqrt(summe / BLOCK));
        this.fuell = 0;
      }
    }
    this.pos -= kanal.length;
    this.letzter = kanal[kanal.length - 1];
  }
}

if (typeof registerProcessor === "function") {
  class PcmWorklet extends AudioWorkletProcessor {
    constructor() {
      super();
      this.umrechner = new Umrechner(sampleRate);
    }

    process(inputs) {
      const kanal = inputs[0]?.[0];
      if (!kanal) return true;
      this.umrechner.fuettern(kanal, (pcm, pegel) => this.port.postMessage({ pcm, pegel }, []));
      return true;
    }
  }

  registerProcessor("pcm-worklet", PcmWorklet);
}
