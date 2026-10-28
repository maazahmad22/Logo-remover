export type RemovalMode = 'content-aware' | 'reverse-alpha' | 'feather-blur';

export type RenderQuality = 'low' | 'medium' | 'high';

export type CornerPreset =
  | 'bottom-right'
  | 'bottom-left'
  | 'top-right'
  | 'top-left'
  | 'custom';

export interface MaskRegion {
  /** Percentage of width (0 - 100) */
  xPct: number;
  /** Percentage of height (0 - 100) */
  yPct: number;
  /** Percentage of width */
  widthPct: number;
  /** Percentage of height */
  heightPct: number;
}

export interface ProcessingConfig {
  mode: RemovalMode;
  preset: CornerPreset;
  region: MaskRegion;
  /** Strength of alpha reversal or feather blending (0.1 to 1.0). Not used by content-aware fill. */
  intensity: number;
  /**
   * Width of the feather band in pixels. For content-aware fill the band lies OUTSIDE the
   * mask box (plus glow margin): the fill is synthesised that much wider and then fades
   * smoothly into the untouched original, so no trace of the badge sits in the transition.
   */
  featherPx: number;
  /**
   * Watermark badges have a soft glow that reaches past their visible edge. The fill
   * extends this many pixels beyond the mask box so the glow is removed too, and no
   * source texture is sampled from that band. Default 13.
   */
  haloPx?: number;
}

