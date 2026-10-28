const fs = require("node:fs/promises");
const path = require("node:path");

const {
  encryptSecret,
  decryptSecret,
  isSecretConfigured,
} = require("../../security/passwordCrypto");

const SESSION_FILE_NAME = "portal-session.json";
const SEEDED_MARKER = "__lightningSeeded";

// Only the fields the API client needs; cookies already live in the
// persistent Chrome profile.
const SAVED_AUTH_FIELDS = [
  "platformAuthToken",
  "authorizationHeader",
  "refreshToken",
  "csrfToken",
  "correlationKey",
  "referer",
  "userAgent",
  "languageId",
  "tokenExpiresAt",
];

function sessionFilePath(profileDir) {
  return profileDir ? path.join(profileDir, SESSION_FILE_NAME) : "";
}

function pickAuth(auth) {
  const picked = {};
  for (const field of SAVED_AUTH_FIELDS) {
    if (auth?.[field]) picked[field] = auth[field];
  }
  return picked;
}

async function readPageSessionStorage(page) {
  return page
    .evaluate((marker) => {
      const entries = {};
      for (let i = 0; i < window.sessionStorage.length; i += 1) {
        const key = window.sessionStorage.key(i);
        if (key && key !== marker) entries[key] = window.sessionStorage.getItem(key);
      }
      return { origin: window.location.origin, entries };
    }, SEEDED_MARKER)
    .catch(() => null);
}

// Encrypted with VISA_SECRET_KEY so the token is never stored in plain text.
async function savePortalSession({ profileDir, page, auth, now = Date.now }) {
  if (!profileDir || !isSecretConfigured() || !auth?.authorizationHeader) {
    return false;
  }
  const storage = await readPageSessionStorage(page);
  if (!storage?.origin) return false;

  const payload = {
    origin: storage.origin,
    sessionStorage: storage.entries,
    auth: pickAuth(auth),
    savedAt: new Date(now()).toISOString(),
  };
  const sealed = encryptSecret(JSON.stringify(payload));
  await fs.mkdir(profileDir, { recursive: true });
  await fs.writeFile(
    sessionFilePath(profileDir),
    JSON.stringify({ version: 1, ...sealed }),
    { mode: 0o600 },
  );
  return true;
}

async function loadPortalSession({ profileDir, minRemainingMs = 120_000, now = Date.now }) {
  if (!profileDir || !isSecretConfigured()) return null;
  try {
    const sealed = JSON.parse(await fs.readFile(sessionFilePath(profileDir), "utf8"));
    if (sealed?.version !== 1) return null;
    const saved = JSON.parse(decryptSecret(sealed));
    const expiry = Date.parse(saved?.auth?.tokenExpiresAt || "");
    if (!saved?.auth?.authorizationHeader || !Number.isFinite(expiry)) return null;
    if (expiry - now() < minRemainingMs) return null;
    return saved;
  } catch {
    return null;
  }
}

async function clearPortalSession(profileDir) {
  if (!profileDir) return;
  await fs.rm(sessionFilePath(profileDir), { force: true }).catch(() => {});
}

// Seeds sessionStorage once per tab before the portal's scripts run. The
// marker stops a later reload from overwriting a token the portal refreshed.
async function seedPortalSessionStorage(context, saved) {
  const entries = Object.entries(saved?.sessionStorage || {});
  if (!entries.length) return;
  await context.addInitScript(
    ({ origin, entries: items, marker }) => {
      try {
        if (window.location.origin !== origin) return;
        if (window.sessionStorage.getItem(marker)) return;
        window.sessionStorage.setItem(marker, "1");
        for (const [key, value] of items) {
          if (window.sessionStorage.getItem(key) === null) {
            window.sessionStorage.setItem(key, value);
          }
        }
      } catch {
        // Storage can be unavailable on error pages.
      }
    },
    { origin: saved.origin, entries, marker: SEEDED_MARKER },
  );
}

// The reCAPTCHA widget writes its response token into this textarea once the
// person has solved the challenge.
async function readCaptchaToken(page) {
  return page
    .evaluate(() => {
      const fields = document.querySelectorAll('textarea[name="g-recaptcha-response"]');
      for (const field of fields) {
        if (field.value && field.value.length > 20) return field.value;
      }
      return "";
    })
    .catch(() => "");
}

async function clickSignIn(page) {
  const candidates = [
    page.locator('form:has(input[formcontrolname="password"]) button[type="submit"]').first(),
    page.getByRole("button", { name: /^\s*(sign\s*in|log\s*in|login)\s*$/i }).first(),
  ];
  for (const button of candidates) {
    // eslint-disable-next-line no-await-in-loop
    const ready =
      (await button.isVisible().catch(() => false)) &&
      (await button.isEnabled().catch(() => false));
    if (ready) {
      // eslint-disable-next-line no-await-in-loop
      await button.click({ timeout: 2000 });
      return true;
    }
  }
  return false;
}

// Clicks Sign In once per solved CAPTCHA. A new token (the person re-solved an
// expired challenge) allows one more click; the same token never clicks twice.
function createLoginAutoSubmitter(page, { readToken = readCaptchaToken, click = clickSignIn } = {}) {
  let submittedToken = "";
  return async () => {
    const token = await readToken(page);
    if (!token || token === submittedToken) return false;
    const clicked = await click(page).catch(() => false);
    if (clicked) submittedToken = token;
    return clicked;
  };
}

module.exports = {
  SESSION_FILE_NAME,
  savePortalSession,
  loadPortalSession,
  clearPortalSession,
  seedPortalSessionStorage,
  readCaptchaToken,
  clickSignIn,
  createLoginAutoSubmitter,
};
