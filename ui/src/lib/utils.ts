import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** shadcn/ui's class joiner: later Tailwind classes win over earlier ones (className overrides a component's own). */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
