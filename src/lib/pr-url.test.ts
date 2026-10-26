import { describe, expect, it } from "bun:test";
import { AnalysisError } from "./errors";
import { parsePullRequestUrl, tryParsePullRequestUrl } from "./pr-url";

function codeFor(input: string): string {
  try {
    parsePullRequestUrl(input);
    return "no-error";
  } catch (error) {
    expect(error).toBeInstanceOf(AnalysisError);
    return (error as AnalysisError).code;
  }
}

describe("parsePullRequestUrl", () => {
  it("parses a canonical pull request URL", () => {
    const ref = parsePullRequestUrl("https://github.com/vercel/next.js/pull/12345");
    expect(ref).toMatchObject({
      owner: "vercel",
      repo: "next.js",
      number: 12345,
      canonicalUrl: "https://github.com/vercel/next.js/pull/12345",
    });
  });

  it("accepts http, www, no scheme, trailing slash, and tab paths", () => {
    expect(parsePullRequestUrl("http://github.com/a/b/pull/1").number).toBe(1);
    expect(parsePullRequestUrl("https://www.github.com/a/b/pull/2").number).toBe(2);
    expect(parsePullRequestUrl("github.com/a/b/pull/3").canonicalUrl).toBe(
      "https://github.com/a/b/pull/3",
    );
    expect(parsePullRequestUrl("https://github.com/a/b/pull/4/").number).toBe(4);
    expect(parsePullRequestUrl("https://github.com/a/b/pull/5/files").number).toBe(5);
    expect(parsePullRequestUrl("https://github.com/a/b/pull/6/commits").number).toBe(6);
    expect(parsePullRequestUrl("https://github.com/a/b/pull/7/checks").number).toBe(7);
  });

  it("ignores query strings, fragments, and casing of the host", () => {
    const ref = parsePullRequestUrl(
      "  HTTPS://GitHub.com/Acme/Widget/pull/9?diff=split#discussion_r1  ",
    );
    expect(ref.owner).toBe("Acme");
    expect(ref.repo).toBe("Widget");
    expect(ref.number).toBe(9);
    expect(ref.canonicalUrl).toBe("https://github.com/Acme/Widget/pull/9");
  });

  it("accepts repositories with dots, dashes, and underscores", () => {
    const ref = parsePullRequestUrl("https://github.com/some-org/my_repo.js/pull/10");
    expect(ref.owner).toBe("some-org");
    expect(ref.repo).toBe("my_repo.js");
  });

  it("rejects empty and whitespace-only input", () => {
    expect(codeFor("")).toBe("invalid_url");
    expect(codeFor("   ")).toBe("invalid_url");
  });

  it("rejects non-GitHub hosts", () => {
    expect(codeFor("https://gitlab.com/a/b/pull/1")).toBe("unsupported_host");
    expect(codeFor("https://bitbucket.org/a/b/pull/1")).toBe("unsupported_host");
    expect(codeFor("https://gist.github.com/a/b/pull/1")).toBe("unsupported_host");
  });

  it("rejects hostname spoofing", () => {
    expect(codeFor("https://github.com.evil.example/a/b/pull/1")).toBe("unsupported_host");
    expect(codeFor("https://evilgithub.com/a/b/pull/1")).toBe("unsupported_host");
    expect(codeFor("https://github.com@evil.example/a/b/pull/1")).toBe("unsupported_host");
  });

  it("rejects credentials embedded in the URL", () => {
    expect(codeFor("https://user:pass@github.com/a/b/pull/1")).toBe("invalid_url");
  });

  it("rejects non-http protocols", () => {
    expect(codeFor("ftp://github.com/a/b/pull/1")).toBe("invalid_url");
    expect(codeFor("javascript:alert(1)//github.com/a/b/pull/1")).toBe("invalid_url");
  });

  it("rejects non-443 ports", () => {
    expect(codeFor("https://github.com:8443/a/b/pull/1")).toBe("unsupported_host");
    expect(parsePullRequestUrl("https://github.com:443/a/b/pull/1").number).toBe(1);
  });

  it("rejects issue and repository URLs", () => {
    expect(codeFor("https://github.com/a/b/issues/1")).toBe("invalid_url");
    expect(codeFor("https://github.com/a/b/pull")).toBe("invalid_url");
    expect(codeFor("https://github.com/a/b")).toBe("invalid_url");
  });

  it("rejects unknown trailing sections", () => {
    expect(codeFor("https://github.com/a/b/pull/1/patches")).toBe("invalid_url");
  });

  it("rejects invalid owners and repositories", () => {
    expect(codeFor("https://github.com/-bad/ok/pull/1")).toBe("invalid_url");
    expect(codeFor("https://github.com/ok/../pull/1")).toBe("invalid_url");
    expect(codeFor("https://github.com/ok/re po/pull/1")).toBe("invalid_url");
  });

  it("rejects invalid pull request numbers", () => {
    expect(codeFor("https://github.com/a/b/pull/0")).toBe("invalid_url");
    expect(codeFor("https://github.com/a/b/pull/-2")).toBe("invalid_url");
    expect(codeFor("https://github.com/a/b/pull/abc")).toBe("invalid_url");
    expect(codeFor("https://github.com/a/b/pull/1.5")).toBe("invalid_url");
    expect(codeFor("https://github.com/a/b/pull/10000000")).toBe("invalid_url");
    expect(parsePullRequestUrl("https://github.com/a/b/pull/9999999").number).toBe(9_999_999);
  });

  it("rejects excessively long input", () => {
    expect(codeFor(`https://github.com/a/b/pull/1?x=${"a".repeat(600)}`)).toBe("invalid_url");
  });

  it("tryParse returns null instead of throwing", () => {
    expect(tryParsePullRequestUrl("nope")).toBeNull();
    expect(tryParsePullRequestUrl("https://github.com/a/b/pull/1")?.number).toBe(1);
  });
});