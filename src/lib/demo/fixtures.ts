import type {
  ChangedFile,
  CiSummary,
  CommitSummary,
  PullRequestData,
  PullRequestSource,
  RepoContext,
} from "../types";
import type { RecordedModelRun } from "./recorded";

export const DEMO_CONTRIBUTING = `# Contributing to Widget Kit

Thanks for taking the time to contribute. Widget Kit is maintained by a small team, so a little process goes a long way.

## Pull request requirements

- Sign every commit off with \`git commit -s\`; each commit needs a \`Signed-off-by:\` trailer certifying the Developer Certificate of Origin (DCO).
- Reference the issue this pull request addresses in the description, for example \`Fixes #128\`.
- Follow Conventional Commits in the pull request title (\`feat:\`, \`fix:\`, \`docs:\`, \`refactor:\`, \`test:\`, \`chore:\`).
- Add or update tests for any behaviour change.
- Update the documentation in \`docs/\` when a public API changes.
- Add a changelog entry under \`## Unreleased\` in \`CHANGELOG.md\` for user-facing changes.

## Design notes

If your change adds a new public API, describe the design in the pull request description so reviewers can evaluate the trade-offs.

## Review process

Keep pull requests focused: a reviewer must be able to understand the change in one sitting. Split unrelated refactors into separate pull requests.

## Local checks

Run the same checks CI runs before opening a pull request:

\`\`\`bash
bun install
bun run lint
bun run test
bun run typecheck
\`\`\`

Thanks for helping make Widget Kit better.
`;

export const DEMO_TEMPLATE = `## Summary

<!-- Describe the change and why it is needed. -->

## Checklist

- [ ] I have read the contributing guide
- [ ] I have added tests for my changes
- [ ] I have signed off my commits (DCO)
`;

const DEMO_PACKAGE_JSON = JSON.stringify(
  {
    name: "widget-kit",
    version: "3.4.1",
    private: true,
    packageManager: "bun@1.4.4",
    scripts: {
      build: "next build",
      lint: "eslint .",
      test: "bun test",
      typecheck: "tsc --noEmit",
    },
  },
  null,
  2,
);

export interface DemoScenario {
  slug: "failing" | "clean";
  label: string;
  description: string;
  url: string;
  pr: PullRequestData;
  changedFiles: ChangedFile[];
  commits: CommitSummary[];
  ci: CiSummary;
  repoContext: RepoContext;
  repositoryFiles: Record<string, string>;
  recording: RecordedModelRun;
}

const OWNER = "acme";
const REPO = "widget-kit";

function makeFile(
  filename: string,
  additions: number,
  deletions: number,
  status: ChangedFile["status"] = "modified",
  patch?: string,
): ChangedFile {
  return {
    filename,
    status,
    additions,
    deletions,
    changes: additions + deletions,
    ...(patch ? { patch } : {}),
  };
}

const PAGINATION_PATCH = [
  "@@ -0,0 +1,12 @@",
  "+export interface Cursor {",
  "+  readonly next: string | null;",
  "+}",
  "+",
  "+export function encodeCursor(index: number): Cursor {",
  "+  return { next: index >= 0 ? String(index) : null };",
  "+}",
].join("\n");

const WIDGETS_PATCH = [
  "@@ -14,7 +14,9 @@",
  " export async function listWidgets(options: WidgetQuery) {",
  "-  return fetchWidgets({ page: options.page });",
  "+  return fetchWidgets({ cursor: options.cursor });",
  " }",
].join("\n");

const DOCS_PATCH = [
  '@@ -40,7 +40,7 @@',
  "-fetchWidgets({ page: 2 })",
  '+fetchWidgets({ cursor: "eyJwYWdlIjoyfQ" })',
].join("\n");

function makeCommit(sha: string, message: string, author: string, date: string): CommitSummary {
  return { sha, shortSha: sha.slice(0, 7), message, author, date, verified: false };
}

