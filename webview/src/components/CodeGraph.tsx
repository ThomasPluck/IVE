import { useRef, useState, useCallback, useEffect, useMemo } from 'react';
import { useForceLayout, type ForceNode } from '../hooks/useGraphLayout';
import { GraphNodeComponent } from './GraphNode';
import { GraphEdgeComponent, EdgeMarkerDefs } from './GraphEdge';
import { CoveragePanel } from './CoveragePanel';
import type { GraphData, GraphNode, DrillEntry, DashboardData } from '../types';

interface Props {
  data: GraphData | null;
  dashboard: DashboardData | null;
  onNavigate: (filePath: string, line: number) => void;
  onDrillDown: (symbolId: number) => void;
  onDrillUp: (parentId: number | null) => void;
  onToggleDiff: () => void;
  drillStack: DrillEntry[];
  diffMode: boolean;
  onShowDeadCode: () => void;
  onSelectNode: (node: GraphNode) => void;
  highlightedNodeIds: Set<number>;
  onClearHighlight: () => void;
}

interface Viewport { x: number; y: number; scale: number }

const DRAG_THRESHOLD = 5;

export function CodeGraph({ data, dashboard, onNavigate, onDrillDown, onDrillUp, onToggleDiff, drillStack, diffMode, onShowDeadCode, onSelectNode, highlightedNodeIds, onClearHighlight }: Props) {
  const forceLayout = useForceLayout(data);
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState<Viewport>({ x: 20, y: 20, scale: 1 });

  // Keep refs in sync so mouse handlers can read current values without re-creating
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;
  const forceLayoutRef = useRef(forceLayout);
  forceLayoutRef.current = forceLayout;

  // Canvas pan state
  const panStart = useRef<{ mx: number; my: number; vx: number; vy: number } | null>(null);

  // Node drag state
  const dragRef = useRef<{ id: number; startX: number; startY: number; moved: boolean } | null>(null);

  const callersSet = useMemo(() => data ? new Set(data.edges.map(e => e.sourceId)) : new Set<number>(), [data]);
  const cycleNodesSet = useMemo(() => {
    if (!data) return new Set<number>();
    const s = new Set<number>();
    for (const e of data.edges) { if (e.isCycle) { s.add(e.sourceId); s.add(e.targetId); } }
    return s;
  }, [data]);
  const rootIdsSet = useMemo(() => new Set(data?.rootIds ?? []), [data]);
  const deadCodeSet = useMemo(() => new Set(dashboard?.coverage.deadCodeIds ?? []), [dashboard]);

  const { highCouplingSet, highImpactSet } = useMemo(() => {
    const nodes = data?.nodes ?? [];
    const couplings = nodes.map(n => n.coupling ?? 0).filter(v => v > 0).sort((a, b) => a - b);
    const impacts = nodes.map(n => n.impactRadius ?? 0).filter(v => v > 0).sort((a, b) => a - b);
    const ct = couplings.length > 0 ? couplings[Math.floor(couplings.length * 0.8)] : Infinity;
    const it = impacts.length > 0 ? impacts[Math.floor(impacts.length * 0.8)] : Infinity;
    return {
      highCouplingSet: new Set(nodes.filter(n => (n.coupling ?? 0) >= ct && ct < Infinity).map(n => n.id)),
      highImpactSet: new Set(nodes.filter(n => (n.impactRadius ?? 0) >= it && it < Infinity).map(n => n.id)),
    };
  }, [data]);

  const churnThreshold = useMemo(() => {
    const v = (data?.nodes ?? []).map(n => n.recentChurnCount ?? 0).filter(v => v > 0).sort((a, b) => a - b);
    return v.length > 0 ? v[Math.floor(v.length * 0.8)] : Infinity;
  }, [data]);

  // Center viewport on data change
  useEffect(() => { setViewport({ x: 20, y: 20, scale: 1 }); }, [data]);

  // --- All mouse handlers use refs — zero dependency churn ---
  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    setViewport(v => {
      const factor = e.deltaY > 0 ? 0.9 : 1.1;
      const newScale = Math.max(0.15, Math.min(4, v.scale * factor));
      const ratio = newScale / v.scale;
      // Keep the world-point under the cursor fixed
      return { x: mx - (mx - v.x) * ratio, y: my - (my - v.y) * ratio, scale: newScale };
    });
  }, []);

  const handleCanvasMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const v = viewportRef.current;
    panStart.current = { mx: e.clientX, my: e.clientY, vx: v.x, vy: v.y };
  }, []);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    // Node drag takes priority
    if (dragRef.current) {
      const dx = e.clientX - dragRef.current.startX;
      const dy = e.clientY - dragRef.current.startY;
      if (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD) {
        dragRef.current.moved = true;
      }
      const v = viewportRef.current;
      const worldX = (e.clientX - v.x) / v.scale;
      const worldY = (e.clientY - v.y) / v.scale;
      forceLayoutRef.current?.onNodeDrag(dragRef.current.id, worldX, worldY);
      return;
    }
    // Canvas pan
    if (panStart.current) {
      setViewport({
        x: panStart.current.vx + e.clientX - panStart.current.mx,
        y: panStart.current.vy + e.clientY - panStart.current.my,
        scale: viewportRef.current.scale,
      });
    }
  }, []);

  const handleMouseUp = useCallback(() => {
    if (dragRef.current) {
      forceLayoutRef.current?.onNodeDragEnd(dragRef.current.id);
      dragRef.current = null;
    }
    panStart.current = null;
  }, []);

  // --- Node interaction handlers ---
  const handleNodeMouseDown = useCallback((e: React.MouseEvent, node: ForceNode) => {
    dragRef.current = { id: node.id, startX: e.clientX, startY: e.clientY, moved: false };
  }, []);

  const handleNodeClick = useCallback((node: ForceNode) => {
    // Suppress click if it was a drag
    if (dragRef.current?.moved) return;
    const gn = data?.nodes.find(n => n.id === node.id);
    if (gn) onSelectNode(gn);
  }, [data, onSelectNode]);

  const handleNodeDrillDown = useCallback((node: ForceNode) => {
    if (dragRef.current?.moved) return;
    onDrillDown(node.id);
  }, [onDrillDown]);

  if (!data || data.nodes.length === 0) {
    return (
      <div className="ive-empty">
        <p>No symbols indexed yet.</p>
        <p style={{ opacity: 0.5, fontSize: 11 }}>Save a file or run IVE: Re-index Workspace.</p>
      </div>
    );
  }

  if (!forceLayout) return <div className="ive-empty"><p>Computing layout...</p></div>;

  const hasHighlight = highlightedNodeIds.size > 0;

  return (
    <div className="ive-graph-container" ref={containerRef}>
      <div className="ive-breadcrumb">
        {drillStack.length > 0 && (
          <>
            <button className="ive-breadcrumb-item" onClick={() => onDrillUp(null)}>⬡ top</button>
            {drillStack.map((entry, i) => (
              <span key={entry.symbolId}>
                <span className="ive-breadcrumb-sep">›</span>
                <button className="ive-breadcrumb-item" onClick={() => { for (let s = 0; s < drillStack.length - 1 - i; s++) onDrillUp(null); }}>
                  {entry.name}
                </button>
              </span>
            ))}
          </>
        )}
        {hasHighlight && (
          <button
            className="ive-diff-btn ive-diff-btn--active"
            onClick={onClearHighlight}
            title="Clear highlight"
          >
            ✕ Highlight
          </button>
        )}
        <button
          className={`ive-diff-btn${diffMode ? ' ive-diff-btn--active' : ''}`}
          onClick={onToggleDiff}
          title={diffMode ? 'Exit diff view' : 'Show uncommitted changes'}
        >
          {diffMode ? '✕ Diff' : '⬡ Diff'}
        </button>
      </div>

      <CoveragePanel dashboard={dashboard} data={data} onShowDeadCode={onShowDeadCode} />

      <svg
        ref={svgRef}
        className="ive-graph-svg"
        onWheel={handleWheel}
        onMouseDown={handleCanvasMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        style={{ cursor: dragRef.current ? 'grabbing' : 'grab' }}
      >
        <EdgeMarkerDefs />
        <g transform={`translate(${viewport.x}, ${viewport.y}) scale(${viewport.scale})`}>
          {forceLayout.edges.map((edge, i) => {
            const edgeDimmed = hasHighlight && !(highlightedNodeIds.has(edge.sourceId) && highlightedNodeIds.has(edge.targetId));
            return (
              <g key={i} opacity={edgeDimmed ? 0.12 : 1}>
                <GraphEdgeComponent
                  edge={edge}
                  sourceNode={edge.source}
                  targetNode={edge.target}
                  markerId={`ive-arrow-${edge.kind}`}
                />
              </g>
            );
          })}
          {forceLayout.nodes.map(node => {
            const nodeDimmed = hasHighlight && !highlightedNodeIds.has(node.id);
            return (
              <g key={node.id} opacity={nodeDimmed ? 0.15 : 1}>
                <GraphNodeComponent
                  node={node}
                  isRoot={rootIdsSet.has(node.id)}
                  hasCallees={callersSet.has(node.id)}
                  isInCycle={cycleNodesSet.has(node.id)}
                  isHighChurn={(node.recentChurnCount ?? 0) >= churnThreshold && churnThreshold < Infinity}
                  isDeadCode={deadCodeSet.has(node.id)}
                  isHighCoupling={highCouplingSet.has(node.id)}
                  isHighImpact={highImpactSet.has(node.id)}
                  onClick={handleNodeClick}
                  onDrillDown={handleNodeDrillDown}
                  onNavigate={onNavigate}
                  onMouseDown={handleNodeMouseDown}
                />
              </g>
            );
          })}
        </g>
        <text x={8} y="98%" fontSize={10} fill="rgba(255,255,255,0.2)" style={{ userSelect: 'none', pointerEvents: 'none' }}>
          {data.nodes.length} nodes · {data.edges.length} edges
        </text>
      </svg>
    </div>
  );
}
