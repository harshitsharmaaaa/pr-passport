import { z } from "zod";

export const MODEL_FINDING_STATUSES = ["pass", "fail", "needs_review"] as const;

export const modelEvidenceSchema = z
  .object({
    kind: z.enum(["file", "commit", "title", "body", "ci", "metadata"]),
    ref: z.string().min(1).max(300),
    note: z.string().min(1).max(400),
  })
  .strict();

export const modelFindingSchema = z
  .object({
    ruleId: z.string().min(1).max(160),
    status: z.enum(MODEL_FINDING_STATUSES),
    rationale: z.string().min(1).max(700),
    confidence: z.number().min(0).max(1).optional(),
    evidence: z.array(modelEvidenceSchema).max(6),
  })
  .strict();

export const modelResponseSchema = z
  .object({
    findings: z.array(modelFindingSchema).max(12),
    notes: z.array(z.string().min(1).max(300)).max(6).optional(),
  })
  .strict();

export type ModelEvidence = z.infer<typeof modelEvidenceSchema>;
export type ModelFinding = z.infer<typeof modelFindingSchema>;
export type ModelResponse = z.infer<typeof modelResponseSchema>;

export interface GroundingContext {
  rules: { id: string; title: string }[];
  files: string[];
  commits: { sha: string; shortSha: string }[];
  hasCi: boolean;
}

export interface ValidatedEvidence extends ModelEvidence {
  /** Resolved canonical reference (full commit sha, normalised file path, etc.). */
  resolved: string;
}

export interface ValidatedFinding {
  ruleId: string;
  ruleTitle: string;
  status: ModelFinding["status"];
  rationale: string;
  confidence?: number;
  evidence: ValidatedEvidence[];
}

export interface ValidationIssue {
  code:
    | "invalid_schema"
    | "unknown_rule"
    | "duplicate_rule"
    | "unknown_evidence"
    | "downgraded_no_evidence"
    | "empty_response"
    | "too_many_findings";
  message: string;
  ruleId?: string;
}

export interface ValidationResult {
  findings: ValidatedFinding[];
  notes: string[];
  issues: ValidationIssue[];
}

const METADATA_KEYS = new Set([
  "title",
  "body",
  "description",
  "changed_files",
  "files_changed",
  "additions",
  "deletions",
  "commits",
  "base_ref",
  "head_ref",
  "draft",
  "author",
  "state",
  "mergeable",
  "mergeable_state",
  "labels",
  "ci",
]);

export function formatSchemaIssues(error: z.ZodError, limit = 4): string[] {
  return error.issues.slice(0, limit).map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    return `${path}: ${issue.message}`;
  });
}

