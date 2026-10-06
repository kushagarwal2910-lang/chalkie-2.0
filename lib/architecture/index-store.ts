import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { cookies } from "next/headers";
import { RepositoryError, type RepositoryIndex } from "./types";

const directory = () => path.resolve(/* turbopackIgnore: true */ process.env.CHALKIE_DATA_DIR || path.join(process.cwd(), ".chalkie-data"));
const ttl = 7 * 24 * 60 * 60 * 1000;
async function readIndexFile(file: string): Promise<Partial<RepositoryIndex>> {
  try { return JSON.parse(await readFile(/* turbopackIgnore: true */ file, "utf8")) as RepositoryIndex; } catch { return {}; }
}
export async function repositoryOwner() {
  const jar = await cookies();
  let value = jar.get("chalkie_repository_owner")?.value;
  if (!value || !/^[a-f0-9]{64}$/.test(value)) {
    value = randomBytes(32).toString("hex");
    jar.set("chalkie_repository_owner", value, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "strict", path: "/", maxAge: 365 * 86400 });
  }
  return createHash("sha256").update(value).digest("hex");
}
export async function saveRepositoryIndex(index: RepositoryIndex) {
  const root = directory();
  await mkdir(root, { recursive: true });
  // Bounded local cache; stale snapshots expire without touching any other directory.
  const entries = (await readdir(/* turbopackIgnore: true */ root)).filter(name => /^[a-f0-9-]{36}\.json$/.test(name));
  let owned = 0;
  for (const name of entries) {
    const file = path.join(/* turbopackIgnore: true */ root, name);
    const info = await stat(file).catch(() => null);
    if (info && Date.now() - info.mtimeMs > ttl) await rm(file, { force: true });
    else {
      const saved = await readIndexFile(file);
      if (saved.ownerKey === index.ownerKey) owned++;
    }
  }
  if (owned >= 30) throw new RepositoryError("This browser has 30 indexed repositories. Reset the workspace or wait for older snapshots to expire.", "INDEX_LIMIT");
  const destination = path.join(/* turbopackIgnore: true */ root, index.id + ".json");
  const temporary = destination + ".tmp";
  await writeFile(temporary, JSON.stringify(index), { mode: 0o600 });
  await rename(temporary, destination);
}
export async function loadRepositoryIndex(id: string, ownerKey: string): Promise<RepositoryIndex> {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new RepositoryError("Invalid repository snapshot.", "INDEX_MISSING");
  try {
    const index = JSON.parse(await readFile(/* turbopackIgnore: true */ path.join(/* turbopackIgnore: true */ directory(), id + ".json"), "utf8")) as RepositoryIndex;
    if (index.version !== 1 || index.ownerKey !== ownerKey || !Number.isFinite(Date.parse(index.createdAt)) || Date.now() - Date.parse(index.createdAt) > ttl) throw new Error("Unavailable");
    return index;
  } catch { throw new RepositoryError("This repository snapshot is unavailable or expired. Paste its GitHub URL again to rebuild the index; your saved diagram is preserved.", "INDEX_MISSING"); }
}
export async function clearRepositoryIndexes(ownerKey: string) {
  const root = directory();
  const entries = await readdir(/* turbopackIgnore: true */ root).catch(() => []);
  for (const name of entries.filter(name => /^[a-f0-9-]{36}\.json$/.test(name))) {
    const file = path.join(/* turbopackIgnore: true */ root, name);
    const index = await readIndexFile(file);
    if (index.ownerKey === ownerKey) await rm(file, { force: true });
  }
}
