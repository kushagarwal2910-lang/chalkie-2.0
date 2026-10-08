import { z } from "zod";

export const canvasColors = ["ink", "slate", "blue", "cyan", "violet", "orange", "green", "red", "yellow", "white", "gray", "none"] as const;
export type CanvasColor = typeof canvasColors[number];

export const diagramTypes = ["mechanism", "spatial", "structure", "cycle", "process", "comparison", "timeline", "system", "quantitative"] as const;
export const visualRoles = ["subject", "component", "environment", "container", "input", "output", "force", "annotation", "energy", "motion", "field", "path", "layer", "formula"] as const;
export const visualShapeTypes = ["custom", "custom-chart", "custom-svg", "custom-template", "geo", "note", "frame"] as const;
export const connectionArrowheads = ["none", "arrow", "triangle", "dot", "diamond", "bar"] as const;
export const labelPlacements = ["inside", "below", "above", "left", "right", "none"] as const;
export type LabelPlacement = typeof labelPlacements[number];

export const safeColorSchema = z.preprocess((val) => {
  if (typeof val !== "string") return "slate";
  const s = val.trim().toLowerCase();
  if (canvasColors.includes(s as any)) return s;
  if (s === "grey" || s === "silver" || s === "metal") return "gray";
  if (s === "black" || s === "dark") return "ink";
  if (s === "purple" || s === "magenta") return "violet";
  if (s === "gold") return "yellow";
  return "slate";
}, z.enum(canvasColors));

export const safeLabelPlacementSchema = z.preprocess((val) => {
  if (typeof val !== "string") return "below";
  const s = val.trim().toLowerCase();
  if (labelPlacements.includes(s as any)) return s;
  if (s === "top") return "above";
  if (s === "bottom") return "below";
  if (s === "center" || s === "middle") return "inside";
  return "below";
}, z.enum(labelPlacements));

export const researchSourceSchema = z.object({
  id: z.string().min(1).max(80),
  title: z.string().min(1).max(180),
  url: z.string().url().or(z.string().min(1)).or(z.literal("")),
  origin: z.enum(["attachment"]).optional(),
  publisher: z.string().max(100).default("Web source"),
  summary: z.string().max(500),
  path: z.string().optional(),
  startLine: z.number().int().positive().optional(),
  score: z.preprocess((val) => {
    const num = typeof val === "number" ? val : parseFloat(String(val)) || 0.85;
    return num > 1 ? Math.min(1, num / 100) : Math.max(0, Math.min(1, num));
  }, z.number().min(0).max(1).default(0.85)),
});

export const visualPartSchema = z.object({
  type: z.preprocess((val) => {
    const s = String(val ?? "").toLowerCase();
    const valid = ["ellipse", "rect", "line", "arrow", "polyline", "polygon", "path", "text", "axes", "radial", "coil", "wave", "particles", "orbit", "cluster", "quarks"];
    return valid.includes(s) ? s : "rect";
  }, z.enum(["ellipse", "rect", "line", "arrow", "polyline", "polygon", "path", "text", "axes", "radial", "coil", "wave", "particles", "orbit", "cluster", "quarks"])),
  x: z.coerce.number().default(0),
  y: z.coerce.number().default(0),
  width: z.coerce.number().default(100),
  height: z.coerce.number().default(60),
  data: z.string().default(""),
  text: z.string().default(""),
  fill: safeColorSchema.default("slate"),
  stroke: safeColorSchema.default("slate"),
  strokeWidth: z.coerce.number().default(2),
  opacity: z.coerce.number().default(1),
});

