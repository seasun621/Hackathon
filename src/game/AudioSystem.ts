import dashSoundUrl from '../../sound/대쉬.mp3?url';
import ropeRideSoundUrl from '../../sound/로프 타고다닐때.mp3?url';
import ropeAttachSoundUrl from '../../sound/벽에 매달리는 로프 발사.mp3?url';
import musicUrl from '../../sound/브금임시.mp3?url';
import windSoundUrl from '../../sound/활공 바람.mp3?url';
import bombExplosionSoundUrl from '../../sound/폭탄터짐.mp3?url';
import jumpSoundUrl from '../../sound/효과음점프.mp3?url';
import laserSoundUrl from '../../sound/레이저건.mp3?url';
import droneHitSoundUrl from '../../sound/드론 맞는소리.mp3?url';
import droneShootSoundUrl from '../../sound/드론 총소리.mp3?url';
import playerHitSoundUrl from '../../sound/드론한테맞음.mp3?url';

const MUSIC_VOLUME = 0.27;

type OneShotKey =
  | 'ropeAttach'
  | 'dash'
  | 'bomb'
  | 'jump'
  | 'laser'
  | 'droneHit'
  | 'droneShoot'
  | 'playerHit';

interface OneShotVoice {
  audio: HTMLAudioElement;
  active: boolean;
  startedAt: number;
  priority: number;
}

interface OneShotPool {
  voices: OneShotVoice[];
  cooldownMs: number;
  lastPlayedAt: number;
  priority: number;
}

const PRIORITY_PREEMPT_WINDOW_MS = 90;

export class AudioSystem {
  private context: AudioContext | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private readonly music = new Audio(musicUrl);
  private readonly ropeRide = new Audio(ropeRideSoundUrl);
  private readonly wind = new Audio(windSoundUrl);
  private readonly fadeFrames = new Map<HTMLAudioElement, number>();
  private readonly oneShotPools = new Map<OneShotKey, OneShotPool>();
  private readonly lastSyntheticEffectAt = new Map<string, number>();
  private mediaEnabled = false;
  private paused = true;
  private intermission = false;
  private ropeRideRequested = false;
  private windRequested = false;
  private musicPlayPending = false;
  private suppressedOneShots = 0;
  private recycledOneShots = 0;

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
    this.createOneShotPool('ropeAttach', ropeAttachSoundUrl, 3, 80, 2);
    this.createOneShotPool('dash', dashSoundUrl, 2, 120, 3);
    this.createOneShotPool('bomb', bombExplosionSoundUrl, 3, 90, 7);
    this.createOneShotPool('jump', jumpSoundUrl, 2, 120, 3);
    this.createOneShotPool('laser', laserSoundUrl, 3, 55, 2);
    this.createOneShotPool('droneHit', droneHitSoundUrl, 3, 55, 6);
    this.createOneShotPool('droneShoot', droneShootSoundUrl, 4, 70, 1);
    this.createOneShotPool('playerHit', playerHitSoundUrl, 2, 90, 7);
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

  setPaused(paused: boolean): void {
    this.paused = paused;
    if (paused) {
      this.stopOneShots();
      this.fadeElement(this.music, 0, 320, () => {
        if (this.paused) this.music.pause();
      });
      this.fadeAndStopLoop(this.ropeRide, 'rope');
      this.fadeAndStopLoop(this.wind, 'wind');
      return;
    }
    if (!this.mediaEnabled) return;
    this.startMusic();
  }

  getPerformanceStats(): {
    oneShots: number;
    pooledVoices: number;
    suppressedOneShots: number;
    recycledOneShots: number;
    loops: number;
    contextState: string;
  } {
    const loops = [this.music, this.ropeRide, this.wind]
      .reduce((count, audio) => count + (audio.paused ? 0 : 1), 0);
    let oneShots = 0;
    let pooledVoices = 0;
    for (const pool of this.oneShotPools.values()) {
      pooledVoices += pool.voices.length;
      oneShots += pool.voices.reduce((count, voice) => count + (voice.active ? 1 : 0), 0);
    }
    return {
      oneShots,
      pooledVoices,
      suppressedOneShots: this.suppressedOneShots,
      recycledOneShots: this.recycledOneShots,
      loops,
      contextState: this.context?.state ?? 'none',
    };
  }

