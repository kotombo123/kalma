import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useSearch } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, type ApiError } from '../lib/api.ts';
import {
  FORMAT_LABEL,
  TRANSPORT_LABEL,
  type Connect,
  type Page,
  type Source,
  type System,
  type Transport,
} from '../lib/types.ts';
import { Button, Field, Input, MoreOptions } from '../components/ui.tsx';
import { ConnectInfo, KeyOnce } from '../components/Connect.tsx';
import { ConnectorDrop, ConnectorTemplates } from '../components/Connectors.tsx';

/** Numbered because it is a real sequence: transport → settings → format. */
function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <section className="grid gap-4 border-b border-rule py-5 last:border-b-0 sm:grid-cols-[2.5rem_1fr]">
      <div aria-hidden className="num text-2xl font-bold text-margin">
        {n}
      </div>
      <div>
        <h2 className="mb-3 text-base font-semibold">{title}</h2>
        {children}
      </div>
    </section>
  );
}

/**
 * After creating a source: wait for its first message, then lead straight to "check that we understood it"
 * (implementation_plan.md §5.5). Polls the source's schemas; the live feed also refreshes them.
 */
function WaitForFirstMessage({ sourceId }: { sourceId: string }) {
  const { t } = useTranslation();
  const schemas = useQuery({
    queryKey: ['schemas', 'for-source', sourceId],
    queryFn: () =>
      api<Page<{ id: string; name: string | null; status: string }>>(`/schemas?sourceId=${sourceId}&limit=5`),
    refetchInterval: (q) => ((q.state.data?.data.length ?? 0) > 0 ? false : 2000),
  });
  const first = schemas.data?.data[0];
  return (
    <section
      aria-live="polite"
      className="mt-6 rounded-panel border-2 p-4"
      style={{ borderColor: first ? 'var(--info)' : 'var(--rule)' }}
    >
      {first ? (
        <>
          <h2 className="text-base font-semibold">{t('newSource2.firstTitle')}</h2>
          <p className="mt-1 max-w-[64ch] text-sm text-ink-soft">{t('newSource2.firstBody')}</p>
          <Link
            to="/schemas/$schemaId"
            params={{ schemaId: first.id }}
            className="mt-3 inline-flex h-8 items-center rounded-control bg-ink px-3 text-sm font-semibold text-sheet hover:bg-ink/90"
          >
            {t('newSource2.check')}
          </Link>
        </>
      ) : (
        <>
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <span
              aria-hidden
              className="size-2 animate-pulse rounded-full motion-reduce:animate-none"
              style={{ background: 'var(--info)' }}
            />
            {t('newSource2.waiting')}
          </h2>
          <p className="mt-1 max-w-[64ch] text-sm text-ink-soft">{t('newSource2.waitingBody')}</p>
        </>
      )}
    </section>
  );
}

interface Created {
  source: Source;
  apiKey: string;
  connect: Connect;
}

