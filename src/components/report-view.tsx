import type { ReactNode } from "react";
import type { Report } from "@/lib/types";
import { FindingCard } from "./finding-card";
import { RemediationPanel } from "./remediation-panel";
import { VERDICT_STYLES } from "./status-meta";
import {
  AlertIcon,
  ArrowUpRightIcon,
  CheckIcon,
  GithubIcon,
  SparkIcon,
} from "./icons";

function formatUtc(value: string): string {
  if (!value) return "unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "unknown";
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function ModeBadge({ mode }: { mode: Report["mode"] }) {
  const demo = mode === "demo";
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] ${
        demo
          ? "border-amber-300/30 bg-amber-300/10 text-amber-200"
          : "border-teal-300/30 bg-teal-300/10 text-teal-200"
      }`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${demo ? "bg-amber-300" : "bg-teal-300"}`} />
      {demo ? "Demo data" : "Live GitHub"}
    </span>
  );
}

function VerdictStamp({ report }: { report: Report }) {
  const style = VERDICT_STYLES[report.summary.verdict];
  return (
    <div
      className={`stamp shrink-0 self-start rounded-2xl border-2 px-6 py-5 text-center -rotate-2 ${style.border} ${style.text}`}
    >
      <p className="text-[9px] font-bold uppercase tracking-[0.4em] opacity-70">Verdict</p>
      <p className="mt-1.5 text-2xl font-black uppercase leading-none tracking-tight">{style.stampLabel}</p>
      {style.stampSubLabel ? (
        <p className="text-sm font-bold uppercase tracking-[0.18em]">{style.stampSubLabel}</p>
      ) : null}
      <div className="mt-3 flex items-center justify-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider opacity-80">
        <span>{report.summary.pass} pass</span>
        <span className="opacity-40">·</span>
        <span>{report.summary.fail} fail</span>
        <span className="opacity-40">·</span>
        <span>{report.summary.needsReview} review</span>
      </div>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="rounded-xl border border-white/5 bg-white/[0.02] px-3 py-2.5">
      <dt className="text-[10px] uppercase tracking-[0.16em] text-slate-500">{label}</dt>
      <dd className="mt-1 font-mono text-sm font-semibold text-slate-200">{value}</dd>
      {hint ? <p className="mt-0.5 truncate text-[10px] text-slate-500">{hint}</p> : null}
    </div>
  );
}

function ReportHeader({ report }: { report: Report }) {
  const { pullRequest, repository, summary, checks, guidelines } = report;
  const style = VERDICT_STYLES[summary.verdict];

  return (
    <header className="panel p-6 md:p-8">
      <div className="flex flex-col gap-7 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-xs">
            <a
              href={repository.url}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-1.5 font-medium text-slate-300 hover:text-white"
            >
              <GithubIcon className="h-3.5 w-3.5" />
              {repository.fullName}
            </a>
            <span className="text-slate-600">/</span>
            <a
              href={pullRequest.url}
              target="_blank"
              rel="noreferrer noopener"
              className="font-mono text-slate-400 hover:text-slate-200"
            >
              #{pullRequest.number}
            </a>
            <ModeBadge mode={report.mode} />
            {pullRequest.draft ? (
              <span className="rounded-full border border-slate-600/60 px-2 py-0.5 text-[10px] uppercase tracking-wider text-slate-400">
                Draft
              </span>
            ) : null}
            <span className="text-[11px] text-slate-500">analyzed {formatUtc(report.generatedAt)}</span>
          </div>

          <h2 className="mt-3 break-words text-2xl font-bold tracking-tight text-white md:text-3xl">
            <a
              href={pullRequest.url}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-start gap-2 hover:text-teal-200"
            >
              {pullRequest.title}
              <ArrowUpRightIcon className="mt-1.5 h-4 w-4 shrink-0 opacity-60" />
            </a>
          </h2>

          <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-400">
            <span>
              by <span className="text-slate-200">@{pullRequest.author}</span>
            </span>
            <span className="text-slate-600">·</span>
            <span className="font-mono text-slate-300">
              {pullRequest.headRef || "unknown"} → {pullRequest.baseRef || "unknown"}
            </span>
            <span className="text-slate-600">·</span>
            <span>updated {formatUtc(pullRequest.updatedAt)}</span>
          </p>

          <p className={`mt-4 text-sm font-medium ${style.text}`}>{summary.headline}</p>

          <dl className="mt-5 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
            <Stat label="Changed files" value={checks.changedFiles} />
            <Stat label="Lines" value={`+${checks.additions} / −${checks.deletions}`} />
            <Stat label="Commits" value={checks.commits} />
            <Stat
              label="Guidelines"
              value={guidelines.files.length}
              hint={guidelines.files.length === 0 ? "none found" : guidelines.files[0]?.path}
            />
          </dl>
        </div>

        <VerdictStamp report={report} />
      </div>
    </header>
  );
}

