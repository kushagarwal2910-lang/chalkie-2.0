"use client";

import { useCallback, useEffect, useMemo, useRef, useState, memo } from "react";
import Image from "next/image";
import { AttachmentSource } from "@/components/attachment-source";
import { ReactFlow, ReactFlowProvider, Background, BackgroundVariant, Controls, MiniMap, Handle, Position, BaseEdge, EdgeLabelRenderer, Panel, useReactFlow, type Node, type NodeChange, type NodeProps, type Edge, type EdgeProps, type Connection, type Viewport } from "@xyflow/react";
import { Database, Server, Cloud, Network, ListOrdered, HardDrive, User, Globe, Route, Cog, Brain, Workflow, Box, FileText, Layers, CircleHelp, X, Undo2, Redo2, Download, LocateFixed, LayoutGrid, Search } from "lucide-react";
import type { LessonPlan, LessonSegment, VisualObject, VisualConnection } from "@/lib/lesson-schema";
import type { CanvasPlaybackState } from "@/lib/playback-sync";
import { assetCatalog, getAsset } from "@/lib/architecture/assets";
import { collisionFreePosition, layoutArchitecture, routeArchitecture, NODE_WIDTH, NODE_HEIGHT } from "@/lib/architecture/layout";

const conceptIcons = { service: Server, database: Database, cloud: Cloud, network: Network, queue: ListOrdered, storage: HardDrive, user: User, browser: Globe, gateway: Route, worker: Cog, model: Brain, pipeline: Workflow, container: Box, document: FileText, cache: Layers, unknown: CircleHelp };
export function ArchitectureAsset({ id, size = 32 }: { id?: string; size?: number }) {
  const asset = getAsset(id);
  const Icon = conceptIcons[asset.id.split(":")[1] as keyof typeof conceptIcons] ?? Server;
  return asset.path ? <Image src={asset.path} alt={asset.name} width={size} height={size} unoptimized draggable={false} /> : <Icon size={size} aria-label={asset.name} />;
}
type ArchitectureNode = Node<{ object: VisualObject; active: boolean; speaking: boolean }, "architecture">;
type ArchitectureEdge = Edge<{ connection: VisualConnection; active: boolean }, "architecture">;
const ArchitectureNodeView = memo(function ArchitectureNodeView({ data, selected }: NodeProps<ArchitectureNode>) {
  const o = data.object;
  const label = o.label || "Untitled component";
  return <div className={"architecture-node" + (data.active ? " is-active" : "") + (selected ? " is-selected" : "")} style={{ width: o.width, height: o.height }} title={label}>
    <Handle type="target" position={Position.Left} id="in" />
    <span className="architecture-asset architecture-node-icon" aria-hidden="true"><ArchitectureAsset id={o.assetId} size={56} /></span>
    <span className="architecture-node-label">{label}</span>
    {data.active && <span className={"architecture-pointer" + (data.speaking ? " speaking" : "")} aria-label="Explanation focus" />}
    <Handle type="source" position={Position.Right} id="out" />
  </div>;
});
function ArchitectureEdgeView({ id, data, markerEnd }: EdgeProps<ArchitectureEdge>) {
  const points: Array<{ x: number; y: number }> = data?.connection.points ?? [];
  if (points.length < 2) return null;
  const d = points.map((p, i) => (i ? "L" : "M") + p.x + " " + p.y).join(" ");
  const label = data?.connection.labelPosition;
  return <><BaseEdge id={id} path={d} markerEnd={markerEnd} style={{ stroke: data?.active ? "#c4b5fd" : "#788697", strokeWidth: data?.active ? 2.7 : 1.6, strokeDasharray: data?.connection.certainty === "inferred" ? "6 5" : undefined }} />
    {data?.active && <circle r="4" fill="#c4b5fd" className="architecture-flow-dot"><animateMotion dur="2.4s" repeatCount="indefinite" path={d} /></circle>}
    {label && <EdgeLabelRenderer><div className={"architecture-edge-label nodrag nopan" + (data?.active ? " is-active" : "")} style={{ transform: "translate(" + label.x + "px," + label.y + "px)", width: label.width, minHeight: label.height }} title={data?.connection.label}>{data?.connection.label}</div></EdgeLabelRenderer>}
  </>;
}
const nodeTypes = { architecture: ArchitectureNodeView };
const edgeTypes = { architecture: ArchitectureEdgeView };
type Props = {
  lesson?: LessonPlan | null; activeSegment?: LessonSegment | null; activeStep: number; isPresenting: boolean; isSpeaking?: boolean; activeTargetId?: string | null; revealedStep?: number | null; playbackRequest?: number; onPlaybackState?: (state: CanvasPlaybackState) => void; onDocumentChange?: (lesson: LessonPlan) => void;
};
export function ChalkCanvas(props: Props) { return <ReactFlowProvider key={props.lesson?.id ?? "empty"}><ArchitectureCanvas {...props} /></ReactFlowProvider>; }

