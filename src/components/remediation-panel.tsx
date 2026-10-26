"use client";

import { useEffect, useRef, useState } from "react";
import type { Report } from "@/lib/types";
import { CopyIcon, DownloadIcon, CheckIcon } from "./icons";

export function RemediationPanel({ report }: { report: Report }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, []);

  const filename = `pr-passport-${report.repository.fullName.replace("/", "-")}-${report.pullRequest.number}-remediation.md`;

  async function copy() {
    setError(null);
    try {
      await navigator.clipboard.writeText(report.remediationPrompt);
      setCopied(true);
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 2200);
    } catch {
      setError("Clipboard access was blocked. Select the text below and copy it manually.");
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
  }

  return (
    <section className="panel overflow-hidden" aria-labelledby="remediation-heading">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-white/5 px-6 py-5">
        <div>
          <h3 id="remediation-heading" className="text-sm font-semibold text-white">
            Alan-ready remediation brief
          </h3>
          <p className="mt-1 text-xs text-slate-400">
            Failed requirements, evidence, files to inspect, validation commands, and hard constraints.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={copy}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700/70 bg-slate-900/70 px-3 py-1.5 text-xs font-medium text-slate-200 transition hover:border-slate-500 hover:text-white"
          >
            {copied ? <CheckIcon className="h-3.5 w-3.5 text-emerald-300" /> : <CopyIcon className="h-3.5 w-3.5" />}
            {copied ? "Copied" : "Copy"}
          </button>
          <button
            type="button"
            onClick={download}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700/70 bg-slate-900/70 px-3 py-1.5 text-xs font-medium text-slate-200 transition hover:border-slate-500 hover:text-white"
          >
            <DownloadIcon className="h-3.5 w-3.5" />
            Download .md
          </button>
        </div>
      </div>

      {error ? (
        <p role="alert" className="border-b border-rose-400/20 bg-rose-500/10 px-6 py-2 text-xs text-rose-200">
          {error}
        </p>
      ) : null}

      <pre className="scroll-thin max-h-[560px] overflow-auto whitespace-pre-wrap break-words px-6 py-5 font-mono text-[11.5px] leading-relaxed text-slate-300">
        {report.remediationPrompt}
      </pre>

      <div className="border-t border-white/5 px-6 py-3">
        <p className="text-[11px] text-slate-500">
          Generated from this report only. The brief contains no credentials and no instructions to merge, push, or
          execute repository code.
        </p>
      </div>
    </section>
  );
}