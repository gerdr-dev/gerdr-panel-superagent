import { createContext, useContext, useEffect, useRef } from "react";

// A settings page with unsaved changes tells the sheet around it (SettingsSheet), so that closing the sheet (✕, a click
// outside, Esc) or switching to another tab asks first instead of dropping the edit: a stray click beside the sheet
// threw away a page of changes (the user's report). `save` resolves true once it went through.

export type Unsaved = { dirty: boolean; save: () => Promise<boolean> };

export const UnsavedCtx = createContext<{ current: Unsaved | null } | null>(null);

export function useUnsaved(dirty: boolean, save: () => Promise<boolean>) {
  const box = useContext(UnsavedCtx);
  const me = useRef<Unsaved>({ dirty, save });
  me.current.dirty = dirty;
  me.current.save = save;
  useEffect(() => {
    if (!box) return;
    box.current = me.current;
    return () => {
      if (box.current === me.current) box.current = null;
    };
  }, [box]);
}
