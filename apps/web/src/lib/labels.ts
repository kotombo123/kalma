/**
 * Plain-language names for things the system names technically (implementation_plan.md §6).
 * One place, so an action keeps one name across the whole UI.
 */
import i18n from './i18n.ts';

/** English UI: everything except an explicit Polish choice. Read at call time, never at module load. */
const en = () => i18n.language !== 'pl';

/** Runbook action types → what a person would call them. */
export const ACTION_LABEL: Record<string, string> = {
  http_get: 'Sprawdź, czy serwis odpowiada',
  http_post: 'Wyślij zapytanie do serwisu',
  retry_workflow: 'Ponów proces',
  restart_service: 'Uruchom ponownie serwis',
  escalate: 'Przekaż do innego zespołu',
  notify_team: 'Powiadom zespół',
  open_ticket: 'Załóż zgłoszenie',
};

/** Actions that wait for a person's approval before they run. */
export const RISKY_ACTIONS = new Set(['restart_service', 'escalate']);

const ACTION_LABEL_EN: Record<string, string> = {
  http_get: 'Check that the service responds',
  http_post: 'Send a request to the service',
  retry_workflow: 'Retry the process',
  restart_service: 'Restart the service',
  escalate: 'Hand over to another team',
  notify_team: 'Notify the team',
  open_ticket: 'Open a ticket',
};

export const actionLabel = (type: string) => (en() ? ACTION_LABEL_EN : ACTION_LABEL)[type] ?? type;

/** Parameter names shown under "Szczegóły". */
const PARAM_LABEL: Record<string, string> = {
  url: 'Adres',
  workflowId: 'Proces',
  team: 'Zespół',
  service: 'Serwis',
  message: 'Wiadomość',
  alertId: 'Alert',
  timeoutMs: 'Limit czasu (ms)',
};
const PARAM_LABEL_EN: Record<string, string> = {
  url: 'Address',
  workflowId: 'Process',
  team: 'Team',
  service: 'Service',
  message: 'Message',
  alertId: 'Alert',
  timeoutMs: 'Timeout (ms)',
};
export const paramLabel = (k: string) => (en() ? PARAM_LABEL_EN : PARAM_LABEL)[k] ?? k;

/** Last segments of event field paths → friendly names (demo data + common log fields). */
const FIELD_WORDS: Record<string, string> = {
  desk: 'Biurko',
  notional: 'Kwota',
  amount: 'Kwota',
  currency: 'Waluta',
  reason: 'Powód',
  instrument: 'Instrument',
  service: 'Serwis',
  workflowId: 'Proces',
  workflow: 'Proces',
  step: 'Krok',
  error: 'Błąd',
  message: 'Treść',
  msg: 'Treść',
  level: 'Poziom',
  lvl: 'Poziom',
  severity: 'Ważność',
  status: 'Status',
  host: 'Serwer',
  name: 'Nazwa',
  env: 'Środowisko',
  environment: 'Środowisko',
  alertname: 'Nazwa alertu',
  instance: 'Instancja',
  latencyMs: 'Opóźnienie (ms)',
  latency: 'Opóźnienie',
  counterparty: 'Kontrahent',
  tradeId: 'Transakcja',
  schema: 'Rodzaj wiadomości',
  type: 'Typ',
  timestamp: 'Czas',
  time: 'Czas',
  ts: 'Czas',
};

const FIELD_WORDS_EN: Record<string, string> = {
  desk: 'Desk',
  notional: 'Amount',
  amount: 'Amount',
  currency: 'Currency',
  reason: 'Reason',
  instrument: 'Instrument',
  service: 'Service',
  workflowId: 'Process',
  workflow: 'Process',
  step: 'Step',
  error: 'Error',
  message: 'Message',
  msg: 'Message',
  level: 'Level',
  lvl: 'Level',
  severity: 'Severity',
  status: 'Status',
  host: 'Server',
  name: 'Name',
  env: 'Environment',
  environment: 'Environment',
  alertname: 'Alert name',
  instance: 'Instance',
  latencyMs: 'Latency (ms)',
  latency: 'Latency',
  counterparty: 'Counterparty',
  tradeId: 'Trade',
  schema: 'Message type',
  type: 'Type',
  timestamp: 'Time',
  time: 'Time',
  ts: 'Time',
};

const NORMALIZED_LABEL_EN: Record<string, string> = {
  $severity: 'Severity',
  $title: 'Title',
  $status: 'Status',
  $entity: 'Affects',
  $source: 'Source',
  $schema: 'Message type',
};

const NORMALIZED_LABEL: Record<string, string> = {
  $severity: 'Ważność',
  $title: 'Tytuł',
  $status: 'Status',
  $entity: 'Czego dotyczy',
  $source: 'Źródło',
  $schema: 'Rodzaj wiadomości',
};

/** `payload.desk` → "Biurko", `labels.service_name` → "Service name". The path stays available as a hint. */
export function fieldLabel(path: string): string {
  const normalized = en() ? NORMALIZED_LABEL_EN : NORMALIZED_LABEL;
  const fieldWords = en() ? FIELD_WORDS_EN : FIELD_WORDS;
  if (normalized[path]) return normalized[path];
  const parts = path
    .replace(/\[\d*\]/g, '')
    .split('.')
    .filter(Boolean);
  const last = parts.at(-1) ?? path;
  if (fieldWords[last]) {
    // host.name → "Serwer", not "Nazwa"
    const parent = parts.at(-2);
    if (last === 'name' && parent && fieldWords[parent]) return fieldWords[parent];
    return fieldWords[last];
  }
  const words = last
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
