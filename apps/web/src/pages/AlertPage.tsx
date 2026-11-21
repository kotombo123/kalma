import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type ApiError } from '../lib/api.ts';
import { uiLocale, when } from '../lib/format.ts';
import { type Alert } from '../lib/types.ts';
import { Button, sevVar } from '../components/ui.tsx';
import { actionLabel, paramLabel, RISKY_ACTIONS } from '../lib/labels.ts';
import { usePersona } from '../lib/roles.ts';
import i18n from '../lib/i18n.ts';

interface Step {
  id: string;
  kind: 'manual' | 'check' | 'action' | 'link' | 'read';
  text: string;
  textFilled?: string;
  state: 'pending' | 'running' | 'waiting_approval' | 'done' | 'failed' | 'skipped';
  approval: 'none' | 'required';
  if?: string;
  url?: string;
  action?: { type: string; params: Record<string, unknown> };
  actionFilled?: { type: string; params: Record<string, unknown> };
  missingFields?: string[];
  result?: { ok: boolean; output?: unknown; error?: string };
  attempts?: number;
}
interface Approval {
  id: string;
  stepId: string;
  code: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  decidedBy: string | null;
  via: string | null;
}
interface Delivery {
  id: string;
  userId: string;
  userName: string | null;
  channel: string;
  status: 'pending' | 'sending' | 'sent' | 'failed' | 'skipped';
  attempts: number;
  lastError: string | null;
}
interface TimelineEntry {
  id: string;
  ts: string;
  kind: string;
  actorType: 'user' | 'system';
  actorName: string | null;
  data: Record<string, unknown>;
}
interface Detail {
  alert: Alert;
  rule: { id: string; name: string } | null;
  timeline: TimelineEntry[];
  runbook: { id: string; steps: Step[] } | null;
  deliveries: Delivery[];
  approvals: Approval[];
}

const tr = (key: string, opts: Record<string, unknown> = {}) => i18n.t(key, opts);
const channelLabel = (c: string) =>
  i18n.exists(`alertDetail.channel.${c}`) ? tr(`alertDetail.channel.${c}`) : c;
const STEP_COLOR: Record<Step['state'], string> = {
  pending: 'var(--ink-soft)',
  running: 'var(--info)',
  waiting_approval: 'var(--warning)',
  done: 'var(--info)',
  failed: 'var(--critical)',
  skipped: 'var(--ink-soft)',
};
const HIGHLIGHT: Record<string, string> = {
  red: 'var(--critical)',
  amber: 'var(--warning)',
  green: 'var(--info)',
};

/** One timeline line in plain words. */
function describe(e: TimelineEntry, names: Map<string, string>, stepNo: Map<string, number>): string {
  const who = e.actorName ?? (e.actorType === 'system' ? tr('alertDetail.tl.system') : tr('alertDetail.tl.someone'));
  const d = e.data;
  const n = stepNo.get(String(d.stepId)) ?? '';
  switch (e.kind) {
    case 'created':
      return tr('alertDetail.tl.created');
    case 'ack':
      return tr(d.via === 'telegram' ? 'alertDetail.tl.ackTelegram' : 'alertDetail.tl.ack', { who });
    case 'resolve':
      return d.reason === 'source_resolved'
        ? tr('alertDetail.tl.resolvedBySource')
        : d.note
          ? tr('alertDetail.tl.resolveNote', { who, note: String(d.note) })
          : tr('alertDetail.tl.resolve', { who });
    case 'comment':
      return `${who}: ${String(d.text ?? '')}`;
    case 'delivery':
      return tr('alertDetail.tl.delivery', {
        channel: channelLabel(String(d.channel)),
        name: names.get(String(d.userId)) ?? tr('alertDetail.tl.recipient'),
      });
    case 'action':
    case 'step':
      if (d.action === 'complete') return tr('alertDetail.tl.stepComplete', { who, n });
      if (d.action === 'run_now') return tr('alertDetail.tl.stepRun', { who, n });
      return d.ok === false
        ? d.error
          ? tr('alertDetail.tl.stepErrorDetail', { n, error: String(d.error) })
          : tr('alertDetail.tl.stepError', { n })
        : tr('alertDetail.tl.stepOk', { n });
    case 'approval':
      return `${tr(d.decision === 'approved' ? 'alertDetail.tl.approved' : 'alertDetail.tl.rejected', { who, n })}${d.via && d.via !== 'ui' ? ` (${String(d.via)})` : ''}`;
    case 'escalation':
      return d.level
        ? tr('alertDetail.tl.escalationLevel', { level: String(d.level) })
        : tr('alertDetail.tl.escalation');
    default:
      return `${who}: ${e.kind}`;
  }
}

