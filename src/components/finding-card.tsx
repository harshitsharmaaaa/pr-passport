import type { Evidence, Finding, RuleSource } from "@/lib/types";
import { ArrowUpRightIcon, SparkIcon } from "./icons";
import { STATUS_STYLES } from "./status-meta";

const ORIGIN_LABEL: Record<Finding["origin"], string> = {
  deterministic: "Deterministic check",
  model: "Model interpretation",
  recorded_fixture: "Recorded sample",
};

function SourceBlock({ source }: { source: RuleSource }) {
  const location = source.path
    ? `${source.path}${source.lineStart ? `:${source.lineStart}` : ""}${source.lineEnd && source.lineEnd !== source.lineStart ? `–${source.lineEnd}` : ""}`
    : source.label;

  return (
    <div className="mt-4 rounded-xl border border-slate-700/50 bg-slate-950/40 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-[0.22em] text-slate-500">
          Rule source
        </span>
        {source.url ? (
          <a
            href={source.url}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-1 text-[11px] font-medium text-sky-300 hover:text-sky-200"
          >
            Open file <ArrowUpRightIcon />
          </a>
        ) : null}
      </div>
      <p className="mt-1 font-mono text-[11px] text-slate-400">{location}</p>
      {source.excerpt ? (
        <blockquote className="mt-2 border-l-2 border-slate-600/80 pl-3 text-sm italic leading-relaxed text-slate-300">
          “{source.excerpt}”
        </blockquote>
      ) : null}
    </div>
  );
}

function EvidenceList({ evidence }: { evidence: Evidence[] }) {
  if (evidence.length === 0) {
    return (
      <p className="mt-4 rounded-lg border border-dashed border-slate-700/60 px-3 py-2 text-xs text-slate-500">
        No evidence was attached to this finding.
      </p>
    );
  }

  return (
    <ul className="mt-4 space-y-2">
      {evidence.map((item, index) => (
        <li
          key={`${item.kind}-${item.label}-${index}`}
          className="flex flex-wrap items-start gap-2 rounded-lg bg-white/[0.02] px-3 py-2"
        >
          <span className="mt-0.5 rounded border border-slate-700/70 bg-slate-900/70 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-slate-400">
            {item.kind}
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold text-slate-200">
              {item.label}
              {item.path && item.path !== item.label ? (
                <span className="ml-1 font-mono font-normal text-slate-500">{item.path}</span>
              ) : null}
            </p>
            <p className="mt-0.5 break-words text-xs leading-relaxed text-slate-400">{item.detail}</p>
          </div>
          {item.url ? (
            <a
              href={item.url}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-1 text-[11px] text-sky-300 hover:text-sky-200"
            >
              View <ArrowUpRightIcon />
            </a>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

export function FindingCard({ finding }: { finding: Finding }) {
  const style = STATUS_STYLES[finding.status];

  return (
    <article className={`rise rounded-2xl border ${style.border} ${style.bg} p-5`}>
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] ${style.pill}`}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${style.dot}`} />
          {style.label}
        </span>
        <h3 className="text-sm font-semibold text-slate-100">{finding.title}</h3>
        <span className="ml-auto inline-flex items-center gap-1 rounded-full border border-slate-700/60 px-2 py-0.5 text-[10px] text-slate-400">
          {finding.origin === "deterministic" ? null : <SparkIcon className="h-3 w-3" />}
          {ORIGIN_LABEL[finding.origin]}
          {finding.confidence !== undefined ? ` · ${(finding.confidence * 100).toFixed(0)}%` : ""}
        </span>
      </div>

      <p className="mt-3 text-sm leading-relaxed text-slate-200">{finding.requirement}</p>
      <p className="mt-1.5 text-xs leading-relaxed text-slate-400">{finding.rationale}</p>

      <SourceBlock source={finding.source} />
      <EvidenceList evidence={finding.evidence} />

      {finding.remediation ? (
        <div className="mt-4 rounded-xl border border-white/10 bg-white/[0.03] p-3">
          <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-slate-500">
            Suggested action
          </p>
          <p className="mt-1 text-xs leading-relaxed text-slate-300">{finding.remediation}</p>
        </div>
      ) : null}
    </article>
  );
}