import type { EventFormat, ParseInput } from './types.ts';

const CONTENT_TYPES: [RegExp, EventFormat][] = [
  [/json/i, 'json'], // application/json, application/x-ndjson, application/cloudevents+json
  [/xml/i, 'xml'],
  [/csv/i, 'csv'],
  [/logfmt/i, 'logfmt'],
];

// key=value pairs, quoted values and bare keys (`retry`); needs at least one `=` to count.
const LOGFMT_TOKEN = String.raw`[\w.@-]+(?:=(?:"(?:[^"\\]|\\.)*"|\S*))?`;
const LOGFMT_LINE = new RegExp(`^${LOGFMT_TOKEN}(?:\\s+${LOGFMT_TOKEN})*$`);
const isLogfmt = (line: string) => line.includes('=') && LOGFMT_LINE.test(line);

/** Format precedence: source config → Content-Type → sniffing the body. */
export function detectFormat(input: ParseInput): EventFormat {
  if (input.format && input.format !== 'auto') return input.format;
  if (input.parserOptions?.grokPattern || input.parserOptions?.regex) return 'regex';

  if (input.contentType) {
    for (const [re, format] of CONTENT_TYPES) if (re.test(input.contentType)) return format;
  }
  return sniff(input.body);
}

export function sniff(body: string): EventFormat {
  const text = body.trimStart();
  const first = text[0];
  if (first === '{' || first === '[') return 'json';
  if (first === '<') return 'xml';

  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length === 0) return 'text';
  if (lines.every((l) => isLogfmt(l.trim()))) return 'logfmt';
  if (looksLikeCsv(lines)) return 'csv';
  return 'text';
}

function looksLikeCsv(lines: string[]): boolean {
  if (lines.length < 2) return false;
  const commas = (l: string) => l.split(',').length - 1;
  const n = commas(lines[0]!);
  return n > 0 && lines.slice(1, 6).every((l) => commas(l) === n);
}
