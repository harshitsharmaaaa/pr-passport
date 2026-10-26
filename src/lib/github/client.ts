import { AnalysisError } from "../errors";
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

interface GithubFile {
  filename?: string;
  previous_filename?: string;
  status?: string;
  additions?: number;
  deletions?: number;
  changes?: number;
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
      const minutes = Number.isFinite(reset) && reset > 0
        ? Math.max(1, Math.ceil((reset * 1000 - Date.now()) / 60_000))
        : null;
      return new AnalysisError("rate_limited", "GitHub's API rate limit is exhausted.", {
        status: 429,
        hint: minutes
          ? `Try again in about ${minutes} minute(s), or set GITHUB_TOKEN for a higher limit.`
          : "Set GITHUB_TOKEN for a higher limit, then try again.",
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
    } catch {
      throw new AnalysisError("github_unavailable", "Could not reach the GitHub API.", {
        status: 502,
        hint: "Check the server's network connection and try again.",
      });
    }

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

  private async paginate<T>(path: string, maxPages: number): Promise<T[]> {
    const items: T[] = [];
    for (let page = 1; page <= maxPages; page += 1) {
      const separator = path.includes("?") ? "&" : "?";
      const batch = await this.request<T[]>(`${path}${separator}per_page=100&page=${page}`, {
        allowNotFound: true,
      });
      if (!batch) break;
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
    if (!repo?.full_name) {
      throw new AnalysisError("github_unavailable", "GitHub did not return the base repository for this pull request.", {
        status: 502,
      });
    }

    const state = pr.merged_at ? "merged" : pr.state === "closed" ? "closed" : "open";
    const headSha = pr.head?.sha ?? "";
    if (!headSha) {
      throw new AnalysisError("github_unavailable", "GitHub did not return a head commit for this pull request.", {
        status: 502,
      });
    }

    return {
      owner: ref.owner,
      repo: ref.repo,
      number: pr.number ?? ref.number,
      url: pr.html_url ?? `https://github.com/${ref.owner}/${ref.repo}/pull/${ref.number}`,
      title: pr.title ?? "",
      body: pr.body ?? "",
      author: pr.user?.login ?? "unknown",
      authorUrl: pr.user?.html_url ?? `https://github.com/${pr.user?.login ?? ""}`,
      state,
      draft: Boolean(pr.draft),
      createdAt: pr.created_at ?? "",
      updatedAt: pr.updated_at ?? "",
      headRef: pr.head?.ref ?? "",
      headSha,
      baseRef: pr.base?.ref ?? "",
      baseSha: pr.base?.sha ?? "",
      labels: (pr.labels ?? []).map((label) => label.name ?? "").filter(Boolean),
      repository: {
        fullName: repo.full_name,
        url: repo.html_url ?? `https://github.com/${repo.full_name}`,
        stars: clampNumber(repo.stargazers_count),
        language: repo.language ?? undefined,
        defaultBranch: repo.default_branch ?? "main",
      },
      mergeable: typeof pr.mergeable === "boolean" ? pr.mergeable : null,
      mergeableState: pr.mergeable_state ?? "",
      additions: clampNumber(pr.additions),
      deletions: clampNumber(pr.deletions),
      changedFileCount: clampNumber(pr.changed_files),
      commitCount: clampNumber(pr.commits),
    };
  }

  async getChangedFiles(ref: { owner: string; repo: string; number: number }): Promise<ChangedFile[]> {
    const raw = await this.paginate<GithubFile>(
      `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/pulls/${ref.number}/files`,
      MAX_FILE_PAGES,
    );

    return raw
      .filter((file) => typeof file.filename === "string" && file.filename.length > 0)
      .map((file) => ({
        filename: file.filename as string,
        previousFilename: file.previous_filename,
        status: normaliseStatus(file.status),
        additions: clampNumber(file.additions),
        deletions: clampNumber(file.deletions),
        changes: clampNumber(file.changes, clampNumber(file.additions) + clampNumber(file.deletions)),
      }));
  }

  async getCommits(ref: { owner: string; repo: string; number: number }): Promise<CommitSummary[]> {
    const raw = await this.paginate<GithubCommit>(
      `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/pulls/${ref.number}/commits`,
      MAX_COMMIT_PAGES,
    );

    return raw
      .filter((commit) => typeof commit.sha === "string" && commit.sha.length > 0)
      .map((commit) => {
        const sha = commit.sha as string;
        return {
          sha,
          shortSha: sha.slice(0, 7),
          message: commit.commit?.message ?? "",
          author: commit.commit?.author?.name ?? commit.author?.login ?? "unknown",
          date: commit.commit?.author?.date ?? "",
          verified: Boolean(commit.commit?.verification?.verified),
        };
      });
  }

  async getCi(ref: { owner: string; repo: string; number: number }, headSha: string): Promise<CiSummary> {
    const base = `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/commits/${headSha}`;
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

    const failing: CiCheck[] = [];
    const pending: CiCheck[] = [];
    let successful = 0;

    if (runsResult.status === "fulfilled") {
      for (const run of runsResult.value?.check_runs ?? []) {
        const name = run.name ?? "unnamed check";
        const url = run.html_url ?? run.details_url;
        const conclusion = run.conclusion ?? undefined;
        if (run.status !== "completed") {
          pending.push({ name, url, conclusion });
        } else if (
          conclusion === "failure" ||
          conclusion === "timed_out" ||
          conclusion === "cancelled" ||
          conclusion === "action_required" ||
          conclusion === "startup_failure"
        ) {
          failing.push({ name, url, conclusion });
        } else {
          successful += 1;
        }
      }
    }

    if (statusResult.status === "fulfilled") {
      for (const status of statusResult.value?.statuses ?? []) {
        const name = status.context ?? "unnamed status";
        if (status.state === "failure" || status.state === "error") {
          failing.push({ name, url: status.target_url, conclusion: status.state });
        } else if (status.state === "pending") {
          pending.push({ name, url: status.target_url, conclusion: status.state });
        } else {
          successful += 1;
        }
      }
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
    const contents = await this.request<GithubContentEntry[] | GithubContentEntry>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents?ref=${baseSha}`,
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
    const encodedPath = path
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");
    const content = await this.request<string>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodedPath}?ref=${ref}`,
      { accept: "application/vnd.github.raw", allowNotFound: true },
    );
    return content ?? null;
  }
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