  setIntermission(active: boolean): void {
    this.intermission = active;
    if (!this.mediaEnabled || this.paused) return;
    this.startMusic();
    this.fadeElement(this.music, active ? MUSIC_VOLUME * 0.42 : MUSIC_VOLUME, active ? 360 : 480);
    if (active) {
      this.fadeAndStopLoop(this.ropeRide, 'rope');
      this.fadeAndStopLoop(this.wind, 'wind');
    }
  }

  setMotionState(
    grappled: boolean,
    airborne: boolean,
    speed: number,
    pulling: boolean,
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
    this.updateLoop(
      this.ropeRide,
      ropeTarget,
      0.82 + speedMix * 0.42 + (pulling ? 0.08 : 0),
      dt,
      'rope',
    );
    this.updateLoop(
      this.wind,
      windTarget,
      0.82 + speedMix * 0.5,
      dt,
      'wind',
    );
    this.music.playbackRate = THREE_MATH_DAMP(
      this.music.playbackRate,
      1,
      4.2,
      dt,
    );
  }

  shoot(weaponId: string): void {
    if (weaponId === 'laser') {
      this.playOneShot('laser', 0.58, 0.98 + Math.random() * 0.04);
      return;
    }
    this.tone(115, 0.075, 'square', 0.075, 48);
    this.noise(0.11, 0.04, 1250);
  }

  attach(): void {
    if (!this.playOneShot('ropeAttach', 0.72, 1)) return;
    this.tone(290, 0.09, 'sine', 0.032, 760);
  }

  detach(): void {
    this.tone(180, 0.07, 'triangle', 0.025, 110);
  }

  hit(): void {
    if (!this.allowSyntheticEffect('hit', 55)) return;
    this.tone(680, 0.09, 'sine', 0.06, 1180);
    window.setTimeout(() => this.tone(920, 0.075, 'sine', 0.035, 1350), 34);
    this.noise(0.12, 0.035, 1250);
  }

  gold(): void {
    if (!this.allowSyntheticEffect('gold', 80)) return;
    this.tone(740, 0.12, 'triangle', 0.065, 1260);
    window.setTimeout(() => this.tone(1120, 0.15, 'sine', 0.045, 1680), 50);
    this.noise(0.2, 0.06, 1700);
  }

  bomb(): void {
    if (!this.playOneShot('bomb', 0.92, 0.88)) return;
    this.tone(92, 0.28, 'sawtooth', 0.09, 34);
    this.noise(0.34, 0.1, 420);
  }

  defuse(): void {
    if (!this.playOneShot('bomb', 0.96, 1.02)) return;
    this.tone(520, 0.11, 'square', 0.06, 980);
    window.setTimeout(() => this.tone(880, 0.14, 'triangle', 0.055, 1480), 45);
    this.noise(0.18, 0.055, 1450);
  }

  fall(): void {
    this.tone(150, 0.36, 'sawtooth', 0.055, 48);
  }

  dash(power = 1): void {
    const duration = 0.34 + power * 0.22;
    if (!this.playOneShot('dash', 0.56 + power * 0.28, 0.94 + power * 0.1)) return;
    this.tone(125, duration, 'sawtooth', 0.045 + power * 0.025, 1050);
    this.tone(58, duration * 0.86, 'triangle', 0.03 + power * 0.018, 280);
    this.noise(duration, 0.045 + power * 0.03, 2400);
  }

  jumpBoost(power = 1): void {
    const duration = 0.32 + power * 0.2;
    if (!this.playOneShot('jump', 0.62 + power * 0.3, 0.94 + power * 0.08)) return;
    this.tone(78, duration, 'sawtooth', 0.035 + power * 0.025, 1280);
    this.noise(duration, 0.035 + power * 0.025, 2100);
  }

  droneShoot(kind: 'scout' | 'assault'): void {
    this.playOneShot(
      'droneShoot',
      kind === 'assault' ? 0.64 : 0.5,
      (kind === 'assault' ? 0.82 : 1.04) + Math.random() * 0.05,
    );
  }

