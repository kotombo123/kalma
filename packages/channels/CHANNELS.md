# Dodanie kanału w 1 pliku

Każdy kanał to jeden plik w `packages/channels/src/adapters/`.

## Interfejs `ChannelAdapter`

```ts
interface ChannelAdapter {
  type: string;          // nazwa kanału, np. 'slack'
  mode: 'real' | 'mock';
  send(msg: RenderedMessage, to: ChannelAddress): Promise<SendResult>;
  startInbound?(handler: (reply: InboundReply) => Promise<void>): Promise<void>;
}
```

## Szablon nowego kanału

```ts
// packages/channels/src/adapters/slack.ts
import type { ChannelAdapter, RenderedMessage, ChannelAddress, SendResult } from '../types.ts';

export interface SlackConfig {
  token: string;
}

export function createSlackAdapter(config?: SlackConfig): ChannelAdapter {
  return {
    type: 'slack',
    mode: config?.token ? 'real' : 'mock',

    async send(msg: RenderedMessage, to: ChannelAddress): Promise<SendResult> {
      if (!config?.token) return { ok: true }; // mock

      try {
        const res = await fetch('https://slack.com/api/chat.postMessage', {
          method: 'POST',
          headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ channel: to.address, text: msg.short }),
        });
        const json = await res.json() as { ok: boolean; error?: string };
        return json.ok ? { ok: true } : { ok: false, retryable: false, error: json.error };
      } catch (err) {
        return { ok: false, retryable: true, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
```

## Kroki

1. Stwórz `packages/channels/src/adapters/<name>.ts` wg szablonu.
2. Wyeksportuj z `packages/channels/src/index.ts`.
3. Podepnij w `apps/notifier/src/dispatcher.ts` → `buildAdapters()`.
4. Dodaj env var do `packages/config/src/env.ts` i `.env.example`.
5. Dodaj `'<name>'` do `ChannelType` w `packages/contracts` (osobny PR `contract: add <name> channel`).

## Istniejące kanały

| Kanał     | Plik                  | Tryb        | Uwagi                                       |
|-----------|-----------------------|-------------|---------------------------------------------|
| `ui`      | `ui.ts`               | mock        | Pub/sub Redis `ui:{orgId}`                  |
| `email`   | `email.ts`            | real/mock   | SMTP via nodemailer; Mailpit w dev          |
| `telegram`| `telegram.ts`         | real/mock   | Bot API; inbound `/start` + callback_query  |
| `teams`   | `teams.ts`            | real/mock   | Adaptive Card via webhook URL               |
| `sms`     | `sms-phone.ts`        | stub        | Zwraca err; dodaj Twilio wg szablonu        |
| `phone`   | `sms-phone.ts`        | stub        | Zwraca err; dodaj dostawcę VoIP wg szablonu |
