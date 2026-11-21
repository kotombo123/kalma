import type { FastifyInstance } from 'fastify';
import type { RawData, WebSocket } from 'ws';
import { z } from 'zod';
import type { AccessClaims } from '../auth/session.ts';
import type { Hub, Conn } from './hub.ts';

const AUTH_TIMEOUT_MS = 5_000;
const HEARTBEAT_MS = 25_000;
const AuthMsg = z.object({ type: z.literal('auth'), token: z.string().min(1).max(4000) });

/** Close codes the client acts on. */
export const WS_CLOSE = {
  authTimeout: 4000,
  unauthorized: 4001,
  tokenExpired: 4002,
} as const;

/**
 * GET /ws. The first message must be `{ "type": "auth", "token": "<access token>" }` — the token is
 * not put in the URL, so it does not end up in access logs. The server answers `{ "type": "ready" }`
 * and then streams UiEvents. When the access token expires the socket closes with 4002; the client
 * refreshes and reconnects, then reloads changes with GET /alerts?changedSince=….
 */
export async function wsRoutes(app: FastifyInstance, hub: Hub) {
  app.get('/ws', { websocket: true }, (socket: WebSocket) => {
    let conn: Conn | undefined;
    let alive = true;
    const authTimer = setTimeout(() => socket.close(WS_CLOSE.authTimeout, 'auth timeout'), AUTH_TIMEOUT_MS);
    let expiryTimer: NodeJS.Timeout | undefined;
    const heartbeat = setInterval(() => {
      if (!alive) return socket.terminate();
      alive = false;
      socket.ping();
    }, HEARTBEAT_MS);
    socket.on('pong', () => (alive = true));

    socket.on('message', async (raw: RawData) => {
      if (conn) return; // the stream is server → client only
      let msg: unknown;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        msg = undefined;
      }
      const auth = AuthMsg.safeParse(msg);
      if (!auth.success) return socket.close(WS_CLOSE.unauthorized, 'auth required');
      let claims: AccessClaims & { exp?: number };
      try {
        claims = app.jwt.verify<AccessClaims & { exp?: number }>(auth.data.token);
      } catch {
        return socket.close(WS_CLOSE.unauthorized, 'invalid token');
      }
      clearTimeout(authTimer);
      conn = {
        socket,
        userId: claims.sub,
        orgId: claims.orgId,
        role: claims.role,
        teams: await hub.teamsOf(claims.sub),
        notified: new Set(),
      };
      hub.add(conn);
      if (claims.exp) {
        const ms = claims.exp * 1000 - Date.now();
        expiryTimer = setTimeout(() => socket.close(WS_CLOSE.tokenExpired, 'token expired'), Math.max(ms, 0));
      }
      socket.send(JSON.stringify({ type: 'ready' }));
    });

    socket.on('close', () => {
      clearTimeout(authTimer);
      clearTimeout(expiryTimer);
      clearInterval(heartbeat);
      if (conn) hub.remove(conn);
    });
  });
}
