import { describe, expect, it } from 'vitest';
import { eventStreams, streamFor } from '../src/streams.ts';

describe('streamFor', () => {
  it('returns the base stream without sharding', () => {
    expect(streamFor('src_1')).toBe('stream:events');
  });
  it('is stable and within shard range', () => {
    const s = streamFor('src_1', 4);
    expect(s).toBe(streamFor('src_1', 4));
    expect(eventStreams(4)).toContain(s);
  });
});

describe('EnvSchema', () => {
  it('requires a real JWT_SECRET in production', async () => {
    const { EnvSchema } = await import('../src/env.ts');
    expect(EnvSchema.safeParse({ NODE_ENV: 'production' }).success).toBe(false);
    expect(EnvSchema.safeParse({ NODE_ENV: 'production', JWT_SECRET: 'x'.repeat(32) }).success).toBe(true);
    expect(EnvSchema.safeParse({}).success).toBe(true);
  });
});
