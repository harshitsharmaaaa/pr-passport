import type { ReactNode } from "react";
import { AlertIcon, CheckIcon } from "./icons";

export function cx(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}

const BUTTON_BASE =
  "inline-flex items-center justify-center gap-2 rounded-control font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-55";

type ButtonVariant = "primary" | "secondary" | "ghost";
type ButtonSize = "sm" | "md";

/**
 * Shared button styling. Kept as class helpers so links and buttons render
 * identical affordances while staying semantic elements.
 */
export function buttonClass(variant: ButtonVariant = "secondary", size: ButtonSize = "md"): string {
  const variants: Record<ButtonVariant, string> = {
    primary: "bg-brand text-white hover:bg-brand-strong",
    secondary:
      "border border-line bg-surface text-ink hover:border-line-strong hover:bg-hover",
    ghost: "text-ink-secondary hover:bg-hover hover:text-ink",
  };
  const sizes: Record<ButtonSize, string> = {
    sm: "h-9 px-2.5 text-[12.5px]",
    md: "h-11 px-4 text-[13.5px]",
  };
  return cx(BUTTON_BASE, variants[variant], sizes[size]);
}

export function Card({
  children,
  className,
  as: Element = "section",
}: {
  children: ReactNode;
  className?: string;
  as?: "section" | "div" | "aside";
}) {
  return (
    <Element className={cx("rounded-surface border border-line bg-surface", className)}>
      {children}
    </Element>
  );
}

export function Toast({
  tone = "success",
  children,
}: {
  tone?: "success" | "danger";
  children: ReactNode;
}) {
  return (
    <div
      role="status"
      className="toast-in fixed inset-x-4 bottom-4 z-50 flex items-center gap-2 rounded-control border border-line bg-surface px-3.5 py-2.5 text-[12.5px] text-ink shadow-[0_10px_30px_-12px_rgba(25,29,26,0.28)] sm:inset-x-auto sm:right-6 sm:w-auto"
    >
      {tone === "success" ? (
        <CheckIcon className="h-4 w-4 shrink-0 text-success" />
      ) : (
        <AlertIcon className="h-4 w-4 shrink-0 text-danger" />
      )}
      <span>{children}</span>
    </div>
  );
}
