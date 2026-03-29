import type { DashboardData, GraphData } from '../types';

interface Props {
  dashboard: DashboardData | null;
  data: GraphData | null;
  onShowDeadCode: () => void;
}

export function CoveragePanel({ dashboard, data, onShowDeadCode }: Props) {
  if (!dashboard || !data) return null;

  const { coverage, annotationCount, architectureStatus, lastPerf, risks } = dashboard;
  const deadCount = coverage.deadCodeIds.length;
  const cycleCount = data.edges.filter(e => e.isCycle).length;
  const modules = new Set(data.nodes.map(n => n.module).filter(Boolean));
  const depths = data.nodes.map(n => n.depthFromEntry ?? -1).filter(d => d >= 0);
  const maxDepth = depths.length > 0 ? Math.max(...depths) : 0;

  return (
    <div className="ive-coverage-panel">
      <span className="ive-coverage-stat">
        <strong>{coverage.coveragePercent}%</strong> covered
      </span>
      <span className="ive-coverage-stat ive-coverage-dim">{coverage.totalFunctions} fn</span>
      {deadCount > 0 && (
        <button className="ive-coverage-dead" onClick={onShowDeadCode} title="Highlight dead code">
          {deadCount} dead
        </button>
      )}
      {cycleCount > 0 && <span className="ive-coverage-stat ive-coverage-warn">{cycleCount} cycle edges</span>}
      <span className="ive-coverage-stat ive-coverage-dim">{modules.size} modules</span>
      <span className="ive-coverage-stat ive-coverage-dim">depth 0–{maxDepth}</span>

      {/* Architecture */}
      {architectureStatus.compliant > 0 && (
        <span className={`ive-coverage-stat ${architectureStatus.pass ? '' : 'ive-coverage-warn'}`}>
          arch: {architectureStatus.pass ? 'pass' : `${architectureStatus.violations} violations`}
        </span>
      )}

      {/* Annotations */}
      <span className="ive-coverage-stat ive-coverage-dim">{annotationCount} annotated</span>
      {risks.length > 0 && (
        <span className="ive-coverage-stat ive-coverage-warn" title="Unannotated high-risk functions">
          {risks.length} risks
        </span>
      )}

      {/* Perf */}
      {lastPerf && (
        <span className="ive-coverage-stat ive-coverage-dim" title="Last index time">
          {lastPerf.skipped ? 'cached' : `${lastPerf.totalMs}ms`}
        </span>
      )}

      <Legend />
    </div>
  );
}

function Legend() {
  return (
    <span className="ive-legend">
      <span className="ive-legend-item" title="Cyclomatic complexity: green=low, red=high">
        <span className="ive-legend-swatch" style={{ background: '#2d7a3a' }} />CC
      </span>
      <span className="ive-legend-item" title="High git churn (top 20%)">
        <span className="ive-legend-dot" style={{ background: '#c87a00' }} />churn
      </span>
      <span className="ive-legend-item" title="High coupling (top 20%)">
        <span className="ive-legend-dot" style={{ background: '#7a3db8' }} />coupling
      </span>
      <span className="ive-legend-item" title="High impact radius (top 20%)">
        <span className="ive-legend-dot" style={{ background: '#2d7acc' }} />impact
      </span>
      <span className="ive-legend-item" title="Participates in a call cycle">
        <span style={{ color: '#c87a00', fontSize: 9 }}>↺</span>cycle
      </span>
    </span>
  );
}
