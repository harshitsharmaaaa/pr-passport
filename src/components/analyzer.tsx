"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { DemoSummary } from "@/lib/demo/fixtures";
import { tryParsePullRequestUrl } from "@/lib/pr-url";
import type { Report } from "@/lib/types";
import { AlertIcon, CheckIcon, GithubIcon, PullRequestIcon, RefreshIcon, Spinner } from "./icons";
import { ReportView } from "./report-view";
import { buttonClass, cx } from "./ui";

interface AnalyzerProps {
  initialUrl?: string;
  autoRunDemo?: boolean;
  demoScenarios: readonly DemoSummary[];
}

interface PublicError {
  message: string;
  hint?: string;
}

const STEPS = [
  {
    title: "Retrieve the evidence",
    body: "Pull request metadata, changed files, commits, GitHub checks, and the repository's CONTRIBUTING file and PR template at the base commit.",
  },
  {
    title: "Evaluate what is checkable",
    body: "Deterministic rules for DCO sign-off, issue links, title format, tests, changelog, template items, CI, mergeability, and size — only when the repository's own guidelines require them.",
  },
  {
    title: "Interpret the rest, carefully",
    body: "Free-form guidance goes to an open-weight model. Every claim is validated against a strict schema and this pull request's own files; unsupported claims become needs-review items.",
  },
];

const GUARDRAILS = [
  ["Read-only by design", "Never merges, pushes, or executes repository code. It cannot write to GitHub."],
  ["Public repositories only", "No OAuth and no private repositories. A missing or private PR is reported as not found."],
  ["No invented rules", "Every project rule cites a repository file and line, with a quoted excerpt."],
  ["Strict model validation", "Unknown rule IDs, files, commits, and metadata are discarded before display."],
  ["Gaps are stated", "Missing CI, unreadable files, or absent guidelines appear as limitations, never as guesses."],
  ["Deterministic demo", "Bundled fixtures exercise the full report without GitHub or inference credentials."],
];

const INVALID_URL_MESSAGE =
  "Enter a public GitHub pull request URL, for example https://github.com/owner/repository/pull/123.";

function updateUrl(url: string, demo: boolean) {
  try {
    const params = new URLSearchParams({ url });
    if (demo) params.set("demo", "1");
    window.history.replaceState({}, "", `${window.location.pathname}?${params.toString()}`);
  } catch {
    // History is best-effort; analysis results are unaffected.
  }
}

