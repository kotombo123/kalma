# Fixtures

Shared test data (implementation_plan.md §5.7). Load them in tests with `fixturePath()` / `readFixture()`
from `@alerting/contracts/fixtures` (Node only).

| File | What | Transport / format |
|---|---|---|
| `events/workflow-failed.json` | Appendix A — workflow failure | Kafka, JSON |
| `events/alertmanager-firing.json` | Appendix A — metric breach | HTTP, JSON (Alertmanager) |
| `events/alertmanager-resolved.json` | same alert, resolved | HTTP, JSON |
| `events/trade-rejected.json` | Appendix A — business event (`meta`/`payload`) | Kafka, JSON |
| `events/pricing-engine.log` | pricing-engine text log (4 lines) | file tail, grok `%{TIMESTAMP_ISO8601:ts} %{LOGLEVEL:level} \[%{NOTSPACE:service}\] %{WORD:instrument} %{GREEDYDATA:message}` |
| `events/logfmt.log` | counterparty-service log line | logfmt |
| `events/settlement-batch.xml` | settlement batch failure | XML |
| `events/reconciliation.csv` | reconciliation mismatches (2 rows) | CSV with header |
| `events/judges-unknown.json` | unknown schema (simulates the judges' event) | JSON |
| `rules/*.yaml` | Appendix B — 4 rules (team / user by name) | `RuleFile` |
| `runbooks/*` | Appendix C — YAML, Markdown, free text | runbook sources |
| `alert.sample.json` | an `Alert` for the settlement scenario (seed ids) | `Alert` |