function diffTotals(files: ChangedFile[]): { additions: number; deletions: number; total: number } {
  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
  return { additions, deletions, total: additions + deletions };
}

function repoContext(): RepoContext {
  return {
    files: [
      { path: "CONTRIBUTING.md", size: DEMO_CONTRIBUTING.length },
      { path: "CHANGELOG.md", size: 4_210 },
      { path: "README.md", size: 8_932 },
      { path: "package.json", size: DEMO_PACKAGE_JSON.length },
      { path: "bun.lockb", size: 184_320 },
      { path: "tsconfig.json", size: 612 },
    ],
    packageJson: {
      raw: DEMO_PACKAGE_JSON,
      scripts: { build: "next build", lint: "eslint .", test: "bun test", typecheck: "tsc --noEmit" },
      packageManager: "bun@1.4.4",
    },
    packageManager: "bun",
    hasPyproject: false,
    hasCargo: false,
    hasGoMod: false,
    hasMakefile: false,
  };
}

const FAILING_FILES: ChangedFile[] = [
  makeFile("src/api/pagination.ts", 312, 0, "added", PAGINATION_PATCH),
  makeFile("src/api/widgets.ts", 210, 64, "modified", WIDGETS_PATCH),
  makeFile("src/api/index.ts", 12, 3),
  makeFile("src/http/query.ts", 96, 18),
  makeFile("src/http/cursor.ts", 88, 0, "added"),
  makeFile("src/http/index.ts", 6, 1),
  makeFile("src/types/pagination.ts", 64, 0, "added"),
  makeFile("src/types/widgets.ts", 31, 9),
  makeFile("src/client/fetch-widgets.ts", 84, 22),
  makeFile("src/client/index.ts", 5, 2),
  makeFile("src/client/options.ts", 47, 11),
  makeFile("src/server/routes/widgets.ts", 58, 15),
  makeFile("src/server/routes/index.ts", 4, 1),
  makeFile("src/telemetry/cursor-events.ts", 148, 0, "added"),
  makeFile("src/config/pagination.ts", 39, 6),
];

const CLEAN_FILES: ChangedFile[] = [
  makeFile("docs/api/pagination.md", 18, 6, "modified", DOCS_PATCH),
  makeFile("test/pagination.test.ts", 42, 3, "added"),
  makeFile("CHANGELOG.md", 4, 0),
];

const FAILING_COMMITS: CommitSummary[] = [
  makeCommit(
    "3d2b1a0f9e8d7c6b5a4938278f3c1d9a7b6e5f4c",
    "Add cursor encoding helpers\n\nPure helper functions for opaque cursors.",
    "Sam Rivera",
    "2026-10-18T09:14:00Z",
  ),
  makeCommit(
    "8f3c1d9a7b6e5f4c3d2b1a0f9e8d7c6b5a493827",
    "Wire pagination into widgets endpoint",
    "Sam Rivera",
    "2026-10-24T16:38:00Z",
  ),
];

const CLEAN_COMMITS: CommitSummary[] = [
  makeCommit(
    "c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7",
    "fix(docs): correct pagination example\n\nSigned-off-by: Lena Ortiz <lena@example.com>",
    "Lena Ortiz",
    "2026-10-25T11:02:00Z",
  ),
];

const FAILING_BODY = `Adds cursor pagination to the widgets endpoint. Refs #128.

## Checklist

- [x] I have read the contributing guide
- [ ] I have added tests for my changes
- [ ] I have signed off my commits (DCO)`;

const CLEAN_BODY = `Corrects the pagination example in the API guide. Fixes #201.

## Checklist

- [x] I have read the contributing guide
- [x] I have added tests for my changes
- [x] I have signed off my commits (DCO)`;

