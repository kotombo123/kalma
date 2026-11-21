import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { parse, stringify } from 'yaml';
import { render } from '@alerting/templates';
import { api, ApiError } from '../lib/api.ts';
import { useAuth } from '../lib/auth.tsx';
import { when } from '../lib/format.ts';
import { describeCondition, emptyDraft, type RuleDraft, type RuleRow } from '../lib/rules.ts';
import i18n from '../lib/i18n.ts';
import { SEVERITY_LABEL, type Page, type SchemaInfo, type Severity, type TeamSummary } from '../lib/types.ts';
import { Button, Field, Input, MoreOptions, sevVar } from '../components/ui.tsx';
import { fieldLabel } from '../lib/labels.ts';
import { usePersona } from '../lib/roles.ts';
import { ConditionEditor } from '../components/ConditionEditor.tsx';

interface PreviewResult {
  matched: number;
  total: number;
  window: number;
  examples: { id: string; severity: Severity; title: string | null; flat: Record<string, unknown> }[];
}
interface Issue {
  path: (string | number)[];
  message: string;
}

/** One numbered question of the rule (a real sequence, so the margin numeral is information). */
function Section({
  n,
  title,
  children,
  hint,
}: {
  n: number;
  title: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <section className="grid gap-x-3 border-b border-rule px-4 py-4 last:border-b-0 sm:grid-cols-[2rem_1fr]">
      <div aria-hidden className="num text-2xl font-bold text-margin">
        {n}
      </div>
      <div className="min-w-0">
        <h2 className="text-base font-semibold">{title}</h2>
        {hint && <p className="mb-2 max-w-[64ch] text-sm text-ink-soft">{hint}</p>}
        <div className="mt-2">{children}</div>
      </div>
    </section>
  );
}

/** API warnings are English and technical; say the common ones in the editor's words. */
function plainWarning(msg: string): string {
  const m = /^field "(.*)" is not in any known schema/.exec(msg);
  if (m)
    return m[1]
      ? i18n.t('ruleEditor.warnFieldUnknown', { field: m[1] })
      : i18n.t('ruleEditor.warnNoField');
  return msg;
}

/** Strip server-owned fields and nulls from a stored definition. */
function toDraft(def: RuleRow['definition']): RuleDraft {
  const { id: _i, orgId: _o, version: _v, origin: _g, ...rest } = def;
  return JSON.parse(JSON.stringify(rest)) as RuleDraft;
}

