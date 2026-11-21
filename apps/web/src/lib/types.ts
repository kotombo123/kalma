import type { Alert, Severity, UiEvent } from '@alerting/contracts';
import i18n from './i18n.ts';

export type { Alert, Severity, UiEvent };

export interface Me {
  user: { id: string; email: string; name: string; timezone: string };
  org: { id: string; name: string; role: 'admin' | 'member' } | null;
  role: 'admin' | 'member';
  orgs: { id: string; name: string; role: string }[];
  teams: { id: string; name: string; role: 'lead' | 'member' }[];
}

export interface Page<T> {
  data: T[];
  nextCursor: string | null;
}

export const SEVERITY_LABEL: Record<Severity, string> = {
  critical: 'Krytyczny',
  error: 'Błąd',
  warning: 'Ostrzeżenie',
  info: 'Informacja',
};

export const STATUS_LABEL: Record<Alert['status'], string> = {
  open: 'Otwarty',
  acknowledged: 'Potwierdzony',
  resolved: 'Rozwiązany',
};

export type Transport = 'http' | 'kafka' | 'file' | 'poll';

export interface Source {
  id: string;
  systemId: string;
  name: string;
  transport: Transport;
  config: Record<string, unknown> & { transport: Transport };
  format: string;
  parserOptions: { regex?: string; grokPattern?: string; csvHeaders?: string[] } | null;
  enabled: boolean;
  apiKeyPrefix: string;
  /** 'file' = managed by a connector file in config/connectors/ (#46) */
  origin?: 'ui' | 'api' | 'file';
  filePath?: string | null;
  fileError?: string | null;
  createdAt: string;
  eventCount: number;
  lastEventAt: string | null;
}

export type Connect =
  | {
      transport: 'http';
      url: string;
      method: string;
      headers: Record<string, string>;
      formats: string;
      curl: string;
    }
  | { transport: 'kafka'; brokers: string; topic: string; example: string }
  | { transport: 'file'; path: string; note: string }
  | { transport: 'poll'; url: string; intervalSec: number; itemsPath: string | null; note: string };

export interface System {
  id: string;
  name: string;
  description: string | null;
  sourceCount: number;
}

export const TRANSPORT_LABEL: Record<Transport, string> = {
  http: 'Adres internetowy (webhook)',
  kafka: 'Kolejka Kafka',
  file: 'Plik logów',
  poll: 'Lista incydentów pod adresem',
};

export const FORMAT_LABEL: Record<string, string> = {
  auto: 'Wykryj automatycznie',
  json: 'JSON / NDJSON',
  xml: 'XML',
  logfmt: 'logfmt',
  csv: 'CSV',
  regex: 'Regex / grok',
  text: 'Tekst',
};

export interface TeamSummary {
  id: string;
  name: string;
  memberCount: number;
}

export interface TeamDetail {
  id: string;
  name: string;
  teamsWebhookUrl: string | null;
  teamsWebhookConfigured: boolean;
  members: { id: string; name: string; email: string; role: 'lead' | 'member' }[];
}

export interface OrgMember {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'member';
}

export interface PendingInvite {
  id: string;
  email: string;
  role: 'admin' | 'member';
  teamId: string | null;
  teamRole: 'lead' | 'member' | null;
  expiresAt: string;
}

export const ORG_ROLE_LABEL = { admin: 'Administrator', member: 'Członek' } as const;
export const TEAM_ROLE_LABEL = { lead: 'Lider', member: 'Członek' } as const;

export type FieldRole = 'severity' | 'timestamp' | 'title' | 'dedupKey' | 'status' | 'entity' | 'message';
export type RoleBinding = { path?: string; template?: string };
export interface MappingDraft {
  roles: Partial<Record<FieldRole, RoleBinding>>;
  severityMap?: Record<string, Alert['severity']>;
  resolvedValues?: string[];
  presetId?: string;
}

export interface SchemaInfo {
  id: string;
  name: string | null;
  status: 'new' | 'mapped' | 'ignored';
  fingerprint: string;
  sourceId: string;
  sourceName: string;
  eventCount: number;
  unmatchedCount: number;
  firstSeen: string;
  lastSeen: string;
  sample: unknown;
  fields: { path: string; type: string; example: unknown }[];
  guessedRoles: Partial<Record<FieldRole, { path: string; confidence: number }>>;
  mappingId: string | null;
  preset: { id: string; name: string; mapping: MappingDraft } | null;
  presetAlternatives: { id: string; name: string }[];
}

export interface Normalized {
  severity: Alert['severity'];
  timestamp: string;
  title?: string;
  message?: string;
  dedupKey: string;
  status: 'firing' | 'resolved';
  entity?: string;
  flat: Record<string, unknown>;
}

export const ROLE_LABEL: Record<FieldRole, string> = {
  title: 'Tytuł',
  severity: 'Ważność',
  timestamp: 'Czas',
  status: 'Status (firing / resolved)',
  entity: 'Czego dotyczy',
  dedupKey: 'Klucz duplikatów',
  message: 'Opis',
};
export const ROLES: FieldRole[] = [
  'title',
  'severity',
  'timestamp',
  'status',
  'entity',
  'dedupKey',
  'message',
];

/**
 * Translated labels (current UI language). The *_LABEL constants above are the Polish originals,
 * kept for existing importers; prefer these helpers (call them at render time).
 */
export const severityLabel = (s: Severity) => i18n.t(`severity.${s}`);
export const statusLabel = (s: Alert['status']) => i18n.t(`status.${s}`);
export const fieldRoleLabel = (r: FieldRole) => i18n.t(`fieldRole.${r}`);
export const orgRoleLabel = (r: keyof typeof ORG_ROLE_LABEL) => i18n.t(`orgRole.${r}`);
export const teamRoleLabel = (r: keyof typeof TEAM_ROLE_LABEL) => i18n.t(`teamRole.${r}`);
