import { stringify } from 'yaml';
import { useTranslation } from 'react-i18next';
import { ACTION_LABEL, RISKY_ACTIONS, actionLabel } from '../lib/labels.ts';
import { Button } from './ui.tsx';
import i18n from '../lib/i18n.ts';

/**
 * Step-by-step instruction editor (implementation_plan.md §5.6). People build steps in a form; the
 * result is the YAML the runbook parser already understands, so nothing changes on the server.
 */
export interface StepDraft {
  mode: 'manual' | 'auto';
  text: string;
  action: string;
  params: Record<string, string>;
}

/** What each automatic action asks for, in plain words. Values may use {{field}} from the alert. */
type ParamDef = { key: string; label: string; placeholder: string; initial?: string };
const P = 'runbookSteps.params.';
const PARAMS: Record<string, ParamDef[]> = {
  http_get: [{ key: 'url', label: `${P}urlCheck`, placeholder: 'http://counterparty-service/health' }],
  http_post: [{ key: 'url', label: `${P}url`, placeholder: 'http://serwis/akcja' }],
  retry_workflow: [
    { key: 'workflowId', label: `${P}workflow`, placeholder: '{{workflowId}}', initial: '{{workflowId}}' },
  ],
  restart_service: [{ key: 'service', label: `${P}service`, placeholder: `${P}servicePh` }],
  escalate: [{ key: 'team', label: `${P}team`, placeholder: `${P}teamPh` }],
  notify_team: [{ key: 'message', label: `${P}message`, placeholder: `${P}messagePh` }],
  open_ticket: [{ key: 'title', label: `${P}ticketTitle`, placeholder: '{{title}}', initial: '{{title}}' }],
};
/** Labels and placeholders are i18n keys when they start with the params prefix; resolve at render time. */
const tp = (v: string) => (v.startsWith(P) ? i18n.t(v, { title: '{{title}}' }) : v);

const ACTIONS = Object.keys(PARAMS);

export const newStep = (mode: StepDraft['mode'] = 'manual'): StepDraft =>
  mode === 'manual'
    ? { mode, text: '', action: '', params: {} }
    : { mode, text: '', action: 'http_get', params: {} };

const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ł/g, 'l')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'instrukcja';

/** Form → runbook YAML. Risky actions always ask for approval; the parser and step engine expect that. */
export function stepsToYaml(name: string, steps: StepDraft[]): string {
  return stringify({
    runbook: slug(name),
    steps: steps
      .filter((s) => (s.mode === 'manual' ? s.text.trim() : s.action))
      .map((s) => {
        if (s.mode === 'manual') return { text: s.text.trim() };
        const params = Object.fromEntries(Object.entries(s.params).filter(([, v]) => v.trim()));
        return {
          action: s.action,
          text: s.text.trim() || ACTION_LABEL[s.action] || s.action,
          ...params,
          approval: RISKY_ACTIONS.has(s.action) ? 'required' : 'none',
        };
      }),
  });
}

