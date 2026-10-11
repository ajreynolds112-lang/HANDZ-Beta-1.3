import * as THREE from "three";
import { mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";

/**
 * Sparring girdle for the textured boxer, built once per template load from
 * the Tripo shell (generated from the user's front reference photo; its front
 * faces +x). Everything is in the body's bind space (+z front, feet at y=0):
 * the shell is scaled onto the hips over the trunks, pushed out wherever it
 * would sink into the body, and a back elastic band with laces is added (the
 * shell only covers the front and sides). Skin weights blend from the nearest
 * body vertices, so it follows the hips and legs like the trunks do.
 */
/** Overall size of the girdle (1 = the original fit); shrinks toward the waist top. */
const GIRDLE_SCALE = 0.9;
const TOP = 118, BOTTOM = TOP - 32 * GIRDLE_SCALE;     // waist top and cup bottom
const SIDE = 19.6 * GIRDLE_SCALE;                       // half-width over the hips (the body push keeps it clear)
const CUP_REACH = 16.4 * GIRDLE_SCALE;                  // cup front, forward of the hip axis
const TAPER_FROM = TOP - 2 * GIRDLE_SCALE;               // narrowing starts here...
const TAPER_MIN = 0.36, CUP_FLATTEN = 0.15;             // ...down to this share of the width (and depth) at the bottom
/** |sin θ| range where the shell goes from pelvis-rigid (centre) to following the body (sides). */
const RIGID_TO_SIDE: [number, number] = [0.55, 0.92];
export const GIRDLE_BAND = { lo: TOP - 13 * GIRDLE_SCALE, hi: TOP - 0.5 * GIRDLE_SCALE };
const ROW0 = 78, ROW1 = 124, BINS = 48;
const OUTER_GAP = 0.9, INNER_GAP = 0.4, BAND_GAP = 1.0;

export function buildGirdleGeometry(src: THREE.Object3D, body: THREE.SkinnedMesh, skipMaterial: string): THREE.BufferGeometry | null {
  // ── the shell: largest connected piece (drops the logo patch, straps and the hallucinated back belt) ──
  src.updateMatrixWorld(true);
  let raw: THREE.BufferGeometry | null = null;
  src.traverse(o => { const m = o as THREE.Mesh; if (!raw && m.isMesh) raw = m.geometry.clone().applyMatrix4(m.matrixWorld); });
  if (!raw) return null;
  const bare = new THREE.BufferGeometry();
  bare.setAttribute("position", (raw as THREE.BufferGeometry).getAttribute("position"));
  if ((raw as THREE.BufferGeometry).index) bare.setIndex((raw as THREE.BufferGeometry).index);
  const shell0 = mergeVertices(bare, 1e-4);
  const sIdx = shell0.index!.array, sPos = shell0.getAttribute("position").array as Float32Array;
  const par = Int32Array.from({ length: sPos.length / 3 }, (_, i) => i);
  const find = (x: number) => { while (par[x] !== x) x = par[x] = par[par[x]]; return x; };
  for (let t = 0; t < sIdx.length; t += 3) { const a = find(sIdx[t]); par[find(sIdx[t + 1])] = a; par[find(sIdx[t + 2])] = a; }
  const size = new Map<number, number>();
  for (let t = 0; t < sIdx.length; t += 3) { const r = find(sIdx[t]); size.set(r, (size.get(r) ?? 0) + 1); }
  const big = [...size.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const remap = new Map<number, number>(), pos: number[] = [], idx: number[] = [];
  for (let t = 0; t < sIdx.length; t += 3) {
    if (find(sIdx[t]) !== big) continue;
    for (let j = 0; j < 3; j++) {
      const v = sIdx[t + j];
      if (!remap.has(v)) { remap.set(v, pos.length / 3); pos.push(sPos[v * 3], sPos[v * 3 + 1], sPos[v * 3 + 2]); }
      idx.push(remap.get(v)!);
    }
  }

  // ── body hull: per height row and angle bin, the furthest visible body surface ──
  const bPos = body.geometry.getAttribute("position") as THREE.BufferAttribute;
  const mats = ([] as THREE.Material[]).concat(body.material);
  const skip = new Uint8Array(bPos.count);
  const bIndex = body.geometry.index;
  for (const g of body.geometry.groups) {
    if (mats[g.materialIndex ?? 0]?.name !== skipMaterial) continue;
    for (let k = g.start; k < g.start + g.count; k++) skip[bIndex ? bIndex.getX(k) : k] = 1;
  }
  const near: number[] = [];
  let zLo = Infinity, zHi = -Infinity;
  for (let k = 0; k < bPos.count; k++) {
    const x = bPos.getX(k), y = bPos.getY(k), z = bPos.getZ(k);
    if (skip[k] || y < ROW0 || y > ROW1 || Math.abs(x) > 26) continue;
    near.push(k);
    if (y > 100 && y < 112) { zLo = Math.min(zLo, z); zHi = Math.max(zHi, z); }
  }
  const cz = (zLo + zHi) / 2;
  const nRows = ROW1 - ROW0 + 1;
  const hull0 = new Float32Array(nRows * BINS);
  const binOf = (x: number, z: number) => ((Math.round(Math.atan2(x, z - cz) / (Math.PI * 2) * BINS) % BINS) + BINS) % BINS;
  // Sample across each triangle, not just its corners: the trunks' vertex rows
  // are further apart than a hull row, which would leave rows sunk into them.
  const inNear = new Uint8Array(bPos.count);
  for (const k of near) inNear[k] = 1;
  const A = new THREE.Vector3(), B = new THREE.Vector3(), Cv = new THREE.Vector3(), P = new THREE.Vector3();
  const nTri = (bIndex ? bIndex.count : bPos.count) / 3;
  for (let t = 0; t < nTri; t++) {
    const ia = bIndex ? bIndex.getX(t * 3) : t * 3, ib = bIndex ? bIndex.getX(t * 3 + 1) : t * 3 + 1, ic = bIndex ? bIndex.getX(t * 3 + 2) : t * 3 + 2;
    if (!inNear[ia] || !inNear[ib] || !inNear[ic]) continue;
    A.fromBufferAttribute(bPos, ia); B.fromBufferAttribute(bPos, ib); Cv.fromBufferAttribute(bPos, ic);
    const n = Math.max(1, Math.ceil(Math.max(A.distanceTo(B), B.distanceTo(Cv), Cv.distanceTo(A)) / 0.7));
    for (let i = 0; i <= n; i++) for (let j = 0; j <= n - i; j++) {
      P.copy(A).multiplyScalar((n - i - j) / n).addScaledVector(B, i / n).addScaledVector(Cv, j / n);
      const row = Math.round(P.y - ROW0), b = binOf(P.x, P.z), r = Math.hypot(P.x, P.z - cz);
      if (r > hull0[row * BINS + b]) hull0[row * BINS + b] = r;
    }
  }
  // Max over neighbouring rows and bins so sparse spots don't leave holes.
  const hull = new Float32Array(nRows * BINS);
  for (let row = 0; row < nRows; row++) for (let b = 0; b < BINS; b++) {
    let m = 0;
    for (let dr = -1; dr <= 1; dr++) for (let db = -1; db <= 1; db++) {
      const rr = row + dr; if (rr < 0 || rr >= nRows) continue;
      m = Math.max(m, hull0[rr * BINS + ((b + db + BINS) % BINS)]);
    }
    hull[row * BINS + b] = m;
  }
  const hullAt = (x: number, y: number, z: number) =>
    hull[THREE.MathUtils.clamp(Math.round(y - ROW0), 0, nRows - 1) * BINS + binOf(x, z)];

  // ── place the shell over the hips ──
  const bb = new THREE.Box3().setFromArray(pos);
  const sx = SIDE / Math.max(Math.abs(bb.min.z), bb.max.z);
  const sy = (TOP - BOTTOM) / (bb.max.y - bb.min.y);
  const sz = CUP_REACH / bb.max.x;
  for (let i = 0; i < pos.length; i += 3) {
    const gx = pos[i], gy = pos[i + 1], gz = pos[i + 2];
    const y = TOP - (bb.max.y - gy) * sy;
    // Narrow toward the bottom: full width over the hips, a slim cup between the legs.
    const s = THREE.MathUtils.smoothstep(TAPER_FROM - y, 0, TAPER_FROM - BOTTOM);
    pos[i] = -gz * sx * (1 - (1 - TAPER_MIN) * s); pos[i + 1] = y; pos[i + 2] = cz + gx * sz * (1 - CUP_FLATTEN * s);
  }
  const shell = new THREE.BufferGeometry();
  shell.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  shell.setIndex(idx);
  shell.computeVertexNormals();
  // Push out of the body: the outside clears it by a hair, the inside sits closer.
  const nrm = shell.getAttribute("normal");
  let thMax = 0;
  for (let i = 0, k = 0; i < pos.length; i += 3, k++) {
    const x = pos[i], y = pos[i + 1], z = pos[i + 2] - cz, r = Math.hypot(x, z) || 1;
    const outward = (nrm.getX(k) * x + nrm.getZ(k) * z) / r > 0;
    const want = hullAt(x, y, pos[i + 2]) + (outward ? OUTER_GAP : INNER_GAP);
    if (r < want) { pos[i] = x * want / r; pos[i + 2] = cz + z * want / r; }
    if (y > GIRDLE_BAND.lo && y < GIRDLE_BAND.hi) thMax = Math.max(thMax, Math.abs(Math.atan2(x, z)));
  }
  shell.getAttribute("position").needsUpdate = true;
  shell.computeVertexNormals();

  // ── back band: from just under each wing's end, round the back ──
  const COLS = 41, ROWS = 9;
  const th0 = thMax - 0.12, th1 = Math.PI * 2 - th0;
  const band: number[] = [], bandUv: number[] = [];
  for (let i = 0; i < ROWS; i++) {
    const y = GIRDLE_BAND.lo + (GIRDLE_BAND.hi - GIRDLE_BAND.lo) * i / (ROWS - 1);
    const row: THREE.Vector3[] = [];
    for (let j = 0; j < COLS; j++) {
      const th = th0 + (th1 - th0) * j / (COLS - 1), sx2 = Math.sin(th), cz2 = Math.cos(th);
      const r = hullAt(sx2, y, cz + cz2) + BAND_GAP;
      row.push(new THREE.Vector3(sx2 * r, y, cz + cz2 * r));
    }
    // Arc length along the row, zero at the back centre (laces are laid out in body units).
    const arc = [0];
    for (let j = 1; j < COLS; j++) arc.push(arc[j - 1] + row[j].distanceTo(row[j - 1]));
    const mid = arc[(COLS - 1) / 2];
    row.forEach((p, j) => { band.push(p.x, p.y, p.z); bandUv.push(arc[j] - mid, y); });
  }
  const bandIdx: number[] = [];
  for (let i = 0; i < ROWS - 1; i++) for (let j = 0; j < COLS - 1; j++) {
    const a = i * COLS + j, b = a + 1, c = a + COLS, d = c + 1;
    bandIdx.push(a, c, b, b, c, d);
  }
  const bandGeo = new THREE.BufferGeometry();
  bandGeo.setAttribute("position", new THREE.Float32BufferAttribute(band, 3));
  bandGeo.setIndex(bandIdx);
  bandGeo.computeVertexNormals();
  // Face outward whatever the winding came out as.
  const mid = (Math.floor(ROWS / 2)) * COLS + (COLS - 1) / 2;
  if (bandGeo.getAttribute("normal").getZ(mid) > 0) {
    for (let t = 0; t < bandIdx.length; t += 3) { const s = bandIdx[t + 1]; bandIdx[t + 1] = bandIdx[t + 2]; bandIdx[t + 2] = s; }
    bandGeo.setIndex(bandIdx);
    bandGeo.computeVertexNormals();
  }

  // ── one geometry, two groups: shell (outside colour) and band (black + laces) ──
  const nShell = pos.length / 3, nBand = band.length / 3;
  const out = new THREE.BufferGeometry();
  const allPos = new Float32Array([...pos, ...band]);
  const allNrm = new Float32Array([...(shell.getAttribute("normal").array as Float32Array), ...(bandGeo.getAttribute("normal").array as Float32Array)]);
  const allUv = new Float32Array((nShell + nBand) * 2);
  allUv.set(bandUv, nShell * 2);
  out.setAttribute("position", new THREE.BufferAttribute(allPos, 3));
  out.setAttribute("normal", new THREE.BufferAttribute(allNrm, 3));
  out.setAttribute("band", new THREE.BufferAttribute(allUv, 2));
  out.setIndex([...idx, ...bandIdx.map(v => v + nShell)]);
  out.addGroup(0, idx.length, 0);
  out.addGroup(idx.length, bandIdx.length, 1);

  // ── skin weights: the front and back centre ride the pelvis rigidly (a hard
  // shell doesn't stretch with the legs); only the sides blend into the body's weights ──
  const pelvis = Math.max(0, body.skeleton.bones.findIndex(b => b.name === "pelvis"));
  const bSi = body.geometry.getAttribute("skinIndex"), bSw = body.geometry.getAttribute("skinWeight");
  const K = 8, n = nShell + nBand;
  const si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
  const bestD = new Float32Array(K), bestK = new Int32Array(K);
  for (let v = 0; v < n; v++) {
    const x = allPos[v * 3], y = allPos[v * 3 + 1], z = allPos[v * 3 + 2];
    bestD.fill(Infinity);
    for (const k of near) {
      const dx = bPos.getX(k) - x, dy = bPos.getY(k) - y, dz = bPos.getZ(k) - z, d = dx * dx + dy * dy + dz * dz;
      if (d >= bestD[K - 1]) continue;
      let p = K - 1;
      while (p > 0 && bestD[p - 1] > d) { bestD[p] = bestD[p - 1]; bestK[p] = bestK[p - 1]; p--; }
      bestD[p] = d; bestK[p] = k;
    }
    const acc = new Map<number, number>();
    const side = Math.abs(x) / (Math.hypot(x, z - cz) || 1);  // |sin θ| around the hip axis
    const rigid = 1 - THREE.MathUtils.smoothstep(side, RIGID_TO_SIDE[0], RIGID_TO_SIDE[1]);
    for (let q = 0; q < K; q++) {
      const w0 = 1 / (bestD[q] + 1);
      for (let c = 0; c < 4; c++) {
        const w = bSw.getComponent(bestK[q], c);
        if (w > 0) { const b = bSi.getComponent(bestK[q], c); acc.set(b, (acc.get(b) ?? 0) + w * w0); }
      }
    }
    let accSum = 0;
    acc.forEach(w => { accSum += w; });
    acc.forEach((w, b) => acc.set(b, (w / (accSum || 1)) * (1 - rigid)));
    acc.set(pelvis, (acc.get(pelvis) ?? 0) + rigid);
    const top = [...acc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
    const sum = top.reduce((s, e) => s + e[1], 0) || 1;
    top.forEach(([b, w], c) => { si[v * 4 + c] = b; sw[v * 4 + c] = w / sum; });
  }
  out.setAttribute("skinIndex", new THREE.BufferAttribute(si, 4));
  out.setAttribute("skinWeight", new THREE.BufferAttribute(sw, 4));
  return out;
}

/** Back band: black elastic, black leather lace tabs, criss-cross laces in the lace colour. */
export function girdleBandMaterial(
  laceColor: { value: THREE.Color },
  laceSpacial: { on: { value: number }; map: { value: THREE.Texture | null } },
): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 0.85, metalness: 0 });
  const { lo, hi } = GIRDLE_BAND;
  m.onBeforeCompile = sh => {
    sh.uniforms.laceColor = laceColor;
    sh.uniforms.laceSpacialOn = laceSpacial.on;
    sh.uniforms.laceSpacialMap = laceSpacial.map;
    sh.vertexShader = "attribute vec2 band;\nvarying vec2 vBand;\n" + sh.vertexShader
      .replace("#include <begin_vertex>", "#include <begin_vertex>\n  vBand = band;");
    sh.fragmentShader = "uniform vec3 laceColor;\nuniform float laceSpacialOn;\nuniform sampler2D laceSpacialMap;\nvarying vec2 vBand;\n" + sh.fragmentShader
      .replace("#include <map_fragment>", `#include <map_fragment>
  float ga = vBand.x, gy = vBand.y;
  float gTab = 1.0 - step(5.2, abs(ga));
  vec3 gCol = vec3(0.035) * (0.85 + 0.15 * step(0.5, fract(gy * 1.4))) * (1.0 - gTab) + vec3(0.03) * gTab;
  const float SP = 2.0, EY = 3.0;
  float gm = SP / (2.0 * EY);
  float gd1 = abs(fract((gy - gm * ga) / SP) - 0.5) * SP, gd2 = abs(fract((gy + gm * ga) / SP) - 0.5) * SP;
  float gd = min(gd1, gd2) / sqrt(1.0 + gm * gm);
  float gIn = step(abs(ga), EY) * step(${(lo + 1.2).toFixed(2)}, gy) * step(gy, ${(hi - 0.9).toFixed(2)});
  float gLace = (1.0 - smoothstep(0.2, 0.3, gd)) * gIn;
  vec2 ge = vec2(abs(ga) - EY, (fract((gy - SP * 0.5) / SP) - 0.5) * SP);
  float gEye = (1.0 - smoothstep(0.22, 0.3, length(ge))) * step(${(lo + 1.0).toFixed(2)}, gy) * step(gy, ${(hi - 0.7).toFixed(2)});
  gCol = mix(gCol, vec3(0.32), gEye);
  vec3 gLaceC = laceSpacialOn > 0.5 ? texture2D(laceSpacialMap, gl_FragCoord.xy / 110.0).rgb : laceColor;
  gCol = mix(gCol, gLaceC * (0.75 + 0.25 * (1.0 - gd / 0.3)), gLace);
  diffuseColor.rgb = gCol;`)
      .replace("#include <roughnessmap_fragment>", "#include <roughnessmap_fragment>\n  roughnessFactor = mix(roughnessFactor, 0.5, gTab);");
  };
  m.customProgramCacheKey = () => "boxerGirdleBand";
  return m;
}
