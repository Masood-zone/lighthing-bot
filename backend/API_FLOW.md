# API inventory and appointment flow

## Important implementation fact

The backend starts `main/index.js` through `src/workerEntry.js`. That worker uses
Playwright to drive the US Visa Appointment web UI. `main/visa-bot.js` is the
legacy Selenium worker and is not used by the current worker pool.

Before the API tracing change, the worker did not directly call any protected
US Visa Appointment API. Consequently, endpoint names copied from another
deployment or guessed from UI labels would be unsafe. The current worker now
records every same-origin XHR/fetch endpoint actually used by the platform as:

```text
[API_DISCOVERED] METHOD https://www.usvisaappt.com/path?key=<redacted> -> STATUS payload-shape={...}
```

Query values and credential/token/captcha payload fields are redacted. A 5xx is
reported as `API_TRANSIENT_ERROR` and does not close the browser session. Set
`VISA_API_TRACE=0` only when this discovery log is not wanted.

## LightingBot backend APIs

All protected endpoints below require `Authorization: Bearer <token>` except
health and authentication setup/login.

| Method | Endpoint | Purpose / payload |
| --- | --- | --- |
| GET | `/health`, `/api/health` | Process health |
| POST | `/api/auth/login` | Admin login: `{ email, password }` |
| GET | `/api/auth/me` | Resolve current bearer token |
| POST | `/api/auth/logout` | Revoke current bearer token |
| POST | `/api/auth/create-admin` | Create an administrator |
| GET | `/api/users` | List booking applicants |
| GET | `/api/users/:id` | Read one applicant/session |
| GET | `/api/users/:id/logs?tail=N` | Read worker/API trace logs |
| POST | `/api/users` | Create applicant; fields include `loginUrl`, `email`, `password`, `displayName`, `pickupPoint`, `headless`, `reschedule`, date-window fields, `proxyUrl`, and optional `autoStart` |
| PUT | `/api/users/:id` | Update the same applicant configuration while stopped |
| DELETE | `/api/users/:id` | Stop and delete an applicant |
| POST | `/api/sessions/:id/start` | Queue and spawn `main/index.js` |
| POST | `/api/sessions/:id/stop` | Stop the worker with SIGTERM |
| GET | `/api/queue` | Worker capacity and queued/running sessions |
| GET | `/api/analytics` | Analytics snapshot |
| GET | `/api/analytics/stream` | Live analytics SSE stream |
| GET | `/api/notifications` | Read notification recipient |
| PUT | `/api/notifications` | Save `{ email, name, active }` |
| DELETE | `/api/notifications` | Clear notification recipient |
| GET | `/api/administrators` | List notification administrators |
| POST | `/api/administrators` | Add notification administrator |
| DELETE | `/api/administrators/:id` | Remove notification administrator |

## End-to-end flow

1. Frontend creates/updates the applicant with `POST /api/users` or
   `PUT /api/users/:id`.
2. Frontend starts the hunt with `POST /api/sessions/:id/start`.
3. The pool decrypts the applicant password, builds worker environment values,
   and forks `src/workerEntry.js` -> `main/index.js`.
4. Playwright registers the platform API observer before opening the login URL.
5. The user completes CAPTCHA/sign-in. Dashboard URL/identity is polled every
   100 ms, so the booking hunt starts on the first authenticated UI tick.
6. The worker opens Pending Appointment or Reschedule, selects the applicant and
   pickup point, and scans allowed calendar months for green dates.
7. The worker selects the earliest allowed date and earliest available time.
8. It currently completes booking through the platform UI (`SELECT POST AND
   PROCEED` or `BOOK POST APPOINTMENT`). There is no hard-coded platform PUT in
   this repository yet.
9. The trace from one real session supplies the authoritative availability,
   slot, and final booking endpoint paths plus sanitized payload shapes. Only
   after those are verified should the final call be promoted to a direct PUT;
   it must reuse the browser context's cookies/anti-forgery headers and retain
   the UI path as fallback.

## Implementation TODOs

- [x] Identify the production worker and current UI flow.
- [x] Start hunting immediately after the first dashboard/authenticated signal.
- [x] Keep the browser alive and retry when login/navigation encounters a
  transient failure.
- [x] Record platform XHR/fetch endpoints, methods, statuses, query-key names,
  and sanitized payload shapes.
- [x] Treat observed platform 5xx responses as non-fatal telemetry.
- [ ] Run one authenticated Pending Appointment session and one Reschedule
  session; copy the `API_DISCOVERED` records into a reviewed endpoint table.
- [ ] Classify each observed endpoint as critical (auth, availability, slots,
  booking) or optional (profile, content, telemetry).
- [ ] Add bounded retry/backoff for critical GET availability/slot calls; never
  retry the final booking mutation blindly because duplicate booking is risky.
- [ ] Implement the verified final platform PUT with captured anti-forgery
  headers/cookies and the exact observed payload, keeping UI automation as a
  fallback and verifying success before marking the session complete.

