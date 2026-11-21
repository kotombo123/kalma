import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/api.ts';
import { useAuth } from '../lib/auth.tsx';
import { useTheme } from '../lib/theme.ts';
import { PERSONA_HINT, PERSONA_LABEL, usePersona, type Persona } from '../lib/roles.ts';
import { toggleLang } from '../lib/i18n.ts';
import type { LiveStatus } from '../lib/live.ts';
import type { Page } from '../lib/types.ts';

interface NavItem {
  to: string;
  label: string;
  params?: Record<string, string>;
  badge?: number;
}
interface NavGroup {
  label?: string;
  items: NavItem[];
}

function navFor(
  persona: Persona,
  leadTeams: { id: string; name: string }[],
  myTeams: { id: string }[],
  newSchemas: number,
  t: (key: string) => string,
): NavGroup[] {
  const myTeam: NavItem =
    myTeams.length === 1
      ? { to: '/teams/$teamId', params: { teamId: myTeams[0]!.id }, label: t('nav.myTeam') }
      : { to: '/teams', label: t('nav.myTeams') };
  if (persona === 'member') {
    return [{ items: [{ to: '/', label: t('nav.alerts') }, { to: '/oncall', label: t('nav.oncall') }, myTeam] }];
  }
  if (persona === 'lead') {
    const team: NavItem =
      leadTeams.length === 1
        ? { to: '/teams/$teamId', params: { teamId: leadTeams[0]!.id }, label: t('nav.myTeam') }
        : { to: '/teams', label: t('nav.myTeams') };
    return [
      { items: [{ to: '/', label: t('nav.alerts') }, { to: '/oncall', label: t('nav.oncall') }, team] },
      {
        label: t('nav.teamConfig'),
        items: [
          { to: '/rules', label: t('nav.notificationRules') },
          { to: '/runbooks', label: t('nav.runbooks') },
        ],
      },
      { items: [{ to: '/graph', label: t('nav.loadAnalysis') }] },
    ];
  }
  return [
    {
      items: [
        { to: '/', label: t('nav.alerts') },
        { to: '/oncall', label: t('nav.oncall') },
        { to: '/teams', label: t('nav.peopleAndTeams') },
      ],
    },
    {
      label: t('nav.configuration'),
      items: [
        { to: '/sources', label: t('nav.connectedSystems') },
        { to: '/schemas', label: t('nav.newMessageTypes'), badge: newSchemas },
        { to: '/rules', label: t('nav.notificationRules') },
        { to: '/runbooks', label: t('nav.runbooks') },
      ],
    },
    { items: [{ to: '/graph', label: t('nav.loadAnalysis') }] },
  ];
}

const linkCls =
  'flex items-center justify-between rounded-control px-3 py-2 text-sm text-ink-soft hover:bg-rule/40 hover:text-ink [&.active]:bg-rule/60 [&.active]:font-semibold [&.active]:text-ink';

function UserMenu({ persona }: { persona: Persona }) {
  const { t, i18n } = useTranslation();
  const { me, logout } = useAuth();
  const { theme, toggle } = useTheme();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node))
        setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);

  const personaLabel = { admin: t('persona.admin'), lead: t('persona.lead'), member: t('persona.member') }[persona];
  const personaHint = { admin: t('persona.adminHint'), lead: t('persona.leadHint'), member: t('persona.memberHint') }[persona];
  // keep Polish fallback labels for cases where PERSONA_LABEL/HINT are used directly elsewhere
  void PERSONA_LABEL;
  void PERSONA_HINT;

  const item = 'block w-full rounded-control px-3 py-1.5 text-left text-sm hover:bg-rule/40';
  return (
    <div ref={ref} className="relative">
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((o) => !o)}
        className="flex items-baseline gap-2 rounded-control px-2 py-1 text-sm hover:bg-rule/40"
      >
        <span className="font-semibold">{me?.user.name}</span>
        <span className="text-ink-soft">{personaLabel}</span>
        <span aria-hidden className="text-ink-soft">
          ▾
        </span>
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 z-20 mt-1 w-72 rounded-panel border border-rule bg-sheet p-1.5 shadow-lg"
        >
          <p className="px-3 pt-1.5 pb-2 text-xs text-ink-soft">{personaHint}</p>
          <Link role="menuitem" to="/settings" className={item} onClick={() => setOpen(false)}>
            {t('user.myNotifications')}
          </Link>
          {persona === 'admin' && (
            <Link role="menuitem" to="/system" className={item} onClick={() => setOpen(false)}>
              {t('user.platformStatus')}
            </Link>
          )}
          <button role="menuitem" className={item} onClick={toggle}>
            {theme === 'dark' ? t('user.lightTheme') : t('user.darkTheme')}
          </button>
          <button role="menuitem" className={item} onClick={() => { toggleLang(); setOpen(false); }}>
            {t('lang.toggle')}
          </button>
          <div className="my-1 border-t border-rule" />
          <button role="menuitem" className={item} onClick={() => void logout()}>
            {t('user.logout')}
          </button>
        </div>
      )}
      <span className="sr-only">{i18n.language}</span>
    </div>
  );
}

