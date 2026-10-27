import { describe, expect, it } from "bun:test";
import {
  extractJsonObject,
  formatSchemaIssues,
  modelResponseSchema,
  validateModelResponse,
  type GroundingContext,
} from "./schema";
import { HEAD_SHA, OTHER_SHA } from "../test-support";

const GROUNDING: GroundingContext = {
  rules: [{ id: "freeform-1", title: "Design notes" }],
  files: ["src/api/pagination.ts", "docs/guide.md"],
  commits: [
    { sha: HEAD_SHA, shortSha: HEAD_SHA.slice(0, 7) },
    { sha: OTHER_SHA, shortSha: OTHER_SHA.slice(0, 7) },
  ],
  hasCi: true,
};

function response(findings: unknown[], notes?: string[]) {
  return { findings, notes };
}

function single(overrides: Record<string, unknown> = {}) {
  return {
    ruleId: "freeform-1",
    status: "pass",
    rationale: "The description documents the design.",
    confidence: 0.9,
    evidence: [
      { kind: "body", ref: "body", note: "Description explains the design." },
    ],
    ...overrides,
  };
}

describe("modelResponseSchema", () => {
  it("accepts a minimal well-formed response", () => {
    expect(modelResponseSchema.safeParse(response([single()])).success).toBe(true);
    expect(modelResponseSchema.safeParse({ findings: [] }).success).toBe(true);
  });

  it("rejects unknown top-level keys", () => {
    const parsed = modelResponseSchema.safeParse({ findings: [], extra: true });
    expect(parsed.success).toBe(false);
  });

  it("rejects unknown keys inside a finding", () => {
    const parsed = modelResponseSchema.safeParse(response([single({ sneaky: "value" })]));
    expect(parsed.success).toBe(false);
  });

  it("rejects invalid statuses, confidence, and evidence counts", () => {
    expect(modelResponseSchema.safeParse(response([single({ status: "maybe" })])).success).toBe(false);
    expect(modelResponseSchema.safeParse(response([single({ confidence: 1.5 })])).success).toBe(false);
    expect(
      modelResponseSchema.safeParse(
        response([
          single({
            evidence: Array.from({ length: 7 }, () => ({ kind: "body", ref: "body", note: "x" })),
          }),
        ]),
      ).success,
    ).toBe(false);
  });

  it("rejects more than twelve findings", () => {
    const findings = Array.from({ length: 13 }, () => single());
    expect(modelResponseSchema.safeParse(response(findings)).success).toBe(false);
  });
});

