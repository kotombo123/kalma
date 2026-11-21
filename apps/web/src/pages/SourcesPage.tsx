import { useState, type FormEvent } from 'react';
import { Link } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, type ApiError } from '../lib/api.ts';
import { useAuth } from '../lib/auth.tsx';
import { when, plural } from '../lib/format.ts';
import { FORMAT_LABEL, type Page, type Source, type System } from '../lib/types.ts';
import { Button, Field, Input } from '../components/ui.tsx';
import { ConnectorFiles } from '../components/Connectors.tsx';

function AddSystem({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const create = useMutation({
    mutationFn: () =>
      api<System>('/systems', { method: 'POST', body: { name, ...(description && { description }) } }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['systems'] });
      onDone();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };
  return (
    <form
      onSubmit={submit}
      className="mb-6 grid max-w-3xl gap-3 rounded-panel border border-rule bg-sheet p-4 sm:grid-cols-[1fr_1.5fr_auto] sm:items-end"
    >
      <Field label={t('sources.systemName')}>
        <Input
          required
          autoFocus
          maxLength={100}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('sources.systemNamePlaceholder')}
        />
      </Field>
      <Field label={t('sources.descOptional')}>
        <Input
          maxLength={500}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t('sources.descPlaceholder')}
        />
      </Field>
      <div className="flex gap-2">
        <Button variant="primary" type="submit" disabled={create.isPending}>
          {t('sources.addSystem')}
        </Button>
        <Button variant="quiet" type="button" onClick={onDone}>
          {t('sources.cancel')}
        </Button>
      </div>
      {create.isError && (
        <p role="alert" className="text-sm text-critical sm:col-span-3">
          {(create.error as ApiError).message}
        </p>
      )}
    </form>
  );
}

/** Systems with their sources. A system groups the sources of one product or service. */
/** New message shapes from one source: one line, straight to the check when there is just one. */
function NewKinds({ kinds }: { kinds: { id: string; name: string | null }[] }) {
  const { t } = useTranslation();
  if (kinds.length === 0) return null;
  const cls = 'mt-1 flex items-center gap-1.5 text-sm hover:underline';
  const dot = <span aria-hidden className="size-2 shrink-0 rounded-full bg-margin" />;
  return kinds.length === 1 ? (
    <Link to="/schemas/$schemaId" params={{ schemaId: kinds[0]!.id }} className={cls}>
      {dot}
      {t('sources.newKindOne', { name: kinds[0]!.name ? `: ${kinds[0]!.name}` : '' })}
    </Link>
  ) : (
    <Link to="/schemas" className={cls}>
      {dot}
      {kinds.length}{' '}
      {plural(kinds.length, t('sources.newKindOneWord'), t('sources.newKindsFew'), t('sources.newKindsMany'))}
      {t('sources.newKindsMessage')}
      {t('sources.newKindsSuffix')}
    </Link>
  );
}