function sanitizeText(value: string, max: number): string {
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function normaliseFileRef(ref: string): string {
  return ref.trim().replace(/^\.?\//, "").replace(/\\/g, "/");
}

function resolveCommitRef(ref: string, commits: GroundingContext["commits"]): string | null {
  const value = ref.trim().toLowerCase();
  if (!/^[a-f0-9]{7,40}$/.test(value)) return null;
  const match = commits.find(
    (commit) =>
      commit.sha.toLowerCase() === value ||
      commit.shortSha.toLowerCase() === value ||
      (value.length >= 7 && commit.sha.toLowerCase().startsWith(value)),
  );
  return match?.sha ?? null;
}

function resolveMetadataRef(ref: string): string | null {
  const value = ref.trim().toLowerCase().replace(/^pull_request\./, "").replace(/\s+/g, "_");
  return METADATA_KEYS.has(value) ? value : null;
}

/**
 * Validate model output against the schema *and* against the analysis's own
 * evidence. Anything the model cannot ground is removed; a claim with no
 * surviving evidence is downgraded to `needs_review`.
 */
export function validateModelResponse(raw: unknown, ctx: GroundingContext): ValidationResult {
  const issues: ValidationIssue[] = [];
  const parsed = modelResponseSchema.safeParse(raw);

  if (!parsed.success) {
    return {
      findings: [],
      notes: [],
      issues: [
        {
          code: "invalid_schema",
          message: `Model output did not match the required schema: ${formatSchemaIssues(parsed.error).join("; ")}`,
        },
      ],
    };
  }

  if (parsed.data.findings.length === 0 && ctx.rules.length > 0) {
    issues.push({
      code: "empty_response",
      message: "The model returned no findings for the supplied rules.",
    });
  }

  const ruleTitles = new Map(ctx.rules.map((rule) => [rule.id, rule.title]));
  const fileSet = new Set(ctx.files.map(normaliseFileRef));
  const seen = new Set<string>();
  const findings: ValidatedFinding[] = [];

  for (const finding of parsed.data.findings) {
    if (findings.length >= 12) {
      issues.push({ code: "too_many_findings", message: "Model returned more than 12 findings; extras were discarded." });
      break;
    }

    const ruleTitle = ruleTitles.get(finding.ruleId);
    if (!ruleTitle) {
      issues.push({
        code: "unknown_rule",
        message: `Discarded finding for rule "${sanitizeText(finding.ruleId, 80)}", which was not supplied in the prompt.`,
        ruleId: finding.ruleId,
      });
      continue;
    }
    if (seen.has(finding.ruleId)) {
      issues.push({
        code: "duplicate_rule",
        message: `Discarded a duplicate finding for rule "${sanitizeText(finding.ruleId, 80)}".`,
        ruleId: finding.ruleId,
      });
      continue;
    }
    seen.add(finding.ruleId);

    const evidence: ValidatedEvidence[] = [];
    for (const item of finding.evidence) {
      const note = sanitizeText(item.note, 400);
      if (!note) continue;

      if (item.kind === "file") {
        const path = normaliseFileRef(item.ref);
        if (!fileSet.has(path)) {
          issues.push({
            code: "unknown_evidence",
            message: `Dropped file evidence "${sanitizeText(path, 120)}" because it is not a changed file in this pull request.`,
            ruleId: finding.ruleId,
          });
          continue;
        }
        evidence.push({ ...item, note, resolved: path });
        continue;
      }

      if (item.kind === "commit") {
        const sha = resolveCommitRef(item.ref, ctx.commits);
        if (!sha) {
          issues.push({
            code: "unknown_evidence",
            message: "Dropped commit evidence that does not match a commit in this pull request.",
            ruleId: finding.ruleId,
          });
          continue;
        }
        evidence.push({ ...item, note, resolved: sha });
        continue;
      }

      if (item.kind === "title" || item.kind === "body") {
        const ref = item.ref.trim().toLowerCase();
        const allowed =
          item.kind === "title"
            ? ref === "title" || ref === "pull_request.title"
            : ref === "body" || ref === "pull_request.body" || ref === "description";
        if (!allowed) {
          issues.push({
            code: "unknown_evidence",
            message: `Dropped ${item.kind} evidence with an unrecognised reference.`,
            ruleId: finding.ruleId,
          });
          continue;
        }
        evidence.push({ ...item, note, resolved: item.kind });
        continue;
      }

      if (item.kind === "ci") {
        if (!ctx.hasCi) {
          issues.push({
            code: "unknown_evidence",
            message: "Dropped CI evidence because no CI checks were available for this pull request.",
            ruleId: finding.ruleId,
          });
          continue;
        }
        evidence.push({ ...item, note, resolved: sanitizeText(item.ref, 120) || "ci" });
        continue;
      }

      const key = resolveMetadataRef(item.ref);
      if (!key) {
        issues.push({
          code: "unknown_evidence",
          message: `Dropped metadata evidence "${sanitizeText(item.ref, 60)}", which is not an allowed field.`,
          ruleId: finding.ruleId,
        });
        continue;
      }
      evidence.push({ ...item, note, resolved: key });
    }

    let status = finding.status;
    let rationale = sanitizeText(finding.rationale, 700);
    if ((status === "pass" || status === "fail") && evidence.length === 0) {
      status = "needs_review";
      rationale = `${rationale} No valid evidence could be attached, so this was downgraded to human review.`;
      issues.push({
        code: "downgraded_no_evidence",
        message: `Downgraded rule "${sanitizeText(finding.ruleId, 80)}" to needs_review because it had no grounded evidence.`,
        ruleId: finding.ruleId,
      });
    }

    findings.push({
      ruleId: finding.ruleId,
      ruleTitle,
      status,
      rationale,
      confidence: finding.confidence,
      evidence: evidence.slice(0, 6),
    });
  }

  return {
    findings,
    notes: (parsed.data.notes ?? []).map((note) => sanitizeText(note, 300)).filter(Boolean).slice(0, 6),
    issues,
  };
}

/** Pull a JSON object out of a model response that may contain prose or fences. */
export function extractJsonObject(content: string): unknown {
  const text = content.trim();
  if (!text) throw new Error("The model returned an empty response.");
  if (text.length > 100_000) throw new Error("The model response was unexpectedly large.");

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error("The model response did not contain a JSON object.");
  }
  const slice = candidate.slice(start, end + 1);
  try {
    return JSON.parse(slice);
  } catch {
    throw new Error("The model response contained malformed JSON.");
  }
}