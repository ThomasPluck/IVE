import type { GraphNode, NodeDetailData } from '../types';

interface Props {
  detail: NodeDetailData | null;
  onDismiss: () => void;
  onNavigate: (filePath: string, line: number) => void;
  onSelectNode: (symbolId: number) => void;
}

function relPath(filePath: string): string {
  const parts = filePath.replace(/\\/g, '/').split('/');
  const srcIdx = parts.indexOf('src');
  return srcIdx >= 0 ? parts.slice(srcIdx).join('/') : parts.slice(-3).join('/');
}

export function NodeDetailPanel({ detail, onDismiss, onNavigate, onSelectNode }: Props) {
  if (!detail) return null;
  const { node, callers, callees, annotations } = detail;

  return (
    <div className="ive-detail-panel">
      <div className="ive-detail-header">
        <span className="ive-detail-title">{node.name}</span>
        <span className="ive-detail-kind">{node.kind}</span>
        <button className="ive-detail-close" onClick={onDismiss}>✕</button>
      </div>

      <div className="ive-detail-body">
        <button className="ive-detail-file" onClick={() => onNavigate(node.filePath, node.line)} title="Open in editor">
          {relPath(node.filePath)}:{node.line}–{node.endLine}
        </button>

        {node.module && <div className="ive-detail-module">{node.module}</div>}

        {/* Annotations */}
        {annotations.length > 0 && (
          <div className="ive-detail-section">
            <div className="ive-detail-label">Annotations</div>
            {annotations.map((a, i) => (
              <div key={i} className="ive-detail-annotation">
                <div className="ive-detail-ann-tags">{a.tags.join(', ')}</div>
                <div className="ive-detail-ann-label">{a.label}</div>
                {a.explanation && <div className="ive-detail-ann-explanation">{a.explanation}</div>}
                {a.algorithmicComplexity && <div className="ive-detail-ann-meta">Time: {a.algorithmicComplexity}</div>}
                {a.spatialComplexity && <div className="ive-detail-ann-meta">Space: {a.spatialComplexity}</div>}
                {a.pitfalls.length > 0 && (
                  <div className="ive-detail-ann-pitfalls">
                    {a.pitfalls.map((p, j) => <div key={j} className="ive-detail-ann-pitfall">{p}</div>)}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Complexity */}
        <div className="ive-detail-section">
          <div className="ive-detail-label">Complexity</div>
          <div className="ive-detail-grid">
            <Stat label="CC" value={node.complexity} warn={10} />
            <Stat label="Cognitive" value={node.cognitiveComplexity} warn={15} />
            <Stat label="LOC" value={node.loc} warn={100} />
            <Stat label="Params" value={node.parameterCount} warn={5} />
            <Stat label="Loop depth" value={node.maxLoopDepth} warn={3} />
          </div>
        </div>

        {/* Structure */}
        {node.fanIn != null && (
          <div className="ive-detail-section">
            <div className="ive-detail-label">Structure</div>
            <div className="ive-detail-grid">
              <Stat label="Fan-in" value={node.fanIn} />
              <Stat label="Fan-out" value={node.fanOut} />
              <Stat label="Coupling" value={node.coupling} warn={20} />
              <Stat label="Depth" value={node.depthFromEntry} warn={5} />
              <Stat label="Impact" value={node.impactRadius} warn={30} />
            </div>
          </div>
        )}

        {/* Callers */}
        {callers.length > 0 && (
          <div className="ive-detail-section">
            <div className="ive-detail-label">Callers ({callers.length})</div>
            {callers.map(c => (
              <button key={c.id} className="ive-detail-ref" onClick={() => onSelectNode(c.id)} title={c.callText}>
                <span className="ive-detail-ref-name">{c.name}</span>
                {c.callLine && <span className="ive-detail-ref-line">:{c.callLine}</span>}
                {c.callText && <span className="ive-detail-ref-text">{c.callText}</span>}
              </button>
            ))}
          </div>
        )}

        {/* Callees */}
        {callees.length > 0 && (
          <div className="ive-detail-section">
            <div className="ive-detail-label">Calls ({callees.length})</div>
            {callees.map(c => (
              <button key={c.id} className="ive-detail-ref" onClick={() => onSelectNode(c.id)} title={c.callText}>
                <span className="ive-detail-ref-name">{c.name}</span>
                {c.callLine && <span className="ive-detail-ref-line">:{c.callLine}</span>}
                {c.callText && <span className="ive-detail-ref-text">{c.callText}</span>}
              </button>
            ))}
          </div>
        )}

        {/* Churn */}
        {node.churnCount != null && (
          <div className="ive-detail-section">
            <div className="ive-detail-label">Git churn</div>
            <div className="ive-detail-value">{node.churnCount} commits ({node.recentChurnCount ?? 0} recent)</div>
          </div>
        )}

        {node.isDeadCode && <div className="ive-detail-warning">Dead code — unreachable from entry points</div>}
      </div>
    </div>
  );
}

function Stat({ label, value, warn }: { label: string; value?: number; warn?: number }) {
  if (value == null) return null;
  const isWarning = warn != null && value >= warn;
  return (
    <div className={`ive-detail-stat${isWarning ? ' ive-detail-stat--warn' : ''}`}>
      <span className="ive-detail-stat-value">{value}</span>
      <span className="ive-detail-stat-label">{label}</span>
    </div>
  );
}
