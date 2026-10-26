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
});