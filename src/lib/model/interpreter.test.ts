import { describe, expect, it } from "bun:test";
import { AnalysisError } from "../errors";
import { MAX_MODEL_OUTPUT_TOKENS, MAX_PROMPT_CHARS_FOR_MODEL } from "../limits";
import { makeCi, makeCommit, makeFile, makePr, makeSpec, HEAD_SHA } from "../test-support";
import {
  interpretFreeformRules,
  readInferenceConfig,
  type InferenceConfig,
} from "./interpreter";
import { buildMessages, type FreeformInput } from "./prompt";

const RULE_ID = "freeform-contributing-md-18";

const RULE = makeSpec("freeform", {
  id: RULE_ID,
  title: "Review process",
  requirement: "Keep pull requests focused so a reviewer can understand the change in one sitting.",
  source: {
    kind: "repository_file",
    label: "CONTRIBUTING.md A Review process",
    path: "CONTRIBUTING.md",
    lineStart: 18,
    lineEnd: 21,
    excerpt: "Keep pull requests focused.",
  },
});

function input(overrides: Partial<FreeformInput> = {}): FreeformInput {
  return {
    pr: makePr(),
    files: [makeFile("src/api/pagination.ts")],
    commits: [makeCommit(HEAD_SHA, "feat: add pagination\n\nSigned-off-by: Dev User <dev@example.com>")],
    ci: makeCi(),
    rules: [RULE],
    ...overrides,
  };
}

function config(overrides: Partial<InferenceConfig> = {}): InferenceConfig {
  return {
    baseUrl: "https://inference.example/v1",
    apiKey: "sk-test-secret-value",
    model: "qwen/qwen3-32b",
    timeoutMs: 5_000,
    jsonMode: true,
    maxTokens: 2_000,
    ...overrides,
  };
}

function answer(overrides: Record<string, unknown> = {}, notes: string[] = ["A model note."]): string {
  return JSON.stringify({
    findings: [
      {
        ruleId: RULE_ID,
        status: "fail",
        rationale: "The change spans more files than a reviewer can hold at once.",
        confidence: 0.8,
        evidence: [{ kind: "metadata", ref: "changed_files", note: "Changed file count." }],
        ...overrides,
      },
    ],
    notes,
  });
}

function completion(
  content: string,
  finishReason: string | null = "stop",
  messageExtras: Record<string, unknown> = {},
): Response {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-test",
      choices: [{ index: 0, message: { role: "assistant", content, ...messageExtras }, finish_reason: finishReason }],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

interface RecordedCall {
  url: string;
  body: {
    model: string;
    messages: { role: string; content: string }[];
    max_tokens: number;
    temperature: number;
    stream: boolean;
    response_format?: { type: string };
  };
  authorization?: string;
}

function record(handler: (call: RecordedCall, index: number) => Response | Promise<Response>) {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (inputUrl: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const call: RecordedCall = {
      url: String(inputUrl),
      body: JSON.parse(String(init?.body ?? "{}")) as RecordedCall["body"],
      authorization: headers.Authorization,
    };
    calls.push(call);
    return handler(call, calls.length - 1);
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

async function failure(promise: Promise<unknown>): Promise<AnalysisError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AnalysisError);
    return error as AnalysisError;
  }
  throw new Error("expected the interpretation to fail");
}

