const path = require("node:path");
try {
  // eslint-disable-next-line global-require
  require("dotenv").config({
    path: path.join(__dirname, "..", ".env"),
  });
} catch {
  // ignore
}

const express = require("express");
const cors = require("cors");

const { SessionStore } = require("./store/sessionStore");
const { UserStore } = require("./store/userStore");
const { AdminRecipientStore } = require("./store/adminRecipientStore");
const { WorkerPool } = require("./queue/workerPool");
const { AuthService } = require("./services/authService");
const { EmailNotificationService } = require("./services/notifications");
const { requireAuth } = require("./middleware/requireAuth");
const { createRoutes } = require("./routes");

const PORT = Number(process.env.PORT || 3001);
const HOST =
  String(
    process.env.HOST || process.env.VISA_HOST || process.env.BIND_HOST || "",
  ).trim() || null;
const BASE_DIR = path.join(__dirname, "..");
function resolveDirFromEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const v = String(raw).trim();
  if (!v) return fallback;
  return path.isAbsolute(v) ? v : path.resolve(BASE_DIR, v);
}

const DATA_DIR = resolveDirFromEnv(
  "VISA_DATA_DIR",
  path.join(BASE_DIR, "data"),
);
const PROFILES_DIR = resolveDirFromEnv(
  "VISA_PROFILES_DIR",
  path.join(BASE_DIR, "profiles"),
);
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT ?? 2);

const app = express();
app.use(cors());
app.use(express.json({ limit: "128kb" }));

app.get("/api/health", (req, res) => {
  res.status(200).json({ ok: true });
});

const store = new SessionStore({ dataDir: DATA_DIR });
const userStore = new UserStore({ dataDir: DATA_DIR });
const adminRecipientStore = new AdminRecipientStore({
  dataDir: DATA_DIR,
  seedFilePath: path.join(BASE_DIR, "admins.json"),
});
const authService = new AuthService({
  tokenTtlMs: Number(process.env.AUTH_TOKEN_TTL_MS || 1000 * 60 * 60 * 12),
});

const notificationService = new EmailNotificationService({
  adminRecipientStore,
  sessionStore: store,
});

const ensure = userStore.ensureAdminFromEnv();
if (ensure?.created && ensure?.via === "env") {
  // eslint-disable-next-line no-console
  console.log(`Admin user created from env: ${ensure.user.email}`);
}
if (ensure?.created && ensure?.via === "generated") {
  // eslint-disable-next-line no-console
  console.log(`Dev admin user created: ${ensure.user.email}`);
  // eslint-disable-next-line no-console
  console.log(`Dev admin password (save this): ${ensure.generatedPassword}`);
}
if (ensure?.warning) {
  // eslint-disable-next-line no-console
  console.warn(`Auth warning: ${ensure.warning}`);
}

const workerEntry = path.join(__dirname, "workerEntry.js");
const pool = new WorkerPool({
  store,
  maxConcurrent: MAX_CONCURRENT,
  workerEntry,
  baseDir: BASE_DIR,
  profilesDir: PROFILES_DIR,
  notificationService,
});

const requireAuthMiddleware = requireAuth({ authService, userStore });
app.use(
  createRoutes({
    store,
    pool,
    baseDir: BASE_DIR,
    profilesDir: PROFILES_DIR,
    userStore,
    adminRecipientStore,
    authService,
    requireAuthMiddleware,
  }),
);

const listener = HOST ? app.listen(PORT, HOST) : app.listen(PORT);
listener.on("listening", () => {
  // eslint-disable-next-line no-console
  console.log(`Backend listening on http://${HOST || "localhost"}:${PORT}`);
  if (MAX_CONCURRENT <= 0) {
    // eslint-disable-next-line no-console
    console.log(
      "Workers are DISABLED (MAX_CONCURRENT=0). This service will not start Selenium sessions.",
    );
  } else {
    // eslint-disable-next-line no-console
    console.log(`Max concurrent workers: ${MAX_CONCURRENT}`);
  }
});
