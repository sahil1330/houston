/** Synthesized sound — no assets. Everything is cosmetic and driven by real sim state. */
class AudioEngine {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private engineGain!: GainNode;
  private engineFilter!: BiquadFilterNode;
  private hissGain!: GainNode;
  private noise!: AudioBuffer;
  private alarmTimer: number | null = null;
  muted = localStorage.getItem("houston.muted") === "1";
  private listeners = new Set<() => void>();

  onChange(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Must be called from a user gesture at least once. */
  unlock() {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.7;
    this.master.connect(ctx.destination);

    const len = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      last = (last + 0.04 * w) / 1.04; // brown-ish noise
      d[i] = last * 6;
    }
    // engine rumble: looping noise → lowpass → gain
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = "lowpass";
    this.engineFilter.frequency.value = 160;
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;
    src.connect(this.engineFilter).connect(this.engineGain).connect(this.master);
    src.start();
    // thruster hiss: looping noise → highpass → gain
    const hs = ctx.createBufferSource();
    hs.buffer = this.noise;
    hs.loop = true;
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 2400;
    this.hissGain = ctx.createGain();
    this.hissGain.gain.value = 0;
    hs.connect(hp).connect(this.hissGain).connect(this.master);
    hs.start();
  }

  setMuted(m: boolean) {
    this.muted = m;
    localStorage.setItem("houston.muted", m ? "1" : "0");
    if (this.ctx) this.master.gain.setTargetAtTime(m ? 0 : 0.7, this.ctx.currentTime, 0.05);
    this.listeners.forEach((l) => l());
  }

  /** Called every frame. throttle 0..1, lateral = a working lateral thruster is firing. */
  engine(throttle: number, lateral: boolean) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.engineGain.gain.setTargetAtTime(throttle * 0.9, t, 0.06);
    this.engineFilter.frequency.setTargetAtTime(110 + throttle * 420, t, 0.08);
    this.hissGain.gain.setTargetAtTime(lateral ? 0.09 : 0, t, 0.03);
  }

  private tone(freq: number, dur: number, type: OscillatorType = "sine", gain = 0.2, delay = 0, slideTo?: number) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime + delay;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(this.master);
    o.start(t0);
    o.stop(t0 + dur + 0.05);
  }

  private burst(dur: number, gain: number, freq: number, delay = 0) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime + delay;
    const s = ctx.createBufferSource();
    s.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.setValueAtTime(freq, t0);
    f.frequency.exponentialRampToValueAtTime(60, t0 + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    s.connect(f).connect(g).connect(this.master);
    s.start(t0);
    s.stop(t0 + dur + 0.05);
  }

  radio() {
    this.tone(1250, 0.05, "square", 0.05);
    this.tone(1650, 0.05, "square", 0.04, 0.07);
  }
  tick() {
    this.tone(880, 0.06, "square", 0.05);
  }
  start() {
    this.tone(220, 0.5, "sawtooth", 0.08, 0, 440);
  }
  alarm(seconds = 3.2) {
    this.stopAlarm();
    if (!this.ctx) return;
    let n = 0;
    const beep = () => {
      this.tone(960, 0.18, "square", 0.12);
      this.tone(720, 0.18, "square", 0.12, 0.2);
      if (++n * 0.42 >= seconds) this.stopAlarm();
    };
    beep();
    this.alarmTimer = window.setInterval(beep, 420);
  }
  stopAlarm() {
    if (this.alarmTimer !== null) clearInterval(this.alarmTimer);
    this.alarmTimer = null;
  }
  touchdown(kind: "LANDED" | "MISSED_ZONE" | "CRASHED" | "LOST") {
    this.engine(0, false);
    if (kind === "CRASHED" || kind === "LOST") {
      this.burst(1.6, 0.9, 1800);
      this.tone(90, 0.9, "sawtooth", 0.2, 0, 30);
    } else {
      this.burst(0.35, 0.5, 600);
      if (kind === "LANDED") {
        [523, 659, 784, 1047].forEach((f, i) => this.tone(f, 0.7, "triangle", 0.14, 0.25 + i * 0.13));
      } else {
        this.tone(330, 0.5, "triangle", 0.12, 0.3);
        this.tone(262, 0.7, "triangle", 0.12, 0.6);
      }
    }
  }
}

export const sound = new AudioEngine();
