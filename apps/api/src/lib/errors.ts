/**
 * One error shape for the whole API: `{ error: { code, message, issues? } }`.
 * Messages are safe to show to users; internals are never sent (OWASP A05).
 */
export class HttpError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    /** Field-level problems, returned as `error.issues`. */
    public issues?: { path: (string | number)[]; message: string }[],
  ) {
    super(message);
  }
}

export const badRequest = (code: string, msg: string) => new HttpError(400, code, msg);
export const unauthorized = (msg = 'Not authenticated') => new HttpError(401, 'unauthorized', msg);
export const forbidden = (msg = 'Not allowed') => new HttpError(403, 'forbidden', msg);
export const notFound = (msg = 'Not found') => new HttpError(404, 'not_found', msg);
export const conflict = (code: string, msg: string) => new HttpError(409, code, msg);
export const gone = (code: string, msg: string) => new HttpError(410, code, msg);
