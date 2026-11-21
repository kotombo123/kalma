import { useState, type FormEvent } from 'react';
import { Link } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, type ApiError } from '../lib/api.ts';
import { useAuth } from '../lib/auth.tsx';
import { plural } from '../lib/format.ts';
import {
  type OrgMember,
  type Page,
  type PendingInvite,
  type TeamSummary,
} from '../lib/types.ts';
import { Button, Field, Input } from '../components/ui.tsx';
import { InviteForm } from '../components/InviteForm.tsx';

function AddTeam() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const create = useMutation({
    mutationFn: () => api('/teams', { method: 'POST', body: { name } }),
    onSuccess: () => {
      setName('');
      return qc.invalidateQueries({ queryKey: ['teams'] });
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };
  return (
    <form onSubmit={submit} className="flex items-end gap-2">
      <Field label={t('teams.newTeam')}>
        <Input
          required
          maxLength={100}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('teams.newTeamPlaceholder')}
        />
      </Field>
      <Button variant="primary" type="submit" disabled={create.isPending}>
        {t('teams.addTeam')}
      </Button>
      {create.isError && <span className="text-sm text-critical">{(create.error as ApiError).message}</span>}
    </form>
  );
}

function OrgMembers() {
  const { t } = useTranslation();
  const { me } = useAuth();
  const qc = useQueryClient();
  const members = useQuery({
    queryKey: ['members'],
    queryFn: () => api<Page<OrgMember>>('/members?limit=100'),
  });
  const change = useMutation({
    mutationFn: ({ id, role }: { id: string; role: OrgMember['role'] }) =>
      api(`/members/${id}`, { method: 'PATCH', body: { role } }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['members'] }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/members/${id}`, { method: 'DELETE' }),
    onSettled: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: ['members'] }),
        qc.invalidateQueries({ queryKey: ['teams'] }),
      ]),
  });
  const failed = (change.error ?? remove.error) as ApiError | null;
  return (
    <section aria-labelledby="members" className="rounded-panel border border-rule bg-sheet">
      <h2 id="members" className="border-b border-rule px-4 py-3 text-base font-semibold">
        {t('teams.orgPeople')}
      </h2>
      <table className="w-full text-sm">
        <caption className="sr-only">{t('teams.orgMembers')}</caption>
        <tbody>
          {members.data?.data.map((m) => (
            <tr key={m.id} className="border-b border-rule/70 last:border-b-0">
              <td className="px-4 py-2">
                <div className="font-semibold">{m.name}</div>
                <div className="text-xs text-ink-soft">{m.email}</div>
              </td>
              <td className="border-l border-rule/70 px-3 py-2">
                <label className="sr-only" htmlFor={`role-${m.id}`}>
                  {t('teams.roleOf', { name: m.name })}
                </label>
                <select
                  id={`role-${m.id}`}
                  value={m.role}
                  onChange={(e) => change.mutate({ id: m.id, role: e.target.value as OrgMember['role'] })}
                  className="h-8 rounded-control border border-rule bg-sheet px-2"
                >
                  {(['member', 'admin'] as const).map((r) => (
                    <option key={r} value={r}>
                      {t(`orgRole.${r}`)}
                    </option>
                  ))}
                </select>
              </td>
              <td className="border-l border-rule/70 px-3 py-2 text-right">
                {m.id !== me?.user.id && (
                  <Button
                    variant="quiet"
                    onClick={() => {
                      if (confirm(t('teams.confirmRemove', { name: m.name })))
                        remove.mutate(m.id);
                    }}
                  >
                    {t('teams.remove')}
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {failed && (
        <p role="alert" className="px-4 py-2 text-sm text-critical">
          {failed.code === 'last_admin'
            ? t('teams.lastAdmin')
            : failed.message}
        </p>
      )}
    </section>
  );
}

function PendingInvites({ teams }: { teams: Map<string, string> }) {
  const { t, i18n } = useTranslation();
  const invites = useQuery({
    queryKey: ['invites'],
    queryFn: () => api<Page<PendingInvite>>('/invites?limit=50'),
  });
  const list = invites.data?.data ?? [];
  if (list.length === 0) return null;
  return (
    <section aria-labelledby="pending" className="rounded-panel border border-rule bg-sheet">
      <h2 id="pending" className="border-b border-rule px-4 py-3 text-base font-semibold">
        {t('teams.pending')}
      </h2>
      <ul>
        {list.map((i) => (
          <li
            key={i.id}
            className="flex flex-wrap justify-between gap-2 border-b border-rule/70 px-4 py-2 text-sm last:border-b-0"
          >
            <span className="font-semibold">{i.email}</span>
            <span className="text-ink-soft">
              {t(`orgRole.${i.role}`)}
              {i.teamId &&
                `, ${teams.get(i.teamId) ?? t('teams.teamFallback')} (${t(`teamRole.${i.teamRole ?? 'member'}`).toLowerCase()})`}
              {t('teams.validUntil', { date: new Date(i.expiresAt).toLocaleDateString(i18n.language) })}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function TeamsPage() {
  const { t } = useTranslation();
  const { me } = useAuth();
  const isAdmin = me?.role === 'admin';
  const teams = useQuery({ queryKey: ['teams'], queryFn: () => api<Page<TeamSummary>>('/teams?limit=100') });
  const list = teams.data?.data ?? [];
  const myRole = new Map(me?.teams.map((x) => [x.id, x.role]));

  return (
    <div className="px-6 py-5">
      <h1 className="text-2xl font-bold">{t('teams.title')}</h1>
      <p className="mt-1 mb-5 max-w-[72ch] text-ink-soft">
        {t('teams.subtitle')}
      </p>

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_26rem]">
        <div className="space-y-6">
          <section aria-labelledby="teams" className="rounded-panel border border-rule bg-sheet">
            <div className="flex flex-wrap items-end justify-between gap-3 border-b border-rule px-4 py-3">
              <h2 id="teams" className="text-base font-semibold">
                {t('teams.all')}
              </h2>
              {isAdmin && <AddTeam />}
            </div>
            {list.length === 0 && !teams.isPending && (
              <p className="px-4 py-4 text-ink-soft">
                {isAdmin
                  ? t('teams.emptyAdmin')
                  : t('teams.empty')}
              </p>
            )}
            <ul>
              {list.map((tm) => (
                <li
                  key={tm.id}
                  className="flex items-baseline justify-between gap-3 border-b border-rule/70 px-4 py-2.5 last:border-b-0"
                >
                  <Link
                    to="/teams/$teamId"
                    params={{ teamId: tm.id }}
                    className="font-semibold hover:underline"
                  >
                    {tm.name}
                  </Link>
                  <span className="text-sm text-ink-soft">
                    {myRole.has(tm.id) && (
                      <span className="mr-3 text-ink">
                        {t('teams.you', { role: t(`teamRole.${myRole.get(tm.id)!}`) })}
                      </span>
                    )}
                    <span className="num">
                      {tm.memberCount}{' '}
                      {plural(
                        tm.memberCount,
                        t('teams.personOne'),
                        t('teams.personFew'),
                        t('teams.personMany'),
                      )}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </section>
          {isAdmin && <OrgMembers />}
        </div>
        <div className="space-y-6">
          <InviteForm teams={list} />
          {isAdmin && <PendingInvites teams={new Map(list.map((x) => [x.id, x.name]))} />}
        </div>
      </div>
    </div>
  );
}
