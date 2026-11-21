import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import type { ApiError } from '../lib/api.ts';
import { useAuth } from '../lib/auth.tsx';
import { Button, Field, Input } from '../components/ui.tsx';
import { Sheet } from './LoginPage.tsx';

/** Creates an organization; the person who creates it becomes its admin. */
export function RegisterPage() {
  const { t } = useTranslation();
  const { register } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ orgName: '', name: '', email: '', password: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await register(form);
      await navigate({ to: '/sources' });
    } catch (err) {
      const ae = err as ApiError;
      setError(
        ae.code === 'email_taken'
          ? t('register.email_taken')
          : ae.code === 'validation'
            ? t('register.validation')
            : ae.message,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet>
      <h1 className="text-2xl font-bold">{t('register.title')}</h1>
      <p className="mt-1 mb-6 text-ink-soft">{t('register.subtitle')}</p>
      <form onSubmit={submit} className="space-y-4">
        <Field label={t('register.orgName')}>
          <Input
            required
            maxLength={100}
            value={form.orgName}
            onChange={set('orgName')}
            autoComplete="organization"
          />
        </Field>
        <Field label={t('register.fullName')}>
          <Input required maxLength={100} value={form.name} onChange={set('name')} autoComplete="name" />
        </Field>
        <Field label={t('register.email')}>
          <Input type="email" required value={form.email} onChange={set('email')} autoComplete="email" />
        </Field>
        <Field label={t('register.password')} hint={t('register.passwordHint')}>
          <Input
            type="password"
            required
            minLength={8}
            value={form.password}
            onChange={set('password')}
            autoComplete="new-password"
          />
        </Field>
        {error && (
          <p role="alert" className="text-sm text-critical">
            {error}
          </p>
        )}
        <Button variant="primary" type="submit" disabled={busy} className="w-full justify-center">
          {t('register.submit')}
        </Button>
      </form>
      <p className="mt-4 text-sm text-ink-soft">
        {t('register.hasAccount')}{' '}
        <Link to="/login" className="font-semibold text-ink underline underline-offset-2">
          {t('register.signIn')}
        </Link>
      </p>
    </Sheet>
  );
}
