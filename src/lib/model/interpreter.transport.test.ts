import { describe, expect, it } from "bun:test";
import { AnalysisError } from "../errors";
import { HEAD_SHA, makeCi, makeCommit, makeFile, makePr, makeSpec } from "../test-support";
import {
  interpretFreeformRules,
  readInferenceConfig,
  type FreeformInput,
  type InferenceConfig,
} from "./interpreter";

/*
 * Transport-level coverage for the OpenAI-compatible interpreter. Every
 * request is served by an in-process scripted fetch: no API key, no live
 * endpoint, no timers longer than a few milliseconds.
 */

function rule(id = "freeform-1") {
  return makeSpec("freeform", {
    id,
    title: "Review process",
    requirement: "Keep pull requests focused so a reviewer can understand the change in one sitting.",
    source: {
      kind: "repository_file",
      label: "CONTRIBUTING.md - Review process",
      path: "CONTRIBUTING.md",
      lineStart: 18,
      lineEnd: 20,
      excerpt: "Keep pull requests focused.",
    },
  });
}

function input(overrides: Partial<FreeformInput> = {}): FreeformInput {
  return {
    pr: makePr(),
    files: [makeFile("src/api/widgets.ts", 30, 8)],
    commits: [makeCommit(HEAD_SHA, "feat: add pagination\n\nSigned-off-by: Dev User <dev@example.com>")],
    ci: makeCi(),
    rules: [rule()],
    ...overrides,
  };
}

function config(overrides: Partial<InferenceConfig> = {}): InferenceConfig {
  return {
    baseUrl: "https://model.test/v1",
    apiKey: "test-api-key",
    model: "test-model",
    timeoutMs: 50,
    jsonMode: true,
    ...overrides,
  };
}

