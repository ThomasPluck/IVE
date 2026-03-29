import { useRef, useState, useCallback, useEffect, useMemo } from 'react';
import { useGraphLayout, type LayoutNode } from '../hooks/useGraphLayout';
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
}

interface Viewport { x: number; y: number; scale: number }

export function CodeGraph({ data, dashboard, onNavigate, onDrillDown, onDrillUp, onToggleDiff, drillStack, diffMode, onShowDeadCode, onSelectNode }: Props) {
  const layout = useGraphLayout(data);
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState<Viewport>({ x: 20, y: 20, scale: 1 });
  const dragStart = useRef<{ mx: number; my: number; vx: number; vy: number } | null>(null);

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

  useEffect(() => { setViewport({ x: 20, y: 20, scale: 1 }); }, [data]);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    setViewport(v => ({ ...v, scale: Math.max(0.15, Math.min(4, v.scale * (e.deltaY > 0 ? 0.9 : 1.1))) }));
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    dragStart.current = { mx: e.clientX, my: e.clientY, vx: viewport.x, vy: viewport.y };
  }, [viewport]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!dragStart.current) return;
    setViewport(v => ({ ...v, x: dragStart.current!.vx + e.clientX - dragStart.current!.mx, y: dragStart.current!.vy + e.clientY - dragStart.current!.my }));
  }, []);

  const handleMouseUp = useCallback(() => { dragStart.current = null; }, []);

  const handleNodeClick = useCallback((node: LayoutNode) => {
    const gn = data?.nodes.find(n => n.id === node.id);
    if (gn) onSelectNode(gn);
  }, [data, onSelectNode]);

  const handleNodeDrillDown = useCallback((node: LayoutNode) => { onDrillDown(node.id); }, [onDrillDown]);

  if (!data || data.nodes.length === 0) {
    return (
      <div className="ive-empty">
        <p>No symbols indexed yet.</p>
        <p style={{ opacity: 0.5, fontSize: 11 }}>Save a file or run IVE: Re-index Workspace.</p>
      </div>
    );
  }

  if (!layout) return <div className="ive-empty"><p>Computing layout…</p></div>;

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
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        style={{ cursor: dragStart.current ? 'grabbing' : 'grab' }}
      >
        <EdgeMarkerDefs />
        <g transform={`translate(${viewport.x}, ${viewport.y}) scale(${viewport.scale})`}>
          {layout.edges.map((edge, i) => (
            <GraphEdgeComponent key={i} edge={edge} markerId={`ive-arrow-${edge.kind}`} />
          ))}
          {layout.nodes.map(node => (
            <GraphNodeComponent
              key={node.id}
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
            />
          ))}
        </g>
        <text x={8} y={layout.height * viewport.scale + viewport.y - 4} fontSize={10} fill="rgba(255,255,255,0.2)" style={{ userSelect: 'none', pointerEvents: 'none' }}>
          {data.nodes.length} nodes · {data.edges.length} edges
        </text>
      </svg>
    </div>
  );
}