export function AppShell({ live, children }: { live: LiveStatus; children: ReactNode }) {
  const { t } = useTranslation();
  const { me, persona, leadTeams, myTeams } = usePersona();
  const newSchemas = useQuery({
    queryKey: ['schemas', 'new-count'],
    queryFn: () => api<Page<{ id: string }>>('/schemas?status=new&limit=100'),
    enabled: persona === 'admin',
  });
  const groups = navFor(persona, leadTeams, myTeams, newSchemas.data?.data.length ?? 0, t);

  const liveLabel: Record<LiveStatus, string> = {
    live: t('live.live'),
    connecting: t('live.connecting'),
    reconnecting: t('live.reconnecting'),
    offline: t('live.offline'),
  };
  const liveColor: Record<LiveStatus, string> = {
    live: 'var(--info)',
    connecting: 'var(--ink-soft)',
    reconnecting: 'var(--warning)',
    offline: 'var(--critical)',
  };

  const renderLink = (n: NavItem, compact = false) => (
    <Link
      key={n.to + (n.params?.teamId ?? '')}
      to={n.to}
      params={n.params}
      activeOptions={{ exact: n.to === '/' }}
      className={compact ? `shrink-0 ${linkCls}` : linkCls}
    >
      {n.label}
      {n.badge ? (
        <span className="num ml-2 rounded-full bg-margin px-1.5 text-xs font-semibold text-sheet">
          {n.badge}
          <span className="sr-only"> {t('nav.newBadge')}</span>
        </span>
      ) : null}
    </Link>
  );

  return (
    <div className="flex h-full">
      <nav
        aria-label={t('nav.mainNav')}
        className="hidden w-56 shrink-0 flex-col border-r border-rule bg-sheet md:flex"
      >
        <div className="flex-1 space-y-4 px-2 pt-3">
          {groups.map((g, i) => (
            <div key={i}>
              {g.label && <div className="px-3 pb-1 text-xs text-ink-soft">{g.label}</div>}
              <ul className="space-y-0.5">
                {g.items.map((n) => (
                  <li key={n.to + (n.params?.teamId ?? '')}>{renderLink(n)}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </nav>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-3 border-b border-rule bg-sheet px-4">
          <span
            aria-hidden
            className="inline-flex size-6 shrink-0 items-center justify-center rounded bg-margin text-xs font-bold text-sheet"
          >
            {(me?.org?.name ?? 'K').charAt(0).toUpperCase()}
          </span>
          <span className="text-sm font-semibold leading-none">{me?.org?.name ?? 'Kalma'}</span>
          <div className="flex-1" />
          <span className="flex items-center gap-1.5 text-sm" role="status" aria-live="polite">
            <span aria-hidden className="size-2 rounded-full" style={{ background: liveColor[live] }} />
            {liveLabel[live]}
          </span>
          <UserMenu persona={persona} />
        </header>
        <nav
          aria-label={t('nav.mobileNav')}
          className="flex gap-1 overflow-x-auto border-b border-rule bg-sheet px-2 py-1.5 md:hidden"
        >
          {groups.flatMap((g) => g.items).map((n) => renderLink(n, true))}
        </nav>
        <main className="min-h-0 flex-1 overflow-auto">{children}</main>
      </div>
    </div>
  );
}
