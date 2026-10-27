/**
 * Redaction helpers for anything that may be shown to a human or written to a
 * log. Error messages must never carry an API key, a bearer token, or a URL
 * with embedded credentials.
 */

export const REDACTED = "[redacted]";

/**
 * Each rule keeps an optional literal prefix (for example `Authorization: `)
 * so the message stays readable while the value is removed.
 */
const RULES: { pattern: RegExp; keepPrefix: boolean }[] = [
  // `Authorization: Bearer <token>` and `authorization=<token>`
  { pattern: /\b(authorization\s*[:=]\s*(?:bearer\s+)?)[^\s,;&"']+/gi, keepPrefix: true },
  // `api_key=...`, `token: ...`, `secret=...`, `password=...`
  {
    pattern:
      /\b((?:api[-_]?key|apikey|access[-_]?token|auth[-_]?token|token|secret|password|passwd)\s*[:=]\s*)[^\s,;&"']+/gi,
    keepPrefix: true,
  },
  // Credentials embedded in a URL: https://user:pass@host
  { pattern: /(https?:\/\/)[^\/\s:@]+:[^\/\s@]+@/gi, keepPrefix: true },
  // Common provider key shapes.
  { pattern: /\bsk-[A-Za-z0-9_-]{8,}\b/g, keepPrefix: false },
  { pattern: /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{10,}\b/g, keepPrefix: false },
  // Query-string credentials.
  { pattern: /([?&](?:key|api[-_]?key|token|access[-_]?token)=)[^&\s"']+/gi, keepPrefix: true },
];

/**
 * Remove anything that looks like a credential from a free-text message.
 * Known secrets (for example the configured API key) are matched literally
 * first, because their shape cannot be guessed reliably.
 */
export function redactSecrets(text: string, knownSecrets: (string | undefined)[] = []): string {
  let output = text;

  for (const secret of knownSecrets) {
    if (!secret || secret.length < 4) continue;
    output = output.split(secret).join(REDACTED);
  }

  for (const rule of RULES) {
    if (!rule.keepPrefix) {
      output = output.replace(rule.pattern, REDACTED);
      continue;
    }
    output = output.replace(rule.pattern, (_match, prefix: string) => `${prefix}${REDACTED}`);
  }

  return output;
}

/** Redact, collapse whitespace, and cap the length of a message. */
export function sanitizeMessage(text: string, max = 300, knownSecrets: (string | undefined)[] = []): string {
  const redacted = redactSecrets(text, knownSecrets)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return redacted.length > max ? `${redacted.slice(0, max)}…` : redacted;
}