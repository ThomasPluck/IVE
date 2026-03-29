import type { LayoutEdge } from '../hooks/useGraphLayout';

interface Props {
  edge: LayoutEdge;
  markerId: string;
}

export function GraphEdgeComponent({ edge, markerId }: Props) {
  if (edge.points.length < 2) return null;

  const isCycle = edge.isCycle === true;
  const color = isCycle ? 'rgba(200,130,0,0.8)' : 'rgba(150,150,170,0.55)';

  const [first, ...rest] = edge.points;
  const d = `M ${first.x} ${first.y} ` + rest.map(p => `L ${p.x} ${p.y}`).join(' ');

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
