import type { ComponentProps } from "react";
import { Button as UIButton } from "./ui/button";

// The board's buttons are shadcn/ui's (ui/button.tsx), compact by default: most sit in dense rows of cards.
export function Button({ size = "sm", ...props }: ComponentProps<typeof UIButton>) {
  return <UIButton size={size} {...props} />;
}
