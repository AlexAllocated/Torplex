import { readFileSync } from "fs";
import { rename, writeFile } from "fs/promises";

export type ProgressSnapshot = {
  downloadedBytes: number;
  totalBytes: number;
  updatedAt: string;
};

type ProgressValue = {
  downloadedBytes: number;
  totalBytes: number;
  percent: number;
  rate: string;
  eta: string;
  phase: string;
};

export function mergeProgressHighWater<T extends ProgressValue>(
  current: T,
  snapshot: ProgressSnapshot | undefined,
  declaredTotalBytes: number,
): T {
  const totalBytes = declaredTotalBytes || current.totalBytes || snapshot?.totalBytes || 0;
  const compatibleSnapshot = snapshot && (!totalBytes || !snapshot.totalBytes || snapshot.totalBytes === totalBytes)
    ? snapshot
    : undefined;
  const downloadedBytes = Math.max(0, current.downloadedBytes, compatibleSnapshot?.downloadedBytes || 0);
  if (downloadedBytes === current.downloadedBytes && totalBytes === current.totalBytes) return current;

  return {
    ...current,
    downloadedBytes,
    totalBytes,
    percent: totalBytes ? Math.min(100, Math.floor((downloadedBytes / totalBytes) * 1000) / 10) : current.percent,
    rate: current.downloadedBytes > 0 ? current.rate : "",
    eta: current.downloadedBytes > 0 ? current.eta : "",
    phase: current.downloadedBytes > 0 ? current.phase : downloadedBytes > 0 ? "waiting" : current.phase,
  };
}

export class ProgressSnapshotStore {
  private readonly path: string;
  private readonly temporaryPath: string;
  private snapshots: Record<string, ProgressSnapshot>;
  private writeTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(path: string) {
    this.path = path;
    this.temporaryPath = `${path}.tmp`;
    try {
      this.snapshots = JSON.parse(readFileSync(path, "utf8")) as Record<string, ProgressSnapshot>;
    } catch {
      this.snapshots = {};
    }
  }

  reconcile<T extends ProgressValue>(id: string, declaredTotalBytes: number, current: T, retain: boolean): T {
    if (!retain) {
      this.delete(id);
      return current;
    }

    const existing = this.snapshots[id];
    const merged = mergeProgressHighWater(current, existing, declaredTotalBytes);
    if (merged.downloadedBytes > (existing?.downloadedBytes || 0)) {
      this.snapshots[id] = {
        downloadedBytes: merged.downloadedBytes,
        totalBytes: merged.totalBytes,
        updatedAt: new Date().toISOString(),
      };
      this.scheduleWrite();
    }
    return merged;
  }

  delete(id: string) {
    if (!(id in this.snapshots)) return;
    delete this.snapshots[id];
    this.scheduleWrite();
  }

  private scheduleWrite() {
    if (this.writeTimer) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = undefined;
      void this.flush().catch(() => {});
    }, 1_000);
    this.writeTimer.unref?.();
  }

  private async flush() {
    await writeFile(this.temporaryPath, `${JSON.stringify(this.snapshots, null, 2)}\n`);
    await rename(this.temporaryPath, this.path);
  }
}
