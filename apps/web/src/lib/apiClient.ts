import type { ApiErrorBody } from '@minedesk/types';

export const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:4000';

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;

  constructor(body: ApiErrorBody['error'], status: number) {
    super(body.message);
    this.name = 'ApiError';
    this.code = body.code;
    this.status = status;
    this.details = body.details;
  }
}

/**
 * The access token lives in memory only - never localStorage, never a
 * JS-readable cookie. A full page reload loses it, which is expected: the
 * refresh cookie (httpOnly, set by the API) silently mints a new one on the
 * first request via /auth/refresh.
 */
let accessToken: string | null = null;
let refreshPromise: Promise<string | null> | null = null;

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function getAccessToken(): string | null {
  return accessToken;
}

type RequestOptions = {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  /** Skip the automatic refresh-and-retry (used by the refresh call itself). */
  skipAuthRetry?: boolean;
};

async function rawRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  // Only set Content-Type when there is an actual body to describe - the API
  // (Fastify's JSON body parser) rejects a request that claims
  // 'application/json' but sends nothing, which every bodyless call here
  // (refresh, logout, delete, ...) would otherwise do.
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

  const response = await fetch(`${API_URL}${path}`, {
    method: options.method ?? 'GET',
    headers,
    credentials: 'include', // send the httpOnly refresh cookie
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  if (response.status === 204) return undefined as T;

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    const errorBody = (payload as ApiErrorBody | null)?.error ?? {
      code: 'INTERNAL_ERROR',
      message: 'Something went wrong. Please try again.',
    };
    throw new ApiError(errorBody, response.status);
  }

  return payload as T;
}

/**
 * A single in-flight refresh is shared by every caller that hits a 401 at the
 * same time, so a burst of parallel requests does not race to rotate the
 * refresh token against itself.
 */
async function refreshAccessToken(): Promise<string | null> {
  if (!refreshPromise) {
    refreshPromise = rawRequest<{ accessToken: string }>('/api/v1/auth/refresh', {
      method: 'POST',
      skipAuthRetry: true,
    })
      .then((res) => {
        setAccessToken(res.accessToken);
        return res.accessToken;
      })
      .catch(() => {
        setAccessToken(null);
        return null;
      })
      .finally(() => {
        refreshPromise = null;
      });
  }
  return refreshPromise;
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  try {
    return await rawRequest<T>(path, options);
  } catch (error) {
    const isAuthError =
      error instanceof ApiError && (error.code === 'TOKEN_EXPIRED' || error.code === 'TOKEN_INVALID');

    if (isAuthError && !options.skipAuthRetry) {
      const refreshed = await refreshAccessToken();
      if (refreshed) return rawRequest<T>(path, options);
    }
    throw error;
  }
}

export const api = {
  get: <T>(path: string) => apiRequest<T>(path),
  post: <T>(path: string, body?: unknown) => apiRequest<T>(path, { method: 'POST', body }),
  put: <T>(path: string, body?: unknown) => apiRequest<T>(path, { method: 'PUT', body }),
  patch: <T>(path: string, body?: unknown) => apiRequest<T>(path, { method: 'PATCH', body }),
  delete: <T>(path: string) => apiRequest<T>(path, { method: 'DELETE' }),
};

/** Called once at app startup to silently establish a session from the refresh cookie, if any. */
export async function bootstrapSession(): Promise<boolean> {
  const token = await refreshAccessToken();
  return token !== null;
}
