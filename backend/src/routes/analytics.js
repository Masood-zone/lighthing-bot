const express = require("express");

function sanitizeVisaUser(sessionLike) {
  if (!sessionLike) return sessionLike;
  const cfg = { ...(sessionLike.config || {}) };
  const passwordSet = Boolean(cfg.passwordEnc || cfg.password);
  delete cfg.password;
  delete cfg.passwordEnc;
  delete cfg.passwordIv;
  delete cfg.passwordTag;

  const timeline = {
    dateStart: cfg.dateStart ?? null,
    dateEnd: cfg.dateEnd ?? null,
    daysFromNowMin: cfg.daysFromNowMin ?? null,
    daysFromNowMax: cfg.daysFromNowMax ?? null,
    weeksFromNowMin: cfg.weeksFromNowMin ?? null,
    weeksFromNowMax: cfg.weeksFromNowMax ?? null,
  };
  return {
    ...sessionLike,
    config: {
      ...cfg,
      passwordSet,
    },
    timeline,
  };
}

function sanitizeAdminUser(user) {
  if (!user) return user;
  const { passwordHash, ...rest } = user;
  return rest;
}

function buildAnalyticsSnapshot({ store, pool, userStore }) {
  const queueSnapshot = pool.getSnapshot();

  const visaUsers = store.listSessions().map(sanitizeVisaUser);
  const admins = userStore.listUsers().map(sanitizeAdminUser);

  const byStatus = {};
  for (const s of visaUsers) {
    const key = String(s.status || "UNKNOWN");
    byStatus[key] = (byStatus[key] || 0) + 1;
  }

  const recentCompleted = visaUsers
    .filter((s) => s.status === "COMPLETED")
    .sort((a, b) => {
      const ta = Date.parse(a.updatedAt || a.createdAt || "") || 0;
      const tb = Date.parse(b.updatedAt || b.createdAt || "") || 0;
      return tb - ta;
    })
    .slice(0, 20)
    .map((s) => ({
      id: s.id,
      status: s.status,
      updatedAt: s.updatedAt,
      lastMessage: s.lastMessage,
      email: s.config?.email,
      displayName: s.config?.displayName,
      pickupPoint: s.config?.pickupPoint,
      lastLog: Array.isArray(s.logs) ? s.logs[s.logs.length - 1] : null,
    }));

  const recentErrors = visaUsers
    .filter((s) => s.status === "ERROR" || s.status === "BLOCKED")
    .sort((a, b) => {
      const ta = Date.parse(a.updatedAt || a.createdAt || "") || 0;
      const tb = Date.parse(b.updatedAt || b.createdAt || "") || 0;
      return tb - ta;
    })
    .slice(0, 20)
    .map((s) => ({
      id: s.id,
      status: s.status,
      updatedAt: s.updatedAt,
      lastMessage: s.lastMessage,
      email: s.config?.email,
      displayName: s.config?.displayName,
      pickupPoint: s.config?.pickupPoint,
      lastLog: Array.isArray(s.logs) ? s.logs[s.logs.length - 1] : null,
    }));

  const resolveSession = (id) => {
    const s = visaUsers.find((x) => x.id === id);
    if (!s) return { id, status: "UNKNOWN" };
    return {
      id: s.id,
      status: s.status,
      updatedAt: s.updatedAt,
      lastMessage: s.lastMessage,
      email: s.config?.email,
      displayName: s.config?.displayName,
      pickupPoint: s.config?.pickupPoint,
    };
  };

  return {
    ts: new Date().toISOString(),
    admins: {
      count: admins.length,
      items: admins,
    },
    visaUsers: {
      count: visaUsers.length,
      byStatus,
    },
    queue: {
      ...queueSnapshot,
      queuedSessions: queueSnapshot.queued.map(resolveSession),
      activeSessions: queueSnapshot.active.map(resolveSession),
    },
    success: {
      recentCompleted,
    },
    issues: {
      recentErrors,
    },
  };
}

function createAnalyticsRouter({ store, pool, userStore }) {
  const router = express.Router();

  router.get("/", (req, res) => {
    res.json(buildAnalyticsSnapshot({ store, pool, userStore }));
  });

  // Real-time feed via Server-Sent Events (SSE)
  // Client can connect and receive JSON snapshots.
  router.get("/stream", (req, res) => {
    const intervalMsRaw = Number(req.query.intervalMs || 1000);
    const intervalMs = Math.max(250, Math.min(10_000, intervalMsRaw));

    res.status(200);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    let lastPayload = "";

    const send = () => {
      const snapshot = buildAnalyticsSnapshot({ store, pool, userStore });
      const payload = JSON.stringify(snapshot);
      if (payload === lastPayload) return;
      lastPayload = payload;
      res.write(`event: snapshot\ndata: ${payload}\n\n`);
    };

    // First push immediately
    send();

    const timer = setInterval(send, intervalMs);

    // Keep-alive comment to prevent some proxies from closing idle connections
    const keepAlive = setInterval(() => {
      res.write(`: ping ${Date.now()}\n\n`);
    }, 15_000);

    req.on("close", () => {
      clearInterval(timer);
      clearInterval(keepAlive);
    });
  });

  return router;
}

module.exports = { createAnalyticsRouter };
