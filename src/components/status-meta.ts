import type { FindingStatus, Verdict } from "@/lib/types";

export interface StatusStyle {
  label: string;
  stampLabel: string;
  stampSubLabel?: string;
  text: string;
  border: string;
  bg: string;
  dot: string;
  pill: string;
}

export const STATUS_STYLES: Record<FindingStatus, StatusStyle> = {
  fail: {
    label: "Fail",
    stampLabel: "Fail",
    text: "text-rose-300",
    border: "border-rose-400/30",
    bg: "bg-rose-500/[0.06]",
    dot: "bg-rose-400",
    pill: "bg-rose-500/15 text-rose-200 border-rose-400/30",
  },
  needs_review: {
    label: "Needs human review",
    stampLabel: "Needs human",
    stampSubLabel: "review",
    text: "text-amber-300",
    border: "border-amber-400/30",
    bg: "bg-amber-400/[0.06]",
    dot: "bg-amber-300",
    pill: "bg-amber-400/15 text-amber-200 border-amber-300/30",
  },
  pass: {
    label: "Pass",
    stampLabel: "Pass",
    text: "text-emerald-300",
    border: "border-emerald-400/30",
    bg: "bg-emerald-400/[0.05]",
    dot: "bg-emerald-400",
    pill: "bg-emerald-400/15 text-emerald-200 border-emerald-300/30",
  },
};

export const VERDICT_STYLES: Record<Verdict, StatusStyle> = {
  fail: STATUS_STYLES.fail,
  needs_review: STATUS_STYLES.needs_review,
  pass: STATUS_STYLES.pass,
};