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
import usss1Url from "@assets/Usss_1_1791661210965.mp3";
import usss2Url from "@assets/Usss_2_1791661455435.wav";
import usss3Url from "@assets/Usss_3_1791661294676.mp3";
import usss5Url from "@assets/Usss_5_1791661268080.wav";
import usss6Url from "@assets/Usss_6_1791661398857.mp3";
import usss7Url from "@assets/Usss_7_1791661431154.mp3";
import usssChargeUrl from "@assets/Usss_Charge_Punch_1791661217318.wav";
import critUrl from "@assets/Crit_1791662425096.mp3";
import stunUrl from "@assets/Stun_1791662097304.mp3";
import dodgeLeftUrl from "@assets/Dodge_1_1791662121931.mp3";
import dodgeRightUrl from "@assets/Dodge_2_1791662124450.mp3";
import counterWindowUrl from "@assets/Counter_window_1791662127358.mp3";
import refCount1Url from "@assets/referee/ref_count_01.mp3";
import refCount2Url from "@assets/referee/ref_count_02.mp3";
import refCount3Url from "@assets/referee/ref_count_03.mp3";
import refCount4Url from "@assets/referee/ref_count_04.mp3";
import refCount5Url from "@assets/referee/ref_count_05.mp3";
import refCount6Url from "@assets/referee/ref_count_06.mp3";
import refCount7Url from "@assets/referee/ref_count_07.mp3";
import refCount8Url from "@assets/referee/ref_count_08.mp3";
import refCount9Url from "@assets/referee/ref_count_09.mp3";
import refCount10Url from "@assets/referee/ref_count_10.mp3";
import refOver1Url from "@assets/referee/ref_over_1.mp3";
import refOver2Url from "@assets/referee/ref_over_2.mp3";
import refKd1Url from "@assets/referee/ref_kd_1.mp3";
import refKd2Url from "@assets/referee/ref_kd_2.mp3";
import refKd3StopUrl from "@assets/referee/ref_kd_3_stop.mp3";
import refKd3Url from "@assets/referee/ref_kd_3.mp3";
import refIntroUrl from "@assets/referee/ref_intro.mp3";
import { EQ_BANDS, getSoundEqConfig, type SoundEq } from "@/lib/soundEqConfig";

export type PunchSoundType = "jab" | "hook" | "uppercut";

const FIGHT_FX = {
  usss1: usss1Url, usss2: usss2Url, usss3: usss3Url, usss5: usss5Url, usss6: usss6Url, usss7: usss7Url,
  usssCharge: usssChargeUrl, crit: critUrl, stun: stunUrl, dodgeLeft: dodgeLeftUrl, dodgeRight: dodgeRightUrl, counterWindow: counterWindowUrl,
  refCount1: refCount1Url, refCount2: refCount2Url, refCount3: refCount3Url, refCount4: refCount4Url, refCount5: refCount5Url, refCount6: refCount6Url, refCount7: refCount7Url, refCount8: refCount8Url, refCount9: refCount9Url, refCount10: refCount10Url,
  refOver1: refOver1Url, refOver2: refOver2Url, refKd1: refKd1Url, refKd2: refKd2Url, refKd3Stop: refKd3StopUrl, refKd3: refKd3Url, refIntro: refIntroUrl,
};
type FightFx = keyof typeof FIGHT_FX;