export function NewSourcePage() {
  const { systemId: initialSystem } = useSearch({ from: '/app/sources/new' });
  const { t } = useTranslation();
  const qc = useQueryClient();
  const systems = useQuery({ queryKey: ['systems'], queryFn: () => api<Page<System>>('/systems?limit=100') });

  const [systemId, setSystemId] = useState(initialSystem);
  const [name, setName] = useState('');
  const [transport, setTransport] = useState<Transport>('http');
  // "Inny protokół": connected by a file in config/connectors/ (#46), not by this form
  const [other, setOther] = useState(false);
  const systemName = systems.data?.data.find((s) => s.id === systemId)?.name ?? '';
  const [cfg, setCfg] = useState<Record<string, string>>({ intervalSec: '30' });
  const [fromBeginning, setFromBeginning] = useState(false);
  const [format, setFormat] = useState('auto');
  const [parser, setParser] = useState({ grokPattern: '', csvHeaders: '' });
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setCfg((c) => ({ ...c, [k]: e.target.value }));

  const config = () => {
    switch (transport) {
      case 'http':
        return { transport };
      case 'kafka':
        return { transport, topic: cfg.topic ?? '', fromBeginning };
      case 'file':
        return { transport, path: cfg.path ?? '', ...(cfg.recordStart && { recordStart: cfg.recordStart }) };
      case 'poll':
        return {
          transport,
          url: cfg.url ?? '',
          intervalSec: Number(cfg.intervalSec) || 30,
          ...(cfg.itemsPath && { itemsPath: cfg.itemsPath }),
          ...(cfg.idPath && { idPath: cfg.idPath }),
        };
    }
  };

  const create = useMutation({
    mutationFn: () =>
      api<Created>('/sources', {
        method: 'POST',
        body: {
          systemId,
          name,
          config: config(),
          format,
          ...(format === 'regex' &&
            parser.grokPattern && { parserOptions: { grokPattern: parser.grokPattern } }),
          ...(format === 'csv' &&
            parser.csvHeaders && {
              parserOptions: { csvHeaders: parser.csvHeaders.split(',').map((h) => h.trim()) },
            }),
        },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sources'] }),
  });

  if (create.data) {
    const { source, apiKey, connect } = create.data;
    return (
      <div className="max-w-3xl px-6 py-5">
        <h1 className="text-2xl font-bold">{t('newSource2.connectTitle', { name: source.name })}</h1>
        <p className="mt-1 mb-5 text-ink-soft">{t('newSource2.ready')}</p>
        <KeyOnce apiKey={apiKey} />
        <div className="mt-6 rounded-panel border border-rule bg-sheet p-4">
          <ConnectInfo connect={connect} apiKey={apiKey} />
        </div>
        <WaitForFirstMessage sourceId={source.id} />
        <div className="mt-6 flex gap-3">
          <Link
            to="/sources/$sourceId"
            params={{ sourceId: source.id }}
            className="font-semibold underline underline-offset-2"
          >
            {t('newSource2.settings')}
          </Link>
          <Link to="/sources" className="text-ink-soft underline underline-offset-2">
            {t('newSource2.backToList')}
          </Link>
        </div>
      </div>
    );
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };
  const err = create.error as ApiError | null;

  return (
    <form onSubmit={submit} className="max-w-3xl px-6 py-5">
      <Link to="/sources" className="text-sm text-ink-soft hover:underline">
        {t('sourceLabels.backLink')}
      </Link>
      <h1 className="mt-1 text-2xl font-bold">{t('newSource2.title')}</h1>

      <Step n={1} title={t('newSource2.step1')}>
        <div role="radiogroup" aria-label="Transport" className="grid gap-2 sm:grid-cols-2">
          {(Object.keys(TRANSPORT_LABEL) as Transport[]).map((tr) => (
            <label
              key={tr}
              className={`cursor-pointer rounded-control border p-3 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-margin ${!other && transport === tr ? 'border-ink bg-sheet' : 'border-rule hover:border-ink-soft'}`}
            >
              <input
                type="radio"
                name="transport"
                value={tr}
                checked={!other && transport === tr}
                onChange={() => {
                  setTransport(tr);
                  setOther(false);
                }}
                className="sr-only"
              />
              <span className="font-semibold">{t(`sourceLabels.transport.${tr}`)}</span>
              <span className="mt-0.5 block text-sm text-ink-soft">{t(`newSource2.help.${tr}`)}</span>
            </label>
          ))}
          <label
            className={`cursor-pointer rounded-control border p-3 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-margin sm:col-span-2 ${other ? 'border-ink bg-sheet' : 'border-rule hover:border-ink-soft'}`}
          >
            <input
              type="radio"
              name="transport"
              checked={other}
              onChange={() => setOther(true)}
              className="sr-only"
            />
            <span className="font-semibold">{t('newSource2.otherTitle')}</span>
            <span className="mt-0.5 block text-sm text-ink-soft">{t('newSource2.otherBody')}</span>
          </label>
        </div>
      </Step>

      {other && (
        <Step n={2} title={t('newSource2.fileStep')}>
          <Field label={t('newSource2.system')}>
            <select
              value={systemId}
              onChange={(e) => setSystemId(e.target.value)}
              className="mb-4 h-9 w-full rounded-control border border-rule bg-sheet px-2 sm:w-80"
            >
              <option value="" disabled>
                {t('newSource2.pickSystem')}
              </option>
              {systems.data?.data.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </Field>
          {systemName ? (
            <>
              <ConnectorDrop systemName={systemName} />
              <p className="my-4 text-sm text-ink-soft">{t('newSource2.noFile')}</p>
              <ConnectorTemplates systemName={systemName} />
            </>
          ) : (
            <p className="text-sm text-ink-soft">{t('newSource2.pickSystemHint')}</p>
          )}
        </Step>
      )}
      {!other && (
        <>
          <Step n={2} title={t('newSource2.details')}>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t('newSource2.system')}>
                <select
                  required
                  value={systemId}
                  onChange={(e) => setSystemId(e.target.value)}
                  className="h-9 w-full rounded-control border border-rule bg-sheet px-2"
                >
                  <option value="" disabled>
                    {t('newSource2.pickSystem')}
                  </option>
                  {systems.data?.data.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t('newSource2.sourceName')}>
                <Input
                  required
                  maxLength={100}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={t('newSource2.sourceNamePlaceholder')}
                />
              </Field>
              {transport === 'kafka' && (
                <>
                  <Field label={t('newSource2.kafkaTopic')}>
                    <Input
                      required
                      value={cfg.topic ?? ''}
                      onChange={set('topic')}
                      placeholder="workflow-events"
                    />
                  </Field>
                  <label className="flex items-center gap-2 self-end pb-2 text-sm">
                    <input
                      type="checkbox"
                      checked={fromBeginning}
                      onChange={(e) => setFromBeginning(e.target.checked)}
                    />
                    {t('newSource2.fromBeginning')}
                  </label>
                </>
              )}
              {transport === 'file' && (
                <>
                  <Field label={t('newSource2.filePath')} hint={t('newSource2.filePathHint')}>
                    <Input
                      required
                      value={cfg.path ?? ''}
                      onChange={set('path')}
                      placeholder="/var/log/pricing/engine.log"
                    />
                  </Field>
                  <Field label={t('newSource2.recordStart')} hint={t('newSource2.recordStartHint')}>
                    <Input
                      value={cfg.recordStart ?? ''}
                      onChange={set('recordStart')}
                      placeholder="^\d{4}-\d{2}-\d{2}"
                    />
                  </Field>
                </>
              )}
              {transport === 'poll' && (
                <>
                  <Field label={t('newSource2.apiUrl')}>
                    <Input
                      required
                      type="url"
                      value={cfg.url ?? ''}
                      onChange={set('url')}
                      placeholder="https://monitoring.example/incidents"
                    />
                  </Field>
                  <Field label={t('newSource2.interval')}>
                    <Input
                      type="number"
                      min={5}
                      value={cfg.intervalSec ?? '30'}
                      onChange={set('intervalSec')}
                    />
                  </Field>
                  <Field label={t('newSource2.itemsPath')} hint={t('newSource2.itemsPathHint')}>
                    <Input value={cfg.itemsPath ?? ''} onChange={set('itemsPath')} />
                  </Field>
                  <Field label={t('newSource2.idPath')} hint={t('newSource2.idPathHint')}>
                    <Input value={cfg.idPath ?? ''} onChange={set('idPath')} placeholder="id" />
                  </Field>
                </>
              )}
            </div>
          </Step>

          <Step n={3} title={t('newSource2.formatStep')}>
            <p className="max-w-[72ch] text-sm">{t('newSource2.formatBody')}</p>
            <MoreOptions count={1} changed={format !== 'auto' ? 1 : 0} label={t('newSource2.setFormat')}>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={t('newSource2.format')} hint={t('newSource2.formatHint')}>
                  <select
                    value={format}
                    onChange={(e) => setFormat(e.target.value)}
                    className="h-9 w-full rounded-control border border-rule bg-sheet px-2"
                  >
                    {Object.entries(FORMAT_LABEL).map(([v, l]) => (
                      <option key={v} value={v}>
                        {t(`sourceLabels.format.${v}`, { defaultValue: l })}
                      </option>
                    ))}
                  </select>
                </Field>
                {format === 'regex' && (
                  <Field
                    label={t('newSource2.grok')}
                    hint={t('newSource2.grokHint', {
                      example: '%{TIMESTAMP_ISO8601:ts} %{LOGLEVEL:level} %{GREEDYDATA:message}',
                    })}
                  >
                    <Input
                      value={parser.grokPattern}
                      onChange={(e) => setParser((p) => ({ ...p, grokPattern: e.target.value }))}
                    />
                  </Field>
                )}
                {format === 'csv' && (
                  <Field label={t('newSource2.csvHeaders')} hint={t('newSource2.csvHeadersHint')}>
                    <Input
                      value={parser.csvHeaders}
                      onChange={(e) => setParser((p) => ({ ...p, csvHeaders: e.target.value }))}
                    />
                  </Field>
                )}
              </div>
            </MoreOptions>
          </Step>

          {err && (
            <div role="alert" className="mb-4 text-sm text-critical">
              <p>{err.code === 'validation' ? t('newSource2.fixSettings') : err.message}</p>
              {err.issues && (
                <ul className="mt-1 list-disc pl-5">
                  {err.issues.map((i) => (
                    <li key={i.path?.join('.') ?? i.message}>{i.message}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
          <Button variant="primary" type="submit" disabled={create.isPending || !systemId}>
            {t('newSource2.create')}
          </Button>
        </>
      )}
    </form>
  );
}
