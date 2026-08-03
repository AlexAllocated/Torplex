import { describe, expect, test } from "bun:test";
import { assessSearchQuality, normalizeQualityProfile, qualityPresets } from "../src/lib/search-quality";

describe("search quality profiles", () => {
  test("normalizes preset and custom profiles", () => {
    expect(normalizeQualityProfile({ preset: "compatibility" })).toEqual(qualityPresets.compatibility);
    expect(normalizeQualityProfile({ preset: "balanced", maximumResolution: 1080 }).preset).toBe("custom");
  });

  test("enforces explicit constraints and scores preferences", () => {
    const profile = qualityPresets.compatibility;
    expect(assessSearchQuality(profile, "Film.2160p.HDR.x265", 4 * 1024 ** 3).allowed).toBe(false);
    expect(assessSearchQuality(profile, "Film.1080p.x265", 4 * 1024 ** 3).violations)
      .toContain("H265 does not match the H264 codec requirement");
    expect(assessSearchQuality(profile, "Film.1080p.x264", 4 * 1024 ** 3).score)
      .toBeGreaterThan(assessSearchQuality(profile, "Film.720p.x265", 4 * 1024 ** 3).score);
  });
});
