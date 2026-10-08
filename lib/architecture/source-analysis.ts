import ts from "typescript";
import { parser as pythonParser } from "@lezer/python";
import { parser as cppParser } from "@lezer/cpp";
import { parser as javaParser } from "@lezer/java";
import { parser as goParser } from "@lezer/go";
import { parser as rustParser } from "@lezer/rust";
import { redactSecrets } from "./blueprints";
import type { Evidence, SourceDefinition, SourceParser } from "./types";

export type SourceFocusRange = { startLine: number; endLine?: number };
export type SourceAnalysis = { evidence: Evidence[]; imports: string[]; symbols: string[]; definitions: SourceDefinition[]; analysisComplete: boolean; language: string; parser: SourceParser };
const MAX_BYTES = 512000;
const MAX_SNIPPETS = 20;
const MAX_SNIPPET = 1800;
const MAX_METADATA = 1000;
const MAX_VISITED = 100000;
const ignoredDirectory = /(?:^|\/)(?:node_modules|bower_components|vendor|third[_-]?party|\.git|\.svn|\.hg|\.ssh|\.aws|\.azure|\.gcloud|\.npm|\.cache|\.next|\.nuxt|\.output|dist|build|coverage|\.terraform|venv|\.venv|env|__pycache__|target|generated|__generated__|__snapshots__|\.idea|\.vscode)(?:\/|$)/i;
const languages: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  py: "python", pyi: "python", go: "go", rs: "rust", java: "java", kt: "kotlin", kts: "kotlin", cs: "csharp", c: "c", h: "c", cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp", hxx: "cpp",
  rb: "ruby", php: "php", swift: "swift", scala: "scala", sc: "scala", sh: "shell", bash: "shell", zsh: "shell", ps1: "powershell", sql: "sql", r: "r", lua: "lua", ex: "elixir", exs: "elixir", erl: "erlang", hrl: "erlang", clj: "clojure", cljs: "clojure", cljc: "clojure",
  vue: "vue", svelte: "svelte", astro: "astro", html: "html", css: "css", scss: "scss",
};

/** Shared exclusions for tree records and pinned source/document reads. */
export function isSafeRepositoryPath(path: string): boolean {
  if (!path || path.length > 2048 || /[\\:\u0000-\u001f]/.test(path) || path.startsWith("/") || path.split("/").some(part => !part || part === "." || part === "..")) return false;
  if (ignoredDirectory.test(path) || /(?:^|[./_-])(?:\.env[^/]*|secrets?|credentials?|private[_-]?keys?|id_rsa|id_ed25519)(?:[./_-]|$)/i.test(path) || /(?:^|\/)\.env(?:[./_-]|$)/i.test(path)) return false;
  const name = path.split("/").pop()!;
  if (/(?:\.min\.|\.bundle\.|\.generated\.|\.g\.cs$|\.designer\.cs$|\.d\.(?:ts|mts|cts)$|\.pb\.|_pb2(?:_grpc)?\.py$|(?:^|[._-])generated[._-]|\.(?:pem|key|p12|pfx|keystore|tfstate)(?:\.|$))/i.test(name)) return false;
  return true;
}

/** Repository paths only. A language suffix never overrides a sensitive/generated path. */
export function classifySource(path: string): string | null {
  if (!isSafeRepositoryPath(path)) return null;
  const name = path.split("/").pop()!;
  return languages[name.split(".").pop()!.toLowerCase()] ?? null;
}

type Candidate = { from: number; to: number; score: number; category: string };
type Span = { from: number; to: number };

function lineOffsets(text: string): number[] {
  const offsets = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) offsets.push(i + 1);
  return offsets;
}

function lineAt(offsets: number[], position: number): number {
  let low = 0, high = offsets.length;
  while (low + 1 < high) { const middle = (low + high) >>> 1; if (offsets[middle] <= position) low = middle; else high = middle; }
  return low;
}

