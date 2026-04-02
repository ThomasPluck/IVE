import { useState, useEffect, useRef, useCallback } from 'react';
import { forceSimulation, forceLink, forceManyBody, forceCenter, forceCollide, forceX, forceY, type Simulation } from 'd3-force';
import type { GraphData, GraphNode, GraphEdge } from '../types';

export const NODE_WIDTH = 180;
export const NODE_HEIGHT = 52;

export interface ForceNode extends GraphNode {
  x: number;
  y: number;
  width: number;
  height: number;
  vx?: number;
  vy?: number;
  fx?: number | null;
  fy?: number | null;
  index?: number;
}

export interface ForceEdge extends GraphEdge {
  source: ForceNode;
  target: ForceNode;
}

export interface ForceLayout {
  nodes: ForceNode[];
  edges: ForceEdge[];
  onNodeDrag: (id: number, x: number, y: number) => void;
  onNodeDragEnd: (id: number) => void;
}

// Bounding circle radius for 180x52 rectangle collision
const COLLIDE_RADIUS = Math.sqrt((NODE_WIDTH / 2) ** 2 + (NODE_HEIGHT / 2) ** 2) + 4;

export function useForceLayout(data: GraphData | null): ForceLayout | null {
  const [, setRenderToken] = useState(0);
  const simRef = useRef<Simulation<ForceNode, ForceEdge> | null>(null);
  const nodesRef = useRef<ForceNode[]>([]);
  const edgesRef = useRef<ForceEdge[]>([]);
  const rafRef = useRef<number>(0);
  const needsRenderRef = useRef(false);

  // Stable rAF render loop — decoupled from simulation ticks
  useEffect(() => {
    let running = true;
    function loop() {
      if (!running) return;
      if (needsRenderRef.current) {
        needsRenderRef.current = false;
        setRenderToken(t => t + 1);
      }
      rafRef.current = requestAnimationFrame(loop);
    }
    rafRef.current = requestAnimationFrame(loop);
    return () => { running = false; cancelAnimationFrame(rafRef.current); };
  }, []);

  useEffect(() => {
    if (!data || data.nodes.length === 0) {
      if (simRef.current) { simRef.current.stop(); simRef.current = null; }
      nodesRef.current = [];
      edgesRef.current = [];
      needsRenderRef.current = true;
      return;
    }

    // Preserve positions of existing nodes
    const oldPositions = new Map<number, { x: number; y: number }>();
    for (const n of nodesRef.current) {
      oldPositions.set(n.id, { x: n.x, y: n.y });
    }

    const isReheat = oldPositions.size > 0;

    const nodes: ForceNode[] = data.nodes.map((n, i) => {
      const old = oldPositions.get(n.id);
      return {
        ...n,
        x: old?.x ?? (Math.cos(i * 2.4) * Math.sqrt(data.nodes.length) * 30),
        y: old?.y ?? (Math.sin(i * 2.4) * Math.sqrt(data.nodes.length) * 30),
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
      };
    });

    const nodeMap = new Map(nodes.map(n => [n.id, n]));

    const edges: ForceEdge[] = data.edges
      .filter(e => nodeMap.has(e.sourceId) && nodeMap.has(e.targetId))
      .map(e => ({
        ...e,
        source: nodeMap.get(e.sourceId)!,
        target: nodeMap.get(e.targetId)!,
      }));

    nodesRef.current = nodes;
    edgesRef.current = edges;

    // Stop old simulation
    if (simRef.current) simRef.current.stop();

    const sim = forceSimulation<ForceNode>(nodes)
      .force('link', forceLink<ForceNode, ForceEdge>(edges)
        .id(d => d.id)
        .distance(120)
        .strength(0.4))
      .force('charge', forceManyBody<ForceNode>().strength(-300))
      .force('center', forceCenter(0, 0).strength(0.05))
      .force('gravityX', forceX<ForceNode>(0).strength(0.01))
      .force('gravityY', forceY<ForceNode>(0).strength(0.01))
      .force('collide', forceCollide<ForceNode>(COLLIDE_RADIUS).strength(0.7))
      .alphaDecay(0.02)
      .velocityDecay(0.3);

    if (isReheat) {
      sim.alpha(0.3);
    }

    // Just flag that we need a render — the rAF loop picks it up
    sim.on('tick', () => {
      needsRenderRef.current = true;
    });

    simRef.current = sim;

    return () => { sim.stop(); };
  }, [data]);

  // Stable drag callbacks — no dependencies that change per-render
  const onNodeDrag = useCallback((id: number, x: number, y: number) => {
    const node = nodesRef.current.find(n => n.id === id);
    if (!node) return;
    node.fx = x;
    node.fy = y;
    const sim = simRef.current;
    if (sim) {
      // Only reheat if simulation has cooled significantly
      if (sim.alpha() < 0.05) sim.alpha(0.1);
      sim.restart();
    }
    needsRenderRef.current = true;
  }, []);

  const onNodeDragEnd = useCallback((id: number) => {
    const node = nodesRef.current.find(n => n.id === id);
    if (!node) return;
    node.fx = null;
    node.fy = null;
  }, []);

  if (!data || data.nodes.length === 0 || nodesRef.current.length === 0) return null;

  return {
    nodes: nodesRef.current,
    edges: edgesRef.current,
    onNodeDrag,
    onNodeDragEnd,
  };
}
