import type { LayoutNode } from '../hooks/useGraphLayout';

interface Props {
  node: LayoutNode;
  isRoot: boolean;
  hasCallees: boolean;
  isInCycle: boolean;
  isHighChurn: boolean;
  isDeadCode: boolean;
  isHighCoupling: boolean;
  isHighImpact: boolean;
  onClick: (node: LayoutNode) => void;
  onDrillDown: (node: LayoutNode) => void;
  onNavigate: (filePath: string, line: number) => void;
}

function diffStripeColor(status: string | undefined): string | null {
  switch (status) {
    case 'added':    return '#2d9a4e';
    case 'modified': return '#c87a00';
    case 'deleted':  return '#9a2d2d';
    default: return null;
  }
}

/** Map cyclomatic complexity to a color on a green→yellow→red scale. */
function complexityColor(complexity: number | undefined): string {
  if (complexity === undefined) return 'var(--vscode-badge-background, #3a3d41)';
  if (complexity <= 3) return '#2d7a3a';   // green
  if (complexity <= 6) return '#7a6a1a';   // amber
  if (complexity <= 10) return '#9a4a1a';  // orange
  return '#8b1a1a';                         // red
}

function kindIcon(kind: string): string {
  switch (kind) {
    case 'function': return 'ƒ';
    case 'method': return 'm';
    case 'class': return 'C';
    default: return '◆';
  }
}

export function GraphNodeComponent({ node, isRoot, hasCallees, isInCycle, isHighChurn, isDeadCode, isHighCoupling, isHighImpact, onClick, onDrillDown, onNavigate }: Props) {
  const color = complexityColor(node.complexity);
  const diffStripe = diffStripeColor(node.diffStatus);
  const borderColor = isDeadCode
    ? '#8b1a1a'
    : isInCycle
      ? '#c87a00'
      : isRoot
        ? 'var(--vscode-focusBorder, #007acc)'
        : 'rgba(255,255,255,0.12)';
  const strokeWidth = isRoot || isInCycle || isDeadCode ? 2 : 1;
  const cursor = hasCallees ? 'pointer' : 'default';

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onClick(node);
  };

  const handleDoubleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (hasCallees) {
      onDrillDown(node);
    } else {
      onNavigate(node.filePath, node.line);
    }
  };

  // Truncate long names
  const displayName = node.name.length > 22 ? node.name.slice(0, 21) + '…' : node.name;

  return (
    <g
      transform={`translate(${node.x}, ${node.y})`}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      style={{ cursor }}
    >
      <rect
        width={node.width}
        height={node.height}
        rx={6}
        ry={6}
        fill={color}
        stroke={borderColor}
        strokeWidth={strokeWidth}
        strokeDasharray={isDeadCode ? '4 2' : undefined}
        opacity={isDeadCode ? 0.5 : 0.92}
      />
      {/* Diff status stripe — left edge */}
      {diffStripe && (
        <rect x={0} y={0} width={4} height={node.height} rx={2} ry={2} fill={diffStripe} opacity={0.9} />
      )}

      {/* Kind badge */}
      <rect x={0} y={0} width={22} height={node.height} rx={6} ry={6} fill="rgba(0,0,0,0.25)" />
      <rect x={14} y={0} width={8} height={node.height} fill="rgba(0,0,0,0.25)" />
      <text
        x={11}
        y={node.height / 2 + 5}
        textAnchor="middle"
        fontSize={12}
        fontFamily="monospace"
        fill="rgba(255,255,255,0.7)"
      >
        {kindIcon(node.kind)}
      </text>

      {/* Function name */}
      <text
        x={30}
        y={node.height / 2 - 4}
        fontSize={12}
        fontFamily="var(--vscode-font-family, monospace)"
        fill="var(--vscode-foreground, #cccccc)"
        dominantBaseline="middle"
      >
        {displayName}
      </text>

      {/* Metrics row */}
      <text
        x={30}
        y={node.height - 10}
        fontSize={9}
        fontFamily="monospace"
        fill="rgba(255,255,255,0.45)"
      >
        {[
          node.loc != null && `${node.loc}L`,
          node.complexity != null && `CC${node.complexity}`,
          (node.coupling ?? 0) > 0 && `c${node.coupling}`,
          (node.impactRadius ?? 0) > 0 && `i${node.impactRadius}`,
          node.maxLoopDepth != null && node.maxLoopDepth > 0 && `L${node.maxLoopDepth}`,
        ].filter(Boolean).join('  ')}
      </text>

      {/* Drill-down indicator */}
      {hasCallees && (
        <text
          x={node.width - 10}
          y={node.height / 2 + 5}
          textAnchor="middle"
          fontSize={10}
          fill="rgba(255,255,255,0.4)"
        >
          ▸
        </text>
      )}

      {/* High-churn badge: amber dot top-right */}
      {isHighChurn && (
        <circle cx={node.width - 6} cy={6} r={4} fill="#c87a00" opacity={0.9} />
      )}

      {/* Cycle badge */}
      {isInCycle && (
        <text x={node.width - 18} y={10} fontSize={9} fill="#c87a00" opacity={0.9}>↺</text>
      )}

      {/* High-coupling badge: purple dot */}
      {isHighCoupling && (
        <circle cx={node.width - 6} cy={node.height - 6} r={3} fill="#7a3db8" opacity={0.9} />
      )}

      {/* High-impact badge: blue dot */}
      {isHighImpact && (
        <circle cx={node.width - 14} cy={node.height - 6} r={3} fill="#2d7acc" opacity={0.9} />
      )}

      {/* Dead code badge */}
      {isDeadCode && (
        <text x={node.width - 18} y={node.height - 4} fontSize={8} fill="#8b1a1a" opacity={0.9}>dead</text>
      )}

      {/* Tooltip */}
      <title>{[
        `${node.name}${node.module ? ` [${node.module}]` : ''}`,
        `${node.filePath}:${node.line}`,
        `LOC: ${node.loc}  CC: ${node.complexity ?? '?'}  Cognitive: ${node.cognitiveComplexity ?? '?'}  Params: ${node.parameterCount ?? '?'}  Loop depth: ${node.maxLoopDepth ?? '?'}`,
        node.fanIn != null ? `Fan-in: ${node.fanIn}  Fan-out: ${node.fanOut}  Coupling: ${node.coupling}  Depth: ${node.depthFromEntry}  Impact: ${node.impactRadius}` : null,
        node.churnCount != null ? `Churn: ${node.churnCount} commits (${node.recentChurnCount ?? 0} recent)` : null,
        isDeadCode ? '☠ Dead code — unreachable from entry points' : null,
        isInCycle ? '⚠ Participates in a call cycle' : null,
        'Click to inspect' + (hasCallees ? ' · Double-click to drill down' : ' · Double-click to navigate'),
      ].filter(Boolean).join('\n')}</title>
    </g>
  );
}
