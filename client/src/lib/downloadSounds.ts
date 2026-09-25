import JSZip from "jszip";
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
import { MUSIC_TRACK_URLS, MUSIC_TRACK_NAMES } from "@/game/musicTracks";

function encodeWAV(buffer: AudioBuffer): ArrayBuffer {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const numSamples = buffer.length;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = numSamples * blockAlign;
  const ab = new ArrayBuffer(44 + dataSize);
  const view = new DataView(ab);

  const str = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  str(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  str(8, "WAVE");
  str(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  str(36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const s = Math.max(-1, Math.min(1, buffer.getChannelData(ch)[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      offset += 2;
    }
  }
  return ab;
}

function makeNoise(offCtx: OfflineAudioContext, duration: number, vol: number, filterFreq: number, filterType: BiquadFilterType = "lowpass") {
  const bufSize = Math.floor(offCtx.sampleRate * duration);
  const noiseBuf = offCtx.createBuffer(1, bufSize, offCtx.sampleRate);
  const data = noiseBuf.getChannelData(0);
  for (let i = 0; i < bufSize; i++) data[i] = Math.random() * 2 - 1;
  const src = offCtx.createBufferSource();
  src.buffer = noiseBuf;
  const filter = offCtx.createBiquadFilter();
  filter.type = filterType;
  filter.frequency.value = filterFreq;
  const gain = offCtx.createGain();
  gain.gain.setValueAtTime(vol, 0);
  gain.gain.exponentialRampToValueAtTime(0.001, duration);
  src.connect(filter).connect(gain).connect(offCtx.destination);
  src.start(0);
  src.stop(duration);
}

function makeTone(offCtx: OfflineAudioContext, freq: number, duration: number, vol: number, type: OscillatorType = "sine") {
  const osc = offCtx.createOscillator();
  osc.type = type;
  osc.frequency.value = freq;
  const gain = offCtx.createGain();
  gain.gain.setValueAtTime(vol, 0);
  gain.gain.exponentialRampToValueAtTime(0.001, duration);
  osc.connect(gain).connect(offCtx.destination);
  osc.start(0);
  osc.stop(duration);
}

async function renderOffline(duration: number, build: (ctx: OfflineAudioContext) => void): Promise<ArrayBuffer> {
  const SR = 44100;
  const offCtx = new OfflineAudioContext(1, Math.ceil(SR * duration) + 16, SR);
  build(offCtx);
  const rendered = await offCtx.startRendering();
  return encodeWAV(rendered);
}

async function fetchAsBlob(url: string): Promise<ArrayBuffer> {
  const resp = await fetch(url);
  return resp.arrayBuffer();
}

export async function downloadAllSounds(onProgress?: (pct: number) => void): Promise<void> {
  const zip = new JSZip();
  const sfxFolder = zip.folder("HANDZ_Sounds/SFX")!;
  const musicFolder = zip.folder("HANDZ_Sounds/Music")!;

  const sampledFiles: { name: string; url: string }[] = [
    { name: "bell.mp3", url: bellUrl },
    { name: "jab_clean.mp3", url: jabCleanUrl },
    { name: "hook_clean.wav", url: hookCleanUrl },
    { name: "uppercut_clean.mp3", url: uppercutCleanUrl },
    { name: "crowd_cheer_1.mp3", url: cheer1Url },
    { name: "crowd_cheer_2.mp3", url: cheer2Url },
    { name: "crowd_cheer_3.mp3", url: cheer3Url },
    { name: "crowd_ambient.mp3", url: constantCrowdUrl },
    { name: "ui_back.mp3", url: uiBackUrl },
    { name: "ui_forward.mp3", url: uiForwardUrl },
    { name: "ui_start.mp3", url: uiStartUrl },
    { name: "ui_stats.mp3", url: uiStatsUrl },
  ];

  const musicFiles: { name: string; url: string }[] = MUSIC_TRACK_NAMES.map((name, i) => ({
    name: `${name}.mp3`,
    url: MUSIC_TRACK_URLS[i],
  }));

  const synthSounds: { name: string; duration: number; build: (ctx: OfflineAudioContext) => void }[] = [
    {
      name: "punch_whoosh.wav",
      duration: 0.2,
      build: (ctx) => {
        const bufSize = Math.floor(ctx.sampleRate * 0.12);
        const buf = ctx.createBuffer(1, bufSize, ctx.sampleRate);
        const d = buf.getChannelData(0);
        for (let i = 0; i < bufSize; i++) d[i] = Math.random() * 2 - 1;
        const src = ctx.createBufferSource();
        src.buffer = buf;
        const filter = ctx.createBiquadFilter();
        filter.type = "bandpass";
        filter.frequency.setValueAtTime(2000, 0);
        filter.frequency.exponentialRampToValueAtTime(800, 0.1);
        filter.Q.value = 2;
        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.001, 0);
        gain.gain.linearRampToValueAtTime(0.6, 0.03);
        gain.gain.exponentialRampToValueAtTime(0.001, 0.12);
        src.connect(filter).connect(gain).connect(ctx.destination);
        src.start(0);
        src.stop(0.15);
      },
    },
    {
      name: "whiff.wav",
      duration: 0.15,
      build: (ctx) => {
        const bufSize = Math.floor(ctx.sampleRate * 0.1);
        const buf = ctx.createBuffer(1, bufSize, ctx.sampleRate);
        const d = buf.getChannelData(0);
        for (let i = 0; i < bufSize; i++) d[i] = Math.random() * 2 - 1;
        const src = ctx.createBufferSource();
        src.buffer = buf;
        const filter = ctx.createBiquadFilter();
        filter.type = "highpass";
        filter.frequency.value = 3000;
        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.5, 0);
        gain.gain.exponentialRampToValueAtTime(0.001, 0.1);
        src.connect(filter).connect(gain).connect(ctx.destination);
        src.start(0);
        src.stop(0.12);
      },
    },
    {
      name: "crit_land.wav",
      duration: 0.2,
      build: (ctx) => {
        makeTone(ctx, 200, 0.15, 0.5, "sawtooth");
        makeNoise(ctx, 0.12, 0.6, 1200);
      },
    },
    {
      name: "stun_land.wav",
      duration: 0.35,
      build: (ctx) => {
        const osc = ctx.createOscillator();
        osc.type = "sine";
        osc.frequency.setValueAtTime(400, 0);
        osc.frequency.exponentialRampToValueAtTime(100, 0.2);
        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.5, 0);
        gain.gain.linearRampToValueAtTime(0.25, 0.05);
        gain.gain.exponentialRampToValueAtTime(0.001, 0.25);
        osc.connect(gain).connect(ctx.destination);
        osc.start(0);
        osc.stop(0.3);
      },
    },
    {
      name: "charge_punch_land.wav",
      duration: 0.25,
      build: (ctx) => {
        makeTone(ctx, 80, 0.2, 0.7, "sawtooth");
        makeNoise(ctx, 0.15, 0.8, 600);
        makeTone(ctx, 160, 0.12, 0.4, "square");
      },
    },
    {
      name: "knockdown.wav",
      duration: 0.4,
      build: (ctx) => {
        makeNoise(ctx, 0.2, 0.8, 400);
        makeTone(ctx, 60, 0.3, 0.7, "sine");
        makeNoise(ctx, 0.08, 0.6, 800);
      },
    },
    {
      name: "crowd_ooh.wav",
      duration: 0.9,
      build: (ctx) => {
        const bufSize = Math.floor(ctx.sampleRate * 0.8);
        const buf = ctx.createBuffer(1, bufSize, ctx.sampleRate);
        const d = buf.getChannelData(0);
        for (let i = 0; i < bufSize; i++) d[i] = Math.random() * 2 - 1;
        const src = ctx.createBufferSource();
        src.buffer = buf;
        const filter = ctx.createBiquadFilter();
        filter.type = "bandpass";
        filter.frequency.value = 500;
        filter.Q.value = 3;
        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.001, 0);
        gain.gain.linearRampToValueAtTime(0.6, 0.1);
        gain.gain.setValueAtTime(0.6, 0.3);
        gain.gain.exponentialRampToValueAtTime(0.001, 0.8);
        src.connect(filter).connect(gain).connect(ctx.destination);
        src.start(0);
        src.stop(0.85);
      },
    },
    {
      name: "crowd_cheer_synth.wav",
      duration: 1.6,
      build: (ctx) => {
        const bufSize = Math.floor(ctx.sampleRate * 1.5);
        const buf = ctx.createBuffer(1, bufSize, ctx.sampleRate);
        const d = buf.getChannelData(0);
        for (let i = 0; i < bufSize; i++) d[i] = Math.random() * 2 - 1;
        const src = ctx.createBufferSource();
        src.buffer = buf;
        const filter = ctx.createBiquadFilter();
        filter.type = "bandpass";
        filter.frequency.value = 800;
        filter.Q.value = 1.5;
        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.001, 0);
        gain.gain.linearRampToValueAtTime(0.6, 0.15);
        gain.gain.setValueAtTime(0.6, 0.6);
        gain.gain.exponentialRampToValueAtTime(0.001, 1.5);
        src.connect(filter).connect(gain).connect(ctx.destination);
        src.start(0);
        src.stop(1.55);
      },
    },
    {
      name: "training_punch_hit.wav",
      duration: 0.15,
      build: (ctx) => {
        makeNoise(ctx, 0.06, 0.6, 900);
        makeTone(ctx, 110, 0.08, 0.4, "sine");
      },
    },
    {
      name: "training_ding.wav",
      duration: 0.5,
      build: (ctx) => {
        makeTone(ctx, 1200, 0.4, 0.6, "sine");
        makeTone(ctx, 1800, 0.4, 0.4, "sine");
      },
    },
    {
      name: "training_buzz.wav",
      duration: 0.35,
      build: (ctx) => {
        makeTone(ctx, 150, 0.25, 0.6, "square");
      },
    },
    {
      name: "ui_click.wav",
      duration: 0.1,
      build: (ctx) => {
        makeTone(ctx, 600, 0.05, 0.5, "sine");
        makeTone(ctx, 900, 0.03, 0.3, "sine");
      },
    },
    {
      name: "ui_hover.wav",
      duration: 0.08,
      build: (ctx) => {
        makeTone(ctx, 500, 0.03, 0.4, "sine");
      },
    },
  ];

  const total = sampledFiles.length + musicFiles.length + synthSounds.length;
  let done = 0;

  const tick = () => {
    done++;
    onProgress?.(Math.round((done / total) * 100));
  };

  for (const sf of sampledFiles) {
    const data = await fetchAsBlob(sf.url);
    sfxFolder.file(sf.name, data);
    tick();
  }

  for (const mf of musicFiles) {
    const data = await fetchAsBlob(mf.url);
    musicFolder.file(mf.name, data);
    tick();
  }

  for (const ss of synthSounds) {
    const data = await renderOffline(ss.duration, ss.build);
    sfxFolder.file(ss.name, data);
    tick();
  }

  const blob = await zip.generateAsync({ type: "blob" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "HANDZ_Sounds.zip";
  a.click();
  URL.revokeObjectURL(url);
}
