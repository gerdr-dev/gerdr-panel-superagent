import { ContextMenu } from "radix-ui";
import type { ReactNode } from "react";

export type RowMenuItem = { id: string; label: string; icon?: ReactNode; danger?: boolean; onSelect: () => void };

/**
 * A right-click (a phone: long-press) menu for a row of ours, in the look of Gerdr's own row menus. For a task whose
 * conversation has no pane: Code's row, with Code's menu, isn't what draws it, and without this such a row looked
 * like its neighbours yet a right click on it did nothing. Portaled to the window (body): the row sits in Code's list,
 * outside the panel's own area.
 */
export function RowMenu({ items, children }: { items: RowMenuItem[]; children: ReactNode }) {
  if (!items.length) return children;
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="pointer-events-auto visible z-50 min-w-40 overflow-hidden rounded-lg border bg-popover p-1 text-popover-foreground shadow-md">
          {items.map((it) => (
            <ContextMenu.Item
              key={it.id}
              onSelect={it.onSelect}
              className={`flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-[13px] outline-none select-none data-[highlighted]:bg-accent max-md:py-2.5 max-md:text-[15px] [&_svg]:size-4 [&_svg]:shrink-0 ${it.danger ? "text-bad [&_svg]:text-bad" : "[&_svg]:text-muted-foreground"}`}
            >
              {it.icon} {it.label}
            </ContextMenu.Item>
          ))}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
