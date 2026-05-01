const express = require("express");

function toPublicRecipient(recipient) {
  if (!recipient) return null;

  return {
    email: recipient.email,
    name: recipient.name || "",
    active: recipient.active !== false,
    createdAt: recipient.createdAt,
    updatedAt: recipient.updatedAt,
  };
}

function createNotificationsRouter({ notificationStore }) {
  const router = express.Router();

  function requireAdminRole(req, res) {
    const role = req?.auth?.user?.role;
    if (role && role !== "ADMIN") {
      res.status(403).json({ error: "forbidden" });
      return false;
    }
    return true;
  }

  router.get("/", (req, res) => {
    if (!requireAdminRole(req, res)) return;
    res.json({
      recipient: toPublicRecipient(notificationStore.getRecipient()),
    });
  });

  router.put("/", (req, res) => {
    if (!requireAdminRole(req, res)) return;

    const { email, name, active } = req.body || {};
    if (!email || typeof email !== "string") {
      return res.status(400).json({ error: "email_required" });
    }

    try {
      const recipient = notificationStore.setRecipient({
        email,
        name: typeof name === "string" ? name : "",
        active: active !== false,
      });
      return res.status(200).json({ recipient: toPublicRecipient(recipient) });
    } catch (err) {
      const code = err && typeof err === "object" ? err.code : null;
      if (code === "EMAIL_REQUIRED") {
        return res.status(400).json({ error: "email_required" });
      }
      return res.status(500).json({ error: "save_failed" });
    }
  });

  router.delete("/", (req, res) => {
    if (!requireAdminRole(req, res)) return;

    const deleted = notificationStore.clearRecipient();
    return res.json({ ok: true, deleted });
  });

  return router;
}

module.exports = { createNotificationsRouter };
