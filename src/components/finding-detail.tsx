import type { Finding, RuleSource } from "@/lib/types";
import { ArrowUpRightIcon } from "./icons";

const ORIGIN_NOTE: Record<Finding["origin"], string | null> = {
  deterministic: null,
  model:
    "Interpreted by a model, then checked against this pull request's own files and commits. Review the evidence before acting.",
  recorded_fixture: "Recorded model sample from the bundled demo. No inference request was made.",
};

function sourceLocation(source: RuleSource): string {
  if (!source.path) return source.label;
  if (!source.lineStart) return source.path;
  if (!source.lineEnd || source.lineEnd === source.lineStart) return `${source.path}:${source.lineStart}`;
  return `${source.path}:${source.lineStart}–${source.lineEnd}`;
}

export function FindingDetail({ finding }: { finding: Finding }) {
  const originNote = ORIGIN_NOTE[finding.origin];
  const confidence =
    finding.confidence !== undefined ? `${Math.round(finding.confidence * 100)}% confidence` : null;

  return (
    <div className="space-y-5">
      <section>
        <h4 className="text-[12px] font-semibold text-ink">Requirement</h4>
        <p className="mt-1.5 text-[13px] leading-6 text-ink">{finding.requirement}</p>
      </section>

      <section>
        <h4 className="text-[12px] font-semibold text-ink">Assessment</h4>
        <p className="mt-1.5 text-[12.5px] leading-5 text-ink-secondary">{finding.rationale}</p>
      </section>

      <section>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h4 className="text-[12px] font-semibold text-ink">Rule source</h4>
          {finding.source.url ? (
            <a
              href={finding.source.url}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-1 rounded-control text-[11.5px] font-medium text-brand hover:underline"
            >
              Open file
              <ArrowUpRightIcon className="h-3 w-3" />
              <span className="sr-only">(opens in a new tab)</span>
            </a>
          ) : null}
        </div>
        <div className="mt-1.5 rounded-control border border-line bg-surface px-3 py-2.5">
          <p className="break-all font-mono text-[11.5px] text-ink-secondary">{sourceLocation(finding.source)}</p>
          {finding.source.excerpt ? (
            <blockquote className="mt-2 border-l-2 border-line-strong pl-2.5 text-[12.5px] italic leading-5 text-ink-secondary">
              “{finding.source.excerpt}”
            </blockquote>
          ) : (
            <p className="mt-1 text-[11.5px] text-ink-subtle">No excerpt was captured for this rule.</p>
          )}
        </div>
      </section>

      <section>
        <h4 className="text-[12px] font-semibold text-ink">
          Evidence
          <span className="ml-1.5 font-normal tabular-nums text-ink-subtle">{finding.evidence.length}</span>
        </h4>
        {finding.evidence.length === 0 ? (
          <p className="mt-1.5 rounded-control border border-dashed border-line-strong px-3 py-2 text-[12px] text-ink-subtle">
            No evidence was attached to this finding.
          </p>
        ) : (
          <ul className="mt-1.5 divide-y divide-line overflow-hidden rounded-control border border-line bg-surface">
            {finding.evidence.map((item, index) => (
              <li
                key={`${item.kind}-${item.label}-${index}`}
                className="flex flex-wrap items-start gap-x-2.5 gap-y-1 px-3 py-2.5"
              >
                <span className="mt-px rounded-[4px] border border-line bg-surface-muted px-1.5 py-px font-mono text-[10.5px] leading-4 text-ink-subtle">
                  {item.kind}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="break-words text-[12.5px] font-medium text-ink">{item.label}</p>
                  <p className="mt-0.5 break-words text-[12px] leading-5 text-ink-secondary">{item.detail}</p>
                  {item.path && item.path !== item.label ? (
                    <p className="mt-0.5 break-all font-mono text-[11px] text-ink-subtle">
                      {item.path}
                      {item.lineStart ? `:${item.lineStart}` : ""}
                    </p>
                  ) : null}
                </div>
                {item.url ? (
                  <a
                    href={item.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="inline-flex items-center gap-1 rounded-control text-[11.5px] font-medium text-brand hover:underline"
                  >
                    View
                    <ArrowUpRightIcon className="h-3 w-3" />
                    <span className="sr-only">(opens in a new tab)</span>
                  </a>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      {finding.remediation ? (
        <section>
          <h4 className="text-[12px] font-semibold text-ink">Suggested action</h4>
          <p className="mt-1.5 border-l-2 border-brand/40 bg-brand-subtle px-3 py-2 text-[12.5px] leading-5 text-ink">
            {finding.remediation}
          </p>
        </section>
      ) : null}

      {originNote ? (
        <p className="text-[11.5px] leading-5 text-ink-subtle">
          {originNote}
          {confidence ? ` · ${confidence}` : ""}
        </p>
      ) : confidence ? (
        <p className="text-[11.5px] text-ink-subtle">{confidence}</p>
      ) : null}
    </div>
  );
}