export interface ProcessOptions {
  /** Render quality tier. Defaults to 'medium'. */
  quality?: RenderQuality;
  /**
   * When set, the nearest-neighbour field from the previous call with the same key
   * seeds this call. Use a stable key for consecutive video frames so the fill is
   * temporally coherent and converges in fewer passes.
   */
  temporalKey?: string | null;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const round1 = (v: number) => Math.round(v * 10) / 10;

/**
 * Calibrated badge placement, as percentages of the frame: box 6.5% x 3%, inset 13%
 * from the side edge and 8% from the top/bottom edge. Tuned against real Gemini output;
 * the other corners mirror it.
 */
const CALIBRATED_BOX = { widthPct: 6.5, heightPct: 3, marginXPct: 13, marginYPct: 8 };

export function regionForPreset(preset: Exclude<CornerPreset, 'custom'>): MaskRegion {
  const { widthPct, heightPct, marginXPct, marginYPct } = CALIBRATED_BOX;
  const right = preset === 'bottom-right' || preset === 'top-right';
  const bottom = preset === 'bottom-right' || preset === 'bottom-left';
  return {
    xPct: round1(right ? 100 - widthPct - marginXPct : marginXPct),
    yPct: round1(bottom ? 100 - heightPct - marginYPct : marginYPct),
    widthPct,
    heightPct,
  };
}

export const DEFAULT_PRESETS: Record<Exclude<CornerPreset, 'custom'>, MaskRegion> = {
  'bottom-right': regionForPreset('bottom-right'),
  'bottom-left': regionForPreset('bottom-left'),
  'top-right': regionForPreset('top-right'),
  'top-left': regionForPreset('top-left'),
};

export const DEFAULT_CONFIG: ProcessingConfig = {
  mode: 'content-aware',
  preset: 'bottom-right',
  region: { ...DEFAULT_PRESETS['bottom-right'] },
  intensity: 1,
  featherPx: 9,
  haloPx: 13,
};

// ---------------------------------------------------------------------------
// Quality profiles
// ---------------------------------------------------------------------------

interface FillProfile {
  /** Patch radius: 2 = 5x5, 3 = 7x7. */
  patchHalf: number;
  /**
   * Maximum pyramid depth. Level 0 is full resolution, each further level halves it.
   * Halving stops early once the hole is no larger than a patch, so the coarsest solve
   * is anchored almost entirely by real pixels instead of a blurred seed.
   */
  levels: number;
  /** PatchMatch passes at the coarsest level (global random search). */
  coarsePasses: number;
  /** PatchMatch passes at every finer level (local refinement). */
  finePasses: number;
  /** Whether to run PatchMatch at full resolution or only vote there. */
  fullResSolve: boolean;
  /** Source ring size as a multiple of the mask's larger side. */
  contextScale: number;
  /** Weight each patch's vote by how well it matched. */
  weightedVote: boolean;
  /** Passes when refining a field carried over from the previous frame. */
  temporalPasses: number;
  /** Random-search radius at refinement levels. */
  refineRadius: number;
  /** Extra candidates per pixel per pass drawn from anywhere in the window. */
  globalSamples: number;
  /** How much more a known (non-hole) target pixel counts in patch comparison. */
  knownWeight: number;
  /** Independent random restarts; the most coherent result wins. */
  restarts: number;
  /**
   * How decisively the final vote favours the best-matching patches. 1 = plain
   * weighting by match quality; higher values approach "copy the best patch", which
   * keeps grain and edges crisp instead of averaging them away.
   */
  finalSharpness: number;
  /** Averaging radius for levels that only vote (no solve); 1 = 3x3. */
  voteOnlyHalf: number;
  /**
   * After the finest solve, copy each hole pixel straight from the centre of its own
   * best-matching patch instead of averaging. Maximum crispness; relies on a coherent field.
   */
  copyFinal: boolean;
  /**
   * How much a propagated (neighbour-derived) candidate is favoured over an independent
   * one: 1 = none, 0.8 = wins unless 20% worse. Stronger coherence copies larger
   * contiguous chunks of real texture, which keeps grain and edges intact.
   */
  coherence: number;
  /**
   * After filling, measure fine-grain energy in the surrounding ring and in the fill and
   * add back the difference as luminance-correlated noise. Exhaustive patch search is
   * biased towards the least noisy source patches, so fills come out cleaner than the
   * footage around them; this restores the match.
   */
  grainMatch: boolean;
}

const PROFILES: Record<RenderQuality, FillProfile> = {
  low: {
    patchHalf: 2,
    levels: 2,
    coarsePasses: 3,
    finePasses: 0,
    fullResSolve: false,
    contextScale: 0.75,
    weightedVote: false,
    temporalPasses: 1,
    refineRadius: 8,
    globalSamples: 0,
    knownWeight: 1,
    restarts: 1,
    finalSharpness: 1,
    voteOnlyHalf: 1,
    copyFinal: false,
    coherence: 0.95,
    grainMatch: false,
  },
  medium: {
    patchHalf: 2,
    levels: 6,
    coarsePasses: 6,
    finePasses: 3,
    fullResSolve: true,
    contextScale: 1.0,
    weightedVote: true,
    temporalPasses: 1,
    refineRadius: 16,
    globalSamples: 1,
    knownWeight: 3,
    restarts: 1,
    finalSharpness: 12,
    voteOnlyHalf: 1,
    copyFinal: false,
    coherence: 0.85,
    grainMatch: true,
  },
  high: {
    patchHalf: 3,
    levels: 8,
    coarsePasses: 10,
    finePasses: 4,
    fullResSolve: true,
    contextScale: 2.0,
    weightedVote: true,
    temporalPasses: 2,
    refineRadius: 32,
    globalSamples: 2,
    knownWeight: 3,
    restarts: 3,
    finalSharpness: 12,
    voteOnlyHalf: 1,
    copyFinal: false,
    coherence: 0.8,
    grainMatch: true,
  },
};

export function getFillProfileSummary(quality: RenderQuality): string {
  const p = PROFILES[quality];
  const patch = p.patchHalf * 2 + 1;
  const restarts = p.restarts > 1 ? `, best of ${p.restarts} restarts` : '';
  return `${patch}x${patch} patches, ${p.levels}-level pyramid, ${p.coarsePasses}+${p.finePasses} passes, ${p.contextScale}x context${restarts}`;
}

// ---------------------------------------------------------------------------
// Content-aware fill (multi-scale PatchMatch exemplar synthesis)
// ---------------------------------------------------------------------------

const MIN_SOURCE_PATCHES = 32;
const MIN_LEVEL_HOLE = 3; // never build a level whose hole is smaller than this

interface NnfCacheEntry {
  level: number;
  sw: number;
  sh: number;
  hx0: number;
  hy0: number;
  hx1: number;
  hy1: number;
  nnf: Int32Array;
}

const nnfCache = new Map<string, NnfCacheEntry>();

/** Drops any cached nearest-neighbour field for the given key (e.g. when a new video loads). */
export function clearTemporalCache(key?: string): void {
  if (key === undefined) {
    nnfCache.clear();
    return;
  }
  for (const k of Array.from(nnfCache.keys())) {
    if (k === key || k.startsWith(`${key}:`)) nnfCache.delete(k);
  }
}

interface Hole {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface SourceField {
  /** True when a patch centred at (x, y) lies inside the window and clear of the hole. */
  isValid: (x: number, y: number) => boolean;
  /** Number of valid source centres. */
  count: number;
  /** A random valid source centre index, or -1 if none could be found. */
  random: () => number;
}

interface Level {
  sw: number;
  sh: number;
  hole: Hole;
  /**
   * Hole dilated by the patch radius, clamped to the window. Patches centred in this
   * ring overlap the hole, so they take part in matching and voting; their centres are
   * known pixels, which anchors the fill to the real border content.
   */
  solve: Hole;
  field: SourceField;
  /** Extra source exclusion around the hole at this level, in pixels. */
  margin: number;
  /** RGBA working image for this level. */
  img: Uint8ClampedArray;
  /** Per-pixel comparison weight: knownWeight outside the hole, 1 inside. Null = unweighted. */
  weights: Uint8Array | null;
}

function dilate(hole: Hole, half: number, sw: number, sh: number): Hole {
  return {
    x0: Math.max(0, hole.x0 - half),
    y0: Math.max(0, hole.y0 - half),
    x1: Math.min(sw, hole.x1 + half),
    y1: Math.min(sh, hole.y1 + half),
  };
}

/** Known (non-hole) pixels are ground truth, so they get a heavier say in patch matching. */
function makeWeights(sw: number, sh: number, hole: Hole, knownWeight: number): Uint8Array | null {
  if (knownWeight <= 1) return null;
  const w = new Uint8Array(sw * sh).fill(knownWeight);
  for (let y = hole.y0; y < hole.y1; y++) {
    w.fill(1, y * sw + hole.x0, y * sw + hole.x1);
  }
  return w;
}

/**
 * Describes where source patches may be taken from: inside the window, and at least
 * `half + margin` away from the hole so residual glow next to the mask is never copied.
 */
function makeSourceField(sw: number, sh: number, hole: Hole, half: number, margin: number): SourceField {
  const vx0 = half;
  const vy0 = half;
  const vx1 = sw - half;
  const vy1 = sh - half;
  const dx0 = Math.max(vx0, hole.x0 - half - margin);
  const dy0 = Math.max(vy0, hole.y0 - half - margin);
  const dx1 = Math.min(vx1, hole.x1 + half + margin);
  const dy1 = Math.min(vy1, hole.y1 + half + margin);

  const isValid = (x: number, y: number): boolean =>
    x >= vx0 && x < vx1 && y >= vy0 && y < vy1 && !(x >= dx0 && x < dx1 && y >= dy0 && y < dy1);

  const windowArea = Math.max(0, vx1 - vx0) * Math.max(0, vy1 - vy0);
  const blockedArea = Math.max(0, dx1 - dx0) * Math.max(0, dy1 - dy0);
  const count = windowArea - blockedArea;

  const random = (): number => {
    if (count <= 0) return -1;
    for (let k = 0; k < 64; k++) {
      const x = vx0 + ((Math.random() * (vx1 - vx0)) | 0);
      const y = vy0 + ((Math.random() * (vy1 - vy0)) | 0);
      if (isValid(x, y)) return y * sw + x;
    }
    for (let y = vy0; y < vy1; y++) {
      for (let x = vx0; x < vx1; x++) {
        if (isValid(x, y)) return y * sw + x;
      }
    }
    return -1;
  };

  return { isValid, count, random };
}

/**
 * Sum of squared RGB differences between the patch centred on the target pixel and the
 * patch centred on the source pixel. Offsets that would leave the window are skipped
 * (the hole may touch the frame edge). Bails out early once the running total passes
 * `limit`, which is what keeps PatchMatch fast.
 */
function patchDistance(
  img: Uint8ClampedArray,
  weights: Uint8Array | null,
  sw: number,
  sh: number,
  half: number,
  tx: number,
  ty: number,
  sx: number,
  sy: number,
  limit: number
): number {
  const dyStart = Math.max(-half, -ty);
  const dyEnd = Math.min(half, sh - 1 - ty);
  const dxStart = Math.max(-half, -tx);
  const dxEnd = Math.min(half, sw - 1 - tx);
  let d = 0;
  if (weights) {
    for (let dy = dyStart; dy <= dyEnd; dy++) {
      let tp = (ty + dy) * sw + tx + dxStart;
      let ti = tp * 4;
      let si = ((sy + dy) * sw + sx + dxStart) * 4;
      for (let dx = dxStart; dx <= dxEnd; dx++) {
        const dr = img[ti] - img[si];
        const dg = img[ti + 1] - img[si + 1];
        const db = img[ti + 2] - img[si + 2];
        d += (dr * dr + dg * dg + db * db) * weights[tp];
        tp++;
        ti += 4;
        si += 4;
      }
      if (d >= limit) return d;
    }
    return d;
  }
  for (let dy = dyStart; dy <= dyEnd; dy++) {
    let ti = ((ty + dy) * sw + tx + dxStart) * 4;
    let si = ((sy + dy) * sw + sx + dxStart) * 4;
    for (let dx = dxStart; dx <= dxEnd; dx++) {
      const dr = img[ti] - img[si];
      const dg = img[ti + 1] - img[si + 1];
      const db = img[ti + 2] - img[si + 2];
      d += dr * dr + dg * dg + db * db;
      ti += 4;
      si += 4;
    }
    if (d >= limit) return d;
  }
  return d;
}

/**
 * Seeds the hole with a smooth boundary interpolation. Deliberately structure-free: a
 * seed that imposes texture (e.g. mirrored edges) can lock the fill into a crisp but
 * misaligned solution that the search never escapes.
 */
function seedHole(img: Uint8ClampedArray, sw: number, sh: number, hole: Hole): void {
  const hw = hole.x1 - hole.x0;
  const hh = hole.y1 - hole.y0;
  const topY = Math.max(0, hole.y0 - 1);
  const botY = Math.min(sh - 1, hole.y1);
  const leftX = Math.max(0, hole.x0 - 1);
  const rightX = Math.min(sw - 1, hole.x1);
  for (let y = hole.y0; y < hole.y1; y++) {
    const vW = (y - hole.y0 + 0.5) / hh;
    for (let x = hole.x0; x < hole.x1; x++) {
      const hW = (x - hole.x0 + 0.5) / hw;
      const t = (topY * sw + x) * 4;
      const b = (botY * sw + x) * 4;
      const l = (y * sw + leftX) * 4;
      const r = (y * sw + rightX) * 4;
      const o = (y * sw + x) * 4;
      for (let c = 0; c < 3; c++) {
        const v = img[t + c] * (1 - vW) + img[b + c] * vW;
        const h = img[l + c] * (1 - hW) + img[r + c] * hW;
        img[o + c] = (v + h) * 0.5;
      }
    }
  }
}

/**
 * Rebuilds every hole pixel from the patches that overlap it. With `bestD` supplied the
 * votes are weighted by match quality (Wexler-style), which keeps texture crisp instead
 * of averaging good and bad matches into mush.
 */
function voteHole(
  level: Level,
  half: number,
  nnf: Int32Array,
  bestD: Float32Array | null,
  sharpness: number,
  voteHalf: number = half
): void {
  const { sw, hole, solve, img } = level;
  const solveW = solve.x1 - solve.x0;

  let sigma = 1;
  if (bestD) {
    let sum = 0;
    let n = 0;
    for (let i = 0; i < bestD.length; i++) {
      if (bestD[i] !== Infinity) {
        sum += bestD[i];
        n++;
      }
    }
    sigma = Math.max(1, sum / Math.max(1, n) / sharpness);
  }

  for (let y = hole.y0; y < hole.y1; y++) {
    for (let x = hole.x0; x < hole.x1; x++) {
      let sr = 0;
      let sg = 0;
      let sb = 0;
      let wsum = 0;
      const qy0 = Math.max(solve.y0, y - voteHalf);
      const qy1 = Math.min(solve.y1 - 1, y + voteHalf);
      const qx0 = Math.max(solve.x0, x - voteHalf);
      const qx1 = Math.min(solve.x1 - 1, x + voteHalf);
      for (let qy = qy0; qy <= qy1; qy++) {
        for (let qx = qx0; qx <= qx1; qx++) {
          // Pixel (x, y) sits at offset (x - qx, y - qy) inside the patch centred on q,
          // so it maps to the same offset inside q's matched source patch.
          const q = qy * sw + qx;
          const si = (nnf[q] + (y - qy) * sw + (x - qx)) * 4;
          const w = bestD ? Math.exp(-bestD[(qy - solve.y0) * solveW + (qx - solve.x0)] / sigma) : 1;
          sr += img[si] * w;
          sg += img[si + 1] * w;
          sb += img[si + 2] * w;
          wsum += w;
        }
      }
      if (wsum > 0) {
        const o = (y * sw + x) * 4;
        img[o] = sr / wsum;
        img[o + 1] = sg / wsum;
        img[o + 2] = sb / wsum;
      }
    }
  }
}

/**
 * Runs `passes` rounds of PatchMatch (propagation + random search) over the hole and,
 * after each round, rebuilds the hole pixels by voting. `nnf` must already hold a valid
 * source centre for every hole pixel.
 */
function patchMatch(
  level: Level,
  half: number,
  nnf: Int32Array,
  passes: number,
  maxRadius: number,
  weighted: boolean,
  globalSamples: number,
  finalSharpness: number,
  coherence: number
): number {
  const { sw, sh, solve, img, field, weights } = level;
  const hole = solve; // every patch overlapping the hole gets a match
  const hw = hole.x1 - hole.x0;
  const hh = hole.y1 - hole.y0;
  const bestD = new Float32Array(hw * hh).fill(Infinity);
  const isValid = field.isValid;

  for (let iter = 0; iter < passes; iter++) {
    const forward = iter % 2 === 0;
    const yStart = forward ? hole.y0 : hole.y1 - 1;
    const yEnd = forward ? hole.y1 : hole.y0 - 1;
    const step = forward ? 1 : -1;

    for (let y = yStart; y !== yEnd; y += step) {
      const xStart = forward ? hole.x0 : hole.x1 - 1;
      const xEnd = forward ? hole.x1 : hole.x0 - 1;
      for (let x = xStart; x !== xEnd; x += step) {
        const p = y * sw + x;
        const hp = (y - hole.y0) * hw + (x - hole.x0);
        let best = bestD[hp];
        let bestIdx = nnf[p];

        if (best === Infinity) {
          best = patchDistance(img, weights, sw, sh, half, x, y, bestIdx % sw, Math.floor(bestIdx / sw), Infinity);
        }

        // Propagation: borrow the neighbour's match, shifted by one pixel.
        const nx = x - step;
        if (nx >= hole.x0 && nx < hole.x1) {
          const q = nnf[y * sw + nx];
          const cx = (q % sw) + step;
          const cy = Math.floor(q / sw);
          if (isValid(cx, cy)) {
            const d = patchDistance(img, weights, sw, sh, half, x, y, cx, cy, best / coherence);
            if (d * coherence < best) {
              best = d;
              bestIdx = cy * sw + cx;
            }
          }
        }
        const ny = y - step;
        if (ny >= hole.y0 && ny < hole.y1) {
          const q = nnf[ny * sw + x];
          const cx = q % sw;
          const cy = Math.floor(q / sw) + step;
          if (isValid(cx, cy)) {
            const d = patchDistance(img, weights, sw, sh, half, x, y, cx, cy, best / coherence);
            if (d * coherence < best) {
              best = d;
              bestIdx = cy * sw + cx;
            }
          }
        }

        // A few candidates from anywhere in the window let the match escape a
        // locally consistent but globally wrong (e.g. phase-shifted) solution.
        for (let g = 0; g < globalSamples; g++) {
          const cand = field.random();
          if (cand < 0) break;
          const d = patchDistance(img, weights, sw, sh, half, x, y, cand % sw, Math.floor(cand / sw), best);
          if (d < best) {
            best = d;
            bestIdx = cand;
          }
        }

        // Random search around the current best at shrinking radii.
        const bx = bestIdx % sw;
        const by = Math.floor(bestIdx / sw);
        for (let r = maxRadius; r >= 1; r = r >> 1) {
          const cx = bx + Math.round((Math.random() * 2 - 1) * r);
          const cy = by + Math.round((Math.random() * 2 - 1) * r);
          if (!isValid(cx, cy)) continue;
          const d = patchDistance(img, weights, sw, sh, half, x, y, cx, cy, best);
          if (d < best) {
            best = d;
            bestIdx = cy * sw + cx;
          }
        }

        bestD[hp] = best;
        nnf[p] = bestIdx;
      }
    }

    // Vote decisively on every pass: a crisp target keeps phase-shifted candidates
    // distinguishable, so the field converges to a coherent, sharp fill.
    const last = iter === passes - 1;
    voteHole(level, half, nnf, weighted ? bestD : null, finalSharpness);

    // Matches were scored against the previous fill; rescore lazily next pass.
    if (!last) bestD.fill(Infinity);
  }

  // Coherence score: mean final match distance (lower is better).
  let sum = 0;
  for (let i = 0; i < bestD.length; i++) sum += bestD[i];
  return sum / Math.max(1, bestD.length);
}

/** Fills any hole entry that does not point at a valid source centre with a random one. */
function ensureValid(nnf: Int32Array, level: Level): boolean {
  const { sw, solve: hole, field } = level;
  for (let y = hole.y0; y < hole.y1; y++) {
    for (let x = hole.x0; x < hole.x1; x++) {
      const p = y * sw + x;
      const s = nnf[p];
      if (s <= 0 || !field.isValid(s % sw, Math.floor(s / sw))) {
        const r = field.random();
        if (r < 0) return false;
        nnf[p] = r;
      }
    }
  }
  return true;
}

/** Builds the next coarser level (2x2 box filter) from a level, or null if it would be too small. */
function downsampleLevel(src: Level, half: number): Level | null {
  const sw = src.sw >> 1;
  const sh = src.sh >> 1;
  const hole: Hole = {
    x0: src.hole.x0 >> 1,
    y0: src.hole.y0 >> 1,
    x1: Math.min(sw, (src.hole.x1 + 1) >> 1),
    y1: Math.min(sh, (src.hole.y1 + 1) >> 1),
  };
  if (sw < half * 4 + 2 || sh < half * 4 + 2) return null;
  if (hole.x1 - hole.x0 < MIN_LEVEL_HOLE || hole.y1 - hole.y0 < MIN_LEVEL_HOLE) return null;

  const margin = src.margin >> 1;
  const field = makeSourceField(sw, sh, hole, half, margin);
  if (field.count < MIN_SOURCE_PATCHES) return null;

  const img = new Uint8ClampedArray(sw * sh * 4);
  const s = src.img;
  const ssw = src.sw;
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const a = (2 * y * ssw + 2 * x) * 4;
      const b = a + 4;
      const c = a + ssw * 4;
      const d = c + 4;
      const o = (y * sw + x) * 4;
      img[o] = (s[a] + s[b] + s[c] + s[d]) * 0.25;
      img[o + 1] = (s[a + 1] + s[b + 1] + s[c + 1] + s[d + 1]) * 0.25;
      img[o + 2] = (s[a + 2] + s[b + 2] + s[c + 2] + s[d + 2]) * 0.25;
      img[o + 3] = 255;
    }
  }
  const knownWeight = src.weights ? src.weights[0] : 1;
  return {
    sw,
    sh,
    hole,
    solve: dilate(hole, half, sw, sh),
    field,
    margin,
    img,
    weights: makeWeights(sw, sh, hole, knownWeight),
  };
}

