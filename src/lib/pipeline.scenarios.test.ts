import { describe, expect, it } from "bun:test";
import { createRecordedInterpreter } from "./demo/recorded";
import { createDemoSource, getDemoScenario } from "./demo/fixtures";
import { AnalysisError } from "./errors";
import type { FreeformInterpreter } from "./model/interpreter";
import { analyzePullRequest } from "./pipeline";
import type { CiSummary, PullRequestData, PullRequestSource, Report } from "./types";

/*
 * Pipeline scenarios that are not covered by the route-level suite: demo
 * verdict paths, missing versus unreadable guidelines, partial GitHub
 * retrieval, guideline-owned CI rules, and empty pull request metadata.
 */

const FAILING_URL = "https://github.com/acme/widget-kit/pull/42";
const CLEAN_URL = "https://github.com/acme/widget-kit/pull/43";

const CI_RULE_GUIDE = `# Contributing

## Pull request requirements

- All checks must pass before review.
`;

function demoSource(number = 42): PullRequestSource {
  return createDemoSource(getDemoScenario({ owner: "acme", repo: "widget-kit", number }));
}

function withOverrides(
  source: PullRequestSource,
  overrides: Partial<PullRequestSource>,
): PullRequestSource {
  return { ...source, ...overrides };
}

function findingById(report: Report, id: string) {
  return report.findings.find((finding) => finding.id === id);
}

async function analyzeWithSource(
  source: PullRequestSource,
  interpreter: FreeformInterpreter | null = null,
  url = FAILING_URL,
): Promise<Report> {
  return analyzePullRequest({ url, source, interpreter });
}

describe("demo verdict paths", () => {
  it("returns the failing demo scenario with deterministic and recorded findings", async () => {
    const report = await analyzePullRequest({ url: FAILING_URL, demo: true });

    expect(report.mode).toBe("demo");
    expect(report.summary.verdict).toBe("fail");
    expect(report.summary.fail).toBeGreaterThan(0);
    expect(report.pendingRules).toEqual([]);
    expect(report.model.mode).toBe("recorded_fixture");
    expect(report.findings.some((finding) => finding.origin === "recorded_fixture")).toBe(true);
  });

  it("returns the clean demo scenario only when every evaluated requirement passes", async () => {
    const report = await analyzePullRequest({ url: CLEAN_URL, demo: true });

    expect(report.mode).toBe("demo");
    expect(report.summary.verdict).toBe("pass");
    expect(report.summary.fail).toBe(0);
    expect(report.summary.needsReview).toBe(0);
    expect(report.findings.every((finding) => finding.status === "pass")).toBe(true);
    expect(report.pendingRules).toEqual([]);
  });

  it("returns a human-review demo report when the recorded model cannot decide", async () => {
    const interpreter = createRecordedInterpreter({
      model: "recorded:human-review-sample",
      findings: [
        {
          heading: "Review process",
          status: "needs_review",
          rationale:
            "The changed files fit a documentation fix, but only a maintainer can confirm the review-size guideline was followed.",
          confidence: 0.55,
          evidence: [
            {
              kind: "metadata",
              ref: "changed_files",
              note: "Three files changed for a documentation correction.",
            },
          ],
        },
      ],
    });

    const report = await analyzePullRequest({
      url: CLEAN_URL,
      demo: true,
      interpreter,
    });

    expect(report.mode).toBe("demo");
    expect(report.summary.verdict).toBe("needs_review");
    expect(report.summary.fail).toBe(0);
    expect(report.summary.needsReview).toBe(1);
    expect(report.summary.headline).toContain("human decision");
    expect(report.model.mode).toBe("recorded_fixture");
    expect(report.pendingRules).toEqual([]);

    const review = report.findings.find((finding) => finding.status === "needs_review");
    expect(review?.origin).toBe("recorded_fixture");
    expect(report.remediationPrompt).toContain("## Needs human review");
    expect(report.remediationPrompt).toContain("A human confirms");
  });
});

