const express = require("express");

function createSessionsRouter({ store, pool }) {
  const router = express.Router();

  router.post("/:id/start", (req, res) => {
    const session = store.getSession(req.params.id);
    if (!session) return res.status(404).json({ error: "not_found" });

    pool.enqueue(session.id);
    return res.json({ ok: true, queued: true, id: session.id });
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
