import { describe, expect, it } from "bun:test";
import { REDACTED, redactSecrets, sanitizeMessage } from "./redact";

describe("redactSecrets", () => {
  it("removes a known key wherever it appears", () => {
    const secret = "sk-live-abcdef123456";
    expect(redactSecrets(`failed with ${secret} in the body`, [secret])).toBe(
      `failed with ${REDACTED} in the body`,
    );
  });

  it("ignores very short known values so ordinary words are not mangled", () => {
    expect(redactSecrets("the cat sat", ["cat"])).toBe("the cat sat");
  });

  it("removes bearer tokens and authorization headers", () => {
    expect(redactSecrets("Authorization: Bearer abc.def.ghi")).toBe(`Authorization: Bearer ${REDACTED}`);
    expect(redactSecrets("authorization=Bearer abc123")).toBe(`authorization=Bearer ${REDACTED}`);
  });

  it("removes api key, token, secret and password assignments", () => {
    expect(redactSecrets("api_key=abc123")).toBe(`api_key=${REDACTED}`);
    expect(redactSecrets("token: abc123")).toBe(`token: ${REDACTED}`);
    expect(redactSecrets("password=hunter2")).toBe(`password=${REDACTED}`);
  });

  it("removes credentials embedded in URLs", () => {
    expect(redactSecrets("https://user:pass@api.example/v1")).toBe(`https://${REDACTED}api.example/v1`);
  });

  it("removes common provider key shapes", () => {
    expect(redactSecrets("key sk-proj-abcdefghijklmnop")).toBe(`key ${REDACTED}`);
    expect(redactSecrets("token ghp_abcdefghijklmnopqrst")).toBe(`token ${REDACTED}`);
  });

  it("removes query-string credentials", () => {
    expect(redactSecrets("https://api.example/v1?key=abc123&x=1")).toBe(
      `https://api.example/v1?key=${REDACTED}&x=1`,
    );
  });

  it("leaves ordinary prose untouched", () => {
    const text = "The inference endpoint returned HTTP 502 while reading the pull request.";
    expect(redactSecrets(text)).toBe(text);
  });
});

describe("sanitizeMessage", () => {
  it("strips control characters, collapses whitespace, and caps length", () => {
    const message = sanitizeMessage("bad\u0000\n\n  text  here", 100);
    expect(message).toBe("bad text here");

    const long = sanitizeMessage("x".repeat(400), 50);
    expect(long.length).toBe(51);
    expect(long.endsWith("…")).toBe(true);
  });

  it("redacts before truncating so a secret is never half-visible", () => {
    const secret = "sk-abcdefghijklmnop";
    const message = sanitizeMessage(`prefix ${secret} suffix`, 300, [secret]);
    expect(message).not.toContain(secret.slice(0, 10));
  });
});
