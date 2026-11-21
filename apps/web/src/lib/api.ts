import i18n from './i18n.ts';
/** API client: access token in memory, refresh token in an httpOnly cookie (POST /auth/refresh). */

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public issues?: { path: (string | number)[]; message: string }[],
  ) {
    super(message);
  }
}

let accessToken: string | null = null;
let refreshing: Promise<string | null> | null = null;
const listeners = new Set<(token: string | null) => void>();

export const getToken = () => accessToken;
export function setToken(token: string | null) {
  accessToken = token;
  listeners.forEach((l) => l(token));
}
export function onTokenChange(l: (token: string | null) => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export interface Session {
  accessToken: string;
  expiresIn: number;
  user: { id: string; email: string; name: string };
  org: { id: string; name: string };
  role: 'admin' | 'member';
}

/** One refresh at a time, shared by every caller. */
export function refresh(): Promise<string | null> {
  refreshing ??= fetch('/api/auth/refresh', { method: 'POST', credentials: 'same-origin' })
    .then(async (r) => {
      if (!r.ok) return null;
      const s = (await r.json()) as Session;
      return s.accessToken;
    })
    .catch(() => null)
    .then((token) => {
      setToken(token);
      refreshing = null;
      return token;
    });
  return refreshing;
}

async function toError(res: Response): Promise<ApiError> {
  try {
    const body = (await res.json()) as {
      error?: { code: string; message: string; issues?: ApiError['issues'] };
    };
    if (body.error) return new ApiError(res.status, body.error.code, body.error.message, body.error.issues);
  } catch {
    /* not JSON */
  }
  return new ApiError(res.status, 'http_error', i18n.language === 'pl' ? `Serwer odpowiedział błędem ${res.status}` : `The server returned error ${res.status}`);
}

/** JSON request to the API; retries once after refreshing an expired access token. */
export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const send = (token: string | null) =>
    fetch(`/api${path}`, {
      method: init.method ?? 'GET',
      credentials: 'same-origin',
      headers: {
        ...(init.body !== undefined && { 'content-type': 'application/json' }),
        ...(token && { authorization: `Bearer ${token}` }),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
  let res = await send(accessToken);
  if (res.status === 401 && !path.startsWith('/auth/')) {
    const token = await refresh();
    if (token) res = await send(token);
  }
  if (!res.ok) throw await toError(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
