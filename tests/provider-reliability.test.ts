import { describe, expect, test } from "bun:test";
import { providerReliabilitySummary } from "../src/lib/server/provider-reliability";

describe("provider reliability", () => {
  test("uses a prior until real manifest outcomes accumulate", () => {
    const unknown = providerReliabilitySummary();
    const healthy = providerReliabilitySummary({ attempts: 20, manifestSuccesses: 19, scopeSuccesses: 16, lastAttemptAt: "" });
    const stale = providerReliabilitySummary({ attempts: 20, manifestSuccesses: 2, scopeSuccesses: 1, lastAttemptAt: "" });
    expect(healthy.score).toBeGreaterThan(unknown.score);
    expect(stale.score).toBeLessThan(unknown.score);
  });
});
