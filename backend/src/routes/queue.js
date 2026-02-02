const express = require("express");

function createQueueRouter({ pool }) {
  const router = express.Router();

  router.get("/", (req, res) => {
    res.json(pool.getSnapshot());
  });

  return router;
}

module.exports = { createQueueRouter };
