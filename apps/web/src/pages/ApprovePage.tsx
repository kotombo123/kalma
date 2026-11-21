import { useParams } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, type ApiError } from '../lib/api.ts';
import { type Severity } from '../lib/types.ts';
import { Button } from '../components/ui.tsx';
import { Sheet } from './LoginPage.tsx';

interface Info {
  alertTitle: string;
  severity: Severity;
  stepId: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
}

/**
 * Link from an approval email. Opening it only shows the request (mail scanners prefetch links);
 * the decision is a button press. The long token in the link is the credential — no login needed.
 */
export function ApprovePage({ intent }: { intent: 'approved' | 'rejected' }) {
  const { t } = useTranslation();
  const { token } = useParams({ strict: false }) as { token: string };
  const info = useQuery({
    queryKey: ['approve', token],
    queryFn: () => api<Info>(`/approve/${token}`),
    retry: false,
  });
  const decide = useMutation({
    mutationFn: (decision: 'approved' | 'rejected') =>
      api<{ decision: string }>(`/approve/${token}`, { method: 'POST', body: { decision } }),
  });

  if (info.isPending) return <Sheet>{t('approve.checking')}</Sheet>;
  if (info.isError)
    return (
      <Sheet>
        <h1 className="text-xl font-bold">{t('approve.brokenTitle')}</h1>
        <p className="mt-2 text-ink-soft">{t('approve.brokenText')}</p>
      </Sheet>
    );
  const i = info.data;
  const done = decide.data?.decision ?? (i.status !== 'pending' ? i.status : null);

  return (
    <Sheet>
      <p className="text-sm font-semibold" style={{ color: `var(--${i.severity})` }}>
        {t(`severity.${i.severity}`)}
      </p>
      <h1 className="mt-1 text-2xl font-bold">{i.alertTitle}</h1>
      {done ? (
        <p role="status" className="mt-4">
          {done === 'approved'
            ? t('approve.approvedDone')
            : done === 'rejected'
              ? t('approve.rejectedDone')
              : t('approve.expired')}
        </p>
      ) : (
        <>
          <p className="mt-2 text-ink-soft">
            {t('approve.prompt')}
          </p>
          <div className="mt-5 flex gap-2">
            <Button
              variant={intent === 'approved' ? 'primary' : 'ink'}
              disabled={decide.isPending}
              onClick={() => decide.mutate('approved')}
            >
              {t('approve.approve')}
            </Button>
            <Button
              variant={intent === 'rejected' ? 'primary' : 'ink'}
              disabled={decide.isPending}
              onClick={() => decide.mutate('rejected')}
            >
              {t('approve.reject')}
            </Button>
          </div>
          {decide.isError && (
            <p role="alert" className="mt-3 text-sm text-critical">
              {(decide.error as ApiError).code === 'already_decided'
                ? t('approve.alreadyDecided')
                : (decide.error as ApiError).message}
            </p>
          )}
        </>
      )}
    </Sheet>
  );
}
