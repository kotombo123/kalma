import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { GraphNode } from '@alerting/contracts';
import { Button } from '../ui.tsx';
import { fmtDuration, fmtNum, fmtRatio, KIND_NAME, MARK_COLOR, markOf, markText } from './model.ts';

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-rule py-1.5">
      <dt className="text-ink-soft">{label}</dt>
      <dd className="num font-semibold">{value}</dd>
    </div>
  );
}

/** Side panel for the selected node: its numbers and the rules behind them. */
export function NodePanel({ node, onClose }: { node: GraphNode; onClose: () => void }) {
  const { t } = useTranslation();
  const mark = markOf(node);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), [node.id]);

  return (
    <aside
      aria-labelledby="graph-panel-title"
      className="graph-panel absolute inset-x-3 bottom-3 z-10 max-h-[60%] overflow-y-auto rounded-panel border border-rule bg-sheet p-4 md:static md:m-3 md:max-h-none md:w-80 md:shrink-0"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs text-ink-soft">{t(KIND_NAME[node.kind])}</p>
          <h2 id="graph-panel-title" ref={heading} tabIndex={-1} className="text-xl font-bold leading-tight">
            {node.label}
          </h2>
          {node.sublabel && <p className="text-ink-soft">{node.sublabel}</p>}
        </div>
        <Button variant="quiet" onClick={onClose} aria-label={t('graph.panel.closeAria')}>
          {t('graph.panel.close')}
        </Button>
      </div>

      {mark && (node.kind === 'user' || node.kind === 'source') && (
        <p className="mt-3 border-l-4 pl-3" style={{ borderColor: MARK_COLOR[mark] }}>
          <span className="block font-semibold">{markText(node, mark)}</span>
          {node.kind === 'user' ? (
            <span className="num text-ink-soft">
              {t('graph.panel.userLoad', {
                ratio: fmtRatio(node.load ?? 0),
                alerts: fmtNum(node.alerts),
                avg: fmtNum(Math.round(node.teamAvgAlerts ?? 0)),
              })}
            </span>
          ) : (
            <span className="num text-ink-soft">
              {t('graph.panel.sourceNoise', { ratio: fmtRatio(node.noise ?? 0) })}
            </span>
          )}
        </p>
      )}

      <dl className="mt-4">
        <Row
          label={node.kind === 'user' ? t('graph.panel.alertsNotified') : t('graph.panel.alerts')}
          value={fmtNum(node.alerts)}
        />
        {node.kind === 'source' && <Row label={t('graph.panel.events')} value={fmtNum(node.events ?? 0)} />}
        <Row label={t('graph.panel.acked')} value={fmtNum(node.acked)} />
        <Row label={t('graph.panel.resolved')} value={fmtNum(node.resolved)} />
        <Row label={t('graph.panel.mtta')} value={fmtDuration(node.mttaSec)} />
        <Row label={t('graph.panel.mttr')} value={fmtDuration(node.mttrSec)} />
        {node.kind === 'user' && (
          <Row label={t('graph.panel.escalationsToPerson')} value={fmtNum(node.escalations ?? 0)} />
        )}
        {node.kind === 'user' && (
          <Row
            label={t('graph.panel.loadVsTeam')}
            value={node.teamAvgAlerts ? fmtRatio(node.load ?? 0) : '—'}
          />
        )}
      </dl>

      {node.topRules.length > 0 && (
        <>
          <h3 className="mt-5 font-semibold">{t('graph.panel.topRules')}</h3>
          <ol className="mt-1">
            {node.topRules.map((r) => (
              <li
                key={r.ruleId}
                className="flex items-baseline justify-between gap-4 border-b border-rule py-1.5"
              >
                <span className="truncate">{r.name}</span>
                <span className="num shrink-0 font-semibold">{fmtNum(r.alerts)}</span>
              </li>
            ))}
          </ol>
        </>
      )}
    </aside>
  );
}
