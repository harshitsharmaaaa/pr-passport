import type { FindingStatus, Verdict } from "@/lib/types";

export interface StatusTone {
  /** Short status word shown next to a finding. */
  label: string;
  /** Label used by the findings filter. */
  filterLabel: string;
  text: string;
  glyphBg: string;
}

export const FINDING_STATUS: Record<FindingStatus, StatusTone> = {
  fail: {
    label: "Fail",
    filterLabel: "Failed",
    text: "text-danger",
    glyphBg: "bg-danger/10",
  },
  needs_review: {
    label: "Needs review",
    filterLabel: "Needs review",
    text: "text-warning",
    glyphBg: "bg-warning/10",
  },
  pass: {
    label: "Pass",
    filterLabel: "Passed",
    text: "text-success",
    glyphBg: "bg-success/10",
  },
};

export const VERDICT_STYLES: Record<Verdict, { label: string; text: string; bg: string; border: string }> = {
  fail: {
    label: "Blocked by failures",
    text: "text-danger",
    bg: "bg-danger-subtle",
    border: "border-danger/20",
  },
  needs_review: {
    label: "Needs human review",
    text: "text-warning",
    bg: "bg-warning-subtle",
    border: "border-warning/20",
  },
  pass: {
    label: "No blocking findings",
    text: "text-success",
    bg: "bg-success-subtle",
    border: "border-success/20",
  },
};
