import { useState, useCallback, useEffect } from 'react';
import { useVSCode } from './hooks/useVSCode';
import { CodeGraph } from './components/CodeGraph';
import { SearchBar } from './components/SearchBar';
import { NodeDetailPanel } from './components/NodeDetailPanel';
import type { GraphData, ExtensionToWebviewMessage, DrillEntry, DashboardData, NodeDetailData } from './types';

export default function App() {
  const [graphData, setGraphData] = useState<GraphData | null>(null);
  const [cleanGraphData, setCleanGraphData] = useState<GraphData | null>(null);
  const [diffMode, setDiffMode] = useState(false);
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null);
  const [drillStack, setDrillStack] = useState<DrillEntry[]>([]);
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [nodeDetail, setNodeDetail] = useState<NodeDetailData | null>(null);
  const [highlightedNodeIds, setHighlightedNodeIds] = useState<Set<number>>(new Set());

  const onMessage = useCallback((msg: ExtensionToWebviewMessage) => {
    switch (msg.type) {
      case 'graphData':
        setGraphData(msg.data);
        setCleanGraphData(msg.data);
        setDiffMode(false);
        setProgress(null);
        setHighlightedNodeIds(new Set());
        break;
      case 'diffData':
        setGraphData(msg.data);
        setDiffMode(true);
        break;
      case 'indexProgress':
        setProgress({ current: msg.current, total: msg.total });
        break;
      case 'coverageData':
        break; // Superseded by dashboard
      case 'dashboard':
        setDashboard(msg.data);
        break;
      case 'nodeDetail':
        setNodeDetail(msg.data);
        break;
      case 'highlightNodes':
        setHighlightedNodeIds(new Set(msg.nodeIds));
        break;
    }
  }, []);

  const { postMessage } = useVSCode(onMessage);

  useEffect(() => {
    postMessage({ type: 'ready' });
  }, [postMessage]);

  const handleNavigate = useCallback((filePath: string, line: number) => {
    postMessage({ type: 'navigate', filePath, line });
  }, [postMessage]);

  const handleSearch = useCallback((query: string) => {
    postMessage(query.trim() ? { type: 'search', query } : { type: 'ready' });
  }, [postMessage]);

  const handleShowDeadCode = useCallback(() => {
    postMessage({ type: 'showDeadCode' });
  }, [postMessage]);

  const handleToggleDiff = useCallback(() => {
    if (diffMode) {
      setGraphData(cleanGraphData);
      setDiffMode(false);
    } else {
      postMessage({ type: 'getDiff' });
    }
  }, [diffMode, cleanGraphData, postMessage]);

  const handleDrillDown = useCallback((symbolId: number) => {
    const node = graphData?.nodes.find(n => n.id === symbolId);
    if (!node) return;
    setDrillStack(prev => [...prev, { symbolId, name: node.name }]);
    postMessage({ type: 'drillDown', symbolId });
  }, [postMessage, graphData]);

  const handleDrillUp = useCallback((_parentId: number | null) => {
    setDrillStack(prev => {
      const next = prev.slice(0, -1);
      const parentId = next.length > 0 ? next[next.length - 1].symbolId : null;
      postMessage({ type: 'drillUp', parentId });
      return next;
    });
  }, [postMessage]);

  const handleSelectNode = useCallback((node: import('./types').GraphNode) => {
    postMessage({ type: 'selectNode', symbolId: node.id });
  }, [postMessage]);

  return (
    <div className="ive-app">
      {progress && (
        <div className="ive-progress">Indexing… {progress.current}/{progress.total}</div>
      )}
      <SearchBar onSearch={handleSearch} />
      <CodeGraph
        data={graphData}
        dashboard={dashboard}
        onNavigate={handleNavigate}
        onDrillDown={handleDrillDown}
        onDrillUp={handleDrillUp}
        onToggleDiff={handleToggleDiff}
        drillStack={drillStack}
        diffMode={diffMode}
        onShowDeadCode={handleShowDeadCode}
        onSelectNode={handleSelectNode}
        highlightedNodeIds={highlightedNodeIds}
        onClearHighlight={() => setHighlightedNodeIds(new Set())}
      />
      <NodeDetailPanel
        detail={nodeDetail}
        onDismiss={() => setNodeDetail(null)}
        onNavigate={handleNavigate}
        onSelectNode={(id) => postMessage({ type: 'selectNode', symbolId: id })}
      />
    </div>
  );
}