/** Expands a coarse level's field to the next finer level: each pixel follows its parent's offset. */
function upsampleNnf(coarse: Level, cNnf: Int32Array, fine: Level): Int32Array {
  const nnf = new Int32Array(fine.sw * fine.sh);
  const { sw: cw, solve: cHole } = coarse;
  const { sw, solve: hole } = fine;
  for (let y = hole.y0; y < hole.y1; y++) {
    const cy = Math.max(cHole.y0, Math.min(cHole.y1 - 1, y >> 1));
    for (let x = hole.x0; x < hole.x1; x++) {
      const cx = Math.max(cHole.x0, Math.min(cHole.x1 - 1, x >> 1));
      const s = cNnf[cy * cw + cx];
      const sx = (s % cw) * 2 + (x & 1);
      const sy = Math.floor(s / cw) * 2 + (y & 1);
      nnf[y * sw + x] = sy * sw + sx;
    }
  }
  return nnf;
}

/**
 * Fills the hole rectangle inside a window of sw x sh RGBA pixels by synthesising texture
 * from the surrounding valid pixels, coarse-to-fine.
 *
 * Returns false when the window has too little valid context to source patches from,
 * in which case the caller falls back to a simple interpolation.
 */
function contentAwareFill(
  data: Uint8ClampedArray,
  sw: number,
  sh: number,
  hole: Hole,
  inner: Hole,
  featherPx: number,
  sourceMargin: number,
  profile: FillProfile,
  cacheKey: string | null
): boolean {
  const half = profile.patchHalf;
  const field = makeSourceField(sw, sh, hole, half, sourceMargin);
  if (field.count < MIN_SOURCE_PATCHES) return false;

  const buildLevels = (): Level[] => {
    // Level 0 works on a copy so `data` keeps the originals for feathering.
    const levels: Level[] = [
      {
        sw,
        sh,
        hole,
        solve: dilate(hole, half, sw, sh),
        field,
        margin: sourceMargin,
        img: new Uint8ClampedArray(data),
        weights: makeWeights(sw, sh, hole, profile.knownWeight),
      },
    ];
    seedHole(levels[0].img, sw, sh, hole);
    const patch = half * 2 + 1;
    for (let k = 1; k < profile.levels; k++) {
      const prev = levels[k - 1].hole;
      if (prev.x1 - prev.x0 <= patch && prev.y1 - prev.y0 <= patch) break;
      const next = downsampleLevel(levels[k - 1], half);
      if (!next) break;
      levels.push(next);
    }
    return levels;
  };

  let levels = buildLevels();
  // The finest level that gets a PatchMatch solve (the rest only vote).
  const solveLevel = profile.fullResSolve ? 0 : Math.min(1, levels.length - 1);

  const cached = cacheKey ? nnfCache.get(cacheKey) : undefined;
  const reuseLevel = cached ? levels[cached.level] : undefined;
  const reuse =
    !!cached &&
    !!reuseLevel &&
    cached.level === solveLevel &&
    cached.sw === reuseLevel.sw &&
    cached.sh === reuseLevel.sh &&
    cached.hx0 === reuseLevel.hole.x0 &&
    cached.hy0 === reuseLevel.hole.y0 &&
    cached.hx1 === reuseLevel.hole.x1 &&
    cached.hy1 === reuseLevel.hole.y1;

  let nnf: Int32Array;

  if (reuse) {
    // Carry the previous frame's field and refine it locally.
    const lvl = levels[solveLevel];
    nnf = cached!.nnf;
    if (!ensureValid(nnf, lvl)) return false;
    patchMatch(
      lvl,
      half,
      nnf,
      profile.temporalPasses,
      profile.refineRadius,
      profile.weightedVote,
      profile.globalSamples,
      profile.finalSharpness,
      profile.coherence
    );
  } else {
    // Coarse-to-fine solve. Higher profiles try several random starts and keep the
    // one whose matches are most coherent.
    const solve = (lv: Level[]): { nnf: Int32Array; score: number } | null => {
      const top = lv.length - 1;
      let f: Int32Array = new Int32Array(lv[top].sw * lv[top].sh);
      if (!ensureValid(f, lv[top])) return null;
      let score = patchMatch(
        lv[top],
        half,
        f,
        profile.coarsePasses,
        Math.max(lv[top].sw, lv[top].sh),
        profile.weightedVote,
        profile.globalSamples,
        profile.finalSharpness,
        profile.coherence
      );
      for (let k = top - 1; k >= solveLevel; k--) {
        f = upsampleNnf(lv[k + 1], f, lv[k]);
        if (!ensureValid(f, lv[k])) return null;
        score = patchMatch(
          lv[k],
          half,
          f,
          Math.max(1, profile.finePasses),
          profile.refineRadius,
          profile.weightedVote,
          profile.globalSamples,
          profile.finalSharpness,
          profile.coherence
        );
      }
      return { nnf: f, score };
    };

    let best: { nnf: Int32Array; score: number; levels: Level[] } | null = null;
    for (let r = 0; r < Math.max(1, profile.restarts); r++) {
      const lv = r === 0 ? levels : buildLevels();
      const result = solve(lv);
      if (!result) continue;
      if (!best || result.score < best.score) best = { ...result, levels: lv };
    }
    if (!best) return false;
    nnf = best.nnf;
    levels = best.levels;
  }

  if (cacheKey) {
    const lvl = levels[solveLevel];
    nnfCache.set(cacheKey, {
      level: solveLevel,
      sw: lvl.sw,
      sh: lvl.sh,
      hx0: lvl.hole.x0,
      hy0: lvl.hole.y0,
      hx1: lvl.hole.x1,
      hy1: lvl.hole.y1,
      nnf,
    });
  }

  if (profile.copyFinal && solveLevel === 0) {
    const lvl = levels[0];
    const img = lvl.img;
    for (let y = hole.y0; y < hole.y1; y++) {
      for (let x = hole.x0; x < hole.x1; x++) {
        const o = (y * sw + x) * 4;
        const si = nnf[y * sw + x] * 4;
        img[o] = img[si];
        img[o + 1] = img[si + 1];
        img[o + 2] = img[si + 2];
      }
    }
  }

  // Levels below the solve level only receive an upsampled field and a vote.
  for (let k = solveLevel - 1; k >= 0; k--) {
    nnf = upsampleNnf(levels[k + 1], nnf, levels[k]);
    if (!ensureValid(nnf, levels[k])) return false;
    voteHole(levels[k], half, nnf, null, 1, profile.voteOnlyHalf);
  }

  const img = levels[0].img;
  if (profile.grainMatch) matchGrain(img, sw, sh, hole, half);

  // Write back. Everything inside `inner` (mask + glow margin) is replaced outright;
  // the band between `inner` and `hole` fades from fill to original with a smooth curve.
  const feather = Math.max(1, featherPx);
  for (let y = hole.y0; y < hole.y1; y++) {
    for (let x = hole.x0; x < hole.x1; x++) {
      const outside = Math.max(inner.x0 - x, x - (inner.x1 - 1), inner.y0 - y, y - (inner.y1 - 1));
      let t = 1;
      if (outside > 0) {
        const u = Math.min(1, outside / (feather + 1));
        t = 1 - u * u * (3 - 2 * u);
      }
      const j = (y * sw + x) * 4;
      data[j] = data[j] * (1 - t) + img[j] * t;
      data[j + 1] = data[j + 1] * (1 - t) + img[j + 1] * t;
      data[j + 2] = data[j + 2] * (1 - t) + img[j + 2] * t;
    }
  }
  return true;
}