function useDebounced<T>(value: T, ms = 350) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** F-16: rule editor with blocks / YAML, live "would catch X of the last N", history and rollback. */
export function RuleEditorPage() {
  const params = useParams({ strict: false }) as { ruleId?: string };
  const search = useSearch({ strict: false }) as { schemaId?: string };
  const ruleId = params.ruleId;
  const { t: tr } = useTranslation();
  const { me } = useAuth();
  const { persona } = usePersona();
  const qc = useQueryClient();
  const navigate = useNavigate();

  const rule = useQuery({
    queryKey: ['rule', ruleId],
    queryFn: () => api<RuleRow>(`/rules/${ruleId}`),
    enabled: Boolean(ruleId),
  });
  const teams = useQuery({ queryKey: ['teams'], queryFn: () => api<Page<TeamSummary>>('/teams?limit=100') });
  const schemas = useQuery({
    queryKey: ['schemas', 'all'],
    queryFn: () => api<Page<SchemaInfo>>('/schemas?limit=100'),
  });
  const schema = useQuery({
    queryKey: ['schema', search.schemaId],
    queryFn: () =>
      api<SchemaInfo & { mapping: { roles: Record<string, { path?: string }> } | null }>(
        `/schemas/${search.schemaId}`,
      ),
    enabled: Boolean(search.schemaId) && !ruleId,
  });

  const runbooks = useQuery({
    queryKey: ['runbooks'],
    queryFn: () =>
      api<Page<{ id: string; name: string; teamName: string; stepCount: number }>>('/runbooks?limit=100'),
  });

  const [draft, setDraft] = useState<RuleDraft | null>(null);
  const [loadedVersion, setLoadedVersion] = useState<number | null>(null);
  const [tab, setTab] = useState<'blocks' | 'yaml'>('blocks');
  const [yamlText, setYamlText] = useState('');
  const [yamlError, setYamlError] = useState<string | null>(null);

  // initial draft: existing rule, or a new one (prefilled from the schema the user just mapped)
  useEffect(() => {
    // (re)load when the stored version changes — e.g. after a rollback or someone else's save
    if (ruleId && rule.data && rule.data.version !== loadedVersion) {
      setDraft(toDraft(rule.data.definition));
      setLoadedVersion(rule.data.version);
      return;
    }
    if (draft || ruleId) return;
    if (search.schemaId && !schema.data) return;
    const myTeam = me?.teams.find((t) => t.role === 'lead')?.id ?? teams.data?.data[0]?.id ?? '';
    const d = emptyDraft(myTeam);
    if (schema.data) {
      const titlePath = schema.data.mapping?.roles.title?.path;
      d.name = i18n.t('ruleEditor.defaultName', { name: schema.data.name ?? i18n.t('ruleEditor.newSchema') });
      d.scope = { schemaIds: [schema.data.id] };
      if (titlePath) d.presentation.titleTemplate = `{{${titlePath}}}`;
    }
    setDraft(d);
  }, [draft, ruleId, rule.data, loadedVersion, search.schemaId, schema.data, me, teams.data]);

  const readOnly =
    rule.data?.origin === 'file' ||
    !(me?.role === 'admin' || me?.teams.some((t) => t.id === draft?.teamId && t.role === 'lead'));

  const knownFields = useMemo(
    () => [...new Set((schemas.data?.data ?? []).flatMap((s) => s.fields.map((f) => f.path)))].sort(),
    [schemas.data],
  );

  const live = useDebounced(draft);
  const preview = useQuery({
    queryKey: ['rule-preview', live?.condition, live?.scope],
    queryFn: () =>
      api<PreviewResult>('/rules/preview', {
        method: 'POST',
        body: { condition: live!.condition, ...(live!.scope && { scope: live!.scope }), maxExamples: 5 },
      }),
    enabled: Boolean(live),
    placeholderData: keepPreviousData,
    retry: false,
  });
  const validation = useQuery({
    queryKey: ['rule-validate', live],
    queryFn: () =>
      api<{ valid: boolean; issues: Issue[]; warnings: Issue[] }>('/rules/validate', {
        method: 'POST',
        body: { rule: live },
      }),
    enabled: Boolean(live),
    placeholderData: keepPreviousData,
  });

  const save = useMutation({
    mutationFn: () =>
      ruleId
        ? api<RuleRow>(`/rules/${ruleId}`, { method: 'PUT', body: { ...draft, version: rule.data?.version } })
        : api<RuleRow>('/rules', { method: 'POST', body: draft }),
    onSuccess: async (saved) => {
      await qc.invalidateQueries({ queryKey: ['rules'] });
      await qc.invalidateQueries({ queryKey: ['rule', saved.id] });
      await qc.invalidateQueries({ queryKey: ['rule-versions', saved.id] });
      if (!ruleId) await navigate({ to: '/rules/$ruleId', params: { ruleId: saved.id } });
    },
  });

  if (!draft) return <p className="px-6 py-5 text-ink-soft">{tr('ruleEditor.loading')}</p>;
  const set = (patch: Partial<RuleDraft>) => setDraft((d) => ({ ...d!, ...patch }));
  const setField = (i: number, patch: Partial<RuleDraft['presentation']['fields'][number]>) =>
    set({
      presentation: {
        ...draft.presentation,
        fields: draft.presentation.fields.map((x, j) => (j === i ? { ...x, ...patch } : x)),
      },
    });
  /** The notifier routes by the rule's team, so the team target follows the team choice. */
  const changeTeam = (teamId: string) => {
    const old = draft.teamId;
    const targets = draft.routing.targets.length
      ? draft.routing.targets.map((t) => (t.type !== 'user' && t.teamId === old ? { ...t, teamId } : t))
      : teamId
        ? [{ type: 'team' as const, teamId }]
        : [];
    set({ teamId, routing: { ...draft.routing, targets } });
  };
  const advancedChanged =
    (draft.dedup.windowSec !== 600 ? 1 : 0) +
    (draft.dedup.keyTemplate ? 1 : 0) +
    (draft.grouping ? 1 : 0) +
    (draft.presentation.bodyTemplate || draft.presentation.fields.length ? 1 : 0);
  const teamList = teams.data?.data ?? [];
  const teamName = new Map(teamList.map((t) => [t.id, t.name]));
  const issues = validation.data?.issues ?? [];
  const example = preview.data?.examples[0];
  const exampleFields = example
    ? Object.keys(example.flat)
        .filter((k) => !k.startsWith('$') && typeof example.flat[k] !== 'object')
        .slice(0, 12)
    : [];
  const renderOn = (tpl: string | undefined) => (tpl && example ? render(tpl, example.flat) : '');

  const switchTab = (next: 'blocks' | 'yaml') => {
    if (next === 'yaml') setYamlText(stringify(draft));
    setTab(next);
  };
  const applyYaml = () => {
    try {
      setDraft(parse(yamlText) as RuleDraft);
      setYamlError(null);
    } catch (e) {
      setYamlError((e as Error).message);
    }
  };

  return (
    <div className="px-6 py-5">
      <Link to="/rules" className="text-sm text-ink-soft hover:underline">
        {tr('rules.title')}
      </Link>
      <h1 className="mt-1 text-2xl font-bold">
        {ruleId ? draft.name || tr('ruleEditor.rule') : tr('ruleEditor.newRule')}
      </h1>
      {rule.data?.origin === 'file' && (
        <p className="mt-2 max-w-[72ch] rounded-control border-l-4 border-warning bg-paper p-3 text-sm">
          {tr('ruleEditor.fileNotice', { path: rule.data.filePath })}
        </p>
      )}

      <div className="mt-4 grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="rounded-panel border border-rule bg-sheet">
          {persona === 'admin' && (
            <div role="tablist" aria-label={tr('ruleEditor.editorAria')} className="flex gap-1 border-b border-rule px-3 pt-2">
              {(['blocks', 'yaml'] as const).map((t) => (
                <button
                  key={t}
                  role="tab"
                  aria-selected={tab === t}
                  onClick={() => switchTab(t)}
                  className={`rounded-t-control px-3 py-1.5 text-sm ${tab === t ? 'bg-paper font-semibold' : 'text-ink-soft'}`}
                >
                  {t === 'blocks' ? tr('ruleEditor.tabBlocks') : tr('ruleEditor.tabYaml')}
                </button>
              ))}
            </div>
          )}

          {tab === 'yaml' ? (
            <div className="p-4">
              <label htmlFor="yaml" className="sr-only">
                {tr('ruleEditor.yamlLabel')}
              </label>
              <textarea
                id="yaml"
                value={yamlText}
                readOnly={readOnly}
                onChange={(e) => setYamlText(e.target.value)}
                onBlur={applyYaml}
                rows={28}
                spellCheck={false}
                className="w-full rounded-control border border-rule bg-paper p-3 text-xs leading-relaxed"
              />
              {yamlError && <p className="text-sm text-critical">{tr('ruleEditor.yamlError', { error: yamlError })}</p>}
              <p className="mt-1 text-xs text-ink-soft">
                {tr('ruleEditor.yamlHint')}
              </p>
            </div>
          ) : (
            <fieldset disabled={readOnly}>
              <Section
                n={1}
                title={tr('ruleEditor.s1Title')}
                hint={tr('ruleEditor.s1Hint')}
              >
                <ConditionEditor
                  value={draft.condition}
                  onChange={(condition) => set({ condition })}
                  fields={knownFields}
                />
                {draft.scope?.schemaIds?.length ? (
                  <p className="mt-2 text-sm text-ink-soft">
                    {tr('ruleEditor.scopeOnly', { name: schema.data?.name ?? tr('ruleEditor.scopePrevious') })}{' '}
                    <button type="button" className="underline" onClick={() => set({ scope: undefined })}>
                      {tr('ruleEditor.scopeAll')}
                    </button>
                  </p>
                ) : null}
              </Section>

              <Section n={2} title={tr('ruleEditor.s2Title')}>
                <Field label={tr('ruleEditor.team')}>
                  <select
                    value={draft.teamId}
                    onChange={(e) => changeTeam(e.target.value)}
                    className="h-9 w-full rounded-control border border-rule bg-sheet px-2 sm:w-80"
                  >
                    <option value="">{tr('ruleEditor.chooseTeam')}</option>
                    {teamList
                      .filter(
                        (t) =>
                          me?.role === 'admin' ||
                          me?.teams.some((m) => m.id === t.id && m.role === 'lead') ||
                          t.id === draft.teamId,
                      )
                      .map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                  </select>
                </Field>
                <p className="mt-2 max-w-[64ch] text-sm text-ink-soft">
                  {tr('ruleEditor.routingHint')}
                </p>
                <label className="mt-3 flex flex-wrap items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={Boolean(draft.routing.escalation)}
                    onChange={(e) =>
                      set({
                        routing: {
                          ...draft.routing,
                          escalation: e.target.checked ? { afterMin: 15, maxLevel: 2 } : undefined,
                        },
                      })
                    }
                  />
                  {tr('ruleEditor.escalateBefore')}
                  <input
                    aria-label={tr('ruleEditor.escalateAria')}
                    type="number"
                    min={1}
                    disabled={!draft.routing.escalation}
                    value={draft.routing.escalation?.afterMin ?? 15}
                    onChange={(e) =>
                      set({
                        routing: {
                          ...draft.routing,
                          escalation: {
                            afterMin: Math.max(1, Number(e.target.value)),
                            maxLevel: draft.routing.escalation?.maxLevel ?? 2,
                          },
                        },
                      })
                    }
                    className="num h-8 w-16 rounded-control border border-rule bg-sheet px-2"
                  />
                  {tr('ruleEditor.escalateAfter')}
                </label>
              </Section>

              <Section n={3} title={tr('ruleEditor.s3Title')}>
                <Field
                  label={tr('ruleEditor.runbook')}
                  hint={tr('ruleEditor.runbookHint')}
                >
                  <select
                    value={draft.runbookId ?? ''}
                    onChange={(e) =>
                      set({
                        runbookId: e.target.value || undefined,
                        ...(!e.target.value && {
                          autoResolve: { ...draft.autoResolve, onRunbookSuccess: false },
                        }),
                      })
                    }
                    className="h-9 w-full rounded-control border border-rule bg-sheet px-2 sm:w-96"
                  >
                    <option value="">{tr('ruleEditor.noRunbook')}</option>
                    {runbooks.data?.data.map((rb) => (
                      <option key={rb.id} value={rb.id}>
                        {tr('ruleEditor.runbookOption', { name: rb.name, team: rb.teamName, count: rb.stepCount })}
                      </option>
                    ))}
                  </select>
                </Field>
                <label className="mt-3 flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={draft.autoResolve.onSourceResolved}
                    onChange={(e) =>
                      set({ autoResolve: { ...draft.autoResolve, onSourceResolved: e.target.checked } })
                    }
                  />
                  {tr('ruleEditor.resolveOnSource')}
                </label>
                {draft.runbookId && (
                  <label className="mt-1 flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={draft.autoResolve.onRunbookSuccess}
                      onChange={(e) =>
                        set({ autoResolve: { ...draft.autoResolve, onRunbookSuccess: e.target.checked } })
                      }
                    />
                    {tr('ruleEditor.resolveOnRunbook')}
                  </label>
                )}
              </Section>

              <Section n={4} title={tr('ruleEditor.s4Title')}>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field
                    label={tr('ruleEditor.name')}
                    hint={tr('ruleEditor.nameHint')}
                  >
                    <Input
                      value={draft.name}
                      maxLength={100}
                      onChange={(e) => set({ name: e.target.value })}
                    />
                  </Field>
                  <Field label={tr('ruleEditor.severity')}>
                    <select
                      value={draft.presentation.severity ?? ''}
                      onChange={(e) =>
                        set({
                          presentation: {
                            ...draft.presentation,
                            severity: (e.target.value || undefined) as Severity | undefined,
                          },
                        })
                      }
                      className="h-9 w-full rounded-control border border-rule bg-sheet px-2"
                    >
                      <option value="">{tr('ruleEditor.severityFromSource')}</option>
                      {(Object.keys(SEVERITY_LABEL) as Severity[]).map((sv) => (
                        <option key={sv} value={sv}>
                          {tr(`severity.${sv}`)}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>

                <MoreOptions count={4} changed={advancedChanged}>
                  <div className="space-y-5">
                    <div>
                      <h3 className="font-semibold">{tr('ruleEditor.repeats')}</h3>
                      <label className="mt-1 flex flex-wrap items-center gap-2 text-sm">
                        {tr('ruleEditor.dedupBefore')}
                        <input
                          aria-label={tr('ruleEditor.dedupAria')}
                          type="number"
                          min={1}
                          value={Math.round(draft.dedup.windowSec / 60)}
                          onChange={(e) =>
                            set({
                              dedup: { ...draft.dedup, windowSec: Math.max(1, Number(e.target.value)) * 60 },
                            })
                          }
                          className="num h-8 w-16 rounded-control border border-rule bg-sheet px-2"
                        />
                        {tr('ruleEditor.dedupAfter')}
                      </label>
                      <div className="mt-3 grid gap-3 sm:grid-cols-2">
                        <Field
                          label={tr('ruleEditor.dedupKey')}
                          hint={tr('ruleEditor.dedupKeyHint')}
                        >
                          <Input
                            value={draft.dedup.keyTemplate ?? ''}
                            placeholder="{{payload.tradeId}}"
                            onChange={(e) =>
                              set({ dedup: { ...draft.dedup, keyTemplate: e.target.value || undefined } })
                            }
                          />
                        </Field>
                        <Field
                          label={tr('ruleEditor.groupBy')}
                          hint={tr('ruleEditor.groupByHint')}
                        >
                          <Input
                            value={draft.grouping?.by.join(', ') ?? ''}
                            onChange={(e) => {
                              const by = e.target.value
                                .split(',')
                                .map((x) => x.trim())
                                .filter(Boolean);
                              set({
                                grouping: by.length
                                  ? { by, windowSec: draft.grouping?.windowSec ?? 300 }
                                  : undefined,
                              });
                            }}
                          />
                        </Field>
                      </div>
                    </div>

                    <div>
                      <h3 className="font-semibold">{tr('ruleEditor.look')}</h3>
                      <p className="text-sm text-ink-soft">
                        {tr('ruleEditor.lookHint')}
                      </p>
                      <div className="mt-2 grid gap-3">
                        <Field label={tr('ruleEditor.titleLabel')}>
                          <Input
                            value={draft.presentation.titleTemplate}
                            onChange={(e) =>
                              set({ presentation: { ...draft.presentation, titleTemplate: e.target.value } })
                            }
                          />
                        </Field>
                        {exampleFields.length > 0 && (
                          <div className="flex flex-wrap gap-1.5" aria-label={tr('ruleEditor.insertField')}>
                            {exampleFields.map((f) => (
                              <button
                                key={f}
                                type="button"
                                title={f}
                                onClick={() =>
                                  set({
                                    presentation: {
                                      ...draft.presentation,
                                      titleTemplate: `${draft.presentation.titleTemplate} {{${f}}}`.trim(),
                                    },
                                  })
                                }
                                className="rounded-control border border-rule px-2 py-0.5 text-xs hover:border-ink-soft"
                              >
                                + {fieldLabel(f)}
                              </button>
                            ))}
                          </div>
                        )}
                        <Field label={tr('ruleEditor.body')}>
                          <Input
                            value={draft.presentation.bodyTemplate ?? ''}
                            onChange={(e) =>
                              set({
                                presentation: {
                                  ...draft.presentation,
                                  bodyTemplate: e.target.value || undefined,
                                },
                              })
                            }
                          />
                        </Field>
                        <div>
                          <span className="text-sm font-semibold">{tr('ruleEditor.fields')}</span>
                          {draft.presentation.fields.map((f, i) => (
                            <div key={i} className="mt-1 flex flex-wrap gap-2">
                              <input
                                aria-label={tr('ruleEditor.fieldLabelAria', { n: i + 1 })}
                                value={f.label}
                                placeholder={tr('ruleEditor.fieldLabelPlaceholder')}
                                onChange={(e) => setField(i, { label: e.target.value })}
                                className="h-8 w-40 rounded-control border border-rule bg-sheet px-2 text-sm"
                              />
                              <input
                                aria-label={tr('ruleEditor.fieldValueAria', { n: i + 1 })}
                                value={f.template}
                                placeholder={`{{${tr('ruleEditor.fieldWord')}}}`}
                                onChange={(e) => setField(i, { template: e.target.value })}
                                className="h-8 w-64 rounded-control border border-rule bg-sheet px-2 text-sm"
                              />
                              <select
                                aria-label={tr('ruleEditor.fieldColorAria', { n: i + 1 })}
                                value={f.highlight ?? ''}
                                onChange={(e) =>
                                  setField(i, {
                                    highlight: (e.target.value || undefined) as
                                      'red' | 'amber' | 'green' | undefined,
                                  })
                                }
                                className="h-8 rounded-control border border-rule bg-sheet px-2 text-sm"
                              >
                                <option value="">{tr('ruleEditor.noColor')}</option>
                                <option value="red">{tr('ruleEditor.red')}</option>
                                <option value="amber">{tr('ruleEditor.amber')}</option>
                                <option value="green">{tr('ruleEditor.green')}</option>
                              </select>
                              <Button
                                type="button"
                                variant="quiet"
                                onClick={() =>
                                  set({
                                    presentation: {
                                      ...draft.presentation,
                                      fields: draft.presentation.fields.filter((_, j) => j !== i),
                                    },
                                  })
                                }
                              >
                                {tr('ruleEditor.remove')}
                              </Button>
                            </div>
                          ))}
                          <Button
                            type="button"
                            variant="quiet"
                            onClick={() =>
                              set({
                                presentation: {
                                  ...draft.presentation,
                                  fields: [...draft.presentation.fields, { label: '', template: '' }],
                                },
                              })
                            }
                          >
                            {tr('ruleEditor.addField')}
                          </Button>
                        </div>
                      </div>
                    </div>
                  </div>
                </MoreOptions>
              </Section>
            </fieldset>
          )}
        </div>

        <aside className="space-y-4 xl:sticky xl:top-4">
          <section
            aria-live="polite"
            aria-labelledby="catch"
            className="rounded-panel border border-rule bg-sheet p-4"
          >
            <h2 id="catch" className="sr-only">
              {tr('ruleEditor.preview')}
            </h2>
            {preview.data ? (
              <>
                <p className="text-3xl font-bold">
                  <span className="num">{preview.data.matched}</span>
                  <span className="text-lg font-normal text-ink-soft">
                    {tr('ruleEditor.ofLast')}
                    <span className="num">{preview.data.window}</span>
                  </span>
                </p>
                <p className="text-sm text-ink-soft">{tr('ruleEditor.wouldCatch')}</p>
                {preview.data.examples.length > 0 && (
                  <ul className="mt-3 border-t border-rule pt-2 text-sm">
                    {preview.data.examples.map((e) => (
                      <li key={e.id} className="flex gap-2 py-0.5">
                        <span
                          aria-hidden
                          className="mt-1 h-3 w-1 shrink-0 rounded-full"
                          style={{ background: sevVar(e.severity) }}
                        />
                        <span className="truncate">
                          {render(draft.presentation.titleTemplate, e.flat) || e.title}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            ) : preview.error instanceof ApiError ? (
              <p className="text-sm text-critical">{tr('ruleEditor.fixConditions')}</p>
            ) : (
              <p className="text-sm text-ink-soft">{tr('ruleEditor.counting')}</p>
            )}
          </section>

          <section
            aria-labelledby="summary"
            className="rounded-panel border border-rule bg-sheet p-4 text-sm"
          >
            <h2 id="summary" className="mb-1 font-semibold">
              {tr('ruleEditor.plain')}
            </h2>
            <p>
              {tr('ruleEditor.summary', {
                condition: describeCondition(draft.condition),
                who: draft.teamId
                  ? tr('ruleEditor.summaryTeam', { team: teamName.get(draft.teamId) ?? '' })
                  : tr('ruleEditor.summaryNoTeam'),
              })}
              {draft.routing.escalation &&
                tr('ruleEditor.summaryEscalation', { min: draft.routing.escalation.afterMin })}
              {draft.autoResolve.onSourceResolved && tr('ruleEditor.summaryResolve')}
            </p>
            {example && (
              <p className="mt-2 text-ink-soft">
                {tr('ruleEditor.sampleTitle')}{' '}
                <span className="font-semibold text-ink">{renderOn(draft.presentation.titleTemplate)}</span>
              </p>
            )}
          </section>

          {(issues.length > 0 || (validation.data?.warnings.length ?? 0) > 0) && (
            <section
              aria-labelledby="problems"
              className="rounded-panel border border-rule bg-sheet p-4 text-sm"
            >
              <h2 id="problems" className="mb-1 font-semibold">
                {tr('ruleEditor.problems')}
              </h2>
              <ul className="space-y-1">
                {issues.map((i) => (
                  <li key={`e-${i.path.join('.')}-${i.message}`} className="text-critical">
                    {i.path.join('.')}: {i.message}
                  </li>
                ))}
                {validation.data?.warnings.map((i) => (
                  <li key={`w-${i.path.join('.')}`} style={{ color: 'var(--warning)' }}>
                    {plainWarning(i.message)}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {!readOnly && (
            <div className="space-y-2">
              <Button
                variant="primary"
                className="w-full justify-center"
                disabled={
                  save.isPending ||
                  issues.length > 0 ||
                  !draft.name ||
                  !draft.teamId ||
                  draft.routing.targets.length === 0
                }
                onClick={() => save.mutate()}
              >
                {ruleId ? tr('ruleEditor.saveVersion') : tr('ruleEditor.create')}
              </Button>
              {save.isError && (
                <p role="alert" className="text-sm text-critical">
                  {(save.error as ApiError).code === 'version_conflict'
                    ? tr('ruleEditor.conflict')
                    : (save.error as ApiError).message}
                </p>
              )}
              {save.isSuccess && ruleId && (
                <p role="status" className="text-sm">
                  {tr('ruleEditor.saved', { version: save.data.version })}
                </p>
              )}
            </div>
          )}
          {ruleId && rule.data && (
            <History ruleId={ruleId} current={rule.data.version} canRollback={!readOnly} />
          )}
        </aside>
      </div>
    </div>
  );
}

function History({
  ruleId,
  current,
  canRollback,
}: {
  ruleId: string;
  current: number;
  canRollback: boolean;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const versions = useQuery({
    queryKey: ['rule-versions', ruleId],
    queryFn: () =>
      api<{ data: { version: number; authorName: string | null; createdAt: string }[] }>(
        `/rules/${ruleId}/versions`,
      ),
  });
  const [open, setOpen] = useState<number | null>(null);
  const diff = useQuery({
    queryKey: ['rule-diff', ruleId, open],
    queryFn: () =>
      api<{ changes: { path: string; before?: unknown; after?: unknown }[] }>(
        `/rules/${ruleId}/diff?from=${Math.max(1, open! - 1)}&to=${open}`,
      ),
    enabled: open !== null && open > 1,
  });
  const rollback = useMutation({
    mutationFn: (version: number) => api(`/rules/${ruleId}/rollback`, { method: 'POST', body: { version } }),
    onSuccess: () =>
      Promise.all(
        ['rule', 'rule-versions', 'rules'].map((k) =>
          qc.invalidateQueries({ queryKey: k === 'rules' ? [k] : [k, ruleId] }),
        ),
      ).then(() => window.location.reload()),
  });
  return (
    <section aria-labelledby="history" className="rounded-panel border border-rule bg-sheet p-4 text-sm">
      <h2 id="history" className="mb-1 font-semibold">
        {t('ruleEditor.history')}
      </h2>
      <ul>
        {versions.data?.data.map((v) => (
          <li key={v.version} className="border-b border-rule/70 py-1.5 last:border-b-0">
            <div className="flex items-baseline justify-between gap-2">
              <button
                className="text-left hover:underline"
                onClick={() => setOpen(open === v.version ? null : v.version)}
              >
                {t('ruleEditor.versionLabel')} <span className="num font-semibold">{v.version}</span>
                {v.version === current && t('ruleEditor.current')}
              </button>
              <span className="num text-xs text-ink-soft">
                {v.authorName ?? t('ruleEditor.system')}, {when(v.createdAt)}
              </span>
            </div>
            {open === v.version && (
              <div className="mt-1 pl-2">
                {v.version === 1 ? (
                  <p className="text-ink-soft">{t('ruleEditor.firstVersion')}</p>
                ) : (
                  <ul className="text-xs">
                    {diff.data?.changes.map((c) => (
                      <li key={c.path}>
                        <span className="font-semibold">{c.path}</span>: {JSON.stringify(c.before)} →{' '}
                        {JSON.stringify(c.after)}
                      </li>
                    ))}
                  </ul>
                )}
                {canRollback && v.version !== current && (
                  <Button variant="quiet" onClick={() => rollback.mutate(v.version)}>
                    {t('ruleEditor.restore')}
                  </Button>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
