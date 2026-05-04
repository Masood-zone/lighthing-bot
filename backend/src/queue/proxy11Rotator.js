function normalizeProxyUrl(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return "";
  if (/^[a-z]+:\/\//i.test(trimmed)) return trimmed;
  return `http://${trimmed}`;
}

function hashString(value) {
  let hash = 0x811c9dc5;
  const str = String(value || "");
  for (let i = 0; i < str.length; i += 1) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function describeProxyUrl(raw) {
  const value = String(raw || "").trim();
  if (!value) return "";

  const fingerprint = hashString(value).toString(16).padStart(8, "0");

  try {
    const parsed = new URL(value);
    return `${parsed.protocol}//${parsed.host}#${fingerprint}`;
  } catch {
    return `proxy#${fingerprint}`;
  }
}

function sanitizeApiUrl(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return "";

  try {
    const url = new URL(trimmed);
    url.searchParams.delete("key");
    url.searchParams.delete("apiKey");
    url.searchParams.delete("apikey");
    return url.toString();
  } catch {
    return trimmed;
  }
}

function buildProxy11ApiUrl(baseUrl, apiKey) {
  const trimmedBase = String(baseUrl || "").trim();
  const trimmedKey = String(apiKey || "").trim();
  if (!trimmedBase || !trimmedKey) return "";

  const normalizedBase = /^[a-z]+:\/\//i.test(trimmedBase)
    ? trimmedBase
    : `http://${trimmedBase}`;

  const url = new URL(normalizedBase);
  url.searchParams.set("key", trimmedKey);
  return url.toString();
}

function buildProxyUrlFromEntry(entry, fallbackPort = "") {
  const ip = String(entry?.ip || "").trim();
  if (!ip) return "";

  const rawPort =
    String(entry?.port || "").trim() || String(fallbackPort || "").trim();
  const protocol = Number(entry?.type) === 1 ? "https" : "http";
  return normalizeProxyUrl(
    `${protocol}://${ip}${rawPort ? `:${rawPort}` : ""}`,
  );
}

class Proxy11Rotator {
  constructor({
    baseUrl,
    apiKey,
    fallbackPort,
    maxEntries = 50,
    refreshMs = 10 * 60 * 1000,
    requestTimeoutMs = 15000,
  } = {}) {
    this.apiUrl = buildProxy11ApiUrl(baseUrl, apiKey);
    this.fallbackPort = String(fallbackPort || "").trim();
    this.maxEntries = Math.min(50, Math.max(1, Number(maxEntries) || 50));
    this.refreshMs = Math.max(60_000, Number(refreshMs) || 10 * 60 * 1000);
    this.requestTimeoutMs = Math.max(3000, Number(requestTimeoutMs) || 15000);

    this.pool = [];
    this.loadedAt = 0;
    this.nextIndex = 0;
    this.loadingPromise = null;
    this.lastError = null;

    if (this.apiUrl) {
      // eslint-disable-next-line no-console
      console.log(
        `[INFO] Proxy11 rotator configured: ${sanitizeApiUrl(this.apiUrl)}`,
      );
    } else {
      // eslint-disable-next-line no-console
      console.warn(
        "[WARN] Proxy11 rotator not configured; falling back to legacy proxy settings.",
      );
    }
  }

  isConfigured() {
    return Boolean(this.apiUrl);
  }

  getStatus() {
    return {
      configured: this.isConfigured(),
      apiUrl: sanitizeApiUrl(this.apiUrl),
      poolSize: this.pool.length,
      loadedAt: this.loadedAt || null,
      nextIndex: this.nextIndex,
      lastError: this.lastError
        ? String(this.lastError.message || this.lastError)
        : null,
    };
  }

  async getPool({ force = false } = {}) {
    if (!this.isConfigured()) {
      return this.pool;
    }

    const stale =
      !this.loadedAt || Date.now() - this.loadedAt >= this.refreshMs;
    if (!force && this.pool.length > 0 && !stale) {
      return this.pool;
    }

    if (this.loadingPromise) {
      return this.loadingPromise;
    }

    this.loadingPromise = this._loadPool().finally(() => {
      this.loadingPromise = null;
    });

    return this.loadingPromise;
  }

  async _loadPool() {
    if (!this.isConfigured()) {
      return this.pool;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    try {
      const response = await fetch(this.apiUrl, {
        signal: controller.signal,
        headers: {
          accept: "application/json",
        },
      });

      if (!response.ok) {
        throw new Error(`Proxy11 API returned HTTP ${response.status}`);
      }

      const payload = await response.json();
      const rawEntries = Array.isArray(payload)
        ? payload
        : Array.isArray(payload?.data)
          ? payload.data
          : [];

      const pool = [];
      const seen = new Set();

      for (const entry of rawEntries) {
        const proxyUrl = buildProxyUrlFromEntry(entry, this.fallbackPort);
        if (!proxyUrl || seen.has(proxyUrl)) {
          continue;
        }

        seen.add(proxyUrl);
        pool.push({
          proxyUrl,
          ip: String(entry?.ip || "").trim(),
          port: String(entry?.port || this.fallbackPort || "").trim(),
          country: String(entry?.country || "").trim(),
          countryCode: String(
            entry?.country_code || entry?.countryCode || "",
          ).trim(),
          time: Number(entry?.time ?? NaN),
          timestamp: Number(entry?.timestamp ?? NaN),
          type: Number(entry?.type ?? NaN),
        });

        if (pool.length >= this.maxEntries) {
          break;
        }
      }

      this.pool = pool;
      this.loadedAt = Date.now();
      this.lastError = null;
      return this.pool;
    } catch (error) {
      this.lastError = error;
      return this.pool;
    } finally {
      clearTimeout(timeout);
    }
  }

  async acquire({ sessionId, activeProxyUrls = new Set() } = {}) {
    const pool = await this.getPool();
    if (!pool.length) {
      return null;
    }

    const reserved =
      activeProxyUrls instanceof Set
        ? activeProxyUrls
        : new Set(activeProxyUrls);
    const startIndex = this.nextIndex % pool.length;

    let selectedIndex = -1;
    let reused = false;

    for (let offset = 0; offset < pool.length; offset += 1) {
      const candidateIndex = (startIndex + offset) % pool.length;
      const candidate = pool[candidateIndex];
      if (!reserved.has(candidate.proxyUrl)) {
        selectedIndex = candidateIndex;
        break;
      }
    }

    if (selectedIndex < 0) {
      selectedIndex = startIndex;
      reused = true;
    }

    const selected = pool[selectedIndex];
    this.nextIndex = (selectedIndex + 1) % pool.length;

    return {
      sessionId,
      proxyUrl: selected.proxyUrl,
      proxyIndex: selectedIndex,
      proxySource: reused ? "proxy11-reuse" : "proxy11",
      poolSize: pool.length,
      proxyLabel: describeProxyUrl(selected.proxyUrl),
      proxyMeta: {
        ip: selected.ip,
        port: selected.port,
        country: selected.country,
        countryCode: selected.countryCode,
        time: selected.time,
      },
    };
  }
}

module.exports = {
  Proxy11Rotator,
  buildProxy11ApiUrl,
  describeProxyUrl,
  normalizeProxyUrl,
};
