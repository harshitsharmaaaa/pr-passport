import { describe, expect, it } from "bun:test";
import {
  evaluateRule,
  evaluateRules,
  isChangelogFile,
  isDocsFile,
  isSourceFile,
  isTestFile,
  type EvaluationContext,
} from "./evaluate";
import type { RuleSpec } from "./spec";
import {
  HEAD_SHA,
  makeCi,
  makeCommit,
  makeContext,
  makeFile,
  makePr,
  makeSpec,
} from "../test-support";

function run(spec: RuleSpec, ctx: EvaluationContext = makeContext()) {
  return evaluateRule(spec, ctx);
}

describe("signed-off-by", () => {
  it("passes when every commit carries a name and email", () => {
    const finding = run(makeSpec("signed_off_by"));
    expect(finding.status).toBe("pass");
    expect(finding.evidence[0]?.kind).toBe("commit");
    expect(finding.origin).toBe("deterministic");
  });

  it("fails when a commit has no sign-off", () => {
    const ctx = makeContext({ commits: [makeCommit(HEAD_SHA, "feat: thing")] });
    const finding = run(makeSpec("signed_off_by"), ctx);
    expect(finding.status).toBe("fail");
    expect(finding.rationale).toContain("1 of 1");
    expect(finding.remediation).toContain("Signed-off-by");
  });

  it("requires an email address in the trailer", () => {
    const ctx = makeContext({ commits: [makeCommit(HEAD_SHA, "feat: x\n\nSigned-off-by: Somebody")] });
    expect(run(makeSpec("signed_off_by"), ctx).status).toBe("fail");
  });

  it("asks for review when GitHub returns no commits", () => {
    const ctx = makeContext({ commits: [] });
    const finding = run(makeSpec("signed_off_by"), ctx);
    expect(finding.status).toBe("needs_review");
    expect(finding.rationale).toContain("no commits");
  });

  it("caps evidence at six items", () => {
    const commits = Array.from({ length: 10 }, (_, index) =>
      makeCommit(String(index).padStart(40, "0"), `feat: change ${index}`),
    );
    const finding = run(makeSpec("signed_off_by"), makeContext({ commits }));
    expect(finding.evidence).toHaveLength(6);
  });
});

describe("linked issue", () => {
  it("passes on a closing keyword", () => {
    expect(run(makeSpec("linked_issue")).status).toBe("pass");
  });

  it("passes on an issue URL", () => {
    const ctx = makeContext({
      pr: makePr({ body: "See https://github.com/acme/widget-kit/issues/31 for context." }),
    });
    expect(run(makeSpec("linked_issue"), ctx).status).toBe("pass");
  });

  it("fails when neither title nor body references an issue", () => {
    const ctx = makeContext({ pr: makePr({ title: "feat: cursor", body: "Adds pagination." }) });
    const finding = run(makeSpec("linked_issue"), ctx);
    expect(finding.status).toBe("fail");
    expect(finding.remediation).toContain("Fixes #");
  });

  it("ignores issue references inside fenced code", () => {
    const ctx = makeContext({ pr: makePr({ title: "feat: docs", body: "```\nFixes #12\n```" }) });
    expect(run(makeSpec("linked_issue"), ctx).status).toBe("fail");
  });
});

describe("conventional title", () => {
  it("passes standard prefixes with scopes and breaking markers", () => {
    expect(run(makeSpec("conventional_title")).status).toBe("pass");
    const breaking = makeContext({ pr: makePr({ title: "feat(api)!: drop v1" }) });
    expect(run(makeSpec("conventional_title"), breaking).status).toBe("pass");
  });

  it("fails a title without a type prefix", () => {
    const ctx = makeContext({ pr: makePr({ title: "Add cursor pagination" }) });
    const finding = run(makeSpec("conventional_title"), ctx);
    expect(finding.status).toBe("fail");
    expect(finding.rationale).toContain("feat:");
  });

  it("uses repository-specific prefixes when provided", () => {
    const spec = makeSpec("conventional_title", {
      params: { allowedPrefixes: ["docs", "feat"] },
    });
    const fix = makeContext({ pr: makePr({ title: "fix: something" }) });
    expect(run(spec, fix).status).toBe("fail");
  });
});

