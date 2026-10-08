"use client";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { GitBranch, X } from "lucide-react";

export function RepositoryAccess() {
  const [open, setOpen] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = dialogRef.current; if (open && !dialog?.open) dialog?.showModal(); else if (!open && dialog?.open) dialog.close(); }, [open]);
  return <><button type="button" className="studio-secondary gap-2 px-3 text-xs" onClick={() => setOpen(true)} title="Repository access" aria-label="Public repository import information"><GitBranch size={15} /><span className="hidden sm:inline">Public repositories</span></button>
    {open && createPortal(<dialog ref={dialogRef} onCancel={() => setOpen(false)} onClose={() => setOpen(false)} aria-labelledby="repository-access-title" className="repository-access-dialog">
      <div className="architecture-inspector-title"><h2 id="repository-access-title">Public GitHub repositories</h2><button aria-label="Close repository access" onClick={() => setOpen(false)}><X size={18} /></button></div>
      <p>Paste a public GitHub repository or branch URL to map its files and inspect its code, documentation and architecture. No GitHub account connection or token is needed.</p>
      <p>Private repositories cannot be imported into Chalkie. A private, missing, or unavailable repository will show an explanation instead of requesting credentials.</p>
      <p>Importing and filtering the snapshot uses no AI tokens. Generating explanations and answering questions still use your Groq allowance.</p>
      <small>Up to 32 MB per snapshot. Indexes up to 120 blueprint files and 160 source files, then retrieves relevant code for follow-ups. Selected source excerpts are sent to your explanation provider.</small>
    </dialog>, document.body)}
  </>;
}