function buildPullRequest(
  number: number,
  title: string,
  body: string,
  headRef: string,
  headSha: string,
  baseSha: string,
  files: ChangedFile[],
  commits: CommitSummary[],
  author: string,
  createdAt: string,
  updatedAt: string,
): PullRequestData {
  const totals = diffTotals(files);
  return {
    owner: OWNER,
    repo: REPO,
    number,
    url: `https://github.com/${OWNER}/${REPO}/pull/${number}`,
    title,
    body,
    author,
    authorUrl: `https://github.com/${author}`,
    state: "open",
    draft: false,
    createdAt,
    updatedAt,
    headRef,
    headSha,
    baseRef: "main",
    baseSha,
    labels: number === 42 ? ["enhancement"] : ["documentation"],
    repository: {
      fullName: `${OWNER}/${REPO}`,
      url: `https://github.com/${OWNER}/${REPO}`,
      stars: 1_840,
      language: "TypeScript",
      defaultBranch: "main",
    },
    mergeable: true,
    mergeableState: "clean",
    additions: totals.additions,
    deletions: totals.deletions,
    changedFileCount: files.length,
    commitCount: commits.length,
  };
}

function failingScenario(): DemoScenario {
  const pr = buildPullRequest(
    42,
    "Add cursor pagination",
    FAILING_BODY,
    "pagination-cursor",
    "8f3c1d9a7b6e5f4c3d2b1a0f9e8d7c6b5a493827",
    "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d",
    FAILING_FILES,
    FAILING_COMMITS,
    "sam-dev",
    "2026-10-18T09:12:00Z",
    "2026-10-24T16:40:00Z",
  );
  const totals = diffTotals(FAILING_FILES);

  const recording: RecordedModelRun = {
    model: "recorded:qwen2.5-coder-32b-instruct",
    findings: [
      {
        heading: "Design notes",
        status: "fail",
        rationale:
          "The pull request adds a new public pagination API in src/api/pagination.ts, but the description only says it adds cursor pagination. It does not describe the design or the trade-offs the guideline asks for.",
        confidence: 0.82,
        evidence: [
          {
            kind: "file",
            ref: "src/api/pagination.ts",
            note: "New public API surface added by this pull request.",
          },
          {
            kind: "body",
            ref: "body",
            note: "The description has no design notes, alternatives, or trade-offs.",
          },
        ],
      },
      {
        heading: "Review process",
        status: "fail",
        rationale: `The diff spans ${FAILING_FILES.length} files and ${totals.total} changed lines (+${totals.additions}/-${totals.deletions}), bundling client, server, and telemetry changes. A reviewer cannot assess that in one sitting.`,
        confidence: 0.9,
        evidence: [
          {
            kind: "metadata",
            ref: "changed_files",
            note: `${FAILING_FILES.length} files, +${totals.additions}/-${totals.deletions}, ${totals.total} changed lines`,
          },
        ],
      },
    ],
    notes: [
      "The interpreter receives file paths and metadata only, not the diff, so design feedback is limited to what the description and file list show.",
    ],
  };

  return {
    slug: "failing",
    label: "Failing pull request",
    description: "Missing DCO sign-off, no tests, unchecked template items, failing CI, and a review-size problem.",
    url: pr.url,
    pr,
    changedFiles: FAILING_FILES,
    commits: FAILING_COMMITS,
    ci: {
      available: true,
      state: "failure",
      total: 4,
      successful: 2,
      failing: [
        {
          name: "unit tests (ubuntu-latest)",
          url: `${pr.url}/checks`,
          conclusion: "failure",
        },
      ],
      pending: [
        {
          name: "e2e smoke (ubuntu-latest)",
          url: `${pr.url}/checks`,
          conclusion: "queued",
        },
      ],
      sourceUrl: `${pr.url}/checks`,
    },
    repoContext: repoContext(),
    repositoryFiles: {
      "CONTRIBUTING.md": DEMO_CONTRIBUTING,
      ".github/PULL_REQUEST_TEMPLATE.md": DEMO_TEMPLATE,
      "package.json": DEMO_PACKAGE_JSON,
      "CHANGELOG.md": "# Changelog\n\n## Unreleased\n\n## 3.4.1\n\n- Previous release notes.\n",
    },
    recording,
  };
}

