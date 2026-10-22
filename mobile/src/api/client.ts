import axios from 'axios';

import { adminErrorResponseErrorInterceptor } from './errorInterceptor';

const API_URL = process.env.EXPO_PUBLIC_API_URL || 'http://localhost:4000';

/**
 * Version prefix prepended to consumer-facing API paths.
 *
 * Defaults to `/api/v1` — the stable, versioned backend lane. Set
 * `EXPO_PUBLIC_API_VERSION_PREFIX=` (empty) to fall back to the legacy
 * unversioned aliases (deprecated, but still served with Deprecation/Sunset
 * headers). The backend serves both lanes, so reverting is a config-only
 * change.
 */
const API_VERSION_PREFIX =
  process.env.EXPO_PUBLIC_API_VERSION_PREFIX ?? '/api/v1';

/** Admin (/admin, /api/admin) and health endpoints are never versioned. */
const UNVERSIONED_PREFIXES = ['/admin', '/api/admin', '/health'];

const apiClient = axios.create({
  baseURL: API_URL,
  timeout: 10000,
});

let authToken: string | null = null;

/**
 * Set or clear the bearer token attached to subsequent API requests.
 * `authStore` keeps this in sync with the token persisted in SecureStore.
 */
export function setAuthToken(token: string | null): void {
  authToken = token;
}

// Add token to requests
apiClient.interceptors.request.use((config) => {
  if (authToken) {
    config.headers.set('Authorization', `Bearer ${authToken}`);
  }
  return config;
});

// Inject the API version prefix centrally for consumer-facing routes. Admin
// and health routes are excluded so they keep hitting the legacy paths.
apiClient.interceptors.request.use((config) => {
  const url = config.url ?? '';
  const isUnversioned =
    UNVERSIONED_PREFIXES.some(
      (p) => url === p || url.startsWith(`${p}/`),
    ) || /^https?:\/\//.test(url);

  if (!isUnversioned && !url.startsWith('/api/v')) {
    config.url = `${API_VERSION_PREFIX}${url}`;
  }
  return config;
});

// Map backend admin errors into typed AdminApiError instances so screens
// and stores don't have to handle raw AxiosErrors.
apiClient.interceptors.response.use(
  (response) => response,
  adminErrorResponseErrorInterceptor,
);

export default apiClient;
