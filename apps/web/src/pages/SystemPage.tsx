import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/api.ts';

interface Status {
  services: { name: string; ok: boolean; detail: string }[];
  streams: {
    stream: string;
    length: number;
    groups: { name: string; consumers: number; pending: number; lag: number | null }[];
  }[];
  throughput: { ingestPerSec: number | null; eventsPerSec: number | null; deliveriesPerSec: number | null };
  links: { grafana: string; mailpit: string; redpandaConsole: string; apiDocs: string } | null;
}

/** i18n keys, translated at render. */
const STREAM_LABEL: Record<string, string> = {
  'stream:events': 'systemStatus.streamEvents',
  'stream:alerts': 'systemStatus.streamAlerts',
};

/** F-21: is everything running, how much is flowing, and where the tools are. */
export function SystemPage() {
  const { t } = useTranslation();
  const q = useQuery({
    queryKey: ['system'],
    queryFn: () => api<Status>('/system/status'),
    refetchInterval: 5000,
  });
  const s = q.data;
  const rate = (v: number | null | undefined) =>
    v === null || v === undefined ? t('systemStatus.noData') : `${v}/s`;
  return (
    <div className="px-6 py-5">
      <h1 className="text-2xl font-bold">{t('systemStatus.title')}</h1>
      <p className="mt-1 mb-5 max-w-[72ch] text-ink-soft">{t('systemStatus.subtitle')}</p>
      <div className="max-w-5xl">
        <div className="space-y-6">
          <section aria-labelledby="services" className="rounded-panel border border-rule bg-sheet">
            <h2 id="services" className="border-b border-rule px-4 py-3 text-base font-semibold">
              {t('systemStatus.services')}
            </h2>
            <ul>
              {s?.services.map((x) => (
                <li
                  key={x.name}
                  className="flex items-baseline justify-between gap-3 border-b border-rule/70 px-4 py-2 last:border-b-0"
                >
                  <span className="flex items-center gap-2 font-semibold">
                    <span
                      aria-hidden
                      className="size-2.5 rounded-full"
                      style={{ background: x.ok ? 'var(--info)' : 'var(--critical)' }}
                    />
                    {x.name}
                    <span className="sr-only">{x.ok ? t('systemStatus.up') : t('systemStatus.down')}</span>
                  </span>
                  <span className={`text-sm ${x.ok ? 'text-ink-soft' : 'text-critical'}`}>{x.detail}</span>
                </li>
              ))}
            </ul>
          </section>

          <section aria-labelledby="flow" className="rounded-panel border border-rule bg-sheet p-4">
            <h2 id="flow" className="text-base font-semibold">
              {t('systemStatus.throughput')}
            </h2>
            <dl className="mt-3 grid gap-4 sm:grid-cols-3">
              {(
                [
                  [t('systemStatus.ingested'), s?.throughput.ingestPerSec],
                  [t('systemStatus.processed'), s?.throughput.eventsPerSec],
                  [t('systemStatus.delivered'), s?.throughput.deliveriesPerSec],
                ] as const
              ).map(([label, v]) => (
                <div key={label}>
                  <dt className="text-sm text-ink-soft">{label}</dt>
                  <dd className="num text-xl font-semibold">{rate(v)}</dd>
                </div>
              ))}
            </dl>
          </section>

          <section aria-labelledby="queues" className="rounded-panel border border-rule bg-sheet">
            <h2 id="queues" className="border-b border-rule px-4 py-3 text-base font-semibold">
              {t('systemStatus.queues')}
            </h2>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-rule text-left text-xs text-ink-soft">
                  <th scope="col" className="px-4 py-2 font-semibold">
                    {t('systemStatus.queue')}
                  </th>
                  <th scope="col" className="border-l border-rule/70 px-3 py-2 text-right font-semibold">
                    {t('systemStatus.consumers')}
                  </th>
                  <th scope="col" className="border-l border-rule/70 px-3 py-2 text-right font-semibold">
                    {t('systemStatus.pending')}
                  </th>
                  <th scope="col" className="border-l border-rule/70 px-3 py-2 text-right font-semibold">
                    {t('systemStatus.lag')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {s?.streams.map((st) => {
                  const g = st.groups[0];
                  return (
                    <tr key={st.stream} className="border-b border-rule/70 last:border-b-0">
                      <td className="px-4 py-2">
                        {STREAM_LABEL[st.stream] ? t(STREAM_LABEL[st.stream]!) : st.stream}
                      </td>
                      <td className="num border-l border-rule/70 px-3 py-2 text-right">
                        {g?.consumers ?? 0}
                      </td>
                      <td className="num border-l border-rule/70 px-3 py-2 text-right">{g?.pending ?? 0}</td>
                      <td className="num border-l border-rule/70 px-3 py-2 text-right font-semibold">
                        {g?.lag ?? '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>

          {s?.links && (
            <section aria-labelledby="tools" className="rounded-panel border border-rule bg-sheet p-4">
              <h2 id="tools" className="text-base font-semibold">
                {t('systemStatus.tools')}
              </h2>
              <ul className="mt-2 grid gap-1 text-sm sm:grid-cols-2">
                {(
                  [
                    [t('systemStatus.grafana'), s.links.grafana],
                    [t('systemStatus.mailpit'), s.links.mailpit],
                    [t('systemStatus.redpanda'), s.links.redpandaConsole],
                    [t('systemStatus.apiDocs'), s.links.apiDocs],
                  ] as const
                ).map(([label, href]) => (
                  <li key={href}>
                    <a
                      href={href}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="font-semibold underline underline-offset-2"
                    >
                      {label}
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
