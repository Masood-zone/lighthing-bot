const SECRET_KEY_RE =
  /authorization|refreshtoken|refresh[-_]?token|access[-_]?token|auth[-_]?token|captcha|cookie|csrf|password|jwt/i;

const TOKEN_RE =
  /\b(?:Bearer\s+)?eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;

function redactString(value) {
  return String(value ?? "")
    .replace(TOKEN_RE, "<redacted-token>")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{20,}/gi, "Bearer <redacted-token>")
    .replace(
      /(authorization|refreshtoken|csrfToken|authToken|captchaToken|password)\s*[:=]\s*[^,\s;}]+/gi,
      "$1=<redacted>",
    );
}

function redact(value, seen = new WeakSet()) {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactString(value);
  if (typeof value !== "object") return value;

  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redact(item, seen));
  }

  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_KEY_RE.test(key)) {
      output[key] = "<redacted>";
    } else {
      output[key] = redact(item, seen);
    }
  }
  return output;
}

function safeJson(value) {
  try {
    return JSON.stringify(redact(value));
  } catch {
    return redactString(String(value));
  }
}

module.exports = { redact, redactString, safeJson };
