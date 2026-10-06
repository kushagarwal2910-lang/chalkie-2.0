import { parseAllDocuments, visit, YAMLMap, Pair, Scalar } from "yaml";
import { DockerfileParser } from "dockerfile-ast";
import hcl from "hcl2-parser";
import type { BlueprintKind, Evidence } from "./types.ts";

const ignoredDirectory = /(^|\/)(node_modules|vendor|\.git|\.next|dist|build|coverage|\.terraform|venv|\.venv|__pycache__|target|generated)(\/|$)/i;
const docName = /^(readme|architecture|agents|contributing|onboarding|design|deployment|infrastructure|operations|runbook)([._-][\w-]+)?\.(md|mdx|rst|txt)$/i;

/** Only these file classes are decompressed and parsed. Application source is never admitted. */
export function classifyBlueprint(path: string): BlueprintKind | null {
  if (ignoredDirectory.test(path) || /(^|\/)(\.env[^/]*|[^/]*\.tfstate(?:\..*)?|secrets?\.[^/]+)$/i.test(path)) return null;
  const name = path.split("/").pop() ?? "";
  if (/^(pnpm-lock\.yaml|yarn\.lock|package-lock\.json|composer\.lock|poetry\.lock|uv\.lock)$/i.test(name)) return null;
  if (/^(?:.+\.)?dockerfile(?:\.[\w-]+)?$/i.test(name)) return "docker";
  if (/^(?:docker-)?compose(?:[.-][\w.-]+)?\.ya?ml$/i.test(name)) return "compose";
  if (/\.tf(?:\.json)?$/i.test(name)) return "terraform";
  if (/^(package\.json|requirements(?:[._-][\w-]+)?\.txt|pyproject\.toml|go\.mod|cargo\.toml|pom\.xml|gemfile)$/i.test(name)) return "dependencies";
  if (docName.test(name) || /(^|\/)(architecture|adr|adrs|runbooks)\//i.test(path) && /\.md$/i.test(name)) return "documentation";
  if (/\.ya?ml$/i.test(name)) return "yaml";
  if (/^(?:.*(?:cloudformation|template|cfn).*)\.json$/i.test(name)) return "cloudformation";
  return null;
}

/** Redact values before storage, retrieval, logging, or model access. Keep variable names. */
export function redactSecrets(text: string): string {
  return text
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16}|sk-[A-Za-z0-9_-]{20,}|gsk_[A-Za-z0-9]{20,})\b/g, "[REDACTED]")
    .replace(/(\b(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credentials?)[\w-]*["']?\s*[:=]\s*)([^\r\n,}]+)/gi, "$1[REDACTED]")
    .replace(/(\w+:\/\/)[^\s/@]+:[^\s/@]+@/g, "$1[REDACTED]@");
}

function safeValue(value: unknown, key = "", depth = 0): unknown {
  if (depth > 9) return "[nested value]";
  if (/password|secret|token|api.?key|access.?key|private.?key|credential/i.test(key)) return "[REDACTED]";
  if (Array.isArray(value)) return value.slice(0, 50).map(v => safeValue(v, key, depth + 1));
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    // Kubernetes Secrets and CloudFormation NoEcho defaults must never reach the LLM.
    if (record.kind === "Secret") return { kind: "Secret", metadata: safeValue(record.metadata), data: "[REDACTED]" };
    if (record.NoEcho === true || record.sensitive === true) return { ...Object.fromEntries(Object.entries(record).filter(([k]) => !/default|value/i.test(k)).map(([k, v]) => [k, safeValue(v, k, depth + 1)])), value: "[REDACTED]" };
    if (typeof record.name === "string" && /password|secret|token|key|credential/i.test(record.name) && "value" in record) return { name: record.name, value: "[REDACTED]" };
    return Object.fromEntries(Object.entries(record).slice(0, 120).map(([k, v]) => [k, safeValue(v, k, depth + 1)]));
  }
  return typeof value === "string" ? redactSecrets(value).slice(0, 1800) : value;
}

export function parseBlueprint(path: string, raw: string): { kind: BlueprintKind; evidence: Omit<Evidence, "id">[]; warnings: string[] } {
  let kind = classifyBlueprint(path);
  if (!kind) throw new Error("File is outside the blueprint allowlist");
  const evidence: Omit<Evidence, "id">[] = [];
  const warnings: string[] = [];
  const lines = raw.split(/\r?\n/);
  const lineOf = (name: string) => Math.max(1, lines.findIndex(line => line.includes(name)) + 1);
  const add = (text: string, startLine = 1, endLine = startLine) => {
    if (text.trim()) evidence.push({ path, startLine, endLine, kind: kind!, text: redactSecrets(text).slice(0, 3500) });
  };
  const entry = (label: string, value: unknown, line = lineOf(label)) => add(label + ": " + JSON.stringify(safeValue(value)), line);
  try {
    if (kind === "documentation") {
      for (let start = 0; start < lines.length; start += 28) add(lines.slice(start, start + 28).join("\n"), start + 1, Math.min(lines.length, start + 28));
    } else if (kind === "docker") {
      const docker = DockerfileParser.parse(raw);
      for (const instruction of docker.getInstructions()) {
        // COPY/RUN commands are not followed or executed. ENV values are omitted.
        const command = instruction.getInstruction().toUpperCase();
        if (["FROM", "EXPOSE", "WORKDIR", "ENTRYPOINT", "CMD", "HEALTHCHECK", "ENV", "ARG"].includes(command)) {
          const args = ["ENV", "ARG"].includes(command) ? "configuration variable names: " + instruction.getArguments().map(arg => arg.getValue().split("=")[0]).filter((_, i) => i === 0).join(", ") : instruction.getArgumentsContent();
          add(command + " " + args, instruction.getRange().start.line + 1, instruction.getRange().end.line + 1);
        }
      }
    } else if (kind === "terraform") {
      const parsed = path.endsWith(".json") ? JSON.parse(raw) : hcl.parseToObject(raw);
      const config = Array.isArray(parsed) ? parsed[0] : parsed;
      if (!config || typeof config !== "object" || Array.isArray(parsed) && parsed[1]) throw new Error("Invalid HCL");
      for (const [block, values] of Object.entries(config as Record<string, unknown>)) {
        if (!["resource", "data", "module", "provider", "variable", "output", "locals", "terraform"].includes(block)) continue;
        for (const [name, value] of Object.entries((values ?? {}) as object)) entry(block + " " + name, value, lineOf(name));
      }
      if (/\b(?:var\.|module\.|terraform\.workspace)/.test(raw)) warnings.push(path + ": variable/module expressions describe declarations; unresolved deployment values remain unknown.");
    } else if (kind === "dependencies") {
      if (path.endsWith("package.json")) {
        const p = JSON.parse(raw);
        entry("package", { name: p.name, workspaces: p.workspaces, engines: p.engines });
        for (const section of ["dependencies", "devDependencies", "peerDependencies"]) if (p[section]) entry(section, p[section], lineOf(section));
      } else {
        // Other manifests are indexed as bounded declarative text, never executed.
        for (let start = 0; start < lines.length; start += 30) add(lines.slice(start, start + 30).filter(line => !/^\s*(?:-r |--|source |git_source)/.test(line)).join("\n"), start + 1, Math.min(lines.length, start + 30));
      }
    } else {
      const docs = path.endsWith(".json") ? [JSON.parse(raw)] : parseAllDocuments(raw, { merge: true, strict: true }).map(doc => {
        if (doc.errors.length) throw new Error("Invalid YAML");
        // Preserve CloudFormation intrinsic functions as data, without evaluating them.
        visit(doc, { Value(_key, node) {
          if (!node.tag?.startsWith("!")) return;
          const name = node.tag.slice(1);
          if (!/^(Ref|Sub|GetAtt|Join|Select|Split|FindInMap|ImportValue|GetAZs|Base64|If|Equals|And|Or|Not|Condition|Cidr|Transform|Length|ToJsonString)$/.test(name)) throw new Error("Unsupported YAML tag");
          node.tag = undefined;
          const wrapper = new YAMLMap(doc.schema);
          wrapper.items.push(new Pair(new Scalar(name === "Ref" || name === "Condition" ? name : "Fn::" + name), node));
          return wrapper;
        } });
        return doc.toJS({ maxAliasCount: 40 });
      });
      for (const doc of docs) {
        if (!doc || typeof doc !== "object") continue;
        if (doc.services && typeof doc.services === "object") {
          kind = "compose";
          for (const [name, service] of Object.entries(doc.services as Record<string, Record<string, unknown>>)) {
            const { image, build, ports, expose, networks, depends_on, volumes, profiles } = service ?? {};
            entry("service " + name, { image, build: typeof build === "string" ? build : (build as {context?: string})?.context, ports, expose, networks, depends_on, volumes, profiles }, lineOf(name + ":"));
          }
          if (doc.networks) entry("networks", doc.networks);
          if (doc.volumes) entry("volumes", doc.volumes);
        } else if (doc.Resources && typeof doc.Resources === "object") {
          kind = "cloudformation";
          for (const [name, resource] of Object.entries(doc.Resources)) entry(name, resource);
          if (doc.Parameters) entry("Parameters", doc.Parameters);
        } else if (doc.apiVersion && doc.kind) {
          kind = "kubernetes";
          if (doc.kind === "List" && Array.isArray(doc.items)) for (const item of doc.items) entry(String(item.kind) + " " + String(item.metadata?.name ?? "resource"), item);
          else entry(String(doc.kind) + " " + String(doc.metadata?.name ?? "resource"), doc, lineOf(String(doc.metadata?.name ?? "kind:")));
        }
      }
      if (kind === "yaml") return { kind, evidence: [], warnings: [] }; // Unrelated YAML is never model context.
    }
  } catch {
    warnings.push(path + ": could not parse this blueprint; its contents were excluded.");
    return { kind, evidence: [], warnings };
  }
  return { kind, evidence, warnings };
}
