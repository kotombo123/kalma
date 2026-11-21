import { describe, it, expect, vi } from 'vitest';
import { uiAdapter } from '../adapters/ui.ts';
import { createTeamsAdapter } from '../adapters/teams.ts';
import { smsAdapter, phoneAdapter } from '../adapters/sms-phone.ts';
import type { RenderedMessage, ChannelAddress } from '../types.ts';

const SAMPLE_MSG: RenderedMessage = {
  title: 'Settlement timeout',
  text: 'Workflow WF-123 timed out',
  short: 'WF-123 timeout',
  url: 'http://localhost:5173/alerts/alert-1',
  actions: [
    { id: 'act-1', label: 'Acknowledge', kind: 'ack' },
    { id: 'act-2', label: 'Approve', kind: 'approve' },
  ],
};

describe('UI adapter', () => {
  it('always succeeds (no-op)', async () => {
    const to: ChannelAddress = { channel: 'ui', address: 'user-1' };
    const result = await uiAdapter.send(SAMPLE_MSG, to);
    expect(result.ok).toBe(true);
  });
});

describe('Teams adapter', () => {
  it('succeeds silently in mock mode (no webhookUrl)', async () => {
    const adapter = createTeamsAdapter(undefined);
    expect(adapter.mode).toBe('mock');
    const result = await adapter.send(SAMPLE_MSG, { channel: 'teams', address: '' });
    expect(result.ok).toBe(true);
  });

  it('calls webhook in real mode', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', mockFetch);

    const webhookUrl = 'https://teams.example.com/webhook';
    const adapter = createTeamsAdapter(webhookUrl);
    expect(adapter.mode).toBe('real');
    const result = await adapter.send(SAMPLE_MSG, { channel: 'teams', address: webhookUrl });

    expect(result.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(webhookUrl, expect.objectContaining({ method: 'POST' }));

    vi.unstubAllGlobals();
  });

  it('returns retryable error on 5xx', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    vi.stubGlobal('fetch', mockFetch);

    const webhookUrl = 'https://teams.example.com/webhook';
    const adapter = createTeamsAdapter(webhookUrl);
    const result = await adapter.send(SAMPLE_MSG, { channel: 'teams', address: webhookUrl });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.retryable).toBe(true);

    vi.unstubAllGlobals();
  });
});

describe('SMS/Phone stub adapters', () => {
  it('SMS returns non-retryable not-configured error', async () => {
    const result = await smsAdapter.send(SAMPLE_MSG, { channel: 'sms', address: '+48500000000' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retryable).toBe(false);
      expect(result.error).toContain('not configured');
    }
  });

  it('Phone returns non-retryable not-configured error', async () => {
    const result = await phoneAdapter.send(SAMPLE_MSG, { channel: 'phone', address: '+48500000000' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.retryable).toBe(false);
  });
});