function ArchitectureCanvas({ lesson, activeSegment, isPresenting, isSpeaking = false, activeTargetId, revealedStep = null, playbackRequest = 0, onPlaybackState, onDocumentChange }: Props) {
  const flow = useReactFlow<ArchitectureNode, ArchitectureEdge>();
  const [dragPositions, setDragPositions] = useState<Record<string, { x: number; y: number }>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [group, setGroup] = useState("");
  const [assetSearch, setAssetSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [layoutError, setLayoutError] = useState<string | null>(null);
  const [past, setPast] = useState<LessonPlan[]>([]);
  const [future, setFuture] = useState<LessonPlan[]>([]);
  const fittedId = useRef("");
  const lessonRef = useRef(lesson);
  useEffect(() => { lessonRef.current = lesson; }, [lesson]);
  const editable = Boolean(onDocumentChange) && !isPresenting;
  const display = useMemo(() => {
    if (!lesson) return null;
    const objects: VisualObject[] = [];
    for (const object of lesson.objects) {
      const n = { ...object, width: NODE_WIDTH, height: NODE_HEIGHT };
      const position = dragPositions[n.id] ?? lesson.view?.positions[n.id] ?? { x: n.x, y: n.y };
      objects.push({ ...n, ...(lesson.schemaVersion === 2 ? position : collisionFreePosition(n, position.x, position.y, objects)) });
    }
    return routeArchitecture({ ...lesson, objects, connections: lesson.connections.filter(e => objects.some(o => o.id === e.from) && objects.some(o => o.id === e.to)) });
  }, [lesson, dragPositions]);
  const visibleIds = useMemo(() => {
    if (!display) return new Set<string>();
    if (revealedStep === null) return new Set(display.objects.map(o => o.id));
    const ids = new Set(display.segments.slice(0, revealedStep + 1).flatMap(s => s.targetIds.map(id => id.split("#")[0])));
    for (const edge of display.connections) if (ids.has(edge.id)) { ids.add(edge.from); ids.add(edge.to); }
    return ids;
  }, [display, revealedStep]);
  const focusIds = useMemo(() => {
    const ids = new Set(activeTargetId ? [activeTargetId.split("#")[0]] : activeSegment?.targetIds ?? []);
    for (const edge of display?.connections ?? []) if (ids.has(edge.id)) { ids.add(edge.from); ids.add(edge.to); }
    return ids;
  }, [activeTargetId, activeSegment, display]);
  const nodes: ArchitectureNode[] = useMemo(() => (display?.objects ?? []).map(object => ({ id: object.id, type: "architecture", ariaLabel: object.label || "Untitled component", position: { x: object.x, y: object.y }, width: NODE_WIDTH, height: NODE_HEIGHT, data: { object, active: focusIds.has(object.id), speaking: isSpeaking }, hidden: !visibleIds.has(object.id) || Boolean(group && !isPresenting && object.group !== group), selected: selectedId === object.id })), [display, focusIds, visibleIds, selectedId, group, isPresenting, isSpeaking]);
  const edges: ArchitectureEdge[] = useMemo(() => (display?.connections ?? []).map(connection => ({ id: connection.id, source: connection.from, target: connection.to, sourceHandle: "out", targetHandle: "in", type: "architecture", data: { connection, active: focusIds.has(connection.id) || focusIds.has(connection.from) && focusIds.has(connection.to) }, hidden: !visibleIds.has(connection.from) || !visibleIds.has(connection.to) || Boolean(group && !isPresenting && display?.objects.some(o => (o.id === connection.from || o.id === connection.to) && o.group !== group)), markerEnd: { type: "arrowclosed" as import("@xyflow/react").MarkerType, color: "#788697" } })), [display, focusIds, visibleIds, group, isPresenting]);
  useEffect(() => {
    if (!lesson || !display) return;
    onPlaybackState?.({ status: "loading", request: playbackRequest });
    let next = 0;
    const first = requestAnimationFrame(() => { next = requestAnimationFrame(() => {
      if (layoutError) onPlaybackState?.({ status: "error", request: playbackRequest, message: layoutError });
      else onPlaybackState?.({ status: "ready", request: playbackRequest });
      if (fittedId.current !== lesson.id && display.objects.length && (visibleIds.size || revealedStep === -1)) {
        fittedId.current = lesson.id;
        if (lesson.view?.viewport) void flow.setViewport(lesson.view.viewport);
        else void flow.fitBounds({ x: Math.min(...display.objects.map(o => o.x)), y: Math.min(...display.objects.map(o => o.y)), width: Math.max(...display.objects.map(o => o.x + o.width)) - Math.min(...display.objects.map(o => o.x)), height: Math.max(...display.objects.map(o => o.y + o.height)) - Math.min(...display.objects.map(o => o.y)) }, { padding: .2, duration: 0 });
      }
    }); });
    return () => { cancelAnimationFrame(first); cancelAnimationFrame(next); };
  }, [display, lesson, playbackRequest, visibleIds, revealedStep, flow, onPlaybackState, layoutError]);
  useEffect(() => {
    if (!isPresenting || !activeSegment || !display) return;
    const ids = new Set(activeSegment.targetIds);
    for (const edge of display.connections) if (ids.has(edge.id)) { ids.add(edge.from); ids.add(edge.to); }
    const frame = requestAnimationFrame(() => { void flow.fitView({ nodes: [...ids].map(id => ({ id })), duration: 500, padding: .6, maxZoom: 1.05 }); });
    return () => cancelAnimationFrame(frame);
  }, [activeSegment, isPresenting, display, flow]);
  const commit = useCallback((next: LessonPlan) => {
    if (!lesson || !editable) return;
    setPast(history => [...history.slice(-29), lesson]); setFuture([]);
    const updated = { ...next, revision: (lesson.revision ?? 0) + 1 };
    lessonRef.current = updated;
    onDocumentChange?.(updated);
  }, [lesson, editable, onDocumentChange]);
  const moveNodes = (changes: NodeChange<ArchitectureNode>[]) => {
    if (!editable || !display) return;
    const moving = changes.flatMap(c => c.type === "position" && c.position ? [{ id: c.id, position: c.position, dragging: c.dragging }] : []);
    if (!moving.length) return;
    if (moving.some(c => c.dragging)) { setDragPositions(current => ({ ...current, ...Object.fromEntries(moving.map(c => [c.id, c.position])) })); return; }
    // React Flow emits dragging=false for both drag completion and keyboard moves.
    const objects = [...display.objects];
    const positions = { ...display.view?.positions };
    for (const change of moving) {
      const index = objects.findIndex(n => n.id === change.id);
      if (index < 0) continue;
      const position = collisionFreePosition(objects[index], change.position.x, change.position.y, objects);
      objects[index] = { ...objects[index], ...position }; positions[change.id] = position;
    }
    setDragPositions({});
    commit({ ...display, objects, view: { ...display.view, positions } });
  };
  const onConnect = (connection: Connection) => {
    if (!display || !connection.source || !connection.target || connection.source === connection.target || display.connections.length >= 320) return;
    const edge: VisualConnection = { id: "manual-" + crypto.randomUUID(), from: connection.source, to: connection.target, label: "User connection", certainty: "unknown", color: "slate", route: "elbow", fromAnchor: "right", toAnchor: "left", arrowhead: "arrow", bend: 0 };
    commit({ ...display, connections: [...display.connections, edge] });
  };
  const selected = display?.objects.find(o => o.id === selectedId);
  const selectedEdge = display?.connections.find(e => e.id === selectedId);
  const groups = [...new Set(display?.objects.map(o => o.group).filter(Boolean))] as string[];
  const updateNode = (updates: Partial<VisualObject>) => { if (display && selected) commit({ ...display, objects: display.objects.map(o => o.id === selected.id ? { ...o, ...updates } : o) }); };
  const exportJson = () => {
    if (!lesson) return;
    const blob = new Blob([JSON.stringify({ ...lesson, view: { positions: lesson.view?.positions ?? {}, viewport: flow.getViewport() } }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = "chalkie-architecture.json"; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const saveViewport = (_: unknown, viewport: Viewport) => {
    const current = lessonRef.current;
    if (isPresenting || !current || !onDocumentChange) return;
    const previous = current.view?.viewport;
    if (previous && Math.abs(previous.x - viewport.x) < .5 && Math.abs(previous.y - viewport.y) < .5 && Math.abs(previous.zoom - viewport.zoom) < .001) return;
    onDocumentChange({ ...current, view: { positions: current.view?.positions ?? {}, viewport } });
  };
  return <div className="architecture-canvas" data-testid="architecture-canvas">
    <ReactFlow<ArchitectureNode, ArchitectureEdge> nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} onNodesChange={moveNodes} onNodeClick={(_, node) => setSelectedId(node.id)} onEdgeClick={(_, edge) => setSelectedId(edge.id)} onPaneClick={() => setSelectedId(null)} onConnect={onConnect} nodesDraggable={editable} nodesConnectable={editable} edgesReconnectable={false} deleteKeyCode={null} minZoom={.05} maxZoom={2} colorMode="dark" onMoveEnd={saveViewport}>
      <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="#39404b" />
      <Controls showInteractive={false} /><MiniMap pannable zoomable nodeColor="#444758" maskColor="#15181dbb" />
      {display?.objects.length ? <Panel position="top-left"><div className="architecture-toolbar">
        <button aria-label="Fit diagram" title="Fit diagram" onClick={() => void flow.fitView({ padding: .2, duration: 350, maxZoom: 1 })}><LocateFixed size={16} /></button>
        <button aria-label="Auto arrange diagram" title="Auto arrange diagram" disabled={!editable || busy} onClick={async () => { setBusy(true); setLayoutError(null); try { const next = await layoutArchitecture(display); commit({ ...next, view: { positions: {} } }); fittedId.current = ""; } catch { setLayoutError("The diagram could not be arranged. Your existing layout has been kept."); } finally { setBusy(false); } }}><LayoutGrid size={16} /></button>
        <button aria-label="Undo diagram edit" disabled={!editable || !past.length} onClick={() => { const previous = past.at(-1); if (!previous || !lesson) return; setPast(past.slice(0, -1)); setFuture([lesson, ...future]); onDocumentChange?.({ ...previous, revision: (lesson.revision ?? 0) + 1 }); }}><Undo2 size={16} /></button>
        <button aria-label="Redo diagram edit" disabled={!editable || !future.length} onClick={() => { if (!lesson) return; setPast([...past, lesson]); setFuture(future.slice(1)); onDocumentChange?.({ ...future[0], revision: (lesson.revision ?? 0) + 1 }); }}><Redo2 size={16} /></button>
        <button aria-label="Export architecture JSON" title="Export JSON" onClick={exportJson}><Download size={16} /></button>
        {groups.length > 1 && <select aria-label="Focus subsystem" value={group} onChange={e => { setGroup(e.target.value); setTimeout(() => void flow.fitView({ padding: .3, duration: 300 }), 60); }} disabled={isPresenting}><option value="">All subsystems</option>{groups.map(g => <option key={g}>{g}</option>)}</select>}
      </div></Panel> : null}
      {layoutError && <Panel position="top-center"><p role="alert" className="architecture-warning">{layoutError}</p></Panel>}
    </ReactFlow>
    {(selected || selectedEdge) && <aside className="architecture-inspector nowheel" aria-label="Component inspector">
      <div className="architecture-inspector-title"><span>{selected ? "Component" : "Connection"}</span><button onClick={() => setSelectedId(null)} aria-label="Close inspector"><X size={17} /></button></div>
      {selected && <><span className="architecture-asset large"><ArchitectureAsset id={selected.assetId} size={40} /></span><h3>{selected.label}</h3><p>{selected.description || "Legacy diagram component. Original saved data is preserved in JSON export."}</p><small>{[selected.group, selected.kind ?? selected.shapeType, selected.certainty ?? "Legacy"].filter(Boolean).join(" · ")}</small>
        {editable && <><label>Display name<input key={selected.id + "-" + selected.label} defaultValue={selected.label} maxLength={90} onBlur={e => { if (e.target.value.trim() && e.target.value !== selected.label) updateNode({ label: e.target.value.trim() }); }} /></label><label><Search size={13} /> Find a visual<input value={assetSearch} onChange={e => setAssetSearch(e.target.value)} placeholder="Postgres, database, cloud…" /></label><div className="architecture-asset-picker">{assetCatalog.filter(a => !assetSearch ? a.id.startsWith("concept:") : (a.name + " " + a.aliases.join(" ")).toLowerCase().includes(assetSearch.toLowerCase())).slice(0, 24).map(asset => <button key={asset.id} title={asset.name} aria-label={"Use " + asset.name + " visual"} onClick={() => updateNode({ assetId: asset.id })}><ArchitectureAsset id={asset.id} size={24} /></button>)}</div></>}
      </>}
      {selectedEdge && <><h3>{selectedEdge.label}</h3><p>{display?.objects.find(o => o.id === selectedEdge.from)?.label} → {display?.objects.find(o => o.id === selectedEdge.to)?.label}</p><small>{selectedEdge.certainty ?? "Legacy relationship"}</small>{editable && <label>Connection label<input key={selectedEdge.id + selectedEdge.label} defaultValue={selectedEdge.label} maxLength={60} onBlur={e => { if (display && e.target.value.trim() && e.target.value !== selectedEdge.label) commit({ ...display, connections: display.connections.map(edge => edge.id === selectedEdge.id ? { ...edge, label: e.target.value.trim() } : edge) }); }} /></label>}</>}
      <div className="architecture-evidence">{(selected?.evidenceIds ?? selectedEdge?.evidenceIds ?? []).map(id => { const source = lesson?.sources.find(s => s.id === id); return source?.origin === "attachment" ? <AttachmentSource key={id} source={source} /> : source ? <a key={id} href={source.url} target="_blank" rel="noreferrer"><FileText size={13} />{source.title}</a> : null; })}</div>
    </aside>}
  </div>;
}