function cleanScenario(): DemoScenario {
  const pr = buildPullRequest(
    43,
    "fix(docs): correct pagination example",
    CLEAN_BODY,
    "fix/pagination-docs",
    "c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7",
    "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d",
    CLEAN_FILES,
    CLEAN_COMMITS,
    "lena-docs",
    "2026-10-25T10:55:00Z",
    "2026-10-25T11:05:00Z",
  );
  const totals = diffTotals(CLEAN_FILES);

  const recording: RecordedModelRun = {
    model: "recorded:qwen2.5-coder-32b-instruct",
    findings: [
      {
        heading: "Review process",
        status: "pass",
        rationale: `The diff is limited to ${CLEAN_FILES.length} files and ${totals.total} changed lines, all serving the documentation fix, which a reviewer can assess in one sitting.`,
        confidence: 0.88,
        evidence: [
          {
            kind: "metadata",
            ref: "changed_files",
            note: `${CLEAN_FILES.length} files, +${totals.additions}/-${totals.deletions}, ${totals.total} changed lines`,
          },
        ],
      },
    ],
    notes: ["The design-notes rule did not apply because this pull request does not add a public API."],
  };

  return {
    slug: "clean",
    label: "Clean pull request",
    description: "Signed-off commit, tested change, checked template, passing CI, and a focused diff.",
    url: pr.url,
    pr,
    changedFiles: CLEAN_FILES,
    commits: CLEAN_COMMITS,
    ci: {
      available: true,
      state: "success",
      total: 4,
      successful: 4,
      failing: [],
      pending: [],
      sourceUrl: `${pr.url}/checks`,
    },
    repoContext: repoContext(),
    repositoryFiles: {
      "CONTRIBUTING.md": DEMO_CONTRIBUTING,
      ".github/PULL_REQUEST_TEMPLATE.md": DEMO_TEMPLATE,
      "package.json": DEMO_PACKAGE_JSON,
      "CHANGELOG.md": "# Changelog\n\n## Unreleased\n\n- Fix the pagination example in the API guide. (#201)\n",
    },
    recording,
  };
}

export const DEMO_SCENARIOS: readonly DemoScenario[] = [failingScenario(), cleanScenario()];

export interface DemoSummary {
  slug: string;
  label: string;
  description: string;
  url: string;
}

export const DEMO_SUMMARIES: readonly DemoSummary[] = DEMO_SCENARIOS.map((scenario) => ({
  slug: scenario.slug,
  label: scenario.label,
  description: scenario.description,
  url: scenario.url,
}));

export function getDemoScenario(ref: { owner: string; repo: string; number: number }): DemoScenario {
  const match = DEMO_SCENARIOS.find(
    (scenario) =>
      scenario.pr.owner.toLowerCase() === ref.owner.toLowerCase() &&
      scenario.pr.repo.toLowerCase() === ref.repo.toLowerCase() &&
      scenario.pr.number === ref.number,
  );
  if (!match) {
    throw new Error(
      `Demo mode has fixtures for ${DEMO_SCENARIOS.map((scenario) => scenario.url).join(" and ")} only.`,
    );
  }
  return match;
}

export function createDemoSource(scenario: DemoScenario): PullRequestSource {
  return {
    async getPullRequest(): Promise<PullRequestData> {
      return scenario.pr;
    },
    async getChangedFiles(): Promise<ChangedFile[]> {
      return scenario.changedFiles;
    },
    async getCommits(): Promise<CommitSummary[]> {
      return scenario.commits;
    },
    async getCi(): Promise<CiSummary> {
      return scenario.ci;
    },
    async getRepoContext(): Promise<RepoContext> {
      return scenario.repoContext;
    },
    async readRepositoryFile(_owner: string, _repo: string, path: string): Promise<string | null> {
      return scenario.repositoryFiles[path] ?? null;
    },
  };
}