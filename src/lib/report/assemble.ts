import { summarizeGuidelines, type GuidelinesBundle } from "../guidelines";
import type {
  AnalysisMode,
  CiSummary,
  Finding,
  FindingStatus,
  ModelMeta,
  PendingRule,
  PullRequestData,
  Report,
  ValidationCommand,
  Verdict,
} from "../types";
import { REPORT_SCHEMA } from "../types";
import { buildRemediationPrompt } from "./remediation";

export interface ReportInput {
  mode: AnalysisMode;
  pr: PullRequestData;
  ci: CiSummary;
  guidelines: GuidelinesBundle;
  findings: Finding[];
  pendingRules: PendingRule[];
  model: ModelMeta;
  limitations: string[];
  validationCommands: ValidationCommand[];
  generatedAt: Date;
  totalMs: number;
}

const STATUS_RANK: Record<FindingStatus, number> = { fail: 0, needs_review: 1, pass: 2 };

function verdictFor(pass: number, fail: number, needsReview: number, pending: number): Verdict {
  if (fail > 0) return "fail";
  // Rules that were never evaluated must not let a report pass silently.
  if (needsReview > 0 || pending > 0) return "needs_review";
  return pass > 0 ? "pass" : "needs_review";
}

function headlineFor(
  verdict: Verdict,
  pass: number,
  fail: number,
  needsReview: number,
  pending: number,
): string {
  if (verdict === "fail") {
    return `${fail} requirement${fail === 1 ? "" : "s"} failed. Fix ${fail === 1 ? "it" : "them"} before requesting review.`;
  }
  if (verdict === "needs_review") {
    if (needsReview === 0 && pending > 0) {
      return `${pending} guideline rule${pending === 1 ? "" : "s"} could not be evaluated automatically. A human should review them.`;
    }
    if (needsReview === 0) {
      return "No requirements could be evaluated from the available data. A human should review this pull request.";
    }
    return `No hard failures, but ${needsReview} requirement${needsReview === 1 ? "" : "s"} need a human decision.`;
  }
  return `All ${pass} evaluated requirement${pass === 1 ? "" : "s"} passed.`;
}

export function assembleReport(input: ReportInput): Report {
  const findings = [...input.findings].sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status]);
  const pass = findings.filter((finding) => finding.status === "pass").length;
  const fail = findings.filter((finding) => finding.status === "fail").length;
  const needsReview = findings.filter((finding) => finding.status === "needs_review").length;
  const verdict = verdictFor(pass, fail, needsReview, input.pendingRules.length);
  const limitations = Array.from(new Set(input.limitations.filter(Boolean)));

  const {
    repository,
    mergeable,
    mergeableState,
    additions,
    deletions,
    changedFileCount,
    commitCount,
    ...pullRequest
  } = input.pr;

  const remediationPrompt = buildRemediationPrompt({
    pr: pullRequest,
    repository,
    mode: input.mode,
    findings,
    pendingRules: input.pendingRules,
    limitations,
    validationCommands: input.validationCommands,
    diff: {
      changedFiles: changedFileCount,
      additions,
      deletions,
      commits: commitCount,
    },
  });

  return {
    schema: REPORT_SCHEMA,
    generatedAt: input.generatedAt.toISOString(),
    mode: input.mode,
    repository,
    pullRequest,
    guidelines: {
      files: summarizeGuidelines(input.guidelines),
      missing: Array.from(new Set(input.guidelines.missing)),
      unavailable: input.guidelines.unavailable,
      templatePath: input.guidelines.template?.path,
    },
    checks: {
      ci: input.ci,
      mergeable,
      mergeableState,
      commits: commitCount,
      changedFiles: changedFileCount,
      additions,
      deletions,
    },
    findings,
    pendingRules: input.pendingRules,
    summary: {
      pass,
      fail,
      needsReview,
      verdict,
      headline: headlineFor(verdict, pass, fail, needsReview, input.pendingRules.length),
    },
    limitations,
    validationCommands: input.validationCommands,
    remediationPrompt,
    model: {
      ...input.model,
      notes: Array.from(new Set(input.model.notes)),
    },
    timings: { totalMs: input.totalMs },
  };
}