/**
 * F-20 — dependency graph: sources → rules → teams → people on the columnar pad. Line width is the
 * alert volume; the margin mark flags a noisy system or an overloaded person (vs the average).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  Controls,
  ReactFlow,
  ReactFlowProvider,
  type Edge,
  type NodeTypes,
  type OnNodesChange,
  useReactFlow,
} from '@xyflow/react';
import type { GraphResponse } from '@alerting/contracts';
import { api, type ApiError } from '../lib/api.ts';
import type { Page, TeamSummary } from '../lib/types.ts';
import {
  ColumnNode,
  LedgerNode,
  type ColumnFlowNode,
  type LedgerFlowNode,
} from '../components/graph/LedgerNode.tsx';
import { Legend } from '../components/graph/Legend.tsx';
import { NodePanel } from '../components/graph/NodePanel.tsx';
import { COL_W, layout, NODE_W } from '../components/graph/layout.ts';
import { COLUMNS, fmtNum, fmtRatio, RANGES, type RangeId } from '../components/graph/model.ts';
import { usePersona } from '../lib/roles.ts';
import '../components/graph/graph.css';

const nodeTypes: NodeTypes = { ledger: LedgerNode, column: ColumnNode };

function useGraph(range: RangeId, teamId: string) {
  return useQuery({
    queryKey: ['graph', range, teamId],
    queryFn: () => {
      const to = new Date();
      const from = new Date(to.getTime() - RANGES.find((r) => r.id === range)!.ms);
      const q = new URLSearchParams({ from: from.toISOString(), to: to.toISOString() });
      if (teamId) q.set('teamId', teamId);
      return api<GraphResponse>(`/graph?${q}`);
    },
    staleTime: 30_000,
  });
}

function Flow({
  data,
  onSelect,
  selectedId,
}: {
  data: GraphResponse;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const { t } = useTranslation();
  const { nodes, edges } = useMemo(() => {
    const { placed, height } = layout(data.nodes, data.edges);
    // Everything connected to the selected node stays in full ink; the rest fades.
    const related = new Set<string>();
    if (selectedId) {
      related.add(selectedId);
      for (const e of data.edges)
        if (e.source === selectedId || e.target === selectedId) related.add(e.source).add(e.target);
    }
    const dim = (id: string) => selectedId !== null && !related.has(id);

    const columns: ColumnFlowNode[] = COLUMNS.map((c, i) => ({
      id: `column:${c.kind}`,
      type: 'column',
      position: { x: i * COL_W, y: 0 },
      data: { title: c.title, hint: c.hint, height: height + 16 },
      draggable: false,
      selectable: false,
      focusable: false,
      zIndex: -1,
      width: NODE_W + 40,
    }));
    const entries: LedgerFlowNode[] = placed.map(({ node, x, y }) => ({
      id: node.id,
      type: 'ledger',
      position: { x, y },
      data: { node, dimmed: dim(node.id) },
      draggable: false,
      selected: node.id === selectedId,
      ariaLabel: t('graph.nodeAria', { label: node.label, count: fmtNum(node.alerts) }),
    }));

    const max = Math.max(1, ...data.edges.map((e) => e.weight));
    const lines: Edge[] = data.edges.map((e) => {
      const faded =
        selectedId !== null &&
        !(
          related.has(e.source) &&
          related.has(e.target) &&
          (e.source === selectedId || e.target === selectedId)
        );
      const escalation = e.kind === 'escalations';
      return {
        id: e.id,
        source: e.source,
        target: e.target,
        focusable: false,
        selectable: false,
        ariaLabel: t(escalation ? 'graph.edgeEscalations' : 'graph.edgeAlerts', { count: fmtNum(e.weight) }),
        style: {
          stroke: escalation ? 'var(--margin)' : 'var(--ink-soft)',
          strokeWidth: escalation ? 1.5 : 1 + 9 * Math.sqrt(e.weight / max),
          strokeDasharray: escalation ? '5 4' : undefined,
          opacity: faded ? 0.12 : escalation ? 0.9 : 0.45,
          transition: 'opacity 150ms',
        },
      };
    });
    return { nodes: [...columns, ...entries], edges: lines };
  }, [data, selectedId, t]);

  // The canvas shrinks when the side panel opens (and with the window): refit so every column
  // stays visible.
  const flow = useReactFlow();
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let frame = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        // Phones: a readable zoom from the first column, panned by finger, beats a tiny whole graph.
        if (el.clientWidth < 700) void flow.setViewport({ x: 12, y: 8, zoom: 0.62 });
        else void flow.fitView({ padding: 0.08, duration: reduce ? 0 : 150 });
      });
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [flow]);

  // Controlled nodes: React Flow reports clicks and Enter on a focused node as `select` changes.
  const onNodesChange: OnNodesChange = (changes) => {
    for (const c of changes)
      if (c.type === 'select' && c.selected && c.id.includes(':') && !c.id.startsWith('column:'))
        onSelect(c.id);
  };

  return (
    <div ref={box} className="absolute inset-0">
      <ReactFlow
        className="graph-flow"
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onPaneClick={() => onSelect(null)}
        nodesConnectable={false}
        nodesDraggable={false}
        fitView
        fitViewOptions={{ padding: 0.08 }}
        minZoom={0.2}
        proOptions={{ hideAttribution: true }}
      >
        <Controls showInteractive={false} position="bottom-left" aria-label={t('graph.zoomControls')} />
      </ReactFlow>
    </div>
  );
}

/**
 * The two or three things worth knowing, as sentences above the graph (implementation_plan.md §5.10):
 * the noisiest systems and the most loaded people, measured the same way as the margin marks.
 */
