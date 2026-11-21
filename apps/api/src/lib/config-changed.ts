import { CONFIG_CHANGED, type Redis } from '@alerting/config';
import { ConfigChanged } from '@alerting/contracts';

/** Tells ingest / worker / notifier to reload their caches (hot-reload, no restart). */
export async function publishConfigChanged(redis: Redis, msg: ConfigChanged): Promise<void> {
  await redis.publish(CONFIG_CHANGED, JSON.stringify(ConfigChanged.parse(msg)));
}
