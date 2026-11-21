import { useRef, useState, type DragEvent } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { parse, stringify } from 'yaml';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '../lib/api.ts';
import i18n from '../lib/i18n.ts';
import { CopyButton } from './Connect.tsx';

interface Template {
  id: string;
  title: string;
  description: string;
  example?: string;
  exampleFile: string;
}
interface Status {
  file: string;
  ok: boolean;
  error?: string;
  sourceId?: string;
  ports?: number[];
  updatedAt: string;
}

const OWN_EXAMPLE = `connector: moj-system
system: Nazwa systemu z Połączonych systemów
name: Mój system (własna konfiguracja)
collector:
  sources:
    in:
      type: socket          # dowolne źródło kolektora Vector z dozwolonej listy
      address: 0.0.0.0:5522
      mode: tcp
`;

/**
 * "Inny protokół" (#46): the person connects a source by dropping a file into config/connectors/.
 * This only shows the ready file; the API's connector sync does the rest.
 */
export function ConnectorTemplates({ systemName }: { systemName?: string }) {
  const { t: tx } = useTranslation();
  const q = useQuery({
    queryKey: ['connector-templates'],
    queryFn: () =>
      api<{ dir: string; connectorsDir: string; errors: string[]; data: Template[] }>(
        '/connectors/templates',
      ),
  });
  const [picked, setPicked] = useState<string>('');
  const list = q.data?.data ?? [];
  const current = list.find((t) => t.id === picked);
  const raw = current ? current.exampleFile : picked === 'own' ? OWN_EXAMPLE : '';
  const file = systemName ? raw.replace('Nazwa systemu z Połączonych systemów', systemName) : raw;
  const dir = q.data?.connectorsDir ?? 'config/connectors';

  return (
    <div className="space-y-4">
      <p className="max-w-[64ch] text-sm">
        {tx('connectors.intro1')}
        <code className="font-semibold">{dir}/</code>
        {tx('connectors.intro2')}
      </p>
      <div role="radiogroup" aria-label={tx('connectors.template')} className="grid gap-2 sm:grid-cols-2">
        {[
          ...list.map((t) => ({ id: t.id, title: t.title, description: t.description })),
          {
            id: 'own',
            title: tx('connectors.ownTitle'),
            description: tx('connectors.ownDesc'),
          },
        ].map((t) => (
          <label
            key={t.id}
            className={`cursor-pointer rounded-control border p-3 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-margin ${picked === t.id ? 'border-ink bg-sheet' : 'border-rule hover:border-ink-soft'}`}
          >
            <input
              type="radio"
              name="template"
              checked={picked === t.id}
              onChange={() => setPicked(t.id)}
              className="sr-only"
            />
            <span className="font-semibold">{t.title}</span>
            <span className="mt-0.5 block text-sm text-ink-soft">{t.description}</span>
          </label>
        ))}
      </div>
      {q.isError && <p className="text-sm text-critical">{tx('connectors.loadError')}</p>}

      {file && (
        <section aria-labelledby="file" className="rounded-panel border border-rule bg-sheet p-4">
          <div className="mb-1 flex items-center justify-between gap-2">
            <h3 id="file" className="font-semibold">
              {tx('connectors.saveAs')}{' '}
              <code>
                {dir}/{picked === 'own' ? 'moj-system' : `moj-${picked.replace(/_/g, '-')}`}.yaml
              </code>
            </h3>
            <CopyButton text={file} />
          </div>
          <pre className="overflow-x-auto rounded-control border border-rule bg-paper p-3 text-xs leading-relaxed">
            {file}
          </pre>
          <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm">
            <li>
              {tx('connectors.step1a')}
              <code>system</code>
              {tx('connectors.step1b')}
              <code>connector</code>
              {tx('connectors.step1c')}
            </li>
            <li>{tx('connectors.step2', { dir, var: '${NAZWA}' })}</li>
            {current?.example ? (
              <li>
                {tx('connectors.step3')}
                <code className="break-all">{current.example}</code>
              </li>
            ) : (
              <li>{tx('connectors.step3own')}</li>
            )}
            <li>{tx('connectors.step4')}</li>
          </ol>
        </section>
      )}
    </div>
  );
}

