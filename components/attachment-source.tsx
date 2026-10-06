import { FileText } from "lucide-react";
import type { ResearchSource } from "@/lib/lesson-schema";

export function AttachmentSource({ source }: { source: ResearchSource }) {
  return <details className="attachment-source"><summary><FileText size={14} /><span>{source.title}<small>Supporting document · excerpt</small></span></summary><p>{source.summary}</p></details>;
}
