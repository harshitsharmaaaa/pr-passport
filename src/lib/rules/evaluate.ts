import type { GuidelinesBundle } from "../guidelines";
import { extractCheckboxes, snippet, stripCodeFences, truncate } from "../markdown";
import type {
  ChangedFile,
  CiSummary,
  CommitSummary,
  Evidence,
  Finding,
  FindingStatus,
  PullRequestData,
  RepoContext,
} from "../types";
import { DEFAULT_TITLE_PREFIXES, type RuleSpec } from "./spec";

export const TEST_PATH_PATTERN =
  /(^|\/)(__tests__|__snapshots__|tests?|specs?)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py|rs)$|^test_.*\.py$/i;

export const DOCS_PATH_PATTERN = /(^|\/)docs?\/|\.mdx?$|(^|\/)README(\.[a-z]+)?$/i;

export const CHANGELOG_PATH_PATTERN =
  /(^|\/)CHANGELOG(\.[a-z]+)?$|(^|\/)\.changeset\/|(^|\/)changes\//i;

const CONFIG_PATH_PATTERN =
  /(^|\/)\.|(^|\/)(package(-lock)?\.json|bun\.lockb?|pnpm-lock\.yaml|yarn\.lock|tsconfig[^/]*\.json|[^/]+\.(json|ya?ml|toml|lock|ini|cfg))$/i;

export function isTestFile(path: string): boolean {
  return TEST_PATH_PATTERN.test(path);
}

export function isDocsFile(path: string): boolean {
  return DOCS_PATH_PATTERN.test(path);
}

export function isChangelogFile(path: string): boolean {
  return CHANGELOG_PATH_PATTERN.test(path);
}

export function isSourceFile(path: string): boolean {
  return !isTestFile(path) && !isDocsFile(path) && !isChangelogFile(path) && !CONFIG_PATH_PATTERN.test(path);
}

