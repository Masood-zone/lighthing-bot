const express = require("express");

const { verifyPassword } = require("../security/passwordHash");

function getBearerToken(req) {
  const h = req.headers.authorization;
  if (!h || typeof h !== "string") return "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : "";
}

function toPublicUser(u) {
  return { id: u.id, email: u.email, role: u.role, createdAt: u.createdAt };
}

function createAuthRouter({ userStore, authService }) {
  const router = express.Router();

  router.post("/create-admin", (req, res) => {
    const { email, password, setupToken } = req.body || {};

    const envSetupToken = String(process.env.ADMIN_SETUP_TOKEN || "");
    const hasSetupTokenConfigured = Boolean(envSetupToken);
    const setupTokenValid =
      hasSetupTokenConfigured &&
      typeof setupToken === "string" &&
      setupToken === envSetupToken;

    const isProd =
      String(process.env.NODE_ENV || "").toLowerCase() === "production";

    if (isProd && !userStore.hasAdmin() && !hasSetupTokenConfigured) {
      return res.status(500).json({
        error: "admin_setup_token_missing",
        message:
          "Set ADMIN_SETUP_TOKEN in env to bootstrap the first admin in production.",
      });
    }

    // If an admin already exists, only an authenticated admin can create more admins.
    if (userStore.hasAdmin()) {
      // Optional out-of-band provisioning: if ADMIN_SETUP_TOKEN is configured and valid,
      // allow creating an admin without an existing login token.
      if (!setupTokenValid) {
        const token = getBearerToken(req);
        if (!token) {
          return res.status(401).json({
            error: "unauthorized",
            message:
              "Admin already exists. Login first and send Authorization: Bearer <token>, or configure ADMIN_SETUP_TOKEN.",
          });
        }

        const rec = authService.authenticate(token);
        if (!rec) {
          return res.status(401).json({
            error: "unauthorized",
            message:
              "Invalid/expired token. Login again and send Authorization: Bearer <token>.",
          });
        }

        const actingUser = userStore.getUser(rec.userId);
        if (!actingUser) {
          return res.status(401).json({
            error: "unauthorized",
            message: "User not found for token. Login again.",
          });
        }
        if (actingUser.role !== "ADMIN") {
          return res.status(403).json({ error: "forbidden" });
        }
      }
    } else {
      // First-admin bootstrap: require ADMIN_SETUP_TOKEN only if configured (or in production).
      if ((isProd || hasSetupTokenConfigured) && !setupTokenValid) {
        return res.status(401).json({
          error: "invalid_setup_token",
          message:
            "Provide setupToken matching ADMIN_SETUP_TOKEN (or unset ADMIN_SETUP_TOKEN in dev to allow bootstrap without it).",
        });
      }
    }

    if (!email || typeof email !== "string") {
      return res.status(400).json({ error: "email_required" });
    }
    if (!password || typeof password !== "string") {
      return res.status(400).json({ error: "password_required" });
    }

    try {
      const user = userStore.createUser({ email, password, role: "ADMIN" });
      return res.status(201).json({ user: toPublicUser(user) });
    } catch (err) {
      const code = err && typeof err === "object" ? err.code : null;
      if (code === "EMAIL_TAKEN") {
        return res.status(409).json({ error: "email_taken" });
      }
      if (code === "EMAIL_REQUIRED") {
        return res.status(400).json({ error: "email_required" });
      }
      if (code === "PASSWORD_REQUIRED") {
        return res.status(400).json({ error: "password_required" });
      }
      return res.status(500).json({ error: "create_admin_failed" });
    }
  });

  router.post("/login", (req, res) => {
    const { email, password } = req.body || {};

    if (!email || typeof email !== "string") {
      return res.status(400).json({ error: "email_required" });
    }
    if (!password || typeof password !== "string") {
      return res.status(400).json({ error: "password_required" });
    }

    const user = userStore.getByEmail(email);
    if (!user) return res.status(401).json({ error: "invalid_credentials" });

    const ok = verifyPassword(password, user.passwordHash);
    if (!ok) return res.status(401).json({ error: "invalid_credentials" });

    const issued = authService.issueToken(user.id);
    return res.json({
      token: issued.token,
      expiresAt: issued.expiresAt,
      user: toPublicUser(user),
    });
  });

  router.get("/me", (req, res) => {
    // Supports /me without requiring middleware by reading token directly.
    const auth = req.headers.authorization;
    if (!auth || typeof auth !== "string") {
      return res.status(401).json({ error: "unauthorized" });
    }
    const m = auth.match(/^Bearer\s+(.+)$/i);
    const token = m ? m[1] : "";
    if (!token) return res.status(401).json({ error: "unauthorized" });

    const rec = authService.authenticate(token);
    if (!rec) return res.status(401).json({ error: "unauthorized" });

    const user = userStore.getUser(rec.userId);
    if (!user) return res.status(401).json({ error: "unauthorized" });

    return res.json({ user: toPublicUser(user), expiresAt: rec.expiresAt });
  });

  router.post("/logout", (req, res) => {
    const auth = req.headers.authorization;
    const m = typeof auth === "string" ? auth.match(/^Bearer\s+(.+)$/i) : null;
    const token = m ? m[1] : "";
    if (token) authService.revoke(token);
    return res.json({ ok: true });
  });

  return router;
}

module.exports = { createAuthRouter };
