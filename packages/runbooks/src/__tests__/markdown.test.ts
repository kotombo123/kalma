import { describe, it, expect } from 'vitest';
import { parseMarkdown } from '../parsers/markdown.ts';
import { readFixture } from '@alerting/contracts/fixtures';

describe('parseMarkdown — Appendix C fixtures', () => {
  it('parses payments-high-error-rate Markdown runbook', () => {
    const source = readFixture('runbooks/payments-high-error-rate.md');
    const result = parseMarkdown(source);

    expect(result.name).toBe('HighErrorRate on payments-api');
    expect(result.steps.length).toBeGreaterThanOrEqual(3);
    expect(result.steps.every((s) => s.kind === 'manual')).toBe(true);

    // step 2 mentions "needs approval"
    const approvalStep = result.steps.find((s) => s.text.toLowerCase().includes('approval') || s.approval === 'required');
    expect(approvalStep).toBeDefined();
    expect(approvalStep?.approval).toBe('required');
  });

  it('detects approval phrases in steps', () => {
    const result = parseMarkdown(`
# Test Runbook

1. Check service health
2. Restart service — needs approval
3. Verify recovery
`);
    expect(result.steps[1]?.approval).toBe('required');
    expect(result.steps[0]?.approval).toBe('none');
  });

  it('detects high-risk keywords for approval', () => {
    const result = parseMarkdown(`
# Risk Test

1. Normal step
2. Roll back the last deployment
`);
    expect(result.steps[1]?.approval).toBe('required');
  });

  it('extracts title from h1', () => {
    expect(parseMarkdown('# My Runbook\n\n1. Step one\n').name).toBe('My Runbook');
  });

  it('returns empty steps for runbook with no numbered items', () => {
    expect(parseMarkdown('# Empty\n\nNo steps here.').steps).toHaveLength(0);
  });
});
