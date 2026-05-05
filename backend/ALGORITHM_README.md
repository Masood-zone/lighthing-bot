# Visa Booking Bot — Algorithm (Automation Worker)

This file documents the _actual runtime algorithm_ executed by the automation worker and how it interacts with the backend.

## Files involved

- API server: `backend/src/server.js`
- Worker pool (forks workers, receives statuses): `backend/src/queue/workerPool.js`
- Worker entry (fork target): `backend/src/workerEntry.js`
- Automation worker (the algorithm): `backend/main/index.js`
- CAPTCHA solver module: `backend/main/captcha-solver.js`
- Admin email notifications: `backend/src/services/notifications.js`

## Configuration inputs (what controls behavior)

### Worker environment variables (core)

- `VISA_PLATFORM_URL` — login URL (defaults to the usvisaappt login route)
- `VISA_USER_EMAIL`, `VISA_USER_PASSWORD`, `VISA_USER_DISPLAY_NAME`
- `VISA_PICKUP_POINT` (default: `Accra`)
- `VISA_RESCHEDULE` — `true|false`
- `VISA_HEADLESS` — `true|false`
- `VISA_PROFILE_DIR` — Chrome user-data-dir path (set by the server per session)
- `VISA_SESSION_ID` — used for backend logs/status association
- `RECAPTCHA_API_KEY` — 2Captcha API key for automated CAPTCHA solving
- `RECAPTCHA_SITE_KEY` — Optional override for the reCAPTCHA site key (auto-detected if not set)
- `RECAPTCHA_SITE_URL` — The login page URL where CAPTCHA appears
- `PROXY_HOST` / `PROXY_API_KEY` — Proxy11 rotator API endpoint and key used to fetch the proxy list
- `PROXY_PORT` — optional fallback port when the API response omits a port value
- `VISA_PROXY_URL` — optional proxy for a worker (format: `http[s]://user:pass@host:port` or `socks5://host:port`)
- `VISA_PROXY_POOL` — legacy fallback comma/newline-separated list of proxy URLs
- `VISA_PROXY_POOL_FILE` — legacy fallback path to a text file with one proxy URL per line
- `VISA_PROXY_BYPASS` — optional bypass list passed to Playwright (comma-separated host globs)

Proxy11 is now the primary rotator. On worker start, the backend requests `PROXY_HOST?key=PROXY_API_KEY`, reads up to 50 proxy records from the response, and assigns one proxy per active session before Chrome launches. Each worker gets a distinct `VISA_PROXY_URL` like `http://185.238.228.22:80` and the assignment is logged.

If you prefer to manage the pool outside the environment file, the legacy `backend/data/proxy-pool.txt` fallback is still supported when Proxy11 is unavailable.

Individual sessions may also carry a stored `proxyUrl` override. When present and Proxy11 is unavailable, that worker can still use the stored proxy directly.

The backend logs which Proxy11 entry was assigned to each session using a sanitized proxy label and short fingerprint. That lets you verify that concurrent browser sessions are being spread across different proxy entries without exposing credentials in the logs.

When multiple sessions run at once, Proxy11 is the setting that spreads them across different IPs. `VISA_PROXY_URL` is now only a single-proxy fallback and will still send every session through the same IP if Proxy11 and the legacy pool are not configured.
For best isolation, keep the Proxy11 response set at least as large as `MAX_CONCURRENT`; otherwise the rotator may eventually reuse an IP when all available proxies are already reserved.

### Date-range filtering (green dates must be inside this window)

Preferred:

- `VISA_MIN_DATE` / `VISA_MAX_DATE` (format: `YYYY-MM-DD`)

Fallback:

- `VISA_DATE_START` / `VISA_DATE_END` (format: `YYYY-MM-DD`)

### Attempt pacing / rate limiting

- `VISA_ATTEMPT_INTERVAL_MS` (default: `300`)
- `VISA_ATTEMPT_BURST_INTERVAL_MS` (default: `250`)
- `VISA_CALENDAR_MAX_MONTHS` (default: `6`)

### Server-side worker capacity

- `MAX_CONCURRENT` — how many sessions can run at once
- `FORCE_VISIBLE_BROWSER=true` — forces workers to run non-headless (overrides session setting)

## End-to-end algorithm (what the bot does)

### 1) Startup (backend)

1. Backend starts (`backend/src/server.js`).
2. `WorkerPool` forks `backend/src/workerEntry.js` for a session.
3. Worker entry loads the algorithm (`require("../main/index")`).

### 2) Login (worker) — Fully Automated

1. Worker opens Chrome and navigates to `VISA_PLATFORM_URL`.
2. Worker fills email + password.
3. **Automated CAPTCHA Solving:**
   - Worker detects the reCAPTCHA on the login page.
   - Worker extracts the site key from the page DOM.
   - Worker sends the CAPTCHA to 2Captcha service via the `@2captcha/captcha-solver` package.
   - 2Captcha returns a solved token (typically within 15-45 seconds).
   - Worker injects the token into the page's reCAPTCHA response field.
   - Worker triggers the reCAPTCHA callback to activate the Sign In button.
