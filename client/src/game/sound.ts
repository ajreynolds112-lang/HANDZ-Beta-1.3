import cheer1Url from "@assets/boxing_crowd_cheer_01_1772376394264.mp3";
import cheer2Url from "@assets/boxing_crowd_cheer_2_1772376429169.mp3";
import cheer3Url from "@assets/boxing_crowd_cheer_3_1772376435281.mp3";
import bellUrl from "@assets/boxing_ring_start_1772376833805.mp3";
import jabCleanUrl from "@assets/Jab_Clean_1772377701184.mp3";
import hookCleanUrl from "@assets/Hook_Clean_1772377724366.wav";
import uppercutCleanUrl from "@assets/uppercut_clean_1772377724367.mp3";
import constantCrowdUrl from "@assets/constant_crowd_1772378336545.mp3";
import uiBackUrl from "@assets/back_1781903482541.mp3";
import uiForwardUrl from "@assets/forward_1781907559777.mp3";
import uiStartUrl from "@assets/Start_1781903482542.mp3";
import uiStatsUrl from "@assets/stats_1781907559778.mp3";

export type PunchSoundType = "jab" | "hook" | "uppercut";

type SoundCategory = "master" | "sfx" | "crowd" | "ui";

interface SoundSettings {
  master: number;
  sfx: number;
  crowd: number;
  ui: number;
  muted: boolean;
}

const STORAGE_KEY = "handz_sound_settings";

// Base loudness scale applied to all UI element sounds, on top of the user's
// "ui" volume slider. Lowered so UI clicks sit 20% quieter than their raw level.
const UI_VOLUME_SCALE = 0.8;

function loadSettings(): SoundSettings {
  const defaults: SoundSettings = { master: 0.7, sfx: 0.8, crowd: 0.5, ui: 0.6, muted: false };
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const { music: _dropped, ...rest } = JSON.parse(saved);
      return { ...defaults, ...rest };
    }
  } catch {}
  return defaults;
}

function saveSettings(s: SoundSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {}
}

