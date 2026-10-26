import { AnalysisError } from "./errors";

export interface PullRequestRef {
  owner: string;
  repo: string;
  number: number;
  canonicalUrl: string;
  host: "github.com";
}

const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
/** Path segments GitHub uses for tabs inside a pull request. */
const ALLOWED_TRAILING_SEGMENTS = new Set([
  "files",
  "commits",
  "checks",
  "conversation",
  "reviews",
]);

function fail(code: "invalid_url" | "unsupported_host", message: string, hint?: string): never {
  throw new AnalysisError(code, message, { status: 400, hint });
}

/**
 * Parse a public GitHub pull request URL.
 *
 * Only `github.com/<owner>/<repo>/pull/<number>` is accepted. The parser is
 * intentionally strict because the value is user input and is later used to
 * build GitHub API requests (never fetch the submitted URL directly).
 */
export function parsePullRequestUrl(input: string): PullRequestRef {
  const raw = typeof input === "string" ? input.trim() : "";
  if (!raw) {
    fail("invalid_url", "Enter a GitHub pull request URL.", "Example: https://github.com/vercel/next.js/pull/12345");
  }
  if (raw.length > 512) {
    fail("invalid_url", "That URL is too long to be a pull request URL.");
  }

  // URL parsers silently strip tabs, newlines and other control characters
  // before parsing, which can hide a different host than the user typed.
  if (/[\u0000-\u001F\u007F]/.test(raw)) {
    fail("invalid_url", "The URL contains control characters.");
  }
  // Backslashes are treated as slashes by some parsers and as literals by
  // others; legitimate pull request URLs never contain them.
  if (raw.includes("\\")) {
    fail("invalid_url", "Backslashes are not valid in a pull request URL.");
  }

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    fail("invalid_url", "That does not look like a URL.", "Paste the full pull request link from your browser.");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    fail("invalid_url", "Only http and https links are supported.");
  }

  const host = url.hostname.toLowerCase();
  if (host !== "github.com" && host !== "www.github.com") {
    fail(
      "unsupported_host",
      `Only public github.com pull requests are supported (received "${url.hostname}").`,
      "GitLab, Bitbucket, Gitea and GitHub Enterprise hosts are out of scope.",
    );
  }
  if (url.port && url.port !== "443") {
    fail("unsupported_host", "GitHub pull request URLs must not include a port.");
  }
  if (url.username || url.password) {
    fail("invalid_url", "Credentials must not be embedded in the URL.");
  }

  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length < 4) {
    fail(
      "invalid_url",
      "That URL does not point at a pull request.",
      "Expected format: https://github.com/owner/repository/pull/123",
    );
  }

  // Percent-encoding could smuggle separators or homoglyphs past the owner,
  // repository and number patterns below; GitHub never percent-encodes them.
  if (url.pathname.includes("%")) {
    fail("invalid_url", "Percent-encoded characters are not supported in pull request URLs.");
  }

  const [owner, repo, pullSegment, numberSegment, ...rest] = segments;
  if (!owner || !repo || pullSegment !== "pull" || !numberSegment) {
    fail(
      "invalid_url",
      "That URL does not point at a pull request.",
      "Expected format: https://github.com/owner/repository/pull/123",
    );
  }

  if (rest.length > 0) {
    const extra = rest[0]?.toLowerCase() ?? "";
    if (!ALLOWED_TRAILING_SEGMENTS.has(extra)) {
      fail(
        "invalid_url",
        `The pull request link has an unsupported section ("${extra}").`,
        "Drop everything after the pull request number.",
      );
    }
  }

  if (!OWNER_PATTERN.test(owner) || owner === "." || owner === "..") {
    fail("invalid_url", `"${owner}" is not a valid GitHub owner name.`);
  }
  if (!REPO_PATTERN.test(repo) || repo === "." || repo === "..") {
    fail("invalid_url", `"${repo}" is not a valid GitHub repository name.`);
  }
  if (!/^\d{1,7}$/.test(numberSegment) || Number(numberSegment) < 1) {
    fail("invalid_url", `"${numberSegment}" is not a valid pull request number.`);
  }

  const number = Number(numberSegment);
  return {
    owner,
    repo,
    number,
    canonicalUrl: `https://github.com/${owner}/${repo}/pull/${number}`,
    host: "github.com",
  };
}

export function tryParsePullRequestUrl(input: string): PullRequestRef | null {
  try {
    return parsePullRequestUrl(input);
  } catch {
    return null;
  }
}