import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** shadcn/ui's class joiner: later Tailwind classes win over earlier ones (className overrides a component's own). */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * An Enter that means "send": not one confirming an input method's candidate (typing Chinese, Japanese…: the Enter
 * that picks a word fires keydown too, with isComposing / keyCode 229), and not Shift+Enter (a new line).
 */
export function isSubmitEnter(e: { key: string; shiftKey?: boolean; keyCode?: number; nativeEvent?: { isComposing?: boolean } }) {
  return e.key === "Enter" && !e.shiftKey && !e.nativeEvent?.isComposing && e.keyCode !== 229;
}
