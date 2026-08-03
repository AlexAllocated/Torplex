import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { qualityPresets } from "../src/lib/search-quality";

const batchDir = await mkdtemp(join(tmpdir(), "torplex-search-sessions-"));
process.env.BATCH_DIR = batchDir;
const sessions = await import("../src/lib/server/search-sessions");

afterAll(async () => {
  await rm(batchDir, { recursive: true, force: true });
});

describe("persistent search sessions", () => {
  test("publishes progress and persists terminal proposal state", async () => {
    const id = "search-persistence-1234";
    await sessions.createSearchSession({ id, prompt: "Find a complete fixture show", qualityProfile: qualityPresets.balanced });
    const snapshots: string[] = [];
    const unsubscribe = sessions.subscribeSearchSession(id, (session) => snapshots.push(session.status));
    await sessions.appendSearchProgress(id, "Checking Plex seasons");
    const proposal = {
      summary: "Fixture ready", works: [], alreadyOwned: [], selections: [], missing: [], providers: [], model: "fixture",
      qualityProfile: qualityPresets.balanced,
    };
    await sessions.completeSearchSession(id, proposal);
    unsubscribe();
    expect((await sessions.getLatestSearchSession())?.proposal?.summary).toBe("Fixture ready");
    expect(snapshots).toEqual(["running", "completed"]);
    const persisted = JSON.parse(await readFile(join(batchDir, "search-sessions.json"), "utf8"));
    expect(persisted.sessions[0].progress).toEqual(["Checking Plex seasons"]);
    expect(persisted.sessions[0].status).toBe("completed");
  });
});