/**
 * Robust fine-grain estimate over a rectangle: 1.4826 x median absolute residual
 * (pixel minus 4-neighbour mean), per channel. The median ignores edges and texture,
 * so a bright object next to the mask does not inflate the estimate.
 */
function grainSigma(
  img: Uint8ClampedArray,
  sw: number,
  rect: Hole,
  skip: Hole | null
): [number, number, number] {
  const res: Float32Array[] = [new Float32Array(0), new Float32Array(0), new Float32Array(0)];
  const w = rect.x1 - rect.x0 - 2;
  const h = rect.y1 - rect.y0 - 2;
  if (w <= 0 || h <= 0) return [0, 0, 0];
  for (let c = 0; c < 3; c++) res[c] = new Float32Array(w * h);
  let n = 0;
  for (let y = rect.y0 + 1; y < rect.y1 - 1; y++) {
    for (let x = rect.x0 + 1; x < rect.x1 - 1; x++) {
      if (skip && x >= skip.x0 && x < skip.x1 && y >= skip.y0 && y < skip.y1) continue;
      const i = (y * sw + x) * 4;
      for (let c = 0; c < 3; c++) {
        res[c][n] = Math.abs(
          img[i + c] - (img[i - 4 + c] + img[i + 4 + c] + img[i - sw * 4 + c] + img[i + sw * 4 + c]) * 0.25
        );
      }
      n++;
    }
  }
  if (n === 0) return [0, 0, 0];
  const out: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const v = res[c].subarray(0, n).sort();
    out[c] = 1.4826 * v[n >> 1];
  }
  return out;
}

