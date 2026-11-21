import { describe, it, expect } from 'vitest';
import { parseYaml } from '../parsers/yaml.ts';
import { readFixture } from '@alerting/contracts/fixtures';

describe('parseYaml — Appendix C fixtures', () => {
  it('parses settlement-timeout YAML runbook (shorthand format)', () => {
    const source = readFixture('runbooks/settlement-timeout.yaml');
    const result = parseYaml(source);

    expect(result.name).toBe('settlement-timeout');
    expect(result.steps).toHaveLength(3);
    expect(result.warnings).toHaveLength(0);

    // step 0: check with action
    expect(result.steps[0]).toMatchObject({
      kind: 'check',
      action: { type: 'http_get' },
      approval: 'none',
    });
    expect(result.steps[0]!.text).toContain('counterparty-service');

    // step 1: retry_workflow action
    expect(result.steps[1]).toMatchObject({
      kind: 'action',
      action: { type: 'retry_workflow' },
      approval: 'none',
    });
    expect(result.steps[1]!.action?.params['workflowId']).toBe('{{workflowId}}');

    // step 2: escalate with approval required
    expect(result.steps[2]).toMatchObject({
      kind: 'action',
      action: { type: 'escalate' },
      approval: 'required',
    });
  });

  it('throws on invalid YAML', () => {
    expect(() => parseYaml('{')).toThrow('YAML parse error');
  });

  it('throws on missing steps field', () => {
    expect(() => parseYaml('runbook: Test\n')).toThrow();
  });

  it('skips unparseable steps with a warning', () => {
    const source = `
runbook: Test
steps:
  - check: "Valid step"
    action: http_get
  - 42
`;
    const result = parseYaml(source);
    expect(result.steps).toHaveLength(1);
    expect(result.warnings).toHaveLength(1);
  });

  it('handles canonical format (kind/text/action nested)', () => {
    const source = `
runbook: Canonical
steps:
  - id: s1
    kind: action
    text: "Do something"
    action:
      type: http_post
      params:
        url: "http://example.com"
    approval: required
`;
    const result = parseYaml(source);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]).toMatchObject({
      id: 's1',
      kind: 'action',
      approval: 'required',
      action: { type: 'http_post' },
    });
  });
});
