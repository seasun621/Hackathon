export class AudioSystem {
  private context: AudioContext | null = null;
  private noiseBuffer: AudioBuffer | null = null;

  resume(): void {
    if (!this.context) {
      this.context = new AudioContext();
      const sampleCount = Math.floor(this.context.sampleRate * 0.34);
      this.noiseBuffer = this.context.createBuffer(1, sampleCount, this.context.sampleRate);
      const channel = this.noiseBuffer.getChannelData(0);
      for (let index = 0; index < sampleCount; index += 1) channel[index] = Math.random() * 2 - 1;
    }
    if (this.context.state === 'suspended') void this.context.resume();
  }

  shoot(): void {
    this.tone(115, 0.045, 'square', 0.055, 56);
  }

  attach(): void {
    this.tone(290, 0.09, 'sine', 0.05, 760);
  }

  detach(): void {
    this.tone(180, 0.045, 'triangle', 0.025, 110);
  }

  hit(): void {
    this.tone(680, 0.07, 'sine', 0.06, 1180);
    window.setTimeout(() => this.tone(920, 0.055, 'sine', 0.035, 1350), 34);
    this.noise(0.09, 0.035, 1250);
  }

  gold(): void {
    this.tone(740, 0.09, 'triangle', 0.065, 1260);
    window.setTimeout(() => this.tone(1120, 0.12, 'sine', 0.045, 1680), 50);
    this.noise(0.16, 0.06, 1700);
  }

  bomb(): void {
    this.tone(92, 0.22, 'sawtooth', 0.09, 34);
    this.noise(0.28, 0.1, 420);
  }

  defuse(): void {
    this.tone(520, 0.08, 'square', 0.06, 980);
    window.setTimeout(() => this.tone(880, 0.1, 'triangle', 0.055, 1480), 45);
    this.noise(0.14, 0.055, 1450);
  }

  fall(): void {
    this.tone(150, 0.3, 'sawtooth', 0.055, 48);
  }

  dash(power = 1): void {
    const duration = 0.34 + power * 0.22;
    this.tone(125, duration, 'sawtooth', 0.07 + power * 0.035, 1050);
    this.tone(58, duration * 0.86, 'triangle', 0.045 + power * 0.025, 280);
    this.noise(duration, 0.075 + power * 0.045, 2400);
  }

  denied(): void {
    this.tone(115, 0.1, 'square', 0.035, 78);
  }

  private tone(
    startFrequency: number,
    duration: number,
    wave: OscillatorType,
    volume: number,
    endFrequency: number,
  ): void {
    if (!this.context) return;
    const now = this.context.currentTime;
    const oscillator = this.context.createOscillator();
    const gain = this.context.createGain();
    oscillator.type = wave;
    oscillator.frequency.setValueAtTime(startFrequency, now);
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(1, endFrequency), now + duration);
    gain.gain.setValueAtTime(volume, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    oscillator.connect(gain).connect(this.context.destination);
    oscillator.start(now);
    oscillator.stop(now + duration);
  }

  private noise(duration: number, volume: number, frequency: number): void {
    if (!this.context || !this.noiseBuffer) return;
    const now = this.context.currentTime;
    const source = this.context.createBufferSource();
    const filter = this.context.createBiquadFilter();
    const gain = this.context.createGain();
    source.buffer = this.noiseBuffer;
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(frequency, now);
    gain.gain.setValueAtTime(volume, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    source.connect(filter).connect(gain).connect(this.context.destination);
    source.start(now);
    source.stop(now + duration);
  }
}
