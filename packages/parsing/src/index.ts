import { detectFormat } from './detect.ts';
import {
  parseCsv,
  parseJson,
  parseLogfmt,
  parseRegex,
  parseText,
  parseXml,
  type Parser,
} from './parsers/index.ts';
import type { EventFormat, FallbackRecord, ParseInput, ParseResult } from './types.ts';

export * from './types.ts';
export { detectFormat, sniff } from './detect.ts';
export { GROK_PATTERNS, compileGrok } from './parsers/grok.ts';
export { parseLogfmtLine } from './parsers/index.ts';

const PARSERS: Record<EventFormat, Parser> = {
  json: parseJson,
  xml: parseXml,
  logfmt: parseLogfmt,
  csv: parseCsv,
  regex: parseRegex,
  text: parseText,
};

/** Never throws: a body that fails its parser becomes one `{ message, _parseError }` record. */
export function parse(input: ParseInput): ParseResult {
  const format = detectFormat(input);
  try {
    const records = PARSERS[format](input.body, input.parserOptions ?? {});
    if (records.length > 0) return { format, records, parseError: false };
  } catch {
    // fall through to fallback
  }
  const fallback: FallbackRecord = { message: input.body, _parseError: true };
  return { format, records: [fallback], parseError: true };
}
