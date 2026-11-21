import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api.ts';
import { useAuth } from '../lib/auth.tsx';
import type { Page, SchemaInfo, TeamSummary } from '../lib/types.ts';
import { Button, Field, Input, MoreOptions } from '../components/ui.tsx';
import { newStep, StepBuilder, stepsToYaml, type StepDraft } from '../components/RunbookSteps.tsx';
import { actionLabel } from '../lib/labels.ts';
import i18n from '../lib/i18n.ts';
import { RUNBOOK_FORMATS } from './RunbooksPage.tsx';

type Format = 'yaml' | 'markdown' | 'checklist' | 'link' | 'text';
interface Step {
  id: string;
  kind: string;
  text: string;
  approval: 'none' | 'required';
  if?: string;
  action?: { type: string; params: Record<string, unknown> };
  risk: 'low' | 'high' | null;
}
interface Filled {
  id: string;
  textFilled: string;
  actionFilled?: { type: string; params: Record<string, unknown> };
  missingFields: string[];
}
interface ParseResult {
  steps: Step[];
  warnings: string[];
  matches?: unknown;
  filled?: Filled[];
}
interface Runbook {
  id: string;
  teamId: string;
  name: string;
  format: Format;
  source: string;
  version: number;
}

/** Starter text per format, in the UI language (called at render). */
const starters = (): Record<Format, string> => ({
  yaml: `runbook: moj-runbook
matches:
  type: WORKFLOW_FAILED
steps:
  - check: "${i18n.t('runbookEditor.starterCheck')}"
    action: http_get
    url: "http://counterparty-service/health"
  - action: retry_workflow
    workflowId: "{{workflowId}}"
    approval: none
`,
  markdown: i18n.t('runbookEditor.starterMarkdown'),
  checklist: i18n.t('runbookEditor.starterChecklist'),
  link: 'https://wiki.firma.example/runbooks/',
  text: i18n.t('runbookEditor.starterText'),
});

