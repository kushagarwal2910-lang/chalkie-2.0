/** Pin a browser tab to its notebook instead of the browser-wide current pointer. */
export function notebookLocation(location: { pathname: string; search: string; hash?: string }, id?: string) {
  const params = new URLSearchParams(location.search);
  params.delete("q"); params.delete("draft"); params.delete("id");
  if (id) params.set("id", id);
  const search = params.toString();
  return location.pathname + (search ? "?" + search : "") + (location.hash ?? "");
}

/** Late IndexedDB loads must never replace a newer navigation or generated lesson. */
export class NotebookRestoreGate {
  private revision = 0;
  begin() { const revision = ++this.revision; return () => revision === this.revision; }
  cancel() { this.revision++; }
}
