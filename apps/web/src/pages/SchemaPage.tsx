import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type ApiError } from '../lib/api.ts';
import { useAuth } from '../lib/auth.tsx';
import { uiLocale, when } from '../lib/format.ts';
import {
  ROLES,
  type FieldRole,
  type MappingDraft,
  type Normalized,
  type SchemaInfo,
  type Severity,
} from '../lib/types.ts';
import { Button, Field, Input, MoreOptions, sevVar } from '../components/ui.tsx';
import { fieldLabel } from '../lib/labels.ts';

type Detail = SchemaInfo & { mapping: (MappingDraft & { version: number }) | null };
interface Preview {
  sample: Normalized;
  events: Normalized[];
  warnings: string[];
}

const SEVERITIES: Severity[] = ['critical', 'error', 'warning', 'info'];

/** The mapping asked as questions (implementation_plan.md §5.5); the rest stays under "Więcej opcji". */
const QUESTIONS: FieldRole[] = ['title', 'severity', 'entity', 'dedupKey', 'timestamp'];
const MORE_QUESTIONS: FieldRole[] = ['status', 'message'];

/** Start from the saved mapping, else the recognized preset, else the guesses. */
function initialDraft(s: Detail): MappingDraft {
  if (s.mapping) {
    const { roles, severityMap, resolvedValues, presetId } = s.mapping;
    return {
      roles,
      severityMap: severityMap ?? undefined,
      resolvedValues: resolvedValues ?? undefined,
      presetId: presetId ?? undefined,
    };
  }
  if (s.preset) return s.preset.mapping;
  return {
    roles: Object.fromEntries(Object.entries(s.guessedRoles).map(([role, g]) => [role, { path: g!.path }])),
  };
}

const show = (v: unknown) =>
  v === null || v === undefined ? '—' : typeof v === 'string' ? v : JSON.stringify(v);

