import { z } from "zod";
import { MAX_MODEL_RESPONSE_CHARS } from "../limits";

export const MODEL_FINDING_STATUSES = ["pass", "fail", "needs_review"] as const;

/** A model verdict below this confidence is never reported as pass/fail. */
export const MIN_CONFIDENCE_FOR_VERDICT = 0.5;

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
    // Notes are advisory, so an over-long list is truncated rather than
    // discarding otherwise valid findings.
    notes: z.array(z.string().min(1).max(300)).max(20).optional(),
  })
  .strict();

export type ModelEvidence = z.infer<typeof modelEvidenceSchema>;
export type ModelFinding = z.infer<typeof modelFindingSchema>;
export type ModelResponse = z.infer<typeof modelResponseSchema>;

export interface GroundingContext {
  /** Rules that were actually supplied to the model. */
  rules: { id: string; title: string }[];
  /** Changed files that were actually shown to the model. */
  files: string[];
  /** Commits that were actually shown to the model. */
  commits: { sha: string; shortSha: string }[];
  hasCi: boolean;
  /**
   * Optional. When `false`, `body` evidence cannot be grounded because the pull
   * request has no description. Omit it when the caller does not know.
   */
  hasBody?: boolean;
  /** Optional. Same as `hasBody`, for the pull request title. */
  hasTitle?: boolean;
  /**
   * Optional. Names of checks GitHub actually reported for the head commit, so
   * a named CI claim can be verified or dropped.
   */
  ciChecks?: string[];
  /**
   * Optional. Rules whose guideline is conditional ("when a public API
   * changes"). The model may not turn those into a hard failure, because the
   * condition itself cannot be verified from the dossier.
   */
  conditionalRuleIds?: string[];
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
    | "low_confidence"
    | "empty_rationale"
    | "conditional_requires_review"
    | "missing_rule"
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

/** More conservative statuses win when a rule is reported twice. */
const STATUS_RANK: Record<ModelFinding["status"], number> = {
  fail: 0,
  needs_review: 1,
  pass: 2,
};

const FALLBACK_RATIONALE = "The model did not give a usable explanation for this finding.";

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

/** Refs that describe CI as a whole rather than naming a specific check. */
const GENERIC_CI_REFS = new Set([
  "ci",
  "check",
  "checks",
  "status",
  "statuses",
  "all checks",
  "combined status",
  "check run",
  "check runs",
  "check-runs",
]);

/**
 * A named check must match a check GitHub actually reported; otherwise the
 * model could invent a green "deploy-to-production" run and carry a PASS with
 * fabricated evidence.
 */
function resolveCiRef(ref: string, ctx: GroundingContext): string | null {
  const value = ref.trim().toLowerCase().replace(/\s+/g, " ");
  if (!value) return null;
  if (GENERIC_CI_REFS.has(value)) return "ci";
  const known = (ctx.ciChecks ?? []).find(
    (name) => name.trim().toLowerCase().replace(/\s+/g, " ") === value,
  );
  return known ? known.trim() : null;
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
  const indexByRule = new Map<string, number>();
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

    const evidence: ValidatedEvidence[] = [];
    const seenEvidence = new Set<string>();

    for (const item of finding.evidence) {
      const note = sanitizeText(item.note, 400);
      if (!note) continue;

      let resolved: string | null = null;

      if (item.kind === "file") {
        const path = normaliseFileRef(item.ref);
        if (!fileSet.has(path)) {
          issues.push({
            code: "unknown_evidence",
            message: `Dropped file evidence "${sanitizeText(path, 120)}" because it is not a changed file shown for this pull request.`,
            ruleId: finding.ruleId,
          });
          continue;
        }
        resolved = path;
      } else if (item.kind === "commit") {
        const sha = resolveCommitRef(item.ref, ctx.commits);
        if (!sha) {
          issues.push({
            code: "unknown_evidence",
            message: "Dropped commit evidence that does not match a commit in this pull request.",
            ruleId: finding.ruleId,
          });
          continue;
        }
        resolved = sha;
      } else if (item.kind === "title" || item.kind === "body") {
        const ref = item.ref.trim().toLowerCase();
        const emptyText =
          (item.kind === "title" && ctx.hasTitle === false) || (item.kind === "body" && ctx.hasBody === false);
        const allowed =
          item.kind === "title"
            ? ref === "title" || ref === "pull_request.title"
            : ref === "body" || ref === "pull_request.body" || ref === "description";
        if (!allowed || emptyText) {
          issues.push({
            code: "unknown_evidence",
            message: emptyText
              ? `Dropped ${item.kind} evidence because the pull request has no ${item.kind} text to ground it in.`
              : `Dropped ${item.kind} evidence with an unrecognised reference.`,
            ruleId: finding.ruleId,
          });
          continue;
        }
        resolved = item.kind;
      } else if (item.kind === "ci") {
        if (!ctx.hasCi) {
          issues.push({
            code: "unknown_evidence",
            message: "Dropped CI evidence because no CI checks were available for this pull request.",
            ruleId: finding.ruleId,
          });
          continue;
        }
        const resolvedCi = resolveCiRef(item.ref, ctx);
        if (!resolvedCi) {
          issues.push({
            code: "unknown_evidence",
            message: `Dropped CI evidence for "${sanitizeText(item.ref, 80)}" because this pull request reported no such check.`,
            ruleId: finding.ruleId,
          });
          continue;
        }
        resolved = resolvedCi;
      } else {
        const key = resolveMetadataRef(item.ref);
        const emptyText =
          (key === "title" && ctx.hasTitle === false) ||
          ((key === "body" || key === "description") && ctx.hasBody === false);
        if (!key || (key === "ci" && !ctx.hasCi) || emptyText) {
          issues.push({
            code: "unknown_evidence",
            message: emptyText
              ? "Dropped metadata evidence because the pull request field it points at is empty."
              : key
                ? "Dropped CI metadata evidence because no CI checks were available for this pull request."
                : `Dropped metadata evidence "${sanitizeText(item.ref, 60)}", which is not an allowed field.`,
            ruleId: finding.ruleId,
          });
          continue;
        }
        resolved = key;
      }

      const dedupeKey = `${item.kind}:${resolved}`;
      if (seenEvidence.has(dedupeKey)) continue;
      seenEvidence.add(dedupeKey);
      evidence.push({ ...item, note, resolved });
    }

    let status = finding.status;
    let rationale = sanitizeText(finding.rationale, 700);
    if (!rationale) {
      rationale = FALLBACK_RATIONALE;
      if (status !== "needs_review") {
        status = "needs_review";
        issues.push({
          code: "empty_rationale",
          message: `Downgraded rule "${sanitizeText(finding.ruleId, 80)}" to needs_review because its explanation was unusable.`,
          ruleId: finding.ruleId,
        });
      }
    }

    if ((status === "pass" || status === "fail") && evidence.length === 0) {
      status = "needs_review";
      rationale = sanitizeText(`${rationale} No valid evidence could be attached, so this was downgraded to human review.`, 700);
      issues.push({
        code: "downgraded_no_evidence",
        message: `Downgraded rule "${sanitizeText(finding.ruleId, 80)}" to needs_review because it had no grounded evidence.`,
        ruleId: finding.ruleId,
      });
    }

    if (status !== "needs_review" && finding.confidence !== undefined && finding.confidence < MIN_CONFIDENCE_FOR_VERDICT) {
      status = "needs_review";
      rationale = sanitizeText(
        `${rationale} The model's confidence (${finding.confidence.toFixed(2)}) is below ${MIN_CONFIDENCE_FOR_VERDICT}, so a human should decide.`,
        700,
      );
      issues.push({
        code: "low_confidence",
        message: `Downgraded rule "${sanitizeText(finding.ruleId, 80)}" to needs_review because the model's confidence was below ${MIN_CONFIDENCE_FOR_VERDICT}.`,
        ruleId: finding.ruleId,
      });
    }

    // A conditional guideline may not apply to this pull request at all, and
    // the model cannot prove that it does. A hard failure is therefore never
    // accepted from the model for those rules.
    if (status === "fail" && ctx.conditionalRuleIds?.includes(finding.ruleId)) {
      status = "needs_review";
      rationale = sanitizeText(
        `${rationale} This guideline is conditional, so a maintainer must confirm the condition applies before it can count as a failure.`,
        700,
      );
      issues.push({
        code: "conditional_requires_review",
        message: `Downgraded conditional rule "${sanitizeText(finding.ruleId, 80)}" to needs_review; the model cannot prove the condition applies.`,
        ruleId: finding.ruleId,
      });
    }

    const candidate: ValidatedFinding = {
      ruleId: finding.ruleId,
      ruleTitle,
      status,
      rationale,
      confidence: finding.confidence,
      evidence: evidence.slice(0, 6),
    };

    const existingIndex = indexByRule.get(finding.ruleId);
    if (existingIndex === undefined) {
      indexByRule.set(finding.ruleId, findings.length);
      findings.push(candidate);
      continue;
    }

    issues.push({
      code: "duplicate_rule",
      message: `Merged a duplicate finding for rule "${sanitizeText(finding.ruleId, 80)}"; the most conservative status wins.`,
      ruleId: finding.ruleId,
    });
    const existing = findings[existingIndex];
    if (existing && STATUS_RANK[candidate.status] < STATUS_RANK[existing.status]) {
      findings[existingIndex] = candidate;
    }
  }

