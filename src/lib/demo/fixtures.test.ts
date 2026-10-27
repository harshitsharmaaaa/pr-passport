import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { loadGuidelines } from "../guidelines";
import { cleanText } from "../markdown";
import { analyzePullRequest } from "../pipeline";
import { buildRuleSpecs } from "../rules/spec";
import type { CiCheck, Report } from "../types";
import {
  DEMO_SCENARIOS,
  DEMO_SUMMARIES,
  createDemoSource,
  getDemoScenario,
} from "./fixtures";

const SAMPLE_REPORT_PATH = new URL("../../../examples/sample-report.json", import.meta.url);
const FAILING_URL = "https://github.com/acme/widget-kit/pull/42";
const CLEAN_URL = "https://github.com/acme/widget-kit/pull/43";

function readSampleReport(): Report {
  return JSON.parse(readFileSync(SAMPLE_REPORT_PATH, "utf8")) as Report;
}

/** Clock and duration fields change on every run; everything else must not. */
function stable(report: Report): Report {
  const copy = JSON.parse(JSON.stringify(report)) as Report;
  copy.generatedAt = "stable";
  copy.timings = { totalMs: 0 };
  return copy;
}

function expectedVerdict(pass: number, fail: number, needsReview: number): Report["summary"]["verdict"] {
  if (fail > 0) return "fail";
  if (needsReview > 0) return "needs_review";
  return pass > 0 ? "pass" : "needs_review";
}

function checkUrls(checks: CiCheck[]): (string | undefined)[] {
  return checks.map((check) => check.url);
}

