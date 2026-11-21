import { describe, expect, it } from 'vitest';
import { buildCollector, fill, portRange, resolveSettings } from '../src/connectors/build.ts';

const base = {
  connector: 'fw',
  allowedSources: new Set(['syslog', 'socket']),
  portOk: portRange('5514-5530'),
  ingestUrl: 'http://localhost:3001/',
  sourceId: 'SRC',
  apiKey: 'ak_x',
};

describe('connector build', () => {
  it('prefixes components and adds the delivery to ingest', () => {
    const b = buildCollector(
      { sources: { in: { type: 'syslog', address: '0.0.0.0:5514', mode: 'udp' } } },
      base,
    );
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    expect(b.ports).toEqual([5514]);
    expect(Object.keys(b.config.sources as object)).toEqual(['fw__in']);
    const sink = (b.config.sinks as Record<string, Record<string, unknown>>).fw__kalma!;
    expect(sink.inputs).toEqual(['fw__in']);
    expect(sink.uri).toBe('http://localhost:3001/ingest/SRC');
    expect(sink.request).toEqual({ headers: { 'x-api-key': 'ak_x' } });
  });

  it('sends what transforms produce, not the raw source they read', () => {
    const b = buildCollector(
      {
        sources: { in: { type: 'socket', address: '0.0.0.0:5520', mode: 'tcp' } },
        transforms: { only: { type: 'filter', inputs: ['in'], condition: 'true' } },
      },
      base,
    );
    expect(b.ok && (b.config.sinks as Record<string, { inputs: string[] }>).fw__kalma!.inputs).toEqual([
      'fw__only',
    ]);
    expect(b.ok && (b.config.transforms as Record<string, { inputs: string[] }>).fw__only!.inputs).toEqual([
      'fw__in',
    ]);
  });

  it('refuses sources that run commands or are not allowed, ports out of range and unknown inputs', () => {
    const exec = buildCollector(
      { sources: { x: { type: 'exec', command: ['sh'] } } },
      {
        ...base,
        allowedSources: new Set(['exec']),
      },
    );
    expect(exec).toMatchObject({ ok: false, error: expect.stringContaining('"exec" jest niedozwolony') });
    expect(buildCollector({ sources: { x: { type: 'kafka' } } }, base)).toMatchObject({ ok: false });
    expect(
      buildCollector({ sources: { x: { type: 'syslog', address: '0.0.0.0:22', mode: 'tcp' } } }, base),
    ).toMatchObject({ ok: false, error: expect.stringContaining('port 22') });
    expect(
      buildCollector(
        {
          sources: { in: { type: 'syslog', address: '0.0.0.0:5514' } },
          transforms: { t: { type: 'filter', inputs: ['nope'] } },
        },
        base,
      ),
    ).toMatchObject({ ok: false, error: expect.stringContaining('nieznany komponent "nope"') });
    expect(
      buildCollector(
        { sources: { in: { type: 'syslog', address: '0.0.0.0:5514' } }, transforms: { t: { type: 'lua' } } },
        base,
      ),
    ).toMatchObject({ ok: false });
  });

  it('fills template settings by value, keeping numbers as numbers', () => {
    const tpl = {
      id: 'syslog',
      title: 'Syslog',
      description: '',
      settings: {
        port: { type: 'port' as const, label: 'Port', default: 5514 },
        mode: { type: 'enum' as const, label: 'Mode', values: ['udp', 'tcp'], default: 'udp' },
      },
    };
    const s = resolveSettings(tpl, { port: 5515 }, base.portOk);
    expect(s).toEqual({ ok: true, values: { port: 5515, mode: 'udp' } });
    expect(fill({ a: '0.0.0.0:{{port}}', p: '{{port}}', m: ['{{mode}}'] }, s.ok ? s.values : {})).toEqual({
      a: '0.0.0.0:5515',
      p: 5515,
      m: ['udp'],
    });
    expect(resolveSettings(tpl, { port: 80 }, base.portOk)).toMatchObject({ ok: false });
    expect(resolveSettings(tpl, { mode: 'http' }, base.portOk)).toMatchObject({ ok: false });
    expect(resolveSettings(tpl, { extra: 1 }, base.portOk)).toMatchObject({ ok: false });
  });
});
