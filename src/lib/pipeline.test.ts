import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createDemoSource, getDemoScenario } from "./demo/fixtures";
import { AnalysisError } from "./errors";
import type { FreeformInterpreter, FreeformInterpretation } from "./model/interpreter";
import { analyzePullRequest } from "./pipeline";
import type { PullRequestSource, Report } from "./types";

const DEMO_FAILING = "https://github.com/acme/widget-kit/pull/42";
const DEMO_CLEAN = "https://github.com/acme/widget-kit/pull/43";

let previousDemoMode: string | undefined;

beforeAll(() => {
  previousDemoMode = process.env.DEMO_MODE;
  delete process.env.DEMO_MODE;
});

afterAll(() => {
  if (previousDemoMode === undefined) delete process.env.DEMO_MODE;
  else process.env.DEMO_MODE = previousDemoMode;
});

function demoSource(number = 42): PullRequestSource {
  return createDemoSource(
    getDemoScenario({ owner: "acme", repo: "widget-kit", number }),
  );
}

function stable(report: Report): string {
  const copy = JSON.parse(JSON.stringify(report)) as Report;
  copy.generatedAt = "stable";
  copy.timings = { totalMs: 0 };
  return JSON.stringify(copy);
}

function interpreterFor(
  status: "pass" | "fail" | "needs_review",
  confidence: number,
): FreeformInterpreter {
  return {
    async interpret(input): Promise<FreeformInterpretation> {
      const rule = input.rules[0];
      if (!rule) return { findings: [], notes: [], issues: [], meta: { mode: "live", model: "test", rejectedFindings: 0 } };
      return {
        findings: [
          {
            ruleId: rule.id,
            ruleTitle: rule.title,
            status,
            rationale: "The description supports this decision.",
            confidence,
            evidence: [{ kind: "body", ref: "body", note: "Body evidence.", resolved: "body" }],
          },
        ],
        notes: ["A model note."],
        issues: [],
        meta: { mode: "live", model: "test-model", rejectedFindings: 0 },
      };
    },
  };
}