  droneHit(): void {
    this.playOneShot('droneHit', 0.64, 0.95 + Math.random() * 0.1);
  }

  playerHit(): void {
    this.playOneShot('playerHit', 0.78, 0.98);
  }

  land(power = 1): void {
    const amount = Math.min(1, Math.max(0.2, power));
    this.tone(92, 0.11 + amount * 0.08, 'triangle', 0.025 + amount * 0.026, 48);
    this.noise(0.08 + amount * 0.08, 0.018 + amount * 0.024, 520);
  }

  denied(): void {
    this.tone(115, 0.14, 'square', 0.035, 78);
  }

  private startMusic(): void {
    const target = this.intermission ? MUSIC_VOLUME * 0.42 : MUSIC_VOLUME;
    if (!this.music.paused) {
      this.fadeElement(this.music, target, 560);
      return;
    }

    // Apply an audible floor and start the fade immediately. Waiting for the
    // play() promise kept the track at volume 0 while the large MP3 buffered;
    // a later input appeared to "unlock" it only because it started a
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

  private createOneShotPool(
    key: OneShotKey,
    sourceUrl: string,
    size: number,
    cooldownMs: number,
    priority: number,
  ): void {
    const voices = Array.from({ length: size }, () => {
      const audio = new Audio(sourceUrl);
      const voice: OneShotVoice = { audio, active: false, startedAt: 0, priority };
      audio.preload = 'auto';
      audio.addEventListener('ended', () => {
        voice.active = false;
      });
      audio.addEventListener('error', () => {
        voice.active = false;
      });
      audio.load();
      return voice;
    });
    this.oneShotPools.set(key, {
      voices,
      cooldownMs,
      lastPlayedAt: Number.NEGATIVE_INFINITY,
      priority,
    });
  }

  private stopOneShots(): void {
    for (const pool of this.oneShotPools.values()) {
      for (const voice of pool.voices) {
        if (!voice.active) continue;
        voice.audio.pause();
        voice.audio.currentTime = 0;
        voice.active = false;
      }
    }
  }

  private preemptRecentLowerPriority(priority: number, now: number): void {
    for (const pool of this.oneShotPools.values()) {
      if (pool.priority >= priority) continue;
      for (const voice of pool.voices) {
        if (!voice.active || now - voice.startedAt > PRIORITY_PREEMPT_WINDOW_MS) continue;
        voice.audio.pause();
        voice.audio.currentTime = 0;
        voice.active = false;
        this.suppressedOneShots += 1;
      }
    }
  }

  private allowSyntheticEffect(key: string, cooldownMs: number): boolean {
    const now = performance.now();
    const lastPlayedAt = this.lastSyntheticEffectAt.get(key) ?? Number.NEGATIVE_INFINITY;
    if (now - lastPlayedAt < cooldownMs) {
      this.suppressedOneShots += 1;
      return false;
    }
    this.lastSyntheticEffectAt.set(key, now);
    return true;
  }

  private playOneShot(key: OneShotKey, volume: number, playbackRate: number): boolean {
    if (!this.mediaEnabled || this.paused) return false;
    const pool = this.oneShotPools.get(key);
    if (!pool) return false;
    const now = performance.now();
    if (now - pool.lastPlayedAt < pool.cooldownMs) {
      this.suppressedOneShots += 1;
      return false;
    }
    pool.lastPlayedAt = now;
    this.preemptRecentLowerPriority(pool.priority, now);

    let voice = pool.voices.find((candidate) => !candidate.active);
    if (!voice) {
      voice = pool.voices.reduce((oldest, candidate) => (
        candidate.startedAt < oldest.startedAt ? candidate : oldest
      ));
      voice.audio.pause();
      this.recycledOneShots += 1;
    }

    voice.active = true;
    voice.startedAt = now;
    voice.priority = pool.priority;
    voice.audio.currentTime = 0;
    voice.audio.volume = Math.min(1, Math.max(0, volume));
    voice.audio.playbackRate = playbackRate;
    void voice.audio.play().catch(() => {
      voice.active = false;
      // Sound playback may be rejected until the next explicit user gesture.
    });
    return true;
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