4. Worker clicks the **SIGN IN** button automatically.
5. Worker waits until dashboard is detected.
6. **Fallback:** If 2Captcha solving fails (API error, timeout, etc.), the worker logs the error and falls back to the manual CAPTCHA wait state, allowing human intervention.

### 3) Navigate to appointment booking page

- If `VISA_RESCHEDULE=false` (PENDING mode):
  1. Go to dashboard.
  2. Click the **PENDING APPOINTMENT REQUEST** tile.
  3. Wait until the booking block `.ofc-book-slot-block` fully loads.

- If `VISA_RESCHEDULE=true` (RESCHEDULE mode):
  1. Navigate directly to **My Appointments**.
  2. Click **RESCHEDULE**.
  3. Confirm in the modal.
  4. Wait until the booking block `.ofc-book-slot-block` fully loads.

### 4) Monitoring loop (repeats until booked)

The main loop is in the `main()` function.

On each cycle:

1. Run `attemptBooking()`.
2. If it returns `"done"`, emit `SUCCESS` / `COMPLETED` and stop.
3. Sleep for `VISA_ATTEMPT_INTERVAL_MS` (idle) or `VISA_BURST_INTERVAL_MS` (other outcomes).

### Recovery behaviors (built-in)

- Calendar not ready: worker skips the scan and retries on the next loop iteration.
- Slot not found: worker advances to the next available date or month.
- Pickup refresh: when no usable dates are found after consecutive attempts, the worker toggles the pickup selection to refresh availability data from the server.
- Throttled pickup refresh: enforced by `VISA_PICKUP_REFRESH_COOLDOWN_MS` and `VISA_PICKUP_REFRESH_AFTER_MISSES`.

## attemptBooking() (the booking attempt algorithm)

### A) Open appointment mode

- Navigate to the booking UI based on `VISA_RESCHEDULE` mode.

### B) Pickup selection (PENDING mode only)

- Select the configured `VISA_PICKUP_POINT` from the dropdown.
- In RESCHEDULE mode, pickup selection is skipped (the existing appointment's pickup is used).

### C) Green date scanning (within date range)

Worker scans the visible Angular Material calendar.

Rules:

- A date is "available" only if it is visually green (the availability green color `#14a38b`).
- A green date is clickable only if it is within `VISA_MIN_DATE..VISA_MAX_DATE` (or fallback range).
- Clicking is done in the browser context and the worker verifies the date was selected.

If multiple in-range green dates exist, the worker selects the earliest one.

### D) Time slot selection

- The worker waits briefly for time slots to load.
- The worker selects the earliest enabled time-slot button that looks like a time (example: `3:30 PM`).

### E) Applicant checkbox

- Worker rechecks the **Applicant List** checkbox before the final action.
- Checkbox logic targets the `Applicant List` area and has multiple fallback click paths.

### F) Final action

- **PENDING mode:** Clicks **SELECT POST AND PROCEED**.
- **RESCHEDULE mode:** Clicks **BOOK POST APPOINTMENT**.
- Worker waits for the booking success toast or a page redirect.

### G) Final confirmation (only then SUCCESS)

The worker does **not** claim success just because it progressed.

Success is determined by:

1. Detecting the "Appointment Booked Successfully" toast message.
2. The toast must remain visible for a minimum duration to avoid false positives.
3. If the "Select a applicant" toast appears instead, the worker resets the checkbox and retries.

Only after success is detected does `attemptBooking()` return `"done"`.

## How admin notification happens

- Worker sends statuses via IPC: `sendWorkerMessage()`.
- Backend receives them in `WorkerPool`.

Key states:

- `DATE_SELECTED` — backend extracts the `YYYY-MM-DD` for the email.
- `SLOT_SELECTED` — backend extracts the time slot for the email.
- `COMPLETED` — backend marks the session completed and queues admin email notification.

## CAPTCHA Solving Architecture

### Components

- **2Captcha Service:** Third-party CAPTCHA solving service.
- **`@2captcha/captcha-solver` npm package:** Official 2Captcha Node.js SDK.
- **`captcha-solver.js` module:** Custom wrapper with error handling and result reporting.

### Flow

1. **Detection:** Worker identifies reCAPTCHA on the login page by searching for the site key in script tags and DOM elements.
2. **Submission:** Site key and page URL are sent to 2Captcha.
3. **Polling:** 2Captcha workers solve the CAPTCHA (typically 15-45 seconds).
4. **Response:** Solved token is returned.
5. **Injection:** Token is injected into the `g-recaptcha-response` field and the reCAPTCHA callback is triggered.
6. **Login:** Sign In button becomes active; worker clicks it.

### Error Handling

- **API errors:** Logged and worker falls back to manual CAPTCHA wait state.
- **Timeouts:** Worker waits up to 120 seconds for 2Captcha; if exceeded, falls back.
- **Invalid tokens:** Worker can report incorrect solutions back to 2Captcha for refunds.

### Environment Configuration

```env
RECAPTCHA_API_KEY=your_2captcha_api_key_here
RECAPTCHA_SITE_KEY=optional_override
RECAPTCHA_SITE_URL=https://www.usvisaappt.com/visaapplicantui/login
```
