import type { ReactNode } from "react";
import type { Report } from "@/lib/types";
import { FindingsExplorer } from "./findings-explorer";
import { RemediationPanel } from "./remediation-panel";
import { VERDICT_STYLES } from "./status-meta";
import { AlertIcon, ArrowUpRightIcon, CheckIcon, CloseIcon, GithubIcon } from "./icons";
import { buttonClass, Card, cx } from "./ui";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatUtc(value: string): string {
  if (!value) return "unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "unknown";
  const iso = date.toISOString();
  const [day = "", time = ""] = iso.split("T");
  const [, month = "1", dateOfMonth = "1"] = day.split("-");
  return `${MONTHS[Number(month) - 1]} ${Number(dateOfMonth)}, ${day.slice(0, 4)} · ${time.slice(0, 5)} UTC`;
}

function ModeBadge({ mode }: { mode: Report["mode"] }) {
  const demo = mode === "demo";
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1.5 rounded-[4px] border px-1.5 py-0.5 text-[11px] font-medium",
        demo
          ? "border-warning/30 bg-warning-subtle text-warning"
          : "border-line bg-surface-muted text-ink-secondary",
      )}
    >
      <span className={cx("h-1.5 w-1.5 rounded-full", demo ? "bg-warning" : "bg-info")} aria-hidden="true" />
      {demo ? "Bundled demo" : "Live GitHub"}
    </span>
  );
}

function PullRequestState({ report }: { report: Report }) {
  const { draft, state } = report.pullRequest;
  const tone = draft
    ? "border-line bg-surface-muted text-ink-secondary"
    : state === "open"
      ? "border-success/25 bg-success-subtle text-success"
      : state === "merged"
        ? "border-info/25 bg-info-subtle text-info"
        : "border-danger/25 bg-danger-subtle text-danger";
  const label = draft ? "Draft" : state === "open" ? "Open" : state === "merged" ? "Merged" : "Closed";
  return (
    <span className={cx("rounded-[4px] border px-1.5 py-0.5 text-[11px] font-medium capitalize", tone)}>
      {label}
    </span>
  );
}

function VerdictSummary({ report }: { report: Report }) {
  const { summary } = report;
  const tone = VERDICT_STYLES[summary.verdict];
  // Only flag gaps that actually affect what could be evaluated — not notes
  // such as "this report came from bundled demo fixtures".
  const evidenceGaps =
    report.pendingRules.length > 0 ||
    !report.checks.ci.available ||
    report.guidelines.files.length === 0 ||
    report.guidelines.unavailable.length > 0 ||
    report.model.mode === "failed";

  return (
    <div className={cx("border-t px-4 py-4 sm:px-6", tone.border, tone.bg)}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
        <div className="flex min-w-0 items-start gap-3">
          <span
            className={cx(
              "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-surface",
              tone.text,
            )}
            aria-hidden="true"
          >
            {summary.verdict === "pass" ? (
              <CheckIcon className="h-4 w-4" />
            ) : summary.verdict === "fail" ? (
              <CloseIcon className="h-4 w-4" />
            ) : (
              <AlertIcon className="h-4 w-4" />
            )}
          </span>
          <div className="min-w-0">
            <p className={cx("text-[13.5px] font-semibold", tone.text)}>{tone.label}</p>
            <p className="mt-0.5 text-[13px] leading-5 text-ink-secondary">{summary.headline}</p>
            {summary.verdict === "pass" && evidenceGaps ? (
              <p className="mt-1 text-[12px] leading-5 text-ink-secondary">
                Some checks could not be evaluated or their evidence was incomplete — see the report context before
                relying on this result.
              </p>
            ) : null}
          </div>
        </div>

        <dl className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1.5 text-[12px] sm:justify-end">
          <div className="flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-danger" aria-hidden="true" />
            <dt className="text-ink-secondary">Failed</dt>
            <dd className="font-mono text-[12px] font-medium tabular-nums text-ink">{summary.fail}</dd>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-warning" aria-hidden="true" />
            <dt className="text-ink-secondary">Needs review</dt>
            <dd className="font-mono text-[12px] font-medium tabular-nums text-ink">{summary.needsReview}</dd>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-success" aria-hidden="true" />
            <dt className="text-ink-secondary">Passed</dt>
            <dd className="font-mono text-[12px] font-medium tabular-nums text-ink">{summary.pass}</dd>
          </div>
        </dl>
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <dt className="text-[12px] text-ink-subtle">{label}</dt>
      <dd className="font-mono text-[12.5px] tabular-nums text-ink">{value}</dd>
    </div>
  );
}

