"use client";

import { useId, useState } from "react";
import type { Finding, FindingStatus } from "@/lib/types";
import { AlertIcon, CheckIcon, ChevronDownIcon, CloseIcon } from "./icons";
import { FindingDetail } from "./finding-detail";
import { FINDING_STATUS } from "./status-meta";
import { cx } from "./ui";

const ORIGIN_LABEL: Record<Finding["origin"], string> = {
  deterministic: "Deterministic check",
  model: "Model interpretation",
  recorded_fixture: "Recorded model sample",
};

type Filter = "all" | FindingStatus;

const FILTER_ORDER: Filter[] = ["all", "fail", "needs_review", "pass"];

function StatusGlyph({ status }: { status: FindingStatus }) {
  const tone = FINDING_STATUS[status];
  return (
    <span
      className={cx(
        "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full",
        tone.glyphBg,
        tone.text,
      )}
      aria-hidden="true"
    >
      {status === "pass" ? (
        <CheckIcon className="h-3.5 w-3.5" />
      ) : status === "fail" ? (
        <CloseIcon className="h-3.5 w-3.5" />
      ) : (
        <AlertIcon className="h-3.5 w-3.5" />
      )}
    </span>
  );
}

function FindingRow({
  finding,
  open,
  onToggle,
}: {
  finding: Finding;
  open: boolean;
  onToggle: () => void;
}) {
  const panelId = useId();
  const tone = FINDING_STATUS[finding.status];
  const location = finding.source.path
    ? `${finding.source.path}${finding.source.lineStart ? `:${finding.source.lineStart}` : ""}`
    : finding.source.label;

  return (
    <li>
      <h3 className="text-[13.5px] font-medium">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-controls={panelId}
          className={cx(
            "flex w-full items-start gap-3 px-4 py-3.5 text-left transition-colors hover:bg-hover/70 focus-visible:outline-offset-[-2px] sm:px-5",
            open && "bg-hover/40",
          )}
        >
          <StatusGlyph status={finding.status} />
          <span className="min-w-0 flex-1">
            <span className="block text-[13.5px] font-medium leading-5 text-ink">{finding.title}</span>
            <span className="mt-0.5 line-clamp-2 text-[12.5px] leading-5 text-ink-secondary">
              {finding.requirement}
            </span>
            <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11.5px]">
              <span className={cx("font-medium", tone.text)}>{tone.label}</span>
              <span aria-hidden="true" className="text-line-strong">
                ·
              </span>
              <span className="text-ink-subtle">{ORIGIN_LABEL[finding.origin]}</span>
              {location ? (
                <>
                  <span aria-hidden="true" className="text-line-strong">
                    ·
                  </span>
                  <span className="min-w-0 truncate font-mono text-[11px] text-ink-subtle">{location}</span>
                </>
              ) : null}
            </span>
          </span>
          <ChevronDownIcon
            className={cx(
              "mt-1 h-4 w-4 shrink-0 text-ink-subtle transition-transform duration-150",
              open && "rotate-180",
            )}
          />
        </button>
      </h3>

      <div
        id={panelId}
        hidden={!open}
        className="border-t border-line bg-surface-muted px-4 py-4 sm:pl-[3.25rem] sm:pr-5"
      >
        {open ? <FindingDetail finding={finding} /> : null}
      </div>
    </li>
  );
}

export function FindingsExplorer({
  findings,
  limitations,
}: {
  findings: Finding[];
  limitations: string[];
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const [openId, setOpenId] = useState<string | null>(null);
  const headingId = useId();

  const counts: Record<Filter, number> = {
    all: findings.length,
    fail: findings.filter((finding) => finding.status === "fail").length,
    needs_review: findings.filter((finding) => finding.status === "needs_review").length,
    pass: findings.filter((finding) => finding.status === "pass").length,
  };

  const filters = FILTER_ORDER.filter((key) => key === "all" || counts[key] > 0);
  const visible = filter === "all" ? findings : findings.filter((finding) => finding.status === filter);

  return (
    <section
      aria-labelledby={headingId}
      className="overflow-hidden rounded-surface border border-line bg-surface"
    >
      <div className="flex flex-col gap-3 border-b border-line px-4 py-4 sm:px-5 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <h2 id={headingId} className="text-[15px] font-semibold text-ink">
            Findings
            <span className="ml-1.5 text-[12.5px] font-normal tabular-nums text-ink-subtle">
              {findings.length}
            </span>
          </h2>
          <p className="mt-0.5 text-[12.5px] leading-5 text-ink-secondary">
            Each finding cites the repository rule and the pull request evidence behind it.
          </p>
        </div>

        {findings.length > 0 ? (
          <div
            role="group"
            aria-label="Filter findings by status"
            className="flex flex-wrap gap-0.5 self-start rounded-control border border-line bg-surface-muted p-0.5 lg:self-auto"
          >
            {filters.map((key) => {
              const active = filter === key;
              const label =
                key === "all" ? "All" : FINDING_STATUS[key as FindingStatus].filterLabel;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setFilter(key)}
                  aria-pressed={active}
                  className={cx(
                    "inline-flex h-9 items-center gap-1.5 rounded-[4px] px-2.5 text-[12px] font-medium transition-colors sm:h-8",
                    active
                      ? "bg-surface text-ink shadow-[0_1px_2px_rgba(25,29,26,0.06)] ring-1 ring-line"
                      : "text-ink-secondary hover:text-ink",
                  )}
                >
                  {label}
                  <span
                    className={cx(
                      "tabular-nums",
                      active ? "text-ink-subtle" : "text-ink-subtle/90",
                    )}
                  >
                    {counts[key]}
                  </span>
                </button>
              );
            })}
          </div>
        ) : null}
      </div>

      {findings.length === 0 ? (
        <div className="px-4 py-7 sm:px-5">
          <p className="flex items-center gap-2 text-[13px] font-medium text-ink">
            <AlertIcon className="h-4 w-4 text-warning" />
            No requirements could be evaluated
          </p>
          <p className="mt-1.5 max-w-prose text-[12.5px] leading-5 text-ink-secondary">
            {limitations[0] ??
              "The repository's guidelines did not produce any checkable rules for this pull request."}
          </p>
          <p className="mt-2 text-[12.5px] leading-5 text-ink-secondary">
            A human reviewer should assess this pull request. This report does not claim it passes.
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-line">
          {visible.map((finding) => (
            <FindingRow
              key={finding.id}
              finding={finding}
              open={openId === finding.id}
              onToggle={() => setOpenId((current) => (current === finding.id ? null : finding.id))}
            />
          ))}
        </ul>
      )}

      {findings.length > 0 ? (
        <div className="border-t border-line px-4 py-3 text-[11.5px] text-ink-subtle sm:px-5">
          {filter === "all"
            ? "Select a row to see the rule text, evidence, and suggested action."
            : `Showing ${visible.length} of ${findings.length} findings.`}{" "}
          {filter !== "all" ? (
            <button
              type="button"
              onClick={() => setFilter("all")}
              className="rounded-control font-medium text-brand hover:underline"
            >
              Show all
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
