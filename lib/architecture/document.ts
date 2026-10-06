import { lessonPlanSchema, type LessonPlan } from "../lesson-schema";
import { collisionFreePosition, NODE_HEIGHT, NODE_WIDTH, routeArchitecture } from "./layout";
import { getAsset } from "./assets";

/** Import a bounded semantic document. Never accept executable visuals or arbitrary assets. */
export function importArchitectureDocument(text: string): LessonPlan {
  if (text.length > 2_000_000) throw new Error("This JSON file exceeds the 2 MB document limit.");
  const lesson = lessonPlanSchema.parse(JSON.parse(text));
  if (lesson.schemaVersion !== 2) throw new Error("Import a Chalkie architecture JSON export (version 2).");
  const unique = new Set<string>();
  for (const item of [...lesson.objects, ...lesson.connections, ...lesson.segments]) {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(item.id) || unique.has(item.id)) throw new Error("The document contains duplicate or invalid IDs.");
    unique.add(item.id);
  }
  const nodeIds = new Set(lesson.objects.map(n => n.id));
  const visualIds = new Set([...nodeIds, ...lesson.connections.map(e => e.id)]);
  const sourceIds = new Set(lesson.sources.map(s => s.id));
  for (const source of lesson.sources) if (!/^https?:\/\//i.test(source.url)) throw new Error("Source links must use HTTP or HTTPS.");
  for (const item of [...lesson.objects, ...lesson.connections]) if (item.evidenceIds?.some(id => !sourceIds.has(id))) throw new Error("The document references missing evidence.");
  for (const edge of lesson.connections) if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to) || edge.from === edge.to) throw new Error("A connection references a missing component.");
  for (const step of lesson.segments) if (step.targetIds.some(id => !visualIds.has(id))) throw new Error("An explanation step references a missing component.");
  const objects: LessonPlan["objects"] = [];
  for (const node of lesson.objects) {
    const position = lesson.view?.positions[node.id] ?? node;
    if (![position.x, position.y].every(n => Number.isFinite(n) && Math.abs(n) <= 1_000_000)) throw new Error("A component position is outside the supported canvas.");
    const safe = { ...node, shapeType: "custom" as const, assetId: getAsset(node.assetId).id, width: NODE_WIDTH, height: NODE_HEIGHT, parts: [] };
    delete safe.svg; delete safe.chart; delete safe.props; delete safe.template; delete safe.templateData; delete safe.templateType; delete safe.data; delete safe.content;
    objects.push({ ...safe, ...collisionFreePosition(safe, position.x, position.y, objects) });
  }
  return routeArchitecture({ ...lesson, objects, view: { ...lesson.view, positions: Object.fromEntries(objects.map(n => [n.id, { x: n.x, y: n.y }])) } });
}
