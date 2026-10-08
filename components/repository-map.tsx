"use client";

import { useEffect, useState } from "react";
import type { SourceDefinition } from "@/lib/architecture/types";

type MapPage = { repository: { url: string; commit: string }; mappedFiles: number; analyzedFiles: number; definitionCount: number; total: number; nextOffset: number | null;
  files: Array<{ path: string; indexed: boolean; parser?: string; analysisComplete?: boolean; definitions: SourceDefinition[]; imports: string[] }> };

export function RepositoryMap({ indexId }: { indexId: string }) {
  return <RepositoryMapContents key={indexId} indexId={indexId} />;
}

function RepositoryMapContents({ indexId }: { indexId: string }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<MapPage | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!open) return;
    const abort = new AbortController();
    const timer = setTimeout(async () => {
      setPage(null); setError("");
      try {
        const params = new URLSearchParams({ indexId, q: query, offset: String(offset) });
        const response = await fetch("/api/repository-map?" + params, { signal: abort.signal, cache: "no-store" });
        if (!response.ok) throw new Error("This repository map is unavailable. Reimport the repository to refresh it.");
        const result = await response.json() as MapPage;
        if (!abort.signal.aborted) setPage(result);
      } catch (failure) { if (!abort.signal.aborted) setError(failure instanceof Error ? failure.message : "Could not load repository map."); }
    }, 180);
    return () => { clearTimeout(timer); abort.abort(); };
  }, [indexId, open, query, offset]);
  return <details className="repository-snapshot" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer">Explore repository files & symbols</summary>
    {open && <div className="mt-3 space-y-3">
      <input className="w-full rounded border border-white/15 bg-transparent p-2 text-xs" aria-label="Search repository paths or symbols" placeholder="Find a file, class or function" value={query} onChange={event => { setPage(null); setQuery(event.target.value); setOffset(0); }} />
      {error ? <p role="alert">{error}</p> : !page ? <p role="status">Loading repository map…</p> : <>
        <p>{page.mappedFiles} mapped files · {page.analyzedFiles} analyzed · {page.definitionCount} definitions</p>
        <div className="max-h-80 space-y-2 overflow-y-auto">
          {page.files.map(file => <details key={file.path} className="rounded border border-white/10 p-2 text-xs">
            <summary className="cursor-pointer break-all">{file.path}</summary>
            <p className="mt-2">{file.parser ? `${file.parser} · ${file.analysisComplete ? "syntax mapped" : "partial syntax coverage"}` : file.indexed ? "Document indexed" : "Path mapped; contents not indexed"}</p>
            {file.definitions.map((symbol, position) => <a key={position} className="block break-all py-1 text-[#c4b5fd]" target="_blank" rel="noreferrer" href={`${page.repository.url}/blob/${page.repository.commit}/${file.path.split("/").map(encodeURIComponent).join("/")}#L${symbol.startLine}-L${symbol.endLine}`}>{symbol.kind} {symbol.name} · lines {symbol.startLine}–{symbol.endLine}</a>)}
            {file.imports.length > 0 && <p className="break-all">Imports: {file.imports.join(", ")}</p>}
          </details>)}
          {!page.files.length && <p>No matching mapped paths or definitions.</p>}
        </div>
        <div className="flex justify-between text-xs"><button type="button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 60))}>Previous</button><span>{Math.min(offset + 1, page.total)}–{offset + page.files.length} of {page.total}</span><button type="button" disabled={page.nextOffset === null} onClick={() => setOffset(page.nextOffset ?? 0)}>Next</button></div>
        <p>Static code map at commit {page.repository.commit.slice(0, 7)}. Generated files, dependencies and secrets are excluded.</p>
      </>}
    </div>}
  </details>;
}
