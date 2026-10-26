import { BASE_SHA, HEAD_SHA } from "../test-support";

/**
 * Deterministic in-process stand-in for the GitHub REST API. It records every
 * request so tests can assert that the client only ever performs GETs against
 * the official API host, never writes, and never follows unexpected redirects.
 */

export class Failure {
  readonly __failure = true;

  constructor(
    readonly status: number,
    readonly body: unknown = { message: "error" },
    readonly headers: Record<string, string> = {},
    /** Simulates the final URL a real fetch would land on after redirects. */
    readonly servedFrom?: string,
  ) {}
}

export class Raw {
  readonly __raw = true;

  constructor(
    readonly body: string,
    readonly status = 200,
    readonly contentType = "application/json",
    readonly servedFrom?: string,
  ) {}
}

export type Responder = unknown | Failure | Raw;

export interface RecordedCall {
  method: string;
  url: string;
  host: string;
  headers: Record<string, string>;
}

export interface GitHubMockRoutes {
  pullRequest?: Responder;
  files?: Responder;
  commits?: Responder;
  checkRuns?: Responder;
  status?: Responder;
  rootContents?: Responder;
  /** Raw repository file contents keyed by their repository path. */
  rawFiles?: Record<string, Responder>;
}

export function createGitHubFetch(routes: GitHubMockRoutes = {}): {
  fetchImpl: typeof fetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];

  async function respond(responder: Responder): Promise<Response> {
    if (responder instanceof Failure) {
      return withUrl(
        new Response(
          typeof responder.body === "string" ? responder.body : JSON.stringify(responder.body),
          { status: responder.status, headers: responder.headers },
        ),
        responder.servedFrom,
      );
    }
    if (responder instanceof Raw) {
      return withUrl(
        new Response(responder.body, {
          status: responder.status,
          headers: { "Content-Type": responder.contentType },
        }),
        responder.servedFrom,
      );
    }
    return new Response(JSON.stringify(responder ?? null), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  function withUrl(response: Response, servedFrom: string | undefined): Response {
    if (servedFrom) {
      Object.defineProperty(response, "url", { value: servedFrom, configurable: true });
    }
    return response;
  }

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
    const headers: Record<string, string> = {};
    if (init?.headers) {
      for (const [key, value] of new Headers(init.headers).entries()) headers[key.toLowerCase()] = value;
    }
    const call: RecordedCall = {
      method: (init?.method ?? "GET").toUpperCase(),
      url: url.toString(),
      host: url.hostname.toLowerCase(),
      headers,
    };
    calls.push(call);

    if (call.method !== "GET") {
      return new Response(JSON.stringify({ message: "writes are never expected" }), { status: 405 });
    }

    const responder = matchRoute(url, routes);
    if (responder === undefined) {
      return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    }
    return respond(responder);
  }) as typeof fetch;

  return { fetchImpl, calls };
}

function matchRoute(url: URL, routes: GitHubMockRoutes): Responder | undefined {
  const path = url.pathname;

  const pr = /^\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)(?:\/(files|commits))?$/.exec(path);
  if (pr) {
    if (pr[2] === "files") return routes.files;
    if (pr[2] === "commits") return routes.commits;
    return routes.pullRequest;
  }

  if (/\/commits\/[^/]+\/check-runs$/.test(path)) return routes.checkRuns;
  if (/\/commits\/[^/]+\/status$/.test(path)) return routes.status;

  if (/^\/repos\/[^/]+\/[^/]+\/contents\/?$/.test(path)) return routes.rootContents;

  const file = /^\/repos\/[^/]+\/[^/]+\/contents\/(.+)$/.exec(path);
  if (file) {
    const requested = decodeURIComponent(file[1] ?? "");
    const map = routes.rawFiles ?? {};
    return requested in map ? map[requested] : new Failure(404, { message: "Not Found" });
  }

  return undefined;
}

/* ---------- GitHub wire-format payload builders (camelCase JSON) ---------- */

export interface PullRequestOverrides {
  number?: number;
  title?: string;
  body?: string | null;
  state?: "open" | "closed";
  merged_at?: string | null;
  draft?: boolean;
  head_ref?: string;
  head_sha?: string;
  base_ref?: string;
  base_sha?: string;
  mergeable?: boolean | null;
  mergeable_state?: string | null;
  commits?: number;
  additions?: number;
  deletions?: number;
  changed_files?: number;
  labels?: { name: string }[];
  user_login?: string | null;
  full_name?: string;
  default_branch?: string;
}

export function githubPullRequestPayload(overrides: PullRequestOverrides = {}): Record<string, unknown> {
  const owner = "acme";
  const repo = "widget-kit";
  const number = overrides.number ?? 42;
  return {
    number,
    title: overrides.title ?? "feat(api): add cursor pagination",
    body: overrides.body !== undefined ? overrides.body : "Fixes #12\n\nAdds cursor pagination to the widgets endpoint.",
    state: overrides.state ?? "open",
    draft: overrides.draft ?? false,
    created_at: "2026-10-18T09:00:00Z",
    updated_at: "2026-10-24T16:00:00Z",
    merged_at: overrides.merged_at ?? null,
    user: overrides.user_login === null ? null : { login: overrides.user_login ?? "sam-dev", html_url: `https://github.com/${overrides.user_login ?? "sam-dev"}` },
    head: { ref: overrides.head_ref ?? "pagination-cursor", sha: overrides.head_sha ?? HEAD_SHA },
    base: {
      ref: overrides.base_ref ?? "main",
      sha: overrides.base_sha ?? BASE_SHA,
      repo: {
        full_name: overrides.full_name ?? `${owner}/${repo}`,
        html_url: `https://github.com/${overrides.full_name ?? `${owner}/${repo}`}`,
        stargazers_count: 1_840,
        language: "TypeScript",
        default_branch: overrides.default_branch ?? "main",
      },
    },
    commits: overrides.commits ?? 2,
    additions: overrides.additions ?? 40,
    deletions: overrides.deletions ?? 8,
    changed_files: overrides.changed_files ?? 2,
    mergeable: overrides.mergeable !== undefined ? overrides.mergeable : true,
    mergeable_state: overrides.mergeable_state ?? "clean",
    labels: overrides.labels ?? [],
    html_url: `https://github.com/${owner}/${repo}/pull/${number}`,
  };
}

export function githubCommitPayload(
  sha: string,
  message: string,
  author = "Sam Rivera",
  login = "sam-dev",
): Record<string, unknown> {
  return {
    sha,
    commit: {
      message,
      author: { name: author, date: "2026-10-20T10:00:00Z" },
      verification: { verified: false },
    },
    author: { login },
  };
}

export function githubCheckRunPayload(
  name: string,
  status: string,
  conclusion: string | null = "success",
): Record<string, unknown> {
  return { name, status, conclusion, html_url: "https://github.com/acme/widget-kit/pull/42/checks" };
}

export function githubStatusPayload(context: string, state: string): Record<string, unknown> {
  return { context, state, target_url: "https://example.com/status" };
}

export function githubRootListing(paths: string[]): Record<string, unknown>[] {
  return paths.map((path) => ({ name: path, path, type: "file", size: 120 }));
}
