# Visa Booking Bot — Algorithm (Selenium Worker)

This file documents the _actual runtime algorithm_ executed by the Selenium worker and how it interacts with the backend.

## Files involved

- API server: `backend/src/server.js`
- Worker pool (forks workers, receives statuses): `backend/src/queue/workerPool.js`
- Worker entry (fork target): `backend/src/workerEntry.js`
- Selenium worker (the algorithm): `backend/main/visa-bot.js`
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
- `VISA_PROXY_URL` — optional proxy for a worker (format: `http[s]://user:pass@host:port` or `socks5://host:port`)
- `VISA_PROXY_POOL` — optional comma/newline-separated list of proxy URLs; the backend assigns one per session deterministically
- `VISA_PROXY_BYPASS` — optional bypass list passed to Playwright (comma-separated host globs)

### Date-range filtering (green dates must be inside this window)

Preferred:

- `VISA_MIN_DATE` / `VISA_MAX_DATE` (format: `YYYY-MM-DD`)

Fallback:

- `VISA_DATE_START` / `VISA_DATE_END` (format: `YYYY-MM-DD`)

### Attempt pacing / rate limiting

- `VISA_ATTEMPT_INTERVAL_MS` (default: `2000`)
- `VISA_ATTEMPT_WINDOW_MS` (default: `60*60*1000`)
- `VISA_ATTEMPTS_PER_WINDOW` (default: `1800`)

### Server-side worker capacity

- `MAX_CONCURRENT` — how many sessions can run at once
- `FORCE_VISIBLE_BROWSER=true` — forces workers to run non-headless (overrides session setting)

## End-to-end algorithm (what the bot does)

### 1) Startup (backend)

1. Backend starts (`backend/src/server.js`).
2. `WorkerPool` forks `backend/src/workerEntry.js` for a session.
3. Worker entry loads the algorithm (`require("../main/visa-bot")`).

### 2) Login (worker)

1. Worker opens Chrome and navigates to `VISA_PLATFORM_URL`.
2. Worker fills email + password.
3. Human solves CAPTCHA and clicks **SIGN IN**.
4. Worker waits until dashboard is detected.

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

The main loop is `appointmentWatcher()`.

On each cycle:

1. Ensure the browser is on the booking page (`.ofc-book-slot-block` exists). If not, navigate there (this navigation is **not** counted as an attempt).
2. Enforce rate limits: only `VISA_ATTEMPTS_PER_WINDOW` attempts per `VISA_ATTEMPT_WINDOW_MS`.
3. Every `VISA_ATTEMPT_INTERVAL_MS`, run one `fastBookingAttempt()`.
4. If `fastBookingAttempt()` returns `SUCCESS`, emit `COMPLETED` and stop.

Important: the worker does **not** auto-refresh. It stabilizes by waiting for overlays/spinners and dismissing overlays.

### Recovery behaviors (built-in)

- White/blank page guard: if navigation leads to `about:blank` / `chrome-error://` / near-empty DOM, the worker navigates back to the appointment page and retries.
- Closed/crashed Chrome window: the worker recreates the driver and restarts login.
- Long waits (rate limit): the worker uses a keep-alive sleep loop to periodically check session state and dismiss overlays.

## fastBookingAttempt() (the booking attempt algorithm)

### A) Applicant checkbox (PENDING mode only)

- If `VISA_RESCHEDULE=false`, the worker checks the **Applicant List** checkbox as early as possible.
- Checkbox logic targets `input[id^='styled-checkbox-']` and has fallbacks if the input is visually hidden.

### B) Pickup selection (select once)

- Pickup is selected only if it is not already set to `VISA_PICKUP_POINT`.
- Once the worker is past the calendar stage (a date is selected or “Available Slot(s)” is visible), pickup is **not** reselected.

### C) Green date scanning (within date range)

Worker scans the visible Angular Material calendar.

Rules:

- A date is “available” only if it is visually green (the availability green color).
- A green date is clickable only if it is within `VISA_MIN_DATE..VISA_MAX_DATE` (or fallback range).
- Clicking is done in the browser context and then confirmed (selected classes / `aria-pressed`).

If multiple in-range green dates exist, the worker tries them one-by-one until “Available Slot(s)” appears.

### D) Time slot selection

- The worker selects the first enabled time-slot button/link that looks like a time (example: `3:30 PM`).
- If a second list appears after clicking proceed, it selects again.

### E) Proceed

- The worker clicks either:
  - **SELECT POST AND PROCEED**, or
  - **BOOK POST APPOINTMENT**

It waits for loading overlays and handles new windows if one opens.

### F) Final confirmation (only then SUCCESS)

The worker does **not** claim success just because it progressed.

Finalization is `finalizeBookingAndConfirm()`:

1. Detect success signals (preferred):
   - landed on `/dashboard`, or
   - landed on `/home/appointment/myappointment`, or
   - a success dialog/snackbar/alert contains “appointment booked/confirmed”.
2. If not confirmed yet, click a final **Confirm/Book/Submit** action:
   - dialog buttons first (Angular Material dialogs)
   - then page-level Confirm/Book/Submit buttons
3. Safety rules:
   - it avoids “YES/OK” unless the dialog looks booking-related
   - it will not confirm cancellation dialogs

Only after success is detected does `fastBookingAttempt()` return `SUCCESS`.

## How admin notification happens

- Worker sends statuses via IPC: `reportStatus(state, message)`.
- Backend receives them in `WorkerPool`.

Key states:

- `DATE_SELECTED` — backend extracts the `YYYY-MM-DD` for the email.
- `SLOT_SELECTED` — backend extracts the time slot for the email.
- `COMPLETED` — backend marks the session completed and queues admin email notification.

## Update cross-references (recent behavior changes)

These are the main algorithm updates that change runtime behavior:

- Stable pickup behavior (“select once”):
  - `backend/main/visa-bot.js` → `triggerPickupCheck()` (no forced reselect)
  - `backend/main/visa-bot.js` → `fastBookingAttempt()` avoids pickup changes once date/slots stage is reached

- Green-date click reliability:
  - `backend/main/visa-bot.js` → `findGreenAvailableDateWithinRange()` (browser-context scan + click + confirm)

- Applicant checkbox timing:
  - `backend/main/visa-bot.js` → `fastBookingAttempt()` checks applicant early in PENDING mode
  - `backend/main/visa-bot.js` → `confirmApplicant()` targets `styled-checkbox-*` with fallbacks

- Completion semantics tightened (emails are not premature):
  - `backend/main/visa-bot.js` → `finalizeBookingAndConfirm()` must confirm success before returning `SUCCESS`
  - `backend/main/visa-bot.js` → `appointmentWatcher()` emits `COMPLETED` only when `fastBookingAttempt()` returns `SUCCESS`
  - `backend/src/queue/workerPool.js` → `COMPLETED` triggers admin email via `enqueueBookingSuccess()`
