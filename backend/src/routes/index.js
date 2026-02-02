const express = require("express");

const { createHealthRouter } = require("./health");
const { createAuthRouter } = require("./auth");
const { createQueueRouter } = require("./queue");
const { createSessionsRouter } = require("./sessions");
const { createUsersRouter } = require("./users");
const { createAnalyticsRouter } = require("./analytics");

function createRoutes(deps) {
  const root = express.Router();

  // Public
  root.use(createHealthRouter());

  // Auth
  root.use("/api/auth", createAuthRouter(deps));

  // Protected APIs
  root.use("/api", deps.requireAuthMiddleware);
  root.use("/api/analytics", createAnalyticsRouter(deps));
  root.use("/api/queue", createQueueRouter(deps));
  root.use("/api/users", createUsersRouter(deps));
  root.use("/api/sessions", createSessionsRouter(deps));

  return root;
}

module.exports = { createRoutes };