  return {
    findings,
    notes: (parsed.data.notes ?? []).map((note) => sanitizeText(note, 300)).filter(Boolean).slice(0, 6),
    issues,
  };
}

interface ScanResult {
  value: unknown;
  /** A `{` was opened and never closed before the text ended. */
  incomplete: boolean;
  /** A balanced object-shaped span was found but did not parse. */
  malformed: boolean;
}

/** Find the first balanced `{...}` span in `text` that parses as a JSON object. */
function scanForJsonObject(text: string): ScanResult {
  let sawOpenBrace = false;
  let sawIncomplete = false;
  let sawMalformed = false;
  // Bound the work so a hostile response full of braces cannot stall the app.
  let budget = 400_000;
  let starts = 0;

  for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
    if (starts >= 50) break;
    starts += 1;
    sawOpenBrace = true;
    let closed = false;
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let index = start; index < text.length; index += 1) {
      budget -= 1;
      if (budget <= 0) return { value: null, incomplete: sawIncomplete, malformed: sawMalformed };
      const char = text[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\" && inString) {
        escaped = true;
        continue;
      }
      if (char === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (char === "{") depth += 1;
      else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          closed = true;
          const slice = text.slice(start, index + 1);
          try {
            const value: unknown = JSON.parse(slice);
            if (value && typeof value === "object" && !Array.isArray(value)) {
              return { value, incomplete: false, malformed: false };
            }
            sawMalformed = true;
          } catch {
            // Not valid JSON: keep looking for another object.
            sawMalformed = true;
          }
          break;
        }
      }
    }

    if (!closed && depth > 0) sawIncomplete = true;
  }

  return { value: null, incomplete: sawOpenBrace && sawIncomplete, malformed: sawOpenBrace && sawMalformed };
}

/** Pull a JSON object out of a model response that may contain prose or fences. */
export function extractJsonObject(content: string): unknown {
  const text = content.trim();
  if (!text) throw new Error("The model returned an empty response.");
  if (text.length > MAX_MODEL_RESPONSE_CHARS) throw new Error("The model response was unexpectedly large.");

  const fenced = /```(?:json)?\s*([\s\S]*?)(?:```|$)/i.exec(text);
  const sources = fenced?.[1] && fenced[1].trim() !== text ? [fenced[1], text] : [text];

  let incomplete = false;
  let malformed = false;
  for (const source of sources) {
    const scan = scanForJsonObject(source);
    if (scan.value !== null) return scan.value;
    incomplete = incomplete || scan.incomplete;
    malformed = malformed || scan.malformed;
  }

  if (incomplete) {
    throw new Error("The model response was truncated or malformed: the JSON object was never closed.");
  }
  if (malformed) {
    throw new Error("The model response contained malformed JSON.");
  }
  throw new Error("The model response did not contain a JSON object.");
}