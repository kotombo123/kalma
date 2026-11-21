import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '../lib/api.ts';
import { useAuth } from '../lib/auth.tsx';
import { Button, Field, Input } from '../components/ui.tsx';

/** A sheet of the columnar pad: the red margin rule runs down its left edge. */
export function Sheet({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-full place-items-center px-4 py-10">
      <div className="relative w-full max-w-md rounded-panel border border-rule bg-sheet py-8 pr-8 pl-14 shadow-[0_10px_30px_-12px_rgba(29,43,58,0.25)]">
        <div aria-hidden className="absolute inset-y-0 left-8 w-[4px] border-x border-margin/70" />
        {children}
      </div>
    </div>
  );
}

export function LoginPage() {
  const { t } = useTranslation();
  const { login, loginAs } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const devUsers = useQuery({
    queryKey: ['dev-users'],
    queryFn: () => api<{ data: { id: string; email: string; name: string }[] }>('/dev/users'),
    retry: false,
  });

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await navigate({ to: '/' });
    } catch (e) {
      setError(
        e instanceof ApiError && e.status === 401 ? t('login.invalid_credentials') : (e as Error).message,
      );
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(() => login(email, password));
  };

  return (
    <Sheet>
      <h1 className="text-2xl font-bold">{t('login.title')}</h1>
      <p className="mt-1 mb-6 text-ink-soft">{t('login.subtitle')}</p>
      <form onSubmit={submit} className="space-y-4">
        <Field label={t('login.email')}>
          <Input
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
        <Field label={t('login.password')}>
          <Input
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        {error && (
          <p role="alert" className="text-sm text-critical">
            {error}
          </p>
        )}
        <Button variant="primary" type="submit" disabled={busy} className="w-full justify-center">
          {t('login.submit')}
        </Button>
      </form>
      <p className="mt-4 text-sm text-ink-soft">
        {t('login.noAccount')}{' '}
        <Link to="/register" className="font-semibold text-ink underline underline-offset-2">
          {t('login.registerLink')}
        </Link>
      </p>

      {devUsers.data && (
        <section className="mt-8 border-t border-rule pt-5" aria-labelledby="dev-login">
          <h2 id="dev-login" className="text-sm font-semibold">
            {t('login.devTitle')}
          </h2>
          <p className="mb-2 text-xs text-ink-soft">{t('login.devHint')}</p>
          <ul className="divide-y divide-rule/70">
            {devUsers.data.data.map((u) => (
              <li key={u.id}>
                <button
                  disabled={busy}
                  onClick={() => void run(() => loginAs(u.email))}
                  className="flex w-full items-baseline justify-between gap-3 py-1.5 text-left text-sm hover:text-margin"
                >
                  <span className="font-semibold">{u.name}</span>
                  <span className="truncate text-xs text-ink-soft">{u.email}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </Sheet>
  );
}
