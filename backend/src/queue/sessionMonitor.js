const { StringDecoder } = require("node:string_decoder");

function phaseFor(state, previous = "initializing") {
  if (state === "QUEUED") return "queued";
  if (state === "STOPPING") return "stopping";
  if (state === "COMPLETED") return "completed";
  if (state === "ERROR" || state === "BLOCKED") return "error";
  if (state === "WAITING_FOR_HOURLY_SIGN_IN") return "hourly_pause";
  if (state === "PAUSED" || state === "MANUAL_VERIFICATION_REQUIRED")
    return "manual_verification";
  if (
    /WAITING_FOR_LOGIN|WAITING_FOR_CAPTCHA|REAUTHENTICATION_REQUIRED/.test(
      state,
    )
  )
    return "login_wait";
  if (/PLATFORM_UNAVAILABLE|RATE_LIMITED|CONTEXT_ACQUISITION_WAIT/.test(state))
    return "backoff";
  if (
    /^(HUNTING|AVAILABILITY_SCAN_HEARTBEAT|NO_DATES_AVAILABLE|NO_SLOTS_AVAILABLE|DATE|DATE_SELECTED|SLOT_SELECTED|PICKUP_REFRESH|SLOT_CONFLICT|SLOT_FALLBACK)$/.test(
      state,
    )
  )
    return "scanning";
  if (
    /^(START|STARTING|LOGIN_BROWSER_STARTING|SESSION_READY|RESOLVING_APPLICATION|CONTEXT_.*)$/.test(
      state,
    )
  )
    return "initializing";
  return previous;
}

class SessionMonitor {
  constructor({
    emit,
    now = Date.now,
    schedule = setInterval,
    cancel = clearInterval,
  }) {
    this.emit = emit;
    this.now = now;
    this.schedule = schedule;
    this.cancel = cancel;
    this.records = new Map();
    this.timer = null;
  }

  update(id, state, { activity = true } = {}) {
    const time = this.now();
    const record = this.records.get(id) || {
      phase: "initializing",
      since: time,
      lastActivity: time,
    };
    if (state) {
      const phase = phaseFor(state, record.phase);
      if (phase !== record.phase) record.since = time;
      record.phase = phase;
      record.state = state;
    }
    if (activity) record.lastActivity = time;
    this.records.set(id, record);
    if (this.timer === null) {
      this.timer = this.schedule(() => this.report(), 10_000);
      this.timer?.unref?.();
    }
  }

  report() {
    const time = this.now();
    for (const [id, record] of this.records) {
      this.emit(id, {
        phase: record.phase,
        state: record.state || "STARTING",
        phaseSeconds: Math.max(0, Math.floor((time - record.since) / 1000)),
        activitySeconds: Math.max(
          0,
          Math.floor((time - record.lastActivity) / 1000),
        ),
      });
    }
  }

  remove(id) {
    this.records.delete(id);
    if (!this.records.size) this.close();
  }

  close() {
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = null;
    this.records.clear();
  }
}

function createLineReader(onLine) {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  const drain = () => {
    let end;
    while ((end = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, end).replace(/\r$/, "");
      buffer = buffer.slice(end + 1);
      if (line.trim()) onLine(line);
    }
  };
  return {
    write(chunk) {
      buffer += decoder.write(chunk);
      drain();
    },
    end() {
      buffer += decoder.end();
      drain();
      if (buffer.trim()) onLine(buffer);
      buffer = "";
    },
  };
}

module.exports = { SessionMonitor, phaseFor, createLineReader };
