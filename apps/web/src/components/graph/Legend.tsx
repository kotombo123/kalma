import { useTranslation } from 'react-i18next';
import { MARK_COLOR } from './model.ts';

function Mark({ color, children }: { color: string; children: string }) {
  return (
    <li className="flex items-center gap-2">
      <span aria-hidden className="h-4 w-1" style={{ background: color }} />
      {children}
    </li>
  );
}

/** What the marks and lines mean. */
export function Legend() {
  const { t } = useTranslation();
  return (
    <ul
      className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-ink-soft"
      aria-label={t('graph.legend.label')}
    >
      <Mark color={MARK_COLOR.high}>{t('graph.legend.high')}</Mark>
      <Mark color={MARK_COLOR.above}>{t('graph.legend.above')}</Mark>
      <Mark color={MARK_COLOR.low}>{t('graph.legend.low')}</Mark>
      <li className="flex items-center gap-2">
        <svg aria-hidden width="28" height="10">
          <line x1="0" y1="2" x2="28" y2="2" stroke="var(--ink-soft)" strokeWidth="1" />
          <line x1="0" y1="8" x2="28" y2="8" stroke="var(--ink-soft)" strokeWidth="4" />
        </svg>
        {t('graph.legend.lineWidth')}
      </li>
      <li className="flex items-center gap-2">
        <svg aria-hidden width="28" height="6">
          <line x1="0" y1="3" x2="28" y2="3" stroke="var(--margin)" strokeWidth="2" strokeDasharray="4 3" />
        </svg>
        {t('graph.legend.escalation')}
      </li>
    </ul>
  );
}