export function SourcesPage() {
  const { t } = useTranslation();
  const { me } = useAuth();
  const isAdmin = me?.role === 'admin';
  const [adding, setAdding] = useState(false);
  const systems = useQuery({ queryKey: ['systems'], queryFn: () => api<Page<System>>('/systems?limit=100') });
  const sources = useQuery({ queryKey: ['sources'], queryFn: () => api<Page<Source>>('/sources?limit=100') });
  // new message shapes are shown next to the source that sent them, not on a separate screen
  const fresh = useQuery({
    queryKey: ['schemas', 'new-count'],
    queryFn: () =>
      api<Page<{ id: string; sourceId: string; name: string | null }>>('/schemas?status=new&limit=100'),
  });
  const newBySource = new Map<string, { id: string; name: string | null }[]>();
  for (const sc of fresh.data?.data ?? [])
    newBySource.set(sc.sourceId, [...(newBySource.get(sc.sourceId) ?? []), sc]);

  const bySystem = new Map<string, Source[]>();
  for (const s of sources.data?.data ?? [])
    bySystem.set(s.systemId, [...(bySystem.get(s.systemId) ?? []), s]);
  const list = systems.data?.data ?? [];

  return (
    <div className="px-6 py-5">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{t('sources.title')}</h1>
          <p className="mt-1 max-w-[72ch] text-ink-soft">{t('sources.subtitle')}</p>
        </div>
        {isAdmin && !adding && (
          <Button variant="primary" onClick={() => setAdding(true)}>
            {t('sources.addSystem')}
          </Button>
        )}
      </div>

      {adding && <AddSystem onDone={() => setAdding(false)} />}

      <div className="mb-6">
        <ConnectorFiles />
      </div>

      {systems.isPending && <p className="text-ink-soft">{t('sourceLabels.loading')}</p>}
      {!systems.isPending && list.length === 0 && (
        <div className="max-w-[72ch] rounded-panel border border-dashed border-rule p-6">
          <p className="font-semibold">{t('sources.emptyTitle')}</p>
          <p className="mt-1 text-ink-soft">{isAdmin ? t('sources.emptyAdmin') : t('sources.emptyMember')}</p>
        </div>
      )}

      <div className="space-y-6">
        {list.map((sys) => {
          const items = bySystem.get(sys.id) ?? [];
          return (
            <section
              key={sys.id}
              aria-labelledby={`sys-${sys.id}`}
              className="rounded-panel border border-rule bg-sheet"
            >
              <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-rule px-4 py-3">
                <div>
                  <h2 id={`sys-${sys.id}`} className="text-base font-semibold">
                    {sys.name}
                  </h2>
                  {sys.description && <p className="text-sm text-ink-soft">{sys.description}</p>}
                </div>
                {isAdmin && (
                  <Link
                    to="/sources/new"
                    search={{ systemId: sys.id }}
                    className="rounded-control border border-rule px-3 py-1 text-sm font-semibold hover:border-ink-soft"
                  >
                    {t('sources.connect')}
                  </Link>
                )}
              </header>
              {items.length === 0 ? (
                <p className="px-4 py-4 text-sm text-ink-soft">{t('sources.notConnected')}</p>
              ) : (
                <table className="w-full text-sm">
                  <caption className="sr-only">{t('sources.caption', { name: sys.name })}</caption>
                  <thead>
                    <tr className="border-b border-rule text-left text-xs text-ink-soft">
                      <th scope="col" className="px-4 py-2 font-semibold">
                        {t('sources.colConnection')}
                      </th>
                      <th scope="col" className="border-l border-rule/70 px-3 py-2 font-semibold">
                        {t('sources.colHow')}
                      </th>
                      <th scope="col" className="border-l border-rule/70 px-3 py-2 text-right font-semibold">
                        {t('sources.colMessages')}
                      </th>
                      <th scope="col" className="border-l border-rule/70 px-3 py-2 font-semibold">
                        {t('sources.colLast')}
                      </th>
                      <th scope="col" className="border-l border-rule/70 px-3 py-2 font-semibold">
                        {t('sources.colState')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((s) => (
                      <tr key={s.id} className="border-b border-rule/70 last:border-b-0">
                        <td className="px-4 py-2.5">
                          <Link
                            to="/sources/$sourceId"
                            params={{ sourceId: s.id }}
                            className="font-semibold hover:underline"
                          >
                            {s.name}
                          </Link>
                          {s.origin === 'file' && (
                            <div className="text-xs text-ink-soft">
                              {t('sources.fromFile', { path: s.filePath })}
                            </div>
                          )}
                          {s.fileError && (
                            <div className="text-sm text-critical">
                              {t('sources.fileError', { error: s.fileError })}
                            </div>
                          )}
                          <NewKinds kinds={newBySource.get(s.id) ?? []} />
                        </td>
                        <td className="border-l border-rule/70 px-3 py-2.5">
                          {s.origin === 'file'
                            ? t('sourceLabels.fileCollector')
                            : t(`sourceLabels.transport.${s.transport}`)}
                          {s.format !== 'auto' && (
                            <span className="block text-xs text-ink-soft">
                              {t(`sourceLabels.format.${s.format}`, {
                                defaultValue: FORMAT_LABEL[s.format] ?? s.format,
                              })}
                            </span>
                          )}
                        </td>
                        <td className="num border-l border-rule/70 px-3 py-2.5 text-right">{s.eventCount}</td>
                        <td className="num border-l border-rule/70 px-3 py-2.5 text-ink-soft">
                          {s.lastEventAt ? when(s.lastEventAt) : t('sources.nothingYet')}
                        </td>
                        <td className="border-l border-rule/70 px-3 py-2.5">
                          {s.enabled ? (
                            t('sourceLabels.enabled')
                          ) : (
                            <span className="text-ink-soft">{t('sourceLabels.disabled')}</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <footer className="px-4 py-2 text-xs text-ink-soft">
                {items.length}{' '}
                {plural(items.length, t('sources.connOne'), t('sources.connFew'), t('sources.connMany'))}
              </footer>
            </section>
          );
        })}
      </div>
    </div>
  );
}
