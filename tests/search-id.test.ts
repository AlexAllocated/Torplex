import { describe, expect, test } from "bun:test";
import { createSearchId } from "../src/lib/client/search-id.js";

describe("search session IDs", () => {
  test("uses randomUUID when it is available", () => {
    expect(createSearchId({ randomUUID: () => "fixture-uuid" }, 1)).toBe("search-fixture-uuid");
  });

  test("works when randomUUID is unavailable on an HTTP origin", () => {
    const cryptoApi = {
      getRandomValues(values: Uint32Array) {
        values.set([1, 2, 3, 4]);
        return values;
      },
    };
    const id = createSearchId(cryptoApi, 123456789);
    expect(id).toMatch(/^search-[a-z0-9]+-[a-z0-9]{28}$/);
    expect(id.length).toBeGreaterThanOrEqual(12);
    expect(id.length).toBeLessThanOrEqual(100);
  });
});
