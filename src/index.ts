/**
 * @creadev.org/network
 *
 * Network tooling, connectivity, poor-internet handling for browser.
 *
 * EXAMPLES:
 * ```typescript
 * import { network, online, isDomainAllowed } from '@creadev.org/network';
 *
 * // Check connectivity
 * if (await online.check()) { ... }
 *
 * // Fetch with retry + timeout
 * const data = await network.fetch('https://api.example.com/data');
 * ```
 * ============================================================================
 */

import { withRetry, CircuitBreaker } from '@creadev.org/qos/retry';
import type { RetryOptions } from '@creadev.org/qos/retry';
import { withTimeout } from '@creadev.org/qos/timeout';
import type { TimeoutOptions } from '@creadev.org/qos/timeout';

// ============================================================================
// CONFIG
// ============================================================================

export interface NetworkConfig {
  DEFAULT_TIMEOUT_MS: number;
  DEFAULT_RETRIES: number;
  DEFAULT_BACKOFF_MS: number;
  MAX_BACKOFF_MS: number;
  LATENCY_SAMPLE_SIZE: number;
  CIRCUIT_THRESHOLD: number;
  CACHE_TTL: number;
}

export const CONFIG: NetworkConfig = {
  DEFAULT_TIMEOUT_MS: 30000,
  DEFAULT_RETRIES: 3,
  DEFAULT_BACKOFF_MS: 1000,
  MAX_BACKOFF_MS: 30000,
  LATENCY_SAMPLE_SIZE: 3,
  CIRCUIT_THRESHOLD: 5,
  CACHE_TTL: 60000,
};

// ============================================================================
// STATE
// ============================================================================

let _isOnline = true;
let _lastOnlineCheck = 0;
let _latencyHistory: number[] = [];
let _startTime = Date.now();

// ============================================================================
// DOMAIN WHITELIST
// ============================================================================

const _allowedDomains: string[] = [];

export function isDomainAllowed(url: string): boolean {
  if (_allowedDomains.length === 0) return true;
  try {
    const hostname = new URL(url).hostname;
    return _allowedDomains.some(d => hostname === d || hostname.endsWith('.' + d));
  } catch {
    return false;
  }
}

export function setAllowedDomains(domains: string[]): void {
  _allowedDomains.length = 0;
  _allowedDomains.push(...domains);
}

export function getAllowedDomains(): string[] {
  return [..._allowedDomains];
}

// ============================================================================
// CONNECTIVITY
// ============================================================================

export function isOnline(): boolean {
  return _isOnline;
}

export function setOnline(status: boolean): void {
  _isOnline = status;
  _lastOnlineCheck = Date.now();
}

export async function checkOnline(probeUrl = 'https://www.google.com', timeoutMs = 5000): Promise<boolean> {
  if (typeof navigator === 'undefined') {
    // Node.js environment - assume online
    _isOnline = true;
    _lastOnlineCheck = Date.now();
    return true;
  }

  if (!navigator.onLine) {
    _isOnline = false;
    _lastOnlineCheck = Date.now();
    return false;
  }

  if (probeUrl) {
    try {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), timeoutMs);
      await fetch(probeUrl, { method: 'HEAD', signal: controller.signal, mode: 'no-cors' });
      _isOnline = true;
    } catch {
      _isOnline = false;
    }
  } else {
    _isOnline = navigator.onLine;
  }
  
  _lastOnlineCheck = Date.now();
  return _isOnline;
}

// Auto-check on visibility change
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => setOnline(true));
  window.addEventListener('offline', () => setOnline(false));
}

// ============================================================================
// LATENCY
// ============================================================================

export function getLatency(): number {
  if (_latencyHistory.length === 0) return 0;
  const sorted = [..._latencyHistory].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

export interface LatencyStats {
  avg: number | null;
  min: number | null;
  max: number | null;
  samples: number;
}

export function getLatencyStats(): LatencyStats {
  if (_latencyHistory.length === 0) return { avg: null, min: null, max: null, samples: 0 };
  const sum = _latencyHistory.reduce((a, b) => a + b, 0);
  return {
    avg: Math.round(sum / _latencyHistory.length),
    min: Math.min(..._latencyHistory),
    max: Math.max(..._latencyHistory),
    samples: _latencyHistory.length
  };
}

export async function measureLatency(url: string, sampleSize = CONFIG.LATENCY_SAMPLE_SIZE): Promise<number> {
  const results: number[] = [];
  const timeoutMs = 10000;

  for (let i = 0; i < sampleSize; i++) {
    const start = Date.now();
    try {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), timeoutMs);
      await fetch(url, { signal: controller.signal });
      results.push(Date.now() - start);
    } catch {
      results.push(timeoutMs);
    }
  }

  const latency = Math.min(...results);
  _latencyHistory.push(latency);
  if (_latencyHistory.length > 100) _latencyHistory.shift();

  return latency;
}

// ============================================================================
// TIMING HELPERS
// ============================================================================

export function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

export function isExpired(timestamp: number, maxAgeMs: number): boolean {
  return Date.now() - timestamp > maxAgeMs;
}

// ============================================================================
// CACHE (In-memory)
// ============================================================================

interface CacheEntry {
  value: unknown;
  expiry: number | null;
}

const _cache = new Map<string, CacheEntry>();

export function cacheGet(key: string): unknown {
  const entry = _cache.get(key);
  if (!entry) return null;
  if (entry.expiry && Date.now() > entry.expiry) {
    _cache.delete(key);
    return null;
  }
  return entry.value;
}

