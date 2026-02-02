const express = require("express");

function createHealthRouter() {
  const router = express.Router();

  router.get("/health", (req, res) => {
    res.json({
      ok: true,
      service: "visa-bot-backend",
      ts: new Date().toISOString(),
    });
  });

  return router;
}

module.exports = { createHealthRouter };
