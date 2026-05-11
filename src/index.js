/**
 * @creadev.org/network
 *
 * Browser-friendly network tooling for single-HTML apps.
 *
 * EXAMPLES:
 * ```javascript
 * import { network, online, fetchWithRetry } from '@creadev.org/network';
 *
 * // Check connectivity
 * if (await online.check()) { ... }
 *
 * // Fetch with retry + timeout
 * const data = await network.fetch('https://api.example.com/data');
 * ```
 * ============================================================================
 */

// Re-export from @creadev.org/qos
export { withRetry, withTimeout, timeoutSignal, CircuitBreaker } from '@creadev.org/qos';

// ============================================================================
// CONFIG
// ============================================================================

const CONFIG = {
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
let _latencyHistory = [];
let _startTime = Date.now();

// ============================================================================
// DOMAIN WHITELIST
// ============================================================================

const _allowedDomains = [];

export function isDomainAllowed(url) {
  if (_allowedDomains.length === 0) return true;
  try {
    const hostname = new URL(url).hostname;
    return _allowedDomains.some(d => hostname === d || hostname.endsWith('.' + d));
  } catch {
    return false;
  }
}

export function setAllowedDomains(domains) {
  _allowedDomains.length = 0;
  _allowedDomains.push(...domains);
}

export function getAllowedDomains() {
  return [..._allowedDomains];
}

// ============================================================================
// CONNECTIVITY
// ============================================================================

export function isOnline() {
  return _isOnline;
}

export function setOnline(status) {
  _isOnline = status;
  _lastOnlineCheck = Date.now();
}

export async function checkOnline(probeUrl = 'https://www.google.com', timeoutMs = 5000) {
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

export function getLatency() {
  if (_latencyHistory.length === 0) return 0;
  const sorted = [..._latencyHistory].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

export function getLatencyStats() {
  if (_latencyHistory.length === 0) return { avg: null, min: null, max: null, samples: 0 };
  const sum = _latencyHistory.reduce((a, b) => a + b, 0);
  return {
    avg: Math.round(sum / _latencyHistory.length),
    min: Math.min(..._latencyHistory),
    max: Math.max(..._latencyHistory),
    samples: _latencyHistory.length
  };
}

export async function measureLatency(url, sampleSize = CONFIG.LATENCY_SAMPLE_SIZE) {
  const results = [];
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

export function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

export function isExpired(timestamp, maxAgeMs) {
  return Date.now() - timestamp > maxAgeMs;
}

// ============================================================================
// CACHE (In-memory)
// ============================================================================

const _cache = new Map();

export function cacheGet(key) {
  const entry = _cache.get(key);
  if (!entry) return null;
  if (entry.expiry && Date.now() > entry.expiry) {
    _cache.delete(key);
    return null;
  }
  return entry.value;
}

export function cacheSet(key, value, ttlMs = CONFIG.CACHE_TTL) {
  _cache.set(key, {
    value,
    expiry: ttlMs ? Date.now() + ttlMs : null
  });
}

export function cacheClear() {
  _cache.clear();
}

const _networkCache = { enabled: true, ttl: CONFIG.CACHE_TTL };

export function setCacheEnabled(enabled) {
  _networkCache.enabled = enabled;
}

export function isCacheEnabled() {
  return _networkCache.enabled;
}

// ============================================================================
// NETWORK FETCH
// ============================================================================

let _circuit = null;

function getCircuit() {
  if (!_circuit) {
    _circuit = new CircuitBreaker({
      failureThreshold: CONFIG.CIRCUIT_THRESHOLD,
      resetTimeoutMs: 30000,
    });
  }
  return _circuit;
}

export async function networkFetch(url, options = {}) {
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
    if (cached) return cached;
  }

  const doFetch = async () => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(url, { method, headers, signal: controller.signal });
      clearTimeout(timeoutId);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response;
    } catch (e) {
      clearTimeout(timeoutId);
      throw e;
    }
  };

  if (useCircuit) {
    return getCircuit().execute(() => withRetry(doFetch, { retries, baseDelayMs: backoff, maxDelayMs: maxBackoff }));
  }

  return withRetry(doFetch, { retries, baseDelayMs: backoff, maxDelayMs: maxBackoff });
}

export async function fetchJson(url, options = {}) {
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

export async function fetchText(url, options = {}) {
  const response = await networkFetch(url, options);
  return response.text();
}

// ============================================================================
// SHORTCUTS
// ============================================================================

export async function fetchWithRetry(url, options = {}) {
  return networkFetch(url, { ...options, circuit: false });
}

export async function fetchJsonWithRetry(url, options = {}) {
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

export function getStatus() {
  return {
    online: _isOnline,
    lastCheck: _lastOnlineCheck,
    latency: getLatencyStats(),
    uptime: Date.now() - _startTime
  };
}

export function getCircuitStatus() {
  if (!_circuit) return { closed: true };
  return _circuit.getStatus();
}

export function clear() {
  _latencyHistory = [];
  _startTime = Date.now();
  _cache.clear();
}

// ============================================================================
// EXPORTS
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