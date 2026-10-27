import { AnalysisError } from "../errors";
import {
  DEFAULT_MODEL_OUTPUT_TOKENS,
  MAX_API_RESPONSE_CHARS,
  MAX_MODEL_OUTPUT_TOKENS,
  MAX_RULES_FOR_MODEL,
  MIN_MODEL_OUTPUT_TOKENS,
} from "../limits";
import type { RuleSpec } from "../rules/spec";
import { buildMessages, buildRepairMessage, type FreeformInput } from "./prompt";
import { sanitizeMessage } from "./redact";
import {
  MIN_CONFIDENCE_FOR_VERDICT,
  extractJsonObject,
  validateModelResponse,
  type GroundingContext,
  type ValidationIssue,
  type ValidatedFinding,
} from "./schema";

export interface InferenceConfig {
  baseUrl: string;
  apiKey?: string;
  model: string;
  timeoutMs: number;
  jsonMode: boolean;
  /** Output token ceiling; defaults to 2000 when omitted. */
  maxTokens?: number;
  /** Query string preserved from the configured base URL (for example an API version). */
  query?: string;
}

export interface FreeformInterpretation {
  findings: ValidatedFinding[];
  notes: string[];
  issues: ValidationIssue[];
  meta: {
    mode: "live" | "recorded_fixture";
    model: string;
    rejectedFindings: number;
  };
}

export interface FreeformInterpreter {
  interpret(input: FreeformInput): Promise<FreeformInterpretation>;
}

export type { FreeformInput } from "./prompt";

const DEFAULT_TIMEOUT_MS = 45_000;
const MIN_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_MODEL_ID_CHARS = 200;
/** How much of a rejected answer is echoed back when asking for a repair. */
const MAX_REPAIR_ECHO_CHARS = 4_000;

/**
 * Statuses that mean "this endpoint does not accept response_format" rather
 * than "this request is broken". Anything else is reported as-is.
 */
const JSON_MODE_REJECTED_STATUSES = new Set([400, 422, 501]);

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function timeoutFromEnv(raw: string | undefined): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_TIMEOUT_MS;
  return clampNumber(value, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
}

/** Returns undefined when the operator did not set a usable ceiling. */
function maxTokensFromEnv(raw: string | undefined): number | undefined {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return clampNumber(value, MIN_MODEL_OUTPUT_TOKENS, MAX_MODEL_OUTPUT_TOKENS);
}

function resolveMaxTokens(config: InferenceConfig): number {
  const value = config.maxTokens;
  if (value === undefined || !Number.isFinite(value) || value <= 0) return DEFAULT_MODEL_OUTPUT_TOKENS;
  return clampNumber(value, MIN_MODEL_OUTPUT_TOKENS, MAX_MODEL_OUTPUT_TOKENS);
}

/**
 * Configuration is read from the environment at call time so that the app can
 * run without credentials and report inference as unavailable.
 */
