import dashSoundUrl from '../../sound/대쉬.mp3?url';
import ropeRideSoundUrl from '../../sound/로프 타고다닐때.mp3?url';
import ropeAttachSoundUrl from '../../sound/벽에 매달리는 로프 발사.mp3?url';
import musicUrl from '../../sound/브금임시.mp3?url';
import focusSoundUrl from '../../sound/시간정지.mp3?url';
import windSoundUrl from '../../sound/활공 바람.mp3?url';
import bombExplosionSoundUrl from '../../sound/폭탄터짐.mp3?url';
import timerSoundUrl from '../../sound/타이머.mp3?url';

const MUSIC_VOLUME = 0.27;

export class AudioSystem {
  private context: AudioContext | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private readonly music = new Audio(musicUrl);
  private readonly ropeRide = new Audio(ropeRideSoundUrl);
  private readonly wind = new Audio(windSoundUrl);
  private readonly ropeAttach = new Audio(ropeAttachSoundUrl);
  private readonly dashBurst = new Audio(dashSoundUrl);
  private readonly focusBurst = new Audio(focusSoundUrl);
  private readonly bombExplosion = new Audio(bombExplosionSoundUrl);
  private readonly timerEnd = new Audio(timerSoundUrl);
  private readonly fadeFrames = new Map<HTMLAudioElement, number>();
  private mediaEnabled = false;
  private paused = true;
  private focusing = false;
  private ropeRideRequested = false;
  private windRequested = false;
  private timerCueActive = false;
  private musicPlayPending = false;

  constructor() {
    this.music.loop = true;
    this.music.preload = 'auto';
    this.music.volume = 0;
    this.music.load();
    this.ropeRide.loop = true;
    this.ropeRide.preload = 'auto';
    this.ropeRide.volume = 0;
    this.wind.loop = true;
    this.wind.preload = 'auto';
    this.wind.volume = 0;
    this.ropeAttach.preload = 'auto';
    this.dashBurst.preload = 'auto';
    this.focusBurst.preload = 'auto';
    this.bombExplosion.preload = 'auto';
    this.timerEnd.preload = 'auto';
    this.timerEnd.volume = 0.9;
    this.timerEnd.addEventListener('ended', () => {
      this.timerCueActive = false;
      this.timerEnd.currentTime = 0;
    });
  }

  resume(): void {
    if (!this.context) {
      this.context = new AudioContext();
      const sampleCount = Math.floor(this.context.sampleRate * 0.34);
      this.noiseBuffer = this.context.createBuffer(1, sampleCount, this.context.sampleRate);
      const channel = this.noiseBuffer.getChannelData(0);
      for (let index = 0; index < sampleCount; index += 1) channel[index] = Math.random() * 2 - 1;
    }
    if (this.context.state === 'suspended') void this.context.resume();
    this.mediaEnabled = true;
    this.setPaused(false);
  }

  setPaused(paused: boolean, keepTimerCue = false): void {
    this.paused = paused;
    if (paused) {
      this.fadeElement(this.music, 0, 320, () => {
        if (this.paused) this.music.pause();
      });
      this.fadeAndStopLoop(this.ropeRide, 'rope');
      this.fadeAndStopLoop(this.wind, 'wind');
      if (this.timerCueActive && !keepTimerCue) this.timerEnd.pause();
      return;
    }
    if (!this.mediaEnabled) return;
    this.startMusic();
    if (this.timerCueActive && this.timerEnd.paused) {
      void this.timerEnd.play().catch(() => {
        // A later explicit input gesture resumes the paused countdown cue.
      });
    }
  }

  setMotionState(
    grappled: boolean,
    airborne: boolean,
    speed: number,
    pulling: boolean,
    focusing: boolean,
    dt: number,
  ): void {
    const speedMix = Math.min(1, Math.max(0, (speed - 4) / 58));
    const active = this.mediaEnabled && !this.paused;
    const ropeTarget = active && grappled
      ? 0.12 + speedMix * 0.28 + (pulling ? 0.09 : 0)
      : 0;
    const windTarget = active && airborne && !grappled
      ? 0.08 + speedMix * 0.34
      : 0;
    const focusRate = focusing ? 0.76 : 1;
    this.updateLoop(
      this.ropeRide,
      ropeTarget,
      (0.82 + speedMix * 0.42 + (pulling ? 0.08 : 0)) * focusRate,
      dt,
      'rope',
    );
    this.updateLoop(
      this.wind,
      windTarget,
      (0.82 + speedMix * 0.5) * focusRate,
      dt,
      'wind',
    );
    this.music.playbackRate = THREE_MATH_DAMP(
      this.music.playbackRate,
      focusing ? 0.72 : 1,
      4.2,
      dt,
    );
  }