function spanFor(candidate: Candidate, text: string, offsets: number[]): Span {
  if (candidate.category === "line") return { from: candidate.from, to: Math.min(candidate.to, candidate.from + MAX_SNIPPET) };
  const firstLine = lineAt(offsets, candidate.from);
  const lineStart = offsets[firstLine];
  const contextStart = offsets[Math.max(0, firstLine - (["call", "return", "focus"].includes(candidate.category) ? 2 : 0))];
  // Long preceding comments must never consume the entire window before the
  // matched function/call begins. Spend the budget on the relevant implementation.
  const from = lineStart - contextStart <= 200 ? contextStart : lineStart;
  let to = Math.min(text.length, Math.max(candidate.to, from + 500), from + MAX_SNIPPET);
  // End on a complete line when possible. Single long lines remain bounded.
  const lastBreak = text.lastIndexOf("\n", to - 1);
  if (to < text.length && lastBreak >= from + 300) to = lastBreak;
  if (to > from && /[\uD800-\uDBFF]/.test(text[to - 1])) to--;
  return { from, to };
}

function safeTokenExpression(name: string, expression: string): boolean {
  const canonical = name.replace(/([a-z\d])([A-Z])/g, "$1_$2").toLowerCase();
  if (!/(?:^|[._])(?:tokens?|tokenizer)(?:[._]|$)/.test(canonical) || /auth|api|access|refresh|session|bearer|jwt|csrf|xsrf|secret|password|credential|private[_-]?key/.test(canonical)) return false;
  const value = expression.trim();
  // A scalar/string token can be a credential. Numeric model IDs/counts have
  // explicit names; token arrays and computed values are code, not secret values.
  if (/^["'`]/.test(value)) return false;
  if (/^[+-]?\d/.test(value)) return /(?:token_ids?|tokens?_(?:id|count|length|index)|(?:num|n|max|min|total|bos|eos|pad|mask)(?:_\w+)?_tokens?(?:_id)?)$/.test(canonical);
  if (/["'`]/.test(value)) return /^(?:[\w.]*tokeniz[\w.]*|encode|decode|tokenize|(?:jnp|np|torch)\.(?:array|asarray|tensor))\s*\(/i.test(value);
  return /[\[\]().+*/-]/.test(value) || /^(?:None|True|False|null|true|false|int|float|bool|str|Array|Tensor)\b/.test(value)
    || /^(?:[a-z_]*tokens?[a-z_]*|input_ids|logits|vocab[a-z_]*|sequence[a-z_]*|batch[a-z_]*|samples?)\b/i.test(value);
}

function maskedSource(text: string, isCodePosition?: (position: number) => boolean): string {
  // Mask before slicing, so a snippet beginning midway through a PEM block or
  // a long secret assignment cannot accidentally expose the value's tail.
  let masked = text.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, block => block.replace(/[^\r\n]/g, " "));
  const sensitiveName = /password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential/i;
  const assignments = /(?<![\w$.-])["']?([a-zA-Z_$][\w$.-]*)["']?\s*[:=]\s*("""|'''|`)/g;
  const spans: Span[] = [];
  for (const match of masked.matchAll(assignments)) {
    if (!sensitiveName.test(match[1])) continue;
    const start = match.index! + match[0].length, delimiter = match[2];
    let end = masked.indexOf(delimiter, start);
    while (end >= 0 && delimiter === "`" && masked[end - 1] === "\\") end = masked.indexOf(delimiter, end + 1);
    spans.push({ from: match.index!, to: end < 0 ? masked.length : end + delimiter.length });
  }
  for (const span of spans.reverse()) masked = masked.slice(0, span.from) + masked.slice(span.from, span.to).replace(/[^\r\n]/g, " ") + masked.slice(span.to);
  const trigger = /password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential|gh[pousr]_|github_pat_|AKIA|sk-|gsk_|:\/\//i;
  return masked.replace(/[^\r\n]+/g, (line, lineOffset: number) => {
    if (!trigger.test(line)) return line;
    // Legacy URL redaction has a variable-width prefix. Never run it against
    // an adversarial long line; mask the whole sensitive line instead.
    const namedAssignment = /(?<![\w$.-])(["']?)([a-zA-Z_$][\w$.-]*)\1\s*([:=])\s*/g;
    // Hide only safe model-token variable names from the generic secret-key
    // detector, then restore the untouched original line after redaction checks.
    // Literal auth/API/access/refresh tokens are never eligible for this path.
    let checked = line;
    if (line.length <= MAX_SNIPPET) {
      const safeNames = [...line.matchAll(namedAssignment)].filter(match => isCodePosition?.(lineOffset + match.index! + match[0].lastIndexOf(match[3]))
        && !/(?:\/\/|#|\/\*)/.test(line.slice(0, match.index)) && safeTokenExpression(match[2], line.slice(match.index! + match[0].length)));
      for (const match of safeNames.reverse()) {
        const offset = match.index! + match[1].length;
        checked = checked.slice(0, offset) + "m".repeat(match[2].length) + checked.slice(offset + match[2].length);
      }
    }
    const sensitive = [...checked.matchAll(namedAssignment)].some(match => sensitiveName.test(match[2]));
    if (line.length <= MAX_SNIPPET && !sensitive && redactSecrets(checked) === checked) return line;
    return line.length >= 10 ? "[REDACTED]".padEnd(line.length, " ") : " ".repeat(line.length);
  });
}

function requestedLineRanges(path: string, question: string, ranges: readonly SourceFocusRange[]): SourceFocusRange[] {
  const requested = [...ranges];
  const escaped = [path, path.split("/").pop()!].map(value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  for (const match of question.matchAll(new RegExp("(?:" + escaped + ")(?:[:#]L?)(\\d+)(?:\\s*(?:-|–|to)\\s*L?(\\d+))?", "gi"))) requested.push({ startLine: Number(match[1]), endLine: Number(match[2] ?? match[1]) });
  const namedFiles = question.match(/\b[\w./-]+\.(?:[cm]?[jt]sx?|py|cpp|cc|cxx|h|hpp|c|java|go|rs|rb|php|cs)\b/gi) ?? [];
  if (!namedFiles.length || namedFiles.some(file => file.toLowerCase() === path.toLowerCase() || file.toLowerCase() === path.split("/").pop()!.toLowerCase())) {
    for (const match of question.matchAll(/\b(?:lines?\s+|L)(\d+)(?:\s*(?:-|–|to)\s*L?(\d+))?\b/gi)) requested.push({ startLine: Number(match[1]), endLine: Number(match[2] ?? match[1]) });
  }
  return requested.filter(range => Number.isSafeInteger(range.startLine) && range.startLine >= 1 && Number.isSafeInteger(range.endLine ?? range.startLine) && (range.endLine ?? range.startLine) >= range.startLine).slice(0, 12);
}

function snippets(path: string, text: string, candidates: Candidate[], question = "", isCodePosition?: (position: number) => boolean, focusRanges: readonly SourceFocusRange[] = []): Evidence[] {
  const offsets = lineOffsets(text);
  const safeText = maskedSource(text, isCodePosition);
  const lineCandidates: Candidate[] = [];
  for (const range of requestedLineRanges(path, question, focusRanges)) {
    if (range.startLine > offsets.length) continue;
    const requestedEnd = offsets[Math.min(range.endLine ?? range.startLine, offsets.length)] ?? text.length;
    for (let from = offsets[range.startLine - 1]; from < requestedEnd && lineCandidates.length < MAX_SNIPPETS; ) {
      let to = Math.min(requestedEnd, from + MAX_SNIPPET);
      const newline = text.lastIndexOf("\n", to - 1);
      if (to < requestedEnd && newline > from + 300) to = newline + 1;
      if (to > from && /[\uD800-\uDBFF]/.test(text[to - 1])) to--;
      lineCandidates.push({ from, to, score: 1000, category: "line" }); from = to;
    }
  }
  candidates.push(...lineCandidates);
  const stopWords = new Set(["the", "and", "how", "what", "why", "explain", "does", "this", "that", "from", "with", "function", "file", "code", "source", "where", "which", "into", "about"]);
  const terms = [...new Set(question.toLowerCase().match(/[a-z_$][a-z0-9_$.-]{2,}/g) ?? [])].filter(term => !stopWords.has(term) && term.length <= 80).slice(0, 12);
  if (terms.length) for (let line = 0; line < offsets.length && candidates.length < 2100; line++) {
    const from = offsets[line], to = line + 1 < offsets.length ? offsets[line + 1] : text.length;
    const content = safeText.slice(from, to).toLowerCase();
    const score = terms.filter(term => new RegExp("(?<![a-z0-9_$])" + term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?![a-z0-9_$])").test(content)).length;
    if (score) candidates.push({ from, to, score: 20 + score, category: "focus" });
  }
  const ordered = candidates.sort((a, b) => b.score - a.score || a.from - b.from);
  const selected: Span[] = [];
  const admit = (candidate: Candidate) => {
    if (selected.length >= MAX_SNIPPETS) return;
    const span = spanFor(candidate, text, offsets);
    if (span.to <= span.from) return;
    const overlap = selected.find(other => Math.max(0, Math.min(span.to, other.to) - Math.max(span.from, other.from)) > 0.7 * Math.min(span.to - span.from, other.to - other.from));
    if (overlap) {
      const from = Math.min(span.from, overlap.from), to = Math.max(span.to, overlap.to);
      // A short function window must not suppress its adjacent initialization
      // or call just because the larger useful window also contains the function.
      if (to - from <= MAX_SNIPPET) { overlap.from = from; overlap.to = to; }
      return;
    }
    selected.push(span);
  };
  // Explicit file/line requests get their region before any generic overview.
  for (const candidate of lineCandidates) admit(candidate);
  // Reserve workflow, return and import context before many similar calls consume the cap.
  for (const category of ["focus", "route", "function", "return", "call", "import", "class"]) {
    const candidate = ordered.find(item => item.category === category); if (candidate) admit(candidate);
  }
  for (const candidate of ordered) admit(candidate);
  const requested = (span: Span) => lineCandidates.some(item => item.from < span.to && item.to > span.from) ? 1 : 0;
  return selected.sort((a, b) => requested(b) - requested(a) || a.from - b.from).flatMap((span, i) => {
    const original = safeText.slice(span.from, span.to).trimEnd();
    // maskedSource already ran the source-aware secret checks before slicing.
    // A second generic pass here would erase safe ML token calculations again.
    const redacted = original;
    if (!redacted.trim()) return [];
    return [{ id: "source_" + i, path, kind: "source" as const, startLine: lineAt(offsets, span.from) + 1, endLine: lineAt(offsets, span.from + original.length - 1) + 1, text: redacted }];
  });
}

function addMetadata(values: Set<string>, value: string): boolean {
  const clean = value.trim();
  if (!clean || clean.length > 200 || /[\r\n\u0000]/.test(clean) || redactSecrets(clean) !== clean) return true;
  if (values.has(clean)) return true;
  if (values.size >= MAX_METADATA) return false;
  values.add(clean); return true;
}

function definitionCollector(text: string) {
  const definitions: SourceDefinition[] = [];
  const offsets = lineOffsets(text);
  let complete = true;
  const priorities = { class: 4, interface: 4, type: 3, function: 3, method: 3, variable: 1 };
  const add = (name: string, kind: SourceDefinition["kind"], from: number, to: number) => {
    if (!name || name.length > 200 || /[\r\n\u0000]/.test(name) || redactSecrets(name) !== name) return;
    const entry = { name, kind, startLine: lineAt(offsets, from) + 1, endLine: lineAt(offsets, Math.max(from, to - 1)) + 1 };
    if (definitions.some(item => item.name === name && item.kind === kind && item.startLine === entry.startLine)) return;
    if (definitions.length < MAX_METADATA) definitions.push(entry);
    else {
      complete = false;
      const lowerPriority = definitions.findIndex(item => priorities[item.kind] < priorities[kind]);
      if (lowerPriority >= 0) definitions[lowerPriority] = entry;
    }
  };
  return { definitions, add, complete: () => complete };
}

function textCandidates(text: string): Candidate[] {
  const candidates: Candidate[] = [];
  let position = 0;
  for (const line of text.split("\n")) {
    const workflow = /\b(?:return|yield|await|async|route|router|handle|request|response|fetch|query|publish|consume|invoke|forward|train|predict|generate)\b/i.test(line);
    const declaration = /\b(?:function|def|func|fn|class|interface|import|require|include|using|package|export)\b/.test(line);
    if (workflow || declaration) candidates.push({ from: position, to: position + line.length, score: workflow ? 8 : 4, category: workflow ? "call" : "text" });
    position += line.length + 1;
    if (candidates.length >= 2000) break;
  }
  // Other languages retain bounded exact source context, not a claimed AST analysis.
  if (!candidates.length) for (let from = 0; from < text.length && candidates.length < MAX_SNIPPETS; from += 1400) candidates.push({ from, to: Math.min(text.length, from + 1400), score: 1, category: "text" });
  return candidates;
}

function typescriptAnalysis(path: string, text: string, language: string, question: string, focusRanges: readonly SourceFocusRange[]): SourceAnalysis {
  const extension = path.split(".").pop()!.toLowerCase();
  const kind = extension === "tsx" ? ts.ScriptKind.TSX : extension === "jsx" ? ts.ScriptKind.JSX : language === "javascript" ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  // Parse the supplied string only: no Program, compiler host, module resolution, emit or execution.
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, false, kind);
  // Source-only ML exceptions must not apply to credentials written inside
  // comments, docstrings or template literals that merely resemble assignments.
  const blocked: Span[] = [];
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, kind === ts.ScriptKind.TSX || kind === ts.ScriptKind.JSX ? ts.LanguageVariant.JSX : ts.LanguageVariant.Standard, text);
  const literalKinds = new Set([ts.SyntaxKind.SingleLineCommentTrivia, ts.SyntaxKind.MultiLineCommentTrivia, ts.SyntaxKind.StringLiteral, ts.SyntaxKind.NoSubstitutionTemplateLiteral, ts.SyntaxKind.TemplateHead, ts.SyntaxKind.TemplateMiddle, ts.SyntaxKind.TemplateTail]);
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) if (literalKinds.has(token)) blocked.push({ from: scanner.getTokenPos(), to: scanner.getTextPos() });
  const isCodePosition = (position: number) => {
    let low = 0, high = blocked.length;
    while (low < high) { const mid = (low + high) >>> 1; if (blocked[mid].to <= position) low = mid + 1; else high = mid; }
    return !blocked[low] || position < blocked[low].from;
  };
  const candidates: Candidate[] = [];
  const imports = new Set<string>(), symbols = new Set<string>();
  const definitions = definitionCollector(text);
  let metadataComplete = true;
  const imported = (value: string) => { if (!addMetadata(imports, value)) metadataComplete = false; };
  const symbol = (value: string) => { if (!addMetadata(symbols, value)) metadataComplete = false; };
  const define = (node: ts.Node, name: string, kind: SourceDefinition["kind"]) => { symbol(name); definitions.add(name, kind, node.getStart(file), node.end); };
  const add = (node: ts.Node, score: number, category: string) => { if (candidates.length < 2000) candidates.push({ from: node.getStart(file), to: node.end, score, category }); };
  const pending: ts.Node[] = [file];
  let visited = 0;
  while (pending.length && visited++ < MAX_VISITED) {
    const node = pending.pop()!;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) imported(node.moduleSpecifier.text);
      add(node, 5, "import");
    } else if (ts.isImportEqualsDeclaration(node)) {
      if (ts.isExternalModuleReference(node.moduleReference) && node.moduleReference.expression && ts.isStringLiteralLike(node.moduleReference.expression)) imported(node.moduleReference.expression.text);
      add(node, 5, "import");
    } else if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isClassDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
      if (node.name) define(node, node.name.getText(file), ts.isClassDeclaration(node) ? "class" : ts.isFunctionDeclaration(node) ? "function" : "method");
      add(node, ts.isClassDeclaration(node) ? 5 : 8, ts.isClassDeclaration(node) ? "class" : "function");
    } else if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node)) {
      define(node, node.name.getText(file), ts.isInterfaceDeclaration(node) ? "interface" : "type"); add(node, 5, "class");
    } else if (ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)) {
      const callable = node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer));
      const classValue = node.initializer && ts.isClassExpression(node.initializer);
      if (ts.isIdentifier(node.name) || ts.isPrivateIdentifier(node.name)) define(node, node.name.getText(file), callable ? ts.isPropertyDeclaration(node) ? "method" : "function" : classValue ? "class" : "variable");
      if (callable || classValue) add(node, 8, classValue ? "class" : "function");
    } else if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const callee = node.expression.getText(file);
      if (/^[\w$?.]+$/.test(callee)) symbol(callee);
      if ((callee === "require" || node.expression.kind === ts.SyntaxKind.ImportKeyword) && node.arguments?.[0] && ts.isStringLiteralLike(node.arguments[0])) imported(node.arguments[0].text);
      const route = /(?:^|\.)(?:get|post|put|patch|delete|use|route|register|addRoute)$/.test(callee) && node.arguments?.[0] && ts.isStringLiteralLike(node.arguments[0]);
      add(node, route ? 11 : 9, route ? "route" : "call");
    } else if (ts.isReturnStatement(node) || ts.isYieldExpression(node)) add(node, 10, "return");
    else if (ts.isIfStatement(node) || ts.isAwaitExpression(node) || ts.isDecorator(node)) add(node, 7, "control");
    const children: ts.Node[] = [];
    ts.forEachChild(node, child => { children.push(child); });
    for (let i = children.length - 1; i >= 0; i--) pending.push(children[i]);
  }
  const syntaxErrors = (file as ts.SourceFile & { parseDiagnostics?: readonly unknown[] }).parseDiagnostics?.length ?? 0;
  return { evidence: snippets(path, text, candidates.length ? candidates : textCandidates(text), question, isCodePosition, focusRanges), imports: [...imports], symbols: [...symbols], definitions: definitions.definitions, analysisComplete: !pending.length && metadataComplete && definitions.complete() && !syntaxErrors, language, parser: "typescript-ast" };
}

