import assert from "node:assert/strict";
import test from "node:test";
import { ingestRepository, parseRepositoryUrl } from "./github";
import { ARCHIVE_BYTE_LIMIT, readPublicArchive } from "./github-archive";
import { PublicSnapshotCache } from "./public-snapshot-cache";
import { archiveResponse, zipFixture } from "./test-zip-fixture";

const repo = parseRepositoryUrl("https://github.com/team/project");
const doc = { name: "project-HEAD/README.md", text: "# Architecture\nThe service stores records in a database." };
const noAbort = () => new AbortController().signal;
const imported = (archive: Buffer) => readPublicArchive(archive, repo, noAbort());

test("branch and commit URLs use a single unauthenticated archive request", async () => {
  for (const ref of ["feature/docs", "a".repeat(40)]) {
    let calls = 0;
    const options = { ownerKey: "owner", token: "legacy-token-must-never-be-sent", fetcher: (async (url, init) => {
      calls++;
      assert.equal(String(url), "https://codeload.github.com/team/project/zip/" + encodeURIComponent(ref));
      assert.equal(new Headers(init?.headers).get("Authorization"), null);
      assert.equal(new Headers(init?.headers).get("Cookie"), null);
      assert.equal(init?.redirect, "error");
      return archiveResponse(zipFixture([doc]));
    }) as typeof fetch };
    const index = await ingestRepository(repo.url + "/tree/" + ref, options);
    assert.equal(calls, 1); assert.equal(index.repository.commit, "a".repeat(40));
  }
});

test("public cache revalidates access and keeps owners and attached context separate", async () => {
  const cache = new PublicSnapshotCache();
  let calls = 0;
  const fetcher = (async (_url, init) => {
    calls++;
    if (calls === 1) return archiveResponse(zipFixture([doc]));
    assert.equal(new Headers(init?.headers).get("If-None-Match"), '"snapshot"');
    return new Response(null, { status: 304 });
  }) as typeof fetch;
  const first = await ingestRepository(repo.url, { ownerKey: "first", cache, fetcher });
  first.evidence[0].text = "private attachment must not leak";
  first.instructions = "private instructions";
  const second = await ingestRepository(repo.url, { ownerKey: "second", cache, fetcher });
  assert.equal(calls, 2); assert.equal(second.ownerKey, "second"); assert.notEqual(second.id, first.id);
  assert.equal(second.instructions, undefined); assert.doesNotMatch(JSON.stringify(second), /private attachment|private instructions/);
});

test("a cached repository becoming unavailable cannot be served to another owner", async () => {
  const cache = new PublicSnapshotCache();
  let calls = 0;
  const fetcher = (async () => ++calls === 1 ? archiveResponse(zipFixture([doc])) : new Response(null, { status: 404 })) as typeof fetch;
  await ingestRepository(repo.url, { ownerKey: "first", cache, fetcher });
  await assert.rejects(ingestRepository(repo.url, { ownerKey: "second", cache, fetcher }), { code: "PUBLIC_REPOSITORY_REQUIRED", retryable: false });
  assert.equal(cache.get("https://codeload.github.com/team/project/zip/HEAD"), undefined);
});

test("a branch moving to another commit replaces cached evidence", async () => {
  const cache = new PublicSnapshotCache();
  let calls = 0;
  const fetcher = (async () => ++calls === 1 ? archiveResponse(zipFixture([doc])) : archiveResponse(zipFixture([{ ...doc, text: "# New architecture\nThe system now uses a message queue." }], "b".repeat(40)), '"new"')) as typeof fetch;
  await ingestRepository(repo.url, { ownerKey: "a", cache, fetcher });
  const next = await ingestRepository(repo.url, { ownerKey: "a", cache, fetcher });
  assert.equal(next.repository.commit, "b".repeat(40)); assert.match(JSON.stringify(next.evidence), /message queue/);
});

test("private/missing repositories fail without model calls, retries or credential requests", async () => {
  let calls = 0;
  const fetcher = (async () => { calls++; return new Response(null, { status: 404 }); }) as typeof fetch;
  await assert.rejects(ingestRepository(repo.url, { ownerKey: "a", fetcher, allowEmptyEvidence: true }), error => {
    assert.equal((error as { code: string }).code, "PUBLIC_REPOSITORY_REQUIRED");
    assert.match((error as Error).message, /private repositories cannot be imported/);
    assert.doesNotMatch((error as Error).message, /connect|token|key/i);
    return true;
  });
  assert.equal(calls, 1);
});