function RunbookStep({
  step,
  n,
  approval,
  busy,
  onComplete,
  onRun,
  onDecide,
}: {
  step: Step;
  n: number;
  approval?: Approval;
  busy: boolean;
  onComplete: () => void;
  onRun: () => void;
  onDecide: (d: 'approved' | 'rejected') => void;
}) {
  const { t } = useTranslation();
  const st = { label: t(`alertDetail.stepState.${step.state}`), color: STEP_COLOR[step.state] };
  const action = step.actionFilled ?? step.action;
  const open = step.state === 'pending' || step.state === 'failed';
  const needsApproval = approval?.status === 'pending';
  return (
    <li className="grid grid-cols-[2rem_1fr] gap-3 border-b border-rule/70 py-3 last:border-b-0">
      <span aria-hidden className="num pt-0.5 text-base font-semibold" style={{ color: st.color }}>
        {n}
      </span>
      <div>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <p
            className={`max-w-[72ch] ${step.state === 'done' || step.state === 'skipped' ? 'text-ink-soft' : ''}`}
          >
            {step.if && <span className="text-ink-soft">{t('alertDetail.ifPrefix', { cond: step.if })}</span>}
            {step.textFilled ?? step.text}
          </p>
          <span className="text-sm font-semibold" style={{ color: st.color }}>
            {st.label}
          </span>
        </div>
        {action && (
          <div className="mt-1 text-sm text-ink-soft">
            <span>
              {t('alertDetail.automatic')}<span className="font-semibold text-ink">{actionLabel(action.type)}</span>
              {(step.approval === 'required' || RISKY_ACTIONS.has(action.type)) && t('alertDetail.afterApproval')}
            </span>
            {Object.entries(action.params).length > 0 && (
              <details className="mt-0.5">
                <summary className="cursor-pointer select-none hover:text-ink">{t('alertDetail.details')}</summary>
                <dl className="mt-1 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-0.5 pl-3">
                  {Object.entries(action.params).map(([k, v]) => (
                    <div key={k} className="contents">
                      <dt>{paramLabel(k)}</dt>
                      <dd className="num break-all text-ink">
                        {typeof v === 'string' ? v : JSON.stringify(v)}
                      </dd>
                    </div>
                  ))}
                </dl>
              </details>
            )}
          </div>
        )}
        {step.kind === 'link' && step.url && /^https?:\/\//i.test(step.url) && (
          <a
            href={step.url}
            target="_blank"
            rel="noreferrer noopener"
            className="mt-1 inline-block text-sm underline"
          >
            {t('alertDetail.openInstruction')}
          </a>
        )}
        {step.missingFields && step.missingFields.length > 0 && (
          <p className="mt-1 text-sm" style={{ color: 'var(--warning)' }}>
            {t('alertDetail.missingValues', { fields: step.missingFields.join(', ') })}
          </p>
        )}
        {step.result && (
          <p className="mt-1 text-sm" style={{ color: step.result.ok ? 'var(--info)' : 'var(--critical)' }}>
            {step.result.ok
              ? t('alertDetail.succeeded')
              : t('alertDetail.failedWith', { error: step.result.error ?? t('alertDetail.noDetails') })}
            {step.attempts && step.attempts > 1 ? t('alertDetail.attempt', { n: step.attempts }) : ''}
          </p>
        )}
        <div className="mt-2 flex flex-wrap gap-2">
          {needsApproval && (
            <>
              <Button variant="primary" disabled={busy} onClick={() => onDecide('approved')}>
                {t('alertDetail.approve')}
              </Button>
              <Button disabled={busy} onClick={() => onDecide('rejected')}>
                {t('alertDetail.reject')}
              </Button>
              <span className="self-center text-sm text-ink-soft">
                {t('alertDetail.orTelegram', { code: approval.code })}
              </span>
            </>
          )}
          {!needsApproval && open && step.kind === 'manual' && (
            <Button disabled={busy} onClick={onComplete}>
              {t('alertDetail.markDone')}
            </Button>
          )}
          {!needsApproval &&
            open &&
            (step.kind === 'check' || step.kind === 'action') &&
            step.approval === 'none' && (
              <Button disabled={busy} onClick={onRun}>
                {step.state === 'failed' ? t('alertDetail.retry') : t('alertDetail.runNow')}
              </Button>
            )}
          {approval && approval.status !== 'pending' && (
            <span className="text-sm text-ink-soft">
              {approval.status === 'approved'
                ? t('alertDetail.approvedState')
                : approval.status === 'rejected'
                  ? t('alertDetail.rejectedState')
                  : t('alertDetail.expiredState')}
              {approval.via && approval.via !== 'ui' ? ` (${approval.via})` : ''}
            </span>
          )}
        </div>
      </div>
    </li>
  );
}

