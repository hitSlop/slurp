// Typed client for the control API (docs/contracts.md, "Control API"). Used by backend tests; the Worker implements `Handlers`.
import type { Api, ApiErrorBody, ErrorCode } from './api.gen.ts';

/** A failed call: the HTTP status plus the API's error code and message (`code` is undefined when the body was not an API error). */
export class ApiError extends Error {
  status: number;
  code: ErrorCode | undefined;

  constructor(status: number, code: ErrorCode | undefined, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

/** POST `{base}/v1/rpc/{method}` with a bearer token. Throws `ApiError` on a non-2xx answer. */
export async function call<M extends keyof Api>(
  base: string,
  token: string,
  method: M,
  req: Api[M]['req'],
): Promise<Api[M]['res']> {
  const response = await fetch(`${base.replace(/\/+$/, '')}/v1/rpc/${method}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(req),
  });
  const text = await response.text();
  if (!response.ok) {
    let body: Partial<ApiErrorBody> | undefined;
    try {
      body = JSON.parse(text);
    } catch {
      // not JSON: fall through with the raw text
    }
    throw new ApiError(response.status, body?.error?.code, body?.error?.message ?? text.slice(0, 200));
  }
  return JSON.parse(text) as Api[M]['res'];
}

/** One handler per method. The Worker's dispatcher is typed by this, so a missing or mistyped method fails `tsc`. */
export type Handlers<Ctx> = {
  [M in keyof Api]: (ctx: Ctx, req: Api[M]['req']) => Promise<Api[M]['res']>;
};
