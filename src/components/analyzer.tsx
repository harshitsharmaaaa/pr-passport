"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { DemoSummary } from "@/lib/demo/fixtures";
import { tryParsePullRequestUrl } from "@/lib/pr-url";
import type { Report } from "@/lib/types";
import {
  AlertIcon,
  CheckIcon,
  GithubIcon,
  PassportMark,
  PullRequestIcon,
  Spinner,
} from "./icons";
import { ReportView } from "./report-view";

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
    title: "Fetch the evidence",
    body: "Pull request metadata, changed files, commits, GitHub checks, and the repository's own CONTRIBUTING and PR template at the base commit.",
  },
  {
    title: "Evaluate what is checkable",
    body: "Deterministic rules for DCO sign-off, issue links, title format, tests, changelog, template checkboxes, CI, mergeability, and size limits.",
  },
  {
    title: "Interpret the rest — carefully",
    body: "Free-form guidance goes to an open-weight model. Every claim is checked against the schema and the PR's own files; unsupported claims become NEEDS HUMAN REVIEW.",
  },
];

const GUARDRAILS = [
  ["Read-only by design", "Never merges, pushes, or executes repository code. It cannot write to GitHub."],
  ["Public repositories only", "No OAuth and no private repositories. A missing or private PR is reported as not found."],
  ["No invented rules", "Every project rule cites a repository file and line number, with a quoted excerpt."],
  ["Strict model validation", "Unknown rule IDs, unknown files, and unsupported commits are discarded before display."],
  ["Gaps are stated", "Missing CI, unreadable files, or absent guidelines appear as limitations, never as guesses."],
  ["Deterministic demo", "Bundled fixtures exercise the full report without GitHub or inference credentials."],
];

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
  const [report, setReport] = useState<Report | null>(null);
  const started = useRef(false);
  const resultsRef = useRef<HTMLDivElement | null>(null);

  const run = useCallback(async (targetUrl: string, isDemo: boolean) => {
    setLoading(true);
    setError(null);
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

      const nextReport = payload as Report;
      setReport(nextReport);
      updateUrl(targetUrl, isDemo);
      window.setTimeout(() => {
        resultsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
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
      setError({
        message: "Enter a valid public GitHub pull request URL.",
        hint: "Expected format: https://github.com/owner/repository/pull/123",
      });
      return;
    }
    void run(parsed.canonicalUrl, false);
  }

  function startDemo(scenario: DemoSummary) {
    setUrl(scenario.url);
    setDemo(true);
    void run(scenario.url, true);
  }

  return (
    <main className="mx-auto w-full max-w-6xl px-4 pb-20 pt-5 sm:px-6">
      <header className="flex items-center justify-between gap-4 py-2">
        <div className="flex items-center gap-2.5">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-teal-300/30 bg-teal-300/10 text-teal-200">
            <PassportMark className="h-6 w-6" />
          </div>
          <div>
            <p className="text-sm font-semibold tracking-tight text-white">PR Passport</p>
            <p className="text-[9px] uppercase tracking-[0.2em] text-slate-500">Contribution compliance</p>
          </div>
        </div>
        <nav className="flex items-center gap-4 text-xs text-slate-400" aria-label="Primary">
          <a href="#how-it-works" className="transition hover:text-white">
            How it works
          </a>
          <a href="#guardrails" className="hidden transition hover:text-white sm:inline">
            Guardrails
          </a>
          <span className="hidden rounded-full border border-white/10 px-2.5 py-1 text-[9px] uppercase tracking-[0.16em] text-slate-500 sm:inline">
            Open source
          </span>
        </nav>
      </header>

      <section className="pt-10 sm:pt-14">
        <div className="max-w-3xl">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-teal-300/25 bg-teal-300/[0.07] px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.16em] text-teal-200">
            <CheckIcon className="h-3 w-3" />
            Read-only · evidence-backed
          </span>
          <h1 className="mt-5 text-balance text-4xl font-bold leading-[1.05] tracking-tight text-white sm:text-5xl">
            Does your pull request follow the repo&apos;s own rules?
          </h1>
          <p className="mt-4 max-w-2xl text-sm leading-relaxed text-slate-400 sm:text-base">
            PR Passport reads a public GitHub pull request and its repository&apos;s contribution guidelines, then
            returns <span className="font-medium text-emerald-300">PASS</span>,{" "}
            <span className="font-medium text-rose-300">FAIL</span>, or{" "}
            <span className="font-medium text-amber-300">NEEDS HUMAN REVIEW</span> — with the rule source and pull
            request evidence for every finding.
          </p>
        </div>

        <form onSubmit={submit} className="panel mt-8 p-2 sm:p-3">
          <div className="flex flex-col gap-2 sm:flex-row">
            <div className="relative flex-1">
              <GithubIcon className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
              <input
                id="pr-url"
                name="url"
                type="url"
                inputMode="url"
                autoComplete="url"
                spellCheck={false}
                value={url}
                onChange={(event) => {
                  setUrl(event.target.value);
                  setDemo(false);
                  setError(null);
                }}
                placeholder="https://github.com/owner/repository/pull/123"
                aria-label="Public GitHub pull request URL"
                className="h-12 w-full rounded-xl border border-transparent bg-slate-950/50 pl-11 pr-4 font-mono text-[12.5px] text-slate-100 outline-none transition placeholder:text-slate-600 focus:border-teal-300/40 focus:bg-slate-950/70"
              />
            </div>
            <button
              type="submit"
              disabled={loading}
              className="inline-flex h-12 items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-teal-300 to-cyan-300 px-6 text-sm font-semibold text-slate-950 transition hover:from-teal-200 hover:to-cyan-200 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {loading ? <Spinner className="h-4 w-4" /> : <PullRequestIcon className="h-4 w-4" />}
              {loading ? "Analyzing" : "Analyze PR"}
            </button>
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-2 px-1 pb-1">
            <span className="text-[9px] uppercase tracking-[0.18em] text-slate-600">Try a fixture</span>
            {demoScenarios.map((scenario) => (
              <button
                key={scenario.slug}
                type="button"
                onClick={() => startDemo(scenario)}
                disabled={loading}
                title={scenario.description}
                className="rounded-full border border-slate-700/70 bg-slate-900/60 px-2.5 py-1 text-[11px] text-slate-300 transition hover:border-teal-300/40 hover:text-teal-200 disabled:opacity-50"
              >
                {scenario.label}
              </button>
            ))}
            {demo ? (
              <span className="rounded-full border border-amber-300/25 bg-amber-300/10 px-2 py-0.5 text-[9px] uppercase tracking-wider text-amber-200">
                demo mode
              </span>
            ) : null}
            <span className="ml-auto hidden text-[10px] text-slate-600 sm:inline">
              No OAuth · public repos only · no repository code executed
            </span>
          </div>
        </form>
      </section>

      {loading ? (
        <div role="status" aria-live="polite" className="panel mt-6 p-6">
          <div className="flex items-center gap-3 text-sm text-slate-300">
            <Spinner className="h-4 w-4 text-teal-300" />
            Reading the pull request, guidelines, and checks…
          </div>
          <div className="mt-4 h-1 overflow-hidden rounded-full bg-white/5">
            <div className="h-full w-1/3 animate-pulse rounded-full bg-gradient-to-r from-teal-300 to-indigo-400" />
          </div>
          <p className="mt-3 text-[11px] text-slate-500">
            Live analyses usually take a few seconds. Model interpretation can take longer.
          </p>
        </div>
      ) : null}

      {error ? (
        <div
          role="alert"
          className="mt-6 rounded-2xl border border-rose-400/30 bg-rose-500/[0.07] px-5 py-4"
        >
          <div className="flex items-start gap-2.5">
            <AlertIcon className="mt-0.5 h-4 w-4 shrink-0 text-rose-300" />
            <div>
              <p className="text-sm font-medium text-rose-100">{error.message}</p>
              {error.hint ? <p className="mt-1 text-xs text-rose-200/70">{error.hint}</p> : null}
            </div>
          </div>
        </div>
      ) : null}

      <div ref={resultsRef}>{report ? <ReportView report={report} /> : null}</div>

      <section id="how-it-works" className="mt-16 scroll-mt-6">
        <h2 className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-500">How it works</h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          {STEPS.map((step, index) => (
            <div key={step.title} className="panel p-5">
              <span className="font-mono text-[11px] text-teal-300">0{index + 1}</span>
              <h3 className="mt-2 text-sm font-semibold text-white">{step.title}</h3>
              <p className="mt-1.5 text-xs leading-relaxed text-slate-400">{step.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section id="guardrails" className="mt-5 scroll-mt-6">
        <div className="panel p-6">
          <h2 className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-500">Guardrails</h2>
          <div className="mt-4 grid gap-x-8 gap-y-4 sm:grid-cols-2">
            {GUARDRAILS.map(([title, body]) => (
              <div key={title} className="flex items-start gap-2.5">
                <CheckIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-teal-300" />
                <div>
                  <p className="text-xs font-semibold text-slate-200">{title}</p>
                  <p className="mt-0.5 text-[11px] leading-relaxed text-slate-500">{body}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <footer className="mt-14 flex flex-col gap-2 border-t border-white/5 pt-6 text-[11px] text-slate-500 sm:flex-row sm:items-center sm:justify-between">
        <p>PR Passport · MIT licensed · built for the Alan hackathon</p>
        <p>No OAuth. No writes. No repository code executed.</p>
      </footer>
    </main>
  );
}