export function Analyzer({ initialUrl = "", autoRunDemo = false, demoScenarios }: AnalyzerProps) {
  const [url, setUrl] = useState(initialUrl);
  const [demo, setDemo] = useState(autoRunDemo);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<PublicError | null>(null);
  const [urlError, setUrlError] = useState<string | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const started = useRef(false);
  const resultsRef = useRef<HTMLDivElement | null>(null);
  const lastRun = useRef<{ url: string; demo: boolean } | null>(null);

  const run = useCallback(async (targetUrl: string, isDemo: boolean) => {
    lastRun.current = { url: targetUrl, demo: isDemo };
    setLoading(true);
    setError(null);
    setUrlError(null);
    setReport(null);
    setDemo(isDemo);

    try {
      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: targetUrl, demo: isDemo }),
      });
      const payload: unknown = await response.json();

      if (!response.ok) {
        const failure = payload as { error?: Partial<PublicError> };
        setError({
          message: failure.error?.message ?? "The analysis failed.",
          hint: failure.error?.hint,
        });
        return;
      }

      setReport(payload as Report);
      updateUrl(targetUrl, isDemo);
      const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      window.setTimeout(() => {
        resultsRef.current?.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
      }, 60);
    } catch {
      setError({
        message: "Could not reach the analysis API.",
        hint: "Check that the server is running, then try again.",
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!autoRunDemo || !initialUrl || started.current) return;
    started.current = true;
    const parsed = tryParsePullRequestUrl(initialUrl);
    if (parsed) void run(parsed.canonicalUrl, true);
  }, [autoRunDemo, initialUrl, run]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = tryParsePullRequestUrl(url);
    if (!parsed) {
      setUrlError(INVALID_URL_MESSAGE);
      setError(null);
      return;
    }
    setUrlError(null);
    void run(parsed.canonicalUrl, false);
  }

  function startDemo(scenario: DemoSummary) {
    setUrl(scenario.url);
    setDemo(true);
    setUrlError(null);
    void run(scenario.url, true);
  }

  function retry() {
    const attempt = lastRun.current;
    if (attempt) void run(attempt.url, attempt.demo);
  }

  const inputInvalid = Boolean(urlError);

  return (
    <main className="mx-auto w-full max-w-[76rem] px-4 pb-4 pt-8 sm:px-6 sm:pt-12">
      <section aria-labelledby="analyze-heading" className="max-w-3xl">
        <h1
          id="analyze-heading"
          className="text-[27px] font-semibold leading-[1.15] tracking-[-0.02em] text-ink sm:text-[32px]"
        >
          Check a pull request
        </h1>
        <p className="mt-2.5 max-w-2xl text-[14px] leading-6 text-ink-secondary sm:text-[15px]">
          Verify repository contribution rules, tests, and CI evidence before review. Every finding cites the rule it
          enforces and the evidence that decided it.
        </p>

        <form
          onSubmit={submit}
          className="mt-7 rounded-surface border border-line bg-surface p-3 shadow-[0_1px_2px_rgba(25,29,26,0.04)] sm:p-4"
        >
          <label htmlFor="pr-url" className="block text-[12.5px] font-medium text-ink">
            Pull request URL
          </label>
          <div className="mt-1.5 flex flex-col gap-2 sm:flex-row">
            <div className="relative min-w-0 flex-1">
              <GithubIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-subtle" />
              <input
                id="pr-url"
                name="url"
                type="text"
                inputMode="url"
                autoComplete="url"
                spellCheck={false}
                enterKeyHint="go"
                value={url}
                onChange={(event) => {
                  setUrl(event.target.value);
                  setDemo(false);
                  setUrlError(null);
                  setError(null);
                }}
                placeholder="https://github.com/owner/repository/pull/123"
                aria-invalid={inputInvalid}
                aria-describedby={cx("pr-url-help", inputInvalid && "pr-url-error")}
                className={cx(
                  "h-11 w-full rounded-control border bg-surface pl-9 pr-3 font-mono text-[13px] text-ink transition-colors placeholder:font-sans placeholder:text-[13px] placeholder:text-ink-subtle",
                  inputInvalid ? "border-danger/60" : "border-line hover:border-line-strong",
                )}
              />
            </div>
            <button type="submit" disabled={loading} className={buttonClass("primary")}>
              {loading ? <Spinner className="h-4 w-4" /> : <PullRequestIcon className="h-4 w-4" />}
              {loading ? "Analyzing…" : "Analyze pull request"}
            </button>
          </div>

          <p id="pr-url-help" className="mt-2 text-[12px] text-ink-subtle">
            Public repositories only. Format:{" "}
            <span className="font-mono text-[11.5px] text-ink-secondary">github.com/owner/repo/pull/123</span>
          </p>
          {urlError ? (
            <p
              id="pr-url-error"
              role="alert"
              className="mt-2 flex items-start gap-1.5 text-[12.5px] leading-5 text-danger"
            >
              <AlertIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {urlError}
            </p>
          ) : null}

          <div className="mt-3 flex flex-wrap items-center gap-x-2.5 gap-y-2 border-t border-line pt-3">
            <span className="text-[12px] text-ink-subtle">No pull request handy? Load a bundled example:</span>
            {demoScenarios.map((scenario) => (
              <button
                key={scenario.slug}
                type="button"
                onClick={() => startDemo(scenario)}
                disabled={loading}
                title={scenario.description}
                className="inline-flex h-11 items-center rounded-control border border-line bg-surface px-2.5 text-[12px] font-medium text-ink-secondary transition-colors hover:border-line-strong hover:bg-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-55 sm:h-9"
              >
                {scenario.label}
              </button>
            ))}
          </div>
        </form>
      </section>

      {loading ? (
        <div
          role="status"
          aria-live="polite"
          className="mt-8 overflow-hidden rounded-surface border border-line bg-surface"
        >
          <div className="flex items-start gap-2.5 border-b border-line px-5 py-4">
            <Spinner className="mt-0.5 h-4 w-4 shrink-0 text-brand" />
            <div className="min-w-0">
              <p className="text-[13.5px] font-medium text-ink">Analyzing pull request</p>
              <p className="mt-0.5 text-[12.5px] leading-5 text-ink-secondary">
                Retrieving pull request metadata, contribution rules, and check results. This usually takes a few
                seconds; model interpretation can take longer.
              </p>
            </div>
          </div>
          <div className="px-5 py-5" aria-hidden="true">
            <div className="skeleton h-3 w-44 rounded-[3px]" />
            <div className="mt-3.5 skeleton h-4 w-3/5 rounded-[3px]" />
            <div className="mt-2 skeleton h-3 w-2/5 rounded-[3px]" />
            <div className="mt-6 flex flex-wrap gap-2">
              <div className="skeleton h-8 w-32 rounded-control" />
              <div className="skeleton h-8 w-24 rounded-control" />
              <div className="skeleton h-8 w-28 rounded-control" />
            </div>
            <div className="mt-7 space-y-4">
              {[0, 1, 2, 3].map((row) => (
                <div key={row} className="flex items-start gap-3">
                  <div className="skeleton h-5 w-5 shrink-0 rounded-full" />
                  <div className="min-w-0 flex-1">
                    <div className="skeleton h-3.5 w-1/3 rounded-[3px]" />
                    <div className="mt-2 skeleton h-3 w-4/5 rounded-[3px]" />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : null}

      {error ? (
        <div
          role="alert"
          className="mt-6 rounded-surface border border-danger/25 bg-danger-subtle px-4 py-3.5"
        >
          <div className="flex items-start gap-2.5">
            <AlertIcon className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
            <div className="min-w-0">
              <p className="text-[13px] font-medium text-danger">{error.message}</p>
              {error.hint ? (
                <p className="mt-1 text-[12.5px] leading-5 text-ink-secondary">{error.hint}</p>
              ) : null}
              <div className="mt-2.5 flex flex-wrap items-center gap-2">
                <button type="button" onClick={retry} className={buttonClass("secondary", "sm")}>
                  <RefreshIcon className="h-3.5 w-3.5" />
                  Try again
                </button>
                <span className="text-[11.5px] text-ink-subtle">Your URL is kept as entered.</span>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      <div ref={resultsRef}>{report ? <ReportView report={report} /> : null}</div>

      {demo && !report && !loading ? (
        <p className="mt-4 inline-flex items-center gap-1.5 rounded-control border border-warning/25 bg-warning-subtle px-2.5 py-1 text-[11.5px] text-warning">
          Demo mode selected — bundled fixtures only.
        </p>
      ) : null}

      <section id="how-it-works" aria-labelledby="how-it-works-heading" className="mt-14 scroll-mt-20">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-t border-line pt-8">
          <h2 id="how-it-works-heading" className="text-[15px] font-semibold text-ink">
            How it works
          </h2>
          <p className="text-[12px] text-ink-subtle">Read-only · no repository code is executed</p>
        </div>
        <ol className="mt-5 grid gap-x-8 gap-y-6 sm:grid-cols-3">
          {STEPS.map((step, index) => (
            <li key={step.title}>
              <p className="font-mono text-[11.5px] tabular-nums text-ink-subtle">0{index + 1}</p>
              <h3 className="mt-1.5 text-[13.5px] font-medium text-ink">{step.title}</h3>
              <p className="mt-1 text-[12.5px] leading-5 text-ink-secondary">{step.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="boundaries-heading" className="mt-10">
        <div className="rounded-surface border border-line bg-surface px-5 py-4 sm:px-6 sm:py-5">
          <h2 id="boundaries-heading" className="text-[15px] font-semibold text-ink">
            Boundaries
          </h2>
          <dl className="mt-3.5 grid gap-x-8 gap-y-3 sm:grid-cols-2">
            {GUARDRAILS.map(([title, body]) => (
              <div key={title} className="flex items-start gap-2">
                <CheckIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand" />
                <div className="min-w-0">
                  <dt className="text-[12.5px] font-medium text-ink">{title}</dt>
                  <dd className="mt-0.5 text-[12px] leading-5 text-ink-secondary">{body}</dd>
                </div>
              </div>
            ))}
          </dl>
        </div>
      </section>
    </main>
  );
}
