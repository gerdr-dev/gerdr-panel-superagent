import * as core from "@gerdr/core";
import type { ReactNode } from "react";

// The board's rows in Gerdr's phone drawer (@gerdr/core usePhoneMenu): what its header has no room for on a phone.
// Through the namespace, so a Gerdr from before usePhoneMenu still runs this panel; `phoneMenu` then says the header
// has to keep those buttons itself.

type Item = { id?: string; label: string; icon?: ReactNode; badge?: string | number; onSelect: () => void };
const fromCore = (core as unknown as { usePhoneMenu?: (items: Item[]) => void }).usePhoneMenu;

/** Whether this Gerdr has a phone drawer the panel can add to. */
export const phoneMenu = !!fromCore;

export function usePhoneMenu(items: Item[]) {
  fromCore?.(items);
}
