import { useState, useEffect } from 'react';
import ELK from 'elkjs/lib/elk.bundled.js';
import type { GraphData, GraphNode, GraphEdge } from '../types';

const elk = new ELK();

const NODE_WIDTH = 180;
const NODE_HEIGHT = 52;

export interface LayoutNode extends GraphNode {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayoutEdge extends GraphEdge {
  // ELK bend-point sections
  points: Array<{ x: number; y: number }>;
}

export interface GraphLayout {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  width: number;
  height: number;
}

export function useGraphLayout(data: GraphData | null): GraphLayout | null {
  const [layout, setLayout] = useState<GraphLayout | null>(null);

  useEffect(() => {
    if (!data || data.nodes.length === 0) {
      setLayout(null);
      return;
    }

    let cancelled = false;

    async function compute() {
      if (!data) return;

      const elkNodes = data.nodes.map((n) => ({
        id: String(n.id),
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
      }));

      const elkEdges = data.edges.map((e, i) => ({
        id: `e${i}`,
        sources: [String(e.sourceId)],
        targets: [String(e.targetId)],
      }));

      const graph = {
        id: 'root',
        layoutOptions: {
          'elk.algorithm': 'layered',
          'elk.direction': 'DOWN',
          'elk.spacing.nodeNode': '48',
          'elk.layered.spacing.nodeNodeBetweenLayers': '64',
          'elk.edgeRouting': 'ORTHOGONAL',
          'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
        },
        children: elkNodes,
        edges: elkEdges,
      };

      try {
        const result = await elk.layout(graph);
        if (cancelled) return;

        const nodeMap = new Map<number, GraphNode>(data.nodes.map((n) => [n.id, n]));

        const layoutNodes: LayoutNode[] = (result.children ?? []).map((en) => {
          const n = nodeMap.get(Number(en.id))!;
          return {
            ...n,
            x: en.x ?? 0,
            y: en.y ?? 0,
            width: en.width ?? NODE_WIDTH,
            height: en.height ?? NODE_HEIGHT,
          };
        });

        const layoutEdges: LayoutEdge[] = (result.edges ?? []).map((ee, i) => {
          const orig = data.edges[i];
          // Flatten all sections into a single polyline
          const points: Array<{ x: number; y: number }> = [];
          if (ee.sections && ee.sections.length > 0) {
            const s = ee.sections[0];
            if (s.startPoint) points.push(s.startPoint);
            if (s.bendPoints) points.push(...s.bendPoints);
            if (s.endPoint) points.push(s.endPoint);
          }
          return { ...orig, points };
        });

        const maxX = Math.max(...layoutNodes.map((n) => n.x + n.width), 400);
        const maxY = Math.max(...layoutNodes.map((n) => n.y + n.height), 300);

        setLayout({ nodes: layoutNodes, edges: layoutEdges, width: maxX + 40, height: maxY + 40 });
      } catch (err) {
        console.error('IVE: ELK layout failed', err);
      }
    }

    compute();
    return () => { cancelled = true; };
  }, [data]);

  return layout;
}
