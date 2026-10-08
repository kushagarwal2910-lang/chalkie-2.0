/**
 * Formats lesson narration text to optimize pronunciation, clarity,
 * and natural pause cadence for device speech synthesis. No model calls.
 */

const FILE_NAME = String.raw`(?:[\p{L}\d_.@+~-]+\.\p{L}[\p{L}\d]{0,11}|Dockerfile(?:\.[\w.-]+)?|Makefile|README|LICENSE|Gemfile|Procfile|\.env(?:\.[\w.-]+)?)`;
const FILE_LINES = String.raw`(?:#L?\d+(?:-L?\d+)?|:\d+(?::\d+)?(?:-\d+(?::\d+)?)?)?(?:\s*\(lines?\s+\d+(?:\s*[-–]\s*\d+)?\))?`;

function spokenFileName(name: string): string {
  return name.length > 48 || /^[a-f\d]{24,}(?:\.[a-z\d]+)+$/i.test(name) ? "the source file" : name;
}

function shortenFileReference(value: string): string {
  const punctuation = value.match(/[.,;!?]+$/)?.[0] ?? "";
  let reference = punctuation ? value.slice(0, -punctuation.length) : value;
  if (/^(?:https?:\/\/)?github\.com\/[^/]+\/[^/]+\/blob\//i.test(reference)) {
    try {
      const url = new URL(/^https?:/i.test(reference) ? reference : "https://" + reference);
      const basename = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
      return (basename ? spokenFileName(basename) : "the source file") + punctuation;
    } catch { return "the source file" + punctuation; }
  }
  // Endpoint names describe an interface, not a source location.
  if (/^\/?(?:api|rest|graphql|v\d+)[/\\]/i.test(reference)) return value;
  reference = reference.replace(new RegExp(FILE_LINES + "$", "iu"), "");
  const basename = reference.split(/[/\\]/).at(-1) ?? "";
  const recognizableFile = new RegExp("^" + FILE_NAME + "$", "iu").test(basename)
    || /[/\\]/.test(reference) && /^[\p{L}\d_. @+()~-]+\.\p{L}[\p{L}\d]{0,11}$/u.test(basename);
  if (!recognizableFile) return value;
  return spokenFileName(basename) + punctuation;
}

