/**
 * Chunked work runner.
 *
 * Heavy career transitions (week simulation, roster self-heal, fight setup) used
 * to run as one long synchronous block, which froze the whole page — no paint,
 * no loading screen, nothing but a stalled tab. These helpers slice that work
 * into phases and hand the main thread back to the browser between them, so a
 * loading screen can actually paint and its progress bar can move.
 *
 * Nothing here changes what the work does: phases run in the order they are
 * given, on the same thread, so any seeded rng() draw order is preserved exactly.
 */

/** A single unit of work in a chunked job. */
export interface ChunkPhase {
  /** Shown on the loading screen while this phase runs. */
  label: string;
  /** Relative share of the progress bar. Defaults to 1. */
  weight?: number;
  /**
   * The work itself. Return a generator to split the phase further: each
   * `yield` hands control back to the browser, and a yielded string relabels
   * the phase.
   */
  run: () => void | Generator<string | void, void, void>;
}

export interface ChunkedProgress {
  /** 0..1 across the whole job. */
  progress: number;
  /** The phase label currently being worked on. */
  label: string;
}

export interface RunChunkedOptions {
  /** Called before each phase and after each internal yield. */
  onProgress?: (p: ChunkedProgress) => void;
  /**
   * Keep the job (and therefore the loading screen) up for at least this long so
   * a fast machine doesn't flash the screen for two frames. Defaults to 0.
   */
  minDurationMs?: number;
}

/**
 * Hand the main thread back to the browser long enough for it to paint.
 * requestAnimationFrame alone only guarantees we run *before* the next paint —
 * the setTimeout after it resumes us once that paint has actually happened.
 */
export function yieldToBrowser(): Promise<void> {
  return new Promise<void>(resolve => {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => setTimeout(resolve, 0));
    } else {
      setTimeout(resolve, 0);
    }
  });
}

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

/**
 * Run `phases` one at a time, yielding to the browser between each so the page
 * can paint. Resolves once every phase has run (and `minDurationMs` has elapsed).
 */
export async function runChunked(phases: ChunkPhase[], opts: RunChunkedOptions = {}): Promise<void> {
  const { onProgress, minDurationMs = 0 } = opts;
  const startedAt = now();
  const totalWeight = phases.reduce((sum, p) => sum + (p.weight ?? 1), 0) || 1;
  let done = 0;

  for (let i = 0; i < phases.length; i++) {
    const phase = phases[i];
    const weight = phase.weight ?? 1;
    // Pad before the final phase, not after it. The last phase is usually the
    // one that swaps the screen (opens the gym, starts the ring walk), so
    // waiting afterwards would leave the loading screen sitting on top of a
    // view that has already moved on.
    if (i === phases.length - 1 && minDurationMs > 0) {
      const soFar = now() - startedAt;
      if (soFar < minDurationMs) await new Promise<void>(r => setTimeout(r, minDurationMs - soFar));
    }
    onProgress?.({ progress: done / totalWeight, label: phase.label });
    // Paint the new label (and the bar position) before the phase blocks.
    await yieldToBrowser();

    const result = phase.run();
    if (result && typeof (result as Generator).next === "function") {
      const gen = result as Generator<string | void, void, void>;
      let label = phase.label;
      // A phase that yields reports sub-progress; the number of steps isn't
      // known up front, so the bar eases toward the phase's end instead of
      // jumping. Each yield gets us 40% of the remaining slice.
      let inner = 0;
      let step = gen.next();
      while (!step.done) {
        if (typeof step.value === "string" && step.value) label = step.value;
        inner = inner + (1 - inner) * 0.4;
        onProgress?.({ progress: (done + weight * inner) / totalWeight, label });
        await yieldToBrowser();
        step = gen.next();
      }
    }

    done += weight;
    onProgress?.({ progress: done / totalWeight, label: phase.label });
  }

  onProgress?.({ progress: 1, label: phases[phases.length - 1]?.label ?? "" });
}
