import { describe, expect, it } from "bun:test";
import { AnalysisError } from "../errors";
import { BASE_SHA, HEAD_SHA, OTHER_SHA } from "../test-support";
import { LiveGithubSource } from "./client";
import {
  createGitHubFetch,
  Failure,
  Raw,
  githubCommitPayload,
  githubPullRequestPayload,
  type GitHubMockRoutes,
} from "./mock";

/*
 * Edge cases in the GitHub adapter that the route suite does not exercise:
 * null pull request fields, commits with missing metadata, and partial
 * pagination failures. All requests are served by the in-process mock.
 */

const REF = { owner: "acme", repo: "widget-kit", number: 42 };

function source(routes: GitHubMockRoutes) {
  const mock = createGitHubFetch(routes);
  return { mock, client: new LiveGithubSource({ fetchImpl: mock.fetchImpl }) };
}

describe("pull request field defaults", () => {
  it("maps a null description and absent counters without inventing values", async () => {
    const { client } = source({
      pullRequest: githubPullRequestPayload({
        body: null,
        user_login: null,
        labels: undefined,
        additions: undefined,
        deletions: undefined,
        changed_files: undefined,
        commits: undefined,
      }),
    });

    const pr = await client.getPullRequest(REF);

    expect(pr.body).toBe("");
    expect(pr.author).toBe("unknown");
    expect(pr.authorUrl).toBe("");
    expect(pr.labels).toEqual([]);
    expect(pr.additions).toBe(40);
    expect(pr.deletions).toBe(8);
    expect(pr.changedFileCount).toBe(2);
    expect(pr.commitCount).toBe(2);
  });

  it("rejects a pull request without a usable head or base commit", async () => {
    for (const overrides of [
      { head_sha: "" },
      { head_sha: "not-a-sha" },
      { base_sha: "" },
    ]) {
      const { client } = source({ pullRequest: githubPullRequestPayload(overrides) });
      try {
        await client.getPullRequest(REF);
        throw new Error("expected the adapter to reject");
      } catch (error) {
        expect(error).toBeInstanceOf(AnalysisError);
        expect((error as AnalysisError).code).toBe("github_unavailable");
      }
    }
  });

  it("rejects a pull request whose base repository is missing", async () => {
    const payload = githubPullRequestPayload();
    (payload.base as Record<string, unknown>).repo = null;
    const { client } = source({ pullRequest: payload });

    await expect(client.getPullRequest(REF)).rejects.toMatchObject({ code: "github_unavailable" });
  });
});

describe("commit metadata", () => {
  it("keeps commits with missing message, author, and date metadata", async () => {
    const { client } = source({
      commits: [
        { sha: HEAD_SHA },
        { sha: OTHER_SHA, commit: { message: null, author: null, verification: null }, author: null },
      ],
    });

    const commits = await client.getCommits(REF);

    expect(commits).toHaveLength(2);
    expect(commits[0]).toEqual({
      sha: HEAD_SHA,
      shortSha: HEAD_SHA.slice(0, 7),
      message: "",
      author: "unknown",
      date: "",
      verified: false,
    });
    expect(commits[1]?.message).toBe("");
    expect(commits[1]?.author).toBe("unknown");
    expect(commits[1]?.date).toBe("");
  });

  it("drops commits without a valid sha instead of fabricating one", async () => {
    const { client } = source({
      commits: [
        { commit: { message: "no sha" } },
        { sha: "short", commit: { message: "bad sha" } },
        githubCommitPayload(HEAD_SHA, "feat: real commit"),
      ],
    });

    const commits = await client.getCommits(REF);

    expect(commits).toHaveLength(1);
    expect(commits[0]?.sha).toBe(HEAD_SHA);
  });

  it("returns an empty list when GitHub reports no commits", async () => {
    const { client } = source({ commits: [] });
    expect(await client.getCommits(REF)).toEqual([]);
  });
});

describe("partial pagination", () => {
  it("rejects instead of returning a truncated commit list when a later page fails", async () => {
    let calls = 0;
    const client = new LiveGithubSource({
      fetchImpl: (async () => {
        calls += 1;
        if (calls === 1) {
          return new Response(
            JSON.stringify(
              Array.from({ length: 100 }, (_, index) => githubCommitPayload(String(index).padStart(40, "0"), `feat: ${index}`)),
            ),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(JSON.stringify({ message: "boom" }), { status: 500 });
      }) as unknown as typeof fetch,
    });

    await expect(client.getCommits(REF)).rejects.toMatchObject({ code: "github_unavailable" });
    expect(calls).toBe(2);
  });

  it("rejects instead of returning a truncated file list when a later page fails", async () => {
    let calls = 0;
    const client = new LiveGithubSource({
      fetchImpl: (async () => {
        calls += 1;
        if (calls === 1) {
          return new Response(
            JSON.stringify(
              Array.from({ length: 100 }, (_, index) => ({
                filename: `src/file-${index}.ts`,
                status: "modified",
                additions: 1,
                deletions: 0,
                changes: 1,
              })),
            ),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(JSON.stringify({ message: "rate limited" }), {
          status: 429,
          headers: { "retry-after": "30" },
        });
      }) as unknown as typeof fetch,
    });

    await expect(client.getChangedFiles(REF)).rejects.toMatchObject({ code: "rate_limited" });
    expect(calls).toBe(2);
  });
});

describe("repository reads", () => {
  it("treats a redirect to a non-GitHub raw host as unavailable", async () => {
    const { client } = source({
      rawFiles: {
        "CONTRIBUTING.md": new Failure(200, "# Contributing", {}, "https://evil.test/CONTRIBUTING.md"),
      },
    });

    await expect(
      client.readRepositoryFile("acme", "widget-kit", "CONTRIBUTING.md", BASE_SHA),
    ).rejects.toThrow("unexpected host");
  });

  it("returns null for a missing file and an empty string for an empty file", async () => {
    const { client } = source({ rawFiles: { "EMPTY.md": new Raw("") } });

    expect(await client.readRepositoryFile("acme", "widget-kit", "MISSING.md", BASE_SHA)).toBeNull();
    expect(await client.readRepositoryFile("acme", "widget-kit", "EMPTY.md", BASE_SHA)).toBe("");
  });
});