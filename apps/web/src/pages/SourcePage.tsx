import { useState } from 'react';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, type ApiError } from '../lib/api.ts';
import { useAuth } from '../lib/auth.tsx';
import { when } from '../lib/format.ts';
import { FORMAT_LABEL, type Connect, type Source } from '../lib/types.ts';
import { Button } from '../components/ui.tsx';
import { ConnectInfo, KeyOnce } from '../components/Connect.tsx';

type Detail = Source & { connect: Connect };

export function SourcePage() {
  const { sourceId } = useParams({ from: '/app/sources/$sourceId' });
  const { t } = useTranslation();
  const { me } = useAuth();
  const isAdmin = me?.role === 'admin';
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [newKey, setNewKey] = useState<{ apiKey: string; connect: Connect } | null>(null);
  const q = useQuery({ queryKey: ['source', sourceId], queryFn: () => api<Detail>(`/sources/${sourceId}`) });

  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ['source', sourceId] }),
      qc.invalidateQueries({ queryKey: ['sources'] }),
    ]);
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api(`/sources/${sourceId}`, { method: 'PATCH', body: { enabled } }),
    onSuccess: refresh,
  });
  const rotate = useMutation({
    mutationFn: () =>
      api<{ apiKey: string; connect: Connect }>(`/sources/${sourceId}/rotate-key`, { method: 'POST' }),
    onSuccess: (r) => {
      setNewKey(r);
      void refresh();
    },
  });
  const remove = useMutation({
    mutationFn: () => api(`/sources/${sourceId}`, { method: 'DELETE' }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['sources'] });
      await navigate({ to: '/sources' });
    },
  });

  if (q.isPending) return <p className="px-6 py-5 text-ink-soft">{t('sourceLabels.loading')}</p>;
  if (q.isError) return <p className="px-6 py-5">{t('source.notFound')}</p>;
  const s = q.data;
  const failed = [toggle, rotate, remove].find((m) => m.isError)?.error as ApiError | undefined;

  return (
    <div className="max-w-3xl px-6 py-5">
      <Link to="/sources" className="text-sm text-ink-soft hover:underline">
        {t('sourceLabels.backLink')}
      </Link>
      <h1 className="mt-1 text-2xl font-bold">{s.name}</h1>
      <p className="mt-1 text-ink-soft">
        {s.origin === 'file' ? t('sourceLabels.fileCollector') : t(`sourceLabels.transport.${s.transport}`)}
        {s.format !== 'auto' &&
          t('source.format', {
            format: t(`sourceLabels.format.${s.format}`, {
              defaultValue: FORMAT_LABEL[s.format] ?? s.format,
            }),
          })}
        . {s.enabled ? t('sourceLabels.enabled') : t('sourceLabels.disabled')}.{' '}
        <span className="num">
          {t('source.messages', { count: s.eventCount })}
          {s.lastEventAt && t('source.lastAt', { when: when(s.lastEventAt) })}
        </span>
      </p>

      {s.origin === 'file' ? (
        <section
          className="mt-6 max-w-[72ch] rounded-control border-l-4 border-info bg-paper p-4"
          aria-labelledby="file"
        >
          <h2 id="file" className="font-semibold">
            {t('source.fileTitle', { path: s.filePath })}
          </h2>
          <p className="mt-1 text-sm text-ink-soft">{t('source.fileBody')}</p>
          {s.fileError && (
            <p role="alert" className="mt-2 text-sm text-critical">
              {t('source.fileErrorBody', { error: s.fileError })}
            </p>
          )}
        </section>
      ) : (
        <>
          {newKey && (
            <div className="mt-5">
              <KeyOnce apiKey={newKey.apiKey} />
            </div>
          )}

          <section className="mt-6 rounded-panel border border-rule bg-sheet p-4" aria-labelledby="connect">
            <h2 id="connect" className="mb-2 text-base font-semibold">
              {t('source.howToConnect')}
            </h2>
            <ConnectInfo connect={newKey?.connect ?? s.connect} apiKey={newKey?.apiKey} />
            {!newKey && (
              <p className="mt-3 text-sm text-ink-soft">
                {t('source.keyPrefixBefore')}
                <span className="font-semibold">{s.apiKeyPrefix}…</span>
                {t('source.keyPrefixAfter')}
              </p>
            )}
          </section>

          {isAdmin && (
            <section className="mt-6 flex flex-wrap gap-2" aria-label={t('source.manage')}>
              <Button onClick={() => toggle.mutate(!s.enabled)} disabled={toggle.isPending}>
                {s.enabled ? t('source.pause') : t('source.resume')}
              </Button>
              <Button
                onClick={() => {
                  if (confirm(t('source.rotateConfirm'))) rotate.mutate();
                }}
                disabled={rotate.isPending}
              >
                {t('source.rotate')}
              </Button>
              <Button
                variant="quiet"
                className="text-critical"
                onClick={() => {
                  if (confirm(t('source.removeConfirm', { name: s.name }))) remove.mutate();
                }}
                disabled={remove.isPending}
              >
                {t('source.remove')}
              </Button>
            </section>
          )}
        </>
      )}
      {failed && (
        <p role="alert" className="mt-3 text-sm text-critical">
          {failed.message}
        </p>
      )}
    </div>
  );
}