describe("readInferenceConfig", () => {
  it("returns null when the endpoint is not configured", () => {
    expect(readInferenceConfig({})).toBeNull();
    expect(readInferenceConfig({ INFERENCE_BASE_URL: "https://api.example/v1" })).toBeNull();
    expect(readInferenceConfig({ INFERENCE_MODEL: "qwen/qwen3-32b" })).toBeNull();
  });

  it("normalises the base URL and accepts a full completions URL", () => {
    const plain = readInferenceConfig({
      INFERENCE_BASE_URL: "https://api.example/v1/",
      INFERENCE_MODEL: "qwen/qwen3-32b",
    });
    expect(plain?.baseUrl).toBe("https://api.example/v1");

    const full = readInferenceConfig({
      INFERENCE_BASE_URL: "https://api.example/v1/chat/completions",
      INFERENCE_MODEL: "qwen/qwen3-32b",
    });
    expect(full?.baseUrl).toBe("https://api.example/v1");

    const versioned = readInferenceConfig({
      INFERENCE_BASE_URL: "https://api.example/v1?api-version=2024-10-21",
      INFERENCE_MODEL: "qwen/qwen3-32b",
    });
    expect(versioned?.baseUrl).toBe("https://api.example/v1");
    expect(versioned?.query).toBe("?api-version=2024-10-21");
  });

  it("keeps the configured query string on the request", async () => {
    const { calls, fetchImpl } = record(() => completion(answer()));
    await interpretFreeformRules(input(), config({ query: "?api-version=2024-10-21" }), { fetchImpl });
    expect(calls[0]?.url).toBe("https://inference.example/v1/chat/completions?api-version=2024-10-21");
  });

  it("rejects an API key with control characters", () => {
    try {
      readInferenceConfig({
        INFERENCE_BASE_URL: "https://api.example/v1",
        INFERENCE_MODEL: "m",
        INFERENCE_API_KEY: "key\nInjected: header",
      });
    } catch (error) {
      expect((error as AnalysisError).message).toContain("control characters");
      return;
    }
    throw new Error("expected a configuration error");
  });

  it("treats INFERENCE_JSON_MODE case-insensitively", () => {
    const base = { INFERENCE_BASE_URL: "https://api.example/v1", INFERENCE_MODEL: "m" };
    expect(readInferenceConfig({ ...base, INFERENCE_JSON_MODE: "OFF" })?.jsonMode).toBe(false);
    expect(readInferenceConfig({ ...base, INFERENCE_JSON_MODE: " off " })?.jsonMode).toBe(false);
    expect(readInferenceConfig({ ...base, INFERENCE_JSON_MODE: "on" })?.jsonMode).toBe(true);
    expect(readInferenceConfig(base)?.jsonMode).toBe(true);
  });

  it("clamps timeout and output token limits", () => {
    const base = { INFERENCE_BASE_URL: "https://api.example/v1", INFERENCE_MODEL: "m" };
    expect(readInferenceConfig({ ...base, INFERENCE_TIMEOUT_MS: "1" })?.timeoutMs).toBe(5_000);
    expect(readInferenceConfig({ ...base, INFERENCE_TIMEOUT_MS: "999999" })?.timeoutMs).toBe(120_000);
    expect(readInferenceConfig({ ...base, INFERENCE_TIMEOUT_MS: "nope" })?.timeoutMs).toBe(45_000);
    expect(readInferenceConfig({ ...base, INFERENCE_MAX_TOKENS: "10" })?.maxTokens).toBe(256);
    expect(readInferenceConfig({ ...base, INFERENCE_MAX_TOKENS: "999999" })?.maxTokens).toBe(
      MAX_MODEL_OUTPUT_TOKENS,
    );
    // Unset means "use the transport default", so the key stays absent.
    expect(readInferenceConfig(base)?.maxTokens).toBeUndefined();
  });

  it("rejects invalid URLs, credentials in the URL, and unusable model ids", () => {
    const bad = (env: Record<string, string | undefined>) => {
      try {
        readInferenceConfig(env);
      } catch (error) {
        return error as AnalysisError;
      }
      throw new Error("expected a configuration error");
    };

    expect(bad({ INFERENCE_BASE_URL: "ftp://api.example/v1", INFERENCE_MODEL: "m" }).code).toBe(
      "inference_failed",
    );
    expect(bad({ INFERENCE_BASE_URL: "not a url", INFERENCE_MODEL: "m" }).message).toContain("not a valid URL");
    expect(
      bad({ INFERENCE_BASE_URL: "https://user:pass@api.example/v1", INFERENCE_MODEL: "m" }).message,
    ).toContain("must not contain credentials");
    expect(
      bad({ INFERENCE_BASE_URL: "https://api.example/v1", INFERENCE_MODEL: "two words" }).message,
    ).toContain("single model id");
  });

  it("never echoes the API key back through the config error path", () => {
    try {
      readInferenceConfig({
        INFERENCE_BASE_URL: "https://user:sk-test-secret-value@api.example/v1",
        INFERENCE_MODEL: "m",
        INFERENCE_API_KEY: "sk-test-secret-value",
      });
    } catch (error) {
      expect((error as AnalysisError).message).not.toContain("sk-test-secret-value");
    }
  });
});

