# Visa Booking Bot - Algorithm (Playwright Worker)

This file documents the runtime algorithm executed by the Playwright worker in `backend/main/index.js` and how it interacts with the backend.

## Files involved

- API server: `backend/src/server.js`
- Worker pool that forks workers and receives statuses: `backend/src/queue/workerPool.js`
- Worker entry used as the fork target: `backend/src/workerEntry.js`
- Booking worker algorithm: `backend/main/index.js`
- Admin email notifications: `backend/src/services/notifications.js`

## Configuration inputs (what controls behavior)

### Worker environment variables (core)

- `VISA_PLATFORM_URL` - login URL, defaulting to the usvisaappt login route
- `VISA_USER_EMAIL`, `VISA_USER_PASSWORD`, `VISA_USER_DISPLAY_NAME`
- `VISA_PICKUP_POINT` - pickup location used in the pending flow
- `VISA_RESCHEDULE` - switches between pending booking and reschedule booking
- `VISA_HEADLESS` - runs Chrome headless when enabled
- `VISA_PROFILE_DIR` - Chrome user-data-dir path supplied per session
- `VISA_SESSION_ID` - used for backend logs and status association
- `PROXY_HOST` / `PROXY_API_KEY` - Proxy11 rotator endpoint and key
- `PROXY_PORT` - fallback port when the proxy API omits one
- `VISA_PROXY_URL` - single-proxy fallback in standard proxy URL format
- `VISA_PROXY_POOL` / `VISA_PROXY_POOL_FILE` - legacy proxy fallbacks
- `VISA_PROXY_BYPASS` - optional bypass list passed to Playwright
- `VISA_EXECUTION_MODE` - `api` uses the authenticated API booking worker; `dom` uses the legacy Playwright DOM worker

The backend prefers Proxy11 for multi-session isolation. On worker start it requests `PROXY_HOST?key=PROXY_API_KEY`, reserves a proxy for the session, and passes the resulting `VISA_PROXY_URL` to Playwright before Chrome launches. If Proxy11 is unavailable, the worker falls back to the stored proxy, `VISA_PROXY_POOL`, `backend/data/proxy-pool.txt`, or the single `VISA_PROXY_URL`.

### Date-range filtering (green dates must be inside this window)

- Preferred: `VISA_MIN_DATE` / `VISA_MAX_DATE` in `YYYY-MM-DD` format
- Fallback: `VISA_DATE_START` / `VISA_DATE_END` in `YYYY-MM-DD` format

### Attempt pacing / rate limiting

- `VISA_ATTEMPT_INTERVAL_MS`
- `VISA_ATTEMPT_WINDOW_MS`
- `VISA_ATTEMPTS_PER_WINDOW`

### Server-side worker capacity

- `MAX_CONCURRENT` - how many sessions can run at once
- `FORCE_VISIBLE_BROWSER=true` - forces workers to run visible even if the session prefers headless

### Hot-path tuning

The worker also honors the tighter runtime values used by the current algorithm:

- `VISA_HOT_SCAN_SETTLE_MS`
- `VISA_HOT_MONTH_CHANGE_WAIT_MS`
- `VISA_HOT_MONTH_READY_WAIT_MS`
- `VISA_HOT_SLOT_READY_TIMEOUT_MS`
- `VISA_HOT_SLOT_CLICK_TIMEOUT_MS`
- `VISA_HOT_SLOT_RETRY_LIMIT`
- `VISA_HOT_FINAL_OUTCOME_TIMEOUT_MS`
- `VISA_HOT_BURST_OUTCOME_TIMEOUT_MS`
- `VISA_HOT_FINAL_OUTCOME_POLL_MS`
- `VISA_HOT_FINAL_BURST_DELAY_MS`
- `VISA_PICKUP_REFRESH_COOLDOWN_MS`
- `VISA_PICKUP_REFRESH_AFTER_MISSES`

## End-to-end algorithm (what the worker does)

## Execution modes

The default execution mode is the authenticated API worker:

```text
VISA_EXECUTION_MODE=api
```

The legacy Playwright DOM worker is available explicitly:

```text
VISA_EXECUTION_MODE=dom
```

In API mode Playwright remains responsible for browser launch, manual login, manual CAPTCHA completion, authenticated session capture, and reauthentication. The worker then uses the authenticated browser context for API requests instead of calendar DOM inspection or final button clicks.

API mode emits the same IPC message shape as the DOM worker and adds more granular states such as `SESSION_CAPTURED`, `SESSION_READY`, `RESOLVING_APPLICATION`, `SCANNING_DATES`, `NO_DATES_AVAILABLE`, `FETCHING_SLOTS`, `SUBMITTING_BOOKING`, `VERIFYING_BOOKING`, `BOOKING_OUTCOME_UNKNOWN`, and `REAUTHENTICATION_REQUIRED`.

### 1) Startup (backend)

1. Backend starts from `backend/src/server.js`.
2. `WorkerPool` forks `backend/src/workerEntry.js` for a session.
3. Worker entry loads the booking algorithm from `backend/main/index.js`.

### 2) Login (worker)

1. Worker opens Chrome and navigates to `VISA_PLATFORM_URL`.
2. Worker fills email and password.
3. Human solves CAPTCHA and clicks **SIGN IN**.
4. Worker waits until the dashboard is detected.

### 3) Navigate to appointment booking page

- If `VISA_RESCHEDULE=false` (pending mode):
  1. Go to the dashboard.
  2. Click the pending appointment tile.
  3. Wait until the booking block fully loads.

