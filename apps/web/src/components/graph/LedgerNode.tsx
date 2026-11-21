import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import type { GraphNode } from '@alerting/contracts';
import { fmtNum, MARK_COLOR, markOf, markText } from './model.ts';

export type LedgerNodeData = { node: GraphNode; dimmed: boolean };
export type LedgerFlowNode = Node<LedgerNodeData, 'ledger'>;

/** One graph entry written on the pad: margin mark, name, small context line, alert count. */
export const LedgerNode = memo(function LedgerNode({ data, selected }: NodeProps<LedgerFlowNode>) {
  useTranslation(); // re-render on language change (markText reads i18n)
  const { node, dimmed } = data;
  const mark = markOf(node);
  const note = markText(node, mark);
  return (
    <div
      className={`graph-entry ${selected ? 'is-selected' : ''} ${dimmed ? 'is-dimmed' : ''}`}
      style={{ '--mark': mark ? MARK_COLOR[mark] : 'transparent' } as React.CSSProperties}
      title={[node.label, node.sublabel, note].filter(Boolean).join('\n')}
    >
      {node.kind !== 'source' && <Handle type="target" position={Position.Left} isConnectable={false} />}
      <span className="graph-entry-mark" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-semibold">{node.label}</span>
        <span className="block truncate text-xs text-ink-soft">{note ?? node.sublabel ?? ' '}</span>
      </span>
      <span className="num shrink-0 text-right font-semibold">{fmtNum(node.alerts)}</span>
      {node.kind !== 'user' && <Handle type="source" position={Position.Right} isConnectable={false} />}
    </div>
  );
});

export type ColumnNodeData = { title: string; hint: string; height: number };
export type ColumnFlowNode = Node<ColumnNodeData, 'column'>;

/** A pad column: header and the green column rule behind its entries. */
export function ColumnNode({ data }: NodeProps<ColumnFlowNode>) {
  const { t } = useTranslation();
  return (
    <div className="graph-column" style={{ height: data.height }}>
      <span className="font-semibold">{t(data.title)}</span>
      <span className="block text-xs text-ink-soft">{t(data.hint)}</span>
    </div>
  );
}
