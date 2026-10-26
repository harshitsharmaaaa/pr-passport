import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { analyzePullRequest } from "../pipeline";
import {
  ALAN_BRIEF_MAX_CHARS,
  evaluateAlanHandoff,
  handoffUserSteps,
  suggestedTaskTitle,
} from "./alan";

const DEMO_FAILING = "https://github.com/acme/widget-kit/pull/42";
const DEMO_CLEAN = "https://github.com/acme/widget-kit/pull/43";

describe("Alan handoff validation", () => {
  it("marks the failing demo brief as a complete, bounded, safe handoff", async () => {
    const report = await analyzePullRequest({ url: DEMO_FAILING, demo: true });
    const handoff = evaluateAlanHandoff(report);

    expect(handoff.ready).toBe(true);
    expect(handoff.checks.every((check) => check.ok)).toBe(true);

    const brief = report.remediationPrompt;
    expect(brief).toContain("CONTRIBUTING.md");
    expect(brief).toContain("Rule source:");
    expect(brief).toContain("Evidence from the pull request");
    expect(brief).toContain("## Validation commands");
    expect(brief).toContain("bun run test");
    expect(brief.length).toBeLessThanOrEqual(ALAN_BRIEF_MAX_CHARS);
  });

  it("gives the human the steps Alan cannot do for them", async () => {
    const report = await analyzePullRequest({ url: DEMO_FAILING, demo: true });
    const steps = handoffUserSteps(report).join(" ");

    expect(steps).toContain("demo fixtures");
    expect(steps).toContain("paste the brief as the task description");
    expect(steps).toContain("Run the validation commands yourself");
    expect(steps).toContain("PR Passport never pushes, merges, or rewrites commits");
  });

  it("suggests an outcome-shaped task title", async () => {
    const failing = await analyzePullRequest({ url: DEMO_FAILING, demo: true });
    const clean = await analyzePullRequest({ url: DEMO_CLEAN, demo: true });

    expect(suggestedTaskTitle(failing)).toBe(
      "Fix PR Passport findings: acme/widget-kit#42 (7 failed requirements)",
    );
    expect(suggestedTaskTitle(clean)).toBe(
      "Verify PR Passport result: acme/widget-kit#43 (all checks passed)",
    );
  });

  it("accepts a clean report and warns against invented work", async () => {
    const report = await analyzePullRequest({ url: DEMO_CLEAN, demo: true });
    const handoff = evaluateAlanHandoff(report);

    expect(handoff.ready).toBe(true);
    expect(handoff.userSteps.join(" ")).toContain("no remediation task is needed");
    expect(report.remediationPrompt).toContain("None. Do not invent work to fill this section.");
  });

  it("fails loudly when the constraints section is lost", async () => {
    const report = await analyzePullRequest({ url: DEMO_FAILING, demo: true });
    const tampered = {
      ...report,
      remediationPrompt: report.remediationPrompt.replace("## Constraints", "## Notes"),
    };
    const handoff = evaluateAlanHandoff(tampered);

    expect(handoff.ready).toBe(false);
    const constraints = handoff.checks.find((check) => check.id === "constraints");
    expect(constraints?.ok).toBe(false);
    expect(constraints?.detail).toContain("missing");
  });

  it("rejects briefs that exceed the bounded-task limit", async () => {
    const report = await analyzePullRequest({ url: DEMO_FAILING, demo: true });
    const bloated = {
      ...report,
      remediationPrompt: `${report.remediationPrompt}\n${"x".repeat(ALAN_BRIEF_MAX_CHARS)}`,
    };
    const handoff = evaluateAlanHandoff(bloated);

    expect(handoff.ready).toBe(false);
    expect(handoff.checks.find((check) => check.id === "bounded")?.ok).toBe(false);
  });

  it("rejects briefs that would leak credential material", async () => {
    const report = await analyzePullRequest({ url: DEMO_FAILING, demo: true });
    const leaky = {
      ...report,
      remediationPrompt: `${report.remediationPrompt}\n- token: ghp_sampleleakedtoken`,
    };
    const handoff = evaluateAlanHandoff(leaky);

    expect(handoff.ready).toBe(false);
    expect(handoff.checks.find((check) => check.id === "no-secrets")?.ok).toBe(false);
  });

  it("keeps the published sample report in sync with the handoff contract", () => {
    const raw = readFileSync(join(process.cwd(), "examples", "sample-report.json"), "utf8");
    const report = JSON.parse(raw) as Parameters<typeof evaluateAlanHandoff>[0];

    expect(report.schema).toBe("pr-passport.report.v1");
    expect(report.mode).toBe("demo");
    expect(report.summary.verdict).toBe("fail");

    const handoff = evaluateAlanHandoff(report);
    expect(handoff.ready).toBe(true);
    expect(handoff.checks.filter((check) => !check.ok)).toEqual([]);
  });
});