describe("interpretFreeformRules", () => {
  it("sends a tagged, bounded request and returns grounded findings", async () => {
    const { calls, fetchImpl } = record(() => completion(answer()));
    const result = await interpretFreeformRules(input(), config(), { fetchImpl });

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe("https://inference.example/v1/chat/completions");
    expect(call.authorization).toBe("Bearer sk-test-secret-value");
    expect(call.body.model).toBe("qwen/qwen3-32b");
    expect(call.body.temperature).toBe(0);
    expect(call.body.stream).toBe(false);
    expect(call.body.max_tokens).toBe(2_000);
    expect(call.body.response_format).toEqual({ type: "json_object" });
    expect(call.body.messages[0]?.role).toBe("system");
    expect(call.body.messages[0]?.content).toContain("untrusted data");
    expect(call.body.messages[1]?.content).toContain("<untrusted_pull_request_data>");
    expect(call.body.messages[1]?.content).toContain("<untrusted_guideline_rules>");
    expect(JSON.stringify(call.body)).not.toContain("sk-test-secret-value");

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.status).toBe("fail");
    expect(result.findings[0]?.evidence[0]?.resolved).toBe("changed_files");
    expect(result.notes).toContain("A model note.");
    expect(result.meta.mode).toBe("live");
    expect(result.meta.model).toBe("qwen/qwen3-32b");
  });

  it("omits response_format when JSON mode is disabled", async () => {
    const { calls, fetchImpl } = record(() => completion(answer()));
    await interpretFreeformRules(input(), config({ jsonMode: false }), { fetchImpl });
    expect(calls[0]?.body.response_format).toBeUndefined();
  });

  it("never leaks the API key through a transport error", async () => {
    const secret = "sk-test-secret-value";
    const { fetchImpl } = record(() => {
      const error = new Error(`connect ECONNREFUSED for key ${secret} (authorization: Bearer ${secret})`);
      throw error;
    });
    const error = await failure(interpretFreeformRules(input(), config({ apiKey: secret }), { fetchImpl }));
    expect(error.message).not.toContain(secret);
    expect(error.hint ?? "").not.toContain(secret);
    expect(error.status).toBe(502);
  });

  it("reports a sanitised transport cause so operators can debug", async () => {
    const { fetchImpl } = record(() => {
      const cause = new Error("getaddrinfo ENOTFOUND inference.example");
      throw new TypeError("fetch failed", { cause });
    });
    const error = await failure(interpretFreeformRules(input(), config(), { fetchImpl }));
    expect(error.message).toContain("fetch failed");
    expect(error.message).toContain("ENOTFOUND");
  });

  it("reports HTTP failures without echoing the upstream body", async () => {
    const { fetchImpl } = record(
      () => new Response(`upstream exploded with key sk-test-secret-value`, { status: 500 }),
    );
    const error = await failure(interpretFreeformRules(input(), config(), { fetchImpl }));
    expect(error.message).toBe("The inference endpoint returned HTTP 500.");
    expect(error.message).not.toContain("sk-test-secret-value");
    expect(error.status).toBe(502);
  });

  it("reports a non-JSON HTTP response instead of treating it as findings", async () => {
    const { calls, fetchImpl } = record(
      () => new Response("<html><body>Bad gateway</body></html>", { status: 200 }),
    );
    const error = await failure(interpretFreeformRules(input(), config(), { fetchImpl }));
    expect(error.message).toContain("not valid JSON");
    expect(calls).toHaveLength(1);
  });

  it("times out when the endpoint never answers", async () => {
    const { fetchImpl } = record(() => new Promise<Response>(() => {}));
    const error = await failure(interpretFreeformRules(input(), config({ timeoutMs: 25 }), { fetchImpl }));
    expect(error.message).toContain("timed out");
    expect(error.status).toBe(504);
  });

  it("treats a synchronously aborted request as a timeout", async () => {
    const { fetchImpl } = record(() => {
      throw Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
    });
    const error = await failure(interpretFreeformRules(input(), config(), { fetchImpl }));
    expect(error.message).toContain("timed out");
    expect(error.hint).toContain("INFERENCE_TIMEOUT_MS");
  });

  it("rejects a truncated completion instead of salvaging partial output", async () => {
    const { calls, fetchImpl } = record(() => completion('{"findings":[{"ruleId":"freeform-', "length"));
    const error = await failure(interpretFreeformRules(input(), config(), { fetchImpl }));
    expect(error.message).toContain("truncated");
    expect(calls).toHaveLength(1);
  });

  it("rejects a model refusal without retrying", async () => {
    const { calls, fetchImpl } = record(() => completion("", "stop", { refusal: "I cannot help with that." }));
    const error = await failure(interpretFreeformRules(input(), config(), { fetchImpl }));
    expect(error.message).toContain("declined");
    expect(calls).toHaveLength(1);
  });

  it("rejects a provider content filter as a failure", async () => {
    const { fetchImpl } = record(() => completion("", "content_filter"));
    const error = await failure(interpretFreeformRules(input(), config(), { fetchImpl }));
    expect(error.message).toContain("filtered");
  });

  it("repairs malformed output once, then fails", async () => {
    const { calls, fetchImpl } = record(() => completion("I think this pull request looks fine."));
    const error = await failure(interpretFreeformRules(input(), config(), { fetchImpl }));
    expect(error.message).toContain("JSON object");
    expect(calls).toHaveLength(2);
    expect(calls[1]?.body.messages.at(-1)?.content).toContain("rejected");
  });

  it("accepts a repaired malformed response", async () => {
    const { calls, fetchImpl } = record((_call, index) =>
      index === 0 ? completion("Sorry, no JSON here.") : completion(answer()),
    );
    const result = await interpretFreeformRules(input(), config(), { fetchImpl });
    expect(calls).toHaveLength(2);
    expect(result.findings).toHaveLength(1);
  });

  it("reports an empty findings array without inventing results", async () => {
    const { calls, fetchImpl } = record(() => completion(JSON.stringify({ findings: [] })));
    const result = await interpretFreeformRules(input(), config(), { fetchImpl });

    expect(calls).toHaveLength(1);
    expect(result.findings).toEqual([]);
    expect(result.issues.some((issue) => issue.code === "empty_response")).toBe(true);
    expect(result.issues.some((issue) => issue.code === "missing_rule")).toBe(true);
    expect(result.meta.rejectedFindings).toBe(0);
  });

  it("rejects an incomplete answer that silently drops a supplied rule", async () => {
    const secondRule = makeSpec("freeform", {
      id: "freeform-contributing-md-30",
      title: "Communication",
      requirement: "Explain trade-offs in the description.",
    });
    const { calls, fetchImpl } = record(() => completion(answer()));
    const error = await failure(
      interpretFreeformRules(input({ rules: [RULE, secondRule] }), config(), { fetchImpl }),
    );
    expect(error.message).toContain("undecided");
    expect(calls).toHaveLength(2);
    expect(calls[1]?.body.messages.at(-1)?.content).toContain("freeform-contributing-md-30");
  });

  it("repairs a schema violation once, then fails", async () => {
    const { calls, fetchImpl } = record(() => completion(answer({ status: "definitely" })));
    const error = await failure(interpretFreeformRules(input(), config(), { fetchImpl }));
    expect(error.message).toContain("strict schema");
    expect(calls).toHaveLength(2);
    expect(calls[1]?.body.messages.at(-1)?.content).toContain("findings.0.status");
  });

  it("discards findings for rules that were never supplied", async () => {
    const raw = JSON.stringify({
      findings: [
        {
          ruleId: "freeform-invented-rule",
          status: "pass",
          rationale: "Everything is fine.",
          evidence: [{ kind: "body", ref: "body", note: "Body." }],
        },
        JSON.parse(answer()).findings[0],
      ],
    });
    const { fetchImpl } = record(() => completion(raw));
    const result = await interpretFreeformRules(input(), config(), { fetchImpl });

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.ruleId).toBe(RULE_ID);
    expect(result.issues.some((issue) => issue.code === "unknown_rule")).toBe(true);
    expect(result.meta.rejectedFindings).toBe(1);
  });

  it("never lets the model overwrite a deterministic rule", async () => {
    const raw = JSON.stringify({
      findings: [
        {
          ruleId: "rule-ci-green",
          status: "pass",
          rationale: "CI is green.",
          confidence: 0.99,
          evidence: [{ kind: "ci", ref: "ci", note: "Green." }],
        },
        JSON.parse(answer()).findings[0],
      ],
    });
    const { fetchImpl } = record(() => completion(raw));
    const result = await interpretFreeformRules(input(), config(), { fetchImpl });

    expect(result.findings.map((finding) => finding.ruleId)).toEqual([RULE_ID]);
    expect(result.issues.some((issue) => issue.code === "unknown_rule")).toBe(true);
  });

  it("keeps conditional guidance at human review instead of a model-driven fail", async () => {
    const conditional = makeSpec("freeform", {
      id: RULE_ID,
      title: RULE.title,
      requirement: "Update the docs when a public API changes.",
      conditional: true,
    });
    const { fetchImpl } = record(() => completion(answer({ status: "fail" })));
    const result = await interpretFreeformRules(input({ rules: [conditional] }), config(), { fetchImpl });

    expect(result.findings[0]?.status).toBe("needs_review");
    expect(result.findings[0]?.rationale).toContain("conditional");
    expect(result.issues.some((issue) => issue.code === "conditional_requires_review")).toBe(true);
  });

  it("downgrades claims built on evidence outside the pull request", async () => {
    const { fetchImpl } = record(() =>
      completion(answer({ evidence: [{ kind: "file", ref: "src/invented.ts", note: "Made up." }] })),
    );
    const result = await interpretFreeformRules(input(), config(), { fetchImpl });

    expect(result.findings[0]?.status).toBe("needs_review");
    expect(result.findings[0]?.evidence).toEqual([]);
    expect(result.issues.some((issue) => issue.code === "unknown_evidence")).toBe(true);
    expect(result.issues.some((issue) => issue.code === "downgraded_no_evidence")).toBe(true);
  });

  it("cannot ground evidence in files that the prompt did not show", async () => {
    const files = Array.from({ length: 70 }, (_, index) => makeFile(`src/file-${index}.ts`));
    const rule = makeSpec("freeform", {
      id: RULE_ID,
      title: RULE.title,
      requirement: RULE.requirement,
    });
    // Even with a trimmed prompt, a file outside the window cannot be cited.
    const oversized = files.map((file) =>
      makeFile(file.filename, 1, 0, "modified", "x".repeat(20_000)),
    );
    const built = buildMessages(input({ files: oversized, rules: [rule] }));
    const shown = new Set(built.included.files);

    const { fetchImpl } = record(() =>
      completion(
        answer({
          evidence: [
            {
              kind: "file",
              ref: shown.has("src/file-69.ts") ? "src/file-0.ts" : "src/file-69.ts",
              note: "Cited outside the window.",
            },
          ],
        }),
      ),
    );
    const result = await interpretFreeformRules(input({ files: oversized, rules: [rule] }), config(), {
      fetchImpl,
    });
    expect(result.findings[0]?.status).toBe("needs_review");
    expect(result.issues.some((issue) => issue.code === "unknown_evidence")).toBe(true);
  });

  it("refuses body evidence when the description is empty", async () => {
    const { fetchImpl } = record(() =>
      completion(answer({ status: "pass", evidence: [{ kind: "body", ref: "body", note: "Described." }] })),
    );
    const result = await interpretFreeformRules(input({ pr: makePr({ body: "   " }) }), config(), {
      fetchImpl,
    });
    expect(result.findings[0]?.status).toBe("needs_review");
    expect(result.findings[0]?.evidence).toEqual([]);
  });

  it("refuses CI evidence when no checks were reported", async () => {
    const { fetchImpl } = record(() =>
      completion(answer({ evidence: [{ kind: "ci", ref: "unit tests", note: "Passed." }] })),
    );
    const result = await interpretFreeformRules(
      input({ ci: makeCi({ total: 0, successful: 0, state: "none" }) }),
      config(),
      { fetchImpl },
    );
    expect(result.findings[0]?.status).toBe("needs_review");
    expect(result.findings[0]?.evidence).toEqual([]);
  });

  it("downgrades low-confidence verdicts and says why", async () => {
    const { fetchImpl } = record(() => completion(answer({ confidence: 0.2 })));
    const result = await interpretFreeformRules(input(), config(), { fetchImpl });

    expect(result.findings[0]?.status).toBe("needs_review");
    expect(result.findings[0]?.rationale).toContain("confidence");
    expect(result.issues.some((issue) => issue.code === "low_confidence")).toBe(true);
    expect(result.notes.join(" ")).toContain("confidence was below 0.5");
  });

  it("falls back to plain prompting when the endpoint rejects JSON mode", async () => {
    const { calls, fetchImpl } = record((call) =>
      call.body.response_format ? new Response("unsupported response_format", { status: 400 }) : completion(answer()),
    );
    const result = await interpretFreeformRules(input(), config(), { fetchImpl });

    expect(calls).toHaveLength(2);
    expect(calls[0]?.body.response_format).toEqual({ type: "json_object" });
    expect(calls[1]?.body.response_format).toBeUndefined();
    expect(result.findings).toHaveLength(1);
    expect(result.notes.join(" ")).toContain("JSON mode");
  });

  it("reports the status when the JSON-mode fallback also fails", async () => {
    const { calls, fetchImpl } = record(() => new Response("nope", { status: 500 }));
    const error = await failure(interpretFreeformRules(input(), config(), { fetchImpl }));

    // A 500 does not trigger the JSON-mode retry, so the endpoint is called once.
    expect(calls).toHaveLength(1);
    expect(error.message).toBe("The inference endpoint returned HTTP 500.");
  });

  it("rejects an oversized upstream response", async () => {
    const huge = `{"choices":[{"message":{"content":"${"a".repeat(500_000)}"},"finish_reason":"stop"}]}`;
    const { fetchImpl } = record(() => new Response(huge, { status: 200 }));
    const error = await failure(interpretFreeformRules(input(), config(), { fetchImpl }));
    expect(error.message).toContain("unexpectedly large");
  });

  it("keeps the request within the prompt budget", async () => {
    const files = Array.from({ length: 60 }, (_, index) =>
      makeFile(`src/deeply/nested/directory/number-${index}/file.ts`, 1, 0, "modified", "y".repeat(20_000)),
    );
    const commits = Array.from({ length: 40 }, (_, index) => makeCommit(HEAD_SHA, `commit ${index} ${"z".repeat(300)}`));
    const { calls, fetchImpl } = record(() => completion(answer()));
    const result = await interpretFreeformRules(
      input({
        pr: makePr({ body: "b".repeat(20_000) }),
        files,
        commits,
      }),
      config(),
      { fetchImpl },
    );

    const user = calls[0]?.body.messages[1]?.content ?? "";
    expect(user.length).toBeLessThanOrEqual(MAX_PROMPT_CHARS_FOR_MODEL);
    expect(user).toContain('"payload_trimmed": true');
    expect(user).not.toContain("y".repeat(2_000));
    expect(JSON.stringify(calls[0]?.body).length).toBeLessThan(MAX_PROMPT_CHARS_FOR_MODEL + 4_000);
    expect(result.notes.join(" ")).toContain("trimmed");
  });

  it("returns nothing when there are no freeform rules", async () => {
    const { calls, fetchImpl } = record(() => completion(answer()));
    const result = await interpretFreeformRules(input({ rules: [] }), config(), { fetchImpl });
    expect(calls).toHaveLength(0);
    expect(result.findings).toEqual([]);
  });

  it("refuses an oversized rule set instead of silently dropping rules", async () => {
    const rules = Array.from({ length: 13 }, (_, index) =>
      makeSpec("freeform", { id: `freeform-${index}`, title: `Rule ${index}` }),
    );
    const { calls, fetchImpl } = record(() => completion(answer()));
    const error = await failure(interpretFreeformRules(input({ rules }), config(), { fetchImpl }));
    expect(error.message).toContain("13 free-form rules");
    expect(calls).toHaveLength(0);
  });
});