function chat(content: unknown, status = 200): Response {
  const text = typeof content === "string" ? content : JSON.stringify(content);
  return new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function validFinding(overrides: Record<string, unknown> = {}) {
  return {
    ruleId: "freeform-1",
    status: "pass",
    rationale: "The description explains the change.",
    confidence: 0.9,
    evidence: [{ kind: "body", ref: "body", note: "The description is focused." }],
    ...overrides,
  };
}

interface ScriptedCall {
  url: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

function sequence(responses: Response[]): {
  fetchImpl: typeof fetch;
  calls: ScriptedCall[];
} {
  const calls: ScriptedCall[] = [];
  const fetchImpl = (async (request: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof request === "string" ? request : request instanceof URL ? request.toString() : request.url;
    const headers: Record<string, string> = {};
    for (const [key, value] of new Headers(init?.headers).entries()) headers[key.toLowerCase()] = value;
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    calls.push({ url, body, headers });

    const next = responses[calls.length - 1];
    if (!next) throw new Error("the interpreter made an unexpected extra request");
    return next;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

async function rejection(promise: Promise<unknown>): Promise<AnalysisError> {
  try {
    await promise;
    throw new Error("expected the interpreter to reject");
  } catch (error) {
    expect(error).toBeInstanceOf(AnalysisError);
    return error as AnalysisError;
  }
}

describe("readInferenceConfig", () => {
  it("stays unconfigured unless both the endpoint and model are present", () => {
    expect(readInferenceConfig({})).toBeNull();
    expect(readInferenceConfig({ INFERENCE_BASE_URL: "https://model.test/v1" })).toBeNull();
    expect(readInferenceConfig({ INFERENCE_MODEL: "test-model" })).toBeNull();
    expect(
      readInferenceConfig({ INFERENCE_BASE_URL: "   ", INFERENCE_MODEL: "test-model" }),
    ).toBeNull();
  });

  it("normalises the base URL and clamps the timeout", () => {
    expect(
      readInferenceConfig({
        INFERENCE_BASE_URL: "https://model.test/v1///",
        INFERENCE_API_KEY: "  key  ",
        INFERENCE_MODEL: "test-model",
        INFERENCE_TIMEOUT_MS: "10",
      }),
    ).toEqual({
      baseUrl: "https://model.test/v1",
      apiKey: "key",
      model: "test-model",
      timeoutMs: 5_000,
      jsonMode: true,
    });

    expect(
      readInferenceConfig({
        INFERENCE_BASE_URL: "http://localhost:11434/v1",
        INFERENCE_MODEL: "local",
        INFERENCE_TIMEOUT_MS: "999999",
        INFERENCE_JSON_MODE: "off",
      }),
    ).toMatchObject({ timeoutMs: 120_000, jsonMode: false, apiKey: undefined });
  });

  it("falls back to the default timeout for unusable values", () => {
    expect(
      readInferenceConfig({
        INFERENCE_BASE_URL: "https://model.test/v1",
        INFERENCE_MODEL: "test-model",
        INFERENCE_TIMEOUT_MS: "not-a-number",
      })?.timeoutMs,
    ).toBe(45_000);
    expect(
      readInferenceConfig({
        INFERENCE_BASE_URL: "https://model.test/v1",
        INFERENCE_MODEL: "test-model",
        INFERENCE_TIMEOUT_MS: "0",
      })?.timeoutMs,
    ).toBe(45_000);
  });

  it("rejects malformed and unsupported base URLs", () => {
    for (const baseUrl of ["not a url", "ftp://model.test/v1", "file:///tmp/model"]) {
      try {
        readInferenceConfig({ INFERENCE_BASE_URL: baseUrl, INFERENCE_MODEL: "test-model" });
        throw new Error("expected config validation to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(AnalysisError);
        expect((error as AnalysisError).code).toBe("inference_failed");
      }
    }
  });
});

describe("interpretFreeformRules transport", () => {
  it("does not call the endpoint when there are no rules to interpret", async () => {
    const { fetchImpl, calls } = sequence([]);
    const result = await interpretFreeformRules(input({ rules: [] }), config(), { fetchImpl });

    expect(result.findings).toEqual([]);
    expect(result.issues).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("sends the model, JSON mode, and bearer token, and never echoes the key", async () => {
    const { fetchImpl, calls } = sequence([chat({ findings: [validFinding()] })]);
    const result = await interpretFreeformRules(input(), config(), { fetchImpl });

    expect(result.findings).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://model.test/v1/chat/completions");
    expect(calls[0]?.headers.authorization).toBe("Bearer test-api-key");
    expect(calls[0]?.body).toMatchObject({
      model: "test-model",
      temperature: 0,
      top_p: 1,
      stream: false,
      response_format: { type: "json_object" },
    });
    expect(JSON.stringify(calls[0]?.body)).not.toContain("test-api-key");
  });

  it("omits the Authorization header when no key is configured", async () => {
    const { fetchImpl, calls } = sequence([chat({ findings: [validFinding()] })]);
    await interpretFreeformRules(input(), config({ apiKey: undefined }), { fetchImpl });
    expect(calls[0]?.headers.authorization).toBeUndefined();
  });

  it("retries once without response_format when the endpoint rejects JSON mode", async () => {
    const { fetchImpl, calls } = sequence([
      new Response(JSON.stringify({ error: { message: "response_format is not supported" } }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }),
      chat({ findings: [validFinding()] }),
    ]);

    const result = await interpretFreeformRules(input(), config(), { fetchImpl });

    expect(result.findings).toHaveLength(1);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.body.response_format).toEqual({ type: "json_object" });
    expect(calls[1]?.body.response_format).toBeUndefined();
  });

  it("times out through the abort signal without a real wait", async () => {
    const signals: AbortSignal[] = [];
    const fetchImpl = ((_request: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal;
      if (!signal) return Promise.reject(new Error("missing abort signal"));
      signals.push(signal);
      return new Promise<Response>((_resolve, reject) => {
        const fail = () => reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
        if (signal.aborted) fail();
        else signal.addEventListener("abort", fail, { once: true });
      });
    }) as typeof fetch;

    const error = await rejection(
      interpretFreeformRules(input(), config({ timeoutMs: 15 }), { fetchImpl }),
    );

    expect(error.code).toBe("inference_failed");
    expect(error.message).toMatch(/timed out/);
    expect(error.hint).toContain("INFERENCE_TIMEOUT_MS");
    expect(signals[0]).toBeInstanceOf(AbortSignal);
  });

  it("distinguishes an unreachable endpoint from a timeout", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;

    const error = await rejection(interpretFreeformRules(input(), config(), { fetchImpl }));
    expect(error.code).toBe("inference_failed");
    expect(error.message).toContain("could not be reached");
  });

  it("maps HTTP failures to safe errors with actionable hints", async () => {
    const cases: { status: number; hint: string }[] = [
      { status: 401, hint: "INFERENCE_API_KEY" },
      { status: 404, hint: "INFERENCE_BASE_URL" },
      { status: 429, hint: "rate limiting" },
    ];

    for (const testCase of cases) {
      const { fetchImpl } = sequence([chat("denied", testCase.status)]);
      const error = await rejection(interpretFreeformRules(input(), config(), { fetchImpl }));
      expect(error.code).toBe("inference_failed");
      expect(error.message).toContain(`HTTP ${testCase.status}`);
      expect(error.hint).toContain(testCase.hint);
    }
  });

  it("rejects an empty completion instead of inventing findings", async () => {
    const { fetchImpl } = sequence([
      new Response(JSON.stringify({ choices: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ]);

    const error = await rejection(interpretFreeformRules(input(), config(), { fetchImpl }));
    expect(error.message).toContain("no message content");
  });

  it("accepts content delivered as an array of text parts", async () => {
    const payload = {
      choices: [
        {
          message: {
            content: [
              { type: "text", text: '{"findings":[' },
              { type: "text", text: `${JSON.stringify(validFinding())}]}` },
            ],
          },
        },
      ],
    };
    const { fetchImpl } = sequence([
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ]);

    const result = await interpretFreeformRules(input(), config(), { fetchImpl });
    expect(result.findings).toHaveLength(1);
  });

  it("repairs malformed JSON once and accepts the corrected response", async () => {
    const { fetchImpl, calls } = sequence([
      chat("I think it passes."),
      chat({ findings: [validFinding()] }),
    ]);

    const result = await interpretFreeformRules(input(), config(), { fetchImpl });

    expect(result.findings).toHaveLength(1);
    expect(calls).toHaveLength(2);
    const secondMessages = calls[1]?.body.messages as { role: string; content: string }[];
    expect(secondMessages.some((message) => message.role === "assistant")).toBe(true);
    expect(secondMessages.some((message) => message.content.includes("rejected by schema"))).toBe(true);
  });

  it("fails after one repair when the model never returns JSON", async () => {
    const malformed = '{"findings": [}';
    const { fetchImpl, calls } = sequence([chat(malformed), chat(malformed)]);
    const error = await rejection(interpretFreeformRules(input(), config(), { fetchImpl }));

    expect(error.code).toBe("inference_failed");
    expect(error.message).toContain("malformed JSON");
    expect(calls).toHaveLength(2);
  });

  it("treats a prose refusal as a failed interpretation, not a verdict", async () => {
    const refusal = "I cannot help with that request because it would require access to private data.";
    const { fetchImpl, calls } = sequence([chat(refusal), chat(refusal)]);
    const error = await rejection(interpretFreeformRules(input(), config(), { fetchImpl }));

    expect(error.code).toBe("inference_failed");
    expect(error.message).toContain("did not contain a JSON object");
    expect(calls).toHaveLength(2);
  });

  it("repairs schema violations once, then fails closed", async () => {
    const invalid = { findings: [{ ruleId: "freeform-1", status: "maybe" }] };
    const { fetchImpl, calls } = sequence([chat(invalid), chat(invalid)]);
    const error = await rejection(interpretFreeformRules(input(), config(), { fetchImpl }));

    expect(error.code).toBe("inference_failed");
    expect(error.message).toContain("strict schema");
    expect(calls).toHaveLength(2);
  });

  it("flags an empty findings array so unresolved rules are visible", async () => {
    const { fetchImpl } = sequence([chat({ findings: [] })]);
    const result = await interpretFreeformRules(input(), config(), { fetchImpl });

    expect(result.findings).toEqual([]);
    expect(result.issues.find((issue) => issue.code === "empty_response")).toBeDefined();
    expect(result.meta.rejectedFindings).toBe(0);
  });

  it("discards unknown rules and unknown evidence instead of trusting them", async () => {
    const { fetchImpl } = sequence([
      chat({
        findings: [
          validFinding(),
          {
            ruleId: "freeform-invented",
            status: "fail",
            rationale: "This rule was never supplied.",
            evidence: [{ kind: "metadata", ref: "changed_files", note: "Fabricated." }],
          },
        ],
      }),
    ]);

    const result = await interpretFreeformRules(input(), config(), { fetchImpl });

    const unknown = result.findings.find((finding) => finding.ruleId === "freeform-invented");
    expect(unknown).toBeUndefined();
    expect(result.issues.some((issue) => issue.code === "unknown_rule")).toBe(true);

    const grounded = result.findings.find((finding) => finding.ruleId === "freeform-1");
    expect(grounded).toBeDefined();
    expect(grounded?.evidence[0]?.resolved).toBe("body");
    expect(result.meta.rejectedFindings).toBeGreaterThan(0);
  });

  it("downgrades a claim that lost all of its evidence", async () => {
    const { fetchImpl } = sequence([
      chat({
        findings: [
          validFinding({
            status: "fail",
            evidence: [{ kind: "file", ref: "src/not-in-this-pr.ts", note: "Made up." }],
          }),
        ],
      }),
    ]);

    const result = await interpretFreeformRules(input(), config(), { fetchImpl });
    const finding = result.findings[0];

    expect(finding?.status).toBe("needs_review");
    expect(finding?.evidence).toEqual([]);
    expect(finding?.rationale).toContain("downgraded to human review");
    expect(result.issues.some((issue) => issue.code === "downgraded_no_evidence")).toBe(true);
  });

  it("never includes the API key in findings, notes, or issues", async () => {
    const { fetchImpl } = sequence([
      chat({ findings: [validFinding({ rationale: "ok" })], notes: ["fine"] }),
    ]);
    const result = await interpretFreeformRules(input(), config({ apiKey: "super-secret-key" }), {
      fetchImpl,
    });

    expect(JSON.stringify(result)).not.toContain("super-secret-key");
    expect(JSON.stringify(result)).not.toContain("test-api-key");
  });
});