/** F-13: everything needed to handle one alert from a single screen. */
export function AlertPage() {
  const { alertId } = useParams({ from: '/app/alerts/$alertId' });
  const { persona } = usePersona();
  const { t } = useTranslation();
  const [fullHistory, setFullHistory] = useState(false);
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['alert', alertId], queryFn: () => api<Detail>(`/alerts/${alertId}`) });
  const [comment, setComment] = useState('');
  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ['alert', alertId] }),
      qc.invalidateQueries({ queryKey: ['alerts'] }),
    ]);
  const act = useMutation({
    mutationFn: ({ path, body }: { path: string; body?: unknown }) =>
      api(`/alerts/${alertId}/${path}`, { method: 'POST', body }),
    onSuccess: refresh,
  });

  if (q.isPending) return <p className="px-6 py-5 text-ink-soft">{t('alertDetail.loading')}</p>;
  if (q.isError) return <p className="px-6 py-5">{t('alertDetail.notFound')}</p>;
  const { alert, rule, timeline, runbook, deliveries, approvals } = q.data;
  const names = new Map(deliveries.map((d) => [d.userId, d.userName ?? t('alertDetail.recipient')]));
  const stepNo = new Map((runbook?.steps ?? []).map((s, i) => [s.id, i + 1]));
  const approvalFor = (stepId: string) =>
    approvals
      .filter((a) => a.stepId === stepId)
      .sort((a, b) => (a.status === 'pending' ? -1 : b.status === 'pending' ? 1 : 0))[0];
  const people = [...new Set(deliveries.map((d) => d.userId))];
  const pending = approvals.filter((a) => a.status === 'pending');
  const stepOf = (id: string) => runbook?.steps.find((s) => s.id === id);
  const decide = (a: Approval, decision: 'approved' | 'rejected') =>
    act.mutate({ path: `approvals/${a.id}/decide`, body: { decision } });
  const HISTORY_SHORT = 5;
  const shownTimeline = fullHistory ? timeline : timeline.slice(-HISTORY_SHORT);

  const submitComment = (e: FormEvent) => {
    e.preventDefault();
    act.mutate({ path: 'comment', body: { text: comment } }, { onSuccess: () => setComment('') });
  };

  return (
    <div className="px-6 py-5" style={{ ['--sev' as string]: sevVar(alert.severity) }}>
      <Link to="/" className="text-sm text-ink-soft hover:underline">
        {t('alertDetail.back')}
      </Link>
      <div className="mt-2 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="flex items-start gap-3 text-2xl font-bold leading-tight">
            <span
              aria-hidden
              className="mt-1 h-7 w-1.5 shrink-0 rounded-full"
              style={{ background: 'var(--sev)' }}
            />
            <span>{alert.title}</span>
          </h1>
          <p className="mt-1 pl-[18px] text-ink-soft">
            <span className="font-semibold" style={{ color: 'var(--sev)' }}>
              {t(`severity.${alert.severity}`)}
            </span>
            , {t(`status.${alert.status}`).toLowerCase()}
            {alert.count > 1 && (
              <>
                {t('alertDetail.occurredPrefix')}
                <span className="num">{alert.count}</span>
                {t('alertDetail.occurredSuffix')}
              </>
            )}
            .{' '}
            <span className="num">
              {t('alertDetail.seen', { first: when(alert.firstSeen), last: when(alert.lastSeen) })}
            </span>
            {rule && t('alertDetail.rule', { name: rule.name })}
          </p>
        </div>
        <div className="flex gap-2">
          {alert.status === 'open' && (
            <Button variant="primary" disabled={act.isPending} onClick={() => act.mutate({ path: 'ack' })}>
              {t('alertDetail.ack')}
            </Button>
          )}
          {alert.status !== 'resolved' && (
            <Button disabled={act.isPending} onClick={() => act.mutate({ path: 'resolve' })}>
              {t('alertDetail.resolve')}
            </Button>
          )}
        </div>
      </div>
      {act.isError && (
        <p role="alert" className="mt-3 text-sm text-critical">
          {(act.error as ApiError).message}
        </p>
      )}

      {pending.length > 0 && (
        <section
          aria-labelledby="decision"
          className="mt-5 max-w-4xl rounded-panel border border-rule bg-sheet p-4 pl-5"
          style={{ borderLeftWidth: '3px', borderLeftColor: 'var(--warning)' }}
        >
          <h2 id="decision" className="text-base font-semibold">
            {t('alertDetail.awaitingDecision')}
          </h2>
          <ul className="mt-2 space-y-3">
            {pending.map((a) => {
              const st = stepOf(a.stepId);
              const act0 = st?.actionFilled ?? st?.action;
              return (
                <li key={a.id} className="flex flex-wrap items-center gap-x-4 gap-y-2">
                  <p className="min-w-0 flex-1">
                    <span className="font-semibold">{act0 ? actionLabel(act0.type) : t('alertDetail.runbookStep')}</span>
                    {st && (
                      <span className="text-ink-soft">
                        {' '}
                        {t('alertDetail.stepRef', { n: stepNo.get(st.id), text: st.textFilled ?? st.text })}
                      </span>
                    )}
                  </p>
                  <div className="flex gap-2">
                    <Button variant="primary" disabled={act.isPending} onClick={() => decide(a, 'approved')}>
                      {t('alertDetail.approve')}
                    </Button>
                    <Button disabled={act.isPending} onClick={() => decide(a, 'rejected')}>
                      {t('alertDetail.reject')}
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
          <p className="mt-3 text-sm text-ink-soft">
            {t('alertDetail.decideElsewhere', { code: pending[0]!.code })}
          </p>
        </section>
      )}

      <div className="mt-6 grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="space-y-6">
          {(alert.body || alert.fields.length > 0) && (
            <section aria-labelledby="details-heading" className="rounded-panel border border-rule bg-sheet p-4">
              <h2 id="details-heading" className="sr-only">{t('alertDetail.details')}</h2>
              {alert.body && <p className="max-w-[72ch]">{alert.body}</p>}
              {alert.fields.length > 0 && (
                <dl
                  className={`grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1.5 text-sm ${alert.body ? 'mt-4' : ''}`}
                >
                  {alert.fields.map((f) => (
                    <div key={f.label} className="contents">
                      <dt className="text-ink-soft">{f.label}</dt>
                      <dd
                        className="num font-semibold"
                        style={f.highlight ? { color: HIGHLIGHT[f.highlight] } : undefined}
                      >
                        {f.value}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
            </section>
          )}

          <section aria-labelledby="runbook" className="rounded-panel border border-rule bg-sheet">
            <h2 id="runbook" className="border-b border-rule px-4 py-3 text-sm font-semibold text-ink-soft">
              {t('alertDetail.whatToDo')}
            </h2>
            {!runbook || runbook.steps.length === 0 ? (
              <p className="px-4 py-4 text-ink-soft">
                {t('alertDetail.noRunbook')}{' '}
                {persona !== 'member' && t('alertDetail.noRunbookHint')}
              </p>
            ) : (
              <ol className="px-4">
                {runbook.steps.map((s, i) => (
                  <RunbookStep
                    key={s.id}
                    step={s}
                    n={i + 1}
                    approval={approvalFor(s.id)}
                    busy={act.isPending}
                    onComplete={() => act.mutate({ path: `steps/${s.id}/complete` })}
                    onRun={() => act.mutate({ path: `steps/${s.id}/run` })}
                    onDecide={(decision) => {
                      const a = approvalFor(s.id);
                      if (a) act.mutate({ path: `approvals/${a.id}/decide`, body: { decision } });
                    }}
                  />
                ))}
              </ol>
            )}
          </section>

          <section aria-labelledby="history" className="rounded-panel border border-rule bg-sheet p-4">
            <h2 id="history" className="mb-2 text-sm font-semibold text-ink-soft">
              {t('alertDetail.history')}
            </h2>
            {timeline.length > HISTORY_SHORT && (
              <button
                className="mb-1 text-sm text-ink-soft hover:text-ink"
                onClick={() => setFullHistory((f) => !f)}
              >
                {fullHistory
                  ? t('alertDetail.showRecent')
                  : t('alertDetail.showAll', { count: timeline.length })}
              </button>
            )}
            <ol className="border-l-2 border-rule pl-4 text-sm">
              {shownTimeline.map((e) => (
                <li key={e.id} className="py-1">
                  <time className="num mr-2 text-ink-soft" dateTime={e.ts}>
                    {new Date(e.ts).toLocaleTimeString(uiLocale())}
                  </time>
                  {describe(e, names, stepNo)}
                </li>
              ))}
            </ol>
            <form onSubmit={submitComment} className="mt-4 flex gap-2">
              <label htmlFor="comment" className="sr-only">
                {t('alertDetail.comment')}
              </label>
              <input
                id="comment"
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                maxLength={2000}
                placeholder={t('alertDetail.commentPlaceholder')}
                className="h-9 min-w-0 flex-1 rounded-control border border-rule bg-paper px-3 placeholder:text-ink-soft"
              />
              <Button type="submit" disabled={!comment.trim() || act.isPending}>
                {t('alertDetail.add')}
              </Button>
            </form>
          </section>

          {persona !== 'member' && (
            <details className="rounded-panel border border-rule bg-sheet px-4 py-3">
              <summary className="cursor-pointer font-semibold">{t('alertDetail.rawMessage')}</summary>
              <pre className="mt-3 overflow-x-auto text-xs leading-relaxed">
                {JSON.stringify(alert.lastEvent.raw, null, 2)}
              </pre>
            </details>
          )}
        </div>

        <aside className="space-y-6">
          <section aria-labelledby="sent" className="rounded-panel border border-rule bg-sheet">
            <h2 id="sent" className="border-b border-rule px-4 py-3 text-sm font-semibold text-ink-soft">
              {t('alertDetail.notified')}
            </h2>
            {people.length === 0 ? (
              <p className="px-4 py-3 text-sm text-ink-soft">{t('alertDetail.nobodyNotified')}</p>
            ) : (
              <ul>
                {people.map((uid) => (
                  <li key={uid} className="border-b border-rule/70 px-4 py-2 text-sm last:border-b-0">
                    <div className="font-semibold">{names.get(uid)}</div>
                    <div className="text-ink-soft">
                      {deliveries
                        .filter((d) => d.userId === uid)
                        .map((d) => (
                          <span key={d.id} className="mr-3 inline-block" title={d.lastError ?? undefined}>
                            {channelLabel(d.channel)}:{' '}
                            <span style={d.status === 'failed' ? { color: 'var(--critical)' } : undefined}>
                              {t(`alertDetail.delivery.${d.status}`)}
                            </span>
                          </span>
                        ))}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
          {alert.groupMembers && alert.groupMembers.length > 1 && (
            <section aria-labelledby="group" className="rounded-panel border border-rule bg-sheet p-4">
              <h2 id="group" className="text-sm font-semibold text-ink-soft">
                {t('alertDetail.inGroup')}
              </h2>
              <ul className="mt-2 text-sm">
                {alert.groupMembers.map((g) => (
                  <li key={g}>{g}</li>
                ))}
              </ul>
            </section>
          )}
        </aside>
      </div>
    </div>
  );
}
