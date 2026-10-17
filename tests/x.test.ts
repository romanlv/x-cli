import { describe, expect, test } from "bun:test";
import { accountOf, xDomain } from "../x/domain";

describe("x accounts", () => {
  test("a context's URL names its account, or none; X's own pages are not handles", () => {
    expect(accountOf("https://x.com/Jack")).toEqual({ onX: true, handle: "jack" });
    expect(accountOf("https://twitter.com/jack/status/20")).toEqual({ onX: true, handle: "jack" });
    expect(accountOf("https://x.com/home")).toEqual({ onX: true, handle: undefined });
    expect(accountOf("https://x.com/i/flow/login")).toEqual({ onX: true, handle: undefined });
    expect(accountOf("https://example.com/jack").onX).toBe(false);
  });

  test("a sign-in starts runs from the account's profile, or home when the context names none", () => {
    expect(xDomain().appUrl!("https://x.com/home", "https://x.com/Jack")).toBe("https://x.com/jack");
    expect(xDomain().appUrl!("https://x.com/home", "https://x.com")).toBe("https://x.com/home");
  });
});
