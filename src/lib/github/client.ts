import { AnalysisError } from "../errors";
import { MAX_PATCH_CHARS, MAX_PATCH_FILES } from "../limits";
import type {
  ChangedFile,
  CiCheck,
  CiSummary,
  CommitSummary,
  PullRequestData,
  PullRequestSource,
  RepoContext,
  RepoFile,
} from "../types";

const API_ROOT = "https://api.github.com";
const USER_AGENT = "pr-passport/0.1 (public contribution compliance checker)";
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_FILE_PAGES = 3;
const MAX_COMMIT_PAGES = 2;

interface GithubUser {
  login?: string;
  html_url?: string;
}

interface GithubRepo {
  full_name?: string;
  html_url?: string;
  stargazers_count?: number;
  language?: string | null;
  default_branch?: string;
}

interface GithubPullRequest {
  number?: number;
  title?: string;
  body?: string | null;
  state?: "open" | "closed";
  draft?: boolean;
  created_at?: string;
  updated_at?: string;
  merged_at?: string | null;
  user?: GithubUser | null;
  head?: { ref?: string; sha?: string };
  base?: { ref?: string; sha?: string; repo?: GithubRepo | null };
  commits?: number;
  additions?: number;
  deletions?: number;
  changed_files?: number;
  mergeable?: boolean | null;
  mergeable_state?: string | null;
  labels?: { name?: string }[];
  html_url?: string;
}

export interface GithubFile {
  filename?: string;
  previous_filename?: string;
  status?: string;
  additions?: number;
  deletions?: number;
  changes?: number;
  patch?: string;
}

interface GithubCommit {
  sha?: string;
  commit?: {
    message?: string;
    author?: { name?: string; date?: string } | null;
    verification?: { verified?: boolean } | null;
  };
  author?: { login?: string } | null;
}

interface GithubContentEntry {
  name?: string;
  path?: string;
  type?: string;
  size?: number;
}

interface GithubCheckRun {
  name?: string;
  status?: string;
  conclusion?: string | null;
  html_url?: string;
  details_url?: string;
}

interface GithubCombinedStatus {
  state?: string;
  statuses?: { context?: string; state?: string; target_url?: string }[];
}

