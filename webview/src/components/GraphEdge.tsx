import type { ForceNode } from '../hooks/useGraphLayout';
import type { GraphEdge } from '../types';

interface Props {
  edge: GraphEdge;
  sourceNode: ForceNode;
  targetNode: ForceNode;
  markerId: string;
}

/** Clip a line from (sx,sy) to (cx,cy) at the boundary of a rectangle centered at (sx,sy). */
function clipToRect(sx: number, sy: number, tx: number, ty: number, hw: number, hh: number): { x: number; y: number } {
  const dx = tx - sx;
  const dy = ty - sy;
  if (dx === 0 && dy === 0) return { x: sx, y: sy };

  // Scale factor to hit the rectangle boundary
  const scaleX = hw / Math.abs(dx || 1);
  const scaleY = hh / Math.abs(dy || 1);
  const scale = Math.min(scaleX, scaleY);

  return { x: sx + dx * scale, y: sy + dy * scale };
}

export function GraphEdgeComponent({ edge, sourceNode, targetNode, markerId }: Props) {
  const isCycle = edge.isCycle === true;
  const color = isCycle ? 'rgba(200,130,0,0.8)' : 'rgba(150,150,170,0.55)';

  const scx = sourceNode.x + sourceNode.width / 2;
  const scy = sourceNode.y + sourceNode.height / 2;
  const tcx = targetNode.x + targetNode.width / 2;
  const tcy = targetNode.y + targetNode.height / 2;

  const hw = sourceNode.width / 2;
  const hh = sourceNode.height / 2;
  const thw = targetNode.width / 2;
  const thh = targetNode.height / 2;

  // Clip endpoints to node bounding boxes
  const start = clipToRect(scx, scy, tcx, tcy, hw, hh);
  const end = clipToRect(tcx, tcy, scx, scy, thw, thh);

  // Quadratic Bezier control point: offset perpendicular to the line
  const mx = (start.x + end.x) / 2;
  const my = (start.y + end.y) / 2;
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const curvature = 0.15;
  const cx = mx - dy * curvature;
  const cy = my + dx * curvature;

  const d = `M ${start.x} ${start.y} Q ${cx} ${cy} ${end.x} ${end.y}`;

  return (
    <path
      d={d}
      fill="none"
      stroke={color}
      strokeWidth={isCycle ? 2 : 1.5}
      strokeDasharray={isCycle ? '6 3' : undefined}
      markerEnd={`url(#${markerId})`}
    />
  );
}

export function EdgeMarkerDefs() {
  return (
    <defs>
      <marker
        id="ive-arrow-call"
        viewBox="0 0 8 8"
        refX={7}
        refY={4}
        markerWidth={6}
        markerHeight={6}
        orient="auto"
      >
        <path d="M0,0 L8,4 L0,8 Z" fill="rgba(150,150,170,0.7)" />
      </marker>
    </defs>
  );
}
