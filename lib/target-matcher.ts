import type { VisualConnection, VisualObject } from "./lesson-schema";
import { formatNarrationForSpeech } from "./speech-formatter";

export interface TargetPosition {
  charIndex: number;
  targetId: string;       // e.g. "central-solenoid#2" or "central-solenoid"
  baseTargetId: string;   // e.g. "central-solenoid"
  partIndex: number;      // -1 for whole object, >= 0 for specific internal part
  partLabel: string;      // specific label of the topic/part being discussed
  matchedToken: string;
}

const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "of", "in", "on", "at", "to", "for", "with",
  "by", "from", "up", "about", "into", "over", "after", "is", "are", "was",
  "were", "be", "been", "being", "have", "has", "had", "do", "does", "did",
  "will", "would", "shall", "should", "can", "could", "may", "might", "must",
  "this", "that", "these", "those", "each", "all", "both", "half", "some",
  "any", "most", "layer", "stage", "component", "card", "overview", "system",
  "structure", "model", "diagram", "where", "which", "then", "also", "here",
  "part", "high", "low", "shaped", "side", "type", "unit", "form", "item",
  "as", "if", "it", "so", "we", "us", "he", "my", "me", "no",
]);

interface CandidateTerm {
  term: string;
  targetId: string;
  baseTargetId: string;
  partIndex: number;
  partLabel: string;
  priority: number;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * High-precision linguistic target matcher:
 * Maps spoken teacher narration words to visual blackboard objects AND internal parts in real time.
 * When a specific part or concept is discussed (e.g. "Pulsed Current", "Loss Function", "D-T Ions"),
 * the laser pointer glides directly to that part and displays a synchronized badge.
 */
export function computeTargetPositions(
  spokenNarration: string,
  targetIds: string[],
  objects: VisualObject[],
  connections?: VisualConnection[],
): TargetPosition[] {
  if (!objects || objects.length === 0) return [];
  const text = spokenNarration.toLowerCase();
  const primaryIdSet = new Set((targetIds || []).map(id => id.split("#")[0]));
  const teachingConnections = (connections ?? []).filter(edge => primaryIdSet.has(edge.id));
  for (const edge of teachingConnections) {
    primaryIdSet.add(edge.from);
    primaryIdSet.add(edge.to);
  }

  const candidates: CandidateTerm[] = [];

  // Register terms from all objects (with higher priority for active segment targets)
  for (const obj of objects) {
    const isPrimary = primaryIdSet.has(obj.id);
    // Architecture steps have explicit targets. Previously a matching noun on
    // an earlier card could pull attention away from the current explanation.
    // Keep the broad legacy matcher for callers without an architecture graph.
    if (connections && !isPrimary) continue;
    const priority = isPrimary ? 2 : 1;

    // 1. Full cleaned object label
    const cleanLabel = (obj.label || "")
      .replace(/\([^)]*\)/g, " ")
      .replace(/[{}\[\]<>]/g, " ")
      .replace(/[:\-_—+*\\/]/g, " ")
      .trim()
      .toLowerCase();

    // Exact short service names such as "db" are meaningful when explicitly
    // targeted (including an edge endpoint). Do not promote short fragments,
    // unrelated labels, numbers, or common two-letter words into candidates.
    const shortPrimaryLabel = isPrimary && /^[a-z][a-z0-9]$/.test(cleanLabel) && (obj.label || "").trim().toLowerCase() === cleanLabel;
    if ((cleanLabel.length >= 3 || shortPrimaryLabel) && !STOP_WORDS.has(cleanLabel)) {
      candidates.push({
        term: cleanLabel,
        targetId: obj.id,
        baseTargetId: obj.id,
        partIndex: -1,
        partLabel: obj.label,
        priority: priority + 0.5,
      });
    }

    // 2. Multi-word phrases inside label
    const labelWords = cleanLabel.split(/\s+/).filter((w) => w.length >= 3 && !STOP_WORDS.has(w));
    if (labelWords.length >= 2) {
      for (let i = 0; i < labelWords.length - 1; i++) {
        const bigram = `${labelWords[i]} ${labelWords[i + 1]}`;
        candidates.push({
          term: bigram,
          targetId: obj.id,
          baseTargetId: obj.id,
          partIndex: -1,
          partLabel: obj.label,
          priority: isPrimary ? priority + 0.3 : priority,
        });
      }
    }
    // Single words inside object label: only for primary target objects, or distinctive terms >= 7 chars
    for (const w of labelWords) {
      if (isPrimary || w.length >= 7) {
        candidates.push({
          term: w,
          targetId: obj.id,
          baseTargetId: obj.id,
          partIndex: -1,
          partLabel: obj.label,
          priority: isPrimary ? priority : priority - 0.5,
        });
      }
    }

    // 3. Object ID tokens (e.g. "central-solenoid" -> "solenoid")
    const idTokens = obj.id
      .replace(/[^a-z0-9]/gi, " ")
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !STOP_WORDS.has(w));
    for (const token of idTokens) {
      if (isPrimary || token.length >= 7) {
        candidates.push({
          term: token,
          targetId: obj.id,
          baseTargetId: obj.id,
          partIndex: -1,
          partLabel: obj.label,
          priority: isPrimary ? priority : priority - 0.5,
        });
      }
    }

