import { createDemoSource, getDemoScenario } from "./demo/fixtures";
import { createRecordedInterpreter } from "./demo/recorded";
import { AnalysisError } from "./errors";
import { createGithubSource } from "./github/client";
import {
  CONTRIBUTING_CANDIDATES,
  TEMPLATE_CANDIDATES,
  loadGuidelines,
  type GuidelinesBundle,
} from "./guidelines";
import { truncate } from "./markdown";
import {
  interpretFreeformRules,
  readInferenceConfig,
  type FreeformInterpreter,
  type InferenceConfig,
} from "./model/interpreter";
import type { ValidatedEvidence, ValidatedFinding } from "./model/schema";
import { parsePullRequestUrl } from "./pr-url";
import { MAX_BODY_CHARS_FOR_MODEL, MAX_FILES_FOR_MODEL, MAX_COMMITS_FOR_MODEL } from "./limits";
import { assembleReport, type ReportInput } from "./report/assemble";
import { evaluateRules, type EvaluationContext } from "./rules/evaluate";
import { buildRuleSpecs, type RuleSpec } from "./rules/spec";
import type {
  AnalysisMode,
  ChangedFile,
  CiSummary,
  CommitSummary,
  Evidence,
  Finding,
  FindingOrigin,
  FindingStatus,
  ModelMeta,
  PendingRule,
  PullRequestData,
  PullRequestSource,
  RepoContext,
  Report,
} from "./types";
import { deriveValidationCommands } from "./validation";

export interface AnalyzeOptions {
  url: string;
  demo?: boolean;
  /** Injectable source for tests; bypasses environment configuration. */
  source?: PullRequestSource;
  /** `null` disables inference; `undefined` auto-detects. */
  interpreter?: FreeformInterpreter | null;
  now?: () => Date;
}

interface Runtime {
  source: PullRequestSource;
  interpreter: FreeformInterpreter | null;
  demo: boolean;
  limitation?: string;
  modelName?: string;
}

function emptyRepoContext(): RepoContext {
  return {
    files: [],
    hasPyproject: false,
    hasCargo: false,
    hasGoMod: false,
    hasMakefile: false,
  };
}

function emptyGuidelines(reason: string): GuidelinesBundle {
  return {
    files: [],
    docs: [],
    missing: [...CONTRIBUTING_CANDIDATES, ...TEMPLATE_CANDIDATES],
    unavailable: [{ path: "contribution guidelines", reason }],
  };
}

function createModelInterpreter(config: InferenceConfig): FreeformInterpreter {
  return {
    interpret: (input) => interpretFreeformRules(input, config),
  };
}

async function resolveRuntime(ref: ReturnType<typeof parsePullRequestUrl>, options: AnalyzeOptions): Promise<Runtime> {
  if (options.source) {
    return {
      source: options.source,
      interpreter: options.interpreter ?? null,
      demo: options.demo === true,
    };
  }

  const demoEnabled = process.env.DEMO_MODE === "on" || options.demo === true;
  if (demoEnabled) {
    let scenario;
    try {
      scenario = getDemoScenario(ref);
    } catch {
      throw new AnalysisError(
        "demo_not_found",
        "Demo mode only has fixtures for the sample pull requests.",
        {
          status: 400,
          hint: "Use one of the demo buttons, or turn off demo mode to analyse a real GitHub pull request.",
        },
      );
    }
    return {
      source: createDemoSource(scenario),
      interpreter:
        options.interpreter === undefined
          ? createRecordedInterpreter(scenario.recording)
          : options.interpreter,
      demo: true,
      limitation:
        "Demo mode: repository, pull request and CI data come from bundled fixtures, not GitHub. Model findings are a recorded sample; no inference endpoint was called.",
      modelName: scenario.recording.model,
    };
  }

  let interpreter = options.interpreter;
  let modelName: string | undefined;
  let limitation: string | undefined;

  if (interpreter === undefined) {
    try {
      const config = readInferenceConfig();
      if (config) {
        interpreter = createModelInterpreter(config);
        modelName = config.model;
      } else {
        interpreter = null;
      }
    } catch (error) {
      interpreter = null;
      limitation = `Inference configuration is invalid: ${error instanceof Error ? error.message : "unknown error"} Free-form guidance was not evaluated.`;
    }
  }

  return {
    source: createGithubSource({ token: process.env.GITHUB_TOKEN }),
    interpreter: interpreter ?? null,
    demo: false,
    limitation,
    modelName,
  };
}

