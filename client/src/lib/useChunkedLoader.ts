import { useCallback, useRef, useState } from "react";
import { runChunked, type ChunkPhase, type RunChunkedOptions } from "./chunkedWork";

export interface LoaderView {
  active: boolean;
  title: string;
  subtitle?: string;
  label: string;
  progress: number;
}

const IDLE: LoaderView = { active: false, title: "", label: "", progress: 0 };

/**
 * Drives a full-screen loading view from a chunked job.
 *
 * `runLoader` shows the view, runs the phases with the main thread handed back
 * between each one so the bar can move, then hides it again. The phases run in
 * order on the same thread, so any seeded generation inside them behaves exactly
 * as it did when the same work ran as one synchronous block.
 */
export function useChunkedLoader() {
  const [loader, setLoader] = useState<LoaderView>(IDLE);
  const busyRef = useRef(false);

  const runLoader = useCallback(async (
    opts: { title: string; subtitle?: string; phases: ChunkPhase[] } & RunChunkedOptions,
  ): Promise<boolean> => {
    // A second click while a job is running must not start a duplicate run.
    if (busyRef.current) return false;
    busyRef.current = true;
    const { title, subtitle, phases, minDurationMs = 450, onProgress } = opts;
    setLoader({ active: true, title, subtitle, label: phases[0]?.label ?? "", progress: 0 });
    try {
      await runChunked(phases, {
        minDurationMs,
        onProgress: p => {
          onProgress?.(p);
          setLoader(prev => (prev.active ? { ...prev, label: p.label, progress: p.progress } : prev));
        },
      });
      return true;
    } finally {
      busyRef.current = false;
      setLoader(IDLE);
    }
  }, []);

  return { loader, runLoader };
}
