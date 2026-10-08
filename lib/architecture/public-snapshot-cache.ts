import type { PublicBlueprintSnapshot } from "./github-archive";

type CachedSnapshot = { etag: string; snapshot: PublicBlueprintSnapshot; expires: number; bytes: number };

/** Redacted public evidence only. Every reuse still requires a successful GitHub access check. */
export class PublicSnapshotCache {
  private entries = new Map<string, CachedSnapshot>();
  private readonly ttl = 15 * 60 * 1000;

  get(key: string): CachedSnapshot | undefined {
    const value = this.entries.get(key);
    if (value && value.expires > Date.now()) return value;
    this.entries.delete(key);
  }

  delete(key: string) { this.entries.delete(key); }

  set(key: string, etag: string, snapshot: PublicBlueprintSnapshot) {
    this.entries.delete(key);
    const bytes = Buffer.byteLength(JSON.stringify(snapshot));
    if (!etag || etag.length > 200 || bytes > 8 * 1024 * 1024) return;
    this.entries.set(key, { etag, snapshot: structuredClone(snapshot), expires: Date.now() + this.ttl, bytes });
    let total = [...this.entries.values()].reduce((sum, value) => sum + value.bytes, 0);
    for (const [oldKey, value] of this.entries) {
      if (this.entries.size <= 8 && total <= 16 * 1024 * 1024) break;
      this.entries.delete(oldKey); total -= value.bytes;
    }
  }
}
