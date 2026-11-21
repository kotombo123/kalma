import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, type ApiError } from '../lib/api.ts';
import { type Channel } from '../lib/rules.ts';
import { type Severity } from '../lib/types.ts';
import { Button, Field, Input, MoreOptions, sevVar } from '../components/ui.tsx';
import { CopyButton } from '../components/Connect.tsx';

interface Prefs {
  timezone: string;
  workingHours: { days: number[]; start: string; end: string } | null;
  inWorkingHoursNow: boolean;
  channelPrefs: { severity: Severity; inHours: Channel[]; offHours: Channel[] }[];
  addresses: { channel: string; address: string; verified: boolean }[];
}

const CHANNELS: Channel[] = ['ui', 'email', 'telegram', 'teams'];
const DAYS_EN = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const DAYS_PL = ['pon', 'wt', 'śr', 'czw', 'pt', 'sob', 'nd'];
const ZONES = [
  'Europe/Warsaw',
  'Europe/London',
  'Europe/Berlin',
  'America/New_York',
  'Asia/Singapore',
  'UTC',
];

const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

type ProfileId = 'recommended' | 'workhours' | 'email' | 'custom';
type ChannelPrefs = Prefs['channelPrefs'];

function profilePrefs(id: Exclude<ProfileId, 'custom'>, telegram: boolean): ChannelPrefs {
  const urgent: Channel[] = telegram ? ['ui', 'email', 'telegram'] : ['ui', 'email'];
  const mail: Channel[] = ['ui', 'email'];
  const ui: Channel[] = ['ui'];
  const rows: Record<Severity, [Channel[], Channel[]]> =
    id === 'recommended'
      ? { critical: [urgent, urgent], error: [mail, mail], warning: [ui, ui], info: [ui, ui] }
      : id === 'workhours'
        ? { critical: [urgent, ui], error: [mail, ui], warning: [ui, ui], info: [ui, ui] }
        : { critical: [mail, mail], error: [mail, mail], warning: [mail, mail], info: [mail, mail] };
  return (Object.keys(rows) as Severity[]).map((severity) => ({
    severity,
    inHours: rows[severity][0],
    offHours: rows[severity][1],
  }));
}

const same = (a: Channel[], b: Channel[]) => a.length === b.length && a.every((x) => b.includes(x));
function detectProfile(prefs: ChannelPrefs, telegram: boolean): ProfileId {
  for (const id of ['recommended', 'workhours', 'email'] as const) {
    const p = profilePrefs(id, telegram);
    const match = p.every((r) => {
      const cur = prefs.find((x) => x.severity === r.severity);
      return cur && same(cur.inHours, r.inHours) && same(cur.offHours, r.offHours);
    });
    if (match) return id;
  }
  return 'custom';
}