/** Shorten narration only. Source paths and citation metadata remain intact. */
export function shortenNarrationReferences(text: string): string {
  if (!text) return "";
  return text
    // Keep a human-readable link label rather than speaking its destination.
    .replace(/!?\[([^\]]+)\]\([^\s)]+\)/g, (_full, label: string) => shortenFileReference(label))
    .replace(new RegExp(String.raw`\x60([^\x60\r\n]+)\x60(${FILE_LINES})`, "giu"), (full, value: string, lines: string) => {
      const reference = value + lines;
      const shortened = shortenFileReference(reference);
      return shortened === reference ? full : shortened;
    })
    .replace(/(["'])((?:[a-z]:[/\\]|\.{1,2}[/\\]|~[/\\]|[/\\])[^"'\r\n]+)\1/gi,
      (full, _quote, value: string) => {
        const shortened = shortenFileReference(value);
        return shortened === value ? full : shortened;
      })
    .replace(/\b(?:https?:\/\/)?github\.com\/[^\s<>"'`\])]+\/blob\/[^\s<>"'`\])]+/gi, shortenFileReference)
    // Absolute paths may contain spaces in directory names. Relative paths
    // with spaces are handled when quoted/backticked, so prose is never eaten.
    .replace(new RegExp(String.raw`(?:\b[a-z]:[/\\]|~[/\\]|\.{1,2}[/\\]|(?<![\w/])[/\\])(?:[\p{L}\d_. @+~()-]+[/\\])*?${FILE_NAME}${FILE_LINES}(?![\p{L}\d_/\\-]|\.[\p{L}\d])`, "giu"), shortenFileReference)
    .replace(new RegExp(String.raw`(?<![\p{L}\d_.:/\\])(?:[\p{L}\d_.@+~()-]+[/\\])+?${FILE_NAME}${FILE_LINES}(?![\p{L}\d_/\\-]|\.[\p{L}\d])`, "giu"), shortenFileReference)
    // Also suppress line citations and unwieldy standalone hashed filenames.
    .replace(new RegExp(String.raw`(?<![\p{L}\d_.:/\\])${FILE_NAME}${FILE_LINES}(?![\p{L}\d/\\])`, "giu"), shortenFileReference)
    .replace(/\b(the|a)\s+the source file\b/gi, "$1 source file");
}

// Common measurement units to expand for clear pronunciation
const UNIT_REPLACEMENTS: [RegExp, string][] = [
  // Computing units, before the shorter physical-unit patterns.
  [/\b(\d+(?:\.\d+)?)\s*ms\b/g, "$1 milliseconds"],
  [/\b(\d+(?:\.\d+)?)\s*KB\b/g, "$1 kilobytes"],
  [/\b(\d+(?:\.\d+)?)\s*MB\b/g, "$1 megabytes"],
  [/\b(\d+(?:\.\d+)?)\s*GB\b/g, "$1 gigabytes"],
  [/\b(\d+(?:\.\d+)?)\s*TB\b/g, "$1 terabytes"],
  // Speed & distance
  [/\b(\d+(?:\.\d+)?)\s*km\/h\b/gi, "$1 kilometers per hour"],
  [/\b(\d+(?:\.\d+)?)\s*mph\b/gi, "$1 miles per hour"],
  [/\b(\d+(?:\.\d+)?)\s*km\b/gi, "$1 kilometers"],
  [/\b(\d+(?:\.\d+)?)\s*m\b/gi, "$1 meters"],
  [/\b(\d+(?:\.\d+)?)\s*cm\b/gi, "$1 centimeters"],
  [/\b(\d+(?:\.\d+)?)\s*mm\b/gi, "$1 millimeters"],
  [/\b(\d+(?:\.\d+)?)\s*nm\b/gi, "$1 nanometers"],

  // Weight & mass
  [/\b(\d+(?:\.\d+)?)\s*kg\b/gi, "$1 kilograms"],
  [/\b(\d+(?:\.\d+)?)\s*mg\b/gi, "$1 milligrams"],
  [/\b(\d+(?:\.\d+)?)\s*t\b/gi, "$1 tons"],

  // Electrical & power
  [/\b(\d+(?:\.\d+)?)\s*kV\b/gi, "$1 kilovolts"],
  [/\b(\d+(?:\.\d+)?)\s*mV\b/gi, "$1 millivolts"],
  [/\b(\d+(?:\.\d+)?)\s*V\b/gi, "$1 volts"],
  [/\b(\d+(?:\.\d+)?)\s*kW\b/gi, "$1 kilowatts"],
  [/\b(\d+(?:\.\d+)?)\s*MW\b/gi, "$1 megawatts"],
  [/\b(\d+(?:\.\d+)?)\s*GW\b/gi, "$1 gigawatts"],
  [/\b(\d+(?:\.\d+)?)\s*W\b/gi, "$1 watts"],
  [/\b(\d+(?:\.\d+)?)\s*mA\b/gi, "$1 milliamps"],
  [/\b(\d+(?:\.\d+)?)\s*A\b/gi, "$1 amps"],
  [/\b(\d+(?:\.\d+)?)\s*hp\b/gi, "$1 horsepower"],
  [/\b(\d+(?:\.\d+)?)\s*rpm\b/gi, "$1 revolutions per minute"],

  // Frequencies
  [/\b(\d+(?:\.\d+)?)\s*GHz\b/gi, "$1 gigahertz"],
  [/\b(\d+(?:\.\d+)?)\s*MHz\b/gi, "$1 megahertz"],
  [/\b(\d+(?:\.\d+)?)\s*kHz\b/gi, "$1 kilohertz"],
  [/\b(\d+(?:\.\d+)?)\s*Hz\b/gi, "$1 hertz"],

  // Temperature & percentages
  [/\b(\d+(?:\.\d+)?)\s*°C\b/gi, "$1 degrees Celsius"],
  [/\b(\d+(?:\.\d+)?)\s*°F\b/gi, "$1 degrees Fahrenheit"],
  [/\b(\d+(?:\.\d+)?)\s*%/g, "$1 percent"],
];

// Common abbreviations to expand into clear spoken English
const ABBREVIATION_REPLACEMENTS: [RegExp, string][] = [
  [/\be\.g\.,?\s*/gi, "for example, "],
  [/\bi\.e\.,?\s*/gi, "that is, "],
  [/\bvs\b\.?/gi, "versus"],
  [/\bapprox\b\.?/gi, "approximately"],
  [/\betc\b\.?/gi, "and so on"],
  [/\b(\d+(?:\.\d+)?)\s*min\b/gi, "$1 minutes"],
  [/\b(\d+(?:\.\d+)?)\s*sec\b/gi, "$1 seconds"],
  [/\bdept\b\.?/gi, "department"],
  [/\bno\.\s*(\d+)/gi, "number $1"],
];

// Technical shorthand and symbols
const SYMBOL_REPLACEMENTS: [RegExp, string][] = [
  [/-->|->|→/g, ", which leads to, "],
  [/==>|=>|⇒/g, ", producing, "],
  [/<--|<-|←/g, ", derived from, "],
  [/\s*\+\s*/g, " plus "],
  [/\s*=\s*/g, " equals "],
  [/\s*&\s*/g, " and "],
  // Mathematical and ML symbols
  [/x₁/g, "x 1"],
  [/x₂/g, "x 2"],
  [/x₃/g, "x 3"],
  [/h₁/g, "h 1"],
  [/h₂/g, "h 2"],
  [/h₃/g, "h 3"],
  [/h₄/g, "h 4"],
  [/ŷ/g, "y-hat"],
  [/W₁/g, "W 1"],
  [/W₂/g, "W 2"],
  [/ΔW|Δw/g, "delta W"],
  [/\bσ\b|σ/g, "sigma"],
  [/\bη\b|η/g, "eta"],
  [/½/g, "one-half"],
  [/∂L\s*\/\s*∂W/gi, "the gradient of loss with respect to W"],
];

// Explicit readings avoid asking a voice engine to guess engineering names.
// Only known initialisms are spelled out: ordinary uppercase words stay words.
const TECHNICAL_READINGS: Record<string, string> = {
  "next.js": "Next J S", nextjs: "Next J S", "node.js": "Node J S", nodejs: "Node J S",
  "vue.js": "Vue J S", "nuxt.js": "Nuxt J S", "express.js": "Express J S",
  javascript: "Java Script", typescript: "Type Script", github: "Git Hub", gitlab: "Git Lab",
  postgresql: "Postgres S Q L", mysql: "My S Q L", sqlite: "S Q L lite", mongodb: "Mongo D B",
  graphql: "Graph Q L", fastapi: "Fast A P I", openai: "Open A I", groq: "Grock",
  n8n: "N eight N", k8s: "Kubernetes", oauth: "O Auth", oauth2: "O Auth two",
  json: "jay son", yaml: "yam ul", nginx: "engine X", kubectl: "kube control",
  rest: "rest", rag: "rag", crud: "crud",
  readme: "read me", dockerfile: "Docker file", websocket: "Web Socket", websockets: "Web Sockets",
};
const INITIALISMS = "API APIs HTTP HTTPS SDK SDKs CLI UI UX URL URLs URI URIs SQL AWS GCP EC2 S3 RDS IAM VPC CDN DNS TCP UDP TLS SSL SSH RPC gRPC JWT HTML CSS JS TS JSX TSX npm npx pnpm LLM LLMs AI ML MCP CPU CPUs GPU GPUs CI CD ORM XML CSV PDF CORS IAC SSR SSG SSE IO IOPS".split(" ");
for (const name of INITIALISMS) {
  const letters = name.replace(/s$/, "").toUpperCase().split("").join(" ");
  TECHNICAL_READINGS[name.toLowerCase()] = letters + (name.endsWith("s") ? "'s" : "");
}
const technicalPattern = new RegExp(`\\b(?:${Object.keys(TECHNICAL_READINGS)
  .sort((a, b) => b.length - a.length).map(word => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`, "gi");

/**
 * Formats a raw narration string with natural breath pauses,
 * expanded abbreviations, and phonetic spacing.
 */
export function formatNarrationForSpeech(text: string): string {
  if (!text) return "";

  let formatted = shortenNarrationReferences(text)
    .replace(/```[^\n]*\n([\s\S]*?)```/g, "$1")
    .replace(/!?\[([^\]]+)\]\([^\s)]+\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_, bold, underline) => bold ?? underline)
    .replace(/^\s*(?:#{1,6}\s+|[-*•]\s+|\d+\.\s+)/gm, "")
    .replace(/\r?\n+/g, ". ")
    .replace(/\bhttps?:\/\//gi, "")
    .replace(/\b([\w-]+)\.(com|org|net|io|dev)(?=\b)/gi, "$1 dot $2")
    .replace(/\b([\w-]+)\.(json|ya?ml|tsx?|jsx?|py|md|tf|toml|txt)\b/gi,
      (full, name, extension) => TECHNICAL_READINGS[full.toLowerCase()] ?? `${name} dot ${extension}`)
    .replace(/\bC\+\+/g, "C plus plus")
    .replace(/\bC#/g, "C sharp");

  // Expand units before initialisms: "2 APIs" must never become "2 amps P Is".
  for (const [pattern, replacement] of UNIT_REPLACEMENTS) {
    formatted = formatted.replace(pattern, replacement);
  }

  // Resolve dotted product names before splitting code identifiers.
  formatted = formatted.replace(technicalPattern, word => TECHNICAL_READINGS[word.toLowerCase()]);
  formatted = formatted.replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
    .replace(/([\p{L}\d])_+(?=[\p{L}\d])/gu, "$1 ");
  formatted = formatted.replace(technicalPattern, word => TECHNICAL_READINGS[word.toLowerCase()]);

  // 2. Expand common Latin and written abbreviations
  for (const [pattern, replacement] of ABBREVIATION_REPLACEMENTS) {
    formatted = formatted.replace(pattern, replacement);
  }

  // 3. Expand symbols
  for (const [pattern, replacement] of SYMBOL_REPLACEMENTS) {
    formatted = formatted.replace(pattern, replacement);
  }
  formatted = formatted.replace(/\s*[/\\]\s*/g, " slash ");

  // 4. Space out hyphenated alphanumeric model/part numbers (e.g. WAG-12B -> WAG 12 B)
  // so TTS engines pronounce each code character clearly rather than trying to read it as a single mangled word.
  formatted = formatted.replace(/\b([A-Z]{2,})-([0-9]+)([A-Z]?)\b/g, "$1 $2 $3");

  // 5. Punctuation and Natural Cadence Pauses:
  // Colons and semicolons should introduce a distinct natural breath pause
  formatted = formatted.replace(/;\s*/g, ", ");
  formatted = formatted.replace(/:\s*/g, ", ");

  // Em dashes and double dashes -> clean comma pause
  formatted = formatted.replace(/\s*—\s*/g, ", ");
  formatted = formatted.replace(/\s*--\s*/g, ", ");

  // Clean up parentheticals so they flow like spoken side-notes
  formatted = formatted.replace(/\s*\(([^)]+)\)/g, ", $1, ");

  // Break up long clauses at key transition words with a slight comma pause if not already punctuated
  formatted = formatted.replace(/([^\s,;:.!?])\s+(which|whereas|causing|allowing|thereby)\s+/gi, "$1, $2 ");

  // Deduplicate redundant commas and clean up spacing
  formatted = formatted.replace(/\s+,/g, ",");
  formatted = formatted.replace(/,\s*,+/g, ", ");
  formatted = formatted.replace(/,\s*([.!?])/g, "$1");
  formatted = formatted.replace(/([.!?])\s*\.+/g, "$1");
  formatted = formatted.replace(/\s{2,}/g, " ").trim();

  // Ensure clean terminal punctuation so the voice doesn't clip the final syllable
  if (!/[.!?]$/.test(formatted)) {
    formatted += ".";
  }

  return formatted;
}

export type SpeechChunk = { text: string; start: number };

/** Keep utterances short, preserving offsets into the formatted narration. */
export function splitSpeechForPlayback(text: string): SpeechChunk[] {
  const chunks: SpeechChunk[] = [];
  let start = 0;
  while (start < text.length) {
    while (/\s/.test(text[start] ?? "") && start < text.length) start++;
    if (start >= text.length) break;
    const remaining = text.slice(start);
    const sentence = /[.!?][”"']?(?=\s|$)/.exec(remaining);
    let end = sentence ? sentence.index + sentence[0].length : remaining.length;
    if (end > 240) {
      const prefix = remaining.slice(0, 240);
      const clause = [...prefix.matchAll(/[,;:]\s/g)].at(-1);
      const space = prefix.lastIndexOf(" ");
      end = clause && clause.index >= 80 ? clause.index + 1 : space > 0 ? space : end;
    }
    chunks.push({ text: remaining.slice(0, end), start });
    start += end;
  }
  return chunks;
}