describe("changelog and documentation", () => {
  it("passes when a changelog file changed", () => {
    const ctx = makeContext({ files: [makeFile("CHANGELOG.md", 4, 0)] });
    expect(run(makeSpec("changelog_updated"), ctx).status).toBe("pass");
  });

  it("fails when no changelog file changed", () => {
    expect(run(makeSpec("changelog_updated")).status).toBe("fail");
  });

  it("softens a conditional changelog rule to human review", () => {
    const finding = run(makeSpec("changelog_updated", { conditional: true }));
    expect(finding.status).toBe("needs_review");
    expect(finding.rationale).toContain("conditional");
  });

  it("asks for review when file data is unavailable", () => {
    const ctx = makeContext({ files: [] });
    const finding = run(makeSpec("changelog_updated"), ctx);
    expect(finding.status).toBe("needs_review");
    expect(finding.rationale).toContain("could not be listed");
  });

  it("passes documentation changes", () => {
    const ctx = makeContext({ files: [makeFile("docs/api.md", 8, 2)] });
    expect(run(makeSpec("docs_updated"), ctx).status).toBe("pass");
  });

  it("fails documentation rules only when unconditional", () => {
    expect(run(makeSpec("docs_updated")).status).toBe("fail");
    expect(run(makeSpec("docs_updated", { conditional: true })).status).toBe("needs_review");
  });
});

describe("tests", () => {
  it("passes when a test file changed", () => {
    const ctx = makeContext({ files: [makeFile("src/api.test.ts", 40, 0, "added")] });
    expect(run(makeSpec("tests_added"), ctx).status).toBe("pass");
  });

  it("fails when source changed without tests", () => {
    const finding = run(makeSpec("tests_added"));
    expect(finding.status).toBe("fail");
    expect(finding.rationale).toContain("source file");
  });

  it("asks for review when only docs changed", () => {
    const ctx = makeContext({ files: [makeFile("docs/guide.md", 5, 1)] });
    expect(run(makeSpec("tests_added"), ctx).status).toBe("needs_review");
  });

  it("asks for review when only configuration changed", () => {
    const ctx = makeContext({ files: [makeFile("package.json", 2, 1)] });
    expect(run(makeSpec("tests_added"), ctx).status).toBe("needs_review");
  });
});

describe("template checklist", () => {
  it("passes when every item is checked", () => {
    const body = "- [x] Read the guide\n- [x] Added tests";
    const ctx = makeContext({ pr: makePr({ body }) });
    expect(run(makeSpec("template_checklist"), ctx).status).toBe("pass");
  });

  it("fails and points at the unchecked line", () => {
    const body = "- [x] Read the guide\n- [ ] Added tests";
    const ctx = makeContext({ pr: makePr({ body }) });
    const finding = run(makeSpec("template_checklist"), ctx);
    expect(finding.status).toBe("fail");
    expect(finding.evidence[0]?.lineStart).toBe(2);
    expect(finding.evidence[0]?.detail).toContain("Added tests");
  });

  it("asks for review when the template was not reproduced", () => {
    const ctx = makeContext({ pr: makePr({ body: "Short description." }) });
    expect(run(makeSpec("template_checklist"), ctx).status).toBe("needs_review");
  });
});

describe("description, branch, and size", () => {
  it("passes and fails the description rule on length", () => {
    expect(run(makeSpec("pr_description")).status).toBe("pass");
    const empty = makeContext({ pr: makePr({ body: "   " }) });
    expect(run(makeSpec("pr_description"), empty).status).toBe("fail");
  });

  it("checks a documented branch prefix", () => {
    const spec = makeSpec("branch_naming", { params: { branchPrefix: "feat/" } });
    expect(run(spec).status).toBe("pass");
    const wrong = makeContext({ pr: makePr({ headRef: "fix/cursor" }) });
    expect(run(spec, wrong).status).toBe("fail");
  });

  it("asks for review when no branch prefix is documented", () => {
    expect(run(makeSpec("branch_naming")).status).toBe("needs_review");
  });

  it("enforces a numeric size limit", () => {
    const spec = makeSpec("pr_size_limit", { params: { maxChanges: 100 } });
    expect(run(spec).status).toBe("pass");
    const big = makeContext({ pr: makePr({ additions: 900, deletions: 100 }) });
    expect(run(spec, big).status).toBe("fail");
    expect(run(makeSpec("pr_size_limit")).status).toBe("needs_review");
  });
});