/** F-15: map a new message shape by clicking roles onto its fields, with a live preview. */
export function SchemaPage() {
  const { t } = useTranslation();
  const { schemaId } = useParams({ from: '/app/schemas/$schemaId' });
  const { me } = useAuth();
  const canEdit = me?.role === 'admin' || Boolean(me?.teams.some((tm) => tm.role === 'lead'));
  const qc = useQueryClient();
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ['schema', schemaId], queryFn: () => api<Detail>(`/schemas/${schemaId}`) });

  const [draft, setDraft] = useState<MappingDraft | null>(null);
  const [name, setName] = useState('');
  useEffect(() => {
    if (q.data && !draft) {
      setDraft(initialDraft(q.data));
      setName(q.data.name ?? q.data.preset?.name ?? '');
    }
  }, [q.data, draft]);

  // live preview of the draft (debounced)
  const [debounced, setDebounced] = useState(draft);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(draft), 250);
    return () => clearTimeout(timer);
  }, [draft]);
  const preview = useQuery({
    queryKey: ['schema-preview', schemaId, debounced],
    queryFn: () =>
      api<Preview>(`/schemas/${schemaId}/preview`, { method: 'POST', body: { mapping: debounced } }),
    enabled: Boolean(debounced),
    placeholderData: keepPreviousData,
  });

  const save = useMutation({
    mutationFn: () =>
      api<{ mapping: { version: number }; warnings: string[] }>(`/schemas/${schemaId}/mapping`, {
        method: 'POST',
        body: { ...draft, ...(name.trim() && { name: name.trim() }) },
      }),
    onSuccess: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: ['schema', schemaId] }),
        qc.invalidateQueries({ queryKey: ['schemas'] }),
      ]),
  });
  const ignore = useMutation({
    mutationFn: (status: 'ignored' | 'new') =>
      api(`/schemas/${schemaId}`, { method: 'PATCH', body: { status } }),
    onSuccess: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: ['schema', schemaId] }),
        qc.invalidateQueries({ queryKey: ['schemas'] }),
      ]),
  });

  const roleOf = useMemo(() => {
    const m = new Map<string, FieldRole>();
    for (const [role, b] of Object.entries(draft?.roles ?? {})) if (b?.path) m.set(b.path, role as FieldRole);
    return m;
  }, [draft]);

  if (q.isPending || !draft) return <p className="px-6 py-5 text-ink-soft">{t('schema.loading')}</p>;
  if (q.isError) return <p className="px-6 py-5">{t('schema.notFound')}</p>;
  const s = q.data;

  const assign = (path: string, role: FieldRole | '') =>
    setDraft((d) => {
      const roles = { ...d!.roles };
      for (const [r, b] of Object.entries(roles)) if (b?.path === path) delete roles[r as FieldRole];
      if (role) roles[role] = { path };
      return { ...d!, roles, presetId: undefined };
    });

  /** One question = one role; picking a field for it does not touch the other answers. */
  const setRole = (role: FieldRole, path: string) =>
    setDraft((d) => {
      const roles = { ...d!.roles };
      if (path) roles[role] = { path };
      else delete roles[role];
      return { ...d!, roles, presetId: undefined };
    });
  const question = (role: FieldRole) => {
    const path = draft.roles[role]?.path ?? '';
    const guess = s.guessedRoles[role];
    const unsure = guess && guess.path === path && guess.confidence < 0.6;
    return (
      <div
        key={role}
        className="grid gap-x-6 gap-y-1 border-b border-rule/70 px-4 py-3 last:border-b-0 md:grid-cols-[1fr_18rem]"
      >
        <div>
          <label htmlFor={`q-${role}`} className="font-semibold">
            {t(`schema.q.${role}`)}
          </label>
          <p className="text-sm text-ink-soft">{t(`schema.hint.${role}`)}</p>
        </div>
        <div>
          <select
            id={`q-${role}`}
            value={path}
            disabled={!canEdit}
            onChange={(e) => setRole(role, e.target.value)}
            className={`h-9 w-full rounded-control border bg-sheet px-2 ${path ? 'border-ink font-semibold' : 'border-rule text-ink-soft'}`}
          >
            <option value="">{t('schema.noField')}</option>
            {s.fields.map((f) => (
              <option key={f.path} value={f.path}>
                {fieldLabel(f.path)}: {show(f.example).slice(0, 40)}
              </option>
            ))}
          </select>
          {path && (
            <p className="mt-0.5 truncate text-xs text-ink-soft" title={path}>
              {unsure ? (
                <span style={{ color: 'var(--warning)' }}>{t('schema.unsure')}</span>
              ) : guess?.path === path ? (
                t('schema.autoDetected')
              ) : null}
              {t('schema.fieldPath', { path })}
            </p>
          )}
        </div>
      </div>
    );
  };

  const sevPath = draft.roles.severity?.path;
  // distinct values of the severity field: the sample's example + what recent events carried
  const sevValues = sevPath
    ? [
        ...new Set(
          [
            s.fields.find((f) => f.path === sevPath)?.example,
            ...(preview.data?.events ?? []).map((e) => e.flat[sevPath]),
          ]
            .filter((v) => v !== undefined && v !== null && v !== '')
            .map(String),
        ),
      ]
    : [];

  const out = preview.data?.sample;
  const saveAndRule = async () => {
    await save.mutateAsync();
    await navigate({ to: '/rules/new', search: { schemaId } });
  };

  return (
    <div className="px-6 py-5">
      <Link to="/schemas" className="text-sm text-ink-soft hover:underline">
        {t('schema.backToList')}
      </Link>
      <div className="mt-1 flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-2xl font-bold">{s.name ?? s.preset?.name ?? t('schema.newType')}</h1>
        <p className="num text-sm text-ink-soft">
          {t('schema.fromSource', { source: s.sourceName, count: s.eventCount, when: when(s.lastSeen) })}
        </p>
      </div>
      {s.preset && (
        <p className="mt-2 max-w-[72ch]">
          {t('schema.presetKnown')} <span className="font-semibold">{s.preset.name}</span>.{' '}
          {draft.presetId === s.preset.id ? (
            t('schema.presetApplied')
          ) : (
            <button className="underline" onClick={() => setDraft(s.preset!.mapping)}>
              {t('schema.usePreset')}
            </button>
          )}
        </p>
      )}

      <div className="mt-5 grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_26rem]">
        <section aria-labelledby="fields" className="rounded-panel border border-rule bg-sheet">
          <h2 id="fields" className="border-b border-rule px-4 py-3 text-base font-semibold">
            {t('schema.checkTitle')}
          </h2>
          <p className="border-b border-rule/70 px-4 py-2 text-sm text-ink-soft">
            {t('schema.checkIntro')}
          </p>
          {QUESTIONS.map(question)}
          <div className="px-4 pb-4">
            <MoreOptions label={t('schema.moreQuestions')} count={MORE_QUESTIONS.length}>
              <div className="-ml-4">{MORE_QUESTIONS.map(question)}</div>
              <div className="mt-3 overflow-x-auto rounded-control border border-rule">
                <table className="w-full table-fixed text-sm">
                  <caption className="sr-only">{t('schema.tableCaption')}</caption>
                  <colgroup>
                    <col className="w-[36%]" />
                    <col />
                    <col className="w-52" />
                  </colgroup>
                  <thead>
                    <tr className="border-b border-rule text-left text-xs text-ink-soft">
                      <th scope="col" className="px-4 py-2 font-semibold">
                        {t('schema.colField')}
                      </th>
                      <th scope="col" className="border-l border-rule/70 px-3 py-2 font-semibold">
                        {t('schema.colExample')}
                      </th>
                      <th scope="col" className="border-l border-rule/70 px-3 py-2 font-semibold">
                        {t('schema.colRole')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.fields.map((f) => {
                      const role = roleOf.get(f.path);
                      const guess =
                        role && s.guessedRoles[role]?.path === f.path ? s.guessedRoles[role] : undefined;
                      return (
                        <tr
                          key={f.path}
                          className={`border-b border-rule/70 last:border-b-0 ${role ? 'bg-paper' : ''}`}
                        >
                          <td className="truncate px-4 py-2" title={f.path}>
                            <span className="font-semibold">{fieldLabel(f.path)}</span>
                            <span className="block truncate text-xs text-ink-soft">{f.path}</span>
                          </td>
                          <td
                            className="truncate border-l border-rule/70 px-3 py-2 text-ink-soft"
                            title={show(f.example)}
                          >
                            {show(f.example)}
                          </td>
                          <td className="border-l border-rule/70 px-3 py-1.5">
                            <label className="sr-only" htmlFor={`role-${f.path}`}>
                              {t('schema.roleOfField', { path: f.path })}
                            </label>
                            <select
                              id={`role-${f.path}`}
                              value={role ?? ''}
                              disabled={!canEdit}
                              onChange={(e) => assign(f.path, e.target.value as FieldRole | '')}
                              className={`h-8 w-full rounded-control border bg-sheet px-2 ${role ? 'border-ink font-semibold' : 'border-rule text-ink-soft'}`}
                            >
                              <option value="">—</option>
                              {ROLES.map((r) => (
                                <option key={r} value={r}>
                                  {t(`fieldRole.${r}`)}
                                </option>
                              ))}
                            </select>
                            {guess && (
                              <span className="mt-0.5 block text-xs text-ink-soft">
                                {t('schema.guessed', { pct: Math.round(guess.confidence * 100) })}
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </MoreOptions>
          </div>
        </section>

        <aside className="space-y-6 xl:sticky xl:top-4">
          <section
            aria-labelledby="result"
            aria-live="polite"
            className="rounded-panel border border-rule bg-sheet p-4"
          >
            <h2 id="result" className="text-base font-semibold">
              {t('schema.resultTitle')}
            </h2>
            {out ? (
              <dl className="mt-3 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-sm">
                <dt className="text-ink-soft">{t('schema.severity')}</dt>
                <dd className="font-semibold" style={{ color: sevVar(out.severity) }}>
                  {t(`severity.${out.severity}`)}
                </dd>
                <dt className="text-ink-soft">{t('schema.title')}</dt>
                <dd className="font-semibold">{out.title ?? t('schema.titleMissing')}</dd>
                <dt className="text-ink-soft">{t('schema.time')}</dt>
                <dd className="num">{new Date(out.timestamp).toLocaleString(uiLocale())}</dd>
                <dt className="text-ink-soft">{t('schema.status')}</dt>
                <dd>{out.status === 'resolved' ? t('schema.statusResolved') : t('schema.statusOngoing')}</dd>
                <dt className="text-ink-soft">{t('schema.entity')}</dt>
                <dd>{out.entity ?? '—'}</dd>
                <dt className="text-ink-soft">{t('schema.dedup')}</dt>
                <dd className="truncate" title={out.dedupKey}>
                  {out.dedupKey}
                </dd>
              </dl>
            ) : (
              <p className="mt-2 text-sm text-ink-soft">{t('schema.computing')}</p>
            )}
            {preview.data?.warnings.map((w) => (
              <p key={w} className="mt-2 text-sm" style={{ color: 'var(--warning)' }}>
                {w}
              </p>
            ))}
            {(preview.data?.events.length ?? 0) > 0 && (
              <div className="mt-4 border-t border-rule pt-3">
                <h3 className="mb-1 text-sm font-semibold">{t('schema.recentEvents')}</h3>
                <ul className="text-sm">
                  {preview.data!.events.slice(0, 6).map((e, i) => (
                    <li key={i} className="flex gap-2 truncate">
                      <span
                        aria-hidden
                        className="mt-1 h-3 w-1 shrink-0 rounded-full"
                        style={{ background: sevVar(e.severity) }}
                      />
                      <span className="truncate">{e.title ?? e.dedupKey}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>

          {sevPath && sevValues.length > 0 && (
            <section aria-labelledby="sevmap" className="rounded-panel border border-rule bg-sheet p-4">
              <h2 id="sevmap" className="text-base font-semibold">
                {t('schema.sevMapTitle')}
              </h2>
              <p className="mb-2 text-sm text-ink-soft">
                {t('schema.sevMapIntro', { field: fieldLabel(sevPath) })}
              </p>
              {sevValues.map((v) => (
                <div key={v} className="flex items-center justify-between gap-3 py-1 text-sm">
                  <label htmlFor={`sev-${v}`} className="font-semibold">
                    {v}
                  </label>
                  <select
                    id={`sev-${v}`}
                    disabled={!canEdit}
                    value={draft.severityMap?.[v] ?? ''}
                    onChange={(e) =>
                      setDraft((d) => {
                        const map = { ...(d!.severityMap ?? {}) };
                        if (e.target.value) map[v] = e.target.value as Severity;
                        else delete map[v];
                        return { ...d!, severityMap: map };
                      })
                    }
                    className="h-8 rounded-control border border-rule bg-sheet px-2"
                  >
                    <option value="">{t('schema.automatic')}</option>
                    {SEVERITIES.map((x) => (
                      <option key={x} value={x}>
                        {t(`severity.${x}`)}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </section>
          )}

          {draft.roles.status?.path && (
            <section className="rounded-panel border border-rule bg-sheet p-4">
              <Field
                label={t('schema.resolvedLabel')}
                hint={t('schema.resolvedHint')}
              >
                <Input
                  disabled={!canEdit}
                  value={(draft.resolvedValues ?? []).join(', ')}
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d!,
                      resolvedValues: e.target.value
                        .split(',')
                        .map((x) => x.trim())
                        .filter(Boolean),
                    }))
                  }
                />
              </Field>
            </section>
          )}

          {canEdit && (
            <section className="space-y-3 rounded-panel border border-rule bg-sheet p-4">
              <Field label={t('schema.nameLabel')}>
                <Input
                  value={name}
                  maxLength={100}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={t('schema.namePlaceholder')}
                />
              </Field>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="primary"
                  disabled={save.isPending || !draft.roles.title}
                  onClick={() => void saveAndRule()}
                >
                  {t('schema.saveAndRule')}
                </Button>
                <Button disabled={save.isPending} onClick={() => save.mutate()}>
                  {t('schema.save')}
                </Button>
                {s.status !== 'ignored' ? (
                  <Button variant="quiet" onClick={() => ignore.mutate('ignored')}>
                    {t('schema.ignore')}
                  </Button>
                ) : (
                  <Button variant="quiet" onClick={() => ignore.mutate('new')}>
                    {t('schema.unignore')}
                  </Button>
                )}
              </div>
              {!draft.roles.title && (
                <p className="text-sm text-ink-soft">{t('schema.needTitle')}</p>
              )}
              {save.isSuccess && (
                <p role="status" className="text-sm">
                  {t('schema.saved')}
                </p>
              )}
              {(save.error ?? ignore.error) && (
                <p role="alert" className="text-sm text-critical">
                  {((save.error ?? ignore.error) as ApiError).message}
                </p>
              )}
            </section>
          )}
        </aside>
      </div>
    </div>
  );
}