describe("validateModelResponse", () => {
  it("keeps a grounded finding and normalises file paths", () => {
    const result = validateModelResponse(
      response([
        single({
          evidence: [
            { kind: "file", ref: "./src/api/pagination.ts", note: "New API surface." },
          ],
        }),
      ]),
      GROUNDING,
    );
    expect(result.issues).toEqual([]);
    expect(result.findings[0]?.evidence[0]?.resolved).toBe("src/api/pagination.ts");
  });

  it("reports a schema error without returning findings", () => {
    const result = validateModelResponse({ findings: [{ nope: true }] }, GROUNDING);
    expect(result.findings).toEqual([]);
    expect(result.issues[0]?.code).toBe("invalid_schema");
    expect(result.issues[0]?.message).toContain("findings.0");
  });

  it("discards findings for rules that were never supplied", () => {
    const result = validateModelResponse(
      response([single({ ruleId: "freeform-99" })]),
      GROUNDING,
    );
    expect(result.findings).toEqual([]);
    expect(result.issues[0]?.code).toBe("unknown_rule");
  });

  it("keeps only the first finding for a duplicated rule", () => {
    const result = validateModelResponse(
      response([single({ rationale: "first" }), single({ rationale: "second" })]),
      GROUNDING,
    );
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.rationale).toBe("first");
    expect(result.issues.some((issue) => issue.code === "duplicate_rule")).toBe(true);
  });

  it("drops evidence for files that did not change", () => {
    const result = validateModelResponse(
      response([
        single({
          evidence: [{ kind: "file", ref: "src/invented.ts", note: "Made up." }],
        }),
      ]),
      GROUNDING,
    );
    expect(result.findings[0]?.status).toBe("needs_review");
    expect(result.findings[0]?.evidence).toEqual([]);
    expect(result.issues.some((issue) => issue.code === "unknown_evidence")).toBe(true);
    expect(result.issues.some((issue) => issue.code === "downgraded_no_evidence")).toBe(true);
  });

  it("keeps a failure that still has one grounded piece of evidence", () => {
    const result = validateModelResponse(
      response([
        single({
          status: "fail",
          evidence: [
            { kind: "file", ref: "src/invented.ts", note: "Made up." },
            { kind: "body", ref: "body", note: "No design notes." },
          ],
        }),
      ]),
      GROUNDING,
    );
    expect(result.findings[0]?.status).toBe("fail");
    expect(result.findings[0]?.evidence).toHaveLength(1);
  });

  it("resolves short commit shas and rejects unknown commits", () => {
    const ok = validateModelResponse(
      response([
        single({
          evidence: [{ kind: "commit", ref: HEAD_SHA.slice(0, 8), note: "Signed off." }],
        }),
      ]),
      GROUNDING,
    );
    expect(ok.findings[0]?.evidence[0]?.resolved).toBe(HEAD_SHA);

    const bad = validateModelResponse(
      response([
        single({
          evidence: [{ kind: "commit", ref: "deadbeefdeadbeef", note: "Not in this PR." }],
        }),
      ]),
      GROUNDING,
    );
    expect(bad.findings[0]?.status).toBe("needs_review");
  });

  it("normalises metadata refs and rejects unknown fields", () => {
    const ok = validateModelResponse(
      response([
        single({
          evidence: [
            { kind: "metadata", ref: "pull_request.changed_files", note: "15 files." },
          ],
        }),
      ]),
      GROUNDING,
    );
    expect(ok.findings[0]?.evidence[0]?.resolved).toBe("changed_files");

    const bad = validateModelResponse(
      response([
        single({ evidence: [{ kind: "metadata", ref: "secret_token", note: "Nope." }] }),
      ]),
      GROUNDING,
    );
    expect(bad.findings[0]?.status).toBe("needs_review");
    expect(bad.findings[0]?.evidence).toEqual([]);
  });

  it("drops CI evidence when the pull request has no CI data", () => {
    const result = validateModelResponse(
      response([single({ evidence: [{ kind: "ci", ref: "unit tests", note: "passed" }] })]),
      { ...GROUNDING, hasCi: false },
    );
    expect(result.findings[0]?.evidence).toEqual([]);
    expect(result.findings[0]?.status).toBe("needs_review");
  });

  it("requires a named CI check to be one GitHub actually reported", () => {
    const grounding = { ...GROUNDING, ciChecks: ["unit tests", "lint"] };

    const known = validateModelResponse(
      response([single({ evidence: [{ kind: "ci", ref: "Unit Tests", note: "Passed." }] })]),
      grounding,
    );
    expect(known.findings[0]?.evidence[0]?.resolved).toBe("unit tests");

    const generic = validateModelResponse(
      response([single({ evidence: [{ kind: "ci", ref: "checks", note: "All checks passed." }] })]),
      grounding,
    );
    expect(generic.findings[0]?.evidence[0]?.resolved).toBe("ci");

    const fabricated = validateModelResponse(
      response([single({ evidence: [{ kind: "ci", ref: "deploy-to-production", note: "Green." }] })]),
      grounding,
    );
    expect(fabricated.findings[0]?.evidence).toEqual([]);
    expect(fabricated.findings[0]?.status).toBe("needs_review");
    expect(fabricated.issues.some((issue) => issue.code === "unknown_evidence")).toBe(true);
  });

  it("accepts title and body references only in recognised forms", () => {
    const ok = validateModelResponse(
      response([
        single({
          evidence: [
            { kind: "title", ref: "pull_request.title", note: "Title is conventional." },
            { kind: "body", ref: "description", note: "Body links the issue." },
          ],
        }),
      ]),
      GROUNDING,
    );
    expect(ok.findings[0]?.evidence).toHaveLength(2);

    const bad = validateModelResponse(
      response([single({ evidence: [{ kind: "title", ref: "some other thing", note: "x" }] })]),
      GROUNDING,
    );
    expect(bad.findings[0]?.evidence).toEqual([]);
  });

  it("sanitises control characters and clamps text", () => {
    const result = validateModelResponse(
      response([
        single({
          rationale: `bad\u0000text ${"x".repeat(20)}`,
          evidence: [{ kind: "body", ref: "body", note: "note\u0007here" }],
        }),
      ]),
      GROUNDING,
    );
    expect(result.findings[0]?.rationale.includes("\u0000")).toBe(false);
    expect(result.findings[0]?.rationale).toContain("bad text");
    expect(result.findings[0]?.evidence[0]?.note).toBe("note here");
  });

  it("flags an empty response when rules were supplied", () => {
    const result = validateModelResponse(response([]), GROUNDING);
    expect(result.findings).toEqual([]);
    expect(result.issues[0]?.code).toBe("empty_response");
  });

  it("formats schema issues with readable paths", () => {
    const parsed = modelResponseSchema.safeParse(response([single({ status: "nope" })]));
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(formatSchemaIssues(parsed.error)[0]).toContain("findings.0.status");
    }
  });
});

