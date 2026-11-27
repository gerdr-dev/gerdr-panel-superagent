import * as core from "@gerdr/core";
import type { ReactNode } from "react";

// The board's tasks in Gerdr's ⌘K palette (@gerdr/core useSearchItems): while the board is shown, ⌘K finds a task by
// its title, id, repo or what was asked. Through the namespace, so a Gerdr from before useSearchItems still runs this
// panel (⌘K then lists only Gerdr's commands and conversations).

type Item = { id?: string; sessionId?: string; label: string; detail?: string; tone?: "brand" | "ok" | "warn" | "bad"; pill?: boolean; keywords?: string; icon?: ReactNode; onSelect: () => void };
const fromCore = (core as unknown as { useSearchItems?: (items: Item[], opts?: { heading?: string }) => void }).useSearchItems;

export function useSearchItems(items: Item[], opts?: { heading?: string }) {
  fromCore?.(items, opts);
}
