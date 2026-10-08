import { fromBufferPromise, type Entry } from "yauzl";
import { classifyBlueprint, parseBlueprint } from "./blueprints";
import { analyzeSource, classifySource, isSafeRepositoryPath } from "./source-analysis";
import { examplePenalty } from "./evidence-search";
import { RepositoryError, type BlueprintKind, type RepositoryIndex } from "./types";

export const ARCHIVE_BYTE_LIMIT = 32 * 1024 * 1024;
const FILE_BYTE_LIMIT = 512000;
const CONTENT_BYTE_LIMIT = 1800000;
const FILE_LIMIT = 120;
const SOURCE_FILE_LIMIT = 3000;
const SOURCE_EXCERPT_FILE_LIMIT = 160;
const SOURCE_CONTENT_BYTE_LIMIT = 32 * 1024 * 1024;
const SOURCE_EVIDENCE_BYTE_LIMIT = 3 * 1024 * 1024;
const SOURCE_EVIDENCE_LIMIT = 2400;
const ENTRY_LIMIT = 50000;

export type PublicBlueprintSnapshot = Pick<RepositoryIndex, "repository" | "discoveredFiles" | "files" | "evidence" | "warnings" | "tree" | "sourceFiles" | "analysisVersion">;
export type PublicRepository = { owner: string; name: string; url: string; ref?: string };
type Candidate = { path: string; entry: Entry; kind: Exclude<BlueprintKind, "source"> };
type SourceCandidate = { path: string; entry: Entry };
const priorities: Record<Exclude<BlueprintKind, "source">, number> = { documentation: 0, compose: 1, terraform: 2, dependencies: 3, docker: 4, cloudformation: 5, kubernetes: 6, yaml: 7 };
const compareCandidates = (a: Candidate, b: Candidate) => priorities[a.kind] - priorities[b.kind] || a.path.split("/").length - b.path.split("/").length || a.path.localeCompare(b.path);
const invalidArchive = () => new RepositoryError("GitHub returned an invalid repository archive. Retry the public repository URL.", "GITHUB_INVALID_ARCHIVE", true);

function excludedArchivePath(path: string) {
  return !isSafeRepositoryPath(path)
    || /(^|\/)(\.svelte-kit|out|\.turbo|\.parcel-cache|\.yarn|\.pnpm-store)(\/|$)/i.test(path)
    || /(^|\/)(\.env[^/]*|\.(?:npmrc|pypirc|netrc)|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|[^/]*\.tfstate(?:\..*)?|(?:secrets?|credentials?|private[_-]?keys?)(?:[._-][^/]*)?)$/i.test(path)
    || /(?:\.(?:pem|key|p12|pfx|jks|keystore|pyc|pyo|class|o|obj|dll|exe|so|dylib|wasm|map)|\.(?:min|bundle)\.[cm]?js|[._-](?:generated|gen|pb)\.[^/]+|\.(?:g|designer)\.cs|\.d\.(?:ts|mts|cts)|_pb2(?:_grpc)?\.py)$/i.test(path);
}

