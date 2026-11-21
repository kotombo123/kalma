import { useState, type FormEvent } from 'react';
import { useNavigate, useParams } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { ApiError } from '../lib/api.ts';
import { api } from '../lib/api.ts';
import { useAuth } from '../lib/auth.tsx';
import { Button, Field, Input } from '../components/ui.tsx';
import { Sheet } from './LoginPage.tsx';

interface InviteInfo {
  email: string;
  orgName: string;
  role: string;
  teamName: string | null;
  teamRole: string | null;
  userExists: boolean;
}

export function InvitePage() {
  const { t } = useTranslation();
  const { token } = useParams({ from: '/invite/$token' });
  const { acceptInvite } = useAuth();
  const navigate = useNavigate();
  const info = useQuery({
    queryKey: ['invite', token],
    queryFn: () => api<InviteInfo>(`/invites/${token}`),
    retry: false,
  });
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await acceptInvite(token, { password, ...(!info.data?.userExists && { name }) });
      await navigate({ to: '/' });
    } catch (err) {
      setError((err as ApiError).message);
    }
  };

  if (info.isPending) return <Sheet>{t('invite.checking')}</Sheet>;
  if (info.isError)
    return (
      <Sheet>
        <h1 className="text-xl font-bold">{t('invite.broken')}</h1>
        <p className="mt-2 text-ink-soft">
          {(info.error as ApiError).status === 410
            ? t('invite.expired')
            : t('invite.notFound')}
        </p>
      </Sheet>
    );

  const i = info.data;
  return (
    <Sheet>
      <h1 className="text-2xl font-bold">{t('invite.join', { org: i.orgName })}</h1>
      <p className="mt-1 mb-6 text-ink-soft">
        {t('invite.for', { email: i.email })}
        {i.teamName && t('invite.toTeam', { team: i.teamName })}.
      </p>
      <form onSubmit={submit} className="space-y-4">
        {!i.userExists && (
          <Field label={t('invite.fullName')}>
            <Input required value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
          </Field>
        )}
        <Field
          label={i.userExists ? t('invite.yourPassword') : t('invite.password')}
          hint={i.userExists ? t('invite.existingHint') : t('invite.passwordHint')}
        >
          <Input
            type="password"
            required
            minLength={i.userExists ? 1 : 8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={i.userExists ? 'current-password' : 'new-password'}
          />
        </Field>
        {error && (
          <p role="alert" className="text-sm text-critical">
            {error}
          </p>
        )}
        <Button variant="primary" type="submit" className="w-full justify-center">
          {t('invite.submit')}
        </Button>
      </form>
    </Sheet>
  );
}