function pythonAnalysis(path: string, text: string, question: string, focusRanges: readonly SourceFocusRange[]): SourceAnalysis {
  const tree = pythonParser.parse(text);
  const isCodePosition = (position: number) => {
    let node: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(position, 1);
    for (; node; node = node.parent) if (/Comment|String/.test(node.name)) return false;
    return true;
  };
  const cursor = tree.cursor();
  const candidates: Candidate[] = [];
  const imports = new Set<string>(), symbols = new Set<string>();
  const definitions = definitionCollector(text);
  let metadataComplete = true, syntaxError = false;
  const imported = (value: string) => { if (!addMetadata(imports, value)) metadataComplete = false; };
  const symbol = (value: string) => { if (!addMetadata(symbols, value)) metadataComplete = false; };
  let visited = 0;
  do {
    if (++visited > MAX_VISITED) break;
    if (cursor.type.isError) syntaxError = true;
    const name = cursor.name;
    const content = text.slice(cursor.from, cursor.to);
    let score = 0, category = "";
    if (name === "FunctionDefinition" || name === "ClassDefinition") {
      const identifier = cursor.node.getChild("VariableName");
      if (identifier) {
        const value = text.slice(identifier.from, identifier.to); symbol(value);
        let kind: SourceDefinition["kind"] = name === "ClassDefinition" ? "class" : "function";
        if (kind === "function") for (let parent = cursor.node.parent; parent; parent = parent.parent) {
          if (parent.name === "FunctionDefinition") break;
          if (parent.name === "ClassDefinition") { kind = "method"; break; }
        }
        definitions.add(value, kind, cursor.from, cursor.to);
      }
      score = name === "FunctionDefinition" ? 8 : 5; category = name === "FunctionDefinition" ? "function" : "class";
    } else if (name === "DecoratedStatement") { score = 11; category = "route"; }
    else if (name === "ReturnStatement" || name === "YieldStatement") { score = 10; category = "return"; }
    else if (name === "CallExpression") {
      const callee = cursor.node.firstChild;
      if (callee) { const value = text.slice(callee.from, callee.to); if (/^[\w.]+$/.test(value)) symbol(value); }
      score = 9; category = "call";
    } else if (name === "ImportStatement") {
      const statement = content.replace(/\\\r?\n/g, " ").replace(/\s+/g, " ");
      const from = statement.match(/^from\s+([.\w]+)\s+import\s+([\s\S]+)$/);
      if (from) {
        imported(from[1]);
        if (from[1].startsWith(".")) for (const member of from[2].replace(/[()]/g, "").split(",")) {
          const identifier = member.trim().split(/\s+/)[0]; if (/^\w+$/.test(identifier)) imported(from[1] + (from[1].endsWith(".") ? "" : ".") + identifier);
        }
      } else for (const member of statement.replace(/^import\s+/, "").split(",")) { const identifier = member.trim().split(/\s+/)[0]; if (/^[\w.]+$/.test(identifier)) imported(identifier); }
      score = 5; category = "import";
    } else if (name === "AssignStatement") {
      const identifier = cursor.node.firstChild;
      if (identifier?.name === "VariableName") { const value = text.slice(identifier.from, identifier.to); symbol(value); definitions.add(value, "variable", cursor.from, cursor.to); }
    } else if (name === "IfStatement" || name === "ForStatement" || name === "WithStatement") { score = 7; category = "control"; }
    if (score && candidates.length < 2000) candidates.push({ from: cursor.from, to: cursor.to, score, category });
  } while (cursor.next());
  return { evidence: snippets(path, text, candidates.length ? candidates : textCandidates(text), question, isCodePosition, focusRanges), imports: [...imports], symbols: [...symbols], definitions: definitions.definitions, analysisComplete: visited <= MAX_VISITED && metadataComplete && definitions.complete() && !syntaxError, language: "python", parser: "python-cst" };
}