export const visualObjectSchema = z.object({
  id: z.string().min(1).max(200),
  kind: z.string().max(80).optional(),
  group: z.string().max(100).optional(),
  description: z.string().max(600).optional(),
  assetId: z.string().max(100).optional(),
  evidenceIds: z.array(z.string()).max(20).optional(),
  certainty: z.enum(["declared", "documented", "inferred", "unknown"]).optional(),
  parentId: z.string().max(200).optional(),
  role: z.preprocess((val) => {
    const s = String(val ?? "").toLowerCase();
    return visualRoles.includes(s as any) ? s : "component";
  }, z.enum(visualRoles)),
  shapeType: z.preprocess((val) => {
    const s = String(val ?? "").toLowerCase();
    return visualShapeTypes.includes(s as any) ? s : "custom";
  }, z.enum(visualShapeTypes)).default("custom"),
  geo: z.string().optional(),
  color: safeColorSchema.optional(),
  label: z.preprocess((val) => (val == null ? "" : String(val)), z.string().default("")),
  labelPlacement: safeLabelPlacementSchema.default("below"),
  x: z.coerce.number().default(0),
  y: z.coerce.number().default(0),
  width: z.coerce.number().default(180),
  height: z.coerce.number().default(120),
  parts: z.array(visualPartSchema).max(24).default([]),
  props: z.record(z.any()).optional(),
  chart: z.any().optional(),
  svg: z.any().optional(),
  template: z.any().optional(),
  templateType: z.string().optional(),
  templateData: z.any().optional(),
  data: z.any().optional(),
  content: z.any().optional(),
});

export const visualConnectionSchema = z.object({
  id: z.string().min(1).max(200),
  evidenceIds: z.array(z.string()).max(20).optional(),
  certainty: z.enum(["declared", "documented", "inferred", "unknown"]).optional(),
  from: z.string().max(200),
  to: z.string().max(200),
  label: z.preprocess((val) => (val == null ? "" : String(val)), z.string().default("")),
  color: safeColorSchema.default("slate"),
  route: z.preprocess((val) => {
    const s = String(val ?? "").toLowerCase();
    return ["straight", "curve", "elbow"].includes(s) ? s : "straight";
  }, z.enum(["straight", "curve", "elbow"])),
  fromAnchor: z.preprocess((val) => {
    const s = String(val ?? "").toLowerCase();
    return ["top", "right", "bottom", "left", "center"].includes(s) ? s : "center";
  }, z.enum(["top", "right", "bottom", "left", "center"])),
  toAnchor: z.preprocess((val) => {
    const s = String(val ?? "").toLowerCase();
    return ["top", "right", "bottom", "left", "center"].includes(s) ? s : "center";
  }, z.enum(["top", "right", "bottom", "left", "center"])),
  arrowhead: z.preprocess((val) => {
    const s = String(val ?? "").toLowerCase();
    return connectionArrowheads.includes(s as any) ? s : "arrow";
  }, z.enum(connectionArrowheads)).default("arrow"),
  bend: z.preprocess((val) => Number(val) || 0, z.number().default(0)),
  // Computed by the layout engine, in canvas page coordinates. These are not
  // requested from the language model: its anchors alone cannot describe a route.
  points: z.array(z.object({ x: z.number().finite(), y: z.number().finite() })).min(2).max(256).optional(),
  fromPort: z.object({ x: z.number().finite(), y: z.number().finite() }).optional(),
  toPort: z.object({ x: z.number().finite(), y: z.number().finite() }).optional(),
  labelPosition: z.object({ x: z.number().finite(), y: z.number().finite(), width: z.number().nonnegative(), height: z.number().nonnegative() }).optional(),
});

export const lessonSegmentSchema = z.object({
  id: z.string().min(1).max(200),
  title: z.preprocess((val) => (val == null ? "" : String(val)), z.string().default("")),
  narration: z.string().min(1).max(2400),
  targetIds: z.array(z.string().max(200)).min(1).max(16),
  action: z.preprocess((val) => {
    const s = String(val ?? "").toLowerCase();
    return ["reveal", "focus", "trace", "move", "rotate", "pulse", "flow", "orbit"].includes(s) ? s : "focus";
  }, z.enum(["reveal", "focus", "trace", "move", "rotate", "pulse", "flow", "orbit"])),
  durationMs: z.coerce.number().int().min(0).max(120000).default(5000),
});

