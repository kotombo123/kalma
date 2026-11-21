import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, type ApiError } from '../lib/api.ts';
import { useAuth } from '../lib/auth.tsx';
import { type OrgMember, type Page, type TeamDetail } from '../lib/types.ts';
import { Button, Field, Input } from '../components/ui.tsx';
import { InviteForm } from '../components/InviteForm.tsx';

/**
 * The notifier does not read the per-team Teams webhook yet (only TEAMS_WEBHOOK_URL), so the setting
 * stays hidden until it does (implementation_plan.md §7). Flip to true once apps/notifier uses it.
 */
const TEAM_WEBHOOK_USED = false;

export function TeamPage() {
  // `t` is the team below, so the translation function is `tr` here.
  const { t: tr } = useTranslation();
  const { teamId } = useParams({ from: '/app/teams/$teamId' });
  const { me } = useAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const isAdmin = me?.role === 'admin';
  const isLead = isAdmin || me?.teams.some((t) => t.id === teamId && t.role === 'lead');

  const team = useQuery({ queryKey: ['team', teamId], queryFn: () => api<TeamDetail>(`/teams/${teamId}`) });
  const members = useQuery({
    queryKey: ['members'],
    queryFn: () => api<Page<OrgMember>>('/members?limit=100'),
    enabled: Boolean(isLead),
  });
  const [addId, setAddId] = useState('');
  const [webhook, setWebhook] = useState<string | null>(null);
  const done = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ['team', teamId] }),
      qc.invalidateQueries({ queryKey: ['teams'] }),
    ]);

  const setMember = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: 'lead' | 'member' }) =>
      api(`/teams/${teamId}/members/${userId}`, { method: 'PUT', body: { role } }),
    onSuccess: done,
  });
  const removeMember = useMutation({
    mutationFn: (userId: string) => api(`/teams/${teamId}/members/${userId}`, { method: 'DELETE' }),
    onSuccess: done,
  });
  const saveWebhook = useMutation({
    mutationFn: (url: string | null) =>
      api(`/teams/${teamId}`, { method: 'PATCH', body: { teamsWebhookUrl: url } }),
    onSuccess: () => {
      setWebhook(null);
      return done();
    },
  });
  const removeTeam = useMutation({
    mutationFn: () => api(`/teams/${teamId}`, { method: 'DELETE' }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['teams'] });
      await navigate({ to: '/teams' });
    },
  });

  if (team.isPending) return <p className="px-6 py-5 text-ink-soft">{tr('loading')}</p>;
  if (team.isError) return <p className="px-6 py-5">{tr('team.notFound')}</p>;
  const t = team.data;
  const inTeam = new Set(t.members.map((m) => m.id));
  const candidates = (members.data?.data ?? []).filter((m) => !inTeam.has(m.id));
  const failed = [setMember, removeMember, saveWebhook, removeTeam].find((m) => m.isError)?.error as
    ApiError | undefined;

  const add = (e: FormEvent) => {
    e.preventDefault();
    if (addId) setMember.mutate({ userId: addId, role: 'member' }, { onSuccess: () => setAddId('') });
  };

  return (
    <div className="px-6 py-5">
      <Link to="/teams" className="text-sm text-ink-soft hover:underline">
        {tr('teams.title')}
      </Link>
      <h1 className="mt-1 text-2xl font-bold">{t.name}</h1>

      <div className="mt-5 grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_26rem]">
        <div className="space-y-6">
          <section aria-labelledby="people" className="rounded-panel border border-rule bg-sheet">
            <h2 id="people" className="border-b border-rule px-4 py-3 text-base font-semibold">
              {tr('team.members')}
            </h2>
            {t.members.length === 0 && (
              <p className="px-4 py-4 text-ink-soft">{tr('team.noMembers')}</p>
            )}
            <table className="w-full text-sm">
              <caption className="sr-only">{tr('team.membersOf', { name: t.name })}</caption>
              <tbody>
                {t.members.map((m) => (
                  <tr key={m.id} className="border-b border-rule/70 last:border-b-0">
                    <td className="px-4 py-2">
                      <div className="font-semibold">{m.name}</div>
                      <div className="text-xs text-ink-soft">{m.email}</div>
                    </td>
                    <td className="border-l border-rule/70 px-3 py-2">
                      {isAdmin ? (
                        <>
                          <label className="sr-only" htmlFor={`tr-${m.id}`}>
                            {tr('team.roleInTeam', { name: m.name })}
                          </label>
                          <select
                            id={`tr-${m.id}`}
                            value={m.role}
                            onChange={(e) =>
                              setMember.mutate({ userId: m.id, role: e.target.value as 'lead' | 'member' })
                            }
                            className="h-8 rounded-control border border-rule bg-sheet px-2"
                          >
                            <option value="member">{tr('teamRole.member')}</option>
                            <option value="lead">{tr('teamRole.lead')}</option>
                          </select>
                        </>
                      ) : (
                        tr(`teamRole.${m.role}`)
                      )}
                    </td>
                    <td className="border-l border-rule/70 px-3 py-2 text-right">
                      {isLead && (isAdmin || m.role !== 'lead') && (
                        <Button variant="quiet" onClick={() => removeMember.mutate(m.id)}>
                          {tr('team.removeFromTeam')}
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {isLead && candidates.length > 0 && (
              <form onSubmit={add} className="flex items-end gap-2 border-t border-rule px-4 py-3">
                <Field label={tr('team.addFromOrg')}>
                  <select
                    value={addId}
                    onChange={(e) => setAddId(e.target.value)}
                    className="h-9 w-full rounded-control border border-rule bg-sheet px-2"
                  >
                    <option value="">{tr('team.choosePerson')}</option>
                    {candidates.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name} ({m.email})
                      </option>
                    ))}
                  </select>
                </Field>
                <Button type="submit" disabled={!addId || setMember.isPending}>
                  {tr('team.add')}
                </Button>
              </form>
            )}
          </section>

          {TEAM_WEBHOOK_USED && (
            <section aria-labelledby="teams-hook" className="rounded-panel border border-rule bg-sheet p-4">
              <h2 id="teams-hook" className="text-base font-semibold">
                {tr('team.teamsChannel')}
              </h2>
              <p className="mt-1 text-sm text-ink-soft">
                {t.teamsWebhookConfigured
                  ? tr('team.webhookOn')
                  : tr('team.webhookOff')}
              </p>
              {isLead &&
                (webhook === null ? (
                  <div className="mt-3 flex gap-2">
                    <Button onClick={() => setWebhook(t.teamsWebhookUrl ?? '')}>
                      {t.teamsWebhookConfigured ? tr('team.changeAddress') : tr('team.setAddress')}
                    </Button>
                    {t.teamsWebhookConfigured && (
                      <Button variant="quiet" onClick={() => saveWebhook.mutate(null)}>
                        {tr('team.disconnect')}
                      </Button>
                    )}
                  </div>
                ) : (
                  <form
                    className="mt-3 flex items-end gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      saveWebhook.mutate(webhook || null);
                    }}
                  >
                    <Field label={tr('team.webhookLabel')}>
                      <Input
                        type="url"
                        required
                        value={webhook}
                        onChange={(e) => setWebhook(e.target.value)}
                      />
                    </Field>
                    <Button variant="primary" type="submit">
                      {tr('team.save')}
                    </Button>
                    <Button variant="quiet" type="button" onClick={() => setWebhook(null)}>
                      {tr('team.cancel')}
                    </Button>
                  </form>
                ))}
            </section>
          )}

          {isAdmin && (
            <Button
              variant="quiet"
              className="text-critical"
              onClick={() => {
                if (confirm(tr('team.confirmDelete', { name: t.name }))) removeTeam.mutate();
              }}
            >
              {tr('team.deleteTeam')}
            </Button>
          )}
          {failed && (
            <p role="alert" className="text-sm text-critical">
              {failed.code === 'team_in_use'
                ? tr('team.teamInUse')
                : failed.message}
            </p>
          )}
        </div>
        {isLead && (
          <InviteForm
            teams={[{ id: t.id, name: t.name, memberCount: t.members.length }]}
            fixedTeamId={t.id}
          />
        )}
      </div>
    </div>
  );
}