export interface GithubSourceOptions {
  token?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

function clampNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

const OWNER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const REPO_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
const SHA_PATTERN = /^[a-fA-F0-9]{7,40}$/;

/**
 * The client is the only place that turns a parsed reference into request
 * paths, so it re-validates every component instead of trusting callers.
 */
function assertOwnerRepo(owner: string, repo: string): void {
  if (!OWNER_PATTERN.test(owner) || !REPO_PATTERN.test(repo) || owner === "." || repo === ".") {
    throw new AnalysisError("invalid_url", "The repository reference failed validation before any request was made.", {
      status: 400,
    });
  }
}

function assertRef(ref: { owner: string; repo: string; number: number }): void {
  assertOwnerRepo(ref.owner, ref.repo);
  if (!Number.isInteger(ref.number) || ref.number < 1 || ref.number > 9_999_999) {
    throw new AnalysisError("invalid_url", "The pull request number failed validation before any request was made.", {
      status: 400,
    });
  }
}

function assertSha(sha: string): string {
  if (!SHA_PATTERN.test(sha)) {
    throw new AnalysisError(
      "github_unavailable",
      "The pull request head commit is missing or malformed, so CI could not be read.",
      { status: 502 },
    );
  }
  return sha;
}

/** Reject traversal and unsafe segments before a repository path is requested. */
function assertRepositoryPath(path: string): string[] {
  const segments = path.split("/").filter(Boolean);
  if (
    segments.length === 0 ||
    segments.some((segment) => segment === "." || segment === ".." || segment.includes("\\") || segment.includes("%"))
  ) {
    throw new AnalysisError("invalid_url", "The repository file path failed validation before any request was made.", {
      status: 400,
    });
  }
  return segments;
}

/**
 * Requests must stay on the official GitHub API host (or the official raw
 * content host when raw file content is requested). Anything else is refused.
 */
const ALLOWED_RESPONSE_HOSTS = new Set(["api.github.com"]);
const ALLOWED_RAW_RESPONSE_HOSTS = new Set(["api.github.com", "raw.githubusercontent.com"]);

function assertFinalHost(response: Response, acceptRaw: boolean): void {
  let finalHost = "api.github.com";
  try {
    finalHost = new URL(response.url || "https://api.github.com/").hostname.toLowerCase();
  } catch {
    // Keep the default; an unreadable final URL is treated as api.github.com.
  }
  const allowed = acceptRaw ? ALLOWED_RAW_RESPONSE_HOSTS : ALLOWED_RESPONSE_HOSTS;
  if (!allowed.has(finalHost)) {
    throw new AnalysisError(
      "github_unavailable",
      `GitHub redirected the request to an unexpected host (${finalHost}); the response was not used.`,
      { status: 502 },
    );
  }
}

function statusError(status: number, headers: Headers): AnalysisError {
  if (status === 401) {
    return new AnalysisError("github_unavailable", "GitHub rejected the configured token.", {
      status: 502,
      hint: "Check GITHUB_TOKEN, or remove it to use unauthenticated public access.",
    });
  }
  if (status === 403 || status === 429) {
    const remaining = headers.get("x-ratelimit-remaining");
    if (remaining === "0" || status === 429) {
      const reset = Number(headers.get("x-ratelimit-reset"));
      const retryAfter = Number(headers.get("retry-after"));
      const minutes = Number.isFinite(reset) && reset > 0
        ? Math.max(1, Math.ceil((reset * 1000 - Date.now()) / 60_000))
        : null;
      const retryHint = Number.isFinite(retryAfter) && retryAfter > 0
        ? ` Retry after about ${retryAfter} second(s).`
        : "";
      return new AnalysisError("rate_limited", "GitHub's API rate limit is exhausted.", {
        status: 429,
        hint: minutes
          ? `Try again in about ${minutes} minute(s), or set GITHUB_TOKEN for a higher limit.${retryHint}`
          : `Set GITHUB_TOKEN for a higher limit, then try again.${retryHint}`,
      });
    }
    return new AnalysisError("github_unavailable", "GitHub denied this request (HTTP 403).", {
      status: 502,
      hint: "The repository or one of its files may be private or restricted.",
    });
  }
  if (status === 404) {
    return new AnalysisError("not_found", "GitHub did not find that pull request.", {
      status: 404,
      hint: "Check that the repository and pull request are public and the URL is correct.",
    });
  }
  return new AnalysisError("github_unavailable", `GitHub returned HTTP ${status}.`, {
    status: 502,
    hint: "GitHub may be unavailable. Try again shortly.",
  });
}

export class LiveGithubSource implements PullRequestSource {
  private readonly token?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: GithubSourceOptions = {}) {
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  private async request<T>(
    path: string,
    options: { accept?: string; allowNotFound?: boolean } = {},
  ): Promise<T | null> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${API_ROOT}${path}`, {
        headers: {
          Accept: options.accept ?? "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": USER_AGENT,
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        },
        signal: AbortSignal.timeout(this.timeoutMs),
        cache: "no-store",
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new AnalysisError(
          "github_unavailable",
          `GitHub did not respond within ${Math.round(this.timeoutMs / 1000)} second(s).`,
          { status: 504, hint: "GitHub may be slow or unreachable. Try again shortly." },
        );
      }
      throw new AnalysisError("github_unavailable", "Could not reach the GitHub API.", {
        status: 502,
        hint: "Check the server's network connection and try again.",
      });
    }

    assertFinalHost(response, (options.accept ?? "").includes("raw"));

    if (response.status === 404 && options.allowNotFound) return null;
    if (!response.ok) throw statusError(response.status, response.headers);

    if ((options.accept ?? "").includes("raw")) {
      return (await response.text()) as T;
    }

    try {
      return (await response.json()) as T;
    } catch {
      throw new AnalysisError("github_unavailable", "GitHub returned an unreadable response.", {
        status: 502,
      });
    }
  }

  /**
   * Paged listing. A 404 here is a failure, not an empty result, so callers
   * can distinguish "nothing changed" from "the data could not be read".
   */
  private async paginate<T>(path: string, maxPages: number): Promise<T[]> {
    const items: T[] = [];
    for (let page = 1; page <= maxPages; page += 1) {
      const separator = path.includes("?") ? "&" : "?";
      const batch = await this.request<T[]>(`${path}${separator}per_page=100&page=${page}`);
      if (!Array.isArray(batch)) {
        throw new AnalysisError("github_unavailable", "GitHub returned an unexpected listing format.", {
          status: 502,
        });
      }
      items.push(...batch);
      if (batch.length < 100) break;
    }
    return items;
  }

  async getPullRequest(ref: {
    owner: string;
    repo: string;
    number: number;
  }): Promise<PullRequestData> {
    assertRef(ref);
    const pr = await this.request<GithubPullRequest>(
      `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/pulls/${ref.number}`,
      { allowNotFound: true },
    );

    if (!pr) {
      throw new AnalysisError(
        "not_found",
        `Pull request #${ref.number} was not found in ${ref.owner}/${ref.repo}.`,
        {
          status: 404,
          hint: "Only public pull requests are supported. Check the URL, or confirm the pull request is public.",
        },
      );
    }

    const repo = pr.base?.repo;
    if (!repo || typeof repo.full_name !== "string" || repo.full_name.length === 0) {
      throw new AnalysisError("github_unavailable", "GitHub did not return the base repository for this pull request.", {
        status: 502,
      });
    }

    const state = asString(pr.merged_at)
      ? "merged"
      : pr.state === "closed"
        ? "closed"
        : "open";
    const headSha = asString(pr.head?.sha);
    if (!SHA_PATTERN.test(headSha)) {
      throw new AnalysisError("github_unavailable", "GitHub did not return a usable head commit for this pull request.", {
        status: 502,
      });
    }
    const baseSha = asString(pr.base?.sha);
    if (!SHA_PATTERN.test(baseSha)) {
      throw new AnalysisError("github_unavailable", "GitHub did not return a usable base commit for this pull request.", {
        status: 502,
      });
    }

    const labels = Array.isArray(pr.labels)
      ? pr.labels.map((label) => asString(label?.name)).filter(Boolean)
      : [];
    const authorLogin = asString(pr.user?.login);

    return {
      owner: ref.owner,
      repo: ref.repo,
      number: clampNumber(pr.number, ref.number),
      url: asString(pr.html_url) || `https://github.com/${ref.owner}/${ref.repo}/pull/${ref.number}`,
      title: asString(pr.title),
      body: asString(pr.body),
      author: authorLogin || "unknown",
      authorUrl: asString(pr.user?.html_url) || (authorLogin ? `https://github.com/${authorLogin}` : ""),
      state,
      draft: pr.draft === true,
      createdAt: asString(pr.created_at),
      updatedAt: asString(pr.updated_at),
      headRef: asString(pr.head?.ref),
      headSha,
      baseRef: asString(pr.base?.ref),
      baseSha,
      labels,
      repository: {
        fullName: repo.full_name,
        url: asString(repo.html_url) || `https://github.com/${repo.full_name}`,
        stars: clampNumber(repo.stargazers_count),
        language: typeof repo.language === "string" ? repo.language : undefined,
        defaultBranch: asString(repo.default_branch) || "main",
      },
      mergeable: typeof pr.mergeable === "boolean" ? pr.mergeable : null,
      mergeableState: asString(pr.mergeable_state),
      additions: clampNumber(pr.additions),
      deletions: clampNumber(pr.deletions),
      changedFileCount: clampNumber(pr.changed_files),
      commitCount: clampNumber(pr.commits),
    };
  }

  async getChangedFiles(ref: { owner: string; repo: string; number: number }): Promise<ChangedFile[]> {
    assertRef(ref);
    const raw = await this.paginate<GithubFile>(
      `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/pulls/${ref.number}/files`,
      MAX_FILE_PAGES,
    );

    // Patches are capped: only the first few files that expose one are kept.
    const patchAllowed = new Set(
      raw
        .filter((file) => typeof file.patch === "string" && file.patch.trim().length > 0)
        .slice(0, MAX_PATCH_FILES)
        .map((file) => file.filename ?? ""),
    );

    return raw
      .map((file) => toChangedFile(file, patchAllowed.has(file.filename ?? "")))
      .filter((file): file is ChangedFile => file !== null);
  }

  async getCommits(ref: { owner: string; repo: string; number: number }): Promise<CommitSummary[]> {
    assertRef(ref);
    const raw = await this.paginate<GithubCommit>(
      `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/pulls/${ref.number}/commits`,
      MAX_COMMIT_PAGES,
    );

    return raw
      .filter((commit) => typeof commit.sha === "string" && SHA_PATTERN.test(commit.sha))
      .map((commit) => {
        const sha = commit.sha as string;
        return {
          sha,
          shortSha: sha.slice(0, 7),
          message: asString(commit.commit?.message),
          author: asString(commit.commit?.author?.name) || asString(commit.author?.login) || "unknown",
          date: asString(commit.commit?.author?.date),
          verified: commit.commit?.verification?.verified === true,
        };
      });
  }

  async getCi(ref: { owner: string; repo: string; number: number }, headSha: string): Promise<CiSummary> {
    assertRef(ref);
    const sha = assertSha(headSha);
    const base = `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/commits/${sha}`;
    const sourceUrl = `https://github.com/${ref.owner}/${ref.repo}/pull/${ref.number}/checks`;

    const [runsResult, statusResult] = await Promise.allSettled([
      this.request<{ check_runs?: GithubCheckRun[] }>(`${base}/check-runs?per_page=100`, {
        accept: "application/vnd.github+json",
      }),
      this.request<GithubCombinedStatus>(`${base}/status`),
    ]);

    if (runsResult.status === "rejected" && statusResult.status === "rejected") {
      const reason = runsResult.reason instanceof AnalysisError
        ? runsResult.reason.message
        : "GitHub did not expose check runs or commit statuses.";
      return {
        available: false,
        reason,
        state: "unknown",
        total: 0,
        successful: 0,
        failing: [],
        pending: [],
        sourceUrl,
      };
    }

    // One entry per check name. Check runs win over commit statuses that
    // describe the same job so totals are not double-counted.
    interface Entry {
      name: string;
      url?: string;
      conclusion?: string;
      failed: boolean;
      pending: boolean;
    }
    const byName = new Map<string, Entry>();
    const record = (entry: Entry): void => {
      const existing = byName.get(entry.name);
      if (!existing) {
        byName.set(entry.name, entry);
        return;
      }
      existing.failed = existing.failed || entry.failed;
      existing.pending = existing.pending && entry.pending;
      existing.url = existing.url ?? entry.url;
    };

    if (runsResult.status === "fulfilled") {
      const runs = Array.isArray(runsResult.value?.check_runs) ? runsResult.value?.check_runs ?? [] : [];
      for (const run of runs) {
        const name = asString(run?.name) || "unnamed check";
        const conclusion = typeof run?.conclusion === "string" ? run.conclusion : undefined;
        const failed =
          conclusion === "failure" ||
          conclusion === "timed_out" ||
          conclusion === "cancelled" ||
          conclusion === "action_required" ||
          conclusion === "startup_failure";
        const pending = run?.status !== "completed" && !failed;
        record({
          name,
          url: asString(run?.html_url) || asString(run?.details_url) || undefined,
          conclusion,
          failed,
          pending,
        });
      }
    }

    if (statusResult.status === "fulfilled") {
      const statuses = Array.isArray(statusResult.value?.statuses) ? statusResult.value?.statuses ?? [] : [];
      for (const status of statuses) {
        const name = asString(status?.context) || "unnamed status";
        if (byName.has(name)) continue;
        const failed = status?.state === "failure" || status?.state === "error";
        const pending = status?.state === "pending" && !failed;
        record({
          name,
          url: asString(status?.target_url) || undefined,
          conclusion: typeof status?.state === "string" ? status.state : undefined,
          failed,
          pending,
        });
      }
    }

    const failing: CiCheck[] = [];
    const pending: CiCheck[] = [];
    let successful = 0;
    for (const entry of byName.values()) {
      if (entry.failed) failing.push({ name: entry.name, url: entry.url, conclusion: entry.conclusion });
      else if (entry.pending) pending.push({ name: entry.name, url: entry.url, conclusion: entry.conclusion });
      else successful += 1;
    }

    const total = successful + failing.length + pending.length;
    const state: CiSummary["state"] =
      failing.length > 0 ? "failure" : pending.length > 0 ? "pending" : total > 0 ? "success" : "none";

    return {
      available: true,
      state,
      total,
      successful,
      failing,
      pending,
      sourceUrl,
    };
  }

  async getRepoContext(owner: string, repo: string, baseSha: string): Promise<RepoContext> {
    assertOwnerRepo(owner, repo);
    const sha = assertSha(baseSha);
    const contents = await this.request<GithubContentEntry[] | GithubContentEntry>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents?ref=${sha}`,
      { allowNotFound: true },
    );

    const entries = Array.isArray(contents) ? contents : [];
    const files: RepoFile[] = entries
      .filter((entry) => entry.type === "file" && typeof entry.path === "string")
      .map((entry) => ({ path: entry.path as string, size: clampNumber(entry.size) }));

    const names = new Set(files.map((file) => file.path));
    let packageJson: RepoContext["packageJson"];
    let packageManager: RepoContext["packageManager"];

    if (names.has("package.json")) {
      const raw = await this.readRepositoryFile(owner, repo, "package.json", baseSha);
      if (raw) {
        const parsed = safeJson(raw);
        const scripts =
          parsed && typeof parsed === "object" && parsed.scripts && typeof parsed.scripts === "object"
            ? Object.fromEntries(
                Object.entries(parsed.scripts as Record<string, unknown>).filter(
                  (entry): entry is [string, string] => typeof entry[1] === "string",
                ),
              )
            : {};
        const declared =
          parsed && typeof parsed === "object" && typeof parsed.packageManager === "string"
            ? parsed.packageManager
            : undefined;
        packageJson = { raw, scripts, packageManager: declared };
        packageManager = detectPackageManager(declared, names);
      }
    }

    if (!packageManager) packageManager = detectPackageManager(undefined, names);

    return {
      files,
      packageJson,
      packageManager,
      hasPyproject: names.has("pyproject.toml"),
      hasCargo: names.has("Cargo.toml"),
      hasGoMod: names.has("go.mod"),
      hasMakefile: names.has("Makefile") || names.has("makefile"),
    };
  }

  async readRepositoryFile(
    owner: string,
    repo: string,
    path: string,
    ref: string,
  ): Promise<string | null> {
    assertOwnerRepo(owner, repo);
    const segments = assertRepositoryPath(path);
    const encodedPath = segments.map((segment) => encodeURIComponent(segment)).join("/");
    const content = await this.request<string>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`,
      { accept: "application/vnd.github.raw", allowNotFound: true },
    );
    return content ?? null;
  }
}

