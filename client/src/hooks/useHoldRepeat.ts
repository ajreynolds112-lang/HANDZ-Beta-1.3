import { useEffect, useRef } from "react";

const HOLD_REPEAT_DELAY_MS = 500;
const HOLD_REPEAT_INTERVAL_MS = 50;

/** Click fires once; press-and-hold repeats after a short delay. Spread the result onto a button. */
export function useHoldRepeat(action: () => void) {
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const repeatedRef = useRef(false);
  const actionRef = useRef(action);
  actionRef.current = action;

  const clear = () => {
    if (timeoutRef.current !== null) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }
    if (intervalRef.current !== null) { clearInterval(intervalRef.current); intervalRef.current = null; }
    window.removeEventListener("mouseup", clear);
    window.removeEventListener("touchend", clear);
    window.removeEventListener("touchcancel", clear);
  };

  const start = () => {
    clear();
    repeatedRef.current = false;
    window.addEventListener("mouseup", clear);
    window.addEventListener("touchend", clear);
    window.addEventListener("touchcancel", clear);
    timeoutRef.current = setTimeout(() => {
      intervalRef.current = setInterval(() => {
        repeatedRef.current = true;
        actionRef.current();
      }, HOLD_REPEAT_INTERVAL_MS);
    }, HOLD_REPEAT_DELAY_MS);
  };

  const handleClick = () => {
    if (repeatedRef.current) {
      repeatedRef.current = false;
      return;
    }
    actionRef.current();
  };

  useEffect(() => clear, []);

  return {
    onMouseDown: start,
    onMouseLeave: clear,
    onTouchStart: start,
    onClick: handleClick,
  };
}