describe("CI", () => {
  it("passes when every reported check passed", () => {
    expect(run(makeSpec("ci_green")).status).toBe("pass");
  });

  it("does not call skipped or neutral checks passes", () => {
    const ci = makeCi({
      state: "success",
      total: 4,
      successful: 4,
      passing: [
        { name: "unit", conclusion: "success" },
        { name: "docs", conclusion: "success" },
        { name: "e2e", conclusion: "skipped" },
        { name: "preview", conclusion: "neutral" },
      ],
    });
    const finding = run(makeSpec("ci_green"), makeContext({ ci }));
    expect(finding.status).toBe("pass");
    expect(finding.evidence[0]?.detail).toContain("2 of 4 reported checks passed");
    expect(finding.evidence[0]?.detail).toContain("2 skipped or neutral");
    expect(finding.rationale).toContain("No reported check failed");
    expect(finding.rationale).not.toContain("All 4");
  });

  it("fails and names failing checks", () => {
    const ci = makeCi({
      state: "failure",
      total: 2,
      successful: 1,
      failing: [{ name: "unit tests", conclusion: "failure", url: "https://example.com/check" }],
    });
    const finding = run(makeSpec("ci_green"), makeContext({ ci }));
    expect(finding.status).toBe("fail");
    expect(finding.evidence[0]?.label).toContain("unit tests");
    expect(finding.rationale).toContain("1 of 2 reported checks failed");
  });

  it("asks for review while checks are pending", () => {
    const ci = makeCi({ state: "pending", total: 2, pending: [{ name: "e2e" }] });
    expect(run(makeSpec("ci_green"), makeContext({ ci })).status).toBe("needs_review");
  });

  it("never claims a CI result when checks are unavailable", () => {
    const ci = makeCi({ available: false, state: "unknown", total: 0, reason: "HTTP 403" });
    const finding = run(makeSpec("ci_green"), makeContext({ ci }));
    expect(finding.status).toBe("needs_review");
    expect(finding.rationale).toContain("HTTP 403");
    expect(finding.rationale).toContain("No pass or fail is claimed");
  });

  it("asks for review when no checks were reported", () => {
    const ci = makeCi({ state: "none", total: 0, successful: 0 });
    expect(run(makeSpec("ci_green"), makeContext({ ci })).status).toBe("needs_review");
  });
});

describe("merge conflicts", () => {
  it("handles mergeable, conflicting, and unknown states", () => {
    expect(run(makeSpec("merge_conflicts")).status).toBe("pass");
    expect(
      run(makeSpec("merge_conflicts"), makeContext({ pr: makePr({ mergeable: false }) })).status,
    ).toBe("fail");
    expect(
      run(
        makeSpec("merge_conflicts"),
        makeContext({ pr: makePr({ mergeable: null, mergeableState: "" }) }),
      ).status,
    ).toBe("needs_review");
  });
});

describe("evaluateRules", () => {
  it("keeps the rule source on every finding", () => {
    const findings = evaluateRules([makeSpec("signed_off_by"), makeSpec("tests_added")], makeContext());
    for (const finding of findings) {
      expect(finding.source.path).toBe("CONTRIBUTING.md");
      expect(finding.source.lineStart).toBeGreaterThan(0);
    }
  });

  it("refuses to evaluate free-form rules deterministically", () => {
    expect(() => evaluateRule(makeSpec("freeform"), makeContext())).toThrow();
    expect(evaluateRules([makeSpec("freeform")], makeContext())).toEqual([]);
  });
});

describe("file classification", () => {
  it("classifies test, docs, changelog, and source paths", () => {
    expect(isTestFile("src/api/pagination.test.ts")).toBe(true);
    expect(isTestFile("tests/helpers.ts")).toBe(true);
    expect(isTestFile("pkg/server_test.go")).toBe(true);
    expect(isTestFile("src/api/pagination.ts")).toBe(false);

    expect(isDocsFile("docs/api.md")).toBe(true);
    expect(isDocsFile("README.md")).toBe(true);

    expect(isChangelogFile("CHANGELOG.md")).toBe(true);
    expect(isChangelogFile(".changeset/brave-lions.md")).toBe(true);

    expect(isSourceFile("src/api/pagination.ts")).toBe(true);
    expect(isSourceFile("package.json")).toBe(false);
    expect(isSourceFile(".github/workflows/ci.yml")).toBe(false);
  });
});