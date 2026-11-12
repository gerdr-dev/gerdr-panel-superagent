import { ListTodo, MessageCircle } from "lucide-react";
import clsx from "clsx";
import { Link, useLocation } from "react-router";

// The panel's two views of the same tasks (DESIGN.md「秘书」): the secretary, a conversation where everything is
// handed over and asked about, and the board, for when the user wants to see every task for themselves.
const VIEWS = [
  { to: "/", label: "秘书", icon: MessageCircle },
  { to: "/board", label: "任务面板", icon: ListTodo },
];

export function Views() {
  const { pathname } = useLocation();
  return (
    <nav className="flex shrink-0 gap-0.5 rounded-lg bg-muted p-0.5" aria-label="视图">
      {VIEWS.map((v) => {
        const on = v.to === "/" ? pathname === "/" || pathname === "" : pathname.startsWith(v.to);
        return (
          <Link
            key={v.to}
            to={v.to}
            aria-current={on ? "page" : undefined}
            className={clsx("flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[13px]", on ? "bg-background font-medium shadow-sm" : "text-muted-foreground hover:text-foreground")}
          >
            <v.icon className="size-3.5" />
            {v.label}
          </Link>
        );
      })}
    </nav>
  );
}