export const lessonPlanSchema = z.object({
  schemaVersion: z.literal(2).optional(),
  revision: z.number().int().nonnegative().optional(),
  audience: z.enum(["developer", "cross-team", "leadership"]).optional(),
  repository: z.object({
    indexId: z.string().uuid(),
    url: z.string().url(),
    name: z.string(),
    commit: z.string().regex(/^[a-f0-9]{40}$/),
    indexedFiles: z.number().int().nonnegative(),
    mappedFiles: z.number().int().nonnegative().optional(),
    analyzedFiles: z.number().int().nonnegative().optional(),
    definitionCount: z.number().int().nonnegative().optional(),
    discoveredFiles: z.number().int().nonnegative(),
    warnings: z.array(z.string()).max(100),
  }).optional(),
  conversation: z.array(z.object({ question: z.string().max(1000), answer: z.string().max(2400) })).max(20).optional(),
  view: z.object({
    positions: z.record(z.object({ x: z.number().finite(), y: z.number().finite() })),
    viewport: z.object({ x: z.number().finite(), y: z.number().finite(), zoom: z.number().min(0.05).max(4) }).optional(),
  }).optional(),
  id: z.preprocess((val) => (val ? String(val) : `lesson-${Date.now()}`), z.string().min(1).max(80).default(() => `lesson-${Date.now()}`)),
  title: z.preprocess((val) => (val == null ? "" : String(val)), z.string().default("")),
  question: z.string().min(1).max(1000),
  summary: z.preprocess((val) => (val == null ? "" : String(val)), z.string().default("")),
  diagramType: z.enum(diagramTypes),
  visualStrategy: z.preprocess((val) => (val == null ? "Diagram" : String(val)), z.string().default("Diagram")),
  sources: z.array(researchSourceSchema).max(300),
  objects: z.array(visualObjectSchema).min(1).max(160),
  connections: z.array(visualConnectionSchema).max(320),
  segments: z.array(lessonSegmentSchema).min(1).max(240),
});

export const followUpPlanSchema = z.object({
  baseRevision: z.number().int().optional(),
  sources: z.array(researchSourceSchema).max(40).optional(),
  id: z.preprocess((val) => (val ? String(val) : `follow-up-${Date.now()}`), z.string().min(1).max(80).default(() => `follow-up-${Date.now()}`)),
  title: z.preprocess((val) => (val == null ? "" : String(val)), z.string().default("")),
  answer: z.string().min(1).max(2400),
  coverage: z.preprocess((val) => (val === "append" ? "append" : "existing"), z.enum(["existing", "append"])),
  visualStrategy: z.preprocess((val) => (val == null ? "Diagram" : String(val)), z.string().default("Diagram")),
  targetIds: z.preprocess((val) => (Array.isArray(val) ? val.map(String) : []), z.array(z.string().max(200)).default([])),
  objects: z.array(visualObjectSchema).max(24).default([]),
  connections: z.array(visualConnectionSchema).max(36).default([]),
  segments: z.preprocess((val) => {
    if (Array.isArray(val) && val.length > 0) return val;
    return [{
      id: `follow-step-1`,
      title: "Explanation",
      narration: "Here is how this works.",
      targetIds: ["root"],
      action: "focus",
      durationMs: 4000,
    }];
  }, z.array(lessonSegmentSchema).min(1).max(14)),
});

export type ResearchSource = z.infer<typeof researchSourceSchema>;
export type VisualPart = z.infer<typeof visualPartSchema>;
export type VisualObject = z.infer<typeof visualObjectSchema>;
export type VisualConnection = z.infer<typeof visualConnectionSchema>;
export type LessonSegment = z.infer<typeof lessonSegmentSchema>;
export type LessonPlan = z.infer<typeof lessonPlanSchema>;
export type FollowUpPlan = z.infer<typeof followUpPlanSchema>;