class SoundEngine {
  private ctx: AudioContext | null = null;
  private settings: SoundSettings;
  private crowdMaster: GainNode | null = null;
  private crowdNode: GainNode | null = null;
  private crowdSource: AudioBufferSourceNode | null = null;
  private crowdNode2: GainNode | null = null;
  private crowdSource2: AudioBufferSourceNode | null = null;
  private crowdPlaying = false;
  private crowdPaused = false;
  private initialized = false;
  private cheerBuffers: [AudioBuffer | null, AudioBuffer | null, AudioBuffer | null] = [null, null, null];
  private bellBuffer: AudioBuffer | null = null;
  private jabBuffer: AudioBuffer | null = null;
  private hookBuffer: AudioBuffer | null = null;
  private uppercutBuffer: AudioBuffer | null = null;
  private crowdAmbientBuffer: AudioBuffer | null = null;
  private uiBackBuffer: AudioBuffer | null = null;
  private uiForwardBuffer: AudioBuffer | null = null;
  private uiStartBuffer: AudioBuffer | null = null;
  private uiStatsBuffer: AudioBuffer | null = null;
  private crowdLoopTimer: ReturnType<typeof setTimeout> | null = null;
  private crowdInitTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.settings = loadSettings();
  }

  private init(): void {
    if (this.initialized) return;
    this.ctx = new AudioContext();
    this.initialized = true;
    this.loadAudioBuffers();
  }

  private ensureCrowdMaster(): GainNode {
    const ctx = this.ensureCtx();
    if (!this.crowdMaster) {
      this.crowdMaster = ctx.createGain();
      this.crowdMaster.gain.value = 1;
      this.crowdMaster.connect(ctx.destination);
    }
    return this.crowdMaster;
  }

  private async loadAudioBuffers(): Promise<void> {
    const ctx = this.ctx;
    if (!ctx) return;
    const uiUrls: [string, "uiBackBuffer" | "uiForwardBuffer" | "uiStartBuffer" | "uiStatsBuffer"][] = [
      [uiBackUrl, "uiBackBuffer"],
      [uiForwardUrl, "uiForwardBuffer"],
      [uiStartUrl, "uiStartBuffer"],
      [uiStatsUrl, "uiStatsBuffer"],
    ];
    for (const [url, key] of uiUrls) {
      try {
        const resp = await fetch(url);
        const arrayBuf = await resp.arrayBuffer();
        this[key] = await ctx.decodeAudioData(arrayBuf);
      } catch {}
    }
    const urls = [cheer1Url, cheer2Url, cheer3Url];
    for (let i = 0; i < 3; i++) {
      try {
        const resp = await fetch(urls[i]);
        const arrayBuf = await resp.arrayBuffer();
        this.cheerBuffers[i] = await ctx.decodeAudioData(arrayBuf);
      } catch {}
    }
    try {
      const resp = await fetch(bellUrl);
      const arrayBuf = await resp.arrayBuffer();
      this.bellBuffer = await ctx.decodeAudioData(arrayBuf);
    } catch {}
    try {
      const resp = await fetch(constantCrowdUrl);
      const arrayBuf = await resp.arrayBuffer();
      this.crowdAmbientBuffer = await ctx.decodeAudioData(arrayBuf);
    } catch {}
    const punchUrls: [string, "jabBuffer" | "hookBuffer" | "uppercutBuffer"][] = [
      [jabCleanUrl, "jabBuffer"],
      [hookCleanUrl, "hookBuffer"],
      [uppercutCleanUrl, "uppercutBuffer"],
    ];
    for (const [url, key] of punchUrls) {
      try {
        const resp = await fetch(url);
        const arrayBuf = await resp.arrayBuffer();
        this[key] = await ctx.decodeAudioData(arrayBuf);
      } catch {}
    }
  }

  private ensureCtx(): AudioContext {
    if (!this.ctx) this.init();
    if (this.ctx!.state === "suspended") this.ctx!.resume();
    return this.ctx!;
  }

  private forceSilent: boolean = false;

  setSilent(silent: boolean): void {
    this.forceSilent = silent;
    if (silent) {
      this.stopCrowdAmbient();
    }
  }

  isSilent(): boolean {
    return this.forceSilent;
  }

  private getVolume(category: SoundCategory): number {
    if (this.forceSilent) return 0;
    if (this.settings.muted) return 0;
    const catVol = this.settings[category];
    return this.settings.master * catVol;
  }

  getSettings(): SoundSettings {
    return { ...this.settings };
  }

  getVolumes(): { master: number; sfx: number; crowd: number; ui: number } {
    return { master: this.settings.master, sfx: this.settings.sfx, crowd: this.settings.crowd, ui: this.settings.ui };
  }

  isMuted(): boolean {
    return this.settings.muted;
  }

  toggleMute(): void {
    this.settings.muted = !this.settings.muted;
    saveSettings(this.settings);
    if (this.crowdNode && this.ctx) {
      this.crowdNode.gain.setTargetAtTime(this.getVolume("crowd") * 0.156, this.ctx.currentTime, 0.1);
    }
  }

  updateSetting(key: keyof SoundSettings, value: number | boolean): void {
    (this.settings as any)[key] = value;
    saveSettings(this.settings);
    if (this.crowdNode) {
      this.crowdNode.gain.setTargetAtTime(this.getVolume("crowd") * 0.156, this.ctx!.currentTime, 0.1);
    }
  }

  private playNoise(duration: number, volume: number, filterFreq: number, filterType: BiquadFilterType = "lowpass", category: SoundCategory = "sfx"): void {
    const ctx = this.ensureCtx();
    const vol = this.getVolume(category) * volume;
    if (vol <= 0) return;

    const bufferSize = Math.floor(ctx.sampleRate * duration);
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1);
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;

    const filter = ctx.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.value = filterFreq;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(vol, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);

    source.connect(filter).connect(gain).connect(ctx.destination);
    source.start();
    source.stop(ctx.currentTime + duration);
  }

  private playTone(freq: number, duration: number, volume: number, type: OscillatorType = "sine", category: SoundCategory = "sfx"): void {
    const ctx = this.ensureCtx();
    const vol = this.getVolume(category) * volume;
    if (vol <= 0) return;

    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(vol, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);

    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + duration);
  }

  private getPunchBuffer(punchType: PunchSoundType): AudioBuffer | null {
    if (punchType === "jab") return this.jabBuffer;
    if (punchType === "hook") return this.hookBuffer;
    return this.uppercutBuffer;
  }

  private playPunchSample(punchType: PunchSoundType, isPlayer: boolean, volumeMult: number = 1, pitchMult: number = 1): void {
    const ctx = this.ensureCtx();
    const buf = this.getPunchBuffer(punchType);
    if (!buf) return;
    const crowdVol = this.getVolume("crowd") * 0.12;
    const sfxVol = this.getVolume("sfx") * 0.12 * volumeMult;
    const vol = Math.min(sfxVol, crowdVol);
    if (vol <= 0) return;

    const source = ctx.createBufferSource();
    source.buffer = buf;
    source.playbackRate.value = (isPlayer ? 1.0 : 0.9) * pitchMult;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(vol, ctx.currentTime);
    source.connect(gain);
    gain.connect(ctx.destination);
    source.start();
  }

  punchLandClean(punchType: PunchSoundType = "jab", isPlayer: boolean = true): void {
    this.playPunchSample(punchType, isPlayer);
  }

  punchLandBlocked(punchType: PunchSoundType = "jab", isPlayer: boolean = true): void {
    this.playPunchSample(punchType, isPlayer, 0.5, 0.5);
  }

  critLand(punchType: PunchSoundType = "jab", isPlayer: boolean = true): void {
    this.playPunchSample(punchType, isPlayer);
    this.playTone(200, 0.15, 0.2, "sawtooth");
    this.playNoise(0.12, 0.25, 1200);
  }

  stunLand(punchType: PunchSoundType = "jab", isPlayer: boolean = true): void {
    this.playPunchSample(punchType, isPlayer);
    const ctx = this.ensureCtx();
    const vol = this.getVolume("sfx") * 0.25;
    if (vol <= 0) return;

    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(400, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(100, ctx.currentTime + 0.2);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(vol, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(vol * 0.5, ctx.currentTime + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);

    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.3);
  }

  chargePunchLand(punchType: PunchSoundType = "jab", isPlayer: boolean = true): void {
    this.playPunchSample(punchType, isPlayer);
    this.playTone(80, 0.2, 0.3, "sawtooth");
    this.playNoise(0.15, 0.35, 600);
    this.playTone(160, 0.12, 0.15, "square");
  }

  punchWhoosh(): void {
    const ctx = this.ensureCtx();
    const vol = this.getVolume("sfx") * 0.08;
    if (vol <= 0) return;

    const bufferSize = Math.floor(ctx.sampleRate * 0.12);
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1);
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;

    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.setValueAtTime(2000, ctx.currentTime);
    filter.frequency.exponentialRampToValueAtTime(800, ctx.currentTime + 0.1);
    filter.Q.value = 2;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.001, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(vol, ctx.currentTime + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.12);

    source.connect(filter).connect(gain).connect(ctx.destination);
    source.start();
    source.stop(ctx.currentTime + 0.15);
  }

  whiff(): void {
    const ctx = this.ensureCtx();
    const vol = this.getVolume("sfx") * 0.06;
    if (vol <= 0) return;

    const bufferSize = Math.floor(ctx.sampleRate * 0.1);
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1);
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;

    const filter = ctx.createBiquadFilter();
    filter.type = "highpass";
    filter.frequency.value = 3000;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(vol, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.08);

    source.connect(filter).connect(gain).connect(ctx.destination);
    source.start();
    source.stop(ctx.currentTime + 0.1);
  }

  bell(): void {
    const ctx = this.ensureCtx();
    const vol = this.getVolume("sfx");
    if (vol <= 0) return;

    if (this.bellBuffer) {
      const source = ctx.createBufferSource();
      source.buffer = this.bellBuffer;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(vol, ctx.currentTime);
      source.connect(gain);
      gain.connect(ctx.destination);
      source.start();
      return;
    }

    const synthVol = vol * 0.35;
    [800, 1200, 1600].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = freq;

      const gain = ctx.createGain();
      const startVol = synthVol * (i === 0 ? 1 : 0.4);
      gain.gain.setValueAtTime(startVol, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 1.5);

      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 1.6);
    });
  }

  knockdown(): void {
    this.playNoise(0.2, 0.4, 400);
    this.playTone(60, 0.3, 0.3, "sine");
    this.playNoise(0.08, 0.3, 800);
  }

  crowdOoh(delay: number = 0): void {
    if (!this.crowdPlaying) return;
    const ctx = this.ensureCtx();
    const vol = this.getVolume("crowd") * 0.2;
    if (vol <= 0) return;

    const startAt = ctx.currentTime + delay;
    const duration = 0.8;
    const bufferSize = Math.floor(ctx.sampleRate * duration);
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1);
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;

    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = 500;
    filter.Q.value = 3;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.001, startAt);
    gain.gain.linearRampToValueAtTime(vol, startAt + 0.1);
    gain.gain.setValueAtTime(vol, startAt + 0.3);
    gain.gain.exponentialRampToValueAtTime(0.001, startAt + duration);

    const master = this.ensureCrowdMaster();
    source.connect(filter).connect(gain).connect(master);
    source.start(startAt);
    source.stop(startAt + duration + 0.05);
  }

  crowdCheer(delay: number = 0): void {
    if (!this.crowdPlaying) return;
    const ctx = this.ensureCtx();
    const vol = this.getVolume("crowd") * 0.24;
    if (vol <= 0) return;

    const startAt = ctx.currentTime + delay;
    const duration = 1.5;
    const bufferSize = Math.floor(ctx.sampleRate * duration);
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1);
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;

    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = 800;
    filter.Q.value = 1.5;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.001, startAt);
    gain.gain.linearRampToValueAtTime(vol, startAt + 0.15);
    gain.gain.setValueAtTime(vol, startAt + 0.6);
    gain.gain.exponentialRampToValueAtTime(0.001, startAt + duration);

    const master = this.ensureCrowdMaster();
    source.connect(filter).connect(gain).connect(master);
    source.start(startAt);
    source.stop(startAt + duration + 0.05);
  }

  private startCrowdLayer(ctx: AudioContext, buf: AudioBuffer, gainNode: GainNode, vol: number, offset: number = 0): AudioBufferSourceNode {
    const source = ctx.createBufferSource();
    source.buffer = buf;
    const clipDur = buf.duration;
    const fadeIn = 3;

    gainNode.gain.setValueAtTime(0, ctx.currentTime);
    gainNode.gain.linearRampToValueAtTime(vol, ctx.currentTime + fadeIn);
    const fadeOutStart = clipDur - 3;
    if (fadeOutStart > fadeIn) {
      gainNode.gain.setValueAtTime(vol, ctx.currentTime + fadeOutStart);
      gainNode.gain.linearRampToValueAtTime(0, ctx.currentTime + clipDur);
    }

    const master = this.ensureCrowdMaster();
    source.connect(gainNode);
    gainNode.connect(master);
    source.start(0, offset);
    return source;
  }

  private scheduleNextCrowdLayer(): void {
    if (!this.crowdPlaying || !this.ctx || !this.crowdAmbientBuffer) return;
    const buf = this.crowdAmbientBuffer;
    const clipDur = buf.duration;
    const overlapTime = 3;
    const nextStartDelay = (clipDur - overlapTime) * 1000;

    this.crowdLoopTimer = setTimeout(() => {
      if (!this.crowdPlaying || !this.ctx || !this.crowdAmbientBuffer) return;
      const vol = this.crowdPaused ? 0 : this.getVolume("crowd") * 0.156;

      try { if (this.crowdSource) { this.crowdSource.stop(); this.crowdSource.disconnect(); } } catch {}
      this.crowdSource = this.crowdSource2;
      this.crowdNode = this.crowdNode2;

      const newGain = this.ctx.createGain();
      const newSource = this.startCrowdLayer(this.ctx, this.crowdAmbientBuffer, newGain, vol);
      this.crowdSource2 = newSource;
      this.crowdNode2 = newGain;

      this.scheduleNextCrowdLayer();
    }, nextStartDelay);
  }

  startCrowdAmbient(): void {
    if (this.crowdPlaying) return;
    const ctx = this.ensureCtx();
    const vol = this.getVolume("crowd") * 0.156;
    if (vol <= 0 && !this.crowdAmbientBuffer) return;

    if (this.crowdAmbientBuffer) {
      const gain1 = ctx.createGain();
      this.crowdSource = this.startCrowdLayer(ctx, this.crowdAmbientBuffer, gain1, vol);
      this.crowdNode = gain1;

      const clipDur = this.crowdAmbientBuffer.duration;
      const overlapTime = 3;
      const secondStart = clipDur - overlapTime;

      this.crowdInitTimer = setTimeout(() => {
        this.crowdInitTimer = null;
        if (!this.crowdPlaying || !this.ctx || !this.crowdAmbientBuffer) return;
        const curVol = this.crowdPaused ? 0 : this.getVolume("crowd") * 0.156;
        const gain2 = this.ctx.createGain();
        this.crowdSource2 = this.startCrowdLayer(this.ctx, this.crowdAmbientBuffer, gain2, curVol);
        this.crowdNode2 = gain2;
        this.scheduleNextCrowdLayer();
      }, secondStart * 1000);

      this.crowdPlaying = true;
      this.crowdPaused = false;
    }
  }

  stopCrowdAmbient(): void {
    if (this.crowdInitTimer) { clearTimeout(this.crowdInitTimer); this.crowdInitTimer = null; }
    if (this.crowdLoopTimer) { clearTimeout(this.crowdLoopTimer); this.crowdLoopTimer = null; }
    if (this.crowdMaster) {
      try { this.crowdMaster.disconnect(); } catch {}
      this.crowdMaster = null;
    }
    try { if (this.crowdSource) { this.crowdSource.stop(0); this.crowdSource.disconnect(); } } catch {}
    try { if (this.crowdSource2) { this.crowdSource2.stop(0); this.crowdSource2.disconnect(); } } catch {}
    if (this.crowdNode) { try { this.crowdNode.disconnect(); } catch {} }
    if (this.crowdNode2) { try { this.crowdNode2.disconnect(); } catch {} }
    this.crowdSource = null;
    this.crowdNode = null;
    this.crowdSource2 = null;
    this.crowdNode2 = null;
    this.crowdPlaying = false;
    this.crowdPaused = false;
  }

  pauseCrowdAmbient(): void {
    if (!this.crowdPlaying || this.crowdPaused) return;
    if (this.crowdNode) this.crowdNode.gain.value = 0;
    if (this.crowdNode2) this.crowdNode2.gain.value = 0;
    this.crowdPaused = true;
  }

  resumeCrowdAmbient(): void {
    if (!this.crowdPlaying || !this.crowdPaused) return;
    const vol = this.getVolume("crowd") * 0.156;
    if (this.crowdNode) this.crowdNode.gain.value = vol;
    if (this.crowdNode2) this.crowdNode2.gain.value = vol;
    this.crowdPaused = false;
  }

  crowdSurge(): void {
    if (!this.crowdPlaying || !this.ctx) return;
    const surgeVol = this.getVolume("crowd") * 0.156 * 1.5;
    if (this.crowdNode) this.crowdNode.gain.setTargetAtTime(surgeVol, this.ctx.currentTime, 0.167);
    if (this.crowdNode2) this.crowdNode2.gain.setTargetAtTime(surgeVol, this.ctx.currentTime, 0.167);
  }

  crowdCalm(): void {
    if (!this.crowdPlaying || !this.ctx) return;
    const baseVol = this.getVolume("crowd") * 0.156;
    if (this.crowdNode) this.crowdNode.gain.setTargetAtTime(baseVol, this.ctx.currentTime, 0.167);
    if (this.crowdNode2) this.crowdNode2.gain.setTargetAtTime(baseVol, this.ctx.currentTime, 0.167);
  }

  playCheer(level: 1 | 2 | 3): void {
    if (!this.crowdPlaying) return;
    const ctx = this.ensureCtx();
    const buf = this.cheerBuffers[level - 1];
    if (!buf) return;
    const vol = this.getVolume("crowd") * 0.8;
    if (vol <= 0) return;

    const source = ctx.createBufferSource();
    source.buffer = buf;
    const gain = ctx.createGain();
    const duration = buf.duration;
    const fadeOut = 0.5;
    gain.gain.setValueAtTime(0, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(vol, ctx.currentTime + 0.2);
    if (duration > fadeOut + 0.2) {
      gain.gain.setValueAtTime(vol, ctx.currentTime + duration - fadeOut);
      gain.gain.linearRampToValueAtTime(0, ctx.currentTime + duration);
    }
    const master = this.ensureCrowdMaster();
    source.connect(gain);
    gain.connect(master);
    source.start();
  }

  trainingPunchHit(): void {
    this.playNoise(0.06, 0.2, 900);
    this.playTone(110, 0.08, 0.15, "sine");
  }

  trainingDing(): void {
    const ctx = this.ensureCtx();
    const vol = this.getVolume("sfx") * 0.3;
    if (vol <= 0) return;

    [1200, 1800].forEach((freq) => {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = freq;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(vol, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.45);
    });
  }

  trainingBuzz(): void {
    const ctx = this.ensureCtx();
    const vol = this.getVolume("sfx") * 0.2;
    if (vol <= 0) return;

    const osc = ctx.createOscillator();
    osc.type = "square";
    osc.frequency.value = 150;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(vol, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.3);
  }

  private playUISample(buffer: AudioBuffer | null): void {
    const ctx = this.ensureCtx();
    if (!buffer) return;
    const vol = this.getVolume("ui") * UI_VOLUME_SCALE;
    if (vol <= 0) return;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(vol, ctx.currentTime);
    source.connect(gain).connect(ctx.destination);
    source.start();
  }

  uiClick(): void {
    this.playUISample(this.uiForwardBuffer);
  }

  uiBack(): void {
    this.playUISample(this.uiBackBuffer);
  }

  uiStart(): void {
    this.playUISample(this.uiStartBuffer);
  }

  uiStatAllocate(): void {
    this.playUISample(this.uiStatsBuffer);
  }

  uiHover(): void {
    this.playTone(500, 0.03, 0.072 * UI_VOLUME_SCALE, "sine", "ui");
  }

  dispose(): void {
    this.stopCrowdAmbient();
    if (this.ctx) {
      this.ctx.close();
      this.ctx = null;
    }
    this.initialized = false;
  }
}

export const soundEngine = new SoundEngine();