/** State of every connector file: what works, and what is wrong in which file. */
export function ConnectorFiles() {
  const { t } = useTranslation();
  const q = useQuery({
    queryKey: ['connectors'],
    queryFn: () => api<{ enabled: boolean; data: Status[] }>('/connectors'),
    refetchInterval: 10_000,
  });
  const rows = q.data?.data ?? [];
  if (rows.length === 0) return null;
  return (
    <section aria-labelledby="connector-files" className="rounded-panel border border-rule bg-sheet">
      <h2 id="connector-files" className="border-b-2 border-rule px-4 py-3 text-lg font-bold">
        {t('connectors.filesTitle')}
      </h2>
      <ul>
        {rows.map((r) => (
          <li
            key={r.file}
            className="flex flex-wrap items-baseline justify-between gap-2 border-b border-rule/70 px-4 py-2.5 text-sm last:border-b-0"
          >
            <span>
              <code className="font-semibold">config/connectors/{r.file}</code>
              {r.ok && r.ports && r.ports.length > 0 && (
                <span className="text-ink-soft"> (port {r.ports.join(', ')})</span>
              )}
            </span>
            {r.ok ? (
              r.sourceId ? (
                <Link to="/sources/$sourceId" params={{ sourceId: r.sourceId }} className="hover:underline">
                  {t('connectors.works')}
                </Link>
              ) : (
                <span>{t('connectors.works')}</span>
              )
            ) : (
              <span className="basis-full text-critical">
                {t('connectors.fileError', { error: r.error })}
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The file is dropped inside one system (its "Połącz"): a file without `system` gets that system, a file
 * for another system is refused before anything is saved.
 */
function forSystem(
  text: string,
  systemName: string,
): { ok: true; text: string } | { ok: false; error: string } {
  let doc: unknown;
  try {
    doc = parse(text);
  } catch {
    return { ok: true, text }; // the API reports the YAML error with its line
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { ok: true, text };
  const system = (doc as { system?: unknown }).system;
  if (system === undefined || system === null || system === '')
    return { ok: true, text: stringify({ ...doc, system: systemName }) };
  if (String(system).trim().toLowerCase() !== systemName.trim().toLowerCase())
    return {
      ok: false,
      error: i18n.t('connectors.wrongSystem', { fileSystem: String(system), system: systemName }),
    };
  return { ok: true, text };
}

interface DropResult {
  name: string;
  ok: boolean;
  text: string;
  sourceId?: string;
}

/**
 * Drop one or more connector files (.yaml) on the screen, or pick them from disk. Each file is checked
 * by the API and saved to config/connectors/ only when it is valid (#46).
 */
export function ConnectorDrop({ systemName }: { systemName: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<DropResult[]>([]);

  const send = async (files: File[]) => {
    const yaml = files.filter((f) => /\.ya?ml$/i.test(f.name));
    const skipped = files.filter((f) => !yaml.includes(f));
    setBusy(true);
    const out: DropResult[] = skipped.map((f) => ({
      name: f.name,
      ok: false,
      text: t('connectors.notYaml'),
    }));
    for (const f of yaml) {
      if (f.size > 64_000) {
        out.push({ name: f.name, ok: false, text: t('connectors.tooBig') });
        continue;
      }
      try {
        const content = forSystem(await f.text(), systemName);
        if (!content.ok) {
          out.push({ name: f.name, ok: false, text: content.error });
          continue;
        }
        const st = await api<Status>('/connectors', { method: 'POST', body: { content: content.text } });
        out.push({
          name: f.name,
          ok: true,
          sourceId: st.sourceId,
          text: t('connectors.added', {
            file: st.file,
            ports: st.ports?.length ? t('connectors.addedPorts', { ports: st.ports.join(', ') }) : '',
          }),
        });
      } catch (err) {
        out.push({
          name: f.name,
          ok: false,
          text: err instanceof ApiError ? err.message : t('connectors.sendFailed'),
        });
      }
    }
    setResults(out);
    setBusy(false);
    await Promise.all(
      ['sources', 'connectors', 'schemas'].map((k) => qc.invalidateQueries({ queryKey: [k] })),
    );
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    void send([...e.dataTransfer.files]);
  };

  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        aria-describedby="drop-hint"
        onClick={() => input.current?.click()}
        onKeyDown={(e) =>
          (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), input.current?.click())
        }
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        className={`flex cursor-pointer flex-col items-center justify-center rounded-panel border-2 border-dashed px-6 py-8 text-center transition-colors ${
          over ? 'border-ink bg-sheet' : 'border-rule hover:border-ink-soft'
        }`}
      >
        <span className="font-semibold">
          {busy ? t('connectors.checking') : over ? t('connectors.dropNow') : t('connectors.dragHere')}
        </span>
        <span id="drop-hint" className="mt-1 text-sm text-ink-soft">
          {t('connectors.dropHint')}
        </span>
        <input
          ref={input}
          type="file"
          accept=".yaml,.yml"
          multiple
          className="sr-only"
          tabIndex={-1}
          onChange={(e) => {
            void send([...(e.target.files ?? [])]);
            e.target.value = '';
          }}
        />
      </div>
      {results.length > 0 && (
        <ul aria-live="polite" className="mt-3 space-y-1 text-sm">
          {results.map((r) => (
            <li key={r.name} className={r.ok ? '' : 'text-critical'}>
              <span className="font-semibold">{r.name}</span>: {r.ok ? '' : t('connectors.notAdded')}
              {r.text}{' '}
              {r.ok && r.sourceId && (
                <Link to="/sources/$sourceId" params={{ sourceId: r.sourceId }} className="underline">
                  {t('connectors.seeConnection')}
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
