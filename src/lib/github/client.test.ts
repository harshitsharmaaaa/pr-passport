import { describe, expect, it } from "bun:test";
import { LiveGithubSource, toChangedFile, truncatePatch, type GithubSourceOptions } from "./client";
import { MAX_PATCH_CHARS } from "../limits";
import { AnalysisError } from "../errors";
import { BASE_SHA, HEAD_SHA } from "../test-support";
import {
  createGitHubFetch,
  Failure,
  githubCheckRunPayload,
  githubPullRequestPayload,
  githubRootListing,
  githubStatusPayload,
  Raw,
  type GitHubMockRoutes,
} from "./mock";

describe("toChangedFile", () => {
  it("maps fields and keeps the previous filename for renames", () => {
    const file = toChangedFile(
      {
        filename: "src/after.ts",
        previous_filename: "src/before.ts",
        status: "renamed",
        additions: 3,
        deletions: 1,
        changes: 4,
        patch: "@@ -1 +1 @@",
      },
      false,
    );
    expect(file).toMatchObject({
      filename: "src/after.ts",
      previousFilename: "src/before.ts",
      status: "renamed",
      additions: 3,
      deletions: 1,
      changes: 4,
    });
    expect(file?.patch).toBeUndefined();
  });

  it("normalises unknown statuses to modified and defaults changes", () => {
    expect(toChangedFile({ filename: "f.txt", status: "weird" }, false)?.status).toBe("modified");
    expect(toChangedFile({ filename: "f.txt" }, false)?.changes).toBe(0);
  });

  it("returns null when GitHub sends no filename", () => {
    expect(toChangedFile({}, true)).toBeNull();
  });

  it("attaches the patch only when allowed", () => {
    expect(toChangedFile({ filename: "a.ts", patch: "@@ -1 +1 @@" }, true)?.patch).toBe("@@ -1 +1 @@");
    expect(toChangedFile({ filename: "a.ts", patch: "@@ -1 +1 @@" }, false)?.patch).toBeUndefined();
    expect(toChangedFile({ filename: "a.ts", patch: "   " }, true)?.patch).toBeUndefined();
  });
});

describe("truncatePatch", () => {
  it("normalises line endings", () => {
    expect(truncatePatch("a\r\nb\rc")).toBe("a\nb\nc");
  });

  it("keeps short patches unchanged", () => {
    const patch = "@@ -1,2 +1,3 @@\n+line";
    expect(truncatePatch(patch)).toBe(patch);
  });

  it("truncates long patches with a visible marker", () => {
    const long = "x".repeat(MAX_PATCH_CHARS + 500);
    const truncated = truncatePatch(long);
    expect(truncated.endsWith("\n[truncated by PR Passport]")).toBe(true);
    expect(truncated.indexOf("x")).toBe(0);
    expect(truncated.length).toBeLessThan(long.length);
  });
});

/* ---------- Behaviour against a mocked GitHub API ---------- */

const REF = { owner: "acme", repo: "widget-kit", number: 42 };

function sourceWith(routes: GitHubMockRoutes, options: GithubSourceOptions = {}) {
  const mock = createGitHubFetch(routes);
  const client = new LiveGithubSource({ fetchImpl: mock.fetchImpl, ...options });
  return { mock, client };
}