describe("missing and unreadable guidelines", () => {
  const TEMPLATE = `## Summary

Describe the change and why it is needed.

## Checklist

- [ ] I have read the contributing guide
- [ ] I have added tests for my changes
`;

  it("still applies pull request template rules when no CONTRIBUTING file exists", async () => {
    const source = withOverrides(demoSource(), {
      readRepositoryFile: async (_owner, _repo, path) =>
        path === ".github/PULL_REQUEST_TEMPLATE.md" ? TEMPLATE : null,
    });

    const report = await analyzeWithSource(source);
    const ids = report.findings.map((finding) => finding.id);

    expect(report.guidelines.files).toEqual([]);
    expect(report.guidelines.templatePath).toBe(".github/PULL_REQUEST_TEMPLATE.md");
    expect(ids).toContain("rule-template-checklist");
    expect(ids).toContain("rule-pr-description");
    expect(ids).not.toContain("rule-signed_off_by");
    expect(report.pendingRules).toEqual([]);
    expect(report.limitations.join(" ")).toContain("No contribution guidelines were found");
  });

  it("does not claim that only platform checks ran when template rules were applied", async () => {
    const source = withOverrides(demoSource(), {
      readRepositoryFile: async (_owner, _repo, path) =>
        path === ".github/PULL_REQUEST_TEMPLATE.md" ? TEMPLATE : null,
    });

    const report = await analyzeWithSource(source);
    const limitation = report.limitations.find((line) =>
      line.includes("No contribution guidelines were found"),
    );

    // The template supplied real requirements, so the report should not say
    // that only platform checks were evaluated.
    expect(limitation).not.toContain("Only platform checks were evaluated");
  });

  it("distinguishes unreadable guideline files from files that do not exist", async () => {
    const unreadable = withOverrides(demoSource(), {
      readRepositoryFile: async () => {
        throw new AnalysisError("github_unavailable", "GitHub returned HTTP 403 for this file.");
      },
    });

    const report = await analyzeWithSource(unreadable);

    expect(report.guidelines.files).toEqual([]);
    expect(report.guidelines.missing).toEqual([]);
    expect(report.guidelines.unavailable.length).toBeGreaterThan(0);
    expect(report.limitations.join(" ")).toContain("Could not read");
    expect(report.findings.map((finding) => finding.id).sort()).toEqual([
      "rule-ci-green",
      "rule-merge-conflicts",
    ]);
    expect(report.pendingRules).toEqual([]);
  });

  it("does not print an empty checked-file list when every guideline read failed", async () => {
    const unreadable = withOverrides(demoSource(), {
      readRepositoryFile: async () => {
        throw new AnalysisError("github_unavailable", "GitHub returned HTTP 403 for this file.");
      },
    });

    const report = await analyzeWithSource(unreadable);
    const limitation = report.limitations.find((line) => line.includes("No contribution guidelines"));

    // Known defect: when every candidate read throws, `missing` stays empty,
    // so the limitation renders as "(checked )" and wrongly claims the files
    // were absent rather than unreadable. Reproduction: make
    // readRepositoryFile reject for every path and inspect report.limitations.
    expect(limitation).not.toContain("(checked )");
    expect(limitation).toContain("Could not read");
  });
});

describe("partial GitHub retrieval", () => {
  it("keeps the report usable when commits cannot be listed", async () => {
    const source = withOverrides(demoSource(), {
      getCommits: async () => {
        throw new AnalysisError("github_unavailable", "The commits endpoint is down.");
      },
    });

    const report = await analyzeWithSource(source);

    expect(report.limitations.join(" ")).toContain("Commits could not be listed");
    expect(findingById(report, "rule-signed_off_by")?.status).toBe("needs_review");
    expect(findingById(report, "rule-ci-green")?.status).toBe("fail");
    expect(report.summary.verdict).toBe("fail");
  });

  it("never claims a CI result when the CI endpoints fail", async () => {
    const source = withOverrides(demoSource(), {
      getCi: async () => {
        throw new AnalysisError("github_unavailable", "Checks are unavailable.");
      },
    });

    const report = await analyzeWithSource(source);

    expect(report.checks.ci.available).toBe(false);
    expect(report.checks.ci.state).toBe("unknown");
    expect(report.limitations.join(" ")).toContain("CI status could not be read");
    expect(findingById(report, "rule-ci-green")).toBeUndefined();
    expect(report.findings.every((finding) => !finding.id.includes("ci"))).toBe(true);
  });

  it("keeps guideline-derived validation commands when the repository listing fails", async () => {
    const source = withOverrides(demoSource(), {
      getRepoContext: async () => {
        throw new AnalysisError("github_unavailable", "The contents endpoint is down.");
      },
    });

    const report = await analyzeWithSource(source);
    const commands = report.validationCommands.map((command) => command.command);

    expect(report.limitations.join(" ")).toContain("Repository files could not be listed");
    expect(commands).toContain("bun install");
    expect(commands).toContain("bun run test");
    expect(report.summary.verdict).toBe("fail");
  });
});

