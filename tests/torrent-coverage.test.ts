import { describe, expect, test } from "bun:test";
import { coversSeasons, seasonNumbersFromManifest } from "../src/lib/server/torrent-coverage";

describe("torrent season coverage", () => {
  test("expands complete-series ranges", () => {
    expect(seasonNumbersFromManifest("Daredevil S01-S03 Complete", [])).toEqual([1, 2, 3]);
    expect(seasonNumbersFromManifest("Series Seasons 1-4", [])).toEqual([1, 2, 3, 4]);
  });

  test("collects seasons from the entire manifest", () => {
    expect(seasonNumbersFromManifest("Series Complete", [
      "Season 01/Series.S01E01.mkv",
      "Season 02/Series.S02E01.mkv",
      "Series.S03E01.mkv",
    ])).toEqual([1, 2, 3]);
  });

  test("reports exact requested coverage", () => {
    expect(coversSeasons([1, 2, 3], [1, 2, 3])).toBe(true);
    expect(coversSeasons([1, 3], [1, 2, 3])).toBe(false);
  });
});