type ConcreteNode = ReturnType<typeof pythonParser.parse>["topNode"];

function hasAncestor(node: ConcreteNode, names: readonly string[], stop: readonly string[] = []): boolean {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (names.includes(parent.name)) return true;
    if (stop.includes(parent.name)) return false;
  }
  return false;
}

function concreteAnalysis(path: string, text: string, language: string, question: string, focusRanges: readonly SourceFocusRange[]): SourceAnalysis {
  const grammars = { c: cppParser, cpp: cppParser, java: javaParser, go: goParser, rust: rustParser };
  const grammar = grammars[language as keyof typeof grammars];
  const tree = grammar.parse(text), cursor = tree.cursor();
  const candidates: Candidate[] = [];
  const imports = new Set<string>(), symbols = new Set<string>();
  const definitions = definitionCollector(text);
  let metadataComplete = true, syntaxError = false, visited = 0;
  const imported = (value: string) => { if (!addMetadata(imports, value)) metadataComplete = false; };
  const symbol = (value: string) => { if (!addMetadata(symbols, value)) metadataComplete = false; };
  const content = (node: ConcreteNode | null | undefined) => node ? text.slice(node.from, node.to) : "";
  const define = (node: ConcreteNode, identifier: ConcreteNode | null | undefined, kind: SourceDefinition["kind"]) => {
    const name = content(identifier);
    if (name) { symbol(name); definitions.add(name, kind, node.from, node.to); }
    if (candidates.length < 2000) candidates.push({ from: node.from, to: node.to, score: kind === "function" || kind === "method" ? 8 : 5, category: kind === "function" || kind === "method" ? "function" : "class" });
  };
  do {
    if (++visited > MAX_VISITED) break;
    if (cursor.type.isError) syntaxError = true;
    const node = cursor.node, name = node.name;
    if (language === "c" || language === "cpp") {
      if (["ClassSpecifier", "StructSpecifier", "UnionSpecifier"].includes(name)) define(node, node.getChild("TypeIdentifier"), "class");
      else if (["EnumSpecifier", "AliasDeclaration"].includes(name)) define(node, node.getChild("TypeIdentifier"), "type");
      else if (name === "FunctionDefinition" || name === "FunctionDeclarator" && !hasAncestor(node, ["FunctionDefinition"])) {
        const declarator = name === "FunctionDeclarator" ? node : node.getChild("FunctionDeclarator");
        if (declarator) {
          const identifier = declarator.firstChild;
          if (identifier && /Identifier|DestructorName|OperatorName|Qualified/.test(identifier.name)) define(node, identifier, hasAncestor(node, ["ClassSpecifier", "StructSpecifier", "UnionSpecifier"]) ? "method" : "function");
        }
      } else if (name === "PreprocDirective") {
        const include = content(node).match(/^\s*#\s*include\s*[<"]([^>"\r\n]+)[>"]/); if (include) imported(include[1]);
      }
    } else if (language === "java") {
      if (["ClassDeclaration", "RecordDeclaration"].includes(name)) define(node, node.getChild("Definition"), "class");
      else if (["InterfaceDeclaration", "AnnotationTypeDeclaration"].includes(name)) define(node, node.getChild("Definition"), "interface");
      else if (name === "EnumDeclaration") define(node, node.getChild("Definition"), "type");
      else if (["MethodDeclaration", "ConstructorDeclaration"].includes(name)) define(node, node.getChild("Definition"), "method");
      else if (name === "VariableDeclarator") define(node, node.getChild("Definition"), "variable");
      else if (name === "ImportDeclaration") imported(content(node).replace(/^import\s+(?:static\s+)?/, "").replace(/;\s*$/, "").trim());
    } else if (language === "go") {
      if (name === "FunctionDecl") define(node, node.getChild("DefName"), "function");
      else if (name === "MethodDecl") define(node, node.getChild("FieldName"), "method");
      else if (name === "TypeSpec") define(node, node.getChild("DefName"), node.getChild("StructType") ? "class" : node.getChild("InterfaceType") ? "interface" : "type");
      else if (name === "VarSpec" || name === "ConstSpec") define(node, node.getChild("DefName"), "variable");
      else if (name === "ImportSpec") { const value = content(node.getChild("String")); if (value) imported(value.slice(1, -1)); }
    } else if (language === "rust") {
      if (name === "StructItem") define(node, node.getChild("TypeIdentifier"), "class");
      else if (name === "TraitItem") define(node, node.getChild("TypeIdentifier"), "interface");
      else if (["EnumItem", "TypeItem"].includes(name)) define(node, node.getChild("TypeIdentifier"), "type");
      else if (name === "FunctionItem") define(node, node.getChild("BoundIdentifier"), hasAncestor(node, ["ImplItem", "TraitItem"], ["FunctionItem"]) ? "method" : "function");
      else if (name === "LetDeclaration" || name === "ConstItem" || name === "StaticItem") define(node, node.getChild("BoundIdentifier"), "variable");
      else if (name === "UseDeclaration") imported(content(node).replace(/^(?:pub\s+)?use\s+/, "").replace(/;\s*$/, "").trim());
    }
    if (["CallExpression", "CallExpr", "MethodInvocation"].includes(name)) {
      const callee = content(node.getChild("MethodName") ?? node.firstChild);
      if (/^[\w.$:>-]+$/.test(callee)) symbol(callee);
      if (candidates.length < 2000) candidates.push({ from: node.from, to: node.to, score: 9, category: "call" });
    } else if (name === "ReturnStatement" || name === "ReturnExpression") {
      if (candidates.length < 2000) candidates.push({ from: node.from, to: node.to, score: 10, category: "return" });
    } else if (/^(?:Import|UseDeclaration|PreprocDirective)/.test(name)) {
      if (candidates.length < 2000) candidates.push({ from: node.from, to: node.to, score: 5, category: "import" });
    }
  } while (cursor.next());
  const parser: SourceParser = language === "c" || language === "cpp" ? "cpp-cst" : language === "java" ? "java-cst" : language === "go" ? "go-cst" : "rust-cst";
  const isCodePosition = (position: number) => {
    let node: ConcreteNode | null = tree.resolveInner(position, 1);
    for (; node; node = node.parent) if (/Comment|String|CharLiteral/.test(node.name)) return false;
    return true;
  };
  return { evidence: snippets(path, text, candidates.length ? candidates : textCandidates(text), question, isCodePosition, focusRanges), imports: [...imports], symbols: [...symbols], definitions: definitions.definitions,
    analysisComplete: visited <= MAX_VISITED && metadataComplete && definitions.complete() && !syntaxError, language, parser };
}

/** Bounded, static source inspection. It never loads modules or executes repository code. */
export function analyzeSource(path: string, text: string, question = "", focusRanges: readonly SourceFocusRange[] = []): SourceAnalysis {
  const language = classifySource(path);
  const empty: SourceAnalysis = { evidence: [], imports: [], symbols: [], definitions: [], analysisComplete: false, language: language ?? "unknown", parser: "text" };
  if (!language || !text.trim() || text.length > MAX_BYTES || Buffer.byteLength(text, "utf8") > MAX_BYTES || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) return empty;
  if (/(?:auto[- ]generated|automatically generated|generated code|code generated[\s\S]{0,100}do not edit)/i.test(text.slice(0, 1000))) return empty;
  try {
    if (language === "typescript" || language === "javascript") return typescriptAnalysis(path, text, language, question, focusRanges);
    if (language === "python") return pythonAnalysis(path, text, question, focusRanges);
    if (["c", "cpp", "java", "go", "rust"].includes(language)) return concreteAnalysis(path, text, language, question, focusRanges);
  } catch { /* Parse failures remain exact bounded text, not fabricated AST facts. */ }
  return { ...empty, evidence: snippets(path, text, textCandidates(text), question, undefined, focusRanges) };
}
