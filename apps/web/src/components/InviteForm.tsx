import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, type ApiError } from '../lib/api.ts';
import { useAuth } from '../lib/auth.tsx';
import type { TeamSummary } from '../lib/types.ts';
import { Button, Field, Input } from './ui.tsx';
import { CopyButton } from './Connect.tsx';

/**
 * Invite a person by email. Admins choose the org role, any team and team role; team leads invite
 * members into a team they lead (the API enforces the same rules).
 */
export function InviteForm({ teams, fixedTeamId }: { teams: TeamSummary[]; fixedTeamId?: string }) {
  const { t } = useTranslation();
  const { me } = useAuth();
  const qc = useQueryClient();
  const isAdmin = me?.role === 'admin';
  const ledTeams = isAdmin
    ? teams
    : teams.filter((tm) => me?.teams.some((m) => m.id === tm.id && m.role === 'lead'));
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'member' | 'admin'>('member');
  const [teamId, setTeamId] = useState(fixedTeamId ?? (isAdmin ? '' : (ledTeams[0]?.id ?? '')));
  const [teamRole, setTeamRole] = useState<'member' | 'lead'>('member');

  const invite = useMutation({
    mutationFn: () =>
      api<{ id: string; link: string; emailed: boolean }>('/invites', {
        method: 'POST',
        body: { email, role, ...(teamId && { teamId, teamRole }) },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['invites'] }),
  });

  if (!isAdmin && ledTeams.length === 0) return null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    invite.mutate();
  };

  return (
    <section aria-labelledby="invite" className="rounded-panel border border-rule bg-sheet p-4">
      <h2 id="invite" className="text-base font-semibold">
        {t('invite.formTitle')}
      </h2>
      <p className="mb-4 text-sm text-ink-soft">
        {t('invite.formHint')}
      </p>
      <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
        <Field label={t('invite.email')}>
          <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        {!fixedTeamId && (
          <Field label={t('invite.team')}>
            <select
              value={teamId}
              onChange={(e) => setTeamId(e.target.value)}
              required={!isAdmin}
              className="h-9 w-full rounded-control border border-rule bg-sheet px-2"
            >
              {isAdmin && <option value="">{t('invite.noTeam')}</option>}
              {ledTeams.map((tm) => (
                <option key={tm.id} value={tm.id}>
                  {tm.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        {isAdmin && (
          <>
            <Field
              label={t('invite.orgRole')}
              hint={
                role === 'admin'
                  ? t('invite.adminHint')
                  : t('invite.memberHint')
              }
            >
              <select
                value={role}
                onChange={(e) => setRole(e.target.value as 'member' | 'admin')}
                className="h-9 w-full rounded-control border border-rule bg-sheet px-2"
              >
                <option value="member">{t('orgRole.member')}</option>
                <option value="admin">{t('orgRole.admin')}</option>
              </select>
            </Field>
            {teamId && (
              <Field
                label={t('invite.teamRole')}
                hint={
                  teamRole === 'lead'
                    ? t('invite.leadHint')
                    : t('invite.teamMemberHint')
                }
              >
                <select
                  value={teamRole}
                  onChange={(e) => setTeamRole(e.target.value as 'member' | 'lead')}
                  className="h-9 w-full rounded-control border border-rule bg-sheet px-2"
                >
                  <option value="member">{t('teamRole.member')}</option>
                  <option value="lead">{t('teamRole.lead')}</option>
                </select>
              </Field>
            )}
          </>
        )}
        <div className="sm:col-span-2">
          <Button variant="primary" type="submit" disabled={invite.isPending}>
            {t('invite.send')}
          </Button>
        </div>
      </form>
      {invite.isError && (
        <p role="alert" className="mt-3 text-sm text-critical">
          {(invite.error as ApiError).message}
        </p>
      )}
      {invite.data && (
        <div role="status" className="mt-4 rounded-control border-l-4 border-info bg-paper p-3 text-sm">
          <p className="font-semibold">
            {invite.data.emailed ? t('invite.sentTo', { email }) : t('invite.sentNoEmail')}.
          </p>
          <div className="mt-2 flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-control border border-rule bg-sheet px-2 py-1 text-xs">
              {invite.data.link}
            </code>
            <CopyButton text={invite.data.link} label={t('invite.copyLink')} />
          </div>
        </div>
      )}
    </section>
  );
}
