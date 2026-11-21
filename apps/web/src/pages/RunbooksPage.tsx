import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api.ts';
import { useAuth } from '../lib/auth.tsx';
import { plural, when } from '../lib/format.ts';
import type { Page } from '../lib/types.ts';

/** Runbook formats; the label is `runbooks.format.<key>` in the locale files. */
export const RUNBOOK_FORMATS = ['yaml', 'markdown', 'checklist', 'link', 'text'] as const;

interface Row {
  id: string;
  name: string;
  teamName: string;
  format: string;
  stepCount: number;
  version: number;
  updatedAt: string;
}

export function RunbooksPage() {
  const { t } = useTranslation();
  const { me } = useAuth();
  const canCreate = me?.role === 'admin' || me?.teams.some((m) => m.role === 'lead');
  const list = useQuery({ queryKey: ['runbooks'], queryFn: () => api<Page<Row>>('/runbooks?limit=100') });
  return (
    <div className="px-6 py-5">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{t('runbooks.title')}</h1>
          <p className="mt-1 max-w-[72ch] text-ink-soft">
            {t('runbooks.subtitle')}
          </p>
        </div>
        {canCreate && (
          <Link
            to="/runbooks/new"
            className="rounded-control bg-ink px-3 py-1.5 text-sm font-semibold text-sheet"
          >
            {t('runbooks.newRunbook')}
          </Link>
        )}
      </div>
      <section className="rounded-panel border border-rule bg-sheet" aria-label={t('runbooks.list')}>
        {list.data?.data.length === 0 && (
          <p className="px-4 py-5 text-ink-soft">
            {t('runbooks.empty')}
          </p>
        )}
        <ul>
          {list.data?.data.map((r) => (
            <li
              key={r.id}
              className="flex flex-wrap items-baseline justify-between gap-3 border-b border-rule/70 px-4 py-3 last:border-b-0"
            >
              <div>
                <Link
                  to="/runbooks/$runbookId"
                  params={{ runbookId: r.id }}
                  className="font-semibold hover:underline"
                >
                  {r.name}
                </Link>
                <span className="ml-2 text-sm text-ink-soft">
                  {r.teamName},{' '}
                  {(RUNBOOK_FORMATS as readonly string[]).includes(r.format)
                    ? t(`runbooks.format.${r.format}`)
                    : r.format}
                </span>
              </div>
              <span className="num text-sm text-ink-soft">
                {r.stepCount}{' '}
                {plural(r.stepCount, t('runbooks.stepOne'), t('runbooks.stepFew'), t('runbooks.stepMany'))},{' '}
                {t('runbooks.version', { version: r.version })},{' '}
                {when(r.updatedAt)}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
