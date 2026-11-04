import * as core from "@gerdr/core";

// Where this panel's overlays (sheets, dialogs) are portaled: inside its own area, so they're hidden with it when
// another panel or Code is shown — a sheet on document.body stayed on screen over them. Through the namespace, so a
// Gerdr from before usePortalContainer still runs this panel (body, as then).
const fromCore = (core as unknown as { usePortalContainer?: () => HTMLElement | null }).usePortalContainer;

export function usePortalContainer(): HTMLElement | null {
  return fromCore ? fromCore() : null;
}
