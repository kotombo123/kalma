import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, type ApiError } from '../lib/api.ts';
import { useAuth } from '../lib/auth.tsx';
import type { OrgMember, Page, TeamDetail, TeamSummary } from '../lib/types.ts';
import { Button, Field } from '../components/ui.tsx';
import { usePersona } from '../lib/roles.ts';

interface Schedule {
  id: string;
  teamId: string;
  rotation: 'daily' | 'weekly';
  handoffTime: string;
  timezone: string;
  participants: string[];
  startDate: string;
  overrides: { id: string; userId: string; startsAt: string; endsAt: string }[];
  onCallNow: { userId: string; overrideId?: string };
}

const dateFmt = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});
const shiftFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' });

function upcoming(s: Schedule, count = 4) {
  const len = (s.rotation === 'daily' ? 1 : 7) * 86_400_000;
  const start = new Date(`${s.startDate}T00:00:00`);
  const period = Math.max(0, Math.floor((Date.now() - start.getTime()) / len));
  const n = s.participants.length;
  const base = s.onCallNow.overrideId ? period % n : Math.max(0, s.participants.indexOf(s.onCallNow.userId));
  return [
    { from: null as Date | null, userId: s.onCallNow.userId },
    ...Array.from({ length: count - 1 }, (_, k) => ({
      from: new Date(start.getTime() + (period + k + 1) * len),
      userId: s.participants[(base + k + 1) % n]!,
    })),
  ];
}

const DAY = 86_400_000;
const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'numeric' });
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const toLocalInput = (d: Date) =>
  new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

function whoAt(s: Schedule, t: Date): { userId: string; override: boolean } {
  const o = s.overrides.find((x) => new Date(x.startsAt) <= t && t < new Date(x.endsAt));
  if (o) return { userId: o.userId, override: true };
  const n = s.participants.length;
  if (n === 0) return { userId: '', override: false };
  const len = (s.rotation === 'daily' ? 1 : 7) * DAY;
  const start = new Date(`${s.startDate}T00:00:00`).getTime();
  const periodNow = Math.floor((Date.now() - start) / len);
  const periodT = Math.floor((t.getTime() - start) / len);
  const base = s.onCallNow.overrideId
    ? ((periodNow % n) + n) % n
    : Math.max(0, s.participants.indexOf(s.onCallNow.userId));
  return { userId: s.participants[(((base + periodT - periodNow) % n) + n) % n]!, override: false };
}

