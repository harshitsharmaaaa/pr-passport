import type { FreeformInput, FreeformInterpreter, FreeformInterpretation } from "../model/interpreter";
import { validateModelResponse, type ModelEvidence } from "../model/schema";

export interface RecordedModelFinding {
  /** Matched case-insensitively against the extracted rule title. */
  heading: string;
  status: "pass" | "fail" | "needs_review";
  rationale: string;
  confidence: number;
  evidence: ModelEvidence[];
}

export interface RecordedModelRun {
  model: string;
  findings: RecordedModelFinding[];
  notes?: string[];
}

/**
 * A deterministic stand-in for the inference endpoint. It emits the same JSON
 * shape as a live model and goes through the same strict validation, so demo
 * reports exercise the real code path but never claim a model was called.
 */
export function createRecordedInterpreter(run: RecordedModelRun): FreeformInterpreter {
  return {
    async interpret(input: FreeformInput): Promise<FreeformInterpretation> {
      const rawFindings: Record<string, unknown>[] = [];

      for (const rule of input.rules) {
        const recorded = run.findings.find(
          (candidate) => candidate.heading.toLowerCase() === rule.title.toLowerCase(),
        );
        if (!recorded) continue;
        rawFindings.push({
          ruleId: rule.id,
          status: recorded.status,
          rationale: recorded.rationale,
          confidence: recorded.confidence,
          evidence: recorded.evidence,
        });
      }

      const raw = {
        findings: rawFindings,
        notes: run.notes ?? [],
      };

      const result = validateModelResponse(raw, {
        rules: input.rules.map((rule) => ({ id: rule.id, title: rule.title })),
        files: input.files.map((file) => file.filename),
        commits: input.commits.map((commit) => ({ sha: commit.sha, shortSha: commit.shortSha })),
        hasCi: input.ci.available,
        ciChecks: [...input.ci.failing, ...input.ci.pending, ...(input.ci.passing ?? [])].map(
          (check) => check.name,
        ),
      });

      return {
        findings: result.findings,
        notes: result.notes,
        issues: result.issues,
        meta: {
          mode: "recorded_fixture",
          model: run.model,
          rejectedFindings: result.issues.filter((issue) =>
            ["unknown_rule", "unknown_evidence", "duplicate_rule", "downgraded_no_evidence"].includes(issue.code),
          ).length,
        },
      };
    },
  };
}