/**
 * Adds luminance-correlated noise inside the hole so its fine grain matches the ring of
 * real pixels around it. Amplitude is capped, and faded out near black and white so
 * clipping cannot shift the average brightness of the fill.
 */
function matchGrain(img: Uint8ClampedArray, sw: number, sh: number, hole: Hole, half: number): void {
  const ringW = Math.max(8, half * 4);
  const ring: Hole = {
    x0: Math.max(0, hole.x0 - ringW),
    y0: Math.max(0, hole.y0 - ringW),
    x1: Math.min(sw, hole.x1 + ringW),
    y1: Math.min(sh, hole.y1 + ringW),
  };
  const inner: Hole = { x0: hole.x0 + 2, y0: hole.y0 + 2, x1: hole.x1 - 2, y1: hole.y1 - 2 };
  if (inner.x1 - inner.x0 < 4 || inner.y1 - inner.y0 < 4) return;

  const want = grainSigma(img, sw, ring, hole);
  const have = grainSigma(img, sw, inner, null);

  // The residual operator scales white noise by sqrt(1.25).
  const add = [0, 1, 2].map((c) =>
    Math.min(8, Math.sqrt(Math.max(0, want[c] * want[c] - have[c] * have[c])) / Math.sqrt(1.25))
  );
  if (Math.max(add[0], add[1], add[2]) < 0.5) return;

  for (let y = hole.y0; y < hole.y1; y++) {
    for (let x = hole.x0; x < hole.x1; x++) {
      const i = (y * sw + x) * 4;
      const lum = 0.299 * img[i] + 0.587 * img[i + 1] + 0.114 * img[i + 2];
      // Fade the grain out within 24 levels of black or white.
      const k = Math.min(1, Math.min(lum, 255 - lum) / 24);
      if (k <= 0) continue;
      const u = Math.max(1e-9, Math.random());
      const v = Math.random();
      const g = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) * k;
      img[i] += g * add[0];
      img[i + 1] += g * add[1];
      img[i + 2] += g * add[2];
    }
  }
}