function reasonFor(error: unknown): string {
  if (error instanceof AnalysisError) return error.message;
  return "The GitHub request failed.";
}

function defaultModelMeta(requested: boolean): ModelMeta {
  return {
    requested,
    used: false,
    mode: "none",
    rejectedFindings: 0,
    notes: [],
  };
}

function metadataLabel(key: string): string {
  const label = key.replace(/_/g, " ");
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function mapModelEvidence(
  evidence: ValidatedEvidence,
  pr: PullRequestData,
  commits: CommitSummary[],
  ci: CiSummary,
): Evidence {
  switch (evidence.kind) {
    case "file":
      return { kind: "file", label: evidence.resolved, detail: evidence.note, path: evidence.resolved };
    case "commit": {
      const commit = commits.find((candidate) => candidate.sha === evidence.resolved);
      return {
        kind: "commit",
        label: `Commit ${commit?.shortSha ?? evidence.resolved.slice(0, 7)}`,
        detail: evidence.note,
        url: `${pr.url}/commits/${evidence.resolved}`,
      };
    }
    case "title":
      return { kind: "title", label: "Pull request title", detail: evidence.note };
    case "body":
      return { kind: "body", label: "Pull request description", detail: evidence.note };
    case "ci":
      return {
        kind: "ci",
        label: `Check: ${evidence.resolved}`,
        detail: evidence.note,
        url: ci.sourceUrl,
      };
    case "metadata":
      return { kind: "metadata", label: metadataLabel(evidence.resolved), detail: evidence.note };
  }
}

function mapModelFinding(
  validated: ValidatedFinding,
  spec: RuleSpec,
  origin: FindingOrigin,
  pr: PullRequestData,
  commits: CommitSummary[],
  ci: CiSummary,
): Finding {
  let status: FindingStatus = validated.status;
  let rationale = validated.rationale;

  if (status !== "needs_review" && validated.confidence !== undefined && validated.confidence < 0.5) {
    status = "needs_review";
    rationale = `${rationale} The model's confidence was below 0.5, so this needs a human decision.`;
  }

  const remediation =
    status === "fail"
      ? `Update the pull request so it satisfies: ${truncate(spec.requirement, 220)} Re-run PR Passport after pushing.`
      : status === "needs_review"
        ? "Ask a maintainer to confirm or waive this requirement; it could not be verified automatically."
        : undefined;

  return {
    id: validated.ruleId,
    title: spec.title,
    requirement: spec.requirement,
    status,
    origin,
    source: spec.source,
    evidence: validated.evidence.map((evidence) => mapModelEvidence(evidence, pr, commits, ci)),
    rationale,
    confidence: validated.confidence,
    remediation,
  };
}

function pendingFor(specs: RuleSpec[], reason: string): PendingRule[] {
  return specs.map((spec) => ({
    id: spec.id,
    title: spec.title,
    requirement: spec.requirement,
    source: spec.source,
    reason,
  }));
}

export async function analyzePullRequest(options: AnalyzeOptions): Promise<Report> {
  const startedAt = Date.now();
  const generatedAt = options.now?.() ?? new Date();
  const ref = parsePullRequestUrl(options.url);
  const runtime = await resolveRuntime(ref, options);
  const mode: AnalysisMode = runtime.demo ? "demo" : "live";
  const limitations: string[] = [];
  if (runtime.limitation) limitations.push(runtime.limitation);

  const pr = await runtime.source.getPullRequest(ref);

  const [filesResult, commitsResult, ciResult, repoResult, guidelinesResult] = await Promise.allSettled([
    runtime.source.getChangedFiles(ref),
    runtime.source.getCommits(ref),
    runtime.source.getCi(ref, pr.headSha),
    runtime.source.getRepoContext(ref.owner, ref.repo, pr.baseSha),
    loadGuidelines(runtime.source, ref.owner, ref.repo, pr.baseSha),
  ]);

  const files: ChangedFile[] =
    filesResult.status === "fulfilled" ? filesResult.value : [];
  if (filesResult.status === "rejected") {
    limitations.push(
      `Changed files could not be listed: ${reasonFor(filesResult.reason)} Checks that depend on file paths are marked for human review.`,
    );
  }

  const commits: CommitSummary[] =
    commitsResult.status === "fulfilled" ? commitsResult.value : [];
  if (commitsResult.status === "rejected") {
    limitations.push(
      `Commits could not be listed: ${reasonFor(commitsResult.reason)} Commit-based checks are marked for human review.`,
    );
  }

  const ci: CiSummary =
    ciResult.status === "fulfilled"
      ? ciResult.value
      : {
          available: false,
          reason: reasonFor(ciResult.reason),
          state: "unknown",
          total: 0,
          successful: 0,
          failing: [],
          pending: [],
          sourceUrl: `${pr.url}/checks`,
        };

  const repo: RepoContext =
    repoResult.status === "fulfilled" ? repoResult.value : emptyRepoContext();
  if (repoResult.status === "rejected") {
    limitations.push(
      `Repository files could not be listed: ${reasonFor(repoResult.reason)} Validation commands were derived from the guidelines only.`,
    );
  }

  const guidelines: GuidelinesBundle =
    guidelinesResult.status === "fulfilled"
      ? guidelinesResult.value
      : emptyGuidelines(reasonFor(guidelinesResult.reason));

  if (guidelines.files.length === 0) {
    limitations.push(
      `No contribution guidelines were found at the base commit (checked ${guidelines.missing.slice(0, 6).join(", ")}). Only platform checks were evaluated.`,
    );
  }
  for (const unavailable of guidelines.unavailable) {
    limitations.push(`Could not read ${unavailable.path}: ${unavailable.reason}`);
  }
  for (const file of guidelines.files) {
    if (file.truncated) {
      limitations.push(`${file.path} was truncated at 60,000 characters; rules after that point were not read.`);
    }
  }
  if (!guidelines.template) {
    limitations.push("No pull request template was found, so template checklist requirements were not applied.");
  }
  if (!ci.available) {
    limitations.push(
      `CI status could not be read${ci.reason ? `: ${ci.reason}` : "."} No CI result is claimed.`,
    );
  } else if (ci.state === "none") {
    limitations.push("No CI checks were reported for the head commit, so CI compliance was not evaluated.");
  }
  if (pr.mergeable === null) {
    limitations.push(
      "GitHub had not finished computing mergeability when this report was generated.",
    );
  }
  if (pr.draft) {
    limitations.push("This pull request is a draft, so maintainers may not review it yet.");
  }
  if (mode === "live" && !process.env.GITHUB_TOKEN) {
    limitations.push(
      "GitHub requests were unauthenticated. Public rate limits apply (60 requests per hour); set GITHUB_TOKEN to raise them.",
    );
  }

  const ruleBundle = buildRuleSpecs(guidelines, {
    prUrl: pr.url,
    headSha: pr.headSha,
    ci,
  });

  const context: EvaluationContext = { pr, files, commits, ci, repo, guidelines };
  const deterministicFindings = evaluateRules(ruleBundle.deterministic, context);

  let modelFindings: Finding[] = [];
  let pendingRules: PendingRule[] = [];
  let model = defaultModelMeta(ruleBundle.freeform.length > 0);

  if (ruleBundle.freeform.length > 0) {
    if (!runtime.interpreter) {
      pendingRules = pendingFor(
        ruleBundle.freeform,
        "No inference endpoint is configured for this deployment.",
      );
      limitations.push(
        `${ruleBundle.freeform.length} free-form guideline rule(s) were not evaluated because no inference endpoint is configured. Set INFERENCE_BASE_URL and INFERENCE_MODEL to enable model interpretation.`,
      );
    } else {
      try {
        const interpretation = await runtime.interpreter.interpret({
          pr,
          files,
          commits,
          ci,
          rules: ruleBundle.freeform,
        });
        const specById = new Map(ruleBundle.freeform.map((spec) => [spec.id, spec]));
        const origin: FindingOrigin =
          interpretation.meta.mode === "recorded_fixture" ? "recorded_fixture" : "model";

        modelFindings = interpretation.findings.flatMap((validated) => {
          const spec = specById.get(validated.ruleId);
          if (!spec) return [];
          return [mapModelFinding(validated, spec, origin, pr, commits, ci)];
        });

        model = {
          requested: true,
          used: true,
          mode: interpretation.meta.mode,
          model: interpretation.meta.model,
          rejectedFindings: interpretation.meta.rejectedFindings,
          notes: interpretation.notes,
        };

        if (interpretation.meta.rejectedFindings > 0) {
          limitations.push(
            `${interpretation.meta.rejectedFindings} model finding(s) were discarded because the rule or evidence could not be grounded in this pull request.`,
          );
        }
        for (const issue of interpretation.issues) {
          if (issue.code === "empty_response") {
            limitations.push(
              "The model returned no findings for the free-form rules, so those rules remain unresolved.",
            );
          }
        }
      } catch (error) {
        const message = error instanceof AnalysisError ? error.message : "The model interpretation failed.";
        const hint = error instanceof AnalysisError ? error.hint : undefined;
        model = {
          requested: true,
          used: false,
          mode: "failed",
          model: runtime.modelName,
          error: message,
          rejectedFindings: 0,
          notes: [],
        };
        pendingRules = pendingFor(
          ruleBundle.freeform,
          "Model interpretation failed; this rule was not evaluated.",
        );
        limitations.push(
          `The inference endpoint failed: ${message}${hint ? ` ${hint}` : ""} Free-form guidance was not evaluated.`,
        );
      }
    }

    if (pr.body.length > MAX_BODY_CHARS_FOR_MODEL) {
      limitations.push(
        `The pull request description was truncated to ${MAX_BODY_CHARS_FOR_MODEL.toLocaleString("en-US")} characters for model interpretation.`,
      );
    }
    if (files.length > MAX_FILES_FOR_MODEL) {
      limitations.push(`Only the first ${MAX_FILES_FOR_MODEL} changed files were shown to the model.`);
    }
    if (commits.length > MAX_COMMITS_FOR_MODEL) {
      limitations.push(`Only the first ${MAX_COMMITS_FOR_MODEL} commits were shown to the model.`);
    }
  }

  const guidelineUrls: Record<string, string> = {};
  for (const file of guidelines.files) guidelineUrls[file.path] = file.url;

  const validationCommands = deriveValidationCommands({
    repo,
    docs: guidelines.docs,
    guidelineUrls,
    owner: pr.owner,
    repoName: pr.repo,
    baseSha: pr.baseSha,
  });

  if (validationCommands.length === 0) {
    limitations.push(
      "No validation commands could be derived from the repository's files. The remediation brief says so instead of guessing.",
    );
  }

  const reportInput: ReportInput = {
    mode,
    pr,
    ci,
    guidelines,
    findings: [...deterministicFindings, ...modelFindings],
    pendingRules,
    model,
    limitations,
    validationCommands,
    generatedAt,
    totalMs: Date.now() - startedAt,
  };

  return assembleReport(reportInput);
}