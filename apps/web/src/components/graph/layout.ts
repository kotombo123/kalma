/**
 * Positions for the four fixed columns. dagre orders nodes inside each column so edges cross as
 * little as possible; x always comes from the column, so the pad's columns stay straight.
 */
import dagre from '@dagrejs/dagre';
import type { GraphEdge, GraphNode, GraphNodeKind } from '@alerting/contracts';
import { COLUMNS } from './model.ts';

export const NODE_W = 220;
export const NODE_H = 54;
export const COL_W = 300;
export const ROW_GAP = 12;
export const HEADER_H = 56;

const columnOf = new Map<GraphNodeKind, number>(COLUMNS.map((c, i) => [c.kind, i]));

export interface Placed {
  node: GraphNode;
  x: number;
  y: number;
}

export function layout(nodes: GraphNode[], edges: GraphEdge[]) {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', nodesep: ROW_GAP, ranksep: 80 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes) g.setNode(n.id, { width: NODE_W, height: NODE_H });
  for (const e of edges) if (e.kind !== 'escalations') g.setEdge(e.source, e.target, { weight: e.weight });
  dagre.layout(g);

  const columns = COLUMNS.map(() => [] as { node: GraphNode; order: number }[]);
  for (const n of nodes) columns[columnOf.get(n.kind)!]!.push({ node: n, order: g.node(n.id)?.y ?? 0 });

  const tallest = Math.max(1, ...columns.map((c) => c.length));
  const height = tallest * (NODE_H + ROW_GAP);
  const placed: Placed[] = [];
  columns.forEach((col, i) => {
    col.sort((a, b) => a.order - b.order);
    // Shorter columns are centred against the tallest one.
    const top = HEADER_H + (height - col.length * (NODE_H + ROW_GAP)) / 2;
    col.forEach(({ node }, j) => placed.push({ node, x: i * COL_W, y: top + j * (NODE_H + ROW_GAP) }));
  });
  return { placed, height: HEADER_H + height };
}