function SectionTitle({
  title,
  description,
  count,
}: {
  title: string;
  description?: string;
  count?: number;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-2">
      <div>
        <h3 className="flex items-center gap-2 text-sm font-semibold text-white">
          {title}
          {typeof count === "number" ? (
            <span className="rounded-full bg-white/5 px-1.5 py-0.5 font-mono text-[10px] text-slate-400">
              {count}
            </span>
          ) : null}
        </h3>
        {description ? <p className="mt-1 text-xs text-slate-500">{description}</p> : null}
      </div>
    </div>
  );
}

function FindingsSection({ report }: { report: Report }) {
  const failed = report.findings.filter((finding) => finding.status === "fail");
  const review = report.findings.filter((finding) => finding.status === "needs_review");
  const passed = report.findings.filter((finding) => finding.status === "pass");

  return (
    <section className="panel p-6" aria-labelledby="findings-heading">
      <div id="findings-heading">
        <SectionTitle
          title="Findings"
          description="Each finding quotes the rule source and the pull request evidence that decided it."
          count={report.findings.length}
        />
      </div>

      {report.findings.length === 0 ? (
        <p className="mt-5 rounded-xl border border-dashed border-slate-700/60 px-4 py-6 text-sm text-slate-400">
          No requirements could be evaluated. {report.limitations[0] ?? "Check the limitations below."}
        </p>
      ) : null}

      {failed.length > 0 ? (
        <div className="mt-6">
          <SectionTitle title="Failed requirements" count={failed.length} />
          <div className="mt-3 space-y-3">
            {failed.map((finding) => (
              <FindingCard key={finding.id} finding={finding} />
            ))}
          </div>
        </div>
      ) : null}

      {review.length > 0 ? (
        <div className="mt-8">
          <SectionTitle title="Needs human review" count={review.length} />
          <p className="mt-1 text-xs text-slate-500">
            Automated evidence was insufficient or the requirement is conditional. These are not failures.
          </p>
          <div className="mt-3 space-y-3">
            {review.map((finding) => (
              <FindingCard key={finding.id} finding={finding} />
            ))}
          </div>
        </div>
      ) : null}

      {passed.length > 0 ? (
        <details className="group mt-8 rounded-xl border border-emerald-400/15 bg-emerald-400/[0.03]">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-4 py-3 text-sm font-medium text-emerald-200">
            <span className="inline-flex items-center gap-2">
              <CheckIcon className="h-4 w-4" />
              {passed.length} requirement{passed.length === 1 ? "" : "s"} passed
            </span>
            <span className="text-[11px] text-emerald-300/60 group-open:hidden">Show</span>
            <span className="hidden text-[11px] text-emerald-300/60 group-open:inline">Hide</span>
          </summary>
          <div className="space-y-3 px-4 pb-4">
            {passed.map((finding) => (
              <FindingCard key={finding.id} finding={finding} />
            ))}
          </div>
        </details>
      ) : null}
    </section>
  );
}

function SideCard({
  title,
  children,
  tone = "default",
}: {
  title: string;
  children: ReactNode;
  tone?: "default" | "warning" | "danger";
}) {
  const border =
    tone === "danger"
      ? "border-rose-400/25"
      : tone === "warning"
        ? "border-amber-300/20"
        : "border-white/10";
  return (
    <section className={`panel ${border} p-5`}>
      <h3 className="text-[10px] font-semibold uppercase tracking-[0.22em] text-slate-500">{title}</h3>
      <div className="mt-3 space-y-3">{children}</div>
    </section>
  );
}

