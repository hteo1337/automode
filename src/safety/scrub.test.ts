import { describe, it, expect } from "vitest";
import { scrub, scrubDeep, truncate, scrubRuleNames } from "./scrub.js";

describe("scrub", () => {
  it("redacts anthropic keys", () => {
    const out = scrub("use sk-ant-api03-AAAAAAAAAAAAAAAAAAAA here");
    expect(out).not.toContain("sk-ant-api03-");
    expect(out).toContain("sk-ant-REDACTED");
  });

  it("redacts OpenAI-style keys", () => {
    expect(scrub("sk-AAAAAAAAAAAAAAAAAAAAABCD")).toBe("sk-REDACTED");
  });

  it("redacts GitHub tokens", () => {
    for (const prefix of ["ghp_", "gho_", "ghu_", "ghs_", "ghr_"]) {
      expect(scrub(`${prefix}${"A".repeat(40)}`)).toContain(`${prefix}REDACTED`);
    }
  });

  it("redacts npm tokens", () => {
    expect(scrub("the token is npm_" + "B".repeat(36))).toContain("npm_REDACTED");
  });

  it("redacts AWS access key", () => {
    expect(scrub("AKIAIOSFODNN7EXAMPLE")).toBe("AKIA_REDACTED");
  });

  it("redacts JWT", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9" +
      ".eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ" +
      ".SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    expect(scrub(jwt)).toBe("<JWT>");
  });

  it("redacts Bearer tokens", () => {
    expect(scrub("Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456")).toContain(
      "Bearer <REDACTED>",
    );
  });

  it("redacts kv-style secrets", () => {
    expect(scrub('token: "abcdefghijklmnop1234"')).toContain("token=<REDACTED>");
    expect(scrub("api_key=AAAAAAAAAAAAAAAAAAAA")).toContain("api_key=<REDACTED>");
    expect(scrub('password="S3cretPasswordWithAlphaNum123"')).toContain("password=<REDACTED>");
  });

  it("leaves normal text alone", () => {
    const input = "hello world, this is a short message without any keys.";
    expect(scrub(input)).toBe(input);
  });

  it("handles empty / non-string", () => {
    expect(scrub("")).toBe("");
    expect(scrub(undefined as unknown as string)).toBe(undefined);
  });
});

describe("scrubDeep", () => {
  it("walks nested structures", () => {
    const out = scrubDeep({
      a: "sk-ant-api-" + "A".repeat(30),
      b: ["plain", "ghp_" + "B".repeat(40)],
      c: { d: "Bearer " + "x".repeat(30) },
    });
    expect(JSON.stringify(out)).not.toMatch(/sk-ant-api-A/);
    expect(JSON.stringify(out)).not.toMatch(/ghp_B/);
    expect(JSON.stringify(out)).toContain("REDACTED");
  });

  it("returns non-string, non-object values untouched", () => {
    expect(scrubDeep(42)).toBe(42);
    expect(scrubDeep(null)).toBe(null);
    expect(scrubDeep(true)).toBe(true);
  });
});

describe("truncate", () => {
  it("leaves short strings alone", () => {
    expect(truncate("hello", 10)).toBe("hello");
  });
  it("caps long strings and annotates", () => {
    const out = truncate("A".repeat(50), 10);
    expect(out).toMatch(/^A{10}…\+40$/);
  });
});

describe("scrubRuleNames", () => {
  it("exports a non-empty list", () => {
    expect(scrubRuleNames.length).toBeGreaterThan(5);
  });
});
