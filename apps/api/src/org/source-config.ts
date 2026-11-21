/**
 * Validation of admin-supplied source configuration (OWASP A10 SSRF, path traversal) and the
 * "how to connect" instructions shown in the UI.
 */
import { posix } from 'node:path';
import { z } from 'zod';
import { EventFormat, ParserOptions, SourceConfig, type Source } from '@alerting/contracts';

/** true when `path` is an absolute path inside `root` after normalization (no `..` escape). */
export function isInside(root: string, path: string): boolean {
  if (!posix.isAbsolute(path) || path.includes('\0')) return false;
  const base = posix.resolve(root);
  const p = posix.resolve(path);
  return p === base || p.startsWith(base.endsWith('/') ? base : `${base}/`);
}

const KafkaTopic = /^[a-zA-Z0-9._-]{1,249}$/;

/** `SourceConfig` plus security checks that depend on deployment settings. */
export function sourceConfigSchema(fileRoot: string) {
  return SourceConfig.superRefine((cfg, ctx) => {
    switch (cfg.transport) {
      case 'kafka':
        if (!KafkaTopic.test(cfg.topic))
          ctx.addIssue({ code: 'custom', path: ['topic'], message: 'Invalid topic name' });
        break;
      case 'file':
        if (!isInside(fileRoot, cfg.path)) {
          ctx.addIssue({
            code: 'custom',
            path: ['path'],
            message: `File must be an absolute path under ${fileRoot}`,
          });
        }
        if (cfg.recordStart !== undefined && !validRegex(cfg.recordStart)) {
          ctx.addIssue({ code: 'custom', path: ['recordStart'], message: 'Invalid regular expression' });
        }
        break;
      case 'poll': {
        const url = z.url({ protocol: /^https?$/ }).safeParse(cfg.url);
        if (!url.success) ctx.addIssue({ code: 'custom', path: ['url'], message: 'URL must be http(s)' });
        break;
      }
    }
  });
}

function validRegex(s: string): boolean {
  try {
    new RegExp(s);
    return true;
  } catch {
    return false;
  }
}

export const SourceParserOptions = ParserOptions.superRefine((o, ctx) => {
  if (o.regex !== undefined && !validRegex(o.regex)) {
    ctx.addIssue({ code: 'custom', path: ['regex'], message: 'Invalid regular expression' });
  }
});

export const SourceFormat = z.union([z.literal('auto'), EventFormat]);

export interface ConnectSettings {
  ingestPublicUrl: string;
  kafkaBrokers: string;
}

/** Per-transport instructions. `apiKey` is only known right after create / rotate; otherwise a placeholder. */
export function connectInfo(source: Pick<Source, 'id' | 'config'>, s: ConnectSettings, apiKey?: string) {
  const key = apiKey ?? '<API_KEY>';
  const cfg = source.config;
  switch (cfg.transport) {
    case 'http': {
      const url = `${s.ingestPublicUrl.replace(/\/$/, '')}/ingest/${source.id}`;
      return {
        transport: 'http' as const,
        url,
        method: 'POST',
        headers: { 'X-Api-Key': key },
        formats: 'JSON, NDJSON (batch), XML, CSV, logfmt or plain text; max 1 MB',
        curl: `curl -X POST '${url}' -H 'X-Api-Key: ${key}' -H 'Content-Type: application/json' -d '{"message":"test","severity":"warning"}'`,
      };
    }
    case 'kafka':
      return {
        transport: 'kafka' as const,
        brokers: s.kafkaBrokers,
        topic: cfg.topic,
        example: `echo '{"message":"test","severity":"warning"}' | rpk topic produce ${cfg.topic} --brokers ${s.kafkaBrokers}`,
      };
    case 'file':
      return {
        transport: 'file' as const,
        path: cfg.path,
        note: 'The ingest service tails this file (rotation-safe). Mount it into the ingest container at the same path.',
      };
    case 'poll':
      return {
        transport: 'poll' as const,
        url: cfg.url,
        intervalSec: cfg.intervalSec,
        itemsPath: cfg.itemsPath ?? null,
        note: 'The ingest service calls this URL on the interval; items are de-duplicated by idPath.',
      };
  }
}