function ReportHeader({ report }: { report: Report }) {
  const { pullRequest, repository, checks, guidelines } = report;
  const ciValue = !report.checks.ci.available
    ? "Unavailable"
    : report.checks.ci.total > 0
      ? `${report.checks.ci.successful}/${report.checks.ci.total}`
      : "None";

  return (
    <Card className="overflow-hidden">
      <div className="p-4 sm:p-6">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[12.5px]">
          <a
            href={repository.url}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-1.5 rounded-control font-medium text-ink-secondary hover:text-ink"
          >
            <GithubIcon className="h-3.5 w-3.5" />
            {repository.fullName}
            <span className="sr-only">(opens in a new tab)</span>
          </a>
          <span aria-hidden="true" className="text-line-strong">
            /
          </span>
          <a
            href={pullRequest.url}
            target="_blank"
            rel="noreferrer noopener"
            className="rounded-control font-mono text-[12px] text-ink-secondary hover:text-ink"
          >
            #{pullRequest.number}
          </a>
          <PullRequestState report={report} />
          <ModeBadge mode={report.mode} />
          <span className="ml-auto text-[11.5px] text-ink-subtle">Analyzed {formatUtc(report.generatedAt)}</span>
        </div>

        <div className="mt-3 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h2 className="text-[19px] font-semibold leading-[1.35] tracking-[-0.01em] text-ink sm:text-[21px]">
              <a
                href={pullRequest.url}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex items-start gap-1.5 rounded-control break-words hover:text-brand"
              >
                <span className="break-words">{pullRequest.title}</span>
                <ArrowUpRightIcon className="mt-1.5 h-3.5 w-3.5 shrink-0 text-ink-subtle" />
                <span className="sr-only">(opens in a new tab)</span>
              </a>
            </h2>
            <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-ink-secondary">
              <span>
                by{" "}
                <a
                  href={pullRequest.authorUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="rounded-control font-medium text-ink hover:text-brand"
                >
                  @{pullRequest.author}
                </a>
              </span>
              <span aria-hidden="true" className="text-line-strong">
                ·
              </span>
              <span className="break-all font-mono text-[12px]">
                {pullRequest.headRef || "unknown"} → {pullRequest.baseRef || "unknown"}
              </span>
              <span aria-hidden="true" className="text-line-strong">
                ·
              </span>
              <span>updated {formatUtc(pullRequest.updatedAt)}</span>
            </p>
          </div>

          <a
            href={pullRequest.url}
            target="_blank"
            rel="noreferrer noopener"
            className={cx(buttonClass("secondary", "sm"), "shrink-0 self-start")}
          >
            <GithubIcon className="h-3.5 w-3.5" />
            Open on GitHub
            <ArrowUpRightIcon className="h-3 w-3 text-ink-subtle" />
            <span className="sr-only">(opens in a new tab)</span>
          </a>
        </div>
      </div>

      <VerdictSummary report={report} />

      <dl className="flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-line px-4 py-3 sm:px-6">
        <Metric label="Changed files" value={String(checks.changedFiles)} />
        <Metric label="Lines" value={`+${checks.additions} / −${checks.deletions}`} />
        <Metric label="Commits" value={String(checks.commits)} />
        <Metric label="CI checks" value={ciValue} />
        <Metric label="Rule files" value={String(guidelines.files.length)} />
      </dl>
    </Card>
  );
}

function SectionHeading({ children }: { children: ReactNode }) {
  return <h3 className="text-[12px] font-semibold text-ink">{children}</h3>;
}

function CiSection({ report }: { report: Report }) {
  const ci = report.checks.ci;
  const mergeable = report.checks.mergeable;
  const checksUrl = ci.sourceUrl ?? `${report.pullRequest.url}/checks`;

  const status = !ci.available
    ? { dot: "bg-ink-subtle", label: "Unavailable", detail: ci.reason ?? "GitHub did not expose checks for this commit." }
    : ci.state === "failure"
      ? {
          dot: "bg-danger",
          label: "Failing",
          detail: `${ci.failing.length} of ${ci.total} reported check${ci.total === 1 ? "" : "s"} did not pass.${
            ci.pending.length > 0 ? ` ${ci.pending.length} still running.` : ""
          }`,
        }
      : ci.state === "pending"
        ? {
            dot: "bg-warning",
            label: "Pending",
            detail: `${ci.pending.length} of ${ci.total} check${ci.total === 1 ? "" : "s"} have not finished.`,
          }
        : ci.state === "success"
          ? {
              dot: "bg-success",
              label: "Passing",
              detail: `${ci.successful} of ${ci.total} checks passed.`,
            }
          : { dot: "bg-ink-subtle", label: "No checks", detail: "No CI checks were reported for this commit." };

  return (
    <section className="px-4 py-4">
      <SectionHeading>Checks</SectionHeading>
      <p className="mt-2 flex items-center gap-2 text-[13px] font-medium text-ink">
        <span className={cx("h-2 w-2 rounded-full", status.dot)} aria-hidden="true" />
        {status.label}
      </p>
      <p className="mt-1 text-[12px] leading-5 text-ink-secondary">{status.detail}</p>

      {ci.failing.length > 0 ? (
        <ul className="mt-2 space-y-1">
          {ci.failing.slice(0, 4).map((check) => (
            <li key={check.name} className="flex items-start gap-1.5 text-[12px] leading-5 text-ink-secondary">
              <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-danger" aria-hidden="true" />
              <span className="min-w-0 break-words">{check.name}</span>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
        <a
          href={checksUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex items-center gap-1 rounded-control font-medium text-brand hover:underline"
        >
          View checks
          <ArrowUpRightIcon className="h-3 w-3" />
          <span className="sr-only">(opens in a new tab)</span>
        </a>
        <span className="text-ink-subtle">
          Mergeability:{" "}
          <span className="text-ink-secondary">
            {mergeable === true ? "no conflicts" : mergeable === false ? "conflicts" : "not computed yet"}
          </span>
        </span>
      </div>
    </section>
  );
}

function GuidelinesSection({ report }: { report: Report }) {
  const { guidelines } = report;
  const hasFiles = guidelines.files.length > 0;

  return (
    <section className="px-4 py-4">
      <SectionHeading>Contribution rules</SectionHeading>
      {hasFiles ? (
        <ul className="mt-2 space-y-2">
          {guidelines.files.map((file) => (
            <li key={file.path}>
              <a
                href={file.url}
                target="_blank"
                rel="noreferrer noopener"
                className="group flex items-start gap-1.5 rounded-control text-[12px] text-ink-secondary hover:text-brand"
              >
                <span className="min-w-0 break-all font-mono text-[11.5px] group-hover:underline">{file.path}</span>
                <ArrowUpRightIcon className="mt-0.5 h-3 w-3 shrink-0 text-ink-subtle" />
                <span className="sr-only">(opens in a new tab)</span>
              </a>
              <p className="mt-0.5 text-[11.5px] text-ink-subtle">
                {file.lineCount} lines
                {file.truncated ? " · truncated" : ""}
              </p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-[12px] leading-5 text-ink-secondary">
          No CONTRIBUTING file or PR template was found at the base commit, so only platform checks ran.
        </p>
      )}

      {guidelines.templatePath ? (
        <p className="mt-2 break-all font-mono text-[11px] text-ink-subtle">template: {guidelines.templatePath}</p>
      ) : null}

      {guidelines.unavailable.length > 0 ? (
        <ul className="mt-2 space-y-1">
          {guidelines.unavailable.map((entry) => (
            <li key={entry.path} className="text-[11.5px] leading-4 text-ink-subtle">
              <span className="break-all font-mono">{entry.path}</span> — {entry.reason}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function ValidationSection({ report }: { report: Report }) {
  if (report.validationCommands.length === 0) return null;
  return (
    <section className="px-4 py-4">
      <SectionHeading>Validation commands</SectionHeading>
      <ul className="mt-2 space-y-2">
        {report.validationCommands.slice(0, 5).map((command) => (
          <li key={command.command}>
            <code className="code-scroll block overflow-x-auto rounded-[4px] border border-line bg-surface-muted px-2 py-1 font-mono text-[11px] text-ink-secondary">
              {command.command}
            </code>
            <p className="mt-1 text-[11.5px] leading-4 text-ink-subtle">{command.reason}</p>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[11px] leading-4 text-ink-subtle">
        Derived from the repository&apos;s own configuration. Nothing is executed here.
      </p>
    </section>
  );
}

function ModelSection({ report }: { report: Report }) {
  const model = report.model;
  const label =
    model.mode === "live"
      ? "Live inference"
      : model.mode === "recorded_fixture"
        ? "Recorded demo sample"
        : model.mode === "failed"
          ? "Inference failed"
          : "Not configured";

  return (
    <section className="px-4 py-4">
      <SectionHeading>Interpretation</SectionHeading>
      <p className="mt-2 text-[13px] font-medium text-ink">{label}</p>
      {model.model ? (
        <p className="mt-0.5 break-all font-mono text-[11px] text-ink-subtle">{model.model}</p>
      ) : null}

      {model.rejectedFindings > 0 ? (
        <p className="mt-1.5 text-[12px] leading-5 text-ink-secondary">
          {model.rejectedFindings} model claim{model.rejectedFindings === 1 ? "" : "s"} discarded during grounding.
        </p>
      ) : null}

      {!model.requested ? (
        <p className="mt-1.5 text-[12px] leading-5 text-ink-secondary">
          No free-form rules required interpretation, so no model call was made.
        </p>
      ) : null}

      {model.error ? (
        <p className="mt-2 rounded-[4px] border border-danger/20 bg-danger-subtle px-2.5 py-2 text-[12px] leading-5 text-danger">
          {model.error}
        </p>
      ) : null}

      {model.notes.length > 0 ? (
        <ul className="mt-2 space-y-1.5">
          {model.notes.map((note) => (
            <li key={note} className="text-[11.5px] leading-5 text-ink-secondary">
              {note}
            </li>
          ))}
        </ul>
      ) : null}

      <p className="mt-2 text-[11px] leading-4 text-ink-subtle">
        Model output is schema-validated and grounded in this pull request&apos;s own files and commits.
      </p>
    </section>
  );
}

function WarningPanel({
  title,
  intro,
  items,
}: {
  title: string;
  intro?: string;
  items: Array<{ key: string; heading?: string; body: string; meta?: string }>;
}) {
  return (
    <Card className="border-warning/30 bg-warning-subtle">
      <div className="px-4 py-3.5">
        <h3 className="flex items-center gap-1.5 text-[12px] font-semibold text-warning">
          <AlertIcon className="h-3.5 w-3.5" />
          {title}
        </h3>
        {intro ? <p className="mt-1 text-[11.5px] leading-4 text-ink-secondary">{intro}</p> : null}
        <ul className="mt-2 space-y-2.5">
          {items.map((item) => (
            <li key={item.key}>
              {item.heading ? <p className="text-[12.5px] font-medium text-ink">{item.heading}</p> : null}
              <p className={cx("text-[12px] leading-5 text-ink-secondary", item.heading && "mt-0.5")}>{item.body}</p>
              {item.meta ? <p className="mt-0.5 text-[11.5px] leading-4 text-ink-secondary">{item.meta}</p> : null}
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}

export function ReportView({ report }: { report: Report }) {
  return (
    <section id="report" aria-label="Analysis report" className="rise mt-9 scroll-mt-20 space-y-4">
      {report.mode === "demo" ? (
        <div className="flex items-start gap-2.5 rounded-surface border border-warning/30 bg-warning-subtle px-4 py-3">
          <AlertIcon className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          <p className="text-[12.5px] leading-5 text-ink-secondary">
            <span className="font-medium text-ink">Bundled demo data.</span> Repository, pull request, and CI details
            come from fixtures. Model findings are a recorded sample; no inference call was made.
          </p>
        </div>
      ) : null}

      <ReportHeader report={report} />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem] xl:grid-cols-[minmax(0,1fr)_21rem]">
        <div className="min-w-0 space-y-4">
          <FindingsExplorer findings={report.findings} limitations={report.limitations} />
          <RemediationPanel report={report} />
        </div>

        <aside aria-label="Repository context" className="space-y-4">
          <h2 className="sr-only">Repository context</h2>
          <Card className="divide-y divide-line">
            <CiSection report={report} />
            <GuidelinesSection report={report} />
            <ValidationSection report={report} />
            <ModelSection report={report} />
          </Card>

          {report.pendingRules.length > 0 ? (
            <WarningPanel
              title={`Not evaluated · ${report.pendingRules.length}`}
              intro="Rules that were extracted but could not be checked automatically. They do not count as passes."
              items={report.pendingRules.map((rule) => ({
                key: rule.id,
                heading: rule.title,
                body: rule.requirement,
                meta: rule.reason,
              }))}
            />
          ) : null}

          {report.limitations.length > 0 ? (
            <WarningPanel
              title="Limitations"
              intro="Evidence gaps in this report. Treat affected findings accordingly."
              items={report.limitations.map((limitation) => ({ key: limitation, body: limitation }))}
            />
          ) : null}
        </aside>
      </div>

      <p className="flex flex-wrap items-center gap-x-2.5 gap-y-1 px-1 font-mono text-[11px] text-ink-subtle">
        <span>{report.schema}</span>
        <span aria-hidden="true">·</span>
        <span>generated in {report.timings.totalMs} ms</span>
        <span aria-hidden="true">·</span>
        <span>
          {report.summary.pass} pass / {report.summary.fail} fail / {report.summary.needsReview} needs review
        </span>
      </p>
    </section>
  );
}