export interface EvaluationContext {
  pr: PullRequestData;
  files: ChangedFile[];
  commits: CommitSummary[];
  ci: CiSummary;
  repo: RepoContext;
  guidelines: GuidelinesBundle;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function fileEvidence(file: ChangedFile, note = ""): Evidence {
  const status = file.status === "modified" ? "modified" : file.status;
  const detail = `${status}, +${file.additions}/−${file.deletions}${note ? ` — ${note}` : ""}`;
  return { kind: "file", label: file.filename, detail, path: file.filename };
}

function commitEvidence(commit: CommitSummary, note: string, prUrl: string): Evidence {
  const firstLine = commit.message.split("\n")[0] ?? "";
  return {
    kind: "commit",
    label: `Commit ${commit.shortSha}`,
    detail: `${truncate(firstLine, 120)} — ${note}`,
    url: `${prUrl}/commits/${commit.sha}`,
  };
}

function metadataEvidence(label: string, detail: string): Evidence {
  return { kind: "metadata", label, detail };
}

function bodyEvidence(body: string, detail: string, line?: number): Evidence {
  return { kind: "body", label: "Pull request description", detail, lineStart: line };
}

function finalize(
  spec: RuleSpec,
  status: FindingStatus,
  evidence: Evidence[],
  rationale: string,
  remediation?: string,
): Finding {
  const softened = status === "fail" && spec.conditional;
  return {
    id: spec.id,
    title: spec.title,
    requirement: spec.requirement,
    status: softened ? "needs_review" : status,
    origin: "deterministic",
    source: spec.source,
    evidence: evidence.slice(0, 6),
    rationale: softened
      ? `${rationale} The guideline is conditional, so this is surfaced for human review rather than treated as a hard failure.`
      : rationale,
    remediation,
  };
}

function hasSignoff(message: string): boolean {
  return /^signed-off-by:\s+\S[^\n]*<[^<>\s]+@[^<>\s]+>\s*$/im.test(message);
}

const ISSUE_REFERENCE_PATTERNS: RegExp[] = [
  /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|refs?|references?|relates? to|related to)\b\s*:?\s*(?:[\w.-]+\/[\w.-]+)?#\d+/i,
  /\b(?:issue|ticket)\s*(?:#|number)?\s*\d+/i,
  /^\s*#\d+\s*$/m,
  /github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+/i,
];

function checkSignedOffBy(spec: RuleSpec, ctx: EvaluationContext): Finding {
  if (ctx.commits.length === 0) {
    return finalize(
      spec,
      "needs_review",
      [metadataEvidence("Commits returned by GitHub", "0 commits")],
      "GitHub returned no commits for this pull request, so the sign-off requirement could not be verified.",
      "Check that the pull request exposes its commits, then re-run the analysis.",
    );
  }

  const unsigned = ctx.commits.filter((commit) => !hasSignoff(commit.message));
  const total = ctx.commits.length;

  if (unsigned.length === 0) {
    return finalize(
      spec,
      "pass",
      ctx.commits.slice(0, 3).map((commit) => commitEvidence(commit, "Signed-off-by trailer present", ctx.pr.url)),
      `All ${total} commit(s) include a Signed-off-by trailer with a name and email address.`,
    );
  }

  return finalize(
    spec,
    "fail",
    unsigned.slice(0, 6).map((commit) => commitEvidence(commit, "No Signed-off-by trailer", ctx.pr.url)),
    `${unsigned.length} of ${total} commit(s) have no Signed-off-by trailer certifying the Developer Certificate of Origin.`,
    "Add `Signed-off-by: Your Name <you@example.com>` to every unsigned commit using `git commit --signoff` (or `git rebase --signoff <base>`), then update the branch. PR Passport does not push or rewrite commits for you.",
  );
}

function checkLinkedIssue(spec: RuleSpec, ctx: EvaluationContext): Finding {
  const body = stripCodeFences(ctx.pr.body);
  const title = ctx.pr.title;

  const bodyMatch = ISSUE_REFERENCE_PATTERNS.map((pattern) => pattern.exec(body)).find(Boolean);
  if (bodyMatch?.index !== undefined) {
    const ref = snippet(body, bodyMatch.index, 90);
    return finalize(
      spec,
      "pass",
      [bodyEvidence(body, `Reference found: ${ref}`)],
      "The pull request description references an issue using a recognised form (closing keyword, issue number, or issue URL).",
    );
  }

  if (ISSUE_REFERENCE_PATTERNS.some((pattern) => pattern.test(title))) {
    return finalize(
      spec,
      "pass",
      [{ kind: "title", label: "Pull request title", detail: truncate(title, 160) }],
      "The pull request title references an issue number.",
    );
  }

  return finalize(
    spec,
    "fail",
    [
      bodyEvidence(
        body,
        body.trim().length === 0
          ? "The pull request description is empty, so no issue can be referenced."
          : `No issue reference found in ${body.trim().length} characters of description.`,
      ),
      { kind: "title", label: "Pull request title", detail: truncate(title, 160) },
    ],
    "Neither the title nor the description contains an issue reference such as `Fixes #123` or an issue URL.",
    "Reference the issue this pull request addresses in the description, for example `Fixes #123`. If there is no issue yet, ask a maintainer whether one is required.",
  );
}

function checkConventionalTitle(spec: RuleSpec, ctx: EvaluationContext): Finding {
  const prefixes =
    spec.params?.allowedPrefixes && spec.params.allowedPrefixes.length > 0
      ? spec.params.allowedPrefixes
      : [...DEFAULT_TITLE_PREFIXES];
  const pattern = new RegExp(
    `^(?:${prefixes.map(escapeRegExp).join("|")})(?:\\([^()\\n]{1,40}\\))?!?:\\s+\\S`,
    "i",
  );
  const title = ctx.pr.title;
  const allowed = prefixes.map((prefix) => `${prefix}:`).join(", ");

  if (pattern.test(title)) {
    return finalize(
      spec,
      "pass",
      [{ kind: "title", label: "Pull request title", detail: truncate(title, 160) }],
      `The title starts with a recognised type prefix from the set: ${allowed}.`,
    );
  }

  return finalize(
    spec,
    "fail",
    [{ kind: "title", label: "Pull request title", detail: truncate(title, 160) }],
    `The title does not start with a type prefix followed by a colon. Expected one of: ${allowed}.`,
    `Rename the pull request to use one of: ${allowed}. Prefix the title only; the model must not rewrite history on your behalf.`,
  );
}

function checkChangelog(spec: RuleSpec, ctx: EvaluationContext): Finding {
  if (ctx.files.length === 0) {
    return finalize(
      spec,
      "needs_review",
      [metadataEvidence("Changed files", "GitHub returned no changed-file data.")],
      "Changed files could not be listed, so this requirement could not be checked.",
      "Re-run the analysis once GitHub exposes the changed files.",
    );
  }

  const changelogFiles = ctx.files.filter((file) => isChangelogFile(file.filename));
  if (changelogFiles.length > 0) {
    return finalize(
      spec,
      "pass",
      changelogFiles.slice(0, 3).map((file) => fileEvidence(file, "changelog entry")),
      "The pull request changes a changelog or changeset file.",
    );
  }

  return finalize(
    spec,
    "fail",
    ctx.files.slice(0, 5).map((file) => fileEvidence(file, "not a changelog")),
    `None of the ${ctx.files.length} changed files is a changelog or changeset entry.`,
    "Add an entry to the changelog or changeset file named by the guideline, then push the update. Confirm with a maintainer whether the change is user-facing.",
  );
}

function checkTests(spec: RuleSpec, ctx: EvaluationContext): Finding {
  const testFiles = ctx.files.filter((file) => isTestFile(file.filename));
  const sourceFiles = ctx.files.filter((file) => isSourceFile(file.filename));

  if (testFiles.length > 0) {
    return finalize(
      spec,
      "pass",
      testFiles.slice(0, 4).map((file) => fileEvidence(file, "test file")),
      `${testFiles.length} test file(s) are included in the pull request.`,
    );
  }

  if (sourceFiles.length === 0) {
    return finalize(
      spec,
      "needs_review",
      ctx.files.slice(0, 4).map((file) => fileEvidence(file, "changed")),
      "No non-configuration source files changed, so the \"behaviour change\" condition could not be established from file paths.",
      "A reviewer should confirm whether this change needs tests.",
    );
  }

  return finalize(
    spec,
    "fail",
    sourceFiles.slice(0, 5).map((file) => fileEvidence(file, "source file without a matching test change")),
    `${sourceFiles.length} source file(s) changed and none of the ${ctx.files.length} changed files matches a test path pattern (for example *.test.ts, tests/, or *_test.go).`,
    "Add or update tests that exercise the changed behaviour, then run the validation commands below. File paths are heuristics: if this change genuinely needs no tests, say why in the pull request.",
  );
}

function checkDocs(spec: RuleSpec, ctx: EvaluationContext): Finding {
  if (ctx.files.length === 0) {
    return finalize(
      spec,
      "needs_review",
      [metadataEvidence("Changed files", "GitHub returned no changed-file data.")],
      "Changed files could not be listed, so this requirement could not be checked.",
      "Re-run the analysis once GitHub exposes the changed files.",
    );
  }

  const docFiles = ctx.files.filter((file) => isDocsFile(file.filename));
  if (docFiles.length > 0) {
    return finalize(
      spec,
      "pass",
      docFiles.slice(0, 4).map((file) => fileEvidence(file, "documentation")),
      `${docFiles.length} documentation file(s) are included in the pull request.`,
    );
  }

  return finalize(
    spec,
    "fail",
    ctx.files.slice(0, 5).map((file) => fileEvidence(file, "changed")),
    `None of the ${ctx.files.length} changed files is under docs/ or ends in .md, .mdx or README.`,
    "Update the documentation named by the guideline, then push the change. If the change is not public-facing, note that for the reviewer.",
  );
}

function checkTemplateChecklist(spec: RuleSpec, ctx: EvaluationContext): Finding {
  const items = extractCheckboxes(ctx.pr.body);
  if (items.length === 0) {
    return finalize(
      spec,
      "needs_review",
      [bodyEvidence(ctx.pr.body, "No Markdown checkboxes found in the pull request description.")],
      "The repository has a pull request template with a checklist, but the description does not reproduce any checklist items, so completion cannot be verified.",
      "Paste the template checklist into the description and tick the items that are true.",
    );
  }

  const unchecked = items.filter((item) => !item.checked);
  if (unchecked.length === 0) {
    return finalize(
      spec,
      "pass",
      [bodyEvidence(ctx.pr.body, `All ${items.length} checklist items are checked.`)],
      `All ${items.length} checklist items in the description are checked.`,
    );
  }

  return finalize(
    spec,
    "fail",
    unchecked.slice(0, 5).map((item) => bodyEvidence(ctx.pr.body, `Unchecked: ${item.text}`, item.line)),
    `${unchecked.length} of ${items.length} checklist items in the description are unchecked.`,
    "Complete the outstanding checklist items and tick them, or explain why an item does not apply. Do not tick items that are not true.",
  );
}

function checkDescription(spec: RuleSpec, ctx: EvaluationContext): Finding {
  const body = ctx.pr.body.trim();
  if (body.length >= 20) {
    return finalize(
      spec,
      "pass",
      [bodyEvidence(body, truncate(body, 180))],
      `The description is ${body.length} characters long and is filled in.`,
    );
  }

  return finalize(
    spec,
    "fail",
    [bodyEvidence(body, `The description is ${body.length} characters long.`)],
    "The pull request description is empty or effectively empty, so the template prompts were not answered.",
    "Fill in the pull request description using the repository template. Explain what changed and why.",
  );
}

function checkBranchNaming(spec: RuleSpec, ctx: EvaluationContext): Finding {
  const prefix = spec.params?.branchPrefix;
  if (!prefix) {
    return finalize(
      spec,
      "needs_review",
      [
        metadataEvidence(
          "Branch",
          `${ctx.pr.headRef} → ${ctx.pr.baseRef}`,
        ),
      ],
      "The guideline asks for a branch naming convention but does not state a machine-checkable prefix, so the branch name was not judged.",
      "A reviewer should confirm the branch name against the guideline.",
    );
  }

  if (ctx.pr.headRef.toLowerCase().startsWith(prefix.toLowerCase())) {
    return finalize(
      spec,
      "pass",
      [metadataEvidence("Head branch", ctx.pr.headRef)],
      `The head branch "${ctx.pr.headRef}" starts with the documented prefix "${prefix}".`,
    );
  }

  return finalize(
    spec,
    "fail",
    [metadataEvidence("Head branch", `${ctx.pr.headRef} → ${ctx.pr.baseRef}`)],
    `The head branch "${ctx.pr.headRef}" does not start with the documented prefix "${prefix}".`,
    `Rename the branch to start with \`${prefix}\` and reopen the pull request if needed. This changes the PR URL and may require a new pull request.`,
  );
}

function checkSizeLimit(spec: RuleSpec, ctx: EvaluationContext): Finding {
  const max = spec.params?.maxChanges;
  const changes = ctx.pr.additions + ctx.pr.deletions;
  if (!max) {
    return finalize(
      spec,
      "needs_review",
      [metadataEvidence("Diff size", `${changes} changed lines`)],
      "The guideline mentions a size limit but no numeric limit could be extracted from the matched sentence.",
      "A reviewer should apply the size guidance manually.",
    );
  }

  if (changes <= max) {
    return finalize(
      spec,
      "pass",
      [metadataEvidence("Diff size", `${changes} changed lines (+${ctx.pr.additions}/−${ctx.pr.deletions}); limit ${max}`)],
      `${changes} changed lines is within the documented limit of ${max}.`,
    );
  }

  return finalize(
    spec,
    "fail",
    [
      metadataEvidence(
        "Diff size",
        `${changes} changed lines (+${ctx.pr.additions}/−${ctx.pr.deletions}); limit ${max}`,
      ),
    ],
    `${changes} changed lines exceeds the documented limit of ${max}.`,
    "Split the change into smaller pull requests that each address one concern, keeping this pull request within the documented limit.",
  );
}

function skippedCheckCount(ci: EvaluationContext["ci"]): number {
  return (ci.passing ?? []).filter(
    (check) => check.conclusion === "skipped" || check.conclusion === "neutral",
  ).length;
}

function checkCi(spec: RuleSpec, ctx: EvaluationContext): Finding {
  const ci = ctx.ci;
  if (!ci.available) {
    return finalize(
      spec,
      "needs_review",
      [metadataEvidence("CI", ci.reason ?? "CI data was not available.")],
      `CI status could not be read${ci.reason ? `: ${ci.reason}` : "."} No pass or fail is claimed.`,
      "Check CI directly on the pull request. PR Passport does not infer CI results.",
    );
  }

  if (ci.state === "success") {
    // `successful` also counts checks GitHub skipped or reported as neutral.
    // They are not failures, but they are not passes either — say so.
    const skipped = skippedCheckCount(ci);
    const passed = Math.max(0, ci.successful - skipped);
    return finalize(
      spec,
      "pass",
      [
        metadataEvidence(
          "CI",
          `${passed} of ${ci.total} reported checks passed${skipped > 0 ? `; ${skipped} skipped or neutral` : ""}.`,
        ),
      ],
      skipped > 0
        ? `No reported check failed. ${passed} passed and ${skipped} skipped or neutral.`
        : `All ${ci.total} reported checks for the head commit passed.`,
    );
  }

  if (ci.state === "failure") {
    const skipped = skippedCheckCount(ci);
    return finalize(
      spec,
      "fail",
      ci.failing.slice(0, 5).map((check) => ({
        kind: "ci" as const,
        label: `Check: ${check.name}`,
        detail: `conclusion: ${check.conclusion ?? "failure"}`,
        url: check.url,
      })),
      `${ci.failing.length} of ${ci.total} reported checks failed${skipped > 0 ? `; ${skipped} skipped or neutral` : ""}.`,
      "Fix the failing checks and push the fix. PR Passport does not run or re-run CI.",
    );
  }

  if (ci.state === "pending") {
    return finalize(
      spec,
      "needs_review",
      ci.pending.slice(0, 5).map((check) => ({
        kind: "ci" as const,
        label: `Check: ${check.name}`,
        detail: "still running or queued",
        url: check.url,
      })),
      `${ci.pending.length} of ${ci.total} reported checks have not finished, so the final result is unknown.`,
      "Wait for CI to finish, then re-run the analysis.",
    );
  }

  return finalize(
    spec,
    "needs_review",
    [metadataEvidence("CI", `state: ${ci.state}, reported checks: ${ci.total}`)],
    "No conclusive CI result was reported for the head commit.",
    "Check CI directly on the pull request.",
  );
}

function checkMergeConflicts(spec: RuleSpec, ctx: EvaluationContext): Finding {
  const evidence = [
    metadataEvidence(
      "Mergeability",
      `mergeable=${String(ctx.pr.mergeable)}, mergeable_state=${ctx.pr.mergeableState || "unknown"}`,
    ),
  ];

  if (ctx.pr.mergeable === true) {
    return finalize(spec, "pass", evidence, "GitHub reports the pull request as mergeable with its base branch.");
  }

  if (ctx.pr.mergeable === false) {
    return finalize(
      spec,
      "fail",
      evidence,
      `GitHub reports the pull request as not mergeable (state: ${ctx.pr.mergeableState || "unknown"}).`,
      "Rebase or merge the base branch into your branch and resolve conflicts, then push the result.",
    );
  }

  return finalize(
    spec,
    "needs_review",
    evidence,
    "GitHub had not finished computing mergeability when this report was generated, so conflicts could not be ruled out.",
    "Re-run the analysis in a moment, or check the pull request page for conflicts.",
  );
}

const EVALUATORS: Record<RuleSpec["kind"], (spec: RuleSpec, ctx: EvaluationContext) => Finding> = {
  signed_off_by: checkSignedOffBy,
  linked_issue: checkLinkedIssue,
  conventional_title: checkConventionalTitle,
  changelog_updated: checkChangelog,
  tests_added: checkTests,
  docs_updated: checkDocs,
  template_checklist: checkTemplateChecklist,
  pr_description: checkDescription,
  branch_naming: checkBranchNaming,
  pr_size_limit: checkSizeLimit,
  ci_green: checkCi,
  merge_conflicts: checkMergeConflicts,
  freeform: () => {
    throw new Error("Free-form rules are interpreted by the model, not evaluated deterministically.");
  },
};

export function evaluateRule(spec: RuleSpec, ctx: EvaluationContext): Finding {
  if (spec.kind === "freeform") {
    throw new Error("Free-form rules must not be passed to the deterministic evaluator.");
  }
  return EVALUATORS[spec.kind](spec, ctx);
}

export function evaluateRules(specs: RuleSpec[], ctx: EvaluationContext): Finding[] {
  return specs.filter((spec) => spec.kind !== "freeform").map((spec) => evaluateRule(spec, ctx));
}