- If `VISA_RESCHEDULE=true` (reschedule mode):
  1. Navigate directly to My Appointments.
  2. Click RESCHEDULE.
  3. Confirm the dialog.
  4. Wait until the booking block fully loads.

### 4) Monitoring loop (repeats until booked)

The main loop is `attemptBooking()` inside the worker's outer retry loop.

On each cycle:

1. Ensure the browser is on the booking page. If not, the worker navigates there without counting that as a booking attempt.
2. Enforce rate limits using `VISA_ATTEMPT_INTERVAL_MS`, `VISA_ATTEMPT_WINDOW_MS`, and `VISA_ATTEMPTS_PER_WINDOW`.
3. Run one booking attempt cycle.
4. Stop only after a real success is confirmed and `COMPLETED` is emitted.

Important: the worker does not blindly refresh the page. It stabilizes by waiting for overlays and scanning the live calendar state.

### Recovery behaviors (built-in)

- White/blank page guard: if navigation leads to `about:blank`, `chrome-error://`, or a near-empty DOM, the worker navigates back to the appointment page and retries.
- Closed or crashed Chrome window: the worker recreates the browser and restarts login.
- Long waits: the worker uses a keep-alive sleep loop to periodically check session state and dismiss overlays.

## Booking attempt flow

### 1) Applicant checkbox

- In pending mode, the worker checks the Applicant List checkbox early.
- The checkbox helper targets the `styled-checkbox-*` family and falls back to nearby label or ancestor clicks when the input is hidden.

### 2) Pickup selection

- In pending mode, the worker selects the configured pickup point if needed.
- Once the worker has moved into the date/slot stage, it avoids reselecting pickup unless a refresh cycle explicitly calls for it.

### 3) Green date scanning

The worker scans the visible Angular Material calendar month-by-month.

- A date is considered available only when it is visually green.
- Only dates inside the configured allowed range are accepted.
- If the visible month has no usable green date, the worker can refresh the pickup and rescan before moving on.

### 4) Time slot selection

- The worker selects the first enabled time-like slot it can find.
- If slots appear only after the calendar settles, it waits briefly and retries instead of immediately failing.

### 5) Final action

- Pending mode clicks `SELECT POST AND PROCEED`.
- Reschedule mode clicks `BOOK POST APPOINTMENT`.
- The final action is capped at two attempts with a gap between clicks so the page has time to settle.

### 6) Final confirmation

The worker only reports success after a real outcome is observed.

- Preferred success signals: redirect to the dashboard, redirect to the my-appointment page, or a success message that clearly indicates booking completion.
- If a confirmation dialog is still blocking the flow, the worker clicks only booking-related confirmation actions.
- In reschedule mode, confirmed booking returns the browser to the dashboard before the worker pauses.

Only after success is detected does the booking cycle return `SUCCESS`.

## API mode booking flow

The API worker lives in `backend/main/api-worker.js`, with reusable helpers in `backend/src/services/visaApi`.

1. Launch Chrome with the same persistent profile and proxy assignment as DOM mode.
2. Fill credentials when available, then wait for the user to solve CAPTCHA and sign in.
3. Capture `sessionStorage.authToken`, user-agent, cookies, and observed auth response headers into a backend-only session object.
4. Use `browserContext.request` so requests share the authenticated browser session and proxy.
5. Resolve the authenticated user through `GET /visauserapi/portal/getuser`.
6. Load the selected Accra post configuration through `GET /visaadministrationapi/v1/postconfiguration/get/483`.
7. Resolve the correct application/appointment record from authenticated bootstrap/browser data.
8. Use the `NEW` appointment for pending mode and the `SCHEDULED` appointment for reschedule mode.
9. Query first available month, available dates, and available slot times through the confirmed `modifyslot` endpoints.
10. Filter dates with the same configured administrator date preferences.
11. Submit pending bookings with `POST /visaappointmentapi/appointments/schedule/group`.
12. Submit reschedules with `PUT /visaappointmentapi/appointments/schedule/group` using one appointment object.
13. Verify by matching appointment id, applicant id, application id, date, time, slot id, and `SCHEDULED` status from the final booking response.

The selected Accra post id defaults to `483`; use `VISA_SELECTED_POST_USER_ID` to override it for another location later.

The API worker never emits `COMPLETED` from a final HTTP status alone.

## How admin notification happens

- Worker sends statuses via IPC.
- Backend receives them in `WorkerPool`.

Key states:

- `DATE_SELECTED` - backend extracts the booked `YYYY-MM-DD` for the email.
- `SLOT_SELECTED` - backend extracts the selected time slot for the email.
- `COMPLETED` - backend marks the session completed and queues admin email notification.

## Update cross-references

The current working flow is implemented in these helpers:

- `backend/main/index.js` - `openAppointmentMode()` decides pending versus reschedule entry.
- `backend/main/index.js` - `waitForAppointmentBookingPageReady()` and `waitForCalendarUiReady()` gate calendar scans.
- `backend/main/index.js` - `selectPickupPoint()` and `refreshPickupByToggle()` handle pickup selection and refresh.
- `backend/main/index.js` - `huntGreenDate()` and `scanVisibleMonthForGreenDate()` handle month traversal and green-date discovery.
- `backend/main/index.js` - `clickEarliestTimeSlot()` and `clickNextAvailableDateAfter()` handle slot selection and date stepping.
- `backend/main/index.js` - `ensureApplicantChecked()` keeps the Applicant List state correct.
- `backend/main/index.js` - `clickBookPostAppointmentButton()`, `safeClickProceed()`, and `waitForFinalActionOutcome()` control final submission and success detection.
