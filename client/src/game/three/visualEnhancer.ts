/**
 * Visual Enhancer: the post-processing pass the 3D views render through.
 *
 * The scene is drawn linear/HDR into an offscreen target at the chosen render
 * scale, then one full-screen pass upsamples it and applies, in order:
 * white balance + exposure → ACES tone map (same fit three.js uses, so the
 * look matches the old direct render) → contrast-adaptive sharpening (the
 * public AMD FidelityFX CAS algorithm) → local detail boost → sRGB encode →
 * contrast / saturation → luma-weighted film grain.
 *
 * With the enhancer switched off, render() is a plain renderer.render().
 */
import * as THREE from "three";
import { getVisualSettings } from "../visualSettings";

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const FRAG = /* glsl */ `
precision highp float;
precision highp int;
uniform sampler2D tSrc;
uniform vec2 outTexel;
uniform float exposure;
uniform vec3 whiteBalance;
uniform float sharp;
uniform float detail;
uniform float detailRadius;
uniform float contrast;
uniform float saturation;
uniform float grain;
uniform float grainSize;
uniform float frame;
varying vec2 vUv;

vec3 rrtOdtFit(vec3 v) {
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}
vec3 aces(vec3 c) {
  const mat3 inM = mat3(vec3(0.59719, 0.07600, 0.02840), vec3(0.35458, 0.90834, 0.13383), vec3(0.04823, 0.01566, 0.83777));
  const mat3 outM = mat3(vec3(1.60475, -0.10208, -0.00327), vec3(-0.53108, 1.10813, -0.07276), vec3(-0.07367, -0.00605, 1.07602));
  c *= exposure / 0.6;
  c = outM * rrtOdtFit(inM * c);
  return clamp(c, 0.0, 1.0);
}
vec3 tap(vec2 o) {
  return aces(texture2D(tSrc, vUv + o * outTexel).rgb * whiteBalance);
}
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 toSrgb(vec3 c) {
  return mix(1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, c * 12.92, vec3(lessThanEqual(c, vec3(0.0031308))));
}

uint hashU(uint x) {
  x ^= x >> 16; x *= 0x7feb352du;
  x ^= x >> 15; x *= 0x846ca68bu;
  return x ^ (x >> 16);
}
float gauss(ivec2 p, uint seed) {
  uint h = hashU(uint(p.x) ^ hashU(uint(p.y) + 0x9e3779b9u) ^ seed);
  float u = (float(hashU(h) >> 8) + 0.5) / 16777216.0;
  float v = (float(hashU(h ^ 0xa511e9b3u) >> 8) + 0.5) / 16777216.0;
  return sqrt(-2.0 * log(u)) * cos(6.28318530718 * v);
}
// Smooth, variance-normalized noise: neighbouring lattice samples blended with
// a Gaussian kernel, rotated so larger grain shows no grid.
float grainField(vec2 p, uint seed) {
  p = mat2(0.8, 0.6, -0.6, 0.8) * p / grainSize;
  ivec2 base = ivec2(floor(p));
  float sum = 0.0, wsq = 0.0;
  for (int y = -1; y <= 2; y++) for (int x = -1; x <= 2; x++) {
    ivec2 q = base + ivec2(x, y);
    vec2 d = p - vec2(q);
    float w = exp(-dot(d, d) / 0.6);
    sum += w * gauss(q, seed);
    wsq += w * w;
  }
  return sum * inversesqrt(max(wsq, 1e-12));
}

void main() {
  vec3 e = tap(vec2(0.0));
  vec3 col = e;

  if (sharp > 0.0) {
    vec3 b = tap(vec2(0.0, -1.0)), d = tap(vec2(-1.0, 0.0));
    vec3 f = tap(vec2(1.0, 0.0)), h = tap(vec2(0.0, 1.0));
    vec3 mn = min(min(min(d, e), min(f, b)), h);
    vec3 mx = max(max(max(d, e), max(f, b)), h);
    vec3 amp = sqrt(clamp(min(mn, 1.0 - mx) / max(mx, vec3(1e-5)), 0.0, 1.0));
    vec3 w = amp * (-1.0 / mix(8.0, 5.0, sharp));
    vec3 s = clamp((e + (b + d + f + h) * w) / (1.0 + 4.0 * w), 0.0, 1.0);
    col = mix(e, s, clamp(sharp * 3.0, 0.0, 1.0));
  }

  if (detail > 0.0) {
    float m = 0.0;
    for (int i = 0; i < 8; i++) {
      float a = float(i) * 0.785398 + 0.3927;
      m += luma(tap(vec2(cos(a), sin(a)) * detailRadius));
    }
    m *= 0.125;
    float l = luma(col);
    float boost = (l - m) * detail * 1.6;
    boost /= 1.0 + abs(boost) * 3.0;
    float nl = clamp(l + boost, 0.0, 1.0);
    col = clamp(col * (l > 1e-4 ? nl / l : 1.0), 0.0, 1.0);
  }

  col = toSrgb(col);
  col = clamp((col - 0.5) * (1.0 + contrast) + 0.5, 0.0, 1.0);
  float L = luma(col);
  col = clamp(mix(vec3(L), col, 1.0 + saturation), 0.0, 1.0);

  if (grain > 0.0) {
    float n = grainField(gl_FragCoord.xy, hashU(uint(frame)));
    float env = mix(1.0, sqrt(max(4.0 * L * (1.0 - L), 0.0)), 0.7);
    float delta = n * grain * 0.06 * env;
    vec3 room = min(col, 1.0 - col);
    float r = min(room.r, min(room.g, room.b));
    col += clamp(delta, -r, r);
  }

  gl_FragColor = vec4(col, 1.0);
}
`;

