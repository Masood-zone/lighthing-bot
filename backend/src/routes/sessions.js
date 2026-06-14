const express = require("express");

function createSessionsRouter({ store, pool }) {
  const router = express.Router();

  router.post("/:id/start", (req, res) => {
    const session = store.getSession(req.params.id);
    if (!session) return res.status(404).json({ error: "not_found" });

    const result = pool.enqueue(session.id);
    if (result?.duplicateAccount) {
      return res.status(409).json({
        ok: false,
        error: "account_session_locked",
        existingSessionId: result.existingSessionId,
      });
    }

    return res.json({ ok: true, queued: Boolean(result?.queued), id: session.id });
  });

  router.post("/:id/stop", (req, res) => {
    const session = store.getSession(req.params.id);
    if (!session) return res.status(404).json({ error: "not_found" });

    const wasRunning = pool.stop(session.id);
    return res.json({ ok: true, stopped: true, wasRunning });
  });

  return router;
}

module.exports = { createSessionsRouter };
