/** Shared caps for what is sent to the inference endpoint. */
export const MAX_BODY_CHARS_FOR_MODEL = 2_500;
export const MAX_FILES_FOR_MODEL = 60;
export const MAX_COMMITS_FOR_MODEL = 40;
export const MAX_MODEL_RESPONSE_CHARS = 100_000;

/** Extended rule text: a requirement or excerpt longer than this is clipped. */
export const MAX_RULE_CHARS_FOR_MODEL = 400;
/**
 * Hard ceiling for the user message. The dossier is trimmed (patches, then
 * files, then commits, then description) until it fits, so a huge pull request
 * can never produce an unbounded request.
 */
export const MAX_PROMPT_CHARS_FOR_MODEL = 24_000;

/** One request may interpret at most this many free-form rules. */
export const MAX_RULES_FOR_MODEL = 12;

/** Raw HTTP body accepted from the inference endpoint, before JSON parsing. */
export const MAX_API_RESPONSE_CHARS = 400_000;

/** Diff excerpts: only a few files, and only the start of each patch. */
export const MAX_PATCH_FILES = 8;
export const MAX_PATCH_CHARS = 1_600;

/** Bounded structured output for the model response. */
export const MIN_MODEL_OUTPUT_TOKENS = 256;
export const DEFAULT_MODEL_OUTPUT_TOKENS = 2_000;
export const MAX_MODEL_OUTPUT_TOKENS = 4_096;