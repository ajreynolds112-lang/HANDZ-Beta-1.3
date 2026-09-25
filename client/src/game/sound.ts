import { MUSIC_TRACK_URLS, FIGHGHT_TRACK_INDEX } from "./musicTracks";
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
  music: number;
  muted: boolean;
}

const STORAGE_KEY = "handz_sound_settings";

// Base loudness scale applied to all UI element sounds, on top of the user's
// "ui" volume slider. Lowered so UI clicks sit 20% quieter than their raw level.
const UI_VOLUME_SCALE = 0.8;

function loadSettings(): SoundSettings {
  const defaults: SoundSettings = { master: 0.7, sfx: 0.8, crowd: 0.5, ui: 0.6, music: 0.7, muted: false };
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) return { ...defaults, ...JSON.parse(saved) };
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

  private getVolume(category: SoundCategory): number {
    if (this.forceSilent) return 0;
    if (this.settings.muted) return 0;
    const catVol = this.settings[category];
    return this.settings.master * catVol;
  }

  getSettings(): SoundSettings {
    return { ...this.settings };
  }

  getVolumes(): { master: number; sfx: number; crowd: number; ui: number; music: number } {
    return { master: this.settings.master, sfx: this.settings.sfx, crowd: this.settings.crowd, ui: this.settings.ui, music: this.settings.music };
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

// ===== MUSIC ENGINE =====

// Cross-instance (and HMR-surviving) registry of every music <audio> element,
// plus a single watchdog that guarantees only one track is ever audible. Stored
// on globalThis so a hot-reloaded module reuses the same registry/watchdog
// instead of leaking a second, still-playing element.
interface MusicGlobal {
  registry: Set<HTMLAudioElement>;
  watchdog: ReturnType<typeof setInterval> | null;
  current: HTMLAudioElement | null;
}

// Dynamic career fight-round music: intensity multipliers applied on top of the
// normal slider volume. Even (base) is intentionally quiet; "losingBadly" mutes.
export const DYNAMIC_MUSIC_LEVELS = {
  losingBadly: 0,
  losing: 0.14,
  even: 0.26,
  winning: 0.36,
  dominating: 0.52,
} as const;

function getMusicGlobal(): MusicGlobal {
  const g = globalThis as unknown as { __handzMusicGlobal?: MusicGlobal };
  if (!g.__handzMusicGlobal) {
    g.__handzMusicGlobal = { registry: new Set(), watchdog: null, current: null };
  }
  return g.__handzMusicGlobal;
}

class MusicEngine {
  private audio: HTMLAudioElement | null = null;
  private shuffleQueue: number[] = [];
  private recentlyPlayed: number[] = [];
  private readonly COOLDOWN = 7;
  private readonly MUSIC_VOL = 0.51;
  private _isPlaying = false;
  private _isPaused = false;
  private fadeInterval: ReturnType<typeof setInterval> | null = null;
  private pendingOp: ReturnType<typeof setTimeout> | null = null;
  private gen = 0;
  private sound: SoundEngine;

  // When set, the engine plays ONLY this track and replays it on "ended"
  // (career sparring + dynamic fight-round music). null = normal shuffle.
  private forcedTrack: number | null = null;
  // Dynamic career fight-round music: drives volume from the live game momentum.
  private dynamicMode = false;
  private dynamicMult = 1;     // current smoothed intensity multiplier
  private dynamicTarget = 1;   // target intensity multiplier (set per frame)
  private duckMult = 1;        // transient stun/crit dip multiplier (1 = none)
  private duckTimer = 0;       // seconds left in the stun/crit duck envelope
  private readonly DYN_APPROACH_RATE = 2.0; // how fast dynamicMult eases to target
  private readonly DUCK_DURATION = 2.0;     // total stun/crit dip-and-return time
  private readonly DUCK_DEPTH = 0.8;        // dip to (1 - depth) of current level

  // Song preview for the career fight-music picker: the track index currently
  // being auditioned (looped) in the picker, or null when not previewing.
  private currentPreviewIdx: number | null = null;

  constructor(sound: SoundEngine) {
    this.sound = sound;
  }

  private getAudio(): HTMLAudioElement {
    if (!this.audio) {
      this.audio = new Audio();
      this.audio.volume = 0;
      getMusicGlobal().registry.add(this.audio);
      this.audio.addEventListener("ended", () => {
        if (this._isPlaying && !this._isPaused) {
          // Natural shuffle progression: start the next song immediately at full
          // volume. Fades are reserved for the game-state transitions only.
          this.nextTrack(0);
        }
      });
    }
    return this.audio;
  }

  private targetVol(): number {
    const s = this.sound.getSettings();
    if (s.muted) return 0;
    return Math.max(0, Math.min(1, s.master * s.music * this.MUSIC_VOL));
  }

  // The actual <audio> volume: the slider-driven base, scaled by the dynamic
  // intensity (career fight-round music) and the transient stun/crit duck. With
  // dynamic mode off, both multipliers are 1 so this equals targetVol().
  private effectiveVol(): number {
    const base = this.targetVol();
    const dyn = this.dynamicMode ? this.dynamicMult : 1;
    return Math.max(0, Math.min(1, base * dyn * this.duckMult));
  }

  // Apply a live volume change while a track is playing
  refreshVolume(): void {
    if (!this._isPlaying || this._isPaused) return;
    this.clearFade();
    const a = this.getAudio();
    a.volume = this.effectiveVol();
  }

  // Re-attempt playback after a user gesture (autoplay policy workaround)
  unlock(): void {
    if (this._isPlaying && !this._isPaused && this.audio && this.audio.paused) {
      this.audio.play().catch(() => {});
      const g = getMusicGlobal();
      g.current = this.audio;
      this.ensureWatchdog();
      this.enforceSinglePlayback();
    }
  }

  private buildQueue(): number[] {
    const n = MUSIC_TRACK_URLS.length;
    const available: number[] = [];
    for (let i = 0; i < n; i++) {
      if (!this.recentlyPlayed.includes(i)) available.push(i);
    }
    for (let i = available.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [available[i], available[j]] = [available[j], available[i]];
    }
    return available;
  }

  private clearFade(): void {
    if (this.fadeInterval) { clearInterval(this.fadeInterval); this.fadeInterval = null; }
  }

  private clearPending(): void {
    if (this.pendingOp) { clearTimeout(this.pendingOp); this.pendingOp = null; }
  }

  // Begin a new exclusive operation: cancel any in-flight fade/timer and bump the
  // generation token. Any previously scheduled callback captures its own token and
  // no-ops once superseded, guaranteeing only one track is ever started at a time.
  private newGen(): number {
    this.clearFade();
    this.clearPending();
    return ++this.gen;
  }

  // Synchronously stop and tear down the single audio element.
  private hardStopAudio(): void {
    if (this.audio) {
      this.audio.pause();
      this.audio.currentTime = 0;
      this.audio.src = "";
    }
    const g = getMusicGlobal();
    if (g.current === this.audio) g.current = null;
    this.stopWatchdog();
  }

  // Run the overlap check continuously while music is active. Idempotent: a
  // single global interval is shared across instances / hot reloads.
  private ensureWatchdog(): void {
    const g = getMusicGlobal();
    if (g.watchdog) return;
    g.watchdog = setInterval(() => this.enforceSinglePlayback(), 100);
  }

  // Stop the shared watchdog once music is fully stopped (no element playing).
  private stopWatchdog(): void {
    const g = getMusicGlobal();
    if (g.watchdog) { clearInterval(g.watchdog); g.watchdog = null; }
  }

  // If more than one track is audible (even for a fraction of a second), keep
  // exactly one and hard-stop the rest. Prefers the engine's current track.
  private enforceSinglePlayback(): void {
    const g = getMusicGlobal();
    const playing: HTMLAudioElement[] = [];
    g.registry.forEach((el) => {
      if (!el.paused && !el.ended) playing.push(el);
    });
    if (playing.length <= 1) return;
    const keep = g.current && playing.includes(g.current)
      ? g.current
      : playing[playing.length - 1];
    for (const el of playing) {
      if (el === keep) continue;
      el.pause();
      try { el.currentTime = 0; } catch {}
      el.src = "";
      g.registry.delete(el);
    }
  }

  // Stop this instance's audio and clear the shared watchdog when the module is
  // hot-replaced, so a stale track can never play under the reloaded engine.
  disposeForHmr(): void {
    this.clearFade();
    this.clearPending();
    const g = getMusicGlobal();
    if (g.watchdog) { clearInterval(g.watchdog); g.watchdog = null; }
    if (this.audio) {
      this.audio.pause();
      this.audio.src = "";
      g.registry.delete(this.audio);
    }
    if (g.current === this.audio) g.current = null;
  }

  private fadeTo(target: number, ms: number): void {
    this.clearFade();
    const a = this.getAudio();
    if (ms <= 0) { a.volume = Math.max(0, Math.min(1, target)); return; }
    const start = a.volume;
    const diff = target - start;
    const steps = Math.max(1, Math.round(ms / 40));
    let step = 0;
    this.fadeInterval = setInterval(() => {
      step++;
      a.volume = Math.max(0, Math.min(1, start + diff * (step / steps)));
      if (step >= steps) this.clearFade();
    }, 40);
  }

  private playIdx(idx: number, fadeMs = 1500): void {
    if (idx < 0 || idx >= MUSIC_TRACK_URLS.length) return;
    const a = this.getAudio();
    a.loop = false; // only the picker preview loops; clear any stale loop flag
    // Hard-stop whatever is currently loaded before swapping the source so the
    // previous track can never keep playing alongside the new one.
    a.pause();
    a.src = MUSIC_TRACK_URLS[idx];
    a.currentTime = 0;
    a.volume = 0;
    a.play().catch(() => {});
    this._isPlaying = true;
    this._isPaused = false;
    const g = getMusicGlobal();
    g.current = a;
    this.ensureWatchdog();
    // Catch any stray/overlapping element right now, not just on the next tick.
    this.enforceSinglePlayback();
    this.recentlyPlayed = [...this.recentlyPlayed.slice(-(this.COOLDOWN - 1)), idx];
    this.fadeTo(this.effectiveVol(), fadeMs);
  }

  private nextTrack(fadeMs = 1500): void {
    if (MUSIC_TRACK_URLS.length === 0) return;
    // Forced mode (sparring / dynamic fight music): always (re)play the one track.
    if (this.forcedTrack != null) {
      this.playIdx(this.forcedTrack, fadeMs);
      return;
    }
    if (this.shuffleQueue.length === 0) {
      this.shuffleQueue = this.buildQueue();
      if (this.shuffleQueue.length === 0) {
        this.recentlyPlayed = [];
        this.shuffleQueue = this.buildQueue();
      }
    }
    const idx = this.shuffleQueue.shift()!;
    this.playIdx(idx, fadeMs);
  }

  isPlaying(): boolean { return this._isPlaying; }

  // Reset forced-track and dynamic-volume state back to plain shuffle behaviour.
  private clearDynamicMode(): void {
    this.forcedTrack = null;
    this.dynamicMode = false;
    this.dynamicMult = 1;
    this.dynamicTarget = 1;
    this.duckMult = 1;
    this.duckTimer = 0;
  }

  start(fadeMs = 1500): void {
    if (MUSIC_TRACK_URLS.length === 0) return;
    // Leaving any forced/dynamic mode: tear it down and start a fresh shuffle
    // track even if a (forced/dynamic) track is currently playing.
    if (this.forcedTrack != null || this.dynamicMode) {
      this.clearDynamicMode();
      this.newGen();
      this.nextTrack(fadeMs);
      return;
    }
    if (this._isPlaying && !this._isPaused) return;
    if (this._isPaused) { this.resume(); return; }
    this.newGen();
    this.nextTrack(fadeMs);
  }

  stop(fadeMs = 2000): void {
    if (!this._isPlaying) { this.clearDynamicMode(); return; }
    const gen = this.newGen();
    this._isPlaying = false;
    this.clearDynamicMode();
    this.fadeTo(0, fadeMs);
    this.pendingOp = setTimeout(() => {
      if (gen !== this.gen) return;
      this.hardStopAudio();
      this._isPaused = false;
    }, fadeMs + 100);
  }

  fastFadeAndReset(): void {
    const gen = this.newGen();
    this._isPlaying = false;
    this.clearDynamicMode();
    this.fadeTo(0, 500);
    this.recentlyPlayed = [];
    this.shuffleQueue = [];
    this.pendingOp = setTimeout(() => {
      if (gen !== this.gen) return;
      this.hardStopAudio();
      this._isPaused = false;
    }, 600);
  }

  // ===== Forced track + dynamic career fight-round music =====

  // Play exactly one track on a loop at the normal slider volume (career sparring
  // plays only "FIGHGHT"). Not dynamic — volume stays constant.
  startForced(idx: number, fadeMs = 1000): void {
    if (idx < 0 || idx >= MUSIC_TRACK_URLS.length) return;
    this.newGen();
    this.clearDynamicMode();
    this.forcedTrack = idx;
    this._isPaused = false;
    this.playIdx(idx, fadeMs);
  }

  // Begin the dynamic fight-round music: loops the FIGHGHT track and ramps its
  // volume up from silence to the quiet base level. Per-frame volume is then
  // driven by setDynamicTarget()/updateDynamic()/triggerDuck(). Idempotent while
  // already running so re-firing effects don't restart the song.
  startDynamicCareer(trackIdx: number = FIGHGHT_TRACK_INDEX): void {
    const idx = (trackIdx >= 0 && trackIdx < MUSIC_TRACK_URLS.length) ? trackIdx : FIGHGHT_TRACK_INDEX;
    if (idx < 0 || idx >= MUSIC_TRACK_URLS.length) return;
    if (this.dynamicMode && this._isPlaying && !this._isPaused && this.forcedTrack === idx) return;
    this.newGen();
    this.forcedTrack = idx;
    this.dynamicMode = true;
    this.dynamicMult = 0; // ramp up from silence via updateDynamic
    this.dynamicTarget = DYNAMIC_MUSIC_LEVELS.even;
    this.duckMult = 1;
    this.duckTimer = 0;
    this._isPaused = false;
    this.playIdx(idx, 0); // dynamicMult 0 => starts silent; per-frame ramps it in
  }

  // Set the target intensity multiplier (one of DYNAMIC_MUSIC_LEVELS).
  setDynamicTarget(mult: number): void {
    this.dynamicTarget = Math.max(0, mult);
  }

  // Trigger the stun/crit dip: volume eases down then back over DUCK_DURATION.
  triggerDuck(): void {
    if (!this.dynamicMode) return;
    this.duckTimer = this.DUCK_DURATION;
  }

  // Per-frame driver (called from the game loop). Eases the intensity toward its
  // target and advances the duck envelope, then writes the audio volume.
  updateDynamic(dt: number): void {
    if (!this.dynamicMode || !this._isPlaying || this._isPaused) return;
    const approach = Math.max(0, Math.min(1, this.DYN_APPROACH_RATE * dt));
    this.dynamicMult += (this.dynamicTarget - this.dynamicMult) * approach;
    if (this.duckTimer > 0) {
      this.duckTimer = Math.max(0, this.duckTimer - dt);
      const e = (this.DUCK_DURATION - this.duckTimer) / this.DUCK_DURATION; // 0..1
      this.duckMult = 1 - this.DUCK_DEPTH * Math.sin(Math.PI * e);
    } else {
      this.duckMult = 1;
    }
    // Don't fight an in-flight fade (e.g. the resume ramp); it hands back to us.
    if (!this.fadeInterval) {
      this.getAudio().volume = this.effectiveVol();
    }
  }

  // Fade the dynamic music out and return to plain (non-forced) behaviour.
  stopDynamic(fadeMs = 600): void {
    if (!this.dynamicMode && this.forcedTrack == null) return;
    this.stop(fadeMs);
  }

  // ===== Song preview (career fight-music picker) =====

  // Loop one track at the normal slider volume so the picker can audition it.
  // Reuses the single audio element (so the global watchdog never kills it) and
  // sets loop=true so the "ended" handler doesn't advance the shuffle.
  previewPlay(idx: number): void {
    if (idx < 0 || idx >= MUSIC_TRACK_URLS.length) return;
    this.newGen();
    this.clearDynamicMode();
    this.currentPreviewIdx = idx;
    this._isPaused = false;
    const a = this.getAudio();
    a.loop = true;
    a.pause();
    a.src = MUSIC_TRACK_URLS[idx];
    a.currentTime = 0;
    a.volume = 0;
    a.play().catch(() => {});
    this._isPlaying = true;
    const g = getMusicGlobal();
    g.current = a;
    this.ensureWatchdog();
    this.enforceSinglePlayback();
    this.fadeTo(this.targetVol(), 250);
  }

  // Stop the current preview (fade out + pause). Leaves the picker free to resume
  // or restart the shuffle when it closes.
  previewStop(): void {
    if (this.currentPreviewIdx == null) return;
    this.currentPreviewIdx = null;
    const gen = this.newGen();
    this._isPlaying = false;
    this.fadeTo(0, 150);
    this.pendingOp = setTimeout(() => {
      if (gen !== this.gen) return;
      if (this.audio) { this.audio.pause(); this.audio.loop = false; }
    }, 170);
  }

  // Restart the shuffle but play `idx` first, then continue the normal shuffle on
  // the next transition. If that track is already previewing, hand it back to the
  // shuffle seamlessly (no restart blip).
  restartShuffleFrom(idx: number, fadeInMs = 800): void {
    if (idx < 0 || idx >= MUSIC_TRACK_URLS.length) { this.start(fadeInMs); return; }
    this.clearDynamicMode();
    if (this.currentPreviewIdx === idx && this._isPlaying && this.audio && !this.audio.paused) {
      this.currentPreviewIdx = null;
      this.newGen();
      this.audio.loop = false;
      this._isPaused = false;
      this.recentlyPlayed = [idx];
      this.shuffleQueue = [];
      this.fadeTo(this.targetVol(), fadeInMs);
      return;
    }
    this.currentPreviewIdx = null;
    this.newGen();
    this._isPaused = false;
    this.recentlyPlayed = [];
    this.shuffleQueue = [];
    if (this.audio) this.audio.loop = false;
    this.playIdx(idx, fadeInMs);
  }

  // Fade the current track out, reset the shuffle, then fade a fresh track in —
  // all as a single tracked operation (used for sparring start). Because it is
  // generation-guarded, a newer transition cancels the pending start instead of
  // letting a second song begin on top of it.
  restartShuffle(fadeOutMs = 500, delayMs = 650, fadeInMs = 1000): void {
    const gen = this.newGen();
    this._isPlaying = false;
    this.clearDynamicMode();
    this.fadeTo(0, fadeOutMs);
    this.recentlyPlayed = [];
    this.shuffleQueue = [];
    this.pendingOp = setTimeout(() => {
      if (gen !== this.gen) return;
      this.hardStopAudio();
      this._isPaused = false;
      this.nextTrack(fadeInMs);
    }, delayMs);
  }

  skipToNext(fadeOutMs = 2000, fadeInMs = 1500): void {
    if (!this._isPlaying) { this.start(fadeInMs); return; }
    const gen = this.newGen();
    this._isPlaying = false;
    this.clearDynamicMode();
    this.fadeTo(0, fadeOutMs);
    this.pendingOp = setTimeout(() => {
      if (gen !== this.gen) return;
      this.hardStopAudio();
      this._isPaused = false;
      this.nextTrack(fadeInMs);
    }, fadeOutMs + 50);
  }

  pause(): void {
    if (!this._isPlaying || this._isPaused) return;
    const gen = this.newGen();
    this._isPaused = true;
    this.fadeTo(0, 350);
    this.pendingOp = setTimeout(() => {
      if (gen !== this.gen) return;
      if (this._isPaused && this.audio) this.audio.pause();
    }, 400);
  }

  resume(): void {
    if (!this._isPlaying || !this._isPaused) return;
    this.newGen();
    this._isPaused = false;
    const a = this.getAudio();
    a.play().catch(() => {});
    const g = getMusicGlobal();
    g.current = a;
    this.ensureWatchdog();
    this.enforceSinglePlayback();
    this.fadeTo(this.effectiveVol(), 350);
  }
}

export const musicEngine = new MusicEngine(soundEngine);

// Dev-only: when this module is hot-replaced, tear down the previous engine's
// audio + watchdog so a second music track can never stack on top of the first.
const hmr = (import.meta as { hot?: { dispose: (cb: () => void) => void } }).hot;
if (hmr) {
  hmr.dispose(() => {
    musicEngine.disposeForHmr();
  });
}