export function cacheSet(key: string, value: unknown, ttlMs = CONFIG.CACHE_TTL): void {
  _cache.set(key, {
    value,
    expiry: ttlMs ? Date.now() + ttlMs : null
  });
}

export function cacheClear(): void {
  _cache.clear();
}

const _networkCache = { enabled: true, ttl: CONFIG.CACHE_TTL };

export function setCacheEnabled(enabled: boolean): void {
  _networkCache.enabled = enabled;
}

export function isCacheEnabled(): boolean {
  return _networkCache.enabled;
}

// ============================================================================
// NETWORK FETCH
// ============================================================================

let _circuit: CircuitBreaker | null = null;

function getCircuit(): CircuitBreaker {
  if (!_circuit) {
    _circuit = new CircuitBreaker({
      failureThreshold: CONFIG.CIRCUIT_THRESHOLD,
      resetTimeoutMs: 30000,
    });
  }
  return _circuit;
}

export interface FetchOptions {
  method?: string;
  cache?: boolean;
  circuit?: boolean;
  timeout?: number;
  retries?: number;
  backoff?: number;
  maxBackoff?: number;
  headers?: Record<string, string>;
  skipDomainCheck?: boolean;
  body?: string | FormData;
}

export async function networkFetch(url: string, options: FetchOptions = {}): Promise<Response> {
  const {
    method = 'GET',
    cache: useCache = true,
    circuit: useCircuit = true,
    timeout = CONFIG.DEFAULT_TIMEOUT_MS,
    retries = CONFIG.DEFAULT_RETRIES,
    backoff = CONFIG.DEFAULT_BACKOFF_MS,
    maxBackoff = CONFIG.MAX_BACKOFF_MS,
    headers = {},
    skipDomainCheck = false,
  } = options;

  if (!skipDomainCheck && !isDomainAllowed(url)) {
    throw new Error(`Network: domain not allowed - ${url}`);
  }

  if (method === 'GET' && _networkCache.enabled && useCache) {
    const cached = cacheGet('net:' + url);
    if (cached) return cached as Response;
  }

  const doFetch = async (): Promise<Response> => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(url, { method, headers, signal: controller.signal, body: options.body });
      clearTimeout(timeoutId);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response;
    } catch (e) {
      clearTimeout(timeoutId);
      throw e;
    }
  };

  const retryOptions: RetryOptions = { retries, baseDelayMs: backoff, maxDelayMs: maxBackoff };

  if (useCircuit) {
    return getCircuit().execute(() => withRetry(doFetch, retryOptions));
  }

  return withRetry(doFetch, retryOptions);
}

export async function fetchJson(url: string, options: FetchOptions = {}): Promise<unknown> {
  const response = await networkFetch(url, {
    ...options,
    headers: { ...options.headers, 'Accept': 'application/json' }
  });
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export async function fetchText(url: string, options: FetchOptions = {}): Promise<string> {
  const response = await networkFetch(url, options);
  return response.text();
}

// ============================================================================
// SHORTCUTS
// ============================================================================

export async function fetchWithRetry(url: string, options: FetchOptions = {}): Promise<Response> {
  return networkFetch(url, { ...options, circuit: false });
}

export async function fetchJsonWithRetry(url: string, options: FetchOptions = {}): Promise<unknown> {
  const response = await networkFetch(url, {
    ...options,
    circuit: false,
    headers: { ...options.headers, 'Accept': 'application/json' }
  });
  try {
    return await response.json();
  } catch {
    return null;
  }
}

// ============================================================================
// STATUS
// ============================================================================

export interface NetworkStatus {
  online: boolean;
  lastCheck: number;
  latency: LatencyStats;
  uptime: number;
}

export function getStatus(): NetworkStatus {
  return {
    online: _isOnline,
    lastCheck: _lastOnlineCheck,
    latency: getLatencyStats(),
    uptime: Date.now() - _startTime
  };
}

export interface CircuitStatus {
  state: 'closed' | 'open' | 'half-open';
  retryAfter: number;
}

export function getCircuitStatus(): CircuitStatus {
  const c = _circuit;
  if (!c) return { state: 'closed', retryAfter: 0 };
  return {
    state: c.status,
    retryAfter: c.retryAfter
  };
}

export function clear(): void {
  _latencyHistory = [];
  _startTime = Date.now();
  _cache.clear();
}

// ============================================================================
// RE-EXPORTS from qos (for convenience)
// ============================================================================

export { withRetry } from '@creadev.org/qos/retry';
export type { RetryOptions } from '@creadev.org/qos/retry';
export { withTimeout } from '@creadev.org/qos/timeout';
export type { TimeoutOptions } from '@creadev.org/qos/timeout';
export { CircuitBreaker } from '@creadev.org/qos/retry';
export type { CircuitBreakerOptions } from '@creadev.org/qos/retry';

// ============================================================================
// EXPORTS BARREL
// ============================================================================

export const network = {
  fetch: networkFetch,
  fetchJson,
  fetchText,
  fetchWithRetry,
  fetchJsonWithRetry,
};

export const online = {
  isOnline,
  setOnline,
  check: checkOnline,
};

export default {
  fetch: networkFetch,
  fetchJson,
  fetchText,
  isOnline,
  setOnline,
  checkOnline,
  getStatus,
  isDomainAllowed,
  setAllowedDomains,
  getAllowedDomains,
  cacheGet,
  cacheSet,
  cacheClear,
  setCacheEnabled,
  isCacheEnabled,
  getLatency,
  getLatencyStats,
  measureLatency,
  sleep,
  isExpired,
  getCircuitStatus,
  clear,
};