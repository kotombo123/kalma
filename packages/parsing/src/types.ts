import type { EventFormat, ParserOptions, Source } from '@alerting/contracts';

export type { EventFormat, ParserOptions };

export interface ParseInput {
  body: string;
  /** Source config format; 'auto' (or undefined) falls back to Content-Type, then sniffing. */
  format?: Source['format'];
  contentType?: string;
  parserOptions?: ParserOptions;
}

export interface ParseResult {
  format: EventFormat;
  /** One body can carry many records: NDJSON lines, JSON array items, CSV rows, log lines. */
  records: unknown[];
  parseError: boolean;
}

export interface FallbackRecord {
  message: string;
  _parseError: true;
}
