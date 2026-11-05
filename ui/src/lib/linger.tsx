import { createContext, useContext, useEffect, useReducer, useRef, type ReactNode } from "react";

// A sheet or dialog shown as `{cond && <X/>}` was taken off the page the moment cond went false, so it opened sliding
// in and closed in a blink: Radix plays the closing animation only while the element is still there with open={false}.
// <Linger> keeps what it last showed for the length of that animation, telling the Sheet / Dialog inside it (through
// this context, components/ui/sheet.tsx and dialog.tsx) that it is closing.

const Leaving = createContext(false);

/** Whether the overlay is on its way out (its Root then gets open={false}). */
export function useLeaving() {
  return useContext(Leaving);
}

/** Shows children; once they become nothing, keeps the last ones `ms` longer as closing (the sheet's 300ms slide). */
export function Linger({ children, ms = 300 }: { children: ReactNode; ms?: number }) {
  const shown = children != null && children !== false && children !== "";
  const last = useRef<ReactNode>(null);
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  if (shown) last.current = children;
  useEffect(() => {
    if (shown || !last.current) return;
    const t = setTimeout(() => {
      last.current = null;
      redraw();
    }, ms);
    return () => clearTimeout(t);
  }, [shown]);
  // The same tree either way, so the element stays mounted (and animates) instead of being remade
  return <Leaving.Provider value={!shown}>{shown ? children : last.current}</Leaving.Provider>;
}
