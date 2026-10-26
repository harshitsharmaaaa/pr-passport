export type AnalysisErrorCode =
  | "invalid_url"
  | "unsupported_host"
  | "not_found"
  | "rate_limited"
  | "github_unavailable"
  | "inference_failed"
  | "demo_not_found"
  | "internal";

/**
 * An error that is safe to show to the user. Never attach tokens or raw
 * upstream responses to this object.
 */
export class AnalysisError extends Error {
  readonly code: AnalysisErrorCode;
  readonly status: number;
  readonly hint?: string;

  constructor(code: AnalysisErrorCode, message: string, options?: { status?: number; hint?: string }) {
    super(message);
    this.name = "AnalysisError";
    this.code = code;
    this.status = options?.status ?? 400;
    this.hint = options?.hint;
  }
}

export function toPublicError(error: unknown): { code: AnalysisErrorCode; message: string; hint?: string } {
  if (error instanceof AnalysisError) {
    return { code: error.code, message: error.message, hint: error.hint };
  }
  return {
    code: "internal",
    message: "The analysis failed unexpectedly. No data was modified.",
    hint: "Try again, or run the app locally with the demo fixtures.",
  };
}