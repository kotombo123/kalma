import { Link } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type ApiError } from '../lib/api.ts';
import { useAuth } from '../lib/auth.tsx';
import { describeCondition, type RuleRow } from '../lib/rules.ts';
import type { Page } from '../lib/types.ts';
import { Button } from '../components/ui.tsx';
import { usePersona } from '../lib/roles.ts';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

export function RulesPage() {
  const { t } = useTranslation();
  const { me } = useAuth();
  const { persona, leadTeams } = usePersona();
  const [showAll, setShowAll] = useState(false);
  const qc = useQueryClient();
  const rules = useQuery({ queryKey: ['rules'], queryFn: () => api<Page<RuleRow>>('/rules?limit=100') });
  const canWrite = (teamId: string) =>
    me?.role === 'admin' || me?.teams.some((m) => m.id === teamId && m.role === 'lead');
  const canCreate = me?.role === 'admin' || me?.teams.some((m) => m.role === 'lead');
  const toggle = useMutation({
    mutationFn: (r: RuleRow) => api(`/rules/${r.id}`, { method: 'PATCH', body: { enabled: !r.enabled } }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['rules'] }),
  });

  const lead = new Set(leadTeams.map((m) => m.id));
  const all = rules.data?.data ?? [];
  const visible = persona === 'lead' && !showAll ? all.filter((r) => lead.has(r.teamId)) : all;
  const hiddenCount = all.length - all.filter((r) => lead.has(r.teamId)).length;

  return (
    <div className="px-6 py-5">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{t('rules.title')}</h1>
          <p className="mt-1 max-w-[72ch] text-ink-soft">
            {persona === 'lead'
              ? t('rules.subtitleLead', { teams: leadTeams.map((m) => m.name).join(', ') })
              : t('rules.subtitle')}
          </p>
        </div>
        {canCreate && (
          <Link
            to="/rules/new"
            search={{ schemaId: '' }}
            className="rounded-control bg-ink px-3 py-1.5 text-sm font-semibold text-sheet"
          >
            {t('rules.newRule')}
          </Link>
        )}
      </div>
      {persona === 'lead' && hiddenCount > 0 && (
        <button className="mb-3 text-sm text-ink-soft hover:text-ink" onClick={() => setShowAll((v) => !v)}>
          {showAll
            ? t('rules.showMine')
            : t('rules.showOthers', { count: hiddenCount })}
        </button>
      )}
      <section className="rounded-panel border border-rule bg-sheet" aria-label={t('rules.list')}>
        {visible.length === 0 && rules.data && (
          <p className="px-4 py-5 text-ink-soft">
            {t('rules.empty')}
          </p>
        )}
        <ul>
          {visible.map((r) => (
            <li
              key={r.id}
              className="flex flex-wrap items-start justify-between gap-3 border-b border-rule/70 px-4 py-3 last:border-b-0"
            >
              <div className="min-w-0 max-w-[80ch]">
                <Link to="/rules/$ruleId" params={{ ruleId: r.id }} className="font-semibold hover:underline">
                  {r.name}
                </Link>
                <span className="ml-2 text-sm text-ink-soft">
                  {r.teamName}
                  {persona === 'admin' && <>{t('rules.version', { version: r.version })}</>}
                  {r.origin === 'file' && <>{t('rules.fromFile', { path: r.filePath })}</>}
                </span>
                <p className="truncate text-sm text-ink-soft">
                  {t('rules.when', { condition: describeCondition(r.definition.condition) })}
                </p>
                {r.fileError && <p className="text-sm text-critical">{t('rules.fileError', { error: r.fileError })}</p>}
              </div>
              {canWrite(r.teamId) && r.origin !== 'file' ? (
                <Button onClick={() => toggle.mutate(r)} disabled={toggle.isPending}>
                  {r.enabled ? t('rules.disable') : t('rules.enable')}
                </Button>
              ) : (
                <span className="text-sm text-ink-soft">{r.enabled ? t('rules.enabled') : t('rules.disabled')}</span>
              )}
            </li>
          ))}
        </ul>
      </section>
      {toggle.isError && <p className="mt-2 text-sm text-critical">{(toggle.error as ApiError).message}</p>}
    </div>
  );
}
