const express = require("express");
const path = require("node:path");
const fs = require("node:fs");

function sanitizeUser(sessionLike) {
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

function isIsoDateOnly(value) {
  // Accept YYYY-MM-DD (no time)
  if (typeof value !== "string") return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime());
}

function isNonNegativeInt(value) {
  return Number.isInteger(value) && value >= 0;
}

function coerceNullableIsoDate(value) {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;

  if (typeof value === "string") {
    // Accept YYYY-MM-DD or ISO timestamps; normalize to YYYY-MM-DD
    const candidate = value.length >= 10 ? value.slice(0, 10) : value;
    return isIsoDateOnly(candidate) ? candidate : "__invalid__";
  }

  return "__invalid__";
}

function coerceNullableNonNegativeInt(value) {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;

  if (typeof value === "number") {
    return isNonNegativeInt(value) ? value : "__invalid__";
  }

  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number.parseInt(value, 10);
    return isNonNegativeInt(parsed) ? parsed : "__invalid__";
  }

  return "__invalid__";
}

function normalizeDatePrefs(body) {
  const src = body || {};

  // Allow nested shapes from common UIs: { dateRange: { from, to } } or { dateRange: { start, end } }
  const range =
    src.dateRange && typeof src.dateRange === "object" ? src.dateRange : null;
  const nestedStart = range ? (range.from ?? range.start) : undefined;
  const nestedEnd = range ? (range.to ?? range.end) : undefined;

  const dateStart = coerceNullableIsoDate(src.dateStart ?? nestedStart);
  const dateEnd = coerceNullableIsoDate(src.dateEnd ?? nestedEnd);

  // Allow nested shapes: { daysFromNow: { min, max } } / { weeksFromNow: { min, max } }
  const daysObj =
    src.daysFromNow && typeof src.daysFromNow === "object"
      ? src.daysFromNow
      : null;
  const weeksObj =
    src.weeksFromNow && typeof src.weeksFromNow === "object"
      ? src.weeksFromNow
      : null;

  const daysFromNowMin = coerceNullableNonNegativeInt(
    src.daysFromNowMin ?? (daysObj ? daysObj.min : undefined),
  );
  const daysFromNowMax = coerceNullableNonNegativeInt(
    src.daysFromNowMax ?? (daysObj ? daysObj.max : undefined),
  );
  const weeksFromNowMin = coerceNullableNonNegativeInt(
    src.weeksFromNowMin ?? (weeksObj ? weeksObj.min : undefined),
  );
  const weeksFromNowMax = coerceNullableNonNegativeInt(
    src.weeksFromNowMax ?? (weeksObj ? weeksObj.max : undefined),
  );

  return {
    dateStart,
    dateEnd,
    daysFromNowMin,
    daysFromNowMax,
    weeksFromNowMin,
    weeksFromNowMax,
  };
}

