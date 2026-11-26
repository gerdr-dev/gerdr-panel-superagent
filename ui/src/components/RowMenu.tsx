import { ContextMenu } from "radix-ui";
import { ChevronRight } from "lucide-react";
import { Fragment, type ReactNode, useState } from "react";

export type RowMenuItem = { id: string; label: string; icon?: ReactNode; danger?: boolean; disabled?: boolean; onSelect?: () => void; children?: RowMenuItem[] };

const item = "flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-[13px] outline-none select-none data-[highlighted]:bg-accent data-[disabled]:opacity-50 max-md:py-2.5 max-md:text-[15px] [&_svg]:size-4 [&_svg]:shrink-0";

/**
 * A right-click (a phone: long-press) menu for a row of ours, in the look of Gerdr's own row menus. For a task whose
 * conversation has no pane: Code's row, with Code's menu, isn't what draws it, and without this such a row looked
 * like its neighbours yet a right click on it did nothing. Portaled to the window (body): the row sits in Code's list,
 * outside the panel's own area.
 *
 * `items` is asked when the menu opens (what Gerdr says of the conversation, unread or not, is read then). An item with
 * `children` unfolds them under it in place, as Code's row menu does (更换 agent...).
 */
export function RowMenu({ items, children }: { items: () => RowMenuItem[]; children: ReactNode }) {
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <Items items={items} />
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

// Mounted only while the menu is open: `items` runs each time it opens
function Items({ items }: { items: () => RowMenuItem[] }) {
  const list = items();
  const [open, setOpen] = useState("");
  if (!list.length) return null;
  return (
    <ContextMenu.Content className="pointer-events-auto visible z-50 min-w-40 overflow-hidden rounded-lg border bg-popover p-1 text-popover-foreground shadow-md">
      {list.map((it) =>
        it.children?.length ? (
          <Fragment key={it.id}>
            <ContextMenu.Item disabled={it.disabled} onSelect={(e) => (e.preventDefault(), setOpen((v) => (v === it.id ? "" : it.id)))} className={`${item} [&_svg]:text-muted-foreground`}>
              {it.icon} {it.label}
              <ChevronRight className={`ml-auto transition-transform ${open === it.id ? "rotate-90" : ""}`} />
            </ContextMenu.Item>
            {open === it.id && (
              <div className="ml-3 border-l pl-1">
                {it.children.map((c) => (
                  <ContextMenu.Item key={c.id} disabled={c.disabled} onSelect={c.onSelect} className={`${item} [&_svg]:text-muted-foreground`}>
                    {c.icon} {c.label}
                  </ContextMenu.Item>
                ))}
              </div>
            )}
          </Fragment>
        ) : (
          <ContextMenu.Item key={it.id} disabled={it.disabled} onSelect={it.onSelect} className={`${item} ${it.danger ? "text-bad [&_svg]:text-bad" : "[&_svg]:text-muted-foreground"}`}>
            {it.icon} {it.label}
          </ContextMenu.Item>
        ),
      )}
    </ContextMenu.Content>
  );
}
