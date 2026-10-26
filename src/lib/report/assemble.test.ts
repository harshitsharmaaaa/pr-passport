import { describe, expect, it } from "bun:test";
import { assembleReport, type ReportInput } from "./assemble";
import { buildRemediationPrompt } from "./remediation";
import { makeCi, makeGuidelines, makePr } from "../test-support";
import type { Finding, FindingStatus, ModelMeta, PendingRule, ValidationCommand } from "../types";

function finding(status: FindingStatus, overrides: Partial<Finding> = {}): Finding {
  return {
    id: `rule-${status}`,
    title: "Tests for behaviour changes",
    requirement: "Add or update tests for any behaviour change.",
    status,
    origin: "deterministic",
    source: {
      kind: "repository_file",
      label: "CONTRIBUTING.md § Pull request requirements",
      path: "CONTRIBUTING.md",
      url: "https://github.com/acme/widget-kit/blob/main/CONTRIBUTING.md",
      lineStart: 10,
      lineEnd: 10,
      excerpt: "Add or update tests for any behaviour change.",
    },
    evidence: [
      { kind: "file", label: "src/api/widgets.ts", detail: "source file, +30/−8", path: "src/api/widgets.ts" },
    ],
    rationale: "A source file changed without a matching test file.",
    remediation: "Add a test that covers the changed behaviour.",
    ...overrides,
  };
}

const MODEL: ModelMeta = {
  requested: true,
  used: true,
  mode: "live",
  model: "qwen-test",
  rejectedFindings: 0,
  notes: [],
};

const COMMANDS: ValidationCommand[] = [
  {
    command: "bun run test",
    reason: 'Defined as the "test" script in package.json.',
    source: { kind: "github_api", label: "package.json scripts", path: "package.json" },
  },
];

const GUIDELINES = makeGuidelines(
  "# Contributing\n\n## Pull request requirements\n\n- Add or update tests for any behaviour change.\n",
);

function assemble(overrides: Partial<ReportInput> = {}): ReturnType<typeof assembleReport> {
  return assembleReport({
    mode: "live",
    pr: makePr(),
    ci: makeCi(),
    guidelines: GUIDELINES,
    findings: [finding("fail")],
    pendingRules: [],
    model: MODEL,
    limitations: [],
    validationCommands: COMMANDS,
    generatedAt: new Date("2026-10-26T10:00:00Z"),
    totalMs: 42,
    ...overrides,
  });
}

describe("assembleReport", () => {
  it("returns FAIL when any requirement fails", () => {
    const report = assemble({ findings: [finding("fail"), finding("needs_review"), finding("pass")] });
    expect(report.summary).toMatchObject({ fail: 1, needsReview: 1, pass: 1, verdict: "fail" });
    expect(report.summary.headline).toContain("1 requirement failed");
  });

  it("returns NEEDS HUMAN REVIEW when nothing fails but review is required", () => {
    const report = assemble({ findings: [finding("needs_review"), finding("pass")] });
    expect(report.summary.verdict).toBe("needs_review");
    expect(report.summary.headline).toContain("need a human decision");
  });

  it("returns PASS when every finding passes", () => {
    const report = assemble({ findings: [finding("pass"), finding("pass")] });
    expect(report.summary.verdict).toBe("pass");
    expect(report.summary.headline).toBe("All 2 evaluated requirements passed.");
  });

  it("returns NEEDS HUMAN REVIEW when nothing could be evaluated", () => {
    const report = assemble({ findings: [] });
    expect(report.summary.verdict).toBe("needs_review");
    expect(report.summary.headline).toContain("No requirements could be evaluated");
  });

  it("sorts findings by severity", () => {
    const report = assemble({
      findings: [finding("pass", { id: "p" }), finding("needs_review", { id: "r" }), finding("fail", { id: "f" })],
    });
    expect(report.findings.map((item) => item.id)).toEqual(["f", "r", "p"]);
  });

  it("copies checks, guidelines, and model metadata into the report", () => {
    const report = assemble();
    expect(report.checks.changedFiles).toBe(1);
    expect(report.checks.mergeable).toBe(true);
    expect(report.guidelines.files[0]?.path).toBe("CONTRIBUTING.md");
    expect(report.model.model).toBe("qwen-test");
    expect(report.generatedAt).toBe("2026-10-26T10:00:00.000Z");
    expect(report.timings.totalMs).toBe(42);
  });

  it("deduplicates limitations and model notes", () => {
    const report = assemble({
      limitations: ["A gap.", "A gap.", "Another gap."],
      model: { ...MODEL, notes: ["note", "note"] },
    });
    expect(report.limitations).toEqual(["A gap.", "Another gap."]);
    expect(report.model.notes).toEqual(["note"]);
  });
});

