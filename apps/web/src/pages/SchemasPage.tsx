import { useState, type FormEvent } from 'react';
import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, type ApiError } from '../lib/api.ts';
import { when, plural } from '../lib/format.ts';
import { ROLES, type Page, type SchemaInfo, type Normalized } from '../lib/types.ts';
import { Button } from '../components/ui.tsx';

const STATUSES: SchemaInfo['status'][] = ['new', 'mapped', 'ignored'];

/** One line of the sample, shortened, so a person recognizes the message at a glance. */
function preview(sample: unknown) {
  const s = JSON.stringify(sample);
  return s.length > 140 ? `${s.slice(0, 140)}…` : s;
}

interface TestResult {
  format: string;
  parseError: boolean;
  recordCount: number;
  knownSchema: { id: string; name: string | null; status: string } | null;
  fields: SchemaInfo['fields'];
  guessedRoles: SchemaInfo['guessedRoles'];
  preset: SchemaInfo['preset'];
  normalized: Normalized;
}

/** "Paste your own example" — try a message before any source sends it. Nothing is saved. */
function PasteExample() {
  const { t } = useTranslation();
  const [body, setBody] = useState('');
  const test = useMutation({
    mutationFn: () => api<TestResult>('/schemas/test', { method: 'POST', body: { body } }),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    test.mutate();
  };
  const r = test.data;
  return (
    <section aria-labelledby="paste" className="rounded-panel border border-rule bg-sheet p-4">
      <h2 id="paste" className="text-base font-semibold">
        {t('schemas.paste.title')}
      </h2>
      <p className="mb-3 text-sm text-ink-soft">
        {t('schemas.paste.intro')}
      </p>
      <form onSubmit={submit}>
        <label htmlFor="example" className="sr-only">
          {t('schemas.paste.label')}
        </label>
        <textarea
          id="example"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={6}
          className="w-full rounded-control border border-rule bg-paper p-3 text-sm"
          placeholder='{"evt": "disk.pressure", "lvl": "CRIT", "host": {"name": "db-node-7"}}'
        />
        <Button type="submit" variant="primary" disabled={!body.trim() || test.isPending} className="mt-2">
          {t('schemas.paste.submit')}
        </Button>
      </form>
      {test.isError && (
        <p role="alert" className="mt-3 text-sm text-critical">
          {(test.error as ApiError).message}
        </p>
      )}
      {r && (
        <div role="status" className="mt-4 space-y-2 text-sm">
          <p>
            {t('schemas.paste.format')} <span className="font-semibold">{r.format}</span>
            {r.parseError && t('schemas.paste.parseError')}, {r.recordCount}{' '}
            {plural(
              r.recordCount,
              t('schemas.paste.recordOne'),
              t('schemas.paste.recordFew'),
              t('schemas.paste.recordMany'),
            )}
            , {r.fields.length}{' '}
            {plural(r.fields.length, t('schemas.fieldOne'), t('schemas.fieldFew'), t('schemas.fieldMany'))}.
            {r.preset && (
              <>
                {' '}
                {t('schemas.paste.recognizedFormat')} <span className="font-semibold">{r.preset.name}</span>.
              </>
            )}
          </p>
          {r.knownSchema ? (
            <p>
              {t('schemas.paste.known')}{' '}
              <Link
                to="/schemas/$schemaId"
                params={{ schemaId: r.knownSchema.id }}
                className="font-semibold underline"
              >
                {r.knownSchema.name ?? t('schemas.paste.unnamed')}
              </Link>
              .
            </p>
          ) : (
            <p className="text-ink-soft">
              {t('schemas.paste.newSchema')}
            </p>
          )}
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
            {ROLES.filter((role) => r.guessedRoles[role]).map((role) => (
              <div key={role} className="contents">
                <dt className="text-ink-soft">{t(`fieldRole.${role}`)}</dt>
                <dd>
                  <span className="font-semibold">{r.guessedRoles[role]!.path}</span>{' '}
                  <span className="text-ink-soft">
                    {t('schemas.paste.confidence', {
                      pct: Math.round(r.guessedRoles[role]!.confidence * 100),
                    })}
                  </span>
                </dd>
              </div>
            ))}
          </dl>
          <p>
            {t('schemas.paste.result')} <span className="font-semibold">{r.normalized.severity}</span>
            {r.normalized.title && t('schemas.paste.resultTitle', { title: r.normalized.title })}.
          </p>
        </div>
      )}
    </section>
  );
}

/** Discovered schemas. New ones come first: they are the "new schema" tiles waiting for a mapping. */
export function SchemasPage() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<SchemaInfo['status']>('new');
  const schemas = useQuery({
    queryKey: ['schemas', status],
    queryFn: () => api<Page<SchemaInfo>>(`/schemas?status=${status}&limit=100`),
  });
  const list = schemas.data?.data ?? [];

  return (
    <div className="px-6 py-5">
      <h1 className="text-2xl font-bold">{t('schemas.title')}</h1>
      <p className="mt-1 mb-5 max-w-[72ch] text-ink-soft">
        {t('schemas.intro')}
      </p>

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_28rem]">
        <section aria-labelledby="list" className="rounded-panel border border-rule bg-sheet">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-rule px-4 py-3">
            <h2 id="list" className="text-base font-semibold">
              {t(`schemas.status_${status}`)}
            </h2>
            <div
              role="radiogroup"
              aria-label={t('schemas.show')}
              className="flex rounded-control border border-rule p-0.5"
            >
              {STATUSES.map((s) => (
                <button
                  key={s}
                  role="radio"
                  aria-checked={status === s}
                  onClick={() => setStatus(s)}
                  className={`rounded-[4px] px-3 py-1 text-sm ${status === s ? 'bg-ink font-semibold text-sheet' : 'text-ink-soft hover:text-ink'}`}
                >
                  {t(`schemas.status_${s}`)}
                </button>
              ))}
            </div>
          </div>
          {!schemas.isPending && list.length === 0 && (
            <p className="px-4 py-6 text-ink-soft">
              {status === 'new'
                ? t('schemas.emptyNew')
                : t('schemas.emptyOther')}
            </p>
          )}
          <ul>
            {list.map((s) => (
              <li key={s.id} className="border-b border-rule/70 last:border-b-0">
                <Link
                  to="/schemas/$schemaId"
                  params={{ schemaId: s.id }}
                  className="block px-4 py-3 hover:bg-paper focus-visible:bg-paper"
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-x-4">
                    <span className="font-semibold">{s.name ?? s.preset?.name ?? t('schemas.newSchema')}</span>
                    <span className="num text-sm text-ink-soft">
                      {s.eventCount}{' '}
                      {plural(s.eventCount, t('schemas.eventOne'), t('schemas.eventFew'), t('schemas.eventMany'))},{' '}
                      {t('schemas.lastAt', { when: when(s.lastSeen) })}
                    </span>
                  </div>
                  <div className="text-sm text-ink-soft">
                    {t('schemas.source', { name: s.sourceName })}, {s.fields.length}{' '}
                    {plural(s.fields.length, t('schemas.fieldOne'), t('schemas.fieldFew'), t('schemas.fieldMany'))}
                    {s.preset && s.status === 'new' && (
                      <>
                        . {t('schemas.recognized')} <span className="font-semibold text-ink">{s.preset.name}</span>
                      </>
                    )}
                    {s.unmatchedCount > 0 && <>. {t('schemas.unmatched', { count: s.unmatchedCount })}</>}
                  </div>
                  <code className="mt-1 block truncate text-xs text-ink-soft">{preview(s.sample)}</code>
                </Link>
              </li>
            ))}
          </ul>
        </section>
        <PasteExample />
      </div>
    </div>
  );
}
