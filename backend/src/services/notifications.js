let nodemailer = null;
try {
  // eslint-disable-next-line global-require
  nodemailer = require("nodemailer");
} catch {
  nodemailer = null;
}

function nowIso() {
  return new Date().toISOString();
}

function readBoolEnv(name) {
  const v = process.env[name];
  if (v === undefined) return undefined;
  return v === "1" || String(v).toLowerCase() === "true";
}

function normalizeEmail(email) {
  return String(email || "")
    .trim()
    .toLowerCase();
}

function safeOneLine(value) {
  return String(value ?? "")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function getSmtpTransportConfigFromEnv() {
  const service = safeOneLine(process.env.SMTP_SERVICE);
  const hostRaw = safeOneLine(process.env.SMTP_HOST);
  const port = Number(process.env.SMTP_PORT || 587);

  const secureEnv = readBoolEnv("SMTP_SECURE");
  const secure = secureEnv === undefined ? port === 465 : Boolean(secureEnv);

  const user = String(process.env.SMTP_USER || "").trim();
  const pass = String(process.env.SMTP_PASS || "").trim();

  const fromRaw = String(process.env.SMTP_FROM || "").trim();
  const from = fromRaw || user;

  const poolEnv = readBoolEnv("SMTP_POOL");
  const pool = poolEnv === undefined ? true : Boolean(poolEnv);

  const maxConnections = Math.max(
    1,
    Number(process.env.SMTP_MAX_CONNECTIONS || 2),
  );

  // Interpret a simple host like "gmail" as a Nodemailer service name.
  const inferredService =
    !service && hostRaw && !hostRaw.includes(".") && !hostRaw.includes(":")
      ? hostRaw
      : "";

  return {
    configured: Boolean(
      (service || inferredService || hostRaw) && user && pass && from,
    ),
    service: service || inferredService,
    host: hostRaw,
    port,
    secure,
    auth: { user, pass },
    from,
    pool,
    maxConnections,
  };
}

class EmailNotificationService {
  /**
   * @param {{ adminRecipientStore: any, notificationStore?: any, sessionStore?: any }} deps
   */
  constructor({ adminRecipientStore, notificationStore, sessionStore } = {}) {
    this.adminRecipientStore = adminRecipientStore;
    this.notificationStore = notificationStore || null;
    this.sessionStore = sessionStore || null;

    this.queue = [];
    this.inFlight = 0;

    this.maxConcurrent = Math.max(
      1,
      Number(process.env.NOTIFICATIONS_CONCURRENCY || 2),
    );

    this.maxQueueSize = Math.max(
      1,
      Number(process.env.NOTIFICATIONS_MAX_QUEUE || 2000),
    );

    this._tickScheduled = false;
    this._transport = null;
  }

  isConfigured() {
    const cfg = getSmtpTransportConfigFromEnv();
    return cfg.configured && Boolean(nodemailer);
  }

  _getTransport() {
    if (this._transport) return this._transport;

    const cfg = getSmtpTransportConfigFromEnv();
    if (!cfg.configured) return null;
    if (!nodemailer) return null;

    const options = {
      pool: cfg.pool,
      maxConnections: cfg.maxConnections,
      secure: cfg.secure,
      auth: cfg.auth,
    };

    if (cfg.service) {
      options.service = cfg.service;
    } else {
      options.host = cfg.host;
      options.port = cfg.port;
    }

    this._transport = nodemailer.createTransport(options);
    return this._transport;
  }

  _scheduleTick() {
    if (this._tickScheduled) return;
    this._tickScheduled = true;
    setImmediate(() => {
      this._tickScheduled = false;
      this._tick();
    });
  }

  _enqueue(job) {
    if (this.queue.length >= this.maxQueueSize) {
      // eslint-disable-next-line no-console
      console.warn(
        `[notifications] queue full (${this.queue.length}); dropping job ${job?.type || "unknown"}`,
      );
      return false;
    }

    this.queue.push(job);
    this._scheduleTick();
    return true;
  }

  enqueueBookingSuccess({ sessionId, session, booking } = {}) {
    const ok = this._enqueue({
      type: "BOOKING_SUCCESS",
      sessionId: String(sessionId || ""),
      session: session || null,
      booking: booking || null,
      ts: nowIso(),
    });

    return ok;
  }

  enqueueBookingClick({ sessionId, session, booking } = {}) {
    const ok = this._enqueue({
      type: "BOOKING_CLICKED",
      sessionId: String(sessionId || ""),
      session: session || null,
      booking: booking || null,
      ts: nowIso(),
    });

    return ok;
  }

  _tick() {
    while (this.inFlight < this.maxConcurrent && this.queue.length > 0) {
      const job = this.queue.shift();
      if (!job) break;

      this.inFlight += 1;

      Promise.resolve()
        .then(() => this._runJob(job))
        .catch((err) => {
          // eslint-disable-next-line no-console
          console.error(
            `[notifications] job failed (${job?.type || "unknown"}):`,
            safeOneLine(err?.message || err),
          );
        })
        .finally(() => {
          this.inFlight -= 1;
          this._scheduleTick();
        });
    }
  }

  async _runJob(job) {
    if (!job || typeof job !== "object") return;

    if (job.type === "BOOKING_SUCCESS") {
      await this._sendBookingSuccess(job);
    } else if (job.type === "BOOKING_CLICKED") {
      await this._sendBookingClicked(job);
    }
  }

  async _sendBookingClicked(job) {
    const transport = this._getTransport();
    if (!transport) {
      // eslint-disable-next-line no-console
      console.warn(
        "[notifications] SMTP not configured (or nodemailer missing); skipping click email.",
      );
      return;
    }

    const recipients = this._getActiveRecipientEmails();
    if (recipients.length === 0) {
      return;
    }

    const cfg = getSmtpTransportConfigFromEnv();

    const session = job.session || null;
    const displayName = safeOneLine(session?.config?.displayName);
    const applicantEmail = safeOneLine(session?.config?.email);
    const pickupPoint = safeOneLine(session?.config?.pickupPoint);
    const reschedule = Boolean(session?.config?.reschedule);

    const attemptedDate = safeOneLine(
      job?.booking?.dateKey || job?.booking?.date,
    );
    const timeSlot = safeOneLine(job?.booking?.timeSlot);

    const subjectBase =
      displayName || applicantEmail || job.sessionId || "Session";
    const subject = `BOOK CLICKED: ${subjectBase}`;

    const lines = [
      "A booking click was initiated by a worker (confirmation pending).",
      "",
      `Session ID: ${safeOneLine(job.sessionId) || "(unknown)"}`,
      `Applicant: ${displayName || "(unknown)"}${applicantEmail ? ` <${applicantEmail}>` : ""}`,
      `Pickup point: ${pickupPoint || "(unknown)"}`,
      `Mode: ${reschedule ? "RESCHEDULE" : "PENDING"}`,
      `Attempted date: ${attemptedDate || "(unknown)"}`,
      `Time slot: ${timeSlot || "(unknown)"}`,
      `Timestamp: ${safeOneLine(job.ts)}`,
      "",
      "This is an automated notification from lighthing-bot.",
    ];

    const from = cfg.from;

    const mail = {
      from,
      to: from,
      bcc: recipients,
      subject,
      text: lines.join("\n"),
    };

    await transport.sendMail(mail);

    if (
      this.sessionStore &&
      typeof this.sessionStore.appendLog === "function"
    ) {
      this.sessionStore.appendLog(
        job.sessionId,
        "info",
        `Click notification sent to ${recipients.length} administrator(s)`,
      );
    }
  }

  _getActiveRecipientEmails() {
    if (this.notificationStore) {
      const recipient =
        typeof this.notificationStore.getRecipient === "function"
          ? this.notificationStore.getRecipient()
          : null;

      const singleEmail = normalizeEmail(recipient?.email);
      if (singleEmail && recipient?.active !== false) {
        return [singleEmail];
      }

      return [];
    }

    const list =
      this.adminRecipientStore &&
      typeof this.adminRecipientStore.listAdmins === "function"
        ? this.adminRecipientStore.listAdmins()
        : [];

    const emails = [];
    for (const a of list) {
      if (!a || a.active === false) continue;
      const e = normalizeEmail(a.email);
      if (!e) continue;
      emails.push(e);
    }

    // de-dupe while keeping order
    const seen = new Set();
    const out = [];
    for (const e of emails) {
      if (seen.has(e)) continue;
      seen.add(e);
      out.push(e);
    }

    return out;
  }

  async _sendBookingSuccess(job) {
    const transport = this._getTransport();
    if (!transport) {
      // eslint-disable-next-line no-console
      console.warn(
        "[notifications] SMTP not configured (or nodemailer missing); skipping email.",
      );
      return;
    }

    const recipients = this._getActiveRecipientEmails();
    if (recipients.length === 0) {
      return;
    }

    const cfg = getSmtpTransportConfigFromEnv();

    const session = job.session || null;
    const displayName = safeOneLine(session?.config?.displayName);
    const applicantEmail = safeOneLine(session?.config?.email);
    const pickupPoint = safeOneLine(session?.config?.pickupPoint);
    const reschedule = Boolean(session?.config?.reschedule);

    const bookedDate = safeOneLine(job?.booking?.dateKey || job?.booking?.date);
    const timeSlot = safeOneLine(job?.booking?.timeSlot);

    const subjectBase =
      displayName || applicantEmail || job.sessionId || "Session";
    const subject = `BOOKED: ${subjectBase}`;

    const lines = [
      "A visa appointment booking was reported as successful.",
      "",
      `Session ID: ${safeOneLine(job.sessionId) || "(unknown)"}`,
      `Applicant: ${displayName || "(unknown)"}${applicantEmail ? ` <${applicantEmail}>` : ""}`,
      `Pickup point: ${pickupPoint || "(unknown)"}`,
      `Mode: ${reschedule ? "RESCHEDULE" : "PENDING"}`,
      `Booked date: ${bookedDate || "(unknown)"}`,
      `Time slot: ${timeSlot || "(unknown)"}`,
      `Timestamp: ${safeOneLine(job.ts)}`,
      "",
      "This is an automated notification from lighthing-bot.",
    ];

    const from = cfg.from;

    // Use `to` as the sender identity and `bcc` for admin recipients.
    const mail = {
      from,
      to: from,
      bcc: recipients,
      subject,
      text: lines.join("\n"),
    };

    await transport.sendMail(mail);

    if (
      this.sessionStore &&
      typeof this.sessionStore.appendLog === "function"
    ) {
      this.sessionStore.appendLog(
        job.sessionId,
        "info",
        `Email notification sent to ${recipients.length} administrator(s)`,
      );
    }
  }
}

module.exports = { EmailNotificationService };
