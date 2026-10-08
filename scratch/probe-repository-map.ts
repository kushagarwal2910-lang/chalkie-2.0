import { ingestRepository, retrieveEvidence } from "../lib/architecture/github";
import { investigateRepository } from "../lib/architecture/repository-research";
import { classifySource } from "../lib/architecture/source-analysis";
import { createRepositoryLesson } from "../lib/architecture/explanation";
import type { Evidence } from "../lib/architecture/types";

const urls = process.argv.slice(2);
for (const url of urls) {
  const started = performance.now();
  const requests: { host: string; credentials?: RequestCredentials; authenticated: boolean }[] = [];
  const contents = new Map<string, string>();
  const fetcher: typeof fetch = async (input, options) => {
    const address = new URL(String(input));
    const headers = new Headers(options?.headers);
    requests.push({ host: address.hostname, credentials: options?.credentials, authenticated: headers.has("authorization") || headers.has("cookie") });
    const response = await fetch(input, options);
    if (address.hostname === "raw.githubusercontent.com" && response.ok) contents.set(address.pathname.split("/").slice(4).map(decodeURIComponent).join("/"), await response.clone().text());
    return response;
  };
  try {
    const index = await ingestRepository(url, { ownerKey: "anonymous-real-parser-smoke", fetcher, allowEmptyEvidence: true });
    const importedMs = Math.round(performance.now() - started);
    const readable = index.tree?.filter(file => classifySource(file.path) && file.bytes > 0 && file.bytes <= 512000) ?? [];
    const mapped = new Set(index.sourceFiles?.map(file => file.path));
    const missing = readable.filter(file => !mapped.has(file.path));
    const counts: Record<string, number> = {};
    for (const file of index.sourceFiles ?? []) counts[file.parser] = (counts[file.parser] ?? 0) + 1;
    const question = "I'm a beginner, want to contribute to this repo, help me figure out codebase";
    index.instructions = question;
    const beginner = await investigateRepository(index, question, { fetcher, freshlyIndexed: true });
    const top = retrieveEvidence(beginner, question);
    let capturedBody = "";
    const sentinel = new Error("MOCK_CAPTURE_COMPLETE");
    try {
      await createRepositoryLesson(beginner, "developer", {}, async (_url, options) => { capturedBody = String(options?.body ?? ""); throw sentinel; });
    } catch (error) { if (error !== sentinel) throw error; }
    const packed = JSON.parse(capturedBody);
    const context = JSON.parse(packed.messages.find((message: { role: string }) => message.role === "user").content) as { evidence: Evidence[]; repositoryMap: { directories: unknown[]; files: Array<{ path: string; definitions: string[] }> }; explanationFocus: string };
    const modelRequest = { bytes: Buffer.byteLength(capturedBody), maxCompletionTokens: packed.max_completion_tokens, evidence: context.evidence.map(item => ({ path: item.path, lines: [item.startLine, item.endLine], kind: item.kind, characters: item.text.length })), sourceCount: context.evidence.filter(item => item.kind === "source").length, documentationCount: context.evidence.filter(item => item.kind === "documentation").length, mapFiles: context.repositoryMap.files.map(file => ({ path: file.path, definitions: file.definitions.length })), mapDirectories: context.repositoryMap.directories.length, instructionsPreserved: context.explanationFocus.includes(question) };
    const defFiles = (index.sourceFiles ?? []).filter(file => !/(?:^|\/)(?:tests?|examples?|test_data)(?:\/|$)/.test(file.path));
    const deep = defFiles.flatMap(file => (file.definitions ?? []).filter(def => ["function", "method", "class"].includes(def.kind) && def.startLine > 200).map(def => ({ file, def })))
      .sort((a, b) => Number(index.evidence.some(item => item.path === a.file.path)) - Number(index.evidence.some(item => item.path === b.file.path)) || b.def.startLine - a.def.startLine)[0];
    let focused: unknown;
    if (deep) {
      const end = Math.min(deep.def.endLine, deep.def.startLine + 12);
      const prompt = `Explain ${deep.file.path}:${deep.def.startLine}-${end}, especially ${deep.def.name}.`;
      const researched = await investigateRepository(beginner, prompt, { fetcher, maxFiles: 3 });
      const selected = retrieveEvidence(researched, prompt);
      const citations = selected.filter(item => item.path === deep.file.path && item.startLine <= end && item.endLine >= deep.def.startLine);
      const raw = contents.get(deep.file.path);
      let lineValid = 0, lineInvalid = 0;
      if (raw) for (const item of citations) {
        const original = raw.split(/\r?\n/).slice(item.startLine - 1, item.endLine).join("\n");
        const clean = item.text.replaceAll("\r\n", "\n");
        if (original.startsWith(clean) || clean.includes("[REDACTED]") || !clean.trim()) lineValid++; else lineInvalid++;
      }
      focused = { path: deep.file.path, definition: deep.def, requestedEnd: end, fetched: researched.research?.paths, top: selected.slice(0, 5).map(item => `${item.path}:${item.startLine}-${item.endLine}`), citedRequestedRegion: citations.length, checkedRaw: Boolean(raw), lineValid, lineInvalid, notes: researched.research?.notes };
    }
    console.log(JSON.stringify({ url, commit: index.repository.commit, importedMs, totalMs: Math.round(performance.now() - started), snapshotBytes: Buffer.byteLength(JSON.stringify(index)), mappedFiles: index.tree?.length, readableSources: readable.length, mappedSources: index.sourceFiles?.length, missingSources: missing.map(file => file.path).slice(0, 12), parsers: counts, completeSources: index.sourceFiles?.filter(file => file.analysisComplete).length, definitions: index.sourceFiles?.reduce((sum, file) => sum + (file.definitions?.length ?? 0), 0), classes: index.sourceFiles?.reduce((sum, file) => sum + (file.definitions?.filter(def => def.kind === "class").length ?? 0), 0), excerptFiles: new Set(index.evidence.filter(item => item.kind === "source").map(item => item.path)).size, evidence: index.evidence.length, importWarnings: index.warnings, beginnerFetched: beginner.research?.paths, beginnerTop: top.slice(0, 12).map(item => `${item.path}:${item.startLine}-${item.endLine}`), modelRequest, focused, requests }, null, 2));
  } catch (error) {
    console.log(JSON.stringify({ url, elapsedMs: Math.round(performance.now() - started), failure: error instanceof Error ? error.message : String(error), requests }, null, 2));
  }
}