function CiRow({ report }: { report: Report }) {
  const ci = report.checks.ci;
  const meta =
    !ci.available
      ? { dot: "bg-slate-500", label: "Unavailable", text: ci.reason ?? "GitHub did not expose checks." }
      : ci.state === "failure"
        ? {
            dot: "bg-rose-400",
            label: `${ci.failing.length} failing`,
            text: `${ci.failing.length} of ${ci.total} reported checks did not pass.`,
          }
        : ci.state === "pending"
          ? {
              dot: "bg-amber-300",
              label: "Pending",
              text: `${ci.pending.length} of ${ci.total} checks have not finished.`,
            }
          : ci.state === "success"
            ? { dot: "bg-emerald-400", label: "Passing", text: `${ci.successful} of ${ci.total} checks passed.` }
            : { dot: "bg-slate-500", label: "No checks", text: "No CI checks were reported for this commit." };

  return (
    <div className="rounded-xl border border-white/5 bg-white/[0.02] px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-xs font-medium text-slate-200">
          <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} />
          CI · {meta.label}
        </span>
        {ci.sourceUrl ? (
          <a
            href={ci.sourceUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="text-[11px] text-sky-300 hover:text-sky-200"
          >
            Checks
          </a>
        ) : null}
      </div>
      <p className="mt-1 text-[11px] leading-relaxed text-slate-500">{meta.text}</p>
      {ci.failing.length > 0 ? (
        <ul className="mt-2 space-y-1">
          {ci.failing.slice(0, 4).map((check) => (
            <li key={check.name} className="flex items-start gap-1.5 text-[11px] text-rose-200/90">
              <span className="mt-1 h-1 w-1 shrink-0 rounded-full bg-rose-400" />
              <span className="break-words">{check.name}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function ChecksCard({ report }: { report: Report }) {
  const mergeable = report.checks.mergeable;
  return (
    <SideCard title="Checks & sources">
      <CiRow report={report} />

      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-lg border border-white/5 bg-white/[0.02] px-2.5 py-2">
          <p className="text-[10px] uppercase tracking-wider text-slate-500">Mergeable</p>
          <p
            className={`mt-0.5 text-xs font-medium ${
              mergeable === true ? "text-emerald-300" : mergeable === false ? "text-rose-300" : "text-slate-400"
            }`}
          >
            {mergeable === true ? "Yes" : mergeable === false ? "Conflicts" : "Unknown"}
          </p>
        </div>
        <div className="rounded-lg border border-white/5 bg-white/[0.02] px-2.5 py-2">
          <p className="text-[10px] uppercase tracking-wider text-slate-500">Diff</p>
          <p className="mt-0.5 font-mono text-xs text-slate-300">
            +{report.checks.additions} / −{report.checks.deletions}
          </p>
        </div>
      </div>

      <div>
        <p className="text-[10px] uppercase tracking-wider text-slate-500">Contribution guidelines</p>
        {report.guidelines.files.length === 0 ? (
          <p className="mt-1 text-[11px] leading-relaxed text-amber-200/90">
            No guidelines were found at the base commit. Only platform checks ran.
          </p>
        ) : (
          <ul className="mt-1.5 space-y-1">
            {report.guidelines.files.map((file) => (
              <li key={file.path}>
                <a
                  href={file.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="flex items-center gap-1.5 font-mono text-[11px] text-slate-300 hover:text-teal-200"
                >
                  <span className="truncate">{file.path}</span>
                  <ArrowUpRightIcon className="h-3 w-3 shrink-0 opacity-60" />
                </a>
                <p className="text-[10px] text-slate-500">
                  {file.lineCount} lines{file.truncated ? " · truncated" : ""}
                </p>
              </li>
            ))}
          </ul>
        )}
        {report.guidelines.templatePath ? (
          <p className="mt-2 font-mono text-[10px] text-slate-500">
            template: {report.guidelines.templatePath}
          </p>
        ) : null}
      </div>

      {report.validationCommands.length > 0 ? (
        <div>
          <p className="text-[10px] uppercase tracking-wider text-slate-500">Validation commands</p>
          <ul className="mt-1.5 space-y-1">
            {report.validationCommands.slice(0, 5).map((command) => (
              <li key={command.command} className="rounded bg-slate-950/50 px-2 py-1 font-mono text-[10.5px] text-slate-300">
                {command.command}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </SideCard>
  );
}

function ModelCard({ report }: { report: Report }) {
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
    <SideCard title="Model">
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-200">
          <SparkIcon className="h-3.5 w-3.5 text-indigo-300" />
          {label}
        </span>
        {model.rejectedFindings > 0 ? (
          <span className="rounded-full border border-amber-300/30 px-1.5 py-0.5 text-[10px] text-amber-200">
            {model.rejectedFindings} rejected
          </span>
        ) : null}
      </div>

      {model.model ? <p className="break-all font-mono text-[10.5px] text-slate-400">{model.model}</p> : null}

      {!model.requested ? (
        <p className="text-[11px] leading-relaxed text-slate-500">
          No free-form rules were extracted from the guidelines, so inference was not needed.
        </p>
      ) : null}

      {model.error ? (
        <p className="rounded-lg border border-rose-400/25 bg-rose-500/10 px-2.5 py-2 text-[11px] leading-relaxed text-rose-200">
          {model.error}
        </p>
      ) : null}

      {model.notes.length > 0 ? (
        <ul className="space-y-1.5">
          {model.notes.map((note) => (
            <li key={note} className="text-[11px] leading-relaxed text-slate-400">
              {note}
            </li>
          ))}
        </ul>
      ) : null}

      <p className="text-[10px] leading-relaxed text-slate-500">
        Model output is validated against a strict schema and against this pull request&apos;s own files and commits.
      </p>
    </SideCard>
  );
}

function PendingCard({ report }: { report: Report }) {
  if (report.pendingRules.length === 0) return null;
  return (
    <SideCard title="Not evaluated" tone="warning">
      <ul className="space-y-2.5">
        {report.pendingRules.map((rule) => (
          <li key={rule.id}>
            <p className="text-xs font-medium text-amber-100">{rule.title}</p>
            <p className="mt-0.5 text-[11px] leading-relaxed text-slate-400">{rule.requirement}</p>
            <p className="mt-1 text-[10px] text-amber-200/70">{rule.reason}</p>
          </li>
        ))}
      </ul>
    </SideCard>
  );
}

function LimitationsCard({ report }: { report: Report }) {
  if (report.limitations.length === 0) return null;
  return (
    <SideCard title="Limitations" tone="warning">
      <ul className="space-y-2">
        {report.limitations.map((limitation) => (
          <li key={limitation} className="flex items-start gap-2 text-[11px] leading-relaxed text-slate-400">
            <AlertIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-300/80" />
            <span>{limitation}</span>
          </li>
        ))}
      </ul>
    </SideCard>
  );
}

export function ReportView({ report }: { report: Report }) {
  return (
    <section id="report" aria-label="Analysis report" className="rise mt-8 space-y-5">
      {report.mode === "demo" ? (
        <div className="rounded-xl border border-amber-300/25 bg-amber-300/[0.07] px-4 py-3 text-xs leading-relaxed text-amber-100">
          <span className="font-semibold uppercase tracking-wider">Demo report.</span> Repository, pull request and CI
          data come from bundled fixtures, not GitHub. Model findings are a recorded sample; no inference endpoint was
          called.
        </div>
      ) : null}

      <ReportHeader report={report} />

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-5">
          <FindingsSection report={report} />
          <RemediationPanel report={report} />
        </div>
        <aside className="space-y-4">
          <ChecksCard report={report} />
          <ModelCard report={report} />
          <PendingCard report={report} />
          <LimitationsCard report={report} />
        </aside>
      </div>

      <p className="px-1 text-[10px] text-slate-600">
        Report {report.schema} · generated in {report.timings.totalMs} ms · findings: {report.summary.pass} pass,{" "}
        {report.summary.fail} fail, {report.summary.needsReview} needs review
      </p>
    </section>
  );
}