import { AnalysisError } from "../errors";
import type { RuleSpec } from "../rules/spec";
import { buildMessages, buildRepairMessage, type FreeformInput } from "./prompt";
import {
  extractJsonObject,
  validateModelResponse,
  type ValidationIssue,
  type ValidatedFinding,
} from "./schema";

export interface InferenceConfig {
  baseUrl: string;
  apiKey?: string;
  model: string;
  timeoutMs: number;
  jsonMode: boolean;
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

  const timeoutFromEnv = Number(env.INFERENCE_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(timeoutFromEnv) && timeoutFromEnv > 0
    ? Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, timeoutFromEnv))
    : DEFAULT_TIMEOUT_MS;

  return {
    baseUrl: `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`,
    apiKey: env.INFERENCE_API_KEY?.trim() || undefined,
    model,
    timeoutMs,
    jsonMode: env.INFERENCE_JSON_MODE !== "off",
  };
}

class InferenceHttpError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`Inference endpoint returned HTTP ${status}.`);
    this.name = "InferenceHttpError";
    this.status = status;
  }
}

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

async function postChat(
  config: InferenceConfig,
  messages: ChatMessage[],
  jsonMode: boolean,
  fetchImpl: typeof fetch,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;

    const response = await fetchImpl(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: config.model,
        messages,
        temperature: 0,
        top_p: 1,
        max_tokens: 1_600,
        stream: false,
        ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new InferenceHttpError(response.status);
    }

    const payload: unknown = await response.json();
    const content = extractContent(payload);
    if (!content) {
      throw new AnalysisError("inference_failed", "The inference endpoint returned no message content.", {
        status: 502,
      });
    }
    return content;
  } catch (error) {
    if (error instanceof InferenceHttpError) throw error;
    if (error instanceof AnalysisError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new AnalysisError(
        "inference_failed",
        `The inference request timed out after ${Math.round(config.timeoutMs / 1000)}s.`,
        { status: 504, hint: "Increase INFERENCE_TIMEOUT_MS or use a smaller model." },
      );
    }
    throw new AnalysisError("inference_failed", "The inference endpoint could not be reached.", { status: 502 });
  } finally {
    clearTimeout(timer);
  }
}

function extractContent(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  if (!first || typeof first !== "object") return null;
  const message = (first as { message?: unknown }).message;
  if (!message || typeof message !== "object") return null;
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  // Some OpenAI-compatible servers return content as an array of parts.
  if (Array.isArray(content)) {
    const text = content
      .map((part) => (part && typeof part === "object" ? (part as { text?: unknown }).text : null))
      .filter((part): part is string => typeof part === "string")
      .join("");
    return text || null;
  }
  return null;
}

function transportError(error: unknown): AnalysisError {
  if (error instanceof AnalysisError) return error;
  if (error instanceof InferenceHttpError) {
    const hint =
      error.status === 401 || error.status === 403
        ? "Check INFERENCE_API_KEY and the endpoint's model permissions."
        : error.status === 404
          ? "Check INFERENCE_BASE_URL and INFERENCE_MODEL."
          : error.status === 429
            ? "The inference endpoint is rate limiting requests. Try again shortly."
            : undefined;
    return new AnalysisError(
      "inference_failed",
      `The inference endpoint returned HTTP ${error.status}.`,
      { status: 502, hint },
    );
  }
  if (error instanceof Error && error.message) {
    return new AnalysisError("inference_failed", error.message, { status: 502 });
  }
  return new AnalysisError("inference_failed", "The model interpretation failed.", { status: 502 });
}

function rejectedCount(issues: ValidationIssue[]): number {
  return issues.filter((issue) =>
    ["unknown_rule", "unknown_evidence", "duplicate_rule", "downgraded_no_evidence"].includes(issue.code),
  ).length;
}

/**
 * Ask the configured open-weight model to interpret free-form rules, then
 * validate every claim against the schema and the pull request's own data.
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

  const fetchImpl = options.fetchImpl ?? fetch;
  const { system, user } = buildMessages(input);
  const messages: ChatMessage[] = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
  const grounding = {
    rules: input.rules.map((rule: RuleSpec) => ({ id: rule.id, title: rule.title })),
    files: input.files.map((file) => file.filename),
    commits: input.commits.map((commit) => ({ sha: commit.sha, shortSha: commit.shortSha })),
    hasCi: input.ci.available,
  };

  let lastPromptError: AnalysisError | null = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let content: string;
    try {
      content = await postChat(config, messages, config.jsonMode, fetchImpl);
    } catch (error) {
      if (error instanceof InferenceHttpError && error.status === 400 && config.jsonMode) {
        // Some OpenAI-compatible servers reject response_format. Retry once
        // without it before giving up.
        content = await postChat(config, messages, false, fetchImpl);
      } else {
        throw transportError(error);
      }
    }

    let raw: unknown;
    try {
      raw = extractJsonObject(content);
    } catch (error) {
      lastPromptError = transportError(error);
      if (attempt === 0) {
        messages.push({ role: "assistant", content });
        messages.push({
          role: "user",
          content: buildRepairMessage([lastPromptError.message]),
        });
        continue;
      }
      throw lastPromptError;
    }

    const result = validateModelResponse(raw, grounding);
    const schemaIssues = result.issues.filter((issue) => issue.code === "invalid_schema");

    if (schemaIssues.length > 0 && attempt === 0) {
      messages.push({ role: "assistant", content });
      messages.push({
        role: "user",
        content: buildRepairMessage(schemaIssues.map((issue) => issue.message)),
      });
      continue;
    }

    if (schemaIssues.length > 0) {
      throw new AnalysisError(
        "inference_failed",
        "Model output failed the strict schema after one repair attempt.",
        { status: 502, hint: "Try a model with stronger JSON instruction following." },
      );
    }

    return {
      findings: result.findings,
      notes: result.notes,
      issues: result.issues,
      meta: {
        mode: "live",
        model: config.model,
        rejectedFindings: rejectedCount(result.issues),
      },
    };
  }

  throw lastPromptError ?? new AnalysisError("inference_failed", "The model interpretation failed.", { status: 502 });
}