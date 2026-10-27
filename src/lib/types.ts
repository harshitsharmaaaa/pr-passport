export const REPORT_SCHEMA = "pr-passport.report.v1" as const;

export type FindingStatus = "pass" | "fail" | "needs_review";
export type FindingOrigin = "deterministic" | "model" | "recorded_fixture";
export type Verdict = "pass" | "fail" | "needs_review";
export type AnalysisMode = "live" | "demo";
export type ModelMode = "live" | "recorded_fixture" | "none" | "failed";

/** Where a rule came from. Every finding must carry one. */
export interface RuleSource {
  kind: "repository_file" | "pull_request" | "github_api" | "unavailable";
  label: string;
  path?: string;
  url?: string;
  lineStart?: number;
  lineEnd?: number;
  excerpt?: string;
}

/** A concrete fact taken from the pull request, used to support a finding. */
export interface Evidence {
  kind: "file" | "commit" | "title" | "body" | "ci" | "metadata";
  label: string;
  detail: string;
  path?: string;
  url?: string;
  lineStart?: number;
}

export interface Finding {
  id: string;
  title: string;
  requirement: string;
  status: FindingStatus;
  origin: FindingOrigin;
  source: RuleSource;
  evidence: Evidence[];
  rationale: string;
  confidence?: number;
  remediation?: string;
}

/** A guideline that exists but could not be evaluated (for example, no inference configured). */
export interface PendingRule {
  id: string;
  title: string;
  requirement: string;
  source: RuleSource;
  reason: string;
}

export interface PullRequestSummary {
  owner: string;
  repo: string;
  number: number;
  url: string;
  title: string;
  body: string;
  author: string;
  authorUrl: string;
  state: "open" | "closed" | "merged";
  draft: boolean;
  createdAt: string;
  updatedAt: string;
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  labels: string[];
}

export interface RepositorySummary {
  fullName: string;
  url: string;
  stars: number;
  language?: string;
  defaultBranch: string;
}

export interface GuidelineSummary {
  path: string;
  url: string;
  truncated: boolean;
  lineCount: number;
}

export interface CiCheck {
  name: string;
  url?: string;
  conclusion?: string;
}

export interface CiSummary {
  available: boolean;
  /** Why CI could not be read, when `available` is false. */
  reason?: string;
  state: "success" | "failure" | "pending" | "none" | "unknown";
  total: number;
  successful: number;
  failing: CiCheck[];
  pending: CiCheck[];
  /**
   * Names of checks that passed, when the source can report them. Used to
   * verify that model evidence naming a check actually exists.
   */
  passing?: CiCheck[];
  sourceUrl?: string;
}

export interface ValidationCommand {
  command: string;
  reason: string;
  source: RuleSource;
}

export interface ModelMeta {
  requested: boolean;
  used: boolean;
  mode: ModelMode;
  model?: string;
  error?: string;
  rejectedFindings: number;
  notes: string[];
}

export interface Report {
  schema: typeof REPORT_SCHEMA;
  generatedAt: string;
  mode: AnalysisMode;
  repository: RepositorySummary;
  pullRequest: PullRequestSummary;
  guidelines: {
    files: GuidelineSummary[];
    missing: string[];
    unavailable: { path: string; reason: string }[];
    templatePath?: string;
  };
  checks: {
    ci: CiSummary;
    mergeable: boolean | null;
    mergeableState: string;
    commits: number;
    changedFiles: number;
    additions: number;
    deletions: number;
  };
  findings: Finding[];
  pendingRules: PendingRule[];
  summary: {
    pass: number;
    fail: number;
    needsReview: number;
    verdict: Verdict;
    headline: string;
  };
  limitations: string[];
  validationCommands: ValidationCommand[];
  remediationPrompt: string;
  model: ModelMeta;
  timings: { totalMs: number };
}

/* ---------- Source data returned by the GitHub adapter ---------- */

export interface PullRequestData extends PullRequestSummary {
  repository: RepositorySummary;
  mergeable: boolean | null;
  mergeableState: string;
  additions: number;
  deletions: number;
  changedFileCount: number;
  commitCount: number;
}

export interface ChangedFile {
  filename: string;
  status: "added" | "modified" | "removed" | "renamed" | "copied" | "changed" | "unchanged";
  additions: number;
  deletions: number;
  changes: number;
  previousFilename?: string;
  /**
   * Bounded unified-diff excerpt from GitHub. Absent for binary files and
   * capped to a small number of files so prompts stay small.
   */
  patch?: string;
}

export interface CommitSummary {
  sha: string;
  shortSha: string;
  message: string;
  author: string;
  date: string;
  verified: boolean;
}

export interface RepoFile {
  path: string;
  size: number;
}

export interface RepoContext {
  files: RepoFile[];
  packageJson?: { raw: string; scripts: Record<string, string>; packageManager?: string };
  packageManager?: "bun" | "pnpm" | "yarn" | "npm";
  hasPyproject: boolean;
  hasCargo: boolean;
  hasGoMod: boolean;
  hasMakefile: boolean;
}

export interface PullRequestSource {
  getPullRequest(ref: { owner: string; repo: string; number: number }): Promise<PullRequestData>;
  getChangedFiles(ref: { owner: string; repo: string; number: number }): Promise<ChangedFile[]>;
  getCommits(ref: { owner: string; repo: string; number: number }): Promise<CommitSummary[]>;
  getCi(ref: { owner: string; repo: string; number: number }, headSha: string): Promise<CiSummary>;
  getRepoContext(owner: string, repo: string, baseSha: string): Promise<RepoContext>;
  readRepositoryFile(owner: string, repo: string, path: string, ref: string): Promise<string | null>;
}