describe("demo fixture integrity", () => {
  it("keeps pull request metadata, changed files and commits in agreement", () => {
    for (const scenario of DEMO_SCENARIOS) {
      const { pr, changedFiles, commits } = scenario;

      expect(pr.url).toBe(`https://github.com/${pr.owner}/${pr.repo}/pull/${pr.number}`);
      expect(pr.repository.fullName).toBe(`${pr.owner}/${pr.repo}`);
      expect(pr.repository.url).toBe(`https://github.com/${pr.owner}/${pr.repo}`);
      expect(pr.authorUrl).toBe(`https://github.com/${pr.author}`);
      expect(pr.baseRef).toBe(pr.repository.defaultBranch);
      expect(pr.headSha).toMatch(/^[a-f0-9]{40}$/);
      expect(pr.baseSha).toMatch(/^[a-f0-9]{40}$/);
      expect(pr.headSha).not.toBe(pr.baseSha);

      const additions = changedFiles.reduce((sum, file) => sum + file.additions, 0);
      const deletions = changedFiles.reduce((sum, file) => sum + file.deletions, 0);

      expect(pr.additions).toBe(additions);
      expect(pr.deletions).toBe(deletions);
      expect(pr.changedFileCount).toBe(changedFiles.length);
      expect(pr.commitCount).toBe(commits.length);

      const paths = changedFiles.map((file) => file.filename);
      expect(new Set(paths).size).toBe(paths.length);
      for (const file of changedFiles) {
        expect(file.changes).toBe(file.additions + file.deletions);
        expect(file.additions).toBeGreaterThanOrEqual(0);
        expect(file.deletions).toBeGreaterThanOrEqual(0);
      }

      for (const commit of commits) {
        expect(commit.shortSha).toBe(commit.sha.slice(0, 7));
        expect(commit.sha).toMatch(/^[a-f0-9]{40}$/);
        expect(commit.message.trim().length).toBeGreaterThan(0);
        expect(commit.author.trim().length).toBeGreaterThan(0);
      }

      const head = commits[commits.length - 1];
      expect(head?.sha).toBe(pr.headSha);

      const createdAt = Date.parse(pr.createdAt);
      const updatedAt = Date.parse(pr.updatedAt);
      expect(Number.isNaN(createdAt)).toBe(false);
      expect(Number.isNaN(updatedAt)).toBe(false);
      expect(createdAt).toBeLessThanOrEqual(updatedAt);

      const commitTimes = commits.map((commit) => Date.parse(commit.date));
      for (const time of commitTimes) {
        expect(Number.isNaN(time)).toBe(false);
        expect(time).toBeGreaterThanOrEqual(createdAt);
        expect(time).toBeLessThanOrEqual(updatedAt);
      }
      expect([...commitTimes].sort((a, b) => a - b)).toEqual(commitTimes);
    }
  });

  it("keeps CI counts consistent with the checks it reports", () => {
    for (const scenario of DEMO_SCENARIOS) {
      const { ci, pr } = scenario;

      expect(ci.available).toBe(true);
      expect(ci.total).toBe(ci.successful + ci.failing.length + ci.pending.length);
      expect(ci.sourceUrl).toBe(`${pr.url}/checks`);
      for (const url of [...checkUrls(ci.failing), ...checkUrls(ci.pending)]) {
        expect(url?.startsWith(`${pr.url}/`)).toBe(true);
      }

      if (ci.state === "success") {
        expect(ci.failing).toHaveLength(0);
        expect(ci.pending).toHaveLength(0);
        expect(ci.successful).toBe(ci.total);
      }
      if (ci.state === "failure") {
        expect(ci.failing.length).toBeGreaterThan(0);
      }
    }
  });

  it("describes a repository whose bundled files match the listing and manifest", () => {
    for (const scenario of DEMO_SCENARIOS) {
      const { repoContext, repositoryFiles } = scenario;
      const listed = new Set(repoContext.files.map((file) => file.path));

      for (const path of Object.keys(repositoryFiles)) {
        expect(listed.has(path)).toBe(true);
      }
      for (const file of repoContext.files) {
        expect(file.size).toBeGreaterThan(0);
      }

      const contributing = repositoryFiles["CONTRIBUTING.md"];
      const template = repositoryFiles[".github/PULL_REQUEST_TEMPLATE.md"];
      const manifest = repositoryFiles["package.json"];
      const changelog = repositoryFiles["CHANGELOG.md"];
      const packageJson = repoContext.packageJson;
      expect(contributing).toBeDefined();
      expect(template).toBeDefined();
      expect(changelog).toBeDefined();
      if (!packageJson) throw new Error("The demo repository context must include package.json.");
      expect(manifest).toBe(packageJson.raw);

      const parsed = JSON.parse(manifest ?? "{}") as {
        scripts?: Record<string, string>;
        packageManager?: string;
      };
      expect(parsed.scripts).toEqual(packageJson.scripts);
      expect(parsed.packageManager).toBe("bun@1.4.4");
      expect(repoContext.packageManager).toBe("bun");

      // The fixture story depends on these two changelog states.
      if (scenario.slug === "failing") {
        expect(changelog).toContain("## Unreleased\n\n## 3.4.1");
      } else {
        expect(changelog).toContain("## Unreleased\n\n- ");
      }
    }
  });

  it("records one finding for every free-form rule it will be asked about", async () => {
    for (const scenario of DEMO_SCENARIOS) {
      const source = createDemoSource(scenario);
      const guidelines = await loadGuidelines(
        source,
        scenario.pr.owner,
        scenario.pr.repo,
        scenario.pr.baseSha,
      );
      const rules = buildRuleSpecs(guidelines, {
        prUrl: scenario.pr.url,
        headSha: scenario.pr.headSha,
        ci: scenario.ci,
      });

      expect(rules.freeform.length).toBeGreaterThan(0);
      expect(scenario.recording.findings.map((finding) => finding.heading.toLowerCase()).sort()).toEqual(
        rules.freeform.map((rule) => rule.title.toLowerCase()).sort(),
      );
      expect(scenario.recording.model.startsWith("recorded:")).toBe(true);

      const changed = new Set(scenario.changedFiles.map((file) => file.filename));
      for (const finding of scenario.recording.findings) {
        expect(finding.rationale.length).toBeGreaterThan(0);
        expect(finding.evidence.length).toBeGreaterThan(0);
        expect(finding.confidence).toBeGreaterThanOrEqual(0.5);
        expect(finding.confidence).toBeLessThanOrEqual(1);

        for (const evidence of finding.evidence) {
          if (evidence.kind === "file") {
            expect(changed.has(evidence.ref)).toBe(true);
          }
          if (evidence.kind === "commit") {
            expect(
              scenario.commits.some(
                (commit) => commit.sha === evidence.ref || commit.shortSha === evidence.ref,
              ),
            ).toBe(true);
          }
          if (evidence.kind === "title" || evidence.kind === "body") {
            expect(["title", "body", "description"]).toContain(evidence.ref);
          }
          if (evidence.kind === "ci") {
            expect(scenario.ci.available).toBe(true);
          }
        }
      }
    }
  });

  it("labels every demo entry as a fixture sample", () => {
    expect(DEMO_SUMMARIES).toHaveLength(DEMO_SCENARIOS.length);
    for (const summary of DEMO_SUMMARIES) {
      expect(summary.label.startsWith("Sample:")).toBe(true);
      expect(summary.description.toLowerCase()).toContain("fixture");
      expect(summary.url.startsWith("https://github.com/")).toBe(true);
    }
  });

  it("quotes guideline excerpts from the bundled repository files", async () => {
    for (const scenario of DEMO_SCENARIOS) {
      const report = await analyzePullRequest({ url: scenario.url, demo: true });

      for (const finding of report.findings) {
        if (finding.source.kind !== "repository_file") continue;
        const path = finding.source.path;
        expect(path).toBeDefined();
        const content = path ? scenario.repositoryFiles[path] : undefined;
        expect(content).toBeDefined();
        if (!path || !content) continue;

        const quoted = (finding.source.excerpt ?? "").replace(/…$/, "");
        expect(quoted.length).toBeGreaterThan(0);
        expect(cleanText(content)).toContain(quoted);
      }
    }
  });
});

