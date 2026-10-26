/** Shared caps for what is sent to the inference endpoint. */
export const MAX_BODY_CHARS_FOR_MODEL = 2_500;
export const MAX_FILES_FOR_MODEL = 60;
export const MAX_COMMITS_FOR_MODEL = 40;
export const MAX_MODEL_RESPONSE_CHARS = 100_000;

/** Diff excerpts: only a few files, and only the start of each patch. */
export const MAX_PATCH_FILES = 8;
export const MAX_PATCH_CHARS = 1_600;