describe("guideline-owned CI rules", () => {
  const source = withOverrides(demoSource(), {
    readRepositoryFile: async (_owner, _repo, path) =>
      path === "CONTRIBUTING.md" ? CI_RULE_GUIDE : null,
  });

  function ci(overrides: Partial<CiSummary>): CiSummary {
    return {
      available: true,
      state: "success",
      total: 1,
      successful: 1,
      failing: [],
      pending: [],
      sourceUrl: `${FAILING_URL}/checks`,
      ...overrides,
    };
  }

  function analyzeCi(value: CiSummary): Promise<Report> {
    return analyzeWithSource(withOverrides(source, { getCi: async () => value }));
  }

  it("passes when every reported check succeeded", async () => {
    const report = await analyzeCi(ci({}));
    expect(findingById(report, "rule-ci_green")?.status).toBe("pass");
    expect(report.summary.verdict).toBe("pass");
  });

  it("fails and names the failing checks", async () => {
    const report = await analyzeCi(
      ci({
        state: "failure",
        total: 2,
        successful: 1,
        failing: [{ name: "integration tests", conclusion: "failure" }],
      }),
    );
    const finding = findingById(report, "rule-ci_green");

    expect(finding?.status).toBe("fail");
    expect(finding?.evidence[0]?.label).toContain("integration tests");
    expect(report.summary.verdict).toBe("fail");
  });

  it("asks for review while checks are pending", async () => {
    const report = await analyzeCi(
      ci({ state: "pending", total: 2, successful: 1, pending: [{ name: "e2e" }] }),
    );
    const finding = findingById(report, "rule-ci_green");

    expect(finding?.status).toBe("needs_review");
    expect(finding?.rationale).toContain("have not finished");
    expect(report.summary.verdict).toBe("needs_review");
  });

  it("asks for review when checks are absent", async () => {
    const report = await analyzeCi(ci({ state: "none", total: 0, successful: 0 }));
    const finding = findingById(report, "rule-ci_green");

    expect(finding?.status).toBe("needs_review");
    expect(finding?.rationale).toContain("No conclusive CI result");
    expect(report.limitations.join(" ")).toContain("No CI checks were reported");
  });

  it("asks for review when CI is unavailable and never claims a pass", async () => {
    const report = await analyzeCi(
      ci({ available: false, state: "unknown", total: 0, successful: 0, reason: "HTTP 403" }),
    );
    const finding = findingById(report, "rule-ci_green");

    expect(finding?.status).toBe("needs_review");
    expect(finding?.rationale).toContain("HTTP 403");
    expect(finding?.rationale).toContain("No pass or fail is claimed");
    expect(report.summary.pass).toBe(1);
    expect(report.summary.needsReview).toBe(1);
  });
});

describe("empty pull request metadata", () => {
  it("handles an empty description and missing commit metadata without inventing evidence", async () => {
    const scenario = getDemoScenario({ owner: "acme", repo: "widget-kit", number: 43 });
    const emptyPr: PullRequestData = {
      ...scenario.pr,
      title: "docs: update the pagination guide",
      body: "",
      commitCount: 0,
    };
    const source = withOverrides(demoSource(43), {
      getPullRequest: async () => emptyPr,
      getCommits: async () => [],
    });

    const report = await analyzeWithSource(source, null, CLEAN_URL);

    const linked = findingById(report, "rule-linked_issue");
    expect(linked?.status).toBe("fail");
    expect(linked?.evidence[0]?.detail).toContain("description is empty");

    const signoff = findingById(report, "rule-signed_off_by");
    expect(signoff?.status).toBe("needs_review");
    expect(signoff?.rationale).toContain("no commits");
    expect(signoff?.evidence.some((evidence) => evidence.kind === "commit")).toBe(false);

    expect(findingById(report, "rule-pr-description")?.status).toBe("fail");
    expect(findingById(report, "rule-template-checklist")?.status).toBe("needs_review");
    expect(report.summary.verdict).toBe("fail");
    expect(report.remediationPrompt).toContain("The pull request description is empty");
    expect(report.remediationPrompt).toContain("Commits returned by GitHub: 0 commits");
  });

  it("lists free-form rules as pending when the model returns no findings", async () => {
    const emptyInterpreter: FreeformInterpreter = {
      async interpret() {
        return {
          findings: [],
          notes: [],
          issues: [
            {
              code: "empty_response",
              message: "The model returned no findings for the supplied rules.",
            },
          ],
          meta: { mode: "live", model: "empty-model", rejectedFindings: 0 },
        };
      },
    };

    const report = await analyzePullRequest({
      url: CLEAN_URL,
      demo: true,
      interpreter: emptyInterpreter,
    });

    // The free-form rules were never resolved, so they must not disappear.
    expect(report.pendingRules.length).toBeGreaterThan(0);
    expect(report.summary.verdict).not.toBe("pass");
  });
});
