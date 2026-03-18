const express = require("express");

function toPublicAdmin(a) {
  return {
    id: a.id,
    email: a.email,
    name: a.name || "",
    active: a.active !== false,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  };
}

function createAdministratorsRouter({ adminRecipientStore }) {
  const router = express.Router();

  function requireAdminRole(req, res) {
    const role = req?.auth?.user?.role;
    if (role && role !== "ADMIN") {
      res.status(403).json({ error: "forbidden" });
      return false;
    }
    return true;
  }

  // List notification administrators (email recipients)
  router.get("/", (req, res) => {
    if (!requireAdminRole(req, res)) return;
    res.json({ admins: adminRecipientStore.listAdmins().map(toPublicAdmin) });
  });

  // Create a notification administrator (email recipient)
  router.post("/", (req, res) => {
    if (!requireAdminRole(req, res)) return;

    const { email, name, active } = req.body || {};

    if (!email || typeof email !== "string") {
      return res.status(400).json({ error: "email_required" });
    }

    try {
      const created = adminRecipientStore.createAdmin({
        email,
        name: typeof name === "string" ? name : "",
        active: active !== false,
      });
      return res.status(201).json({ admin: toPublicAdmin(created) });
    } catch (err) {
      const code = err && typeof err === "object" ? err.code : null;
      if (code === "EMAIL_TAKEN") {
        return res.status(409).json({ error: "email_taken" });
      }
      if (code === "EMAIL_REQUIRED") {
        return res.status(400).json({ error: "email_required" });
      }
      return res.status(500).json({ error: "create_failed" });
    }
  });

  // Delete a notification administrator
  router.delete("/:id", (req, res) => {
    if (!requireAdminRole(req, res)) return;

    const ok = adminRecipientStore.deleteAdmin(req.params.id);
    return res.json({ ok: true, deleted: ok });
  });

  return router;
}

module.exports = { createAdministratorsRouter };
