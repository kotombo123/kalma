import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Connect } from '../lib/types.ts';
import { Button } from './ui.tsx';

export function CopyButton({ text, label }: { text: string; label?: string }) {
  const { t } = useTranslation();
  const [done, setDone] = useState(false);
  return (
    <Button
      type="button"
      variant="quiet"
      onClick={() =>
        void navigator.clipboard.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        })
      }
    >
      {done ? t('connect2.copied') : (label ?? t('connect2.copy'))}
    </Button>
  );
}

function Row({ label, value, copy = true }: { label: string; value: string; copy?: boolean }) {
  return (
    <div className="grid grid-cols-[9rem_1fr_auto] items-center gap-3 border-b border-rule/70 py-2 last:border-b-0">
      <dt className="text-sm text-ink-soft">{label}</dt>
      <dd className="min-w-0 truncate font-semibold">{value}</dd>
      {copy ? <CopyButton text={value} /> : <span />}
    </div>
  );
}

/** How to point a system at this source. With `apiKey` (only right after create/rotate) it is complete. */
export function ConnectInfo({ connect, apiKey }: { connect: Connect; apiKey?: string }) {
  const { t } = useTranslation();
  const [test, setTest] = useState<string | null>(null);

  const sendTest = async () => {
    if (connect.transport !== 'http' || !apiKey) return;
    setTest(t('connect2.sending'));
    const res = await fetch(new URL(connect.url).pathname, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({
        message: t('connect2.testMessage'),
        severity: 'info',
        timestamp: new Date().toISOString(),
      }),
    }).catch(() => null);
    setTest(
      res?.ok
        ? t('connect2.testOk')
        : t('connect2.testFail', { reason: res?.status ?? t('connect2.noIngest') }),
    );
  };

  return (
    <div>
      <dl>
        {connect.transport === 'http' && (
          <>
            <Row label={t('connect2.address')} value={connect.url} />
            <Row
              label={t('connect2.header')}
              value={`X-Api-Key: ${apiKey ?? t('connect2.yourKey')}`}
              copy={Boolean(apiKey)}
            />
            <Row label={t('connect2.formats')} value={connect.formats} copy={false} />
          </>
        )}
        {connect.transport === 'kafka' && (
          <>
            <Row label={t('connect2.brokers')} value={connect.brokers} />
            <Row label={t('connect2.topic')} value={connect.topic} />
          </>
        )}
        {connect.transport === 'file' && <Row label={t('connect2.file')} value={connect.path} />}
        {connect.transport === 'poll' && (
          <>
            <Row label={t('connect2.addressPoll')} value={connect.url} />
            <Row label={t('connect2.every')} value={`${connect.intervalSec} s`} copy={false} />
          </>
        )}
      </dl>
      {'note' in connect && <p className="mt-3 max-w-[72ch] text-sm text-ink-soft">{connect.note}</p>}
      {(connect.transport === 'http' || connect.transport === 'kafka') && (
        <div className="mt-4">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-sm font-semibold">
              {connect.transport === 'http' ? t('connect2.curlExample') : t('connect2.rpkExample')}
            </span>
            <CopyButton
              text={(connect.transport === 'http' ? connect.curl : connect.example).replace(
                '<API_KEY>',
                apiKey ?? '<API_KEY>',
              )}
            />
          </div>
          <pre className="overflow-x-auto rounded-control border border-rule bg-paper p-3 text-xs leading-relaxed whitespace-pre-wrap">
            {(connect.transport === 'http' ? connect.curl : connect.example).replace(
              '<API_KEY>',
              apiKey ?? '<API_KEY>',
            )}
          </pre>
        </div>
      )}
      {connect.transport === 'http' && apiKey && (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button variant="primary" type="button" onClick={() => void sendTest()}>
            {t('connect2.sendTest')}
          </Button>
          {test && (
            <span role="status" className="text-sm">
              {test}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/** The API key is shown once — say so plainly. */
export function KeyOnce({ apiKey }: { apiKey: string }) {
  const { t } = useTranslation();
  return (
    <div className="rounded-control border-l-4 border-margin bg-paper p-4">
      <p className="font-semibold">{t('connect2.keyTitle')}</p>
      <p className="mt-0.5 text-sm text-ink-soft">{t('connect2.keyBody')}</p>
      <div className="mt-3 flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-control border border-rule bg-sheet px-3 py-1.5 text-sm">
          {apiKey}
        </code>
        <CopyButton text={apiKey} />
      </div>
    </div>
  );
}
