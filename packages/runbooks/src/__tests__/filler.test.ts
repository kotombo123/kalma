import { describe, it, expect } from 'vitest';
import { fillStep, fillRunbook } from '../filler.ts';
import { readJsonFixture } from '@alerting/contracts/fixtures';
import type { RunbookStep, Alert } from '@alerting/contracts';

const mockRender = (template: string, data: Record<string, unknown>): string =>
  template.replace(/\{\{([^}]+)\}\}/g, (_m, key: string) => {
    const path = key.trim().split('|')[0]?.trim() ?? '';
    return String(data[path] ?? `{{${path}}}`);
  });

const ctx = { renderTemplate: mockRender };

describe('fillStep', () => {
  it('fills text template with event data', () => {
    const step: RunbookStep = {
      id: 's1',
      kind: 'manual',
      text: 'Retry workflow {{workflowId}}',
      approval: 'none',
    };
    const filled = fillStep(step, { workflowId: 'WF-123' }, ctx);
    expect(filled.textFilled).toBe('Retry workflow WF-123');
    expect(filled.missingFields).toHaveLength(0);
  });

  it('marks missing fields', () => {
    const step: RunbookStep = {
      id: 's2',
      kind: 'action',
      text: 'Retry {{workflowId}} for {{counterpartyId}}',
      approval: 'none',
    };
    const filled = fillStep(step, { workflowId: 'WF-999' }, ctx);
    expect(filled.missingFields).toContain('counterpartyId');
  });

  it('fills action params', () => {
    const step: RunbookStep = {
      id: 's3',
      kind: 'action',
      text: 'Run action',
      action: { type: 'retry_workflow', params: { workflowId: '{{workflowId}}' } },
      approval: 'none',
    };
    const filled = fillStep(step, { workflowId: 'WF-20261023-00042' }, ctx);
    expect(filled.actionFilled?.params['workflowId']).toBe('WF-20261023-00042');
  });
});

describe('fillRunbook with official alert.sample.json', () => {
  it('fills steps using seed alert data', () => {
    const alert = readJsonFixture<Alert>('alert.sample.json');
    const data: Record<string, unknown> = {
      ...alert.lastEvent.flat,
      id: alert.id,
      title: alert.title,
    };

    const steps: RunbookStep[] = [
      { id: 's1', kind: 'check', text: 'Check {{workflowId}}', approval: 'none' },
      { id: 's2', kind: 'action', text: 'Retry {{workflowId}}', approval: 'none' },
    ];

    const filled = fillRunbook(steps, data, ctx);
    expect(filled[0]?.textFilled).toBe('Check WF-20261023-00042');
    expect(filled[1]?.textFilled).toBe('Retry WF-20261023-00042');
  });
});
