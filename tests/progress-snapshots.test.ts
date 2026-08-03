import { describe, expect, test } from "bun:test";
import { mergeProgressHighWater } from "../src/lib/server/progress-snapshots";

const progress = (downloadedBytes: number, totalBytes = 1_000) => ({
  downloadedBytes,
  totalBytes,
  percent: totalBytes ? downloadedBytes / totalBytes * 100 : 0,
  rate: downloadedBytes ? "2MiB" : "",
  eta: downloadedBytes ? "1m" : "",
  phase: downloadedBytes ? "downloading" : "pending",
});

describe("progress high-water marks", () => {
  test("preserves downloaded bytes when a waiting log has no progress line", () => {
    const merged = mergeProgressHighWater(progress(0), {
      downloadedBytes: 425,
      totalBytes: 1_000,
      updatedAt: "2026-08-02T00:00:00.000Z",
    }, 1_000);

    expect(merged.downloadedBytes).toBe(425);
    expect(merged.percent).toBe(42.5);
    expect(merged.phase).toBe("waiting");
    expect(merged.rate).toBe("");
    expect(merged.eta).toBe("");
  });

  test("ignores stale progress for a different torrent size", () => {
    const current = progress(0, 2_000);
    expect(mergeProgressHighWater(current, {
      downloadedBytes: 900,
      totalBytes: 1_000,
      updatedAt: "2026-08-02T00:00:00.000Z",
    }, 2_000)).toEqual(current);
  });

  test("never regresses when a current log reports an older checkpoint", () => {
    const merged = mergeProgressHighWater(progress(400), {
      downloadedBytes: 650,
      totalBytes: 1_000,
      updatedAt: "2026-08-02T00:00:00.000Z",
    }, 1_000);
    expect(merged.downloadedBytes).toBe(650);
    expect(merged.percent).toBe(65);
    expect(merged.phase).toBe("downloading");
  });
});
