import { Check, ChevronDown } from "lucide-react";
import { Select as SelectPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";
import { usePortalContainer } from "../../lib/portal";

export type SelectOption = { value: string; label: string; /** Muted, after the label in the list (not on the closed box). */ hint?: string };

// Radix refuses "" as an item's value (it means "nothing picked"); our "" is a real choice (the default)
const EMPTY = "\u0000default";

/**
 * A dropdown in the panel's look, instead of the system's <select>. Opened, it's portaled into the panel's own area
 * (usePortalContainer), so it hides with the panel. `value` "" is an option like any other (e.g. 默认).
 */
export function Select({ value, options, onChange, className }: { value: string; options: SelectOption[]; onChange: (v: string) => void; className?: string }) {
  const container = usePortalContainer();
  const enc = (v: string) => (v === "" ? EMPTY : v);
  return (
    <SelectPrimitive.Root value={enc(value)} onValueChange={(v) => onChange(v === EMPTY ? "" : v)}>
      <SelectPrimitive.Trigger
        className={cn(
          "flex h-8 w-full items-center justify-between gap-2 rounded-md border bg-background px-2 text-left text-[13px] outline-none focus:ring-2 focus:ring-ring data-[placeholder]:text-muted-foreground max-md:text-[16px]",
          className,
        )}
      >
        <span className="min-w-0 truncate">
          <SelectPrimitive.Value />
        </span>
        <SelectPrimitive.Icon>
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal container={container ?? undefined}>
        <SelectPrimitive.Content
          position="popper"
          sideOffset={4}
          className="visible pointer-events-auto z-50 max-h-[min(24rem,var(--radix-select-content-available-height))] min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md"
        >
          <SelectPrimitive.Viewport className="p-1">
            {options.map((o) => (
              <SelectPrimitive.Item
                key={o.value}
                value={enc(o.value)}
                className="relative flex cursor-default items-center gap-2 rounded-sm py-1.5 pr-2 pl-7 text-[13px] outline-none select-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground"
              >
                <span className="absolute left-2 flex size-3.5 items-center justify-center">
                  <SelectPrimitive.ItemIndicator>
                    <Check className="size-3.5" />
                  </SelectPrimitive.ItemIndicator>
                </span>
                <SelectPrimitive.ItemText>{o.label}</SelectPrimitive.ItemText>
                {o.hint && <span className="ml-auto truncate pl-3 text-[12px] text-muted-foreground">{o.hint}</span>}
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}