describe("LiveGithubSource over a mocked GitHub API", () => {
  it("maps a full pull request payload and sends the right headers", async () => {
    const { mock, client } = sourceWith({
      pullRequest: githubPullRequestPayload({ user_login: null, labels: undefined }),
    });
    const pr = await client.getPullRequest(REF);

    expect(pr).toMatchObject({
      owner: "acme",
      repo: "widget-kit",
      number: 42,
      state: "open",
      headSha: HEAD_SHA,
      baseSha: BASE_SHA,
      mergeable: true,
      author: "unknown",
      labels: [],
      repository: { fullName: "acme/widget-kit", defaultBranch: "main", stars: 1840 },
    });
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]).toMatchObject({ method: "GET", host: "api.github.com" });
    expect(mock.calls[0]?.headers["user-agent"]).toContain("pr-passport");
    expect(mock.calls[0]?.headers["x-github-api-version"]).toBe("2022-11-28");
    expect(mock.calls[0]?.headers.authorization).toBeUndefined();
  });

  it("sends the bearer token only when one is configured", async () => {
    const { mock, client } = sourceWith(
      { pullRequest: githubPullRequestPayload() },
      { token: "gh-token" },
    );
    await client.getPullRequest(REF);
    expect(mock.calls[0]?.headers.authorization).toBe("Bearer gh-token");
  });

  it("rejects invalid references before any network call", async () => {
    const { mock, client } = sourceWith({ pullRequest: githubPullRequestPayload() });
    await expect(client.getPullRequest({ ...REF, number: 0 })).rejects.toMatchObject({ code: "invalid_url" });
    await expect(client.getPullRequest({ ...REF, owner: "../etc" })).rejects.toBeInstanceOf(AnalysisError);
    await expect(client.getChangedFiles({ ...REF, number: 10_000_000 })).rejects.toMatchObject({ code: "invalid_url" });
    expect(mock.calls).toHaveLength(0);
  });

  it("refuses repository paths that could traverse the API", async () => {
    const { mock, client } = sourceWith({});
    await expect(
      client.readRepositoryFile("acme", "widget-kit", "../../etc/passwd", BASE_SHA),
    ).rejects.toMatchObject({ code: "invalid_url" });
    await expect(
      client.readRepositoryFile("acme", "widget-kit", "docs/%2e%2e/hidden", BASE_SHA),
    ).rejects.toMatchObject({ code: "invalid_url" });
    expect(mock.calls).toHaveLength(0);
  });

  it("rejects a malformed head sha before reading CI", async () => {
    const { mock, client } = sourceWith({});
    await expect(client.getCi(REF, "not-a-sha")).rejects.toMatchObject({ code: "github_unavailable" });
    expect(mock.calls).toHaveLength(0);
  });

  it("maps 404 for the pull request to not_found", async () => {
    const { client } = sourceWith({ pullRequest: new Failure(404, { message: "Not Found" }) });
    await expect(client.getPullRequest(REF)).rejects.toMatchObject({ code: "not_found" });
  });

  it("maps GitHub rate limiting with the retry-after hint", async () => {
    const { client } = sourceWith({
      pullRequest: new Failure(
        403,
        { message: "API rate limit exceeded" },
        {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3_600),
          "retry-after": "60",
        },
      ),
    });
    try {
      await client.getPullRequest(REF);
      throw new Error("expected a rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(AnalysisError);
      const analysisError = error as AnalysisError;
      expect(analysisError.code).toBe("rate_limited");
      expect(analysisError.hint).toContain("60 second");
    }
  });

  it("maps a non-rate-limit 403, 401, and 5xx to github_unavailable", async () => {
    const plain403 = sourceWith({ pullRequest: new Failure(403, { message: "private" }) });
    await expect(plain403.client.getPullRequest(REF)).rejects.toMatchObject({ code: "github_unavailable" });

    const unauthorised = sourceWith({ pullRequest: new Failure(401, { message: "Bad credentials" }) });
    await expect(unauthorised.client.getPullRequest(REF)).rejects.toMatchObject({ code: "github_unavailable" });

    const serverError = sourceWith({ pullRequest: new Failure(500, { message: "boom" }) });
    await expect(serverError.client.getPullRequest(REF)).rejects.toMatchObject({ code: "github_unavailable" });
  });

  it("treats malformed JSON as an unavailable response", async () => {
    const { client } = sourceWith({ pullRequest: new Raw("<html>oops</html>", 200, "text/html") });
    await expect(client.getPullRequest(REF)).rejects.toThrow("unreadable response");
  });

  it("distinguishes network failures from timeouts and always passes an abort signal", async () => {
    const signals: AbortSignal[] = [];
    const networkDown = new LiveGithubSource({
      fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        signals.push(init?.signal as AbortSignal);
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
    });
    await expect(networkDown.getPullRequest(REF)).rejects.toThrow("Could not reach the GitHub API");
    expect(signals[0]).toBeInstanceOf(AbortSignal);

    const timedOut = new LiveGithubSource({
      fetchImpl: (async () => {
        throw Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
      }) as unknown as typeof fetch,
    });
    await expect(timedOut.getPullRequest(REF)).rejects.toThrow("did not respond within");
  });

  it("refuses responses served from hosts other than the official API", async () => {
    const { client } = sourceWith({
      pullRequest: new Raw(
        JSON.stringify(githubPullRequestPayload()),
        200,
        "application/json",
        "https://evil.test/payload",
      ),
    });
    await expect(client.getPullRequest(REF)).rejects.toThrow("unexpected host");
  });

  it("reads raw repository files from the official raw host", async () => {
    const { mock, client } = sourceWith({
      rawFiles: {
        "CONTRIBUTING.md": new Raw(
          "# Contributing",
          200,
          "text/plain",
          "https://raw.githubusercontent.com/acme/widget-kit/main/CONTRIBUTING.md",
        ),
      },
    });
    const text = await client.readRepositoryFile("acme", "widget-kit", "CONTRIBUTING.md", BASE_SHA);
    expect(text).toBe("# Contributing");
    expect(mock.calls[0]?.headers.accept).toContain("raw");
    expect(mock.calls[0]?.url).toContain(`ref=${encodeURIComponent(BASE_SHA)}`);
  });

  it("returns null for a missing repository file", async () => {
    const { client } = sourceWith({});
    const text = await client.readRepositoryFile("acme", "widget-kit", "CONTRIBUTING.md", BASE_SHA);
    expect(text).toBeNull();
  });

  it("treats an empty listing as empty and a 404 listing as missing", async () => {
    const empty = sourceWith({ files: [] });
    expect(await empty.client.getChangedFiles(REF)).toEqual([]);
    expect(empty.mock.calls).toHaveLength(1);

    const missing = sourceWith({ files: new Failure(404, { message: "Not Found" }) });
    await expect(missing.client.getChangedFiles(REF)).rejects.toMatchObject({ code: "not_found" });
  });

  it("paginates only while pages are full", async () => {
    const page = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        filename: `src/file-${index}.ts`,
        status: "modified",
        additions: 1,
        deletions: 0,
        changes: 1,
      }));
    let requests = 0;
    const client = new LiveGithubSource({
      fetchImpl: (async () => {
        requests += 1;
        return new Response(JSON.stringify(requests === 1 ? page(100) : page(2)), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as unknown as typeof fetch,
    });
    const files = await client.getChangedFiles(REF);
    expect(files).toHaveLength(102);
    expect(requests).toBe(2);
  });

  it("aggregates check runs and statuses and dedupes shared check names", async () => {
    const { client } = sourceWith({
      checkRuns: {
        total_count: 3,
        check_runs: [
          githubCheckRunPayload("lint", "completed", "success"),
          githubCheckRunPayload("tests", "completed", "failure"),
          githubCheckRunPayload("e2e", "in_progress", null),
        ],
      },
      status: {
        state: "failure",
        statuses: [
          githubStatusPayload("ci/build", "success"),
          githubStatusPayload("tests", "failure"),
        ],
      },
    });
    const ci = await client.getCi(REF, HEAD_SHA);
    expect(ci).toMatchObject({ available: true, state: "failure", total: 4, successful: 2 });
    expect(ci.failing.map((check) => check.name)).toEqual(["tests"]);
    expect(ci.pending.map((check) => check.name)).toEqual(["e2e"]);
  });

  it("reports CI as unavailable only when both endpoints fail", async () => {
    const both = sourceWith({
      checkRuns: new Failure(403, { message: "nope" }),
      status: new Failure(403, { message: "nope" }),
    });
    const bothResult = await both.client.getCi(REF, HEAD_SHA);
    expect(bothResult.available).toBe(false);
    expect(bothResult.state).toBe("unknown");

    const one = sourceWith({
      checkRuns: new Failure(403, { message: "nope" }),
      status: { state: "success", statuses: [githubStatusPayload("ci/build", "success")] },
    });
    const oneResult = await one.client.getCi(REF, HEAD_SHA);
    expect(oneResult.available).toBe(true);
    expect(oneResult.total).toBe(1);
  });

  it("reports CI as present but empty when nothing is configured", async () => {
    const { client } = sourceWith({
      checkRuns: { total_count: 0, check_runs: [] },
      status: { state: "clean", statuses: [] },
    });
    const ci = await client.getCi(REF, HEAD_SHA);
    expect(ci).toMatchObject({ available: true, state: "none", total: 0 });
  });

  it("builds repository context and tolerates an unreadable package.json", async () => {
    const { client } = sourceWith({
      rootContents: githubRootListing(["package.json", "bun.lockb", "Cargo.toml"]),
      rawFiles: { "package.json": new Raw("{not json") },
    });
    const context = await client.getRepoContext("acme", "widget-kit", BASE_SHA);
    expect(context).toMatchObject({ hasCargo: true, packageManager: "bun" });
    expect(context.packageJson?.scripts).toEqual({});
  });

  it("yields an empty repository context when the listing is missing", async () => {
    const { client } = sourceWith({});
    const context = await client.getRepoContext("acme", "widget-kit", BASE_SHA);
    expect(context.files).toEqual([]);
    expect(context.packageJson).toBeUndefined();
  });
});
