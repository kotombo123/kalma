import { useAuth } from './auth.tsx';
import i18n from './i18n.ts';
import type { Me } from './types.ts';

/**
 * Who is looking at the console. The UI is shaped per persona (apps/web/implementation_plan.md §3.6):
 * - admin: org admin, sees everything incl. connected systems and platform health
 * - lead: leads at least one team ("manager"), configures rules, instructions and on-call for it
 * - member: receives and handles alerts
 * The API enforces the same rules; this only decides what the screen offers.
 */
export type Persona = 'admin' | 'lead' | 'member';

export function personaOf(me: Me | undefined): Persona {
  if (!me) return 'member';
  if (me.role === 'admin') return 'admin';
  return me.teams.some((t) => t.role === 'lead') ? 'lead' : 'member';
}

/** Label maps that answer in the current UI language (read at access time). */
function localized(pl: Record<Persona, string>, en: Record<Persona, string>): Record<Persona, string> {
  return new Proxy(pl, { get: (target, key) => (i18n.language === 'pl' ? target : en)[key as Persona] });
}

export const PERSONA_LABEL = localized(
  { admin: 'Administrator', lead: 'Lider zespołu', member: 'Członek zespołu' },
  { admin: 'Administrator', lead: 'Team lead', member: 'Team member' },
);

export const PERSONA_HINT = localized(
  {
    admin: 'Możesz wszystko: systemy, reguły, instrukcje, zespoły i dyżury.',
    lead: 'Ustalasz reguły, instrukcje i dyżury swojego zespołu.',
    member: 'Dostajesz alerty swojego zespołu i je obsługujesz.',
  },
  {
    admin: 'You can do everything: systems, rules, runbooks, teams and on-call.',
    lead: "You set your team's rules, runbooks and on-call.",
    member: "You get your team's alerts and handle them.",
  },
);

export function usePersona() {
  const { me } = useAuth();
  const persona = personaOf(me);
  const leadTeams = (me?.teams ?? []).filter((t) => t.role === 'lead');
  return { me, persona, leadTeams, myTeams: me?.teams ?? [] };
}

/** Which personas may open a screen. Kept next to the nav so both stay in sync. */
export const ACCESS = {
  admin: ['admin'],
  config: ['admin', 'lead'],
  all: ['admin', 'lead', 'member'],
} satisfies Record<string, Persona[]>;
