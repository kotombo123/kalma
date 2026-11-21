// Mini-grok: %{NAME} or %{NAME:field} expand to regex; patterns may reference each other.
export const GROK_PATTERNS: Record<string, string> = {
  INT: '[+-]?\\d+',
  NUMBER: '[+-]?(?:\\d+(?:\\.\\d+)?|\\.\\d+)',
  WORD: '\\w+',
  NOTSPACE: '\\S+',
  SPACE: '\\s*',
  DATA: '.*?',
  GREEDYDATA: '.*',
  QUOTEDSTRING: '"(?:[^"\\\\]|\\\\.)*"',
  UUID: '[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}',
  IPV4: '(?:\\d{1,3}\\.){3}\\d{1,3}',
  HOSTNAME: '[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,62})(?:\\.[a-zA-Z0-9-]{1,63})*',
  IP: '%{IPV4}',
  URIPATH: '/[^\\s?#]*',
  YEAR: '\\d{4}',
  MONTHNUM: '0?[1-9]|1[0-2]',
  MONTHDAY: '0?[1-9]|[12]\\d|3[01]',
  TIME: '\\d{2}:\\d{2}(?::\\d{2}(?:[.,]\\d+)?)?',
  ISO8601_TIMEZONE: 'Z|[+-]\\d{2}:?\\d{2}',
  TIMESTAMP_ISO8601: '%{YEAR}-\\d{2}-\\d{2}[T ]%{TIME}(?:%{ISO8601_TIMEZONE})?',
  MONTH: 'Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec',
  SYSLOGTIMESTAMP: '(?:%{MONTH}) +\\d{1,2} %{TIME}',
  LOGLEVEL:
    '(?:[Tt]race|TRACE|[Dd]ebug|DEBUG|[Ii]nfo|INFO|[Nn]otice|NOTICE|[Ww]arn(?:ing)?|WARN(?:ING)?|[Ee]rr(?:or)?|ERR(?:OR)?|[Cc]rit(?:ical)?|CRIT(?:ICAL)?|[Ff]atal|FATAL|[Ee]merg(?:ency)?|EMERG(?:ENCY)?)',
};

const REF = /%\{(\w+)(?::([\w.@-]+))?\}/g;
const cache = new Map<string, RegExp>();

/** Field names may contain dots (`error.code`); RegExp group names cannot, so we map them. */
export interface CompiledGrok {
  re: RegExp;
  fields: Map<string, string>;
}

const compiledCache = new Map<string, CompiledGrok>();

export function compileGrok(pattern: string): CompiledGrok {
  const hit = compiledCache.get(pattern);
  if (hit) return hit;

  const fields = new Map<string, string>();
  const expand = (src: string, depth: number): string => {
    if (depth > 10) throw new Error(`grok: pattern nesting too deep in "${pattern}"`);
    return src.replace(REF, (_, name: string, field?: string) => {
      const def = GROK_PATTERNS[name];
      if (def === undefined) throw new Error(`grok: unknown pattern %{${name}}`);
      const body = expand(def, depth + 1);
      if (!field) return `(?:${body})`;
      const group = `g${fields.size}`;
      fields.set(group, field);
      return `(?<${group}>${body})`;
    });
  };

  const compiled = { re: new RegExp(`^${expand(pattern, 0)}$`), fields };
  compiledCache.set(pattern, compiled);
  return compiled;
}

export function compileRegex(source: string): RegExp {
  let re = cache.get(source);
  if (!re) {
    re = new RegExp(source);
    cache.set(source, re);
  }
  return re;
}