export function readInferenceConfig(
  env: Record<string, string | undefined> = process.env,
): InferenceConfig | null {
  const baseUrl = env.INFERENCE_BASE_URL?.trim();
  const model = env.INFERENCE_MODEL?.trim();
  if (!baseUrl || !model) return null;

  if (model.length > MAX_MODEL_ID_CHARS || /[\u0000-\u0020\u007F]/.test(model)) {
    throw new AnalysisError("inference_failed", "INFERENCE_MODEL must be a single model id without spaces.", {
      status: 500,
      hint: "Use the provider's model slug, for example qwen/qwen3-32b.",
    });
  }

  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new AnalysisError("inference_failed", "INFERENCE_BASE_URL is not a valid URL.", {
      status: 500,
      hint: "Use the OpenAI-compatible API root, for example https://openrouter.ai/api/v1.",
    });
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new AnalysisError("inference_failed", "INFERENCE_BASE_URL must use http or https.", { status: 500 });
  }
  if (parsed.username || parsed.password) {
    throw new AnalysisError(
      "inference_failed",
      "INFERENCE_BASE_URL must not contain credentials; put the key in INFERENCE_API_KEY instead.",
      { status: 500 },
    );
  }

  // Accept a full completions URL as a convenience, and never double the path.
  const path = parsed.pathname.replace(/\/+$/, "").replace(/\/chat\/completions$/i, "");
  const jsonModeValue = (env.INFERENCE_JSON_MODE ?? "").trim().toLowerCase();
  const apiKey = env.INFERENCE_API_KEY?.trim();

  if (apiKey && /[\u0000-\u001F\u007F]/.test(apiKey)) {
    throw new AnalysisError("inference_failed", "INFERENCE_API_KEY contains control characters.", {
      status: 500,
      hint: "Paste the key as a single line without trailing whitespace.",
    });
  }

  const config: InferenceConfig = {
    baseUrl: `${parsed.origin}${path}`,
    apiKey: apiKey ? apiKey : undefined,
    model,
    timeoutMs: timeoutFromEnv(env.INFERENCE_TIMEOUT_MS),
    jsonMode: !["off", "false", "0", "no", "disabled"].includes(jsonModeValue),
  };

  // Only present when explicitly configured, so the default config shape stays
  // stable for callers and tests.
  const maxTokens = maxTokensFromEnv(env.INFERENCE_MAX_TOKENS);
  if (maxTokens !== undefined) config.maxTokens = maxTokens;
  if (parsed.search) config.query = parsed.search;
  return config;
}

class InferenceHttpError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`Inference endpoint returned HTTP ${status}.`);
    this.name = "InferenceHttpError";
    this.status = status;
  }
}

class InferenceTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Inference request timed out after ${timeoutMs}ms.`);
    this.name = "InferenceTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface Completion {
  content: string;
}

function timeoutAnalysisError(timeoutMs: number): AnalysisError {
  return new AnalysisError(
    "inference_failed",
    `The inference request timed out after ${Math.round(timeoutMs / 1000)}s.`,
    { status: 504, hint: "Increase INFERENCE_TIMEOUT_MS or use a smaller model." },
  );
}

function responseTooLargeError(): AnalysisError {
  return new AnalysisError(
    "inference_failed",
    "The inference endpoint returned an unexpectedly large response, so it was rejected.",
    { status: 502, hint: "Check that INFERENCE_BASE_URL points at an OpenAI-compatible chat completions API." },
  );
}

function unusableResponseError(message: string, config: InferenceConfig, hint?: string): AnalysisError {
  return new AnalysisError("inference_failed", sanitizeMessage(message, 300, [config.apiKey]), {
    status: 502,
    hint,
  });
}

function readCompletionText(value: unknown): string | null {
  if (typeof value === "string") return value;
  // Some OpenAI-compatible servers return content as an array of parts.
  if (Array.isArray(value)) {
    const text = value
      .map((part) => (part && typeof part === "object" ? (part as { text?: unknown }).text : null))
      .filter((part): part is string => typeof part === "string")
      .join("");
    return text || null;
  }
  return null;
}

/**
 * Read the first choice of a chat completion. Truncated, filtered, and refused
 * answers are surfaced as failures: partial output must never look complete.
 */
function readCompletion(payload: unknown, config: InferenceConfig): Completion {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw unusableResponseError("The inference endpoint returned an unexpected response shape.", config);
  }

  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw unusableResponseError("The inference endpoint returned no message content.", config);
  }

  const first = choices[0];
  if (!first || typeof first !== "object") {
    throw unusableResponseError("The inference endpoint returned an unexpected completion.", config);
  }

  const finishReason = typeof (first as { finish_reason?: unknown }).finish_reason === "string"
    ? ((first as { finish_reason: string }).finish_reason)
    : null;
  const message = (first as { message?: unknown }).message;
  if (!message || typeof message !== "object") {
    throw unusableResponseError("The inference endpoint returned no message content.", config);
  }

  const refusalText = (message as { refusal?: unknown }).refusal;
  const refusal = typeof refusalText === "string" && refusalText.trim() ? refusalText.trim() : null;
  const content = readCompletionText((message as { content?: unknown }).content);

  if (finishReason === "content_filter") {
    throw unusableResponseError(
      "The inference provider filtered the model response, so no interpretation was accepted.",
      config,
      "The pull request may contain content the provider blocks. Review the free-form guidance manually.",
    );
  }
  if (refusal) {
    throw unusableResponseError(
      `The model declined to interpret this pull request: ${refusal.slice(0, 200)}`,
      config,
      "This is a model refusal, not an analysis. Review the free-form guidance manually.",
    );
  }
  if (finishReason === "length") {
    throw new AnalysisError(
      "inference_failed",
      `The model response hit the ${resolveMaxTokens(config)}-token output limit and was truncated, so it was discarded.`,
      { status: 502, hint: "Raise INFERENCE_MAX_TOKENS, or reduce the number of free-form rules." },
    );
  }
  if (!content || !content.trim()) {
    throw unusableResponseError("The inference endpoint returned no message content.", config);
  }

  return { content };
}

async function postChat(
  config: InferenceConfig,
  messages: ChatMessage[],
  jsonMode: boolean,
  fetchImpl: typeof fetch,
): Promise<string> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new InferenceTimeoutError(config.timeoutMs));
    }, config.timeoutMs);
  });

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;

    const body: Record<string, unknown> = {
      model: config.model,
      messages,
      temperature: 0,
      top_p: 1,
      max_tokens: resolveMaxTokens(config),
      stream: false,
    };
    if (jsonMode) body.response_format = { type: "json_object" };

    const response = await Promise.race([
      fetchImpl(`${config.baseUrl}/chat/completions${config.query ?? ""}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      }),
      timeout,
    ]);

    if (!response.ok) throw new InferenceHttpError(response.status);

    // Bound the body before parsing so a misconfigured endpoint cannot stream
    // an unbounded response into memory.
    const declaredLength = Number(response.headers?.get?.("content-length") ?? Number.NaN);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_API_RESPONSE_CHARS) {
      throw responseTooLargeError();
    }
    const rawBody = await Promise.race([response.text(), timeout]);
    if (rawBody.length > MAX_API_RESPONSE_CHARS) throw responseTooLargeError();

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      throw unusableResponseError(
        "The inference endpoint returned a response that was not valid JSON.",
        config,
        "Check that INFERENCE_BASE_URL points at an OpenAI-compatible chat completions API root.",
      );
    }

    return readCompletion(payload, config).content;
  } catch (error) {
    // Whichever rejection wins the race, a request we aborted is a timeout, and
    // an AbortError from this fetch call means the abort we asked for.
    const name = error instanceof Error ? error.name : "";
    if (
      !(error instanceof AnalysisError) &&
      (controller.signal.aborted || name === "AbortError" || name === "TimeoutError")
    ) {
      throw new InferenceTimeoutError(config.timeoutMs);
    }
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function httpErrorHint(status: number): string | undefined {
  if (status === 401 || status === 403) return "Check INFERENCE_API_KEY and the endpoint's model permissions.";
  if (status === 404) return "Check INFERENCE_BASE_URL and INFERENCE_MODEL.";
  if (status === 429) return "The inference endpoint is rate limiting requests. Try again shortly.";
  if (status >= 500) return "The inference endpoint failed. Try again, or check the provider's status.";
  return undefined;
}

function transportError(error: unknown, config: InferenceConfig): AnalysisError {
  if (error instanceof AnalysisError) return error;
  if (error instanceof InferenceTimeoutError) return timeoutAnalysisError(error.timeoutMs);
  if (error instanceof InferenceHttpError) {
    return new AnalysisError("inference_failed", `The inference endpoint returned HTTP ${error.status}.`, {
      status: 502,
      hint: httpErrorHint(error.status),
    });
  }
  if (error instanceof Error) {
    const secrets = [config.apiKey];
    const cause = error.cause instanceof Error ? ` (${error.cause.message})` : "";
    const detail = sanitizeMessage(`${error.message}${cause}`, 200, secrets);
    const unreachable = error instanceof TypeError;
    if (detail) {
      return new AnalysisError(
        "inference_failed",
        unreachable
          ? `The inference endpoint could not be reached: ${detail}`
          : `The inference request failed: ${detail}`,
        {
          status: 502,
          hint: "Check INFERENCE_BASE_URL and that the endpoint is reachable.",
        },
      );
    }
  }
  return new AnalysisError("inference_failed", "The model interpretation failed.", { status: 502 });
}

function rejectedCount(issues: ValidationIssue[]): number {
  return issues.filter((issue) =>
    ["unknown_rule", "unknown_evidence", "duplicate_rule", "downgraded_no_evidence", "empty_rationale"].includes(
      issue.code,
    ),
  ).length;
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

/** Keep the echoed assistant turn small so a repair cannot double the payload. */
function boundEcho(content: string): string {
  return content.length > MAX_REPAIR_ECHO_CHARS
    ? `${content.slice(0, MAX_REPAIR_ECHO_CHARS)}\n[previous response truncated]`
    : content;
}

/**
 * Ask the configured open-weight model to interpret free-form rules, then
 * validate every claim against the schema and the pull request's own data.
 *
 * Any transport failure, refusal, truncation, or output that produces no
 * grounded finding throws, so callers can never mistake it for a successful
 * analysis.
 */
export async function interpretFreeformRules(
  input: FreeformInput,
  config: InferenceConfig,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<FreeformInterpretation> {
  if (input.rules.length === 0) {
    return {
      findings: [],
      notes: [],
      issues: [],
      meta: { mode: "live", model: config.model, rejectedFindings: 0 },
    };
  }

  if (input.rules.length > MAX_RULES_FOR_MODEL) {
    // Refuse rather than silently dropping rules: the caller can then surface
    // them as unevaluated instead of losing them.
    throw new AnalysisError(
      "inference_failed",
      `${input.rules.length} free-form rules exceed the ${MAX_RULES_FOR_MODEL}-rule limit for one model request, so none were evaluated.`,
      { status: 502, hint: "Interpret free-form guidance in smaller batches." },
    );
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const built = buildMessages(input);
  const messages: ChatMessage[] = [
    { role: "system", content: built.system },
    { role: "user", content: built.user },
  ];
  // Ground the model's claims in exactly what it was shown, not in the pull
  // request's full file and commit lists.
  const grounding: GroundingContext = {
    rules: input.rules.map((rule: RuleSpec) => ({ id: rule.id, title: rule.title })),
    files: built.included.files,
    commits: built.included.commits,
    hasCi: input.ci.available && input.ci.total > 0,
    hasBody: input.pr.body.trim().length > 0,
    hasTitle: input.pr.title.trim().length > 0,
    conditionalRuleIds: input.rules.filter((rule) => rule.conditional).map((rule) => rule.id),
    ciChecks: [...input.ci.failing, ...input.ci.pending, ...(input.ci.passing ?? [])].map(
      (check) => check.name,
    ),
  };
  const notes: string[] = [];
  if (built.trimmed) {
    notes.push(
      "The pull request dossier was trimmed to keep the model request small, so some files, commits, or diff excerpts were not shown to the model.",
    );
  }

  let jsonMode = config.jsonMode;
  let lastPromptError: AnalysisError | null = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let content: string;
    try {
      content = await postChat(config, messages, jsonMode, fetchImpl);
    } catch (error) {
      if (error instanceof InferenceHttpError && jsonMode && JSON_MODE_REJECTED_STATUSES.has(error.status)) {
        // Some OpenAI-compatible servers reject response_format. Retry once
        // without it, and keep it off for the rest of this interpretation.
        jsonMode = false;
        notes.push(
          "The inference endpoint rejected response_format JSON mode, so PR Passport retried without it. Output reliability then depends on the model following the prompt.",
        );
        try {
          content = await postChat(config, messages, false, fetchImpl);
        } catch (retryError) {
          throw transportError(retryError, config);
        }
      } else {
        throw transportError(error, config);
      }
    }

    let raw: unknown;
    try {
      raw = extractJsonObject(content);
    } catch (error) {
      lastPromptError = transportError(error, config);
      if (attempt === 0) {
        messages.push({ role: "assistant", content: boundEcho(content) });
        messages.push({ role: "user", content: buildRepairMessage([lastPromptError.message]) });
        continue;
      }
      throw lastPromptError;
    }

    const result = validateModelResponse(raw, grounding);
    const schemaIssues = result.issues.filter((issue) => issue.code === "invalid_schema");

    if (schemaIssues.length > 0) {
      if (attempt === 0) {
        messages.push({ role: "assistant", content: boundEcho(content) });
        messages.push({ role: "user", content: buildRepairMessage(schemaIssues.map((issue) => issue.message)) });
        continue;
      }
      throw new AnalysisError("inference_failed", "Model output failed the strict schema after one repair attempt.", {
        status: 502,
        hint: "Try a model with stronger JSON instruction following.",
      });
    }

    if (result.findings.length === 0) {
      // No usable finding at all. The caller turns this into pending,
      // needs-review rules, so it is reported as an empty interpretation rather
      // than retried or invented.
      const issue: ValidationIssue = {
        code: "missing_rule",
        message: "The model returned no usable findings for the supplied rules.",
      };
      return {
        findings: [],
        notes: dedupe(notes),
        issues: [...result.issues, issue],
        meta: { mode: "live", model: config.model, rejectedFindings: rejectedCount(result.issues) },
      };
    }

    const missingRules = input.rules.filter(
      (rule) => !result.findings.some((finding) => finding.ruleId === rule.id),
    );

    if (missingRules.length > 0) {
      // A partial answer cannot be reported as a complete analysis: the caller
      // would otherwise drop the unanswered rules silently.
      const issue: ValidationIssue = {
        code: "missing_rule",
        message: `The model did not decide ${missingRules.length} supplied rule(s): ${missingRules
          .map((rule) => rule.id)
          .join(", ")}.`,
      };

      if (attempt === 0) {
        messages.push({ role: "assistant", content: boundEcho(content) });
        messages.push({
          role: "user",
          content: buildRepairMessage([
            issue.message,
            `Return one finding for every supplied ruleId: ${input.rules.map((rule) => rule.id).join(", ")}.`,
            `Use needs_review when the dossier does not support a decision.`,
          ]),
        });
        lastPromptError = new AnalysisError("inference_failed", issue.message, { status: 502 });
        continue;
      }

      throw new AnalysisError(
        "inference_failed",
        `The model left ${missingRules.length} free-form rule(s) undecided, so the interpretation was rejected.`,
        {
          status: 502,
          hint: "Try a model with stronger JSON instruction following, or review the free-form guidance manually.",
        },
      );
    }

    const rejected = rejectedCount(result.issues);
    const downgraded = result.issues.filter((issue) => issue.code === "low_confidence").length;
    if (downgraded > 0) {
      notes.push(
        `${downgraded} model finding(s) were downgraded to needs_review because the model's confidence was below ${MIN_CONFIDENCE_FOR_VERDICT}.`,
      );
    }

    return {
      findings: result.findings,
      notes: dedupe([...notes, ...result.notes]),
      issues: result.issues,
      meta: {
        mode: "live",
        model: config.model,
        rejectedFindings: rejected,
      },
    };
  }

  throw lastPromptError ?? new AnalysisError("inference_failed", "The model interpretation failed.", { status: 502 });
}
