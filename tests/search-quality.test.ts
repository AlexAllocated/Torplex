import { describe, expect, test } from "bun:test";
import { assessPlexMediaQuality, assessSearchQuality, normalizeQualityProfile, qualityPresets, searchQualityIsUsable } from "../src/lib/search-quality";

describe("search quality profiles", () => {
  test("normalizes preset and custom profiles", () => {
    expect(normalizeQualityProfile(undefined)).toEqual(qualityPresets.compatibility);
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
    expect(assessSearchQuality(profile, "Film.1080p.WEB-DL", 4 * 1024 ** 3).allowed).toBe(false);
    expect(assessSearchQuality(profile, "Film.1080p.x264.10bit", 4 * 1024 ** 3).allowed).toBe(false);
  });

  test("keeps unknown codec candidates reviewable while rejecting confirmed conflicts", () => {
    const profile = qualityPresets.compatibility;
    expect(searchQualityIsUsable(assessSearchQuality(profile, "Babylon 5 Complete Series", 40 * 1024 ** 3))).toBe(true);
    expect(searchQualityIsUsable(assessSearchQuality(profile, "Babylon 5 Complete Series x265", 40 * 1024 ** 3))).toBe(false);
  });

  test("uses Plex stream metadata to identify direct-play replacements", () => {
    const profile = qualityPresets.compatibility;
    expect(assessPlexMediaQuality(profile, { videoCodec: "h264", videoResolution: "1080", file: "Film.mkv" }).allowed).toBe(true);
    expect(assessPlexMediaQuality(profile, { videoCodec: "hevc", videoResolution: "1080", file: "Film.mp4" }).allowed).toBe(false);
    expect(assessPlexMediaQuality(profile, { videoCodec: "h264", videoResolution: "2160", file: "Film.mp4" }).allowed).toBe(false);
  });
});