test("secrets, generated code, symlinks and vendored files are never decompressed", async () => {
  const ignored = ["generated/app.ts", "vendor/auth.py", ".env", "secrets.yaml", "node_modules/pkg/package.json", "infra/terraform.tfstate"];
  const snapshot = await imported(zipFixture([doc, ...ignored.map(name => ({ name: "project-HEAD/" + name, text: "DO_NOT_READ", invalidDeflate: true })),
    { name: "project-HEAD/ARCHITECTURE.md", text: "outside.md", mode: 0xa1ff, invalidDeflate: true },
  ]));
  assert.deepEqual(snapshot.files.map(f => f.path), ["README.md"]);
  assert.doesNotMatch(JSON.stringify(snapshot), /DO_NOT_READ|outside.md/);
});

test("archive paths, duplicate names, corruption and missing commit provenance fail closed", async () => {
  for (const name of ["project-HEAD/../README.md", "/absolute/README.md", "project-HEAD/docs/../../README.md", "project-HEAD/docs\\README.md"]) {
    await assert.rejects(imported(zipFixture([{ ...doc, name }])), { code: "GITHUB_INVALID_ARCHIVE" });
  }
  await assert.rejects(imported(zipFixture([doc, doc])), { code: "GITHUB_INVALID_ARCHIVE" });
  await assert.rejects(imported(Buffer.from("not a zip")), { code: "GITHUB_INVALID_ARCHIVE" });
  await assert.rejects(imported(zipFixture([doc], "")), { code: "GITHUB_INVALID_ARCHIVE" });
  await assert.rejects(readPublicArchive(zipFixture([doc]), { ...repo, ref: "b".repeat(40) }, noAbort()), { code: "GITHUB_INVALID_ARCHIVE" });
});

test("oversized blueprints are skipped and dishonest uncompressed sizes are rejected", async () => {
  const large = await imported(zipFixture([doc, { name: "project-HEAD/ARCHITECTURE.md", text: "x".repeat(512001) }]));
  assert.equal(large.files.length, 1); assert.ok(large.warnings.some(w => /oversized/.test(w)));
  await assert.rejects(imported(zipFixture([{ ...doc, text: "x".repeat(100000), declaredSize: 10 }])), { code: "GITHUB_INVALID_ARCHIVE" });
});

test("priority and count limits retain the root documentation and report partial coverage", async () => {
  const files = Array.from({ length: 125 }, (_, i) => ({ name: `project-HEAD/services/${i}/package.json`, text: '{"dependencies":{"redis":"5"}}' }));
  const snapshot = await imported(zipFixture([...files, doc]));
  assert.equal(snapshot.discoveredFiles, 126); assert.equal(snapshot.files.length, 120);
  assert.equal(snapshot.files[0].path, "README.md"); assert.ok(snapshot.warnings.some(w => /partial/.test(w)));
});

test("download limits cancel oversized responses before archive parsing", async () => {
  let cancelled = false;
  const fetcher = (async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { "content-length": String(ARCHIVE_BYTE_LIMIT + 1) } })) as typeof fetch;
  await assert.rejects(ingestRepository(repo.url, { ownerKey: "a", fetcher }), { code: "REPOSITORY_LIMIT" });
  assert.equal(cancelled, true);
});

test("streaming size limits work when Content-Length is absent", async () => {
  let cancelled = false;
  const fetcher = (async () => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); },
    cancel() { cancelled = true; },
  }))) as typeof fetch;
  await assert.rejects(ingestRepository(repo.url, { ownerKey: "a", fetcher }), { code: "REPOSITORY_LIMIT" });
  assert.equal(cancelled, true);
});

test("aborting an import cancels download and cannot return a stale snapshot", async () => {
  const controller = new AbortController(); let cancelled = false;
  const fetcher = (async () => new Response(new ReadableStream({
    pull() { controller.abort(); }, cancel() { cancelled = true; },
  }))) as typeof fetch;
  await assert.rejects(ingestRepository(repo.url, { ownerKey: "a", fetcher, signal: controller.signal }), { name: "AbortError" });
  assert.equal(cancelled, true);
});