/** Cap a unified diff so prompts stay small; the marker makes truncation visible. */
export function truncatePatch(patch: string): string {
  const normalized = patch.replace(/\r\n?/g, "\n");
  if (normalized.length <= MAX_PATCH_CHARS) return normalized;
  return `${normalized.slice(0, MAX_PATCH_CHARS)}\n[truncated by PR Passport]`;
}

export function toChangedFile(raw: GithubFile, allowPatch: boolean): ChangedFile | null {
  const filename = typeof raw.filename === "string" ? raw.filename : "";
  if (!filename) return null;

  const additions = clampNumber(raw.additions);
  const deletions = clampNumber(raw.deletions);
  const file: ChangedFile = {
    filename,
    previousFilename: raw.previous_filename,
    status: normaliseStatus(raw.status),
    additions,
    deletions,
    changes: clampNumber(raw.changes, additions + deletions),
  };

  if (allowPatch && typeof raw.patch === "string" && raw.patch.trim().length > 0) {
    file.patch = truncatePatch(raw.patch);
  }
  return file;
}

function normaliseStatus(status: string | undefined): ChangedFile["status"] {
  switch (status) {
    case "added":
    case "removed":
    case "renamed":
    case "copied":
    case "changed":
    case "unchanged":
      return status;
    case "modified":
      return "modified";
    default:
      return "modified";
  }
}

function safeJson(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function detectPackageManager(
  declared: string | undefined,
  names: Set<string>,
): RepoContext["packageManager"] {
  const name = declared?.split("@")[0];
  if (name === "bun" || name === "pnpm" || name === "yarn" || name === "npm") return name;
  if (names.has("bun.lockb") || names.has("bun.lock")) return "bun";
  if (names.has("pnpm-lock.yaml")) return "pnpm";
  if (names.has("yarn.lock")) return "yarn";
  if (names.has("package-lock.json")) return "npm";
  if (names.has("package.json")) return "npm";
  return undefined;
}

export function createGithubSource(options: GithubSourceOptions = {}): LiveGithubSource {
  return new LiveGithubSource(options);
}