function sourcePriority(path: string) {
  if (examplePenalty(path, "")) return 4;
  if (/(^|\/)(?:main|__main__|app|server|index|cli|manage|program)\.[^/]+$/i.test(path)) return 0;
  if (/(^|\/)(?:routes?|controllers?|handlers?)(?:\/|\.[^/]+$)|(?:^|[.\/_-])(?:route|controller|handler)\.[^/]+$/i.test(path)) return 1;
  if (/(^|\/)(?:src|lib|app|packages)\//i.test(path)) return 2;
  return 3;
}

const compareSources = (a: SourceCandidate, b: SourceCandidate) => sourcePriority(a.path) - sourcePriority(b.path) || a.path.split("/").length - b.path.split("/").length || a.path.localeCompare(b.path);

/** List safe regular files first; decompress only bounded blueprint/source candidates. Never extract or execute. */
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
    if (previous?.analysisVersion === 2 && previous.repository.commit === commit && Array.isArray(previous.tree) && Array.isArray(previous.sourceFiles)) {
      onStatus?.("Reusing code and blueprints from the same public repository commit");
      return previous;
    }
    if (zip.entryCount > ENTRY_LIMIT) throw new RepositoryError("This snapshot exceeds the 50,000-entry import limit. Use a smaller public repository.", "REPOSITORY_LIMIT");
    const snapshot: PublicBlueprintSnapshot = { repository: { owner: repo.owner, name: repo.name, url: repo.url, commit }, discoveredFiles: 0, files: [], evidence: [], warnings: [], tree: [], sourceFiles: [], analysisVersion: 2 };
    const candidates: Candidate[] = [];
    const sources: SourceCandidate[] = [];
    const seen = new Set<string>();
    let root = "", pathBytes = 0, blueprintCount = 0, sourceCount = 0;
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
      if (excludedArchivePath(path)) continue;
      const kind = classifyBlueprint(path);
      const language = kind ? null : classifySource(path);
      snapshot.tree!.push({ path, bytes: entry.uncompressedSize, kind: kind ? "blueprint" : language ? "source" : "other", ...(language ? { language } : {}) });
      if (kind && kind !== "source") {
        snapshot.discoveredFiles++; blueprintCount++;
        candidates.push({ path, entry, kind });
        candidates.sort(compareCandidates);
        if (candidates.length > FILE_LIMIT) candidates.pop();
      } else if (language) {
        snapshot.discoveredFiles++; sourceCount++;
        sources.push({ path, entry });
      }
    }
    snapshot.tree!.sort((a, b) => a.path.localeCompare(b.path));
    sources.sort(compareSources);
    sources.splice(SOURCE_FILE_LIMIT);
    if (blueprintCount > FILE_LIMIT) snapshot.warnings.push(`Found ${blueprintCount} candidate blueprints; scanned the first ${FILE_LIMIT} by blueprint priority. This overview is partial.`);
    if (sourceCount > SOURCE_FILE_LIMIT) snapshot.warnings.push(`Found ${sourceCount} candidate source files; scanned up to ${SOURCE_FILE_LIMIT}, prioritizing entrypoints and application code. Source coverage is partial.`);
    const readText = async ({ path, entry }: SourceCandidate) => {
      signal.throwIfAborted();
      if (!entry.uncompressedSize || entry.uncompressedSize > FILE_BYTE_LIMIT) {
        snapshot.warnings.push(path + ": skipped empty or oversized file (512 KB per-file limit)."); return null;
      }
      if (entry.isEncrypted()) { snapshot.warnings.push(path + ": encrypted entries are unsupported."); return null; }
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
      let raw: string;
      try { raw = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(buffers)); }
      catch { snapshot.warnings.push(path + ": skipped non-UTF-8 content."); return null; }
      if (raw.includes("\0")) { snapshot.warnings.push(path + ": skipped binary content."); return null; }
      return { raw, size };
    };
    let totalBytes = 0;
    for (const [i, candidate] of candidates.entries()) {
      const { path, entry } = candidate;
      signal.throwIfAborted();
      if ((entry.uncompressedSize <= FILE_BYTE_LIMIT && totalBytes + entry.uncompressedSize > CONTENT_BYTE_LIMIT) || snapshot.evidence.length >= 1500) {
        snapshot.warnings.push("Reached the blueprint evidence size limit. Some blueprints were not indexed."); break;
      }
      onStatus?.(`Reading blueprint ${i + 1}/${candidates.length} · ${path}`);
      // Account for attempted decompression even when binary/invalid UTF-8 is skipped.
      if (entry.uncompressedSize <= FILE_BYTE_LIMIT) totalBytes += entry.uncompressedSize;
      const content = await readText(candidate);
      if (!content) continue;
      const { raw, size } = content;
      const parsed = parseBlueprint(path, raw);
      snapshot.warnings.push(...parsed.warnings);
      if (!parsed.evidence.length) continue;
      snapshot.files.push({ path, kind: parsed.kind, bytes: size });
      for (const item of parsed.evidence) snapshot.evidence.push({ ...item, id: "e" + (snapshot.evidence.length + 1) });
    }
    let sourceBytes = 0, sourceEvidence = 0, sourceEvidenceBytes = 0, sourceEvidenceFull = false;
    for (const [i, candidate] of sources.entries()) {
      const { path, entry } = candidate;
      signal.throwIfAborted();
      if (entry.uncompressedSize <= FILE_BYTE_LIMIT && sourceBytes + entry.uncompressedSize > SOURCE_CONTENT_BYTE_LIMIT) {
        snapshot.warnings.push("Reached the 32 MiB source analysis budget. Remaining file paths are mapped and available for targeted lookup; their symbols are not yet analyzed."); break;
      }
      onStatus?.(`Reading code ${i + 1}/${sources.length} · ${path}`);
      if (entry.uncompressedSize <= FILE_BYTE_LIMIT) sourceBytes += entry.uncompressedSize;
      const content = await readText(candidate);
      if (!content) continue;
      try {
        const parsed = analyzeSource(path, content.raw);
        if (!parsed.evidence.length) { snapshot.warnings.push(path + ": no usable source excerpts; generated or unsupported content was excluded."); continue; }
        snapshot.sourceFiles!.push({ path, language: parsed.language, parser: parsed.parser, imports: parsed.imports, symbols: parsed.symbols, definitions: parsed.definitions, analysisComplete: parsed.analysisComplete });
        snapshot.files.push({ path, kind: "source", bytes: content.size });
        // Build the symbol map independently of the much smaller overview context.
        // Later files remain discoverable by class/function and can be read on demand.
        if (i >= SOURCE_EXCERPT_FILE_LIMIT || sourceEvidenceFull || sourceEvidence >= SOURCE_EVIDENCE_LIMIT) continue;
        for (const item of parsed.evidence) {
          const bytes = Buffer.byteLength(item.text);
          if (sourceEvidence >= SOURCE_EVIDENCE_LIMIT || sourceEvidenceBytes + bytes > SOURCE_EVIDENCE_BYTE_LIMIT) {
            sourceEvidenceFull = true;
            snapshot.warnings.push(path + ": some code excerpts were omitted at the source evidence limit.");
            break;
          }
          snapshot.evidence.push({ ...item, id: "e" + (snapshot.evidence.length + 1) });
          sourceEvidence++; sourceEvidenceBytes += bytes;
        }
      } catch {
        snapshot.warnings.push(path + ": source analysis was unavailable; its contents were excluded.");
      }
    }
    if (snapshot.sourceFiles!.length > SOURCE_EXCERPT_FILE_LIMIT || sourceEvidenceFull) snapshot.warnings.push("The symbol map covers more files than the initial code excerpts. Questions retrieve matching files and line ranges from this exact commit.");
    snapshot.warnings.push("Imported a public repository snapshot with a filtered file tree and bounded code excerpts. Secrets, vendored dependencies, generated/build output, symlinks, submodules, and files excluded by Git archive export rules are not included. No repository code was executed.");
    snapshot.warnings = snapshot.warnings.length > 100 ? [...snapshot.warnings.slice(0, 98), ...snapshot.warnings.slice(-2)] : snapshot.warnings;
    return snapshot;
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof RepositoryError) throw error;
    throw invalidArchive();
  } finally { zip.close(); }
}
