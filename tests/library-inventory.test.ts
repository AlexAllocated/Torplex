import { describe, expect, test } from "bun:test";
import {
  findLibraryMatch,
  normalizeLibraryTitle,
  type LibraryInventoryItem,
} from "../src/lib/server/library-inventory";

const inventory: LibraryInventoryItem[] = [
  { id: "event-horizon", title: "Event Horizon", year: 1997, type: "movie", source: "plex", status: "in library" },
  { id: "the-thing-1982", title: "The Thing", year: 1982, type: "movie", source: "plex", status: "in library" },
  { id: "the-thing-2011", title: "The Thing", year: 2011, type: "movie", source: "queue", status: "active" },
];

describe("library-aware search matching", () => {
  test("normalizes punctuation and ampersands", () => {
    expect(normalizeLibraryTitle("Dungeons & Dragons: Honor Among Thieves"))
      .toBe(normalizeLibraryTitle("Dungeons and Dragons - Honor Among Thieves"));
  });

  test("matches canonical title, year, and media type", () => {
    expect(findLibraryMatch({ title: "Event Horizon", year: 1997, type: "movie" }, inventory)?.id)
      .toBe("event-horizon");
    expect(findLibraryMatch({ title: "Event Horizon", year: 1997, type: "show" }, inventory)).toBeUndefined();
  });

  test("does not collapse remakes when a year is supplied", () => {
    expect(findLibraryMatch({ title: "The Thing", year: 2011, type: "movie" }, inventory)?.id)
      .toBe("the-thing-2011");
    expect(findLibraryMatch({ title: "The Thing", year: 1951, type: "movie" }, inventory)).toBeUndefined();
  });
});