describe("demo analysis", () => {
  it("produces a failing report for the failing fixture", async () => {
    const report = await analyzePullRequest({ url: DEMO_FAILING, demo: true });

    expect(report.mode).toBe("demo");
    expect(report.summary.verdict).toBe("fail");
    expect(report.summary.fail).toBeGreaterThanOrEqual(6);
    expect(report.model.mode).toBe("recorded_fixture");
    expect(report.model.used).toBe(true);

    const ids = report.findings.map((finding) => finding.id);
    expect(ids).toContain("rule-signed_off_by");
    expect(ids).toContain("rule-tests_added");
    expect(ids).toContain("rule-template-checklist");
    expect(ids).toContain("rule-ci-green");
    expect(ids.some((id) => id.startsWith("freeform-"))).toBe(true);
  });

  it("attaches a rule source and evidence to every finding", async () => {
    const report = await analyzePullRequest({ url: DEMO_FAILING, demo: true });

    for (const finding of report.findings) {
      expect(finding.source.label.length).toBeGreaterThan(0);
      expect(finding.evidence.length).toBeGreaterThan(0);
      expect(finding.requirement.length).toBeGreaterThan(0);
      if (finding.source.kind === "repository_file") {
        expect(finding.source.path).toBeDefined();
        expect(finding.source.lineStart).toBeGreaterThan(0);
        expect(finding.source.excerpt).toBeDefined();
      }
    }
  });

  it("keeps model evidence inside the pull request", async () => {
    const report = await analyzePullRequest({ url: DEMO_FAILING, demo: true });
    const scenario = getDemoScenario({ owner: "acme", repo: "widget-kit", number: 42 });
    const changed = new Set(scenario.changedFiles.map((file) => file.filename));

    const modelFindings = report.findings.filter((finding) => finding.origin !== "deterministic");
    expect(modelFindings.length).toBeGreaterThan(0);
    for (const finding of modelFindings) {
      expect(finding.source.path).toBe("CONTRIBUTING.md");
      for (const evidence of finding.evidence) {
        if (evidence.kind === "file") expect(changed.has(evidence.path ?? "")).toBe(true);
      }
    }
  });

  it("states that demo data is not live data", async () => {
    const report = await analyzePullRequest({ url: DEMO_FAILING, demo: true });
    expect(report.limitations.join(" ")).toContain("Demo mode");
    expect(report.limitations.join(" ")).toContain("recorded sample");
  });

  it("produces a clean report for the clean fixture", async () => {
    const report = await analyzePullRequest({ url: DEMO_CLEAN, demo: true });

    expect(report.summary.verdict).toBe("pass");
    expect(report.summary.fail).toBe(0);
    expect(report.summary.needsReview).toBe(0);
    expect(report.summary.pass).toBe(report.findings.length);
    expect(report.findings.every((finding) => finding.status === "pass")).toBe(true);
    expect(report.pendingRules).toEqual([]);
  });

  it("counts match the findings list and the schema is declared", async () => {
    const report = await analyzePullRequest({ url: DEMO_FAILING, demo: true });
    expect(report.summary.pass).toBe(report.findings.filter((f) => f.status === "pass").length);
    expect(report.summary.fail).toBe(report.findings.filter((f) => f.status === "fail").length);
    expect(report.summary.needsReview).toBe(
      report.findings.filter((f) => f.status === "needs_review").length,
    );
    expect(report.schema).toBe("pr-passport.report.v1");
    expect(Number.isNaN(Date.parse(report.generatedAt))).toBe(false);
    expect(report.timings.totalMs).toBeGreaterThanOrEqual(0);
  });

  it("is deterministic across runs", async () => {
    const first = await analyzePullRequest({ url: DEMO_FAILING, demo: true });
    const second = await analyzePullRequest({ url: DEMO_FAILING, demo: true });
    expect(stable(first)).toBe(stable(second));
  });

  it("derives validation commands only from repository files", async () => {
    const report = await analyzePullRequest({ url: DEMO_FAILING, demo: true });
    const commands = report.validationCommands.map((command) => command.command);
    expect(commands).toContain("bun run test");
    expect(commands).toContain("bun run lint");
    expect(commands).toContain("bun install");
    for (const command of report.validationCommands) {
      expect(command.source.label.length).toBeGreaterThan(0);
      expect(command.reason.length).toBeGreaterThan(0);
    }
  });
});

describe("remediation brief", () => {
  it("contains every required section and no secrets", async () => {
    const report = await analyzePullRequest({ url: DEMO_FAILING, demo: true });
    const prompt = report.remediationPrompt;

    expect(prompt).toContain("# PR Passport remediation brief");
    expect(prompt).toContain("## Definition of done");
    expect(prompt).toContain("## Failed requirements");
    expect(prompt).toContain("## Needs human review");
    expect(prompt).toContain("## Suggested files to inspect");
    expect(prompt).toContain("## Validation commands");
    expect(prompt).toContain("## Constraints");
    expect(prompt).toContain("## Known limitations of this report");
    expect(prompt).toContain("Do not invent contribution rules");
    expect(prompt).toContain("Do not rewrite another person's commits");
    expect(prompt).toContain("Signed-off-by");
    expect(prompt).toContain("bun run test");
    expect(prompt).not.toContain("GITHUB_TOKEN");
    expect(prompt).not.toContain("INFERENCE_API_KEY");
    expect(prompt).not.toContain("undefined");
  });
});

describe("error handling", () => {
  it("rejects invalid URLs before any network call", async () => {
    try {
      await analyzePullRequest({ url: "https://gitlab.com/a/b/pull/1", demo: true });
      throw new Error("expected an error");
    } catch (error) {
      expect(error).toBeInstanceOf(AnalysisError);
      expect((error as AnalysisError).code).toBe("unsupported_host");
    }
  });

  it("reports demo fixtures that do not exist", async () => {
    try {
      await analyzePullRequest({ url: "https://github.com/vercel/next.js/pull/1", demo: true });
      throw new Error("expected an error");
    } catch (error) {
      expect(error).toBeInstanceOf(AnalysisError);
      expect((error as AnalysisError).code).toBe("demo_not_found");
      expect((error as AnalysisError).hint).toContain("demo");
    }
  });
});

