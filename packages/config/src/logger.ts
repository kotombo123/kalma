import { pino, type Logger } from 'pino';
import { env } from './env.ts';

export type { Logger };

export function createLogger(name: string): Logger {
  const e = env();
  return pino({
    name,
    level: e.LOG_LEVEL,
    ...(e.NODE_ENV === 'development' && process.stdout.isTTY
      ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
      : {}),
  });
}