export function SettingsPage() {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['prefs'], queryFn: () => api<Prefs>('/me/preferences') });
  const [draft, setDraft] = useState<Prefs | null>(null);
  const [profile, setProfile] = useState<ProfileId | null>(null);
  useEffect(() => {
    if (q.data) setDraft(q.data);
  }, [q.data]);
  const save = useMutation({
    mutationFn: () =>
      api<Prefs>('/me/preferences', {
        method: 'PUT',
        body: {
          timezone: draft!.timezone,
          workingHours: draft!.workingHours,
          channelPrefs: draft!.channelPrefs,
        },
      }),
    onSuccess: (p) => qc.setQueryData(['prefs'], p),
  });

  if (!draft) return <p className="px-6 py-5 text-ink-soft">{t('loading')}</p>;

  const toggle = (sev: Severity, when: 'inHours' | 'offHours', ch: Channel) =>
    setDraft((d) => ({
      ...d!,
      channelPrefs: d!.channelPrefs.map((p) =>
        p.severity !== sev
          ? p
          : { ...p, [when]: p[when].includes(ch) ? p[when].filter((x) => x !== ch) : [...p[when], ch] },
      ),
    }));
  const wh = draft.workingHours;
  const telegramLinked = q.data!.addresses.some((a) => a.channel === 'telegram');
  const current = detectProfile(draft.channelPrefs, telegramLinked);
  const chosen = profile ?? current;
  const setChosen = setProfile;
  const pick = (id: ProfileId) => {
    setChosen(id);
    if (id !== 'custom') setDraft((d) => ({ ...d!, channelPrefs: profilePrefs(id, telegramLinked) }));
  };

  const DAYS = i18n.language === 'pl' ? DAYS_PL : DAYS_EN;

  const sevLabel: Record<Severity, string> = {
    critical: t('severity.critical'),
    error: t('severity.error'),
    warning: t('severity.warning'),
    info: t('severity.info'),
  };
  const chLabel: Record<Channel, string> = {
    ui: t('channels.ui'),
    email: t('channels.email'),
    telegram: t('channels.telegram'),
    teams: t('channels.teams'),
    sms: t('channels.sms'),
    phone: t('channels.phone'),
  };

  type ProfileDef = { id: ProfileId; name: string; hint: string };
  const PROFILES: ProfileDef[] = [
    {
      id: 'recommended',
      name: t('settings.profileRecommended'),
      hint: telegramLinked ? t('settings.recommendedHint_tg') : t('settings.recommendedHint'),
    },
    {
      id: 'workhours',
      name: t('settings.profileWorkhours'),
      hint: telegramLinked ? t('settings.workhoursHint_tg') : t('settings.workhoursHint'),
    },
    {
      id: 'email',
      name: t('settings.profileEmail'),
      hint: t('settings.emailHint'),
    },
    {
      id: 'custom',
      name: t('settings.profileCustom'),
      hint: t('settings.customHint'),
    },
  ];

  return (
    <div className="max-w-4xl px-6 py-5">
      <h1 className="text-2xl font-bold">{t('settings.title')}</h1>
      <p className="mt-1 max-w-[72ch] text-ink-soft">{t('settings.subtitle')}</p>

      <fieldset className="mt-5 overflow-hidden rounded-panel border border-rule bg-sheet">
        <legend className="sr-only">Notification method</legend>
        {PROFILES.map((p) => (
          <label
            key={p.id}
            className={`flex cursor-pointer gap-3 border-b border-rule/70 px-4 py-3 last:border-b-0 ${chosen === p.id ? 'bg-paper' : ''}`}
          >
            <input
              type="radio"
              name="profile"
              className="mt-1"
              checked={chosen === p.id}
              onChange={() => pick(p.id)}
            />
            <span>
              <span className="block font-semibold">{p.name}</span>
              <span className="block max-w-[64ch] text-sm text-ink-soft">{p.hint}</span>
              {p.id === 'workhours' && !wh && chosen === 'workhours' && (
                <span className="mt-1 block text-sm" style={{ color: 'var(--warning)' }}>
                  {t('settings.setWorkingHours')}
                </span>
              )}
            </span>
          </label>
        ))}
      </fieldset>

      {chosen === 'custom' && (
        <section
          aria-labelledby="matrix"
          className="mt-4 overflow-x-auto rounded-panel border border-rule bg-sheet"
        >
          <h2 id="matrix" className="border-b border-rule px-4 py-3 text-sm font-semibold text-ink-soft">
            {t('settings.matrixTitle')}
          </h2>
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="border-b border-rule text-left text-xs text-ink-soft">
                <th scope="col" className="px-4 py-2 font-semibold">
                  {t('settings.matrixSeverity')}
                </th>
                <th scope="col" className="border-l border-rule/70 px-3 py-2 font-semibold">
                  {t('settings.matrixInHours')}
                </th>
                <th scope="col" className="border-l border-rule/70 px-3 py-2 font-semibold">
                  {t('settings.matrixOffHours')}
                </th>
              </tr>
            </thead>
            <tbody>
              {draft.channelPrefs.map((p) => (
                <tr key={p.severity} className="border-b border-rule/70 last:border-b-0">
                  <th scope="row" className="px-4 py-2.5 text-left">
                    <span className="flex items-center gap-2 font-semibold">
                      <span
                        aria-hidden
                        className="h-4 w-1 rounded-full"
                        style={{ background: sevVar(p.severity) }}
                      />
                      {sevLabel[p.severity]}
                    </span>
                  </th>
                  {(['inHours', 'offHours'] as const).map((w) => (
                    <td key={w} className="border-l border-rule/70 px-3 py-2">
                      <div className="flex flex-wrap gap-x-3 gap-y-1">
                        {CHANNELS.map((ch) => (
                          <label
                            key={ch}
                            className={`flex items-center gap-1 ${ch === 'telegram' && !telegramLinked ? 'text-ink-soft' : ''}`}
                            title={
                              ch === 'telegram' && !telegramLinked
                                ? t('settings.telegramHint')
                                : undefined
                            }
                          >
                            <input
                              type="checkbox"
                              disabled={ch === 'telegram' && !telegramLinked && !p[w].includes(ch)}
                              checked={p[w].includes(ch)}
                              onChange={() => toggle(p.severity, w, ch)}
                            />
                            {chLabel[ch]}
                          </label>
                        ))}
                      </div>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section aria-labelledby="hours" className="mt-6 rounded-panel border border-rule bg-sheet p-4">
        <h2 id="hours" className="text-base font-semibold">
          {t('settings.whTitle')}
        </h2>
        <label className="mt-2 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={Boolean(wh)}
            onChange={(e) =>
              setDraft((d) => ({
                ...d!,
                workingHours: e.target.checked
                  ? { days: [1, 2, 3, 4, 5], start: '08:00', end: '17:00' }
                  : null,
              }))
            }
          />
          {t('settings.whEnabled')}
        </label>
        {wh && (
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
            <span>{t('settings.whWorkingOn')}</span>
            <div role="group" aria-label="Working days" className="flex gap-1">
              {DAYS.map((d, i) => {
                const day = i + 1;
                const on = wh.days.includes(day);
                return (
                  <button
                    key={d}
                    type="button"
                    aria-pressed={on}
                    onClick={() =>
                      setDraft((x) => ({
                        ...x!,
                        workingHours: {
                          ...wh,
                          days: on ? wh.days.filter((n) => n !== day) : [...wh.days, day].sort(),
                        },
                      }))
                    }
                    className={`h-8 w-10 rounded-control border text-sm ${on ? 'border-ink bg-ink font-semibold text-sheet' : 'border-rule'}`}
                  >
                    {d}
                  </button>
                );
              })}
            </div>
            <span>{t('settings.whFrom')}</span>
            <input
              aria-label="From"
              type="time"
              value={wh.start}
              onChange={(e) => setDraft((x) => ({ ...x!, workingHours: { ...wh, start: e.target.value } }))}
              className="h-9 rounded-control border border-rule bg-sheet px-2"
            />
            <span>{t('settings.whTo')}</span>
            <input
              aria-label="To"
              type="time"
              value={wh.end}
              onChange={(e) => setDraft((x) => ({ ...x!, workingHours: { ...wh, end: e.target.value } }))}
              className="h-9 rounded-control border border-rule bg-sheet px-2"
            />
          </div>
        )}
        <p className="mt-3 text-sm text-ink-soft">
          {q.data?.inWorkingHoursNow ? t('settings.currently_in') : t('settings.currently_out')}
        </p>
        <MoreOptions count={1} changed={draft.timezone !== browserZone ? 1 : 0}>
          <Field label={t('settings.timezone')}>
            <select
              value={draft.timezone}
              onChange={(e) => setDraft((x) => ({ ...x!, timezone: e.target.value }))}
              className="h-9 rounded-control border border-rule bg-sheet px-2"
            >
              {[...new Set([draft.timezone, browserZone, ...ZONES])].map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </select>
          </Field>
        </MoreOptions>
      </section>

      <div className="mt-4 flex items-center gap-3">
        <Button variant="primary" onClick={() => save.mutate()} disabled={save.isPending}>
          {t('settings.saveBtn')}
        </Button>
        {save.isSuccess && <span role="status">{t('settings.saved')}</span>}
        {save.isError && <span className="text-critical">{(save.error as ApiError).message}</span>}
      </div>

      <Addresses prefs={q.data!} />
    </div>
  );
}

function Addresses({ prefs }: { prefs: Prefs }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const addr = (ch: string) => prefs.addresses.find((a) => a.channel === ch);
  const [email, setEmail] = useState(addr('email')?.address ?? '');
  const [teamsUrl, setTeamsUrl] = useState(addr('teams')?.address ?? '');
  const save = useMutation({
    mutationFn: ({ ch, address }: { ch: string; address: string }) =>
      address
        ? api<Prefs>(`/me/addresses/${ch}`, { method: 'PUT', body: { address } })
        : api(`/me/addresses/${ch}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['prefs'] }),
  });
  const link = useMutation({
    mutationFn: () =>
      api<{ code: string; command: string; expiresAt: string }>('/me/telegram/link', { method: 'POST' }),
  });
  const telegram = addr('telegram');

  return (
    <section aria-labelledby="addresses" className="mt-6 rounded-panel border border-rule bg-sheet p-4">
      <h2 id="addresses" className="text-base font-semibold">
        {t('settings.addressesTitle')}
      </h2>
      <form
        className="mt-3 flex items-end gap-2 sm:max-w-md"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate({ ch: 'email', address: email.trim() });
        }}
      >
        <Field
          label={t('settings.emailLabel')}
          hint={addr('email') && !addr('email')!.verified ? t('settings.unverified') : undefined}
        >
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Button type="submit">{t('settings.save')}</Button>
      </form>
      {save.isError && <p className="mt-2 text-sm text-critical">{(save.error as ApiError).message}</p>}

      <div className="mt-5 border-t border-rule pt-4">
        <h3 className="font-semibold">Microsoft Teams</h3>
        {addr('teams') ? (
          <p className="mt-1 text-sm">
            {t('settings.teamsConnected')}{' '}
            <button className="underline" onClick={() => save.mutate({ ch: 'teams', address: '' })}>
              {t('settings.teamsDisconnect')}
            </button>
          </p>
        ) : (
          <div className="mt-2">
            <p className="mb-2 text-sm text-ink-soft">{t('settings.teamsHint')}</p>
            <form
              className="flex items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                const url = teamsUrl.trim();
                if (url) save.mutate({ ch: 'teams', address: url });
              }}
            >
              <Field label={t('settings.teamsWebhookLabel')}>
                <Input
                  type="url"
                  value={teamsUrl}
                  onChange={(e) => setTeamsUrl(e.target.value)}
                  placeholder="https://xxx.webhook.office.com/..."
                />
              </Field>
              <Button type="submit" disabled={save.isPending}>
                {t('settings.save')}
              </Button>
            </form>
          </div>
        )}
      </div>

      <div className="mt-5 border-t border-rule pt-4">
        <h3 className="font-semibold">Telegram</h3>
        {telegram ? (
          <p className="mt-1 text-sm">
            {t('settings.telegramConnected', { id: telegram.address })}{' '}
            <button className="underline" onClick={() => save.mutate({ ch: 'telegram', address: '' })}>
              {t('settings.telegramDisconnect')}
            </button>
          </p>
        ) : link.data ? (
          <div className="mt-2 text-sm">
            <p>{t('settings.telegramInstruction')}</p>
            <div className="mt-2 flex items-center gap-2">
              <code className="rounded-control border border-rule bg-paper px-3 py-1.5 text-base font-semibold">
                {link.data.command}
              </code>
              <CopyButton text={link.data.command} />
            </div>
            <button
              className="mt-2 underline"
              onClick={() => void qc.invalidateQueries({ queryKey: ['prefs'] })}
            >
              {t('settings.telegramCheckLink')}
            </button>
          </div>
        ) : (
          <div className="mt-1 text-sm">
            <p className="text-ink-soft">{t('settings.telegramChannelHint')}</p>
            <Button className="mt-2" onClick={() => link.mutate()} disabled={link.isPending}>
              {t('settings.telegramConnect')}
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}