    // 4. Meaningful part labels & data inside the object
    if (Array.isArray(obj.parts)) {
      obj.parts.forEach((p, pIdx) => {
        const partTargetId = `${obj.id}#${pIdx}`;

        if (p.text && p.text.length >= 2 && p.text.length <= 48) {
          const ptClean = p.text
            .replace(/\([^)]*\)/g, " ")
            .replace(/[{}\[\]<>:=+*\\/]/g, " ")
            .toLowerCase()
            .trim();

          if (ptClean && ptClean.length >= 3 && !STOP_WORDS.has(ptClean)) {
            candidates.push({
              term: ptClean,
              targetId: partTargetId,
              baseTargetId: obj.id,
              partIndex: pIdx,
              partLabel: p.text,
              priority: priority + 0.6,
            });

            const ptWords = ptClean.split(/\s+/).filter((w) => w.length >= 3 && !STOP_WORDS.has(w));
            if (ptWords.length >= 2) {
              for (let i = 0; i < ptWords.length - 1; i++) {
                candidates.push({
                  term: `${ptWords[i]} ${ptWords[i + 1]}`,
                  targetId: partTargetId,
                  baseTargetId: obj.id,
                  partIndex: pIdx,
                  partLabel: p.text,
                  priority: priority + 0.4,
                });
              }
            }
            // Single part words: only for primary target objects or distinctive terms >= 7 chars
            for (const pw of ptWords) {
              if (isPrimary || pw.length >= 7) {
                candidates.push({
                  term: pw,
                  targetId: partTargetId,
                  baseTargetId: obj.id,
                  partIndex: pIdx,
                  partLabel: p.text,
                  priority: isPrimary ? priority : priority - 0.5,
                });
              }
            }
          }
        }

        // Part data keywords (e.g. "pushrod", "effort", "ions", "gradient")
        if (
          p.data &&
          typeof p.data === "string" &&
          p.data.length >= 3 &&
          p.data.length <= 24 &&
          !p.data.includes("|") &&
          !p.data.includes(":") &&
          !p.data.startsWith("M ") &&
          !/[0-9, ]{6,}/.test(p.data)
        ) {
          const pData = p.data.toLowerCase().trim();
          if (pData && !STOP_WORDS.has(pData) && (isPrimary || pData.length >= 7)) {
            candidates.push({
              term: pData,
              targetId: partTargetId,
              baseTargetId: obj.id,
              partIndex: pIdx,
              partLabel: p.text || obj.label,
              priority: isPrimary ? priority : priority - 0.5,
            });
          }
        }
      });
    }
  }

  // De-duplicate candidate terms per target
  const uniqueCandidates: CandidateTerm[] = [];
  const seenTermTarget = new Set<string>();
  for (const c of candidates) {
    // Match the same expanded engineering terms that the listener hears.
    const spokenTerm = formatNarrationForSpeech(c.term).replace(/[.!?]$/, "").toLowerCase();
    const key = `${spokenTerm}|${c.targetId}`;
    if (!seenTermTarget.has(key)) {
      seenTermTarget.add(key);
      uniqueCandidates.push({ ...c, term: spokenTerm });
    }
  }

  // Search for matches in spoken narration with strict word-boundary matching
  interface RawMatch extends TargetPosition {
    length: number;
    priority: number;
  }
  const rawMatches: RawMatch[] = [];

  for (const c of uniqueCandidates) {
    const escaped = escapeRegex(c.term);
    const regex = new RegExp(`\\b${escaped}\\b`, "gi");
    let m: RegExpExecArray | null;
    while ((m = regex.exec(text)) !== null) {
      rawMatches.push({
        charIndex: m.index,
        targetId: c.targetId,
        baseTargetId: c.baseTargetId,
        partIndex: c.partIndex,
        partLabel: c.partLabel,
        matchedToken: m[0],
        length: m[0].length,
        priority: c.priority,
      });
    }
  }

  // Sort matches:
  // 1. By charIndex ascending
  // 2. By length descending (longer, more specific phrases take precedence)
  // 3. By priority descending (active segment target preferred over other cards)
  rawMatches.sort((a, b) => a.charIndex - b.charIndex || b.length - a.length || b.priority - a.priority);

  // Filter overlapping spans (e.g. "central solenoid" vs "solenoid")
  const nonOverlapping: RawMatch[] = [];
  let lastEnd = -1;

  for (const m of rawMatches) {
    if (m.charIndex < lastEnd) continue;
    nonOverlapping.push(m);
    lastEnd = m.charIndex + m.length;
  }

  // Teach a directed handoff as source -> connection -> destination. Only use
  // connections explicitly selected by the lesson, with both endpoints spoken
  // in order in the same clause/sentence; proximity alone is not a relationship.
  const handoffs: RawMatch[] = [];
  for (let i = 1; i < nonOverlapping.length; i++) {
    const source = nonOverlapping[i - 1];
    const destination = nonOverlapping[i];
    if (source.baseTargetId === destination.baseTargetId) continue;
    const edges = teachingConnections.filter(edge => edge.from === source.baseTargetId && edge.to === destination.baseTargetId);
    if (!edges.length) continue;
    const start = source.charIndex + source.length;
    const bridge = text.slice(start, destination.charIndex);
    if (bridge.length > 180 || /[.!?]|\b(?:not|never|without|cannot|doesn['’]t|can['’]t)\b/.test(bridge)) continue;
    const explicit = edges.flatMap(edge => {
      const label = formatNarrationForSpeech(edge.label).replace(/[.!?]$/, "").trim().toLowerCase();
      if (label.length < 3 || STOP_WORDS.has(label)) return [];
      const match = new RegExp(`\\b${escapeRegex(label)}\\b`, "i").exec(bridge);
      return match ? [{ edge, match }] : [];
    });
    // Parallel connections need an exact relationship label to disambiguate.
    const selected = explicit.length === 1 ? explicit[0] : edges.length === 1 ? {
      edge: edges[0],
      match: /\b(?:send(?:s|ing)?|sent|pass(?:es|ing)?|call(?:s|ing)?|request(?:s|ing)?|quer(?:y|ies|ying)|read(?:s|ing)?|writ(?:e|es|ing)|stor(?:e|es|ing)|rout(?:e|es|ing)|forward(?:s|ing)?|publish(?:es|ing)?|feed(?:s|ing)?|trigger(?:s|ing)?|load(?:s|ing)?|connect(?:s|ing)?|depend(?:s|ing)?|use(?:s)?|run(?:s|ning)?|build(?:s|ing)?|deploy(?:s|ing)?|produce(?:s|d)?|contain(?:s|ing)?)\b/.exec(bridge),
    } : undefined;
    if (!selected?.match) continue;
    handoffs.push({
      charIndex: start + selected.match.index,
      targetId: selected.edge.id, baseTargetId: selected.edge.id,
      partIndex: -1, partLabel: selected.edge.label,
      matchedToken: selected.match[0], length: selected.match[0].length, priority: 3,
    });
  }
  nonOverlapping.push(...handoffs);
  nonOverlapping.sort((a, b) => a.charIndex - b.charIndex);

  // Guaranteed fallback: If no terms matched in text, distribute segment targetIds proportionally
  if (nonOverlapping.length === 0 && targetIds.length > 0) {
    const textLen = Math.max(1, text.length);
    targetIds.forEach((tId, idx) => {
      const obj = objects.find((o) => o.id === tId);
      nonOverlapping.push({
        charIndex: Math.floor((idx / targetIds.length) * textLen),
        targetId: tId,
        baseTargetId: tId,
        partIndex: -1,
        partLabel: obj?.label || tId,
        matchedToken: "proportional-timing",
        length: 1,
        priority: 1,
      });
    });
  }

  // Remove adjacent duplicate targets so pointer moves intentionally between topics
  const filtered: TargetPosition[] = [];
  for (const pos of nonOverlapping) {
    if (!filtered.length || filtered[filtered.length - 1].targetId !== pos.targetId) {
      filtered.push({
        charIndex: pos.charIndex,
        targetId: pos.targetId,
        baseTargetId: pos.baseTargetId,
        partIndex: pos.partIndex,
        partLabel: pos.partLabel,
        matchedToken: pos.matchedToken,
      });
    }
  }

  return filtered;
}
