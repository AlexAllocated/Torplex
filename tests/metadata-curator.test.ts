import { describe, expect, test } from "bun:test";
import {
  sanitizeMetadataCuratorPlan,
  type MetadataCuratorPlan,
  type MetadataCuratorRecord,
} from "../src/lib/server/metadata-curator";

const record: MetadataCuratorRecord = {
  recordId: "42",
  type: "movie",
  title: "Wrong Title",
  parentTitle: "",
  grandparentTitle: "",
  seasonNumber: 0,
  episodeNumber: 0,
  year: 2001,
  originallyAvailableAt: "2001-01-01",
  summary: "Existing summary",
  guid: "plex://movie/example",
  externalGuids: [],
  hasArtwork: true,
  lockedFields: ["summary"],
  files: ["/media/plex/Movies/Example (2002)/Example (2002).mkv"],
};

function plan(overrides: Partial<MetadataCuratorPlan["patches"][number]> = {}): MetadataCuratorPlan {
  return {
    summary: "One correction found",
    confidence: "high",
    issues: [],
    patches: [{
      recordId: "42",
      confidence: "high",
      reason: "The official release listing confirms the canonical metadata.",
      evidenceUrls: ["https://example.com/official"],
      applyTitle: true,
      title: "Example",
      applySummary: true,
      summary: "Replacement summary",
      applyOriginallyAvailableAt: true,
      originallyAvailableAt: "2002-02-03",
      applyYear: true,
      year: 2002,
      ...overrides,
    }],
  };
}

describe("metadata curator guardrails", () => {
  test("keeps supported high-confidence edits and honors Plex locks", () => {
    const result = sanitizeMetadataCuratorPlan(plan(), [record]);
    expect(result.patches).toHaveLength(1);
    expect(result.patches[0].applyTitle).toBe(true);
    expect(result.patches[0].applySummary).toBe(false);
    expect(result.patches[0].applyOriginallyAvailableAt).toBe(true);
    expect(result.patches[0].applyYear).toBe(true);
  });

  test("rejects edits without evidence, unknown records, or high confidence", () => {
    expect(sanitizeMetadataCuratorPlan(plan({ evidenceUrls: [] }), [record]).patches).toHaveLength(0);
    expect(sanitizeMetadataCuratorPlan(plan({ recordId: "404" }), [record]).patches).toHaveLength(0);
    expect(sanitizeMetadataCuratorPlan(plan({ confidence: "medium" }), [record]).patches).toHaveLength(0);
  });

  test("rejects invalid dates and years without discarding another safe field", () => {
    const result = sanitizeMetadataCuratorPlan(plan({
      applyTitle: false,
      originallyAvailableAt: "not-a-date",
      year: 9999,
    }), [record]);
    expect(result.patches).toHaveLength(0);
  });
});
