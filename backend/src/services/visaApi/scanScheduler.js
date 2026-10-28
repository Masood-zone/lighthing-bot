// Start-to-start availability scan pacing with server-driven backoff.
//
// The scheduler only decides how long to wait before the next scan. It never
// issues requests itself, so the worker loop stays the single owner of I/O and
// two scans from the same worker can never overlap.

const FAILURE_BACKOFF_MS = [1000, 2000, 4000, 8000, 15000];
const RATE_LIMIT_BACKOFF_MS = [5000, 10000, 20000, 40000, 60000];

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function createScanScheduler({
  pollMs = 750,
  jitterMs = 100,
  now = () => Date.now(),
  random = Math.random,
} = {}) {
  const cadenceMs = positiveNumber(pollMs, 750);
  const maxJitterMs = positiveNumber(jitterMs, 100);
  let failureStreak = 0;
  let rateLimitStreak = 0;

  function jitter() {
    return Math.floor(random() * (maxJitterMs + 1));
  }

  return {
    get throttleState() {
      if (rateLimitStreak) return `rate_limited:${rateLimitStreak}`;
      if (failureStreak) return `backoff:${failureStreak}`;
      return "normal";
    },

    // A 2xx response (with or without dates) clears every penalty.
    onSuccess() {
      failureStreak = 0;
      rateLimitStreak = 0;
    },

    // Delay until the next scan should START, measured from when the previous
    // scan started. A slow response is followed by an immediate scan.
    delayUntilNextScan(scanStartedAt) {
      const elapsed = Math.max(0, now() - Number(scanStartedAt || 0));
      return Math.max(0, cadenceMs - elapsed) + jitter();
    },

    // Network errors and 5xx: 1, 2, 4, 8, then 15 seconds.
    onFailure() {
      const delay = FAILURE_BACKOFF_MS.at(
        Math.min(failureStreak, FAILURE_BACKOFF_MS.length - 1),
      );
      failureStreak += 1;
      return delay + jitter();
    },

    // 429: honor Retry-After, otherwise 5, 10, 20, 40, then 60 seconds.
    onRateLimited(retryAfterMs) {
      const fallback = RATE_LIMIT_BACKOFF_MS.at(
        Math.min(rateLimitStreak, RATE_LIMIT_BACKOFF_MS.length - 1),
      );
      rateLimitStreak += 1;
      const serverDelay = Number(retryAfterMs);
      return Number.isFinite(serverDelay) && serverDelay > 0
        ? serverDelay
        : fallback + jitter();
    },
  };
}

// Run `fn` over `items` with at most `limit` in flight per batch. Results keep
// the input order so callers choose by preference, never by arrival time.
async function mapInBatches(items, limit, fn, { stopWhen } = {}) {
  const size = Math.max(1, Math.trunc(Number(limit) || 1));
  const results = [];
  for (let index = 0; index < items.length; index += size) {
    const batch = items.slice(index, index + size);
    // eslint-disable-next-line no-await-in-loop
    const settled = await Promise.all(batch.map((item) => fn(item)));
    results.push(...settled);
    if (stopWhen && stopWhen(settled)) break;
  }
  return results;
}

function createScanStats({ now = () => Date.now() } = {}) {
  const stats = {
    scans: 0,
    latencyTotalMs: 0,
    lastFirstAvailableDate: null,
    rateLimited: 0,
    failures: 0,
    conflicts: 0,
    fallbackAttempts: 0,
    lastHeartbeatAt: now(),
  };

  return {
    stats,
    recordScan({ latencyMs, firstAvailableDate }) {
      stats.scans += 1;
      stats.latencyTotalMs += Math.max(0, Number(latencyMs) || 0);
      if (firstAvailableDate !== undefined) {
        stats.lastFirstAvailableDate = firstAvailableDate || null;
      }
    },
    averageLatencyMs() {
      return stats.scans ? Math.round(stats.latencyTotalMs / stats.scans) : 0;
    },
    // Returns a heartbeat summary when one is due, then starts a new window.
    takeHeartbeat(intervalMs) {
      if (now() - stats.lastHeartbeatAt < intervalMs) return null;
      const summary = {
        scans: stats.scans,
        averageLatencyMs: this.averageLatencyMs(),
        lastFirstAvailableDate: stats.lastFirstAvailableDate,
        rateLimited: stats.rateLimited,
        failures: stats.failures,
        conflicts: stats.conflicts,
        fallbackAttempts: stats.fallbackAttempts,
      };
      stats.scans = 0;
      stats.latencyTotalMs = 0;
      stats.rateLimited = 0;
      stats.failures = 0;
      stats.conflicts = 0;
      stats.fallbackAttempts = 0;
      stats.lastHeartbeatAt = now();
      return summary;
    },
  };
}

module.exports = {
  createScanScheduler,
  createScanStats,
  mapInBatches,
};