describe("extractJsonObject", () => {
  it("parses bare JSON", () => {
    expect(extractJsonObject('{"findings":[]}')).toEqual({ findings: [] });
  });

  it("parses JSON inside a markdown fence", () => {
    expect(extractJsonObject('Here you go:\n```json\n{"findings":[]}\n```\n')).toEqual({
      findings: [],
    });
  });

  it("parses JSON surrounded by prose", () => {
    expect(extractJsonObject('Sure. {"findings":[],"notes":["ok"]} Hope that helps.')).toEqual({
      findings: [],
      notes: ["ok"],
    });
  });

  it("throws on empty or malformed output", () => {
    expect(() => extractJsonObject("   ")).toThrow(/empty/);
    expect(() => extractJsonObject("not json at all")).toThrow(/JSON object/);
    expect(() => extractJsonObject('{"findings": [}')).toThrow(/malformed/);
  });

  it("rejects unexpectedly large responses", () => {
    expect(() => extractJsonObject(`{"x":"${"a".repeat(100_001)}"}`)).toThrow(/large/);
  });

  it("parses an object that contains braces inside strings", () => {
    expect(extractJsonObject('{"findings":[],"notes":["use {curly} braces"]}')).toEqual({
      findings: [],
      notes: ["use {curly} braces"],
    });
  });

  it("skips a leading object that is not the answer", () => {
    expect(extractJsonObject('Example {not json} then {"findings":[]}')).toEqual({ findings: [] });
  });

  it("parses an unclosed fence", () => {
    expect(extractJsonObject('```json\n{"findings":[]}')).toEqual({ findings: [] });
  });

  it("reports truncation distinctly from malformed JSON", () => {
    expect(() => extractJsonObject('{"findings":[{"ruleId":"x"')).toThrow(/truncated/);
    expect(() => extractJsonObject('{"findings": [}')).toThrow(/malformed/);
  });

  it("does not stall on a hostile response full of braces", () => {
    const startedAt = Date.now();
    expect(() => extractJsonObject("{".repeat(100_000))).toThrow(/JSON object|truncated/);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it("rejects a bare array or scalar answer", () => {
    expect(() => extractJsonObject("[]")).toThrow(/JSON object/);
    expect(() => extractJsonObject("42")).toThrow(/JSON object/);
  });
});

describe("validateModelResponse hardening", () => {
  it("merges duplicate rules conservatively instead of trusting order", () => {
    const result = validateModelResponse(
      response([
        single({ status: "pass", rationale: "first" }),
        single({ status: "fail", rationale: "second" }),
      ]),
      GROUNDING,
    );
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.status).toBe("fail");
    expect(result.issues.some((issue) => issue.code === "duplicate_rule")).toBe(true);
  });

  it("keeps needs_review over pass when a rule is duplicated", () => {
    const result = validateModelResponse(
      response([single({ status: "pass" }), single({ status: "needs_review" })]),
      GROUNDING,
    );
    expect(result.findings[0]?.status).toBe("needs_review");
  });

  it("deduplicates repeated evidence entries", () => {
    const result = validateModelResponse(
      response([
        single({
          evidence: [
            { kind: "body", ref: "body", note: "first" },
            { kind: "body", ref: "pull_request.body", note: "second" },
          ],
        }),
      ]),
      GROUNDING,
    );
    expect(result.findings[0]?.evidence).toHaveLength(1);
  });

  it("downgrades a confident verdict built on no evidence", () => {
    const result = validateModelResponse(
      response([single({ confidence: 0.99, evidence: [] })]),
      GROUNDING,
    );
    expect(result.findings[0]?.status).toBe("needs_review");
    expect(result.findings[0]?.rationale).toContain("human review");
  });

  it("downgrades low-confidence verdicts", () => {
    const result = validateModelResponse(response([single({ confidence: 0.4 })]), GROUNDING);
    expect(result.findings[0]?.status).toBe("needs_review");
    expect(result.issues.some((issue) => issue.code === "low_confidence")).toBe(true);
  });

  it("leaves a high-confidence grounded verdict alone", () => {
    const result = validateModelResponse(response([single({ confidence: 0.9 })]), GROUNDING);
    expect(result.findings[0]?.status).toBe("pass");
    expect(result.issues).toEqual([]);
  });

  it("never accepts a hard fail for a conditional rule", () => {
    const result = validateModelResponse(response([single({ status: "fail" })]), {
      ...GROUNDING,
      conditionalRuleIds: ["freeform-1"],
    });
    expect(result.findings[0]?.status).toBe("needs_review");
    expect(result.findings[0]?.rationale).toContain("conditional");
    expect(result.issues.some((issue) => issue.code === "conditional_requires_review")).toBe(true);
  });

  it("still accepts a conditional rule that passes", () => {
    const result = validateModelResponse(response([single({ status: "pass" })]), {
      ...GROUNDING,
      conditionalRuleIds: ["freeform-1"],
    });
    expect(result.findings[0]?.status).toBe("pass");
  });

  it("does not invent evidence when the body is empty", () => {
    const result = validateModelResponse(response([single()]), { ...GROUNDING, hasBody: false });
    expect(result.findings[0]?.evidence).toEqual([]);
    expect(result.findings[0]?.status).toBe("needs_review");
  });

  it("does not invent evidence when the title is empty", () => {
    const result = validateModelResponse(
      response([single({ evidence: [{ kind: "title", ref: "title", note: "Title." }] })]),
      { ...GROUNDING, hasTitle: false },
    );
    expect(result.findings[0]?.evidence).toEqual([]);
  });

  it("rejects ci metadata evidence when no CI exists", () => {
    const result = validateModelResponse(
      response([single({ evidence: [{ kind: "metadata", ref: "ci", note: "Green." }] })]),
      { ...GROUNDING, hasCi: false },
    );
    expect(result.findings[0]?.evidence).toEqual([]);
    expect(result.issues.some((issue) => issue.code === "unknown_evidence")).toBe(true);
  });

  it("does not ground a file that was not shown to the model", () => {
    const result = validateModelResponse(
      response([single({ evidence: [{ kind: "file", ref: "src/api/pagination.ts", note: "x" }] })]),
      { ...GROUNDING, files: [] },
    );
    expect(result.findings[0]?.evidence).toEqual([]);
  });

  it("does not ground a commit that was not shown to the model", () => {
    const result = validateModelResponse(
      response([single({ evidence: [{ kind: "commit", ref: HEAD_SHA, note: "x" }] })]),
      { ...GROUNDING, commits: [] },
    );
    expect(result.findings[0]?.evidence).toEqual([]);
  });

  it("downgrades a verdict whose rationale is only control characters", () => {
    const result = validateModelResponse(response([single({ rationale: "\u0000\u0001\u0002" })]), GROUNDING);
    expect(result.findings[0]?.status).toBe("needs_review");
    expect(result.findings[0]?.rationale.length).toBeGreaterThan(0);
    expect(result.issues.some((issue) => issue.code === "empty_rationale")).toBe(true);
  });

  it("reports an empty response only when rules were supplied", () => {
    expect(validateModelResponse(response([]), GROUNDING).issues[0]?.code).toBe("empty_response");
    expect(validateModelResponse(response([]), { ...GROUNDING, rules: [] }).issues).toEqual([]);
  });

  it("keeps a needs_review finding that has no evidence", () => {
    const result = validateModelResponse(
      response([single({ status: "needs_review", evidence: [] })]),
      GROUNDING,
    );
    expect(result.findings[0]?.status).toBe("needs_review");
    expect(result.issues.some((issue) => issue.code === "downgraded_no_evidence")).toBe(false);
  });

  it("ignores a model that tries to smuggle extra keys through evidence", () => {
    const result = validateModelResponse(
      response([
        single({
          evidence: [{ kind: "body", ref: "body", note: "x", url: "https://evil.example" }],
        }),
      ]),
      GROUNDING,
    );
    expect(result.findings).toEqual([]);
    expect(result.issues[0]?.code).toBe("invalid_schema");
  });

  it("sanitises notes and caps them", () => {
    const result = validateModelResponse(
      response([single()], ["ok\u0000note", ...Array.from({ length: 10 }, (_, index) => `note ${index}`)]),
      GROUNDING,
    );
    expect(result.notes).toHaveLength(6);
    expect(result.notes[0]).toBe("ok note");
  });
});