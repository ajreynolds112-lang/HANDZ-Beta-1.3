/**
 * Regenerates the per-rarity variants of the item icons whose artwork is blue
 * by default (Headgear Strap, Refinement Tome). Every tier of those families
 * ships the same sprite re-tinted to its rarity colour, so the icon in the
 * Locker reads as Journeyman green / Elite purple / etc. at a glance.
 *
 *   npx tsx script/recolorItemIcons.ts
 *
 * Source art stays untouched at client/public/items/<base>.png; the variants
 * are written next to it as <base>_<rarity>.png and are what defaultItems.ts
 * points each tier at.
 */
import fs from "fs";
import path from "path";
import zlib from "zlib";

// Kept in sync with RARITY_COLORS in client/src/game/itemsConfig.ts.
const RARITY_COLORS: Record<string, string> = {
  journeyman: "#22aa44",
  contender: "#3b82f6",
  elite: "#a855f7",
  champion: "#f5b301",
  undisputed: "#ffffff",
  goat: "#8b5cf6",
};

const ITEMS_DIR = path.resolve("client/public/items");
const BASES = ["headgear_strap", "refinement_tome"];

// Which pixels count as "the blue part of the sprite". Everything else (gold
// leaf, leather, outlines, shadow) is left exactly as the artist drew it.
const BLUE_HUE_LO = 185;
const BLUE_HUE_HI = 268;
const BLUE_MIN_SAT = 0.14;

interface Png { width: number; height: number; pixels: Buffer }

function decodePng(file: string): Png {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error(`${file}: not a PNG`);
  let offset = 8;
  const idat: Buffer[] = [];
  let width = 0, height = 0;
  while (offset < buf.length) {
    const len = buf.readUInt32BE(offset);
    const type = buf.toString("ascii", offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const [depth, colorType, , , interlace] = [data[8], data[9], data[10], data[11], data[12]];
      if (depth !== 8 || colorType !== 6 || interlace !== 0) {
        throw new Error(`${file}: only 8-bit RGBA non-interlaced PNGs are supported`);
      }
    } else if (type === "IDAT") {
      idat.push(Buffer.from(data));
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + len;
  }

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const pixels = Buffer.alloc(stride * height);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const line = raw.subarray(pos, pos + stride);
    pos += stride;
    const out = pixels.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? out[x - 4] : 0;
      const b = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const c = x >= 4 && y > 0 ? pixels[(y - 1) * stride + x - 4] : 0;
      let v = line[x];
      switch (filter) {
        case 0: break;
        case 1: v += a; break;
        case 2: v += b; break;
        case 3: v += (a + b) >> 1; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          break;
        }
        default: throw new Error(`${file}: unsupported scanline filter ${filter}`);
      }
      out[x] = v & 0xff;
    }
  }
  return { width, height, pixels };
}

function encodePng(png: Png, file: string): void {
  const stride = png.width * 4;
  const raw = Buffer.alloc((stride + 1) * png.height);
  for (let y = 0; y < png.height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none — these sprites are tiny
    png.pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const chunk = (type: string, data: Buffer): Buffer => {
    const out = Buffer.alloc(data.length + 12);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, "ascii");
    data.copy(out, 8);
    out.writeInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(png.width, 0);
  ihdr.writeUInt32BE(png.height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]));
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function hueSat(r: number, g: number, b: number): { hue: number; sat: number } {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return { hue: 0, sat: 0 };
  let hue: number;
  if (max === r) hue = ((g - b) / d) % 6;
  else if (max === g) hue = (b - r) / d + 2;
  else hue = (r - g) / d + 4;
  hue *= 60;
  if (hue < 0) hue += 360;
  return { hue, sat: d / max };
}

const luma = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;

/**
 * Re-tints the blue pixels to `hex` while keeping the sprite's own shading:
 * each pixel's brightness relative to the average blue becomes a scale on the
 * target colour, and anything brighter than the average blends toward white so
 * highlights stay as highlights.
 */
function retint(src: Png, hex: string): Png {
  const [tr, tg, tb] = hexToRgb(hex);
  const pixels = Buffer.from(src.pixels);
  const blues: number[] = [];

  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] < 8) continue;
    const { hue, sat } = hueSat(pixels[i], pixels[i + 1], pixels[i + 2]);
    if (hue >= BLUE_HUE_LO && hue <= BLUE_HUE_HI && sat >= BLUE_MIN_SAT) {
      blues.push(luma(pixels[i], pixels[i + 1], pixels[i + 2]));
    }
  }
  if (blues.length === 0) throw new Error("no blue pixels found — check the hue window");

  const avg = blues.reduce((a, b) => a + b, 0) / blues.length;
  const maxRatio = Math.max(...blues) / Math.max(1, avg);

  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] < 8) continue;
    const { hue, sat } = hueSat(pixels[i], pixels[i + 1], pixels[i + 2]);
    if (hue < BLUE_HUE_LO || hue > BLUE_HUE_HI || sat < BLUE_MIN_SAT) continue;

    const ratio = luma(pixels[i], pixels[i + 1], pixels[i + 2]) / Math.max(1, avg);
    let r: number, g: number, b: number;
    if (ratio <= 1) {
      r = tr * ratio; g = tg * ratio; b = tb * ratio;
    } else {
      const t = maxRatio > 1 ? Math.min(1, (ratio - 1) / (maxRatio - 1)) : 0;
      // Highlights lift toward white, but never all the way — the tint has to
      // survive on the lit faces of the sprite.
      const lift = t * 0.75;
      r = tr + (255 - tr) * lift;
      g = tg + (255 - tg) * lift;
      b = tb + (255 - tb) * lift;
    }
    pixels[i] = Math.max(0, Math.min(255, Math.round(r)));
    pixels[i + 1] = Math.max(0, Math.min(255, Math.round(g)));
    pixels[i + 2] = Math.max(0, Math.min(255, Math.round(b)));
  }
  return { width: src.width, height: src.height, pixels };
}

for (const base of BASES) {
  const src = decodePng(path.join(ITEMS_DIR, `${base}.png`));
  for (const [rarity, hex] of Object.entries(RARITY_COLORS)) {
    const out = path.join(ITEMS_DIR, `${base}_${rarity}.png`);
    encodePng(retint(src, hex), out);
    console.log(`wrote ${path.relative(process.cwd(), out)}  (${hex})`);
  }
}