/** Every recorded sound, for the EQ / pitch editor. */
export const SOUND_LABELS = {
  usss1: "Usss 1", usss2: "Usss 2", usss3: "Usss 3", usss5: "Usss 5", usss6: "Usss 6", usss7: "Usss 7",
  usssCharge: "Usss Charge Punch", jab: "Jab Land", hook: "Hook Land", uppercut: "Uppercut Land",
  crit: "Crit", stun: "Stun", dodgeLeft: "Dodge Left", dodgeRight: "Dodge Right", counterWindow: "Counterpunch Window",
  bell: "Bell", crowdAmbient: "Crowd Ambient", cheer1: "Cheer 1", cheer2: "Cheer 2", cheer3: "Cheer 3",
  uiForward: "UI Forward", uiBack: "UI Back", uiStart: "UI Start", uiStats: "UI Stats",
  refCount1: "Ref Count 1", refCount2: "Ref Count 2", refCount3: "Ref Count 3", refCount4: "Ref Count 4", refCount5: "Ref Count 5", refCount6: "Ref Count 6", refCount7: "Ref Count 7", refCount8: "Ref Count 8", refCount9: "Ref Count 9", refCount10: "Ref Count 10",
  refOver1: "Ref That's It", refOver2: "Ref It's Over", refKd1: "Ref KD 1 Good To Go", refKd2: "Ref KD 2 Able To Continue", refKd3Stop: "Ref KD 3 Stopping Fight", refKd3: "Ref KD 3 Fight Back", refIntro: "Ref Instructions",
} as const;
export type SoundId = keyof typeof SOUND_LABELS;
const pick = <T,>(a: T[]): T => a[Math.floor(Math.random() * a.length)];

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
  private fx: Partial<Record<FightFx, AudioBuffer>> = {};
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
    for (const [key, url] of Object.entries(FIGHT_FX) as [FightFx, string][]) {
      try {
        this.fx[key] = await ctx.decodeAudioData(await (await fetch(url)).arrayBuffer());
      } catch {}
    }
    for (const e of Object.values(getSoundEqConfig())) if (e.file) void this.loadFile(e.file);
  }

  /** Decoded replacement recordings (Sound EQ card uploads), keyed by URL. */
  private replaced = new Map<string, AudioBuffer>();
  private loadingFiles = new Map<string, Promise<void>>();
  loadFile(url: string): Promise<void> {
    if (this.replaced.has(url)) return Promise.resolve();
    let p = this.loadingFiles.get(url);
    if (!p) {
      const ctx = this.ensureCtx();
      p = fetch(url).then(r => r.arrayBuffer()).then(b => ctx.decodeAudioData(b))
        .then(buf => { this.replaced.set(url, buf); })
        .catch(() => {})
        .finally(() => { this.loadingFiles.delete(url); });
      this.loadingFiles.set(url, p);
    }
    return p;
  }

  /** Editor preview: the sound being auditioned plays with these unsaved settings. */
  private eqOverride: { id: SoundId; eq: SoundEq } | null = null;
  private eqOf(id: SoundId): SoundEq | undefined {
    return this.eqOverride?.id === id ? this.eqOverride.eq : getSoundEqConfig()[id];
  }
  /** Playback-rate multiplier for the sound's fine pitch. */
  private rate(id: SoundId): number {
    return 2 ** ((this.eqOf(id)?.pitch ?? 0) / 12);
  }
  /** The input node for sound `id`: its 7-band EQ into `dest` (just `dest` when flat). */
  private eq(id: SoundId, dest: AudioNode): AudioNode {
    const e = this.eqOf(id);
    if (!e || e.gains.every(g => g === 0) || !this.ctx) return dest;
    let next = dest;
    for (let i = EQ_BANDS.length - 1; i >= 0; i--) {
      const f = this.ctx.createBiquadFilter();
      f.type = i === 0 ? "lowshelf" : i === EQ_BANDS.length - 1 ? "highshelf" : "peaking";
      f.frequency.value = EQ_BANDS[i];
      f.gain.value = e.gains[i];
      f.connect(next);
      next = f;
    }
    return next;
  }
  /** The recording sound `id` plays: its uploaded replacement once decoded, else the built-in one. */
  private bufferOf(id: SoundId): AudioBuffer | null | undefined {
    const file = this.eqOf(id)?.file;
    if (file) {
      const b = this.replaced.get(file);
      if (b) return b;
      void this.loadFile(file);
    }
    switch (id) {
      case "cheer1": return this.cheerBuffers[0];
      case "cheer2": return this.cheerBuffers[1];
      case "cheer3": return this.cheerBuffers[2];
      case "bell": return this.bellBuffer;
      case "jab": return this.jabBuffer;
      case "hook": return this.hookBuffer;
      case "uppercut": return this.uppercutBuffer;
      case "crowdAmbient": return this.crowdAmbientBuffer;
      case "uiForward": return this.uiForwardBuffer;
      case "uiBack": return this.uiBackBuffer;
      case "uiStart": return this.uiStartBuffer;
      case "uiStats": return this.uiStatsBuffer;
      default: return this.fx[id];
    }
  }
  /** Plays one recorded sound with unsaved EQ / pitch (long sounds cut at 4s). */
  async previewSound(id: SoundId, eq: SoundEq): Promise<void> {
    const ctx = this.ensureCtx();
    if (eq.file) await this.loadFile(eq.file);
    this.eqOverride = { id, eq };
    const buf = this.bufferOf(id);
    const vol = this.settings.muted ? 0 : this.settings.master * 0.6;
    if (!buf || vol <= 0) { this.eqOverride = null; return; }
    const source = ctx.createBufferSource();
    source.buffer = buf;
    source.playbackRate.value = this.rate(id);
    const gain = ctx.createGain();
    gain.gain.value = vol;
    source.connect(gain).connect(this.eq(id, ctx.destination));
    source.start();
    source.stop(ctx.currentTime + 4);
    this.eqOverride = null;
  }

  private playFx(key: FightFx, volume = 0.5): AudioBufferSourceNode | null {
    const ctx = this.ensureCtx();
    const buf = this.bufferOf(key);
    const vol = this.getVolume("sfx") * volume;
    if (!buf || vol <= 0) return null;
    const source = ctx.createBufferSource();
    source.buffer = buf;
    source.playbackRate.value = this.rate(key);
    const gain = ctx.createGain();
    gain.gain.value = vol;
    source.connect(gain).connect(this.eq(key, ctx.destination));
    source.start();
    return source;
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
    return this.bufferOf(punchType) ?? null;
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
    source.playbackRate.value = (isPlayer ? 1.0 : 0.9) * pitchMult * this.rate(punchType);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(vol, ctx.currentTime);
    source.connect(gain);
    gain.connect(this.eq(punchType, ctx.destination));
    source.start();
  }

  punchLandClean(punchType: PunchSoundType = "jab", isPlayer: boolean = true): void {
    this.playPunchSample(punchType, isPlayer);
  }

  punchLandBlocked(punchType: PunchSoundType = "jab", isPlayer: boolean = true): void {
    this.playPunchSample(punchType, isPlayer, 0.5, 0.5);
  }

  critLand(_punchType: PunchSoundType = "jab", _isPlayer: boolean = true): void {
    this.playFx("crit");
  }

  stunLand(_punchType: PunchSoundType = "jab", _isPlayer: boolean = true): void {
    this.playFx("stun");
  }

  chargePunchLand(punchType: PunchSoundType = "jab", isPlayer: boolean = true): void {
    this.playPunchSample(punchType, isPlayer);
    this.playTone(80, 0.2, 0.3, "sawtooth");
    this.playNoise(0.15, 0.35, 600);
    this.playTone(160, 0.12, 0.15, "square");
  }

  /** Plays as the punch starts extending. */
  punchWhoosh(punch: string | null, isPlayer: boolean, charged: boolean, gymScene = false): void {
    const upOrHook = !!punch && (punch.includes("Hook") || punch.includes("Uppercut"));
    const key: FightFx = charged ? "usssCharge"
      : punch === "jab" ? (isPlayer ? pick<FightFx>(["usss1", "usss5"]) : "usss6")
      : upOrHook ? (isPlayer ? pick<FightFx>(["usss2", "usss5"]) : "usss7")
      : pick<FightFx>(["usss5", "usss3"]);
    this.playFx(key, gymScene ? 0.08 : 0.2);
  }

  dodge(side: "left" | "right"): void {
    this.playFx(side === "left" ? "dodgeLeft" : "dodgeRight", 0.35);
  }

  counterWindow(): void {
    this.playFx("counterWindow");
  }

  bell(): void {
    const ctx = this.ensureCtx();
    const vol = this.getVolume("sfx");
    if (vol <= 0) return;

    const bellBuf = this.bufferOf("bell");
    if (bellBuf) {
      const source = ctx.createBufferSource();
      source.buffer = bellBuf;
      source.playbackRate.value = this.rate("bell");
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(vol, ctx.currentTime);
      source.connect(gain);
      gain.connect(this.eq("bell", ctx.destination));
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

  /** Referee's knockdown count voice line, 1-10. */
  refCount(n: number): void {
    if (n < 1 || n > 10) return;
    this.playFx(`refCount${n}` as FightFx, 0.9);
  }

  /** Plays a referee voice line; returns its length in seconds (0 when it can't be heard). */
  refLine(key: "refOver1" | "refOver2" | "refKd1" | "refKd2" | "refKd3Stop" | "refKd3" | "refIntro"): number {
    const buf = this.bufferOf(key);
    if (!buf || this.getVolume("sfx") <= 0) return 0;
    this.refSource = this.playFx(key, 0.9);
    return buf.duration / this.rate(key);
  }

  private refSource: AudioBufferSourceNode | null = null;
  /** Cuts off the referee line that is playing (e.g. the ring walk was skipped). */
  stopRefLine(): void {
    try { this.refSource?.stop(); } catch {}
    this.refSource = null;
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
    source.playbackRate.value = this.rate("crowdAmbient");
    const clipDur = buf.duration / this.rate("crowdAmbient");
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
    gainNode.connect(this.eq("crowdAmbient", master));
    source.start(0, offset);
    return source;
  }

  private scheduleNextCrowdLayer(): void {
    const buf = this.bufferOf("crowdAmbient");
    if (!this.crowdPlaying || !this.ctx || !buf) return;
    const clipDur = buf.duration / this.rate("crowdAmbient");
    const overlapTime = 3;
    const nextStartDelay = (clipDur - overlapTime) * 1000;

    this.crowdLoopTimer = setTimeout(() => {
      const amb = this.bufferOf("crowdAmbient");
      if (!this.crowdPlaying || !this.ctx || !amb) return;
      const vol = this.crowdPaused ? 0 : this.getVolume("crowd") * 0.156;

      try { if (this.crowdSource) { this.crowdSource.stop(); this.crowdSource.disconnect(); } } catch {}
      this.crowdSource = this.crowdSource2;
      this.crowdNode = this.crowdNode2;

      const newGain = this.ctx.createGain();
      const newSource = this.startCrowdLayer(this.ctx, amb, newGain, vol);
      this.crowdSource2 = newSource;
      this.crowdNode2 = newGain;

      this.scheduleNextCrowdLayer();
    }, nextStartDelay);
  }

  startCrowdAmbient(): void {
    if (this.crowdPlaying) return;
    const ctx = this.ensureCtx();
    const vol = this.getVolume("crowd") * 0.156;
    const amb = this.bufferOf("crowdAmbient");
    if (vol <= 0 && !amb) return;

    if (amb) {
      const gain1 = ctx.createGain();
      this.crowdSource = this.startCrowdLayer(ctx, amb, gain1, vol);
      this.crowdNode = gain1;

      const clipDur = amb.duration / this.rate("crowdAmbient");
      const overlapTime = 3;
      const secondStart = clipDur - overlapTime;

      this.crowdInitTimer = setTimeout(() => {
        this.crowdInitTimer = null;
        const amb2 = this.bufferOf("crowdAmbient");
        if (!this.crowdPlaying || !this.ctx || !amb2) return;
        const curVol = this.crowdPaused ? 0 : this.getVolume("crowd") * 0.156;
        const gain2 = this.ctx.createGain();
        this.crowdSource2 = this.startCrowdLayer(this.ctx, amb2, gain2, curVol);
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
    const buf = this.bufferOf(`cheer${level}`);
    if (!buf) return;
    const vol = this.getVolume("crowd") * 0.8;
    if (vol <= 0) return;

    const id = `cheer${level}` as const;
    const source = ctx.createBufferSource();
    source.buffer = buf;
    source.playbackRate.value = this.rate(id);
    const gain = ctx.createGain();
    const duration = buf.duration / this.rate(id);
    const fadeOut = 0.5;
    gain.gain.setValueAtTime(0, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(vol, ctx.currentTime + 0.2);
    if (duration > fadeOut + 0.2) {
      gain.gain.setValueAtTime(vol, ctx.currentTime + duration - fadeOut);
      gain.gain.linearRampToValueAtTime(0, ctx.currentTime + duration);
    }
    const master = this.ensureCrowdMaster();
    source.connect(gain);
    gain.connect(this.eq(id, master));
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

  private playUISample(id: "uiForward" | "uiBack" | "uiStart" | "uiStats"): void {
    const ctx = this.ensureCtx();
    const buffer = this.bufferOf(id);
    if (!buffer) return;
    const vol = this.getVolume("ui") * UI_VOLUME_SCALE;
    if (vol <= 0) return;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = this.rate(id);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(vol, ctx.currentTime);
    source.connect(gain).connect(this.eq(id, ctx.destination));
    source.start();
  }

  uiClick(): void {
    this.playUISample("uiForward");
  }

  uiBack(): void {
    this.playUISample("uiBack");
  }

  uiStart(): void {
    this.playUISample("uiStart");
  }

  uiStatAllocate(): void {
    this.playUISample("uiStats");
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