describe("remediation brief content", () => {
  it("lists failed requirements with source, evidence, and action", () => {
    const report = assemble();
    const prompt = report.remediationPrompt;

    expect(prompt).toContain("## Failed requirements");
    expect(prompt).toContain("### 1. Tests for behaviour changes");
    expect(prompt).toContain("`CONTRIBUTING.md:10`");
    expect(prompt).toContain("Add or update tests for any behaviour change.");
    expect(prompt).toContain("src/api/widgets.ts");
    expect(prompt).toContain("A source file changed without a matching test file.");
    expect(prompt).toContain("Add a test that covers the changed behaviour.");
    expect(prompt).toContain("- [ ] Fix: Tests for behaviour changes");
  });

  it("includes validation commands and their sources", () => {
    const prompt = assemble().remediationPrompt;
    expect(prompt).toContain("```sh\nbun run test\n```");
    expect(prompt).toContain("package.json scripts");
  });

  it("handles an all-clear report without inventing work", () => {
    const report = assemble({ findings: [finding("pass")] });
    expect(report.summary.verdict).toBe("pass");
    expect(report.remediationPrompt).toContain("None. Do not invent work to fill this section.");
    expect(report.remediationPrompt).toContain("No failed or unresolved requirements were detected");
  });

  it("names requirements that were not evaluated", () => {
    const pending: PendingRule = {
      id: "freeform-contributing-md-18",
      title: "Review process",
      requirement: "Keep pull requests focused.",
      source: {
        kind: "repository_file",
        label: "CONTRIBUTING.md § Review process",
        path: "CONTRIBUTING.md",
        lineStart: 18,
      },
      reason: "No inference endpoint is configured.",
    };
    const prompt = assemble({ pendingRules: [pending] }).remediationPrompt;
    expect(prompt).toContain("## Not evaluated");
    expect(prompt).toContain("Review process");
    expect(prompt).toContain("CONTRIBUTING.md:18");
    expect(prompt).toContain("No inference endpoint is configured.");
  });

  it("states when no validation commands could be derived", () => {
    const prompt = assemble({ validationCommands: [] }).remediationPrompt;
    expect(prompt).toContain("No validation commands could be derived");
    expect(prompt).toContain("Do not invent a test command.");
  });

  it("never emits undefined or credentials", () => {
    const report = assemble({ model: { ...MODEL, error: "HTTP 401" } });
    expect(report.remediationPrompt).not.toContain("undefined");
    expect(report.remediationPrompt).not.toContain("Bearer ");
    expect(report.remediationPrompt).not.toContain("API_KEY");
  });
});

describe("buildRemediationPrompt", () => {
  it("rejects nothing and keeps diff facts from the report", () => {
    const prompt = buildRemediationPrompt({
      pr: makePr({ title: "feat: cursor", headRef: "feat/cursor", baseRef: "main" }),
      repository: makePr().repository,
      mode: "demo",
      findings: [finding("fail")],
      pendingRules: [],
      limitations: ["Demo mode: fixtures."],
      validationCommands: COMMANDS,
      diff: { changedFiles: 3, additions: 40, deletions: 10, commits: 2 },
    });
    expect(prompt).toContain("Demo mode: fixtures.");
    expect(prompt).toContain("3 files, +40/−10, 2 commit(s)");
    expect(prompt).toContain("demo (bundled fixtures)");
    expect(prompt).toContain("must not merge it either");
  });
});