  setFocus(active: boolean): void {
    if (this.focusing === active) return;
    this.focusing = active;
    if (!this.mediaEnabled || this.paused) return;
    if (active) {
      this.playOneShot(this.focusBurst, 0.78, 0.96, 0.07, 0.58);
      this.fadeElement(this.music, 0.19, 260);
    } else {
      this.fadeElement(this.music, MUSIC_VOLUME, 560);
    }
  }

  shoot(): void {
    this.tone(115, 0.045, 'square', 0.055, 56);
  }

  attach(): void {
    this.playOneShot(this.ropeAttach, 0.72, 1, 0.055, 0.42);
    this.tone(290, 0.09, 'sine', 0.032, 760);
  }

  detach(): void {
    this.tone(180, 0.07, 'triangle', 0.025, 110);
  }

  hit(): void {
    this.tone(680, 0.09, 'sine', 0.06, 1180);
    window.setTimeout(() => this.tone(920, 0.075, 'sine', 0.035, 1350), 34);
    this.noise(0.12, 0.035, 1250);
  }

  gold(): void {
    this.tone(740, 0.12, 'triangle', 0.065, 1260);
    window.setTimeout(() => this.tone(1120, 0.15, 'sine', 0.045, 1680), 50);
    this.noise(0.2, 0.06, 1700);
  }

  bomb(): void {
    this.playOneShot(this.bombExplosion, 0.92, 0.88, 0.018, 0.42);
    this.tone(92, 0.28, 'sawtooth', 0.09, 34);
    this.noise(0.34, 0.1, 420);
  }

  defuse(): void {
    this.playOneShot(this.bombExplosion, 0.96, 1.02, 0.018, 0.38);
    this.tone(520, 0.11, 'square', 0.06, 980);
    window.setTimeout(() => this.tone(880, 0.14, 'triangle', 0.055, 1480), 45);
    this.noise(0.18, 0.055, 1450);
  }

  fall(): void {
    this.tone(150, 0.36, 'sawtooth', 0.055, 48);
  }

  dash(power = 1): void {
    const duration = 0.34 + power * 0.22;
    this.playOneShot(this.dashBurst, 0.56 + power * 0.28, 0.94 + power * 0.1, 0.045, 0.34);
    this.tone(125, duration, 'sawtooth', 0.045 + power * 0.025, 1050);
    this.tone(58, duration * 0.86, 'triangle', 0.03 + power * 0.018, 280);
    this.noise(duration, 0.045 + power * 0.03, 2400);
  }

  denied(): void {
    this.tone(115, 0.14, 'square', 0.035, 78);
  }

  startRunEndCue(elapsedSeconds = 0): void {
    if (!this.mediaEnabled || this.paused || this.timerCueActive) return;
    this.timerCueActive = true;
    this.timerEnd.pause();
    this.timerEnd.playbackRate = 1;
    this.timerEnd.volume = 0.9;
    try {
      this.timerEnd.currentTime = Math.max(0, elapsedSeconds);
    } catch {
      this.timerEnd.currentTime = 0;
    }
    void this.timerEnd.play().catch(() => {
      this.timerCueActive = false;
    });
  }

  resetRunEndCue(): void {
    this.timerCueActive = false;
    this.timerEnd.pause();
    this.timerEnd.currentTime = 0;
  }

  private startMusic(): void {
    const target = this.focusing ? 0.19 : MUSIC_VOLUME;
    if (!this.music.paused) {
      this.fadeElement(this.music, target, 560);
      return;
    }

    // Apply an audible floor and start the fade immediately. Waiting for the
    // play() promise kept the track at volume 0 while the large MP3 buffered;
    // the next focus input appeared to "unlock" it only because it started a
    // second volume transition.
    this.music.volume = Math.max(this.music.volume, target * 0.42);
    this.fadeElement(this.music, target, 420);
    if (this.musicPlayPending) return;
    this.musicPlayPending = true;
    void this.music.play().then(() => {
      this.musicPlayPending = false;
      if (!this.paused) this.fadeElement(this.music, target, 320);
    }).catch(() => {
      this.musicPlayPending = false;
      // The next explicit pointer or keyboard gesture retries playback.
    });
  }