// ---------------------------------------------------------------------------
// Frame processor
// ---------------------------------------------------------------------------

/**
 * Applies the selected watermark removal algorithm directly to a 2D Canvas context's pixel buffer.
 */
export function processCanvasFrame(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  config: ProcessingConfig,
  options: ProcessOptions = {}
): void {
  if (width < 2 || height < 2) return;

  const quality = options.quality ?? 'medium';
  const profile = PROFILES[quality];

  // Clamp the region so it always lies fully inside the frame. The minimum size is
  // applied before the edge clamp so a mask placed at the far edge can never
  // index past the end of the pixel buffer.
  const clampRect = (x: number, y: number, w: number, h: number) => {
    const cx = Math.max(0, Math.min(width - 1, x));
    const cy = Math.max(0, Math.min(height - 1, y));
    return {
      x: cx,
      y: cy,
      w: Math.min(width - cx, Math.max(1, w - (cx - x))),
      h: Math.min(height - cy, Math.max(1, h - (cy - y))),
    };
  };

  // Inner rect: the mask box grown by the glow margin. This is replaced outright.
  const halo = Math.max(0, Math.round(config.haloPx ?? 0));
  const inner = clampRect(
    Math.floor((config.region.xPct / 100) * width) - halo,
    Math.floor((config.region.yPct / 100) * height) - halo,
    Math.floor((config.region.widthPct / 100) * width) + halo * 2,
    Math.floor((config.region.heightPct / 100) * height) + halo * 2
  );
  // Outer rect: content-aware fill also synthesises a feather band around the inner rect.
  const band = config.mode === 'content-aware' ? Math.max(0, Math.round(config.featherPx)) : 0;
  const outer = clampRect(inner.x - band, inner.y - band, inner.w + band * 2, inner.h + band * 2);

  const rx = outer.x;
  const ry = outer.y;
  const rw = outer.w;
  const rh = outer.h;
  if (rw <= 0 || rh <= 0) return;

  // Content-aware fill needs a generous ring of real texture to sample from; the
  // other modes only need a few pixels of context.
  const pad =
    config.mode === 'content-aware'
      ? Math.max(config.featherPx, Math.round(Math.max(rw, rh) * profile.contextScale), 32)
      : Math.max(4, config.featherPx);
  const sx = Math.max(0, rx - pad);
  const sy = Math.max(0, ry - pad);
  // When the mask is clamped against the left/top edge the window simply extends
  // further right/down so the fill keeps the same amount of context.
  const sw = Math.min(width - sx, rw + pad * 2);
  const sh = Math.min(height - sy, rh + pad * 2);

  const imageData = ctx.getImageData(sx, sy, sw, sh);
  const data = imageData.data;
  // The content-aware path keeps its own working copy; the other modes read from this one.
  const copy = config.mode === 'content-aware' ? data : new Uint8ClampedArray(data);

  const localX0 = rx - sx;
  const localY0 = ry - sy;
  const localX1 = localX0 + rw;
  const localY1 = localY0 + rh;

  const getIdx = (x: number, y: number) => (y * sw + x) * 4;

  if (config.mode === 'content-aware') {
    const cacheKey = options.temporalKey ? `${options.temporalKey}:${quality}` : null;
    // Keep sources clear of any glow that still reaches past the (already expanded) mask.
    const sourceMargin = Math.max(4, Math.round(Math.max(rw, rh) * 0.08));
    const filled = contentAwareFill(
      data,
      sw,
      sh,
      { x0: localX0, y0: localY0, x1: localX1, y1: localY1 },
      {
        x0: inner.x - sx,
        y0: inner.y - sy,
        x1: inner.x - sx + inner.w,
        y1: inner.y - sy + inner.h,
      },
      config.featherPx,
      sourceMargin,
      profile,
      cacheKey
    );
    if (!filled) {
      bilinearFallback(data, copy, sw, sh, localX0, localY0, localX1, localY1, config.featherPx);
    }
  } else if (config.mode === 'reverse-alpha') {
    // Reverse semi-transparent white/sparkle overlay using surrounding ambient luminance reference
    for (let y = localY0; y < localY1; y++) {
      const topSampleY = Math.max(0, localY0 - 3);
      const leftSampleX = Math.max(0, localX0 - 3);

      for (let x = localX0; x < localX1; x++) {
        const idx = getIdx(x, y);
        const refIdx1 = getIdx(x, topSampleY);
        const refIdx2 = getIdx(leftSampleX, y);

        const refR = (copy[refIdx1] + copy[refIdx2]) * 0.5;
        const refG = (copy[refIdx1 + 1] + copy[refIdx2 + 1]) * 0.5;
        const refB = (copy[refIdx1 + 2] + copy[refIdx2 + 2]) * 0.5;

        const r = copy[idx];
        const g = copy[idx + 1];
        const b = copy[idx + 2];

        // Detect excess brightness caused by translucent white/silver watermark logo
        const lumCurrent = 0.299 * r + 0.587 * g + 0.114 * b;
        const lumRef = 0.299 * refR + 0.587 * refG + 0.114 * refB;
        const lumDelta = Math.max(0, lumCurrent - lumRef);

        if (lumDelta > 6) {
          const estAlpha = Math.min(
            0.85,
            (lumDelta / Math.max(25, 255 - lumRef)) * config.intensity * 1.35
          );
          const unblendR = (r - estAlpha * 255) / (1 - estAlpha);
          const unblendG = (g - estAlpha * 255) / (1 - estAlpha);
          const unblendB = (b - estAlpha * 255) / (1 - estAlpha);

          data[idx] = Math.max(0, Math.min(255, Math.round(unblendR * 0.7 + refR * 0.3)));
          data[idx + 1] = Math.max(0, Math.min(255, Math.round(unblendG * 0.7 + refG * 0.3)));
          data[idx + 2] = Math.max(0, Math.min(255, Math.round(unblendB * 0.7 + refB * 0.3)));
        }
      }
    }
  } else if (config.mode === 'feather-blur') {
    // Wide radius neighborhood smoothing
    const radius = Math.max(4, Math.round(config.intensity * 12));
    for (let y = localY0; y < localY1; y++) {
      for (let x = localX0; x < localX1; x++) {
        let sumR = 0;
        let sumG = 0;
        let sumB = 0;
        let count = 0;

        for (let ky = -radius; ky <= radius; ky += 2) {
          for (let kx = -radius; kx <= radius; kx += 2) {
            const sySample = Math.max(0, Math.min(sh - 1, y + ky));
            const sxSample = Math.max(0, Math.min(sw - 1, x + kx));
            const sIdx = getIdx(sxSample, sySample);
            sumR += copy[sIdx];
            sumG += copy[sIdx + 1];
            sumB += copy[sIdx + 2];
            count++;
          }
        }

        const idxTarget = getIdx(x, y);
        data[idxTarget] = Math.round(sumR / count);
        data[idxTarget + 1] = Math.round(sumG / count);
        data[idxTarget + 2] = Math.round(sumB / count);
      }
    }
  }

  ctx.putImageData(imageData, sx, sy);
}

