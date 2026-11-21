import { afterEach, describe, expect, it, vi } from 'vitest';
import { demoAwareFetch } from '../src/step-engine.ts';

describe('demoAwareFetch', () => {
  afterEach(() => vi.restoreAllMocks());

  it('routes simulated services and demo-systems to DEMO_SYSTEMS_URL; leaves other URLs alone', async () => {
    const calls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      calls.push(String(input));
      return new Response('{}');
    });
    const f = demoAwareFetch('http://localhost:3002/');
    await f('http://counterparty-service/health');
    await f('http://demo-systems:3002/workflows/WF-1/retry');
    await f('https://status.example.com/api?x=1');
    expect(calls).toEqual([
      'http://localhost:3002/services/counterparty-service/health',
      'http://localhost:3002/workflows/WF-1/retry',
      'https://status.example.com/api?x=1',
    ]);
  });
});