export class VisualEnhancer {
  private target: THREE.WebGLRenderTarget | null = null;
  private targetSamples = -1;
  private readonly quadScene = new THREE.Scene();
  private readonly quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly material: THREE.ShaderMaterial;
  private readonly size = new THREE.Vector2();
  private frame = 0;

  constructor() {
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
      uniforms: {
        tSrc: { value: null },
        outTexel: { value: new THREE.Vector2(1, 1) },
        exposure: { value: 1 },
        whiteBalance: { value: new THREE.Vector3(1, 1, 1) },
        sharp: { value: 0 },
        detail: { value: 0 },
        detailRadius: { value: 5 },
        contrast: { value: 0 },
        saturation: { value: 0 },
        grain: { value: 0 },
        grainSize: { value: 1 },
        frame: { value: 0 },
      },
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    quad.frustumCulled = false;
    this.quadScene.add(quad);
  }

  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera): void {
    const s = getVisualSettings();
    if (!s.enabled) {
      renderer.render(scene, camera);
      return;
    }
    renderer.getDrawingBufferSize(this.size);
    const outW = Math.max(1, this.size.x);
    const outH = Math.max(1, this.size.y);
    const w = Math.max(1, Math.round(outW * s.renderScale));
    const h = Math.max(1, Math.round(outH * s.renderScale));
    // Supersampling already anti-aliases; MSAA on top would only cost.
    const samples = s.renderScale > 1 ? 0 : 4;
    if (!this.target || this.targetSamples !== samples) {
      this.target?.dispose();
      this.target = new THREE.WebGLRenderTarget(w, h, {
        type: THREE.HalfFloatType,
        samples,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer: true,
      });
      this.targetSamples = samples;
    } else if (this.target.width !== w || this.target.height !== h) {
      this.target.setSize(w, h);
    }

    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(this.target);
    renderer.render(scene, camera);
    renderer.setRenderTarget(prev);

    const u = this.material.uniforms;
    const t = s.temperature / 100;
    u.tSrc.value = this.target.texture;
    (u.outTexel.value as THREE.Vector2).set(1 / outW, 1 / outH);
    u.exposure.value = renderer.toneMappingExposure * Math.pow(2, s.exposure);
    (u.whiteBalance.value as THREE.Vector3).set(1 + 0.12 * t, 1 + 0.02 * t, 1 - 0.12 * t);
    u.sharp.value = s.sharpness / 100;
    u.detail.value = s.detail / 100;
    u.detailRadius.value = Math.max(2, outH / 216);
    u.contrast.value = (s.contrast / 100) * 0.5;
    u.saturation.value = s.saturation / 100;
    u.grain.value = s.grain / 100;
    u.grainSize.value = s.grainSize * Math.max(1, outH / 1080);
    u.frame.value = this.frame = (this.frame + 1) % 65536;
    renderer.render(this.quadScene, this.quadCam);
  }

  dispose(): void {
    this.target?.dispose();
    this.target = null;
    this.material.dispose();
    (this.quadScene.children[0] as THREE.Mesh).geometry.dispose();
  }
}
