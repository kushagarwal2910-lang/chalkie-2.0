import technologies from "./asset-catalog.json";
export type AssetRecord = { id: string; name: string; aliases: string[]; categories: string[]; description: string; path: string; source: string; license: string; version: string };
const concepts = [
  ["service", "Service", "application api backend server"], ["database", "Database", "sql nosql storage persistence"],
  ["cloud", "Cloud", "infrastructure hosting compute"], ["network", "Network", "vpc subnet networking routing"],
  ["queue", "Message queue", "events messaging broker async"], ["storage", "Object storage", "bucket s3 blob files"],
  ["user", "User", "customer actor person"], ["browser", "Web application", "frontend website client"],
  ["gateway", "Gateway", "load balancer proxy ingress api"], ["worker", "Worker", "job task background processing"],
  ["model", "ML model", "machine learning inference training ai"], ["pipeline", "Pipeline", "workflow cicd deployment etl"],
  ["container", "Container", "docker pod deployment workload"], ["document", "Documentation", "readme architecture team practices"],
  ["cache", "Cache", "caching memory key value"], ["unknown", "Unresolved component", "unknown missing evidence"],
];
export const assetCatalog: AssetRecord[] = [...concepts.map(([id, name, words]) => ({ id: "concept:" + id, name, aliases: words.split(" "), categories: ["concept"], description: "Generic " + name.toLowerCase() + "; does not imply a specific vendor.", path: "", source: "https://lucide.dev", license: "ISC", version: "lucide-react" })), ...technologies];
const byId = new Map(assetCatalog.map(asset => [asset.id, asset]));
export function getAsset(id?: string): AssetRecord { return byId.get(id ?? "") ?? byId.get("concept:service")!; }
export function isKnownAsset(id: string) { return byId.has(id); }
export function searchAssets(query: string, limit = 40) {
  const terms = new Set(query.toLowerCase().match(/[a-z0-9][a-z0-9.+-]{1,}/g) ?? []);
  const ranked = assetCatalog.filter(asset => !asset.id.startsWith("concept:")).map(asset => {
    const names = [asset.name.toLowerCase(), ...asset.aliases.map(a => a.toLowerCase()), asset.id.split(":")[1]];
    return { asset, score: names.reduce((score, name) => score + (terms.has(name) ? 10 : 0), 0) + asset.categories.filter(c => terms.has(c)).length };
  }).filter(row => row.score > 0).sort((a, b) => b.score - a.score || a.asset.id.localeCompare(b.asset.id));
  return [...assetCatalog.filter(a => a.id.startsWith("concept:")), ...ranked.slice(0, Math.max(0, limit - concepts.length)).map(row => row.asset)];
}