export function StepBuilder({
  steps,
  onChange,
  disabled,
}: {
  steps: StepDraft[];
  onChange: (s: StepDraft[]) => void;
  disabled?: boolean;
}) {
  const update = (i: number, patch: Partial<StepDraft>) =>
    onChange(steps.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const move = (i: number, d: -1 | 1) => {
    const next = [...steps];
    const [s] = next.splice(i, 1);
    next.splice(i + d, 0, s!);
    onChange(next);
  };
  const { t } = useTranslation();
  const input = 'h-9 w-full rounded-control border border-rule bg-sheet px-2 text-sm';

  return (
    <div>
      <ol>
        {steps.map((s, i) => (
          <li
            key={i}
            className="grid grid-cols-[2rem_1fr] gap-3 border-b border-rule/70 py-3 last:border-b-0"
          >
            <span aria-hidden className="num pt-1 text-base font-semibold text-margin">
              {i + 1}
            </span>
            <fieldset disabled={disabled} className="min-w-0 space-y-2">
              <legend className="sr-only">{t('runbookSteps.step', { n: i + 1 })}</legend>
              <div
                role="radiogroup"
                aria-label={t('runbookSteps.kind', { n: i + 1 })}
                className="flex flex-wrap gap-1 text-sm"
              >
                {(['manual', 'auto'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    role="radio"
                    aria-checked={s.mode === m}
                    onClick={() =>
                      s.mode !== m &&
                      update(i, m === 'auto' ? { mode: m, action: 'http_get', params: {} } : { mode: m })
                    }
                    className={`rounded-control border px-2.5 py-1 ${s.mode === m ? 'border-ink bg-ink font-semibold text-sheet' : 'border-rule hover:border-ink-soft'}`}
                  >
                    {m === 'manual' ? t('runbookSteps.manual') : t('runbookSteps.auto')}
                  </button>
                ))}
              </div>

              {s.mode === 'manual' ? (
                <input
                  aria-label={t('runbookSteps.whatToDo', { n: i + 1 })}
                  value={s.text}
                  onChange={(e) => update(i, { text: e.target.value })}
                  placeholder={t('runbookSteps.manualPh')}
                  className={input}
                />
              ) : (
                <div className="grid gap-2 sm:grid-cols-2">
                  <label className="text-sm">
                    <span className="mb-1 block font-semibold">{t('runbookSteps.systemAction')}</span>
                    <select
                      value={s.action}
                      onChange={(e) => {
                        const action = e.target.value;
                        const initial = Object.fromEntries(
                          (PARAMS[action] ?? []).filter((p) => p.initial).map((p) => [p.key, p.initial!]),
                        );
                        update(i, { action, params: initial });
                      }}
                      className={input}
                    >
                      {ACTIONS.map((a) => (
                        <option key={a} value={a}>
                          {actionLabel(a)}
                          {RISKY_ACTIONS.has(a) ? t('runbookSteps.needsApproval') : ''}
                        </option>
                      ))}
                    </select>
                  </label>
                  {(PARAMS[s.action] ?? []).map((p) => (
                    <label key={p.key} className="text-sm">
                      <span className="mb-1 block font-semibold">{tp(p.label)}</span>
                      <input
                        value={s.params[p.key] ?? ''}
                        onChange={(e) => update(i, { params: { ...s.params, [p.key]: e.target.value } })}
                        placeholder={tp(p.placeholder)}
                        className={input}
                      />
                    </label>
                  ))}
                  {RISKY_ACTIONS.has(s.action) && (
                    <p className="text-sm sm:col-span-2" style={{ color: 'var(--warning)' }}>
                      {t('runbookSteps.riskyHint')}
                    </p>
                  )}
                </div>
              )}

              {!disabled && (
                <div className="flex gap-1 text-sm">
                  <Button type="button" variant="quiet" disabled={i === 0} onClick={() => move(i, -1)}>
                    {t('runbookSteps.up')}
                  </Button>
                  <Button
                    type="button"
                    variant="quiet"
                    disabled={i === steps.length - 1}
                    onClick={() => move(i, 1)}
                  >
                    {t('runbookSteps.down')}
                  </Button>
                  <Button
                    type="button"
                    variant="quiet"
                    className="text-critical"
                    onClick={() => onChange(steps.filter((_, j) => j !== i))}
                  >
                    {t('runbookSteps.remove')}
                  </Button>
                </div>
              )}
            </fieldset>
          </li>
        ))}
      </ol>
      {!disabled && (
        <div className="mt-2 flex flex-wrap gap-2">
          <Button type="button" onClick={() => onChange([...steps, newStep('manual')])}>
            {t('runbookSteps.addManual')}
          </Button>
          <Button type="button" onClick={() => onChange([...steps, newStep('auto')])}>
            {t('runbookSteps.addAuto')}
          </Button>
        </div>
      )}
      <p className="mt-3 max-w-[64ch] text-xs text-ink-soft">
        {t('runbookSteps.hint', { example: '{{workflowId}}' })}
      </p>
    </div>
  );
}