function Insights({ data, onPick }: { data: GraphResponse; onPick: (id: string) => void }) {
  const { t } = useTranslation();
  const noisy = data.nodes
    .filter((n) => n.kind === 'source' && (n.noise ?? 0) >= 1.2)
    .sort((a, b) => (b.noise ?? 0) - (a.noise ?? 0))
    .slice(0, 2);
  const loaded = data.nodes
    .filter((n) => n.kind === 'user' && (n.load ?? 0) >= 1.2)
    .sort((a, b) => (b.load ?? 0) - (a.load ?? 0))
    .slice(0, 2);
  const lines = [
    ...noisy.map((n) => ({
      id: n.id,
      high: (n.noise ?? 0) >= 1.5,
      text: t('graph.insightNoisy', {
        label: `${n.label}${n.sublabel ? ` (${n.sublabel})` : ''}`,
        ratio: fmtRatio(n.noise!),
      }),
    })),
    ...loaded.map((n) => ({
      id: n.id,
      high: (n.load ?? 0) >= 1.5,
      text: t('graph.insightLoaded', {
        label: n.label,
        ratio: fmtRatio(n.load!),
        team: n.sublabel ? ` ${n.sublabel}` : '',
      }),
    })),
  ];
  if (lines.length === 0)
    return <p className="px-6 pt-3 text-sm text-ink-soft">{t('graph.insightsBalanced')}</p>;
  return (
    <section aria-labelledby="insights" className="px-6 pt-3">
      <h2 id="insights" className="sr-only">
        {t('graph.insightsTitle')}
      </h2>
      <ul className="space-y-1">
        {lines.map((l) => (
          <li key={l.id}>
            <button
              type="button"
              onClick={() => onPick(l.id)}
              className="flex items-baseline gap-2 text-left hover:underline"
            >
              <span
                aria-hidden
                className="h-3 w-1 shrink-0 translate-y-0.5 rounded-full"
                style={{ background: l.high ? 'var(--critical)' : 'var(--warning)' }}
              />
              {l.text}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function GraphPage() {
  const { t } = useTranslation();
  const { persona, leadTeams } = usePersona();
  const [range, setRange] = useState<RangeId>('7d');
  // a lead starts with their own team; an admin with the whole org
  const [teamId, setTeamId] = useState(persona === 'lead' && leadTeams.length === 1 ? leadTeams[0]!.id : '');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const graph = useGraph(range, teamId);
  const teams = useQuery({ queryKey: ['teams'], queryFn: () => api<Page<TeamSummary>>('/teams?limit=100') });
  const selected = graph.data?.nodes.find((n) => n.id === selectedId) ?? null;
  const empty = graph.data && !graph.data.nodes.some((n) => n.kind !== 'user');

  return (
    <div className="flex h-full flex-col" onKeyDown={(e) => e.key === 'Escape' && setSelectedId(null)}>
      <header className="flex flex-wrap items-end gap-x-6 gap-y-3 border-b border-rule px-6 py-4">
        <div className="mr-auto max-w-[72ch]">
          <h1 className="text-2xl font-bold">{t('graph.title')}</h1>
          <p className="text-ink-soft">{t('graph.subtitle')}</p>
        </div>
        <div
          role="group"
          aria-label={t('graph.timeRange')}
          className="flex rounded-control border border-rule bg-sheet p-0.5"
        >
          {RANGES.map((r) => (
            <button
              key={r.id}
              type="button"
              aria-pressed={range === r.id}
              onClick={() => setRange(r.id)}
              className={`h-7 rounded-[4px] px-2.5 text-sm font-semibold ${range === r.id ? 'bg-ink text-sheet' : 'text-ink hover:bg-rule/40'}`}
            >
              {t(r.label)}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-2 text-sm font-semibold">
          {t('graph.team')}
          <select
            value={teamId}
            onChange={(e) => {
              setTeamId(e.target.value);
              setSelectedId(null);
            }}
            className="h-8 rounded-control border border-rule bg-sheet px-2 font-normal text-ink"
          >
            <option value="">{t('graph.allTeams')}</option>
            {teams.data?.data.map((tm) => (
              <option key={tm.id} value={tm.id}>
                {tm.name}
              </option>
            ))}
          </select>
        </label>
        <div className="basis-full">
          <Legend />
          <p className="mt-1 text-xs text-ink-soft md:hidden">{t('graph.swipeHint')}</p>
        </div>
      </header>

      {graph.data && !empty && <Insights data={graph.data} onPick={setSelectedId} />}

      <div className="relative flex min-h-[420px] flex-1">
        <div className="relative min-w-0 flex-1">
          {graph.isPending && <p className="px-6 py-5 text-ink-soft">{t('graph.loading')}</p>}
          {graph.isError && (
            <p className="px-6 py-5 text-critical" role="alert">
              {t('graph.loadError', { message: (graph.error as ApiError).message })}
            </p>
          )}
          {empty && <p className="max-w-[72ch] px-6 py-5 text-ink-soft">{t('graph.empty')}</p>}
          {graph.data && !empty && (
            <ReactFlowProvider>
              <Flow data={graph.data} selectedId={selectedId} onSelect={setSelectedId} />
            </ReactFlowProvider>
          )}
        </div>
        {selected && <NodePanel node={selected} onClose={() => setSelectedId(null)} />}
      </div>
    </div>
  );
}
