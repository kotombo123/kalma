import { useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { ApiError } from '../lib/api.ts';
import { api } from '../lib/api.ts';
import { useAuth } from '../lib/auth.tsx';
import { isFresh, type AlertFilter } from '../lib/live.ts';
import { type Alert, type Page, type Severity } from '../lib/types.ts';
import { Button, sevVar } from '../components/ui.tsx';
import { FirstSteps, OnCallStrip } from '../components/RoleHome.tsx';
import { usePersona } from '../lib/roles.ts';

const SEVERITIES: Severity[] = ['critical', 'error', 'warning', 'info'];

type View = 'active' | 'resolved' | 'all';
const VIEW_STATUS: Record<View, Alert['status'][]> = {
  active: ['open', 'acknowledged'],
  resolved: ['resolved'],
  all: ['open', 'acknowledged', 'resolved'],
};

const today = new Date().toDateString();
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const dayFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
function when(iso: string) {
  const d = new Date(iso);
  return d.toDateString() === today
    ? timeFmt.format(d)
    : `${dayFmt.format(d)} ${timeFmt.format(d).slice(0, 5)}`;
}

export function AlertsPage() {
  const { t } = useTranslation();
  const { me } = useAuth();
  const { persona, leadTeams, myTeams } = usePersona();
  const qc = useQueryClient();
  const [view, setView] = useState<View>('active');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [severity, setSeverity] = useState<Severity[]>(SEVERITIES);
  const [teamId, setTeamId] = useState<string>('');

  const filter: AlertFilter = { status: VIEW_STATUS[view], severity, ...(teamId && { teamId }) };
  const params = new URLSearchParams({
    status: filter.status.join(','),
    severity: severity.join(','),
    limit: '100',
  });
  if (teamId) params.set('teamId', teamId);

  const alerts = useQuery({
    queryKey: ['alerts', filter],
    queryFn: () => api<Page<Alert>>(`/alerts?${params}`),
    enabled: severity.length > 0,
  });
  const teams = useQuery({
    queryKey: ['teams'],
    queryFn: () => api<Page<{ id: string; name: string }>>('/teams?limit=100'),
  });
  const teamName = useMemo(() => new Map(teams.data?.data.map((t) => [t.id, t.name])), [teams.data]);

  const act = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'ack' | 'resolve' }) =>
      api<Alert>(`/alerts/${id}/${action}`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['alerts'] }),
  });

  const toggleSeverity = (s: Severity) =>
    setSeverity((cur) =>
      cur.includes(s) ? cur.filter((x) => x !== s) : SEVERITIES.filter((x) => x === s || cur.includes(x)),
    );

  const sevLabel: Record<Severity, string> = {
    critical: t('severity.critical'),
    error: t('severity.error'),
    warning: t('severity.warning'),
    info: t('severity.info'),
  };
  const statusLabel: Record<Alert['status'], string> = {
    open: t('status.open'),
    acknowledged: t('status.acknowledged'),
    resolved: t('status.resolved'),
  };

  const rows = severity.length ? (alerts.data?.data ?? []) : [];
  const teamChoices = me?.role === 'admin' ? (teams.data?.data ?? []) : myTeams;
  const activeFilters = (severity.length < SEVERITIES.length ? 1 : 0) + (teamId ? 1 : 0);
  const names = (ts: { name: string }[]) => ts.map((tItem) => tItem.name).join(', ');
  const heading =
    persona === 'admin'
      ? t('alerts.title_admin')
      : persona === 'lead'
        ? leadTeams.length > 1
          ? t('alerts.title_lead_plural')
          : t('alerts.title_lead_single')
        : t('alerts.title_member');
  const subheading =
    persona === 'admin'
      ? t('alerts.sub_admin')
      : persona === 'lead'
        ? leadTeams.length > 1
          ? t('alerts.sub_lead_plural', { teams: names(leadTeams) })
          : t('alerts.sub_lead_single', { team: names(leadTeams) })
        : myTeams.length
          ? t('alerts.sub_member_teams', { teams: names(myTeams), plural: myTeams.length > 1 ? 's' : '' })
          : t('alerts.sub_member_none');

  const views: { key: View; label: string }[] = [
    { key: 'active', label: t('alerts.view_active') },
    { key: 'resolved', label: t('alerts.view_resolved') },
    { key: 'all', label: t('alerts.view_all') },
  ];

  return (
    <div className="px-6 py-5">
      <FirstSteps />
      <div className="mb-3 flex flex-wrap items-end gap-x-6 gap-y-3">
        <div>
          <h1 className="text-2xl font-bold leading-tight">{heading}</h1>
          {subheading && <p className="mt-0.5 text-sm text-ink-soft">{subheading}</p>}
        </div>

        <div
          role="radiogroup"
          aria-label="View"
          className="flex rounded-control border border-rule bg-sheet p-0.5"
        >
          {views.map((v) => (
            <button
              key={v.key}
              role="radio"
              aria-checked={view === v.key}
              onClick={() => setView(v.key)}
              className={`rounded-[4px] px-3 py-1 text-sm ${view === v.key ? 'bg-ink font-semibold text-sheet' : 'text-ink-soft hover:text-ink'}`}
            >
              {v.label}
            </button>
          ))}
        </div>

        <button
          aria-expanded={filtersOpen}
          aria-controls="alert-filters"
          onClick={() => setFiltersOpen((o) => !o)}
          className="h-8 rounded-control px-2 text-sm text-ink-soft hover:text-ink"
        >
          {filtersOpen ? t('alerts.hideFilters') : t('alerts.filters')}
          {activeFilters > 0 && (
            <span className="font-semibold text-ink">{t('alerts.filtersActive', { count: activeFilters })}</span>
          )}
        </button>
      </div>

      {filtersOpen && (
        <div
          id="alert-filters"
          className="mb-4 flex flex-wrap items-center gap-x-6 gap-y-3 border-l-2 border-rule pl-4"
        >
          <fieldset className="flex flex-wrap items-center gap-1">
            <legend className="sr-only">Severity</legend>
            {SEVERITIES.map((s) => {
              const on = severity.includes(s);
              return (
                <button
                  key={s}
                  aria-pressed={on}
                  onClick={() => toggleSeverity(s)}
                  className={`flex items-center gap-1.5 rounded-control border px-2.5 py-1 text-sm ${on ? 'border-rule bg-sheet text-ink' : 'border-transparent text-ink-soft line-through'}`}
                >
                  <span aria-hidden className="h-3 w-1 rounded-full" style={{ background: sevVar(s) }} />
                  {sevLabel[s]}
                </button>
              );
            })}
          </fieldset>

          {teamChoices.length > 1 && (
            <label className="flex items-center gap-2 text-sm">
              <span className="text-ink-soft">{t('alerts.col_team')}</span>
              <select
                value={teamId}
                onChange={(e) => setTeamId(e.target.value)}
                className="h-8 rounded-control border border-rule bg-sheet px-2 text-ink"
              >
                <option value="">{me?.role === 'admin' ? t('alerts.allTeams') : t('alerts.myTeams')}</option>
                {teamChoices.map((tItem) => (
                  <option key={tItem.id} value={tItem.id}>
                    {tItem.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      )}

      <OnCallStrip />

      <div className="relative overflow-x-auto rounded-panel border border-rule bg-sheet">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 left-8 w-[4px] border-x border-margin/70"
        />
        <table className="w-full min-w-[880px] table-fixed border-collapse text-sm">
          <caption className="sr-only">{t('alerts.list')}</caption>
          <colgroup>
            <col className="w-10" />
            <col className="w-28" />
            <col />
            <col className="w-36" />
            <col className="w-16" />
            <col className="w-32" />
            <col className="w-52" />
          </colgroup>
          <thead>
            <tr className="border-b border-rule text-left text-xs text-ink-soft">
              <th scope="col">
                <span className="sr-only">Severity</span>
              </th>
              <th scope="col" className="py-2 pl-3">
                {t('alerts.col_last')}
              </th>
              <th scope="col" className="border-l border-rule/70 py-2 pl-3">
                {t('alerts.col_alert')}
              </th>
              <th scope="col" className="border-l border-rule/70 py-2 pl-3">
                {t('alerts.col_team')}
              </th>
              <th scope="col" className="border-l border-rule/70 py-2 pr-3 text-right">
                {t('alerts.col_count')}
              </th>
              <th scope="col" className="border-l border-rule/70 py-2 pl-3">
                {t('alerts.col_status')}
              </th>
              <th scope="col" className="border-l border-rule/70 py-2 pl-3">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => {
              const fresh = isFresh(a.id);
              return (
                <tr
                  key={a.id}
                  className={`border-b border-rule/80 last:border-b-0 ${fresh ? 'ink-in' : ''} ${a.status === 'resolved' ? 'text-ink-soft' : ''}`}
                  style={{ ['--sev' as string]: sevVar(a.severity) }}
                >
                  <td className="relative">
                    <span
                      className="ink-mark absolute inset-y-1.5 left-3.5 w-1 rounded-full"
                      style={{ background: sevVar(a.severity), opacity: a.status === 'resolved' ? 0.35 : 1 }}
                    />
                    <span className="sr-only">{sevLabel[a.severity]}</span>
                  </td>
                  <td className="num py-2.5 pl-3 align-top whitespace-nowrap text-ink-soft">
                    <time dateTime={a.lastSeen}>{when(a.lastSeen)}</time>
                  </td>
                  <td className="border-l border-rule/70 py-2.5 pr-3 pl-3 align-top">
                    <Link
                      to="/alerts/$alertId"
                      params={{ alertId: a.id }}
                      className="font-semibold text-ink hover:underline"
                    >
                      {a.title}
                    </Link>
                    {a.fields[0] && (
                      <div className="mt-0.5 max-w-[72ch] truncate text-xs text-ink-soft">
                        {a.fields
                          .slice(0, 3)
                          .map((f) => `${f.label}: ${f.value}`)
                          .join('   ')}
                      </div>
                    )}
                  </td>
                  <td className="border-l border-rule/70 py-2.5 pl-3 align-top">
                    {teamName.get(a.teamId) ?? '—'}
                  </td>
                  <td className="num border-l border-rule/70 py-2.5 pr-3 text-right align-top font-semibold">
                    {a.count > 1 ? `×${a.count}` : ''}
                  </td>
                  <td className="border-l border-rule/70 py-2.5 pl-3 align-top">{statusLabel[a.status]}</td>
                  <td className="border-l border-rule/70 py-1.5 pl-3 align-top">
                    <div className="flex gap-1.5">
                      {a.status === 'open' && (
                        <Button
                          variant="primary"
                          disabled={act.isPending}
                          onClick={() => act.mutate({ id: a.id, action: 'ack' })}
                        >
                          {t('alerts.ack')}
                        </Button>
                      )}
                      {a.status !== 'resolved' && (
                        <Button
                          disabled={act.isPending}
                          onClick={() => act.mutate({ id: a.id, action: 'resolve' })}
                        >
                          {t('alerts.resolve')}
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {alerts.isPending && severity.length > 0 && (
          <p className="px-12 py-8 text-ink-soft">{t('alerts.loadingAlerts')}</p>
        )}
        {alerts.isError && (
          <p className="px-12 py-8" role="alert">
            {t('alerts.loadError', { message: (alerts.error as ApiError).message })}{' '}
            <button className="underline" onClick={() => void alerts.refetch()}>
              {t('alerts.tryAgain')}
            </button>
          </p>
        )}
        {!alerts.isPending && !alerts.isError && rows.length === 0 && (
          <p className="px-12 py-10 text-ink-soft">
            {severity.length === 0
              ? t('alerts.empty_noSeverity')
              : view === 'active'
                ? t('alerts.empty_active')
                : t('alerts.empty_other')}
          </p>
        )}
      </div>
      {act.isError && (
        <p role="alert" className="mt-3 text-sm text-critical">
          {(act.error as ApiError).message}
        </p>
      )}
    </div>
  );
}