function WeekCalendar({
  schedules,
  names,
  teamName,
  me,
  onPickDay,
}: {
  schedules: Schedule[];
  names: Map<string, string>;
  teamName: Map<string, string>;
  me: string;
  onPickDay: (scheduleId: string, day: Date) => void;
}) {
  const { t } = useTranslation();
  const today = startOfDay(new Date());
  const days = Array.from({ length: 6 }, (_, i) => new Date(today.getTime() + (i + 1) * DAY + DAY / 2));
  const short = (id: string) => names.get(id) ?? '—';
  const cell = (userId: string, override: boolean, strong = false) => (
    <span
      className={`inline-block max-w-full truncate align-bottom ${userId === me ? 'rounded-control bg-ink px-1.5 py-0.5 text-sheet' : ''} ${strong ? 'font-semibold' : ''}`}
    >
      {short(userId)}
      {override && <span className={userId === me ? '' : 'text-ink-soft'}> ({t('oncall.sub')})</span>}
    </span>
  );
  return (
    <section
      aria-labelledby="week"
      className="mb-6 overflow-x-auto rounded-panel border border-rule bg-sheet"
    >
      <h2 id="week" className="border-b border-rule px-4 py-3 text-base font-semibold">
        {t('oncall.weekTitle')}
      </h2>
      <table className="w-full min-w-[860px] table-fixed text-sm">
        <caption className="sr-only">{t('oncall.weekCaption')}</caption>
        <colgroup>
          <col className="w-40" />
          <col className="w-44" />
        </colgroup>
        <thead>
          <tr className="border-b border-rule text-left text-xs text-ink-soft">
            <th scope="col" className="px-4 py-2 font-semibold">
              {t('oncall.team')}
            </th>
            <th scope="col" className="border-l border-rule/70 px-3 py-2 font-semibold text-ink">
              {t('oncall.now_label')}
            </th>
            {days.map((d) => (
              <th
                key={d.toISOString()}
                scope="col"
                className="num border-l border-rule/70 px-3 py-2 font-semibold"
              >
                {dayFmt.format(d)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {schedules.map((s) => (
            <tr key={s.id} className="border-b border-rule/70 last:border-b-0">
              <th scope="row" className="truncate px-4 py-2.5 text-left font-semibold">
                {teamName.get(s.teamId) ?? t('oncall.teamLabel')}
              </th>
              <td className="border-l border-rule/70 bg-paper px-3 py-2.5">
                {cell(s.onCallNow.userId, Boolean(s.onCallNow.overrideId), true)}
              </td>
              {days.map((d) => {
                const w = whoAt(s, d);
                return (
                  <td key={d.toISOString()} className="border-l border-rule/70 p-0">
                    <button
                      type="button"
                      onClick={() => onPickDay(s.id, d)}
                      title={t('oncall.clickDay')}
                      className="block h-full w-full truncate px-3 py-2.5 text-left hover:bg-rule/30"
                    >
                      {cell(w.userId, w.override)}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="px-4 py-2 text-xs text-ink-soft">{t('oncall.clickDay')}</p>
    </section>
  );
}

function ScheduleCard({
  s,
  names,
  teamName,
  canManage,
  me,
  picked,
}: {
  s: Schedule;
  names: Map<string, string>;
  teamName: string;
  canManage: boolean;
  me: string;
  picked: Date | null;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const team = useQuery({
    queryKey: ['team', s.teamId],
    queryFn: () => api<TeamDetail>(`/teams/${s.teamId}`),
  });
  const [form, setForm] = useState({ userId: me, startsAt: '', endsAt: '' });
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (!picked) return;
    const from = startOfDay(picked);
    setForm((f) => ({
      ...f,
      startsAt: toLocalInput(from),
      endsAt: toLocalInput(new Date(from.getTime() + DAY)),
    }));
    formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    formRef.current?.querySelector('select')?.focus();
  }, [picked]);
  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ['oncall'] }),
      qc.invalidateQueries({ queryKey: ['oncall-now'] }),
    ]);
  const add = useMutation({
    mutationFn: () =>
      api(`/oncall/schedules/${s.id}/overrides`, {
        method: 'POST',
        body: {
          userId: form.userId,
          startsAt: new Date(form.startsAt).toISOString(),
          endsAt: new Date(form.endsAt).toISOString(),
        },
      }),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/oncall/schedules/${s.id}/overrides/${id}`, { method: 'DELETE' }),
    onSuccess: refresh,
  });
  const drop = useMutation({
    mutationFn: () => api(`/oncall/schedules/${s.id}`, { method: 'DELETE' }),
    onSuccess: refresh,
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    add.mutate();
  };
  const people = canManage
    ? (team.data?.members ?? [])
    : (team.data?.members ?? []).filter((m) => m.id === me);
  const err = (add.error ?? remove.error ?? drop.error) as ApiError | null;
  const rotLabel = s.rotation === 'daily' ? t('oncall.rotationDaily') : t('oncall.rotationWeekly');

  return (
    <section aria-label={`${teamName}`} className="rounded-panel border border-rule bg-sheet">
      <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-rule px-4 py-3">
        <h2 className="text-base font-semibold">{teamName}</h2>
        <span className="text-sm text-ink-soft">
          {t('oncall.rotation')} {rotLabel}
        </span>
      </header>
      <div className="grid gap-4 p-4 md:grid-cols-2">
        <div>
          <h3 className="text-sm font-semibold">{t('oncall.queue')}</h3>
          <ol className="mt-1 text-sm">
            {upcoming(s).map((u, i) => (
              <li key={i} className="flex justify-between gap-3 border-b border-rule/60 py-1 last:border-b-0">
                <span className={i === 0 ? 'font-semibold' : ''}>{names.get(u.userId) ?? u.userId}</span>
                <span className="num text-ink-soft">
                  {u.from ? `${t('oncall.onDutyFrom')} ${shiftFmt.format(u.from)}` : t('oncall.now_label')}
                </span>
              </li>
            ))}
          </ol>
          {canManage && (
            <Button
              variant="quiet"
              className="mt-2 text-critical"
              onClick={() => confirm(t('oncall.confirmDelete')) && drop.mutate()}
            >
              {t('oncall.deleteSchedule')}
            </Button>
          )}
        </div>
        <div>
          <h3 className="text-sm font-semibold">{t('oncall.substitutes')}</h3>
          {s.overrides.length === 0 && (
            <p className="text-sm text-ink-soft">{t('oncall.noSubs')}</p>
          )}
          <ul className="text-sm">
            {s.overrides.map((o) => (
              <li key={o.id} className="flex items-baseline justify-between gap-2 py-0.5">
                <span>
                  <span className="font-semibold">{names.get(o.userId) ?? o.userId}</span>{' '}
                  <span className="num text-ink-soft">
                    {dateFmt.format(new Date(o.startsAt))} – {dateFmt.format(new Date(o.endsAt))}
                  </span>
                </span>
                {(canManage || o.userId === me) && (
                  <button className="text-ink-soft underline" onClick={() => remove.mutate(o.id)}>
                    {t('oncall.deleteOverride')}
                  </button>
                )}
              </li>
            ))}
          </ul>
          {people.length > 0 && (
            <form ref={formRef} onSubmit={submit} className="mt-3 flex flex-wrap items-center gap-2 text-sm">
              <label className="sr-only" htmlFor={`who-${s.id}`}>
                {t('oncall.who')}
              </label>
              <select
                id={`who-${s.id}`}
                value={form.userId}
                onChange={(e) => setForm((f) => ({ ...f, userId: e.target.value }))}
                className="h-9 rounded-control border border-rule bg-sheet px-2"
              >
                {people.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.id === me ? t('oncall.me') : m.name}
                  </option>
                ))}
              </select>
              <span>{t('oncall.onDutyFrom')}</span>
              <input
                aria-label="From"
                type="datetime-local"
                required
                value={form.startsAt}
                onChange={(e) => setForm((f) => ({ ...f, startsAt: e.target.value }))}
                className="h-9 rounded-control border border-rule bg-sheet px-2"
              />
              <span>{t('oncall.to')}</span>
              <input
                aria-label="To"
                type="datetime-local"
                required
                value={form.endsAt}
                onChange={(e) => setForm((f) => ({ ...f, endsAt: e.target.value }))}
                className="h-9 rounded-control border border-rule bg-sheet px-2"
              />
              <Button type="submit" disabled={add.isPending}>
                {t('oncall.addSub')}
              </Button>
            </form>
          )}
          {err && <p className="mt-2 text-sm text-critical">{err.message}</p>}
        </div>
      </div>
    </section>
  );
}

function NewSchedule({ teams, onDone }: { teams: TeamSummary[]; onDone: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [teamId, setTeamId] = useState(teams[0]?.id ?? '');
  const [rotation, setRotation] = useState<'daily' | 'weekly'>('weekly');
  const handoffTime = '00:00';
  const [order, setOrder] = useState<string[]>([]);
  const team = useQuery({
    queryKey: ['team', teamId],
    queryFn: () => api<TeamDetail>(`/teams/${teamId}`),
    enabled: Boolean(teamId),
  });
  const create = useMutation({
    mutationFn: () =>
      api('/oncall/schedules', {
        method: 'POST',
        body: {
          teamId,
          rotation,
          handoffTime,
          timezone: 'Europe/Warsaw',
          participants: order,
          startDate: new Date().toISOString().slice(0, 10),
        },
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['oncall'] });
      onDone();
    },
  });
  return (
    <section className="rounded-panel border border-rule bg-sheet p-4" aria-label={t('oncall.newScheduleLabel')}>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label={t('oncall.teamLabel')}>
          <select
            value={teamId}
            onChange={(e) => (setTeamId(e.target.value), setOrder([]))}
            className="h-9 w-full rounded-control border border-rule bg-sheet px-2"
          >
            {teams.map((tItem) => (
              <option key={tItem.id} value={tItem.id}>
                {tItem.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('oncall.rotation')}>
          <select
            value={rotation}
            onChange={(e) => setRotation(e.target.value as 'daily' | 'weekly')}
            className="h-9 w-full rounded-control border border-rule bg-sheet px-2"
          >
            <option value="weekly">{t('oncall.rotationWeekly')}</option>
            <option value="daily">{t('oncall.rotationDaily')}</option>
          </select>
        </Field>
      </div>
      <fieldset className="mt-3">
        <legend className="text-sm font-semibold">{t('oncall.participants')}</legend>
        <div className="mt-1 flex flex-wrap gap-3 text-sm">
          {team.data?.members.map((m) => (
            <label key={m.id} className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={order.includes(m.id)}
                onChange={(e) =>
                  setOrder((o) => (e.target.checked ? [...o, m.id] : o.filter((x) => x !== m.id)))
                }
              />
              {m.name}
              {order.includes(m.id) && (
                <span className="num font-semibold text-margin">{order.indexOf(m.id) + 1}</span>
              )}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="mt-3 flex gap-2">
        <Button
          variant="primary"
          disabled={order.length === 0 || create.isPending}
          onClick={() => create.mutate()}
        >
          {t('oncall.create')}
        </Button>
        <Button variant="quiet" onClick={onDone}>
          Cancel
        </Button>
      </div>
      {create.isError && <p className="mt-2 text-sm text-critical">{(create.error as ApiError).message}</p>}
    </section>
  );
}

export function OncallPage() {
  const { t } = useTranslation();
  const { me } = useAuth();
  const { persona, myTeams } = usePersona();
  const [adding, setAdding] = useState(false);
  const [picked, setPicked] = useState<{ id: string; day: Date } | null>(null);
  const [showOthers, setShowOthers] = useState(false);
  const schedules = useQuery({
    queryKey: ['oncall'],
    queryFn: () => api<{ data: Schedule[] }>('/oncall/schedules'),
    refetchInterval: 60_000,
  });
  const teams = useQuery({ queryKey: ['teams'], queryFn: () => api<Page<TeamSummary>>('/teams?limit=100') });
  const members = useQuery({
    queryKey: ['members'],
    queryFn: () => api<Page<OrgMember>>('/members?limit=100'),
  });
  const names = new Map(members.data?.data.map((m) => [m.id, m.name]));
  const teamName = new Map(teams.data?.data.map((tItem) => [tItem.id, tItem.name]));
  const leads = (teams.data?.data ?? []).filter(
    (tItem) => me?.role === 'admin' || me?.teams.some((m) => m.id === tItem.id && m.role === 'lead'),
  );
  const all = schedules.data?.data ?? [];
  const mine = new Set(myTeams.map((tItem) => tItem.id));
  const shown = persona === 'admin' || showOthers ? all : all.filter((s) => mine.has(s.teamId));
  const hidden = persona === 'admin' ? 0 : all.length - all.filter((s) => mine.has(s.teamId)).length;

  return (
    <div className="px-6 py-5">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{t('oncall.title')}</h1>
          <p className="mt-1 max-w-[72ch] text-ink-soft">{t('oncall.description')}</p>
        </div>
        {leads.length > 0 && !adding && (
          <Button variant="primary" onClick={() => setAdding(true)}>
            {t('oncall.newSchedule')}
          </Button>
        )}
      </div>

      {all.length === 0 && schedules.data && (
        <p className="mb-6 max-w-[72ch] rounded-panel border border-dashed border-rule p-6 text-ink-soft">
          {t('oncall.noSchedules')}
          {leads.length > 0 && t('oncall.noSchedules_lead')}
        </p>
      )}
      {shown.length > 0 && (
        <WeekCalendar
          schedules={shown}
          names={names}
          teamName={teamName}
          me={me?.user.id ?? ''}
          onPickDay={(id, day) => setPicked({ id, day })}
        />
      )}
      {hidden > 0 && (
        <button
          className="-mt-4 mb-6 text-sm text-ink-soft hover:text-ink"
          onClick={() => setShowOthers((v) => !v)}
        >
          {showOthers ? t('oncall.showMine') : t('oncall.showOthers', { count: hidden })}
        </button>
      )}

      {adding && (
        <div className="mb-6">
          <NewSchedule teams={leads} onDone={() => setAdding(false)} />
        </div>
      )}

      <div className="space-y-6">
        {shown.map((s) => (
          <ScheduleCard
            picked={picked?.id === s.id ? picked.day : null}
            key={s.id}
            s={s}
            names={names}
            teamName={teamName.get(s.teamId) ?? t('oncall.teamLabel')}
            canManage={leads.some((tItem) => tItem.id === s.teamId)}
            me={me?.user.id ?? ''}
          />
        ))}
      </div>
    </div>
  );
}