/** Smooth boundary interpolation used only when there is no texture to sample from. */
function bilinearFallback(
  data: Uint8ClampedArray,
  copy: Uint8ClampedArray,
  sw: number,
  sh: number,
  localX0: number,
  localY0: number,
  localX1: number,
  localY1: number,
  featherPx: number
): void {
  const rw = localX1 - localX0;
  const rh = localY1 - localY0;
  const getIdx = (x: number, y: number) => (y * sw + x) * 4;
  const topSampleY = Math.max(0, localY0 - 2);
  const bottomSampleY = Math.min(sh - 1, localY1 + 1);
  const leftSampleX = Math.max(0, localX0 - 2);
  const rightSampleX = Math.min(sw - 1, localX1 + 1);

  for (let y = localY0; y < localY1; y++) {
    const vWeight = (y - localY0) / Math.max(1, rh);
    for (let x = localX0; x < localX1; x++) {
      const hWeight = (x - localX0) / Math.max(1, rw);
      const idxTop = getIdx(x, topSampleY);
      const idxBottom = getIdx(x, bottomSampleY);
      const idxLeft = getIdx(leftSampleX, y);
      const idxRight = getIdx(rightSampleX, y);
      const idxTarget = getIdx(x, y);

      const minEdgeDist = Math.min(x - localX0, localX1 - 1 - x, y - localY0, localY1 - 1 - y);
      const t = Math.min(1, (minEdgeDist + 0.5) / Math.max(1, featherPx));

      for (let c = 0; c < 3; c++) {
        const vertInterp = copy[idxTop + c] * (1 - vWeight) + copy[idxBottom + c] * vWeight;
        const horizInterp = copy[idxLeft + c] * (1 - hWeight) + copy[idxRight + c] * hWeight;
        const interpolated = (vertInterp + horizInterp) * 0.5;
        data[idxTarget + c] = Math.round(copy[idxTarget + c] * (1 - t) + interpolated * t);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Demo media
// ---------------------------------------------------------------------------

/**
 * Generates a realistic high-resolution sample image with a semi-transparent corner
 * sparkle watermark so the user can test the removal engine with one click.
 */
export function createDemoWatermarkedImage(): string {
  const canvas = document.createElement('canvas');
  canvas.width = 1280;
  canvas.height = 720;
  const ctx = canvas.getContext('2d')!;

  // Rich cinematic twilight landscape gradient
  const grad = ctx.createLinearGradient(0, 0, 1280, 720);
  grad.addColorStop(0, '#0f172a');
  grad.addColorStop(0.45, '#1e1b4b');
  grad.addColorStop(0.8, '#311042');
  grad.addColorStop(1, '#090d16');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 1280, 720);

  // Decorative glowing orbs / aurora waves
  const orb1 = ctx.createRadialGradient(380, 260, 20, 380, 260, 340);
  orb1.addColorStop(0, 'rgba(99, 102, 241, 0.45)');
  orb1.addColorStop(1, 'rgba(99, 102, 241, 0)');
  ctx.fillStyle = orb1;
  ctx.fillRect(0, 0, 1280, 720);

  const orb2 = ctx.createRadialGradient(920, 420, 20, 920, 420, 380);
  orb2.addColorStop(0, 'rgba(6, 182, 212, 0.35)');
  orb2.addColorStop(1, 'rgba(6, 182, 212, 0)');
  ctx.fillStyle = orb2;
  ctx.fillRect(0, 0, 1280, 720);

  // Subtle mountain silhouettes
  ctx.fillStyle = '#0b0f1d';
  ctx.beginPath();
  ctx.moveTo(0, 720);
  ctx.lineTo(0, 520);
  ctx.lineTo(280, 390);
  ctx.lineTo(590, 510);
  ctx.lineTo(920, 360);
  ctx.lineTo(1280, 490);
  ctx.lineTo(1280, 720);
  ctx.closePath();
  ctx.fill();

  // Fine grain so the content-aware fill has real texture to reproduce.
  const grain = ctx.getImageData(0, 0, 1280, 720);
  const g = grain.data;
  for (let i = 0; i < g.length; i += 4) {
    const n = (Math.random() - 0.5) * 14;
    g[i] += n;
    g[i + 1] += n;
    g[i + 2] += n;
  }
  ctx.putImageData(grain, 0, 0);

  // Draw simulated corner AI sparkle watermark in bottom-right
  drawSimulatedWatermarkBadge(ctx, 1280, 720);

  return canvas.toDataURL('image/png');
}

export function drawSimulatedWatermarkBadge(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number
): void {
  // Drawn inside the calibrated default mask (see regionForPreset) so the sample media
  // demonstrates the defaults as shipped: a small sparkle badge with a soft glow.
  const box = DEFAULT_PRESETS['bottom-right'];
  const x0 = (box.xPct / 100) * width;
  const y0 = (box.yPct / 100) * height;
  const h = (box.heightPct / 100) * height;

  ctx.save();
  ctx.shadowColor = 'rgba(255, 255, 255, 0.55)';
  ctx.shadowBlur = h * 0.9;

  // Four-point sparkle
  const cx = x0 + h * 0.65;
  const cy = y0 + h * 0.5;
  const outerR = h * 0.42;
  const innerR = h * 0.14;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.78)';
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const r = i % 2 === 0 ? outerR : innerR;
    const angle = (i * Math.PI) / 4;
    const px = cx + Math.cos(angle) * r;
    const py = cy + Math.sin(angle) * r;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fill();

  // Badge text
  ctx.font = `600 ${Math.max(9, h * 0.6)}px sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(255, 255, 255, 0.72)';
  ctx.fillText('Gemini', x0 + h * 1.35, cy);
  ctx.restore();
}