describe("demo analysis reproducibility", () => {
  it("shows every recorded finding with no silent drops", async () => {
    for (const scenario of DEMO_SCENARIOS) {
      const report = await analyzePullRequest({ url: scenario.url, demo: true });

      expect(report.mode).toBe("demo");
      expect(report.model.requested).toBe(true);
      expect(report.model.used).toBe(true);
      expect(report.model.mode).toBe("recorded_fixture");
      expect(report.model.model).toBe(scenario.recording.model);
      expect(report.model.rejectedFindings).toBe(0);
      expect(report.pendingRules).toEqual([]);
      expect(report.limitations.join(" ")).toContain("Demo mode");
      expect(report.limitations.join(" ")).toContain("recorded sample");

      const recordedFindings = report.findings.filter(
        (finding) => finding.origin === "recorded_fixture",
      );
      expect(recordedFindings).toHaveLength(scenario.recording.findings.length);

      for (const recorded of scenario.recording.findings) {
        const match = recordedFindings.find((finding) => finding.title === recorded.heading);
        expect(match).toBeDefined();
        expect(match?.status).toBe(recorded.status);
        expect(match?.confidence).toBe(recorded.confidence);
        expect(match?.evidence.length).toBeGreaterThan(0);
        expect(match?.source.path).toBe("CONTRIBUTING.md");
        expect(match?.source.lineStart ?? 0).toBeGreaterThan(0);
        expect(match?.source.excerpt ?? "").not.toBe("");
      }

      for (const finding of report.findings.filter(
        (candidate) => candidate.origin === "deterministic",
      )) {
        expect(finding.source.label.length).toBeGreaterThan(0);
        expect(finding.evidence.length).toBeGreaterThan(0);
        if (finding.source.kind === "repository_file") {
          expect(finding.source.path).toBeDefined();
          expect(finding.source.lineStart ?? 0).toBeGreaterThan(0);
          expect(finding.source.excerpt ?? "").not.toBe("");
        }
      }

      const pass = report.findings.filter((finding) => finding.status === "pass").length;
      const fail = report.findings.filter((finding) => finding.status === "fail").length;
      const needsReview = report.findings.filter(
        (finding) => finding.status === "needs_review",
      ).length;
      expect(report.summary).toMatchObject({ pass, fail, needsReview });
      expect(report.summary.verdict).toBe(expectedVerdict(pass, fail, needsReview));
    }
  });

  it("contains a hard failure with a rule source, evidence and remediation", async () => {
    const report = await analyzePullRequest({ url: FAILING_URL, demo: true });
    const failure = report.findings.find(
      (finding) => finding.title === "Developer Certificate of Origin sign-off",
    );

    expect(report.summary.verdict).toBe("fail");
    expect(failure).toBeDefined();
    expect(failure?.status).toBe("fail");
    expect(failure?.origin).toBe("deterministic");
    expect(failure?.source.kind).toBe("repository_file");
    expect(failure?.source.path).toBe("CONTRIBUTING.md");
    expect(failure?.source.excerpt).toContain("Signed-off-by");
    expect(failure?.evidence.some((evidence) => evidence.kind === "commit")).toBe(true);
    expect(failure?.remediation ?? "").not.toBe("");

    const review = report.findings.filter((finding) => finding.status === "needs_review");
    expect(review.length).toBeGreaterThan(0);
    expect(review.every((finding) => finding.origin === "deterministic")).toBe(true);

    const recorded = report.findings.filter((finding) => finding.origin === "recorded_fixture");
    expect(recorded.length).toBeGreaterThan(0);
    expect(recorded.every((finding) => finding.confidence !== undefined)).toBe(true);

    expect(report.remediationPrompt).toContain("# PR Passport remediation brief");
    expect(report.remediationPrompt).toContain("## Definition of done");
    expect(report.remediationPrompt).toContain("## Validation commands");
    expect(report.remediationPrompt).toContain("bun run test");
    expect(report.remediationPrompt).toContain("Do not invent contribution rules");
    expect(report.remediationPrompt).toContain("demo (bundled fixtures)");
  });

  it("keeps the clean sample clean and does not invent work", async () => {
    const scenario = getDemoScenario({ owner: "acme", repo: "widget-kit", number: 43 });
    const report = await analyzePullRequest({ url: CLEAN_URL, demo: true });

    expect(scenario.url).toBe(CLEAN_URL);
    expect(report.summary.verdict).toBe("pass");
    expect(report.summary.fail).toBe(0);
    expect(report.summary.needsReview).toBe(0);
    expect(report.summary.pass).toBe(report.findings.length);
    expect(report.findings.every((finding) => finding.status === "pass")).toBe(true);
    expect(report.pendingRules).toEqual([]);
    expect(report.remediationPrompt).toContain(
      "No failed or unresolved requirements were detected",
    );
    expect(report.remediationPrompt).toContain("None. Do not invent work to fill this section.");
  });

  it("runs without network access or credentials", async () => {
    const keys = ["GITHUB_TOKEN", "INFERENCE_BASE_URL", "INFERENCE_API_KEY", "INFERENCE_MODEL"] as const;
    const saved = new Map<string, string | undefined>();
    for (const key of keys) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }

    const originalFetch = globalThis.fetch;
    let networkCalls = 0;
    globalThis.fetch = (() => {
      networkCalls += 1;
      throw new Error("network access is forbidden in the demo test");
    }) as unknown as typeof fetch;

    try {
      for (const scenario of DEMO_SCENARIOS) {
        const report = await analyzePullRequest({ url: scenario.url, demo: true });
        expect(report.mode).toBe("demo");
      }
    } finally {
      globalThis.fetch = originalFetch;
      for (const key of keys) {
        const value = saved.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }

    expect(networkCalls).toBe(0);
  });
});

describe("checked-in sample report", () => {
  it("matches a fresh run of the failing demo fixture", async () => {
    const sample = readSampleReport();
    const fresh = await analyzePullRequest({ url: FAILING_URL, demo: true });
    expect(stable(fresh)).toEqual(stable(sample));
  });

  it("is a demo report that carries the required demo beats", () => {
    const sample = readSampleReport();

    expect(sample.schema).toBe("pr-passport.report.v1");
    expect(sample.mode).toBe("demo");
    expect(sample.summary.verdict).toBe("fail");
    expect(sample.findings.some((finding) => finding.origin === "deterministic" && finding.status === "fail")).toBe(
      true,
    );
    expect(sample.findings.some((finding) => finding.origin === "recorded_fixture")).toBe(true);
    expect(sample.findings.some((finding) => finding.status === "needs_review")).toBe(true);
    expect(sample.limitations.join(" ")).toContain("not GitHub");
    expect(sample.limitations.join(" ")).toContain("no inference endpoint was called");
    expect(sample.remediationPrompt).toContain("## Validation commands");
    expect(sample.remediationPrompt).not.toContain("undefined");
  });
});