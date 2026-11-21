import { uiChannel, type Redis } from '@alerting/config';
import { UiEvent } from '@alerting/contracts';

/** Publishes a contract-valid UiEvent on `ui:{orgId}` (the WebSocket forwards it to browsers). */
export async function publishUi(redis: Redis, orgId: string, ev: UiEvent): Promise<void> {
  await redis.publish(uiChannel(orgId), JSON.stringify(UiEvent.parse(ev)));
}
