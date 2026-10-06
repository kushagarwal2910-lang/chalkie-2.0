"use client";
import { useEffect, useRef, useState } from "react";
import { GitBranch, X } from "lucide-react";
export function RepositoryAccess() {
  const [open, setOpen] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = dialogRef.current; if (open && !dialog?.open) dialog?.showModal(); else if (!open && dialog?.open) dialog.close(); }, [open]);
  const [connected, setConnected] = useState(false);
  const [token, setToken] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { void fetch("/api/repository-access").then(r => r.json()).then(data => setConnected(Boolean(data.connected))).catch(() => {}); }, []);
  async function save(remove = false) {
    setBusy(true); setMessage("");
    try {
      const response = await fetch("/api/repository-access", { method: remove ? "DELETE" : "POST", headers: { "Content-Type": "application/json" }, ...(!remove ? { body: JSON.stringify({ token }) } : {}) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "Could not update GitHub access.");
      setConnected(data.connected); setToken(""); setMessage(remove ? "GitHub access disconnected." : "Connected. You can now index repositories this token can read.");
      window.dispatchEvent(new Event("chalkie:repository-access-updated"));
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not connect GitHub."); }
    finally { setBusy(false); }
  }
  return <><button type="button" className="studio-secondary gap-2 px-3 text-xs" onClick={() => setOpen(true)} title="Repository access"><GitBranch size={15} /><span className="hidden sm:inline">{connected ? "GitHub connected" : "Repository access"}</span></button>
    <dialog ref={dialogRef} onCancel={() => setOpen(false)} onClose={() => { setOpen(false); setToken(""); }} aria-labelledby="repository-access-title" className="repository-access-dialog"><div className="architecture-inspector-title"><h2 id="repository-access-title">Repository access</h2><button aria-label="Close repository access" onClick={() => setOpen(false)}><X size={18} /></button></div><p>Public repositories work without a GitHub token. For private repositories or higher API limits, connect a fine-grained token restricted to your selected repositories with Contents: read-only access.</p><a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noreferrer">Create a GitHub token</a><form onSubmit={e => { e.preventDefault(); void save(); }}><label>GitHub token<input type="password" autoComplete="off" value={token} onChange={e => setToken(e.target.value)} placeholder="github_pat_…" maxLength={255} /></label><button className="studio-primary" disabled={busy || token.length < 10}>{busy ? "Connecting…" : "Connect GitHub"}</button></form>{connected && <button className="studio-secondary" disabled={busy} onClick={() => void save(true)}>Disconnect</button>}<p role="status">{message}</p><small>Your token is encrypted in an HttpOnly cookie. It is never included in the model context.</small></dialog>
  </>;
}
