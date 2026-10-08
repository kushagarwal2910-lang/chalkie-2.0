"use client";

import { useId, useRef, useState } from "react";
import { FileText, Paperclip, X } from "lucide-react";
import { MAX_DOCUMENTS, MAX_DOCUMENT_CHARS, repositoryInputSchema, type RepositoryInput } from "@/lib/repository-input";
import { defaultExplanationFocusHint } from "@/lib/architecture/teaching-focus";

export function RepositoryContext({ value, onChange, audience = "developer", disabled = false, onBusyChange, defaultOpen = false }: {
  value: RepositoryInput; onChange: (value: RepositoryInput) => void; audience?: string; disabled?: boolean; onBusyChange?: (busy: boolean) => void; defaultOpen?: boolean;
}) {
  const id = useId();
  const fileRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState("");
  const [reading, setReading] = useState(false);
  const [expanded, setExpanded] = useState(defaultOpen);
  const defaultFocus = defaultExplanationFocusHint(audience);
  const hasCustomFocus = Boolean(value.instructions.trim());
  async function attach(files: File[]) {
    setError(""); setReading(true); onBusyChange?.(true);
    try {
      if (files.length + value.documents.length > MAX_DOCUMENTS) throw new Error("Attach up to 5 documents.");
      const documents = [...value.documents];
      for (const file of files) {
        if (!/\.(md|markdown|txt)$/i.test(file.name)) throw new Error("Upload Markdown (.md, .markdown) or plain text (.txt). Paste text from other formats into Supporting notes.");
        if (file.size > 100_000) throw new Error(file.name + " exceeds the 100 KB file limit.");
        const text = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
        if (text.includes("\0")) throw new Error(file.name + " is not a plain-text document.");
        if (!text.trim() || text.length > MAX_DOCUMENT_CHARS) throw new Error(file.name + " must contain between 1 and 20,000 characters.");
        documents.push({ name: file.name, text });
      }
      const parsed = repositoryInputSchema.safeParse({ ...value, documents });
      if (!parsed.success) throw new Error(parsed.error.issues[0].message);
      onChange(parsed.data);
    } catch (err) { setError(err instanceof Error ? err.message : "Could not read these documents."); }
    finally { setReading(false); onBusyChange?.(false); if (fileRef.current) fileRef.current.value = ""; }
  }
  return <details className="repository-context" open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary><Paperclip size={14} /> Add instructions & documentation <span>{value.documents.length ? `${value.documents.length} attached` : hasCustomFocus ? "Custom focus" : defaultFocus.label}</span></summary>
    <fieldset disabled={disabled || reading}>
      <label htmlFor={id + "-instructions"}>What should Chalkie focus on?</label>
      <textarea id={id + "-instructions"} value={value.instructions} maxLength={2000} rows={3} aria-describedby={!hasCustomFocus ? id + "-default-focus" : undefined} onChange={e => onChange({ ...value, instructions: e.target.value })} placeholder="Optional: describe your question or preferred focus to replace the default walkthrough." />
      {!hasCustomFocus && <p id={id + "-default-focus"}>Default: {defaultFocus.summary}</p>}
      <label htmlFor={id + "-notes"}>Supporting notes</label>
      <textarea id={id + "-notes"} value={value.notes} maxLength={MAX_DOCUMENT_CHARS} rows={3} onChange={e => onChange({ ...value, notes: e.target.value })} placeholder="Paste architecture docs, team conventions, onboarding notes, or business context…" />
      <div className="repository-context-files"><button type="button" className="studio-secondary gap-2 px-3 text-xs" onClick={() => fileRef.current?.click()}><Paperclip size={14} />{reading ? "Reading documents…" : "Attach documents"}</button><span>Markdown or text · 5 files · 20,000 characters each</span></div>
      <input hidden ref={fileRef} type="file" accept=".md,.markdown,.txt,text/plain,text/markdown" multiple onChange={e => void attach(Array.from(e.target.files ?? []))} />
      {value.documents.map((doc, index) => <div key={index} className="repository-context-file"><FileText size={14} /><span>{doc.name}</span><button type="button" onClick={() => onChange({ ...value, documents: value.documents.filter((_, i) => i !== index) })} aria-label={"Remove " + doc.name}><X size={15} /></button></div>)}
      <p>These sources accompany your GitHub repository and remain available for follow-up questions. Relevant excerpts are sent to Groq. Use text from PDFs or Word documents in Supporting notes.</p>
    </fieldset>
    {error && <p className="repository-context-error" role="alert">{error}</p>}
  </details>;
}
