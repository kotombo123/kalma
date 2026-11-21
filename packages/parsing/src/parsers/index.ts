import { parse as parseCsvSync } from 'csv-parse/sync';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import type { ParserOptions } from '../types.ts';
import { compileGrok, compileRegex } from './grok.ts';

/** Every parser returns the records it found or throws; parse() turns throws into fallbacks. */
export type Parser = (body: string, opts: ParserOptions) => unknown[];

const lines = (body: string) => body.split(/\r?\n/).filter((l) => l.trim() !== '');

/** JSON object, JSON array (batch) or NDJSON (batch). */
export const parseJson: Parser = (body) => {
  try {
    const value: unknown = JSON.parse(body);
    return Array.isArray(value) ? value : [value];
  } catch (err) {
    const ls = lines(body);
    if (ls.length < 2) throw err;
    return ls.map((l) => JSON.parse(l) as unknown);
  }
};

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  parseTagValue: false, // leave typing to normalization in packages/schema
  trimValues: true,
});

export const parseXml: Parser = (body) => {
  const valid = XMLValidator.validate(body);
  if (valid !== true) throw new Error(`xml: ${valid.err.msg}`);
  return [xml.parse(body) as unknown];
};

const LOGFMT_PAIR = /([\w.@-]+)(?:=("(?:[^"\\]|\\.)*"|\S*))?/g;

export function parseLogfmtLine(line: string): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const [, key, raw] of line.matchAll(LOGFMT_PAIR)) {
    if (raw === undefined) out[key!] = true;
    else out[key!] = raw.startsWith('"') ? (JSON.parse(raw) as string) : raw;
  }
  return out;
}

export const parseLogfmt: Parser = (body) => lines(body).map(parseLogfmtLine);

export const parseCsv: Parser = (body, opts) =>
  parseCsvSync(body, {
    columns: opts.csvHeaders ?? true,
    skip_empty_lines: true,
    trim: true,
  }) as unknown[];

/** Regex with named groups, or a grok pattern; applied per line. Non-matching lines throw. */
export const parseRegex: Parser = (body, opts) => {
  if (opts.grokPattern) {
    const { re, fields } = compileGrok(opts.grokPattern);
    return lines(body).map((line) => {
      const m = re.exec(line);
      if (!m?.groups) throw new Error(`grok: no match for line "${line.slice(0, 80)}"`);
      const out: Record<string, string> = {};
      for (const [group, value] of Object.entries(m.groups)) {
        if (value !== undefined) out[fields.get(group)!] = value;
      }
      return out;
    });
  }
  if (!opts.regex) throw new Error('regex: no regex or grokPattern in parserOptions');
  const re = compileRegex(opts.regex);
  return lines(body).map((line) => {
    const m = re.exec(line);
    if (!m) throw new Error(`regex: no match for line "${line.slice(0, 80)}"`);
    return { ...(m.groups ?? {}) };
  });
};

export const parseText: Parser = (body) => lines(body).map((message) => ({ message }));