function createUsersRouter({ store, pool, baseDir }) {
  const router = express.Router();

  // List users
  router.get("/", (req, res) => {
    res.json(store.listSessions().map(sanitizeUser));
  });

  // Get user details
  router.get("/:id", (req, res) => {
    const user = store.getSession(req.params.id);
    if (!user) return res.status(404).json({ error: "not_found" });
    return res.json(sanitizeUser(user));
  });

  // Get user logs
  router.get("/:id/logs", (req, res) => {
    const user = store.getSession(req.params.id);
    if (!user) return res.status(404).json({ error: "not_found" });

    const tail = Math.max(1, Math.min(1000, Number(req.query.tail || 200)));
    const logs = Array.isArray(user.logs) ? user.logs.slice(-tail) : [];
    return res.json({ id: user.id, logs });
  });

  // Create user
  router.post("/", (req, res) => {
    const {
      loginUrl,
      email,
      password,
      displayName,
      pickupPoint = "Accra",
      headless = false,
    } = req.body || {};

    const {
      dateStart,
      dateEnd,
      daysFromNowMin,
      daysFromNowMax,
      weeksFromNowMin,
      weeksFromNowMax,
    } = normalizeDatePrefs(req.body);

    if (!loginUrl || typeof loginUrl !== "string") {
      return res.status(400).json({ error: "loginUrl_required" });
    }
    if (!email || typeof email !== "string") {
      return res.status(400).json({ error: "email_required" });
    }
    if (!password || typeof password !== "string") {
      return res.status(400).json({ error: "password_required" });
    }
    if (!displayName || typeof displayName !== "string") {
      return res.status(400).json({ error: "displayName_required" });
    }

    if (dateStart === "__invalid__") {
      return res.status(400).json({ error: "dateStart_invalid" });
    }
    if (dateEnd === "__invalid__") {
      return res.status(400).json({ error: "dateEnd_invalid" });
    }
    if (isIsoDateOnly(dateStart) && isIsoDateOnly(dateEnd)) {
      if (dateStart > dateEnd) {
        return res.status(400).json({ error: "dateRange_invalid" });
      }
    }

    const numFields = [
      ["daysFromNowMin", daysFromNowMin],
      ["daysFromNowMax", daysFromNowMax],
      ["weeksFromNowMin", weeksFromNowMin],
      ["weeksFromNowMax", weeksFromNowMax],
    ];
    for (const [name, value] of numFields) {
      if (value === undefined || value === null) continue;
      if (value === "__invalid__") {
        return res.status(400).json({ error: `${name}_invalid` });
      }
      if (!isNonNegativeInt(value)) {
        return res.status(400).json({ error: `${name}_invalid` });
      }
    }
    if (
      daysFromNowMin !== undefined &&
      daysFromNowMax !== undefined &&
      daysFromNowMin !== null &&
      daysFromNowMax !== null &&
      isNonNegativeInt(daysFromNowMin) &&
      isNonNegativeInt(daysFromNowMax) &&
      daysFromNowMin > daysFromNowMax
    ) {
      return res.status(400).json({ error: "daysFromNowRange_invalid" });
    }
    if (
      weeksFromNowMin !== undefined &&
      weeksFromNowMax !== undefined &&
      weeksFromNowMin !== null &&
      weeksFromNowMax !== null &&
      isNonNegativeInt(weeksFromNowMin) &&
      isNonNegativeInt(weeksFromNowMax) &&
      weeksFromNowMin > weeksFromNowMax
    ) {
      return res.status(400).json({ error: "weeksFromNowRange_invalid" });
    }

    try {
      const user = store.createSession({
        loginUrl,
        email,
        password,
        displayName,
        pickupPoint,
        headless,
        dateStart,
        dateEnd,
        daysFromNowMin,
        daysFromNowMax,
        weeksFromNowMin,
        weeksFromNowMax,
      });

      return res.status(201).json({ id: user.id, user: sanitizeUser(user) });
    } catch (err) {
      if (err?.code === "SECRET_KEY_MISSING") {
        return res.status(500).json({
          error: "secret_key_missing",
          message:
            "Server is not configured to encrypt passwords. Set VISA_SECRET_KEY in the environment.",
        });
      }
      return res
        .status(500)
        .json({ error: "create_failed", message: String(err?.message || err) });
    }
  });

  // Update user
  router.put("/:id", (req, res) => {
    const user = store.getSession(req.params.id);
    if (!user) return res.status(404).json({ error: "not_found" });

    if (user.status === "RUNNING" || user.status === "QUEUED") {
      return res.status(409).json({
        error: "user_busy",
        message: "Stop the booking hunt before updating.",
      });
    }

    const { loginUrl, email, password, displayName, pickupPoint, headless } =
      req.body || {};

    const {
      dateStart,
      dateEnd,
      daysFromNowMin,
      daysFromNowMax,
      weeksFromNowMin,
      weeksFromNowMax,
    } = normalizeDatePrefs(req.body);

    if (loginUrl !== undefined && (typeof loginUrl !== "string" || !loginUrl)) {
      return res.status(400).json({ error: "loginUrl_invalid" });
    }
    if (email !== undefined && (typeof email !== "string" || !email)) {
      return res.status(400).json({ error: "email_invalid" });
    }
    if (password !== undefined && (typeof password !== "string" || !password)) {
      return res.status(400).json({ error: "password_invalid" });
    }
    if (
      displayName !== undefined &&
      (typeof displayName !== "string" || !displayName)
    ) {
      return res.status(400).json({ error: "displayName_invalid" });
    }
    if (
      pickupPoint !== undefined &&
      (typeof pickupPoint !== "string" || !pickupPoint)
    ) {
      return res.status(400).json({ error: "pickupPoint_invalid" });
    }

    if (dateStart === "__invalid__") {
      return res.status(400).json({ error: "dateStart_invalid" });
    }
    if (dateEnd === "__invalid__") {
      return res.status(400).json({ error: "dateEnd_invalid" });
    }
    // If both present in the request, enforce ordering
    if (isIsoDateOnly(dateStart) && isIsoDateOnly(dateEnd)) {
      if (dateStart > dateEnd) {
        return res.status(400).json({ error: "dateRange_invalid" });
      }
    }

    const numFields2 = [
      ["daysFromNowMin", daysFromNowMin],
      ["daysFromNowMax", daysFromNowMax],
      ["weeksFromNowMin", weeksFromNowMin],
      ["weeksFromNowMax", weeksFromNowMax],
    ];
    for (const [name, value] of numFields2) {
      if (value === undefined || value === null) continue;
      if (value === "__invalid__") {
        return res.status(400).json({ error: `${name}_invalid` });
      }
      if (!isNonNegativeInt(value)) {
        return res.status(400).json({ error: `${name}_invalid` });
      }
    }
    if (
      daysFromNowMin !== undefined &&
      daysFromNowMax !== undefined &&
      daysFromNowMin !== null &&
      daysFromNowMax !== null &&
      isNonNegativeInt(daysFromNowMin) &&
      isNonNegativeInt(daysFromNowMax) &&
      daysFromNowMin > daysFromNowMax
    ) {
      return res.status(400).json({ error: "daysFromNowRange_invalid" });
    }
    if (
      weeksFromNowMin !== undefined &&
      weeksFromNowMax !== undefined &&
      weeksFromNowMin !== null &&
      weeksFromNowMax !== null &&
      isNonNegativeInt(weeksFromNowMin) &&
      isNonNegativeInt(weeksFromNowMax) &&
      weeksFromNowMin > weeksFromNowMax
    ) {
      return res.status(400).json({ error: "weeksFromNowRange_invalid" });
    }

    try {
      const updated = store.updateSession(user.id, {
        ...(loginUrl !== undefined ? { loginUrl } : null),
        ...(email !== undefined ? { email } : null),
        ...(password !== undefined ? { password } : null),
        ...(displayName !== undefined ? { displayName } : null),
        ...(pickupPoint !== undefined ? { pickupPoint } : null),
        ...(headless !== undefined ? { headless } : null),
        ...(dateStart !== undefined ? { dateStart } : null),
        ...(dateEnd !== undefined ? { dateEnd } : null),
        ...(daysFromNowMin !== undefined ? { daysFromNowMin } : null),
        ...(daysFromNowMax !== undefined ? { daysFromNowMax } : null),
        ...(weeksFromNowMin !== undefined ? { weeksFromNowMin } : null),
        ...(weeksFromNowMax !== undefined ? { weeksFromNowMax } : null),
      });

      return res.json({ ok: true, user: sanitizeUser(updated) });
    } catch (err) {
      if (err?.code === "SECRET_KEY_MISSING") {
        return res.status(500).json({
          error: "secret_key_missing",
          message:
            "Server is not configured to encrypt passwords. Set VISA_SECRET_KEY in the environment.",
        });
      }
      return res
        .status(500)
        .json({ error: "update_failed", message: String(err?.message || err) });
    }
  });

  // Delete user
  router.delete("/:id", (req, res) => {
    const user = store.getSession(req.params.id);
    if (!user) return res.status(404).json({ error: "not_found" });

    // Stop if queued/running (best-effort)
    pool.stop(user.id);

    const deleted = store.deleteSession(user.id);

    // Best-effort cleanup of Chrome profile directory
    try {
      const profileDir = path.join(baseDir, "profiles", user.id);
      fs.rmSync(profileDir, { recursive: true, force: true });
    } catch {
      // ignore
    }

    return res.json({ ok: true, deleted });
  });

  return router;
}

module.exports = { createUsersRouter };