function useDebounced<T>(value: T, ms = 400) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** F-17: write a runbook in any of 5 formats and see the steps (and a test fill) as you type. */
export function RunbookEditorPage() {
  const { t } = useTranslation();
  const { runbookId } = useParams({ strict: false }) as { runbookId?: string };
  const { me } = useAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const existing = useQuery({
    queryKey: ['runbook', runbookId],
    queryFn: () => api<Runbook>(`/runbooks/${runbookId}`),
    enabled: Boolean(runbookId),
  });
  const teams = useQuery({ queryKey: ['teams'], queryFn: () => api<Page<TeamSummary>>('/teams?limit=100') });
  const schemas = useQuery({
    queryKey: ['schemas', 'all'],
    queryFn: () => api<Page<SchemaInfo>>('/schemas?limit=100'),
  });
  const actions = useQuery({
    queryKey: ['actions'],
    queryFn: () =>
      api<{ data: { name: string; title: string; risk: 'low' | 'high' }[] }>('/runbooks/actions'),
  });

  const [form, setForm] = useState<{ teamId: string; name: string; format: Format; source: string } | null>(
    null,
  );
  const [sampleId, setSampleId] = useState('');
  // new instructions start in the step form; existing ones (any of 5 formats) open as text
  const [mode, setMode] = useState<'steps' | 'text'>(runbookId ? 'text' : 'steps');
  const [steps, setSteps] = useState<StepDraft[]>([newStep('manual')]);
  const changeSteps = (next: StepDraft[]) => {
    setSteps(next);
    setForm((f) => f && { ...f, format: 'yaml', source: stepsToYaml(f.name, next) });
  };
  useEffect(() => {
    if (form) return;
    if (runbookId) {
      if (existing.data)
        setForm({
          teamId: existing.data.teamId,
          name: existing.data.name,
          format: existing.data.format,
          source: existing.data.source,
        });
      return;
    }
    const lead = me?.teams.find((m) => m.role === 'lead')?.id;
    if (lead || teams.data)
      setForm({
        teamId: lead ?? teams.data?.data[0]?.id ?? '',
        name: '',
        format: 'yaml',
        source: stepsToYaml('', [newStep('manual')]),
      });
  }, [form, runbookId, existing.data, me, teams.data]);

  const canEdit =
    me?.role === 'admin' || Boolean(form && me?.teams.some((m) => m.id === form.teamId && m.role === 'lead'));
  const sample = schemas.data?.data.find((s) => s.id === sampleId)?.sample as
    Record<string, unknown> | undefined;
  const live = useDebounced(form);
  const parsed = useQuery({
    queryKey: ['runbook-parse', live?.format, live?.source, sampleId],
    queryFn: () =>
      api<ParseResult>('/runbooks/parse', {
        method: 'POST',
        body: { format: live!.format, source: live!.source, ...(sample && { sample }) },
      }),
    enabled: Boolean(live?.source.trim()),
    placeholderData: keepPreviousData,
    retry: false,
  });

  const save = useMutation({
    mutationFn: () =>
      runbookId
        ? api<Runbook>(`/runbooks/${runbookId}`, {
            method: 'PUT',
            body: { ...form, version: existing.data?.version },
          })
        : api<Runbook>('/runbooks', { method: 'POST', body: form }),
    onSuccess: async (rb) => {
      await qc.invalidateQueries({ queryKey: ['runbooks'] });
      await qc.invalidateQueries({ queryKey: ['runbook', rb.id] });
      if (!runbookId) await navigate({ to: '/runbooks/$runbookId', params: { runbookId: rb.id } });
    },
  });
  const remove = useMutation({
    mutationFn: () => api(`/runbooks/${runbookId}`, { method: 'DELETE' }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['runbooks'] });
      await navigate({ to: '/runbooks' });
    },
  });

  if (!form) return <p className="px-6 py-5 text-ink-soft">{t('runbookEditor.loading')}</p>;
  const STARTERS = starters();
  const set = (p: Partial<typeof form>) =>
    setForm((f) => {
      const next = { ...f!, ...p };
      // the step form owns the source; keep the YAML name in step with the title
      if (mode === 'steps' && p.name !== undefined) next.source = stepsToYaml(p.name, steps);
      return next;
    });
  const parseError = parsed.error instanceof ApiError ? parsed.error.message : null;
  const filledById = new Map(parsed.data?.filled?.map((f) => [f.id, f]));
  const failed = (save.error ?? remove.error) as ApiError | null;

  return (
    <div className="px-6 py-5">
      <Link to="/runbooks" className="text-sm text-ink-soft hover:underline">
        {t('runbooks.title')}
      </Link>
      <h1 className="mt-1 text-2xl font-bold">{runbookId ? form.name || t('runbookEditor.runbook') : t('runbookEditor.newRunbook')}</h1>

      <div className="mt-4 grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_26rem]">
        <fieldset disabled={!canEdit} className="space-y-4 rounded-panel border border-rule bg-sheet p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('runbookEditor.name')}>
              <Input
                value={form.name}
                maxLength={100}
                onChange={(e) => set({ name: e.target.value })}
                placeholder={t('runbookEditor.namePlaceholder')}
              />
            </Field>
            <Field label={t('runbookEditor.team')}>
              <select
                value={form.teamId}
                onChange={(e) => set({ teamId: e.target.value })}
                className="h-9 w-full rounded-control border border-rule bg-sheet px-2"
              >
                {(teams.data?.data ?? [])
                  .filter(
                    (tm) =>
                      me?.role === 'admin' ||
                      me?.teams.some((m) => m.id === tm.id && m.role === 'lead') ||
                      tm.id === form.teamId,
                  )
                  .map((tm) => (
                    <option key={tm.id} value={tm.id}>
                      {tm.name}
                    </option>
                  ))}
              </select>
            </Field>
          </div>
          {mode === 'steps' ? (
            <div>
              <h2 className="font-semibold">{t('runbookEditor.steps')}</h2>
              <StepBuilder steps={steps} onChange={changeSteps} disabled={!canEdit} />
              {canEdit && (
                <MoreOptions label={t('runbookEditor.pasteMore')} count={5}>
                  <p className="text-sm text-ink-soft">
                    {t('runbookEditor.pasteHint')}
                  </p>
                  <Button type="button" className="mt-2" onClick={() => setMode('text')}>
                    {t('runbookEditor.pasteBtn')}
                  </Button>
                </MoreOptions>
              )}
            </div>
          ) : (
            <>
              <div role="radiogroup" aria-label={t('runbookEditor.format')} className="flex flex-wrap gap-1">
                {RUNBOOK_FORMATS.map((f) => (
                  <button
                    key={f}
                    type="button"
                    role="radio"
                    aria-checked={form.format === f}
                    onClick={() =>
                      set({
                        format: f,
                        source:
                          form.source === STARTERS[form.format] || !form.source.trim()
                            ? STARTERS[f]
                            : form.source,
                      })
                    }
                    className={`rounded-control border px-3 py-1.5 text-sm ${form.format === f ? 'border-ink bg-ink font-semibold text-sheet' : 'border-rule hover:border-ink-soft'}`}
                  >
                    {t(`runbooks.format.${f}`)}
                  </button>
                ))}
              </div>
              {form.format === 'link' ? (
                <Field label={t('runbookEditor.linkLabel')}>
                  <Input type="url" value={form.source} onChange={(e) => set({ source: e.target.value })} />
                </Field>
              ) : (
                <div>
                  <label htmlFor="source" className="mb-1 block text-sm font-semibold">
                    {t('runbookEditor.content')}
                  </label>
                  <textarea
                    id="source"
                    value={form.source}
                    onChange={(e) => set({ source: e.target.value })}
                    rows={18}
                    spellCheck={form.format === 'text' || form.format === 'markdown'}
                    className="w-full rounded-control border border-rule bg-paper p-3 text-sm leading-relaxed"
                  />
                  <p className="mt-1 text-xs text-ink-soft">
                    {form.format === 'yaml' &&
                      t('runbookEditor.hintYaml', { example: `{{${t('ruleEditor.fieldWord')}}}` })}
                    {form.format === 'markdown' &&
                      t('runbookEditor.hintMarkdown')}
                    {form.format === 'checklist' && t('runbookEditor.hintChecklist')}
                    {form.format === 'text' && t('runbookEditor.hintText')}
                  </p>
                </div>
              )}
              {!runbookId && canEdit && (
                <Button
                  type="button"
                  variant="quiet"
                  onClick={() => {
                    setMode('steps');
                    changeSteps(steps);
                  }}
                >
                  {t('runbookEditor.backToSteps')}
                </Button>
              )}
            </>
          )}
          {canEdit && (
            <div className="flex flex-wrap gap-2">
              <Button
                variant="primary"
                disabled={save.isPending || !form.name.trim() || Boolean(parseError)}
                onClick={() => save.mutate()}
              >
                {runbookId ? t('runbookEditor.saveVersion') : t('runbookEditor.create')}
              </Button>
              {runbookId && (
                <Button
                  variant="quiet"
                  className="text-critical"
                  onClick={() => {
                    if (confirm(t('runbookEditor.confirmRemove', { name: form.name }))) remove.mutate();
                  }}
                >
                  {t('runbookEditor.remove')}
                </Button>
              )}
            </div>
          )}
          {failed && (
            <p role="alert" className="text-sm text-critical">
              {failed.code === 'runbook_in_use'
                ? t('runbookEditor.inUse', { message: failed.message })
                : failed.message}
            </p>
          )}
          {save.isSuccess && runbookId && (
            <p role="status" className="text-sm">
              {t('runbookEditor.saved', { version: save.data.version })}
            </p>
          )}
        </fieldset>

        <aside className="space-y-4 xl:sticky xl:top-4">
          <section
            aria-live="polite"
            aria-labelledby="steps"
            className="rounded-panel border border-rule bg-sheet p-4"
          >
            <h2 id="steps" className="text-base font-semibold">
              {t('runbookEditor.preview')}
            </h2>
            <label className="mt-2 flex items-center gap-2 text-sm">
              <span className="text-ink-soft">{t('runbookEditor.fillWith')}</span>
              <select
                value={sampleId}
                onChange={(e) => setSampleId(e.target.value)}
                className="h-8 min-w-0 flex-1 rounded-control border border-rule bg-sheet px-2"
              >
                <option value="">{t('runbookEditor.noSample')}</option>
                {schemas.data?.data.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name ?? s.preset?.name ?? t('runbookEditor.newType')} ({s.sourceName})
                  </option>
                ))}
              </select>
            </label>
            {parseError ? (
              <p className="mt-3 text-sm text-critical">{parseError}</p>
            ) : (
              <ol className="mt-3">
                {parsed.data?.steps.map((s, i) => {
                  const f = filledById.get(s.id);
                  const needsApproval = s.approval === 'required' || s.risk === 'high';
                  return (
                    <li
                      key={s.id}
                      className="grid grid-cols-[1.5rem_1fr] gap-2 border-b border-rule/70 py-2 text-sm last:border-b-0"
                    >
                      <span aria-hidden className="num font-bold text-margin">
                        {i + 1}
                      </span>
                      <div>
                        <p>
                          {s.if && <span className="text-ink-soft">{t('runbookEditor.if', { cond: s.if })}</span>}
                          {f?.textFilled ?? s.text}
                        </p>
                        {s.action && (
                          <p className="text-ink-soft">
                            {t('runbookEditor.auto')}{' '}
                            <span className="font-semibold text-ink">{actionLabel(s.action.type)}</span>
                            {s.risk === null && t('runbookEditor.unknownAction')}
                          </p>
                        )}
                        {needsApproval && (
                          <p className="font-semibold" style={{ color: 'var(--warning)' }}>
                            {t('runbookEditor.needsApproval')}
                          </p>
                        )}
                        {f && f.missingFields.length > 0 && (
                          <p style={{ color: 'var(--warning)' }}>
                            {t('runbookEditor.missing', { fields: f.missingFields.join(', ') })}
                          </p>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
            {parsed.data?.warnings.map((w) => (
              <p key={w} className="mt-2 text-sm" style={{ color: 'var(--warning)' }}>
                {w}
              </p>
            ))}
          </section>
          {mode === 'text' && (
            <section
              aria-labelledby="catalog"
              className="rounded-panel border border-rule bg-sheet p-4 text-sm"
            >
              <h2 id="catalog" className="mb-1 font-semibold">
                {t('runbookEditor.catalog')}
              </h2>
              <ul>
                {actions.data?.data.map((a) => (
                  <li key={a.name} className="flex justify-between gap-2 py-0.5">
                    <span>
                      <span className="font-semibold">{a.name}</span>{' '}
                      <span className="text-ink-soft">{a.title}</span>
                    </span>
                    <span style={a.risk === 'high' ? { color: 'var(--warning)' } : undefined}>
                      {a.risk === 'high' ? t('runbookEditor.riskHigh') : t('runbookEditor.riskLow')}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </aside>
      </div>
    </div>
  );
}
