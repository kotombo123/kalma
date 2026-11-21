import type { ComponentType } from 'react';
import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  redirect,
  useRouterState,
} from '@tanstack/react-router';
import { getToken } from './lib/api.ts';
import { useAuth } from './lib/auth.tsx';
import { useLive } from './lib/live.ts';
import { AppShell } from './components/AppShell.tsx';
import { AlertsPage } from './pages/AlertsPage.tsx';
import { AlertPage } from './pages/AlertPage.tsx';
import { LoginPage } from './pages/LoginPage.tsx';
import { InvitePage } from './pages/InvitePage.tsx';
import { RegisterPage } from './pages/RegisterPage.tsx';
import { Pending } from './pages/Pending.tsx';
import { GraphPage } from './pages/GraphPage.tsx';
import { SourcesPage } from './pages/SourcesPage.tsx';
import { NewSourcePage } from './pages/NewSourcePage.tsx';
import { SourcePage } from './pages/SourcePage.tsx';
import { TeamsPage } from './pages/TeamsPage.tsx';
import { TeamPage } from './pages/TeamPage.tsx';
import { SchemasPage } from './pages/SchemasPage.tsx';
import { SchemaPage } from './pages/SchemaPage.tsx';
import { RulesPage } from './pages/RulesPage.tsx';
import { RuleEditorPage } from './pages/RuleEditorPage.tsx';
import { RunbooksPage } from './pages/RunbooksPage.tsx';
import { RunbookEditorPage } from './pages/RunbookEditorPage.tsx';
import { SettingsPage } from './pages/SettingsPage.tsx';
import { OncallPage } from './pages/OncallPage.tsx';
import { SystemPage } from './pages/SystemPage.tsx';
import { ApprovePage } from './pages/ApprovePage.tsx';
import { useTranslation } from 'react-i18next';
import { NoAccess } from './components/ui.tsx';
import { usePersona, ACCESS, type Persona } from './lib/roles.ts';

/** Screens a role does not use show a short explanation instead (the API enforces the same rules). */
function gate(allow: readonly Persona[], Page: ComponentType, whatKey: string) {
  return function Gated() {
    const { persona } = usePersona();
    const { t } = useTranslation();
    return allow.includes(persona) ? <Page /> : <NoAccess what={t(whatKey)} />;
  };
}

function Root() {
  const { ready } = useAuth();
  const pending = useRouterState({ select: (s) => s.status === 'pending' });
  if (!ready || pending) return <p className="p-6 text-ink-soft">Wczytywanie…</p>;
  return <Outlet />;
}

function Shell() {
  const { me } = useAuth();
  const live = useLive(Boolean(me));
  return (
    <AppShell live={live}>
      <Outlet />
    </AppShell>
  );
}

const root = createRootRoute({ component: Root });
const login = createRoute({ getParentRoute: () => root, path: '/login', component: LoginPage });
const register = createRoute({ getParentRoute: () => root, path: '/register', component: RegisterPage });
// approval links from emails: public (the token is the credential)
const approve = createRoute({
  getParentRoute: () => root,
  path: '/approve/$token',
  component: () => <ApprovePage intent="approved" />,
});
const reject = createRoute({
  getParentRoute: () => root,
  path: '/reject/$token',
  component: () => <ApprovePage intent="rejected" />,
});
const invite = createRoute({ getParentRoute: () => root, path: '/invite/$token', component: InvitePage });
const app = createRoute({
  getParentRoute: () => root,
  id: 'app',
  component: Shell,
  beforeLoad: () => {
    if (!getToken()) throw redirect({ to: '/login' });
  },
});

const pages: [string, string, string][] = [];

const tree = root.addChildren([
  login,
  register,
  approve,
  reject,
  invite,
  app.addChildren([
    createRoute({ getParentRoute: () => app, path: '/', component: AlertsPage }),
    createRoute({ getParentRoute: () => app, path: '/alerts/$alertId', component: AlertPage }),
    // "Acknowledge" links in emails open the alert; the person confirms with the button (no action on GET)
    createRoute({
      getParentRoute: () => app,
      path: '/alerts/$alertId/ack',
      beforeLoad: ({ params }) => {
        throw redirect({ to: '/alerts/$alertId', params });
      },
    }),
    createRoute({
      getParentRoute: () => app,
      path: '/sources',
      component: gate(ACCESS.admin, SourcesPage, 'nav.connectedSystems'),
    }),
    createRoute({
      getParentRoute: () => app,
      path: '/sources/new',
      component: gate(ACCESS.admin, NewSourcePage, 'nav.connectedSystems'),
      validateSearch: (s: Record<string, unknown>) => ({
        systemId: typeof s.systemId === 'string' ? s.systemId : '',
      }),
    }),
    createRoute({
      getParentRoute: () => app,
      path: '/sources/$sourceId',
      component: gate(ACCESS.admin, SourcePage, 'nav.connectedSystems'),
    }),
    createRoute({ getParentRoute: () => app, path: '/teams', component: TeamsPage }),
    createRoute({
      getParentRoute: () => app,
      path: '/schemas',
      component: gate(ACCESS.admin, SchemasPage, 'nav.newMessageTypes'),
    }),
    createRoute({
      getParentRoute: () => app,
      path: '/rules',
      component: gate(ACCESS.config, RulesPage, 'nav.notificationRules'),
    }),
    createRoute({
      getParentRoute: () => app,
      path: '/runbooks',
      component: gate(ACCESS.config, RunbooksPage, 'Instrukcje'),
    }),
    createRoute({ getParentRoute: () => app, path: '/settings', component: SettingsPage }),
    createRoute({ getParentRoute: () => app, path: '/oncall', component: OncallPage }),
    createRoute({
      getParentRoute: () => app,
      path: '/system',
      component: gate(ACCESS.admin, SystemPage, 'Stan platformy'),
    }),
    createRoute({
      getParentRoute: () => app,
      path: '/runbooks/new',
      component: gate(ACCESS.config, RunbookEditorPage, 'Instrukcje'),
    }),
    createRoute({
      getParentRoute: () => app,
      path: '/runbooks/$runbookId',
      component: gate(ACCESS.config, RunbookEditorPage, 'Instrukcje'),
    }),
    createRoute({
      getParentRoute: () => app,
      path: '/rules/new',
      component: gate(ACCESS.config, RuleEditorPage, 'nav.notificationRules'),
      validateSearch: (s: Record<string, unknown>) => ({
        schemaId: typeof s.schemaId === 'string' ? s.schemaId : '',
      }),
    }),
    createRoute({
      getParentRoute: () => app,
      path: '/rules/$ruleId',
      component: gate(ACCESS.config, RuleEditorPage, 'nav.notificationRules'),
    }),
    createRoute({
      getParentRoute: () => app,
      path: '/schemas/$schemaId',
      component: gate(ACCESS.admin, SchemaPage, 'nav.newMessageTypes'),
    }),
    createRoute({ getParentRoute: () => app, path: '/teams/$teamId', component: TeamPage }),
    createRoute({
      getParentRoute: () => app,
      path: '/graph',
      component: gate(ACCESS.config, GraphPage, 'nav.loadAnalysis'),
    }),
    ...pages.map(([path, title, what]) =>
      createRoute({
        getParentRoute: () => app,
        path,
        component: () => <Pending title={title} what={what} />,
      }),
    ),
  ]),
]);

export const router = createRouter({ routeTree: tree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
