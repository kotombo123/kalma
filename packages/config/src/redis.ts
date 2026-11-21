import { Redis, type RedisOptions } from 'ioredis';
import { env } from './env.ts';

export { Redis };

export function createRedis(opts: RedisOptions = {}): Redis {
  return new Redis(env().REDIS_URL, { maxRetriesPerRequest: null, ...opts });
}
