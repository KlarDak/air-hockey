import type { SoundKind } from "./types";

export class SoundSystem {
  private context: AudioContext | null = null;
  private lastContact = 0;
  broadcast: ((kind: SoundKind) => void) | null = null;

  ensure(): AudioContext {
    this.context ??= new AudioContext();
    if (this.context.state === "suspended") void this.context.resume();
    return this.context;
  }

  play(kind: SoundKind, remote = false): void {
    const now = performance.now();
    if (kind !== "goal" && now - this.lastContact < 38) return;
    if (kind !== "goal") this.lastContact = now;
    const context = this.ensure();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const startAt = context.currentTime;
    const settings = kind === "mallet"
      ? { frequency: 175, end: 92, volume: .105, duration: .075, wave: "square" as OscillatorType }
      : kind === "rail"
        ? { frequency: 520, end: 290, volume: .055, duration: .045, wave: "triangle" as OscillatorType }
        : { frequency: 220, end: 720, volume: .13, duration: .3, wave: "sine" as OscillatorType };
    oscillator.type = settings.wave;
    oscillator.frequency.setValueAtTime(settings.frequency, startAt);
    oscillator.frequency.exponentialRampToValueAtTime(settings.end, startAt + settings.duration);
    gain.gain.setValueAtTime(settings.volume, startAt);
    gain.gain.exponentialRampToValueAtTime(.0001, startAt + settings.duration);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start(startAt);
    oscillator.stop(startAt + settings.duration);
    if (!remote) this.broadcast?.(kind);
  }
}
