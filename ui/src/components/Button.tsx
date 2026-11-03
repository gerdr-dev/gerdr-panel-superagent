import clsx from "clsx";

const VARIANTS = {
  default: "bg-primary text-primary-foreground hover:bg-primary/90",
  outline: "border bg-background hover:bg-accent",
  ghost: "hover:bg-accent",
};
const SIZES = { sm: "h-8 gap-1.5 px-3 text-[13px]", icon: "size-8" };

export function Button({
  variant = "default",
  size = "sm",
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: keyof typeof VARIANTS; size?: keyof typeof SIZES }) {
  return (
    <button
      className={clsx("inline-flex shrink-0 items-center justify-center rounded-md font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50 max-md:min-h-11 max-md:min-w-11", VARIANTS[variant], SIZES[size], className)}
      {...props}
    />
  );
}
