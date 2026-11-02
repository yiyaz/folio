export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: any,
  ) {
    super(message);
  }
}

type Body = Record<string, unknown> | unknown[] | FormData | undefined;

/** Network failures, timeouts, rate limits and server errors are worth retrying; 4xx are not. */
export const isRetryable = (e: unknown) => e instanceof ApiError && (e.status === 0 || e.status === 429 || e.status >= 500);

export async function api<T = any>(path: string, opts: { method?: string; body?: Body; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
  const method = opts.method ?? (opts.body ? 'POST' : 'GET');
  const headers: Record<string, string> = { 'x-requested-with': 'folio' };
  let body: BodyInit | undefined;
  if (opts.body instanceof FormData) body = opts.body;
  else if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  let res: Response;
  try {
    res = await fetch(path, { method, headers, body, credentials: 'same-origin', signal: opts.signal ?? AbortSignal.timeout(opts.timeoutMs ?? 30_000) });
  } catch (e) {
    // offline, DNS failure, timeout: status 0 lets callers decide to retry
    throw new ApiError(
      0,
      'network',
      e instanceof DOMException && e.name === 'TimeoutError' ? 'The server took too long to respond' : 'Network error: check your connection',
    );
  }
  const text = await res.text();
  const data = text ? safeJson(text) : null;
  if (!res.ok) throw new ApiError(res.status, data?.error ?? 'error', data?.message ?? res.statusText, data?.details);
  return data as T;
}

function safeJson(t: string) {
  try {
    return JSON.parse(t);
  } catch {
    return { message: t };
  }
}

export const get = <T = any>(p: string) => api<T>(p);
export const post = <T = any>(p: string, body: Body = {}) => api<T>(p, { method: 'POST', body });
export const put = <T = any>(p: string, body: Body) => api<T>(p, { method: 'PUT', body });
export const patch = <T = any>(p: string, body: Body) => api<T>(p, { method: 'PATCH', body });
export const del = <T = any>(p: string) => api<T>(p, { method: 'DELETE' });
