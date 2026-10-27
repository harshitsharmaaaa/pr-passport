"use client";

import { useEffect, useRef, useState } from "react";
import type { Report } from "@/lib/types";
import { CheckIcon, CopyIcon, DownloadIcon } from "./icons";
import { buttonClass, Toast } from "./ui";

type Notice = { tone: "success" | "danger"; message: string };

function describeScope(report: Report): string {
  const failed = report.summary.fail;
  const review = report.summary.needsReview;

  if (failed === 0 && review === 0) {
    if (report.findings.length === 0) {
      return "No requirements were evaluated, so this brief records only the constraints and this report's limits. A human reviewer should assess the pull request first.";
    }
    return "No failed requirements were detected. The brief records the constraints, the passed checks not to regress, and this report's limits.";
  }

  const parts: string[] = [];
  if (failed > 0) parts.push(`${failed} failed requirement${failed === 1 ? "" : "s"}`);
  if (review > 0) parts.push(`${review} needs-review item${review === 1 ? "" : "s"}`);

  return `Scoped to ${parts.join(" and ")}: the rule, the evidence, files to inspect, validation commands, and hard constraints.`;
}

export function RemediationPanel({ report }: { report: Report }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const copiedTimer = useRef<number | null>(null);
  const noticeTimer = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
      if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
    };
  }, []);

  const filename = `pr-passport-${report.repository.fullName.replace("/", "-")}-${report.pullRequest.number}-remediation.md`;
  const lineCount = report.remediationPrompt.split("\n").length;

  function showNotice(next: Notice) {
    setNotice(next);
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(null), 2400);
  }

  async function copy() {
    setError(null);
    try {
      await navigator.clipboard.writeText(report.remediationPrompt);
      setCopied(true);
      showNotice({ tone: "success", message: "Repair brief copied to clipboard." });
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => setCopied(false), 2400);
    } catch {
      setError("Clipboard access was blocked by the browser. Select the brief below and copy it manually.");
      showNotice({ tone: "danger", message: "Copy failed — clipboard access was blocked." });
    }
  }

  function download() {
    const blob = new Blob([report.remediationPrompt], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    showNotice({ tone: "success", message: "Repair brief downloaded." });
  }

  return (
    <section
      id="repair-brief"
      aria-labelledby="repair-brief-heading"
      className="scroll-mt-20 overflow-hidden rounded-surface border border-line bg-surface"
    >
      <div className="flex flex-col gap-3 border-b border-line px-4 py-4 sm:px-5 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 id="repair-brief-heading" className="text-[15px] font-semibold text-ink">
              Repair brief
            </h2>
            <span className="rounded-[4px] border border-line bg-surface-muted px-1.5 py-0.5 text-[11px] font-medium text-ink-secondary">
              Alan-ready
            </span>
          </div>
          <p className="mt-1 max-w-2xl text-[12.5px] leading-5 text-ink-secondary">{describeScope(report)}</p>
        </div>

        <div className="flex shrink-0 flex-wrap gap-2">
          <button type="button" onClick={copy} className={buttonClass("primary", "sm")}>
            {copied ? <CheckIcon className="h-3.5 w-3.5" /> : <CopyIcon className="h-3.5 w-3.5" />}
            {copied ? "Copied" : "Copy brief"}
          </button>
          <button type="button" onClick={download} className={buttonClass("secondary", "sm")}>
            <DownloadIcon className="h-3.5 w-3.5" />
            Download .md
          </button>
        </div>
      </div>

      {error ? (
        <p role="alert" className="border-b border-danger/20 bg-danger-subtle px-4 py-2.5 text-[12.5px] text-danger sm:px-5">
          {error}
        </p>
      ) : null}

      <div className="flex items-center justify-between gap-3 border-b border-line bg-surface-muted px-4 py-2 sm:px-5">
        <span className="truncate font-mono text-[11px] text-ink-subtle">{filename}</span>
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-ink-subtle">
          {lineCount} lines · markdown
        </span>
      </div>

      <pre className="code-scroll max-h-[520px] overflow-auto whitespace-pre-wrap break-words bg-surface-muted px-4 py-4 font-mono text-[12px] leading-[1.7] text-ink-secondary sm:px-5">
        {report.remediationPrompt}
      </pre>

      <p className="border-t border-line px-4 py-3 text-[11.5px] leading-4 text-ink-subtle sm:px-5">
        Generated from this report only. No credentials, and no instruction to merge, push, or execute repository code.
      </p>

      {notice ? <Toast tone={notice.tone}>{notice.message}</Toast> : null}
    </section>
  );
}
