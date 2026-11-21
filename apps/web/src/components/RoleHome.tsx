import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/api.ts';
import { usePersona } from '../lib/roles.ts';
import type { Page } from '../lib/types.ts';

interface OnCallNow {
  teamId: string;
  teamName: string;
  userId: string;
  userName: string;
}

/** One line above the feed: who is on call for my teams right now, and whether it is me. */
export function OnCallStrip() {
  const { t } = useTranslation();
  const { me, myTeams } = usePersona();
  const now = useQuery({
    queryKey: ['oncall-now'],
    queryFn: () => api<{ data: OnCallNow[] }>('/oncall/now'),
  });
  const mine = new Set(myTeams.map((t) => t.id));
  const rows = (now.data?.data ?? []).filter((r) => mine.has(r.teamId));
  if (rows.length === 0) return null;
  const meOnCall = rows.filter((r) => r.userId === me?.user.id);
  return (
    <p className="mb-4 max-w-[72ch] text-sm">
      {meOnCall.length > 0 ? (
        <>
          <span className="font-semibold">{t('roleHome.youOnCall')}</span>
          {t('roleHome.youOnCallRest', { teams: meOnCall.map((r) => r.teamName).join(', ') })}
        </>
      ) : (
        <>
          {rows.map((r, i) => (
            <span key={r.teamId}>
              {i > 0 && ' '}
              {t('roleHome.onCallNowPrefix', { team: r.teamName })}
              <span className="font-semibold">{r.userName}</span>
              {t('roleHome.onCallSuffix')}
            </span>
          ))}
        </>
      )}{' '}
      <Link to="/oncall" className="text-ink-soft underline-offset-2 hover:underline">
        {t('roleHome.schedule')}
      </Link>
    </p>
  );
}

interface Step {
  done: boolean;
  title: string;
  hint: string;
  to: string;
  action: string;
}

/**
 * "Pierwsze kroki" (implementation_plan.md §5.2): until the basics exist, admins and leads see what is
 * missing, in order. A real sequence, so it is numbered. Hidden once done or dismissed.
 */
export function FirstSteps() {
  const { t } = useTranslation();
  const { me, persona, leadTeams } = usePersona();
  const key = `first-steps-hidden:${me?.user.id}:${persona}`;
  const [hidden, setHidden] = useState(() => localStorage.getItem(key) === '1');
  const enabled = persona !== 'member' && !hidden;
  const sources = useQuery({
    queryKey: ['sources', 'first-steps'],
    queryFn: () => api<Page<{ id: string; eventCount: number }>>('/sources?limit=100'),
    enabled: enabled && persona === 'admin',
  });
  const rules = useQuery({
    queryKey: ['rules', 'first-steps'],
    queryFn: () => api<Page<{ id: string; teamId: string; enabled: boolean }>>('/rules?limit=100'),
    enabled,
  });
  const runbooks = useQuery({
    queryKey: ['runbooks', 'first-steps'],
    queryFn: () => api<Page<{ id: string; teamId: string }>>('/runbooks?limit=100'),
    enabled: enabled && persona === 'lead',
  });
  const schedules = useQuery({
    queryKey: ['oncall', 'first-steps'],
    queryFn: () => api<{ data: { id: string; teamId: string }[] }>('/oncall/schedules'),
    enabled,
  });
  if (!enabled || rules.isPending || schedules.isPending) return null;

  const lead = new Set(leadTeams.map((t) => t.id));
  const ofMine = <T extends { teamId: string }>(xs: T[] | undefined) =>
    (xs ?? []).filter((x) => persona === 'admin' || lead.has(x.teamId));
  const teamWord =
    leadTeams.length === 1 ? t('roleHome.teamOne', { name: leadTeams[0]!.name }) : t('roleHome.teamYours');

  const steps: Step[] =
    persona === 'admin'
      ? [
          {
            done: (sources.data?.data ?? []).some((s) => s.eventCount > 0),
            title: t('roleHome.adminSourceTitle'),
            hint: t('roleHome.adminSourceHint'),
            to: '/sources',
            action: t('roleHome.adminSourceAction'),
          },
          {
            done: ofMine(rules.data?.data).some((r) => r.enabled),
            title: t('roleHome.adminRuleTitle'),
            hint: t('roleHome.adminRuleHint'),
            to: '/rules/new',
            action: t('roleHome.addRule'),
          },
          {
            done: ofMine(schedules.data?.data).length > 0,
            title: t('roleHome.oncallTitle'),
            hint: t('roleHome.adminOncallHint'),
            to: '/oncall',
            action: t('roleHome.oncallAction'),
          },
        ]
      : [
          {
            done: ofMine(rules.data?.data).some((r) => r.enabled),
            title: t('roleHome.leadRuleTitle', { team: teamWord }),
            hint: t('roleHome.leadRuleHint'),
            to: '/rules/new',
            action: t('roleHome.addRule'),
          },
          {
            done: ofMine(runbooks.data?.data).length > 0,
            title: t('roleHome.runbookTitle'),
            hint: t('roleHome.runbookHint'),
            to: '/runbooks/new',
            action: t('roleHome.runbookAction'),
          },
          {
            done: ofMine(schedules.data?.data).length > 0,
            title: t('roleHome.leadOncallTitle', { team: teamWord }),
            hint: t('roleHome.leadOncallHint'),
            to: '/oncall',
            action: t('roleHome.oncallAction'),
          },
        ];
  if (steps.every((s) => s.done)) return null;
  const next = steps.findIndex((s) => !s.done);

  return (
    <section
      aria-labelledby="first-steps"
      className="mb-5 max-w-3xl rounded-panel border border-rule bg-sheet"
    >
      <div className="flex items-baseline justify-between border-b border-rule px-4 py-3">
        <h2 id="first-steps" className="text-base font-semibold">
          {t('roleHome.firstSteps')}
        </h2>
        <button
          className="text-sm text-ink-soft hover:text-ink"
          onClick={() => {
            localStorage.setItem(key, '1');
            setHidden(true);
          }}
        >
          {t('roleHome.hide')}
        </button>
      </div>
      <ol>
        {steps.map((s, i) => (
          <li
            key={s.title}
            className="grid grid-cols-[2rem_1fr_auto] items-start gap-3 border-b border-rule/70 px-4 py-3 last:border-b-0"
          >
            <span
              aria-hidden
              className="num pt-0.5 text-base font-semibold"
              style={{ color: s.done ? 'var(--ink-soft)' : 'var(--margin)' }}
            >
              {i + 1}
            </span>
            <div>
              <p className={`font-semibold ${s.done ? 'text-ink-soft line-through' : ''}`}>
                {s.title}
                {s.done && <span className="sr-only">{t('roleHome.done')}</span>}
              </p>
              {!s.done && <p className="max-w-[60ch] text-sm text-ink-soft">{s.hint}</p>}
            </div>
            {!s.done && (
              <Link
                to={s.to}
                className={`inline-flex h-8 items-center rounded-control px-3 text-sm font-semibold ${
                  i === next
                    ? 'bg-ink text-sheet hover:bg-ink/90'
                    : 'border border-rule hover:border-ink-soft'
                }`}
              >
                {s.action}
              </Link>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
