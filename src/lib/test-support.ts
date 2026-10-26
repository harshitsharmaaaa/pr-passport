import { parseMarkdown } from "./markdown";
import type { GuidelineFile, GuidelinesBundle } from "./guidelines";
import type { EvaluationContext } from "./rules/evaluate";
import type { RuleKind, RuleSpec } from "./rules/spec";
import type {
  ChangedFile,
  CiSummary,
  CommitSummary,
  PullRequestData,
  RepoContext,
  RuleSource,
} from "./types";

export const BASE_SHA = "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d";
export const HEAD_SHA = "8f3c1d9a7b6e5f4c3d2b1a0f9e8d7c6b5a493827";
export const OTHER_SHA = "3d2b1a0f9e8d7c6b5a4938278f3c1d9a7b6e5f4c";

export function makeFile(
  filename: string,
  additions = 12,
  deletions = 3,
  status: ChangedFile["status"] = "modified",
): ChangedFile {
  return { filename, status, additions, deletions, changes: additions + deletions };
}

export function makeCommit(
  sha: string,
  message: string,
  author = "Test Author",
  date = "2026-10-20T10:00:00Z",
): CommitSummary {
  return { sha, shortSha: sha.slice(0, 7), message, author, date, verified: false };
}

export function makeCi(overrides: Partial<CiSummary> = {}): CiSummary {
  return {
    available: true,
    state: "success",
    total: 2,
    successful: 2,
    failing: [],
    pending: [],
    sourceUrl: "https://github.com/acme/widget-kit/pull/42/checks",
    ...overrides,
  };
}

export function makeRepo(overrides: Partial<RepoContext> = {}): RepoContext {
  return {
    files: [
      { path: "package.json", size: 240 },
      { path: "bun.lock", size: 1_000 },
      { path: "tsconfig.json", size: 300 },
    ],
    packageJson: {
      raw: JSON.stringify({ scripts: { test: "bun test", lint: "eslint .", typecheck: "tsc --noEmit" } }),
      scripts: { test: "bun test", lint: "eslint .", typecheck: "tsc --noEmit" },
      packageManager: "bun@1.4.4",
    },
    packageManager: "bun",
    hasPyproject: false,
    hasCargo: false,
    hasGoMod: false,
    hasMakefile: false,
    ...overrides,
  };
}

export function makePr(overrides: Partial<PullRequestData> = {}): PullRequestData {
  const pr: PullRequestData = {
    owner: "acme",
    repo: "widget-kit",
    number: 42,
    url: "https://github.com/acme/widget-kit/pull/42",
    title: "feat(api): add cursor pagination",
    body: "Adds cursor pagination.\n\nFixes #128",
    author: "dev-user",
    authorUrl: "https://github.com/dev-user",
    state: "open",
    draft: false,
    createdAt: "2026-10-18T09:00:00Z",
    updatedAt: "2026-10-24T16:00:00Z",
    headRef: "feat/cursor-pagination",
    headSha: HEAD_SHA,
    baseRef: "main",
    baseSha: BASE_SHA,
    labels: [],
    repository: {
      fullName: "acme/widget-kit",
      url: "https://github.com/acme/widget-kit",
      stars: 120,
      language: "TypeScript",
      defaultBranch: "main",
    },
    mergeable: true,
    mergeableState: "clean",
    additions: 30,
    deletions: 8,
    changedFileCount: 1,
    commitCount: 1,
  };
  return { ...pr, ...overrides };
}

export function makeGuidelines(markdown: string, template?: string): GuidelinesBundle {
  const file: GuidelineFile = {
    path: "CONTRIBUTING.md",
    content: markdown,
    url: "https://github.com/acme/widget-kit/blob/main/CONTRIBUTING.md",
    truncated: false,
    lineCount: markdown.split("\n").length,
  };
  const templateFile: GuidelineFile | undefined = template
    ? {
        path: ".github/PULL_REQUEST_TEMPLATE.md",
        content: template,
        url: "https://github.com/acme/widget-kit/blob/main/.github/PULL_REQUEST_TEMPLATE.md",
        truncated: false,
        lineCount: template.split("\n").length,
      }
    : undefined;

  return {
    files: [file],
    docs: [parseMarkdown(file.path, markdown)],
    template: templateFile,
    templateDoc: templateFile ? parseMarkdown(templateFile.path, templateFile.content) : undefined,
    missing: [],
    unavailable: [],
  };
}

export function makeSpec(kind: RuleKind, overrides: Partial<RuleSpec> = {}): RuleSpec {
  const source: RuleSource = {
    kind: "repository_file",
    label: "CONTRIBUTING.md § Pull request requirements",
    path: "CONTRIBUTING.md",
    url: "https://github.com/acme/widget-kit/blob/main/CONTRIBUTING.md",
    lineStart: 7,
    lineEnd: 7,
    excerpt: "Test requirement excerpt.",
  };
  return {
    id: `test-${kind}`,
    kind,
    title: `Test ${kind}`,
    requirement: "A test requirement.",
    source,
    conditional: false,
    origin: "guideline",
    ...overrides,
  };
}

export function makeContext(overrides: Partial<EvaluationContext> = {}): EvaluationContext {
  return {
    pr: makePr(),
    files: [makeFile("src/api/widgets.ts", 30, 8)],
    commits: [makeCommit(HEAD_SHA, "feat: add pagination\n\nSigned-off-by: Dev User <dev@example.com>")],
    ci: makeCi(),
    repo: makeRepo(),
    guidelines: makeGuidelines("# Contributing\n\nBe kind.\n"),
    ...overrides,
  };
}