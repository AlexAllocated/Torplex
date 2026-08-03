import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type ProviderReliability = {
  attempts: number;
  manifestSuccesses: number;
  scopeSuccesses: number;
  lastAttemptAt: string;
};

type ReliabilityStore = { version: 1; providers: Record<string, ProviderReliability> };

let writeChain = Promise.resolve();

function storePath() {
  return join(process.env.BATCH_DIR || "/media/plex/.downloads/torrent-batch", "provider-reliability.json");
}

async function readStore(): Promise<ReliabilityStore> {
  try {
    const parsed = JSON.parse(await readFile(storePath(), "utf8")) as ReliabilityStore;
    return { version: 1, providers: parsed.providers && typeof parsed.providers === "object" ? parsed.providers : {} };
  } catch {
    return { version: 1, providers: {} };
  }
}

export function providerReliabilitySummary(value?: ProviderReliability) {
  const attempts = Math.max(0, Number(value?.attempts) || 0);
  const manifestSuccesses = Math.min(attempts, Math.max(0, Number(value?.manifestSuccesses) || 0));
  const scopeSuccesses = Math.min(manifestSuccesses, Math.max(0, Number(value?.scopeSuccesses) || 0));
  const priorSamples = 8;
  const manifestRate = (manifestSuccesses + priorSamples * .65) / (attempts + priorSamples);
  const scopeRate = (scopeSuccesses + priorSamples * .5) / (attempts + priorSamples);
  return {
    attempts,
    manifestSuccessRate: manifestRate,
    scopeSuccessRate: scopeRate,
    score: manifestRate * .78 + scopeRate * .22,
  };
}

export async function loadProviderReliability() {
  return (await readStore()).providers;
}

export async function recordProviderOutcomes(
  outcomes: Array<{ provider: string; manifestSuccess: boolean; scopeSuccess: boolean }>,
) {
  if (!outcomes.length) return;
  writeChain = writeChain.then(async () => {
    const store = await readStore();
    const now = new Date().toISOString();
    for (const outcome of outcomes) {
      const current = store.providers[outcome.provider] || {
        attempts: 0,
        manifestSuccesses: 0,
        scopeSuccesses: 0,
        lastAttemptAt: now,
      };
      current.attempts += 1;
      if (outcome.manifestSuccess) current.manifestSuccesses += 1;
      if (outcome.scopeSuccess) current.scopeSuccesses += 1;
      current.lastAttemptAt = now;
      store.providers[outcome.provider] = current;
    }
    const path = storePath();
    const temporary = `${path}.tmp`;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, "utf8");
    await rename(temporary, path);
  }).catch(() => {});
  await writeChain;
}