describe("honest degradation", () => {
  it("does not invent rules when no guidelines exist", async () => {
    const source: PullRequestSource = {
      ...demoSource(),
      readRepositoryFile: async () => null,
    };
    const report = await analyzePullRequest({ url: DEMO_FAILING, source, interpreter: null });

    expect(report.guidelines.files).toEqual([]);
    expect(report.guidelines.missing.length).toBeGreaterThan(0);
    expect(report.limitations.some((line) => line.includes("No contribution guidelines"))).toBe(true);
    expect(report.pendingRules).toEqual([]);
    expect(report.findings.every((finding) => finding.origin === "deterministic")).toBe(true);
    expect(report.findings.map((finding) => finding.id).sort()).toEqual([
      "rule-ci-green",
      "rule-merge-conflicts",
    ]);
  });

  it("marks free-form rules as unevaluated when inference is not configured", async () => {
    const report = await analyzePullRequest({ url: DEMO_FAILING, source: demoSource(), interpreter: null });

    expect(report.pendingRules.length).toBeGreaterThan(0);
    expect(report.pendingRules[0]?.reason).toContain("No inference endpoint");
    expect(report.model.mode).toBe("none");
    expect(report.model.requested).toBe(true);
    expect(report.model.used).toBe(false);
    expect(report.limitations.join(" ")).toContain("free-form");
  });

  it("keeps deterministic findings when inference fails", async () => {
    const failing: FreeformInterpreter = {
      async interpret() {
        throw new AnalysisError("inference_failed", "The endpoint is offline.", {
          status: 502,
          hint: "Check INFERENCE_BASE_URL.",
        });
      },
    };
    const report = await analyzePullRequest({
      url: DEMO_FAILING,
      source: demoSource(),
      interpreter: failing,
    });

    expect(report.model.mode).toBe("failed");
    expect(report.model.error).toContain("offline");
    expect(report.pendingRules.length).toBeGreaterThan(0);
    expect(report.summary.verdict).toBe("fail");
    expect(report.findings.some((finding) => finding.id === "rule-signed_off_by")).toBe(true);
  });

  it("does not fail file-based rules when the file list is unavailable", async () => {
    const source: PullRequestSource = {
      ...demoSource(),
      getChangedFiles: async () => {
        throw new AnalysisError("github_unavailable", "The files endpoint is down.");
      },
    };
    const report = await analyzePullRequest({ url: DEMO_FAILING, source, interpreter: null });

    expect(report.limitations.join(" ")).toContain("Changed files could not be listed");
    const changelog = report.findings.find((finding) => finding.id === "rule-changelog_updated");
    expect(changelog?.status).toBe("needs_review");
    const tests = report.findings.find((finding) => finding.id === "rule-tests_added");
    expect(tests?.status).toBe("needs_review");
  });
});

describe("model integration", () => {
  it("maps validated model findings onto the extracted rule", async () => {
    const report = await analyzePullRequest({
      url: DEMO_FAILING,
      source: demoSource(),
      interpreter: interpreterFor("pass", 0.9),
    });
    const modelFinding = report.findings.find((finding) => finding.origin === "model");

    expect(modelFinding).toBeDefined();
    expect(modelFinding?.source.path).toBe("CONTRIBUTING.md");
    expect(modelFinding?.evidence[0]?.kind).toBe("body");
    expect(report.model.mode).toBe("live");
    expect(report.model.model).toBe("test-model");
    expect(report.model.notes).toContain("A model note.");
  });

  it("downgrades low-confidence model verdicts to human review", async () => {
    const report = await analyzePullRequest({
      url: DEMO_FAILING,
      source: demoSource(),
      interpreter: interpreterFor("fail", 0.3),
    });
    const modelFinding = report.findings.find((finding) => finding.origin === "model");
    expect(modelFinding?.status).toBe("needs_review");
    expect(modelFinding?.rationale).toContain("confidence was below 0.5");
  });
});