  private updateLoop(
    audio: HTMLAudioElement,
    targetVolume: number,
    targetRate: number,
    dt: number,
    kind: 'rope' | 'wind',
  ): void {
    const requested = kind === 'rope' ? this.ropeRideRequested : this.windRequested;
    if (targetVolume > 0) {
      const fadeFrame = this.fadeFrames.get(audio);
      if (fadeFrame !== undefined) {
        cancelAnimationFrame(fadeFrame);
        this.fadeFrames.delete(audio);
      }
    }
    if (targetVolume > 0 && audio.paused && !requested) {
      if (kind === 'rope') this.ropeRideRequested = true;
      else this.windRequested = true;
      void audio.play().then(() => {
        if (kind === 'rope') this.ropeRideRequested = false;
        else this.windRequested = false;
      }).catch(() => {
        if (kind === 'rope') this.ropeRideRequested = false;
        else this.windRequested = false;
      });
    }

    audio.volume = THREE_MATH_DAMP(audio.volume, targetVolume, 4.1, dt);
    audio.playbackRate = THREE_MATH_DAMP(audio.playbackRate, targetRate, 4.8, dt);
    if (targetVolume === 0 && audio.volume < 0.006 && !audio.paused) {
      audio.pause();
      audio.currentTime = 0;
      audio.volume = 0;
    }
  }

  private fadeAndStopLoop(audio: HTMLAudioElement, kind: 'rope' | 'wind'): void {
    this.fadeElement(audio, 0, 520, () => {
      if (!this.paused) return;
      audio.pause();
      audio.currentTime = 0;
      if (kind === 'rope') this.ropeRideRequested = false;
      else this.windRequested = false;
    });
  }

  private fadeElement(
    audio: HTMLAudioElement,
    targetVolume: number,
    durationMs: number,
    onComplete?: () => void,
  ): void {
    const previous = this.fadeFrames.get(audio);
    if (previous !== undefined) cancelAnimationFrame(previous);
    const startVolume = audio.volume;
    const startTime = performance.now();
    const tick = (time: number): void => {
      const progress = Math.min(1, (time - startTime) / Math.max(1, durationMs));
      const eased = 1 - Math.pow(1 - progress, 2);
      audio.volume = startVolume + (targetVolume - startVolume) * eased;
      if (progress < 1) {
        this.fadeFrames.set(audio, requestAnimationFrame(tick));
        return;
      }
      this.fadeFrames.delete(audio);
      onComplete?.();
    };
    this.fadeFrames.set(audio, requestAnimationFrame(tick));
  }

  private playOneShot(
    template: HTMLAudioElement,
    volume: number,
    playbackRate: number,
    fadeInSeconds = 0.045,
    fadeOutSeconds = 0.22,
  ): void {
    if (!this.mediaEnabled || this.paused) return;
    const voice = template.cloneNode(true) as HTMLAudioElement;
    const peakVolume = Math.min(1, Math.max(0, volume));
    voice.volume = 0;
    voice.playbackRate = playbackRate;
    const updateEnvelope = (): void => {
      if (voice.paused || voice.ended) return;
      const fadeIn = Math.min(1, voice.currentTime / Math.max(0.001, fadeInSeconds));
      const remaining = Number.isFinite(voice.duration)
        ? Math.max(0, voice.duration - voice.currentTime)
        : fadeOutSeconds;
      const fadeOut = Math.min(1, remaining / Math.max(0.001, fadeOutSeconds));
      voice.volume = peakVolume * Math.min(fadeIn, fadeOut);
      requestAnimationFrame(updateEnvelope);
    };
    void voice.play().then(() => requestAnimationFrame(updateEnvelope)).catch(() => {
      // Sound playback may be rejected until the next explicit user gesture.
    });
  }

  private tone(
    startFrequency: number,
    duration: number,
    wave: OscillatorType,
    volume: number,
    endFrequency: number,
  ): void {
    if (!this.context || this.paused) return;
    const now = this.context.currentTime;
    const attackEnd = now + Math.min(0.022, duration * 0.22);
    const oscillator = this.context.createOscillator();
    const gain = this.context.createGain();
    oscillator.type = wave;
    oscillator.frequency.setValueAtTime(startFrequency, now);
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(1, endFrequency), now + duration);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, volume), attackEnd);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    oscillator.connect(gain).connect(this.context.destination);
    oscillator.start(now);
    oscillator.stop(now + duration);
  }

  private noise(duration: number, volume: number, frequency: number): void {
    if (!this.context || !this.noiseBuffer || this.paused) return;
    const now = this.context.currentTime;
    const attackEnd = now + Math.min(0.025, duration * 0.2);
    const source = this.context.createBufferSource();
    const filter = this.context.createBiquadFilter();
    const gain = this.context.createGain();
    source.buffer = this.noiseBuffer;
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(frequency, now);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, volume), attackEnd);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    source.connect(filter).connect(gain).connect(this.context.destination);
    source.start(now);
    source.stop(now + duration);
  }
}

function THREE_MATH_DAMP(current: number, target: number, lambda: number, dt: number): number {
  return current + (target - current) * (1 - Math.exp(-lambda * Math.max(0, dt)));
}
