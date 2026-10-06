import { fromBufferPromise, type Entry } from "yauzl";
import { classifyBlueprint, parseBlueprint } from "./blueprints";
import { RepositoryError, type BlueprintKind, type RepositoryIndex } from "./types";

export const ARCHIVE_BYTE_LIMIT = 32 * 1024 * 1024;
const FILE_BYTE_LIMIT = 128000;
const CONTENT_BYTE_LIMIT = 1800000;
const FILE_LIMIT = 120;
const ENTRY_LIMIT = 50000;

export type PublicBlueprintSnapshot = Pick<RepositoryIndex, "repository" | "discoveredFiles" | "files" | "evidence" | "warnings">;
export type PublicRepository = { owner: string; name: string; url: string; ref?: string };
type Candidate = { path: string; entry: Entry; kind: BlueprintKind };
const priorities: Record<BlueprintKind, number> = { documentation: 0, compose: 1, terraform: 2, dependencies: 3, docker: 4, cloudformation: 5, kubernetes: 6, yaml: 7 };
const compareCandidates = (a: Candidate, b: Candidate) => priorities[a.kind] - priorities[b.kind] || a.path.split("/").length - b.path.split("/").length || a.path.localeCompare(b.path);
const invalidArchive = () => new RepositoryError("GitHub returned an invalid repository archive. Retry the public repository URL.", "GITHUB_INVALID_ARCHIVE", true);

/** Read metadata first; only decompress allowed, bounded blueprint entries. Never extract to disk. */
export async function readPublicArchive(
  archive: Buffer,
  repo: PublicRepository,
  signal: AbortSignal,
  onStatus?: (message: string) => void,
  previous?: PublicBlueprintSnapshot,
): Promise<PublicBlueprintSnapshot> {
  if (archive.length > ARCHIVE_BYTE_LIMIT) throw new RepositoryError("The repository snapshot exceeds the 32 MB compressed download limit.", "REPOSITORY_LIMIT");
  const zip = await fromBufferPromise(archive, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true }).catch(() => { throw invalidArchive(); });
  try {
    signal.throwIfAborted();
    // git archive embeds the immutable commit SHA in the ZIP comment.
    const commit = zip.comment;
    if (!/^[a-f0-9]{40}$/.test(commit) || /^[a-f0-9]{40}$/i.test(repo.ref ?? "") && commit !== repo.ref!.toLowerCase()) throw invalidArchive();
    if (previous?.repository.commit === commit) {
      onStatus?.("Reusing blueprints from the same public repository commit");
      return previous;
    }
    if (zip.entryCount > ENTRY_LIMIT) throw new RepositoryError("This snapshot exceeds the 50,000-entry import limit. Use a smaller public repository.", "REPOSITORY_LIMIT");
    const snapshot: PublicBlueprintSnapshot = { repository: { owner: repo.owner, name: repo.name, url: repo.url, commit }, discoveredFiles: 0, files: [], evidence: [], warnings: [] };
    const candidates: Candidate[] = [];
    const seen = new Set<string>();
    let root = "", pathBytes = 0;
    for await (const entry of zip.eachEntry()) {
      signal.throwIfAborted();
      const name = entry.fileName;
      pathBytes += Buffer.byteLength(name);
      if (name.length > 2048 || pathBytes > 4 * 1024 * 1024) throw new RepositoryError("The repository file listing exceeds the import size limit.", "REPOSITORY_LIMIT");
      const parts = name.split("/");
      if (/[\x00-\x1f\x7f\\:]/.test(name) || parts.some(part => part === "." || part === "..") || !parts[0] || parts.length < 2) throw invalidArchive();
      if (!root) root = parts[0];
      if (root !== parts[0]) throw invalidArchive();
      if (name.endsWith("/")) continue;
      const path = parts.slice(1).join("/");
      if (!path || parts.slice(1).some(part => !part) || seen.has(path)) throw invalidArchive();
      seen.add(path);
      // Ignore symbolic links, devices, sockets, and other non-regular Unix entries.
      const kindBits = (entry.externalFileAttributes >>> 16) & 0xf000;
      if (kindBits !== 0 && kindBits !== 0x8000) continue;
      const kind = classifyBlueprint(path);
      if (!kind) continue;
      snapshot.discoveredFiles++;
      candidates.push({ path, entry, kind });
      candidates.sort(compareCandidates);
      if (candidates.length > FILE_LIMIT) candidates.pop();
    }
    if (snapshot.discoveredFiles > FILE_LIMIT) snapshot.warnings.push(`Found ${snapshot.discoveredFiles} candidate files; scanned the first ${FILE_LIMIT} by blueprint priority. This overview is partial.`);
    let totalBytes = 0;
    for (const [i, { path, entry }] of candidates.entries()) {
      signal.throwIfAborted();
      if (!entry.uncompressedSize || entry.uncompressedSize > FILE_BYTE_LIMIT) {
        snapshot.warnings.push(path + ": skipped empty or oversized file (128 KB per-file limit)."); continue;
      }
      if (totalBytes + entry.uncompressedSize > CONTENT_BYTE_LIMIT || snapshot.evidence.length > 1500) {
        snapshot.warnings.push("Reached the evidence size limit. Some blueprints were not indexed."); break;
      }
      if (entry.isEncrypted()) { snapshot.warnings.push(path + ": encrypted entries are unsupported."); continue; }
      onStatus?.(`Reading blueprint ${i + 1}/${candidates.length} · ${path}`);
      const stream = await zip.openReadStreamPromise(entry);
      const abort = () => stream.destroy(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      const buffers: Buffer[] = [];
      let size = 0;
      try {
        signal.throwIfAborted();
        for await (const part of stream) {
          size += part.length;
          if (size > FILE_BYTE_LIMIT || size > entry.uncompressedSize) throw invalidArchive();
          buffers.push(part);
        }
      } finally {
        signal.removeEventListener("abort", abort);
        stream.destroy();
      }
      if (size !== entry.uncompressedSize) throw invalidArchive();
      totalBytes += size;
      let raw: string;
      try { raw = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(buffers)); }
      catch { snapshot.warnings.push(path + ": skipped non-UTF-8 content."); continue; }
      if (raw.includes("\0")) { snapshot.warnings.push(path + ": skipped binary content."); continue; }
      const parsed = parseBlueprint(path, raw);
      snapshot.warnings.push(...parsed.warnings);
      if (!parsed.evidence.length) continue;
      snapshot.files.push({ path, kind: parsed.kind, bytes: size });
      for (const item of parsed.evidence) snapshot.evidence.push({ ...item, id: "e" + (snapshot.evidence.length + 1) });
    }
    snapshot.warnings.push("Imported a public repository snapshot. Submodule contents and files excluded by Git archive export rules are not included.");
    snapshot.warnings = snapshot.warnings.slice(0, 100);
    return snapshot;
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof RepositoryError) throw error;
    throw invalidArchive();
  } finally { zip.close(); }
}
