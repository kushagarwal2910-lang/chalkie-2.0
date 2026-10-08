import ELK from "elkjs/lib/elk.bundled.js";
import type { LessonPlan, VisualObject } from "../lesson-schema.ts";
import { layoutConnectorLabel, routeOrthogonalConnector } from "../connector-routing.ts";

export const NODE_WIDTH = 144;
export const NODE_HEIGHT = 132;
export function overlap(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }, gap = 24) {
  return a.x < b.x + b.width + gap && a.x + a.width + gap > b.x && a.y < b.y + b.height + gap && a.y + a.height + gap > b.y;
}
export function collisionFreePosition(node: VisualObject, x: number, y: number, others: VisualObject[]) {
  const candidate = { ...node, x, y };
  for (let i = 0; i < 500; i++) {
    const obstacle = others.find(other => other.id !== node.id && overlap(candidate, other));
    if (!obstacle) return { x: candidate.x, y: candidate.y };
    candidate.y = obstacle.y + obstacle.height + 48;
  }
  return { x: Math.max(0, ...others.map(o => o.x + o.width)) + 180, y };
}
export function routeArchitecture(lesson: LessonPlan): LessonPlan {
  const objects = lesson.objects;
  const byId = new Map(objects.map(o => [o.id, o]));
  const labels: Array<{ x: number; y: number; width: number; height: number }> = [];
  const connections = lesson.connections.map(edge => {
    const from = byId.get(edge.from), to = byId.get(edge.to);
    if (!from || !to) throw new Error("Connection references a missing component");
    const source = { x: from.x + from.width, y: from.y + from.height / 2 };
    const target = { x: to.x, y: to.y + to.height / 2 };
    const points = routeOrthogonalConnector({ start: source, end: target, startId: from.id, endId: to.id, startDirection: "right", endDirection: "left", obstacles: objects, clearance: 22 });
    const labelPosition = layoutConnectorLabel(points, edge.label, [...objects, ...labels]);
    if (labelPosition) labels.push(labelPosition);
    return { ...edge, points, fromPort: source, toPort: target, labelPosition };
  });
  return { ...lesson, connections };
}
export async function layoutArchitecture(lesson: LessonPlan): Promise<LessonPlan> {
  const elk = new ELK();
  const graph = await elk.layout({
    id: "architecture",
    layoutOptions: { "elk.algorithm": "layered", "elk.direction": "RIGHT", "elk.edgeRouting": "ORTHOGONAL", "elk.spacing.nodeNode": "90", "elk.layered.spacing.nodeNodeBetweenLayers": "210", "elk.spacing.edgeNode": "36", "elk.spacing.edgeEdge": "30", "elk.padding": "[top=50,left=50,bottom=50,right=50]" },
    children: lesson.objects.map(o => ({ id: o.id, width: NODE_WIDTH, height: NODE_HEIGHT,
      layoutOptions: { "elk.portConstraints": "FIXED_SIDE" },
      ports: [{ id: o.id + "-in", width: 1, height: 1, properties: { "port.side": "WEST" } }, { id: o.id + "-out", width: 1, height: 1, properties: { "port.side": "EAST" } }],
    })),
    // Labels are placed against obstacles by routeArchitecture after node layout.
    edges: lesson.connections.map(e => ({ id: e.id, sources: [e.from + "-out"], targets: [e.to + "-in"] })),
  });
  const positions = new Map(graph.children?.map(n => [n.id, { x: n.x ?? 0, y: n.y ?? 0 }]));
  const objects: VisualObject[] = [];
  for (const original of lesson.objects) {
    const node = { ...original, width: NODE_WIDTH, height: NODE_HEIGHT };
    const desired = positions.get(node.id) ?? { x: 0, y: 0 };
    objects.push({ ...node, ...collisionFreePosition(node, desired.x, desired.y, objects) });
  }
  return routeArchitecture({ ...lesson, objects });
}
