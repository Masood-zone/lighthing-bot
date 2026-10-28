# Visa API endpoint and booking flow

## Runtime selection

`src/workerEntry.js` defaults to `VISA_EXECUTION_MODE=api` and loads
`main/api-worker.js`. `main/index.js` is the Playwright DOM fallback and
`main/visa-bot.js` is the Selenium fallback.

## US Visa endpoints used by API mode

| Phase               | Method | Endpoint                                                               | Purpose                                                                                                                                                 |
| ------------------- | ------ | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity            | GET    | `/visauserapi/portal/getuser`                                          | Validate the captured bearer session and obtain authenticated user/application fields.                                                                  |
| Context fallback    | GET    | `/visaworkflowprocessor/workflow/getUserHistoryApplicantPaymentStatus` | Used only when DevTools traffic plus `getuser` cannot resolve the application/appointment. It is non-critical, single-attempt, and capped at 3 seconds. |
| Appointment context | POST   | `/visaappointmentapi/appointments/search`                              | Capture or retrieve the complete `NEW`/`SCHEDULED` appointment record; also verify an ambiguous final mutation without replaying it.                    |
| First availability  | POST   | `/visaadministrationapi/v1/modifyslot/getFirstAvailableMonth`          | Return the first month containing availability.                                                                                                         |
| Date availability   | POST   | `/visaadministrationapi/v1/modifyslot/getSlotDates`                    | Return available dates inside the selected month/range.                                                                                                 |
| Time availability   | POST   | `/visaadministrationapi/v1/modifyslot/getSlotTime`                     | Return slot records for a selected date.                                                                                                                |
| Pending booking     | POST   | `/visaappointmentapi/appointments/schedule/group`                      | Schedule a new/pending appointment.                                                                                                                     |
| Reschedule          | PUT    | `/visaappointmentapi/appointments/schedule/group`                      | Replace an existing scheduled appointment.                                                                                                              |

The following endpoints are not called directly by the API worker because their
output is not required for the active booking path:

- `GET /visaadministrationapi/v1/postconfiguration/get/:postUserId`
- `GET /visaworkflowprocessor/workflow/getTransformData/:applicationId`

The network bridge first consumes browser-generated appointment-search
responses. If none exist, it briefly opens the Pending Appointment or My
Appointments surface and captures the platform's request. A direct read-only
search by `applicationId` is the final fallback.

## Request payloads

Availability context shared by the three `modifyslot` calls:

```json
{
  "postUserId": "483",
  "applicantId": "<captured>",
  "applicationId": "<captured>",
  "locationType": "POST",
  "visaClass": "<captured>",
  "visaType": "<captured>"
}
```

`getSlotDates` adds `fromDate` and `toDate`. `getSlotTime` adds `fromDate`,
`toDate`, and `slotDate`.

The final POST/PUT sends one appointment object:

```json
{
  "applicantId": "<captured>",
  "applicantUUID": "<captured-or-null>",
  "applicationId": "<captured>",
  "appointmentDt": "YYYY-MM-DDT00:00:00.000+00:00",
  "appointmentId": "<captured>",
  "appointmentLocationType": "POST",
  "appointmentStatus": "SCHEDULED",
  "appointmentTime": "10:00 AM",
  "postUserId": "483",
  "slotId": "<selected-slot>"
}
```

## Fast-path sequence

1. The user signs in and completes CAPTCHA in Playwright.
2. Request/response listeners have already captured authorization, refresh/CSRF
   headers, correlation key, cookies, and relevant response bodies.
3. Dashboard detection is polled every 100 ms.
4. `sessionStorage.authToken`, cookies, browser headers, and DevTools state are
   promoted into the backend-only API session.
5. `GET /visauserapi/portal/getuser` validates the session.
6. Context is resolved from captured traffic and `getuser`; history is tried
   once, then the relevant appointment surface is opened to capture the
   platform-generated appointment search. Direct search is the final fallback.
7. First month → dates → times are queried in order.
8. The earliest date allowed by administrator preferences and earliest usable
   time are selected.
9. Pending uses POST; reschedule uses PUT.
10. The worker emits `COMPLETED` only when the returned appointment matches the
    submitted applicant, application, appointment, date, time, slot, and
    `SCHEDULED` status.

## Failure policy

- Read-only availability calls retry up to three times with 0.5s and 1.5s
  backoff, then the outer hunt continues without closing Chrome.
- A 500 from optional history is ignored after one short attempt.
- Missing/incomplete context reports sanitized missing-field/source counts,
  retains Chrome, and retries acquisition after 30 seconds without repeatedly
  calling the same bootstrap APIs.
- Missing token capture or failed reauthentication retries the browser-to-API
  session bridge in the same Chrome session instead of reaching cleanup.
- The final POST/PUT is never automatically replayed after an ambiguous failure.
  One read-only appointment search verifies the outcome; otherwise the worker
  pauses for manual verification.
- 401 triggers reauthentication, 429 respects retry timing, and 403 remains a
  blocked/manual-review state.

## LightingBot APIs that start and monitor this flow

| Method | Endpoint                     | Purpose                                              |
| ------ | ---------------------------- | ---------------------------------------------------- |
| POST   | `/api/users`                 | Store encrypted applicant credentials/configuration. |
| PUT    | `/api/users/:id`             | Update a stopped applicant configuration.            |
| POST   | `/api/sessions/:id/start`    | Queue and fork the selected API worker.              |
| POST   | `/api/sessions/:id/stop`     | Stop the worker explicitly.                          |
| GET    | `/api/users/:id/logs?tail=N` | Read worker state/API retry logs.                    |
| GET    | `/api/queue`                 | Read queued and active worker state.                 |
| GET    | `/api/analytics`             | Read aggregate session state.                        |
| GET    | `/api/analytics/stream`      | Stream aggregate state over SSE.                     |

## Booking speed settings

The API worker scans on a start-to-start cadence and backs off only when the
platform pushes back. All values are environment variables with these defaults:

| Variable | Default | Purpose |
| --- | --- | --- |
| `VISA_FIRST_MONTH_POLL_MS` | 750 | Target time between scan starts |
| `VISA_SCAN_JITTER_MS` | 100 | Random jitter added to each scan |
| `VISA_SCAN_TIMEOUT_MS` | 4000 | Timeout for scan and lookup reads |
| `VISA_HEARTBEAT_MS` | 10000 | Interval of the `AVAILABILITY_SCAN_HEARTBEAT` status |
| `VISA_API_MAX_MONTHS` | 12 | Maximum months checked per scan |
| `VISA_DATE_LOOKUP_CONCURRENCY` | 3 | Months fetched with `getSlotDates` in parallel |
| `VISA_SLOT_LOOKUP_CONCURRENCY` | 2 | Dates fetched with `getSlotTime` in parallel |
| `VISA_CONFLICT_FALLBACK_LIMIT` | 2 | Different slots tried immediately after a 409 |
| `VISA_READ_TRANSPORT` | `auto` | `fetch`, `playwright`, or `auto` (fetch unless a proxy is set) |
| `VISA_TOKEN_REFRESH_LEAD_MS` | 120000 | Start background token refresh this long before expiry |
| `VISA_SLOW_CONNECTION_MS` | 1200 | Heartbeat flags a slow connection above this average latency |

Backoff: network errors and 5xx wait 1, 2, 4, 8, then 15 s. A 429 honors
`Retry-After`, otherwise 5, 10, 20, 40, then 60 s. Any 2xx clears both.
The final booking request is still sent once per slot and never replayed.
Set `VISA_PERF_TRACE=1` to log per-step timings, including
`availability_seen_to_booking_sent`.

## Faster sign-in

The worker opens Chrome, fills in the applicant's email and password, and
clicks Sign In. If the portal shows a CAPTCHA, the worker waits for a person to
solve it before clicking; it never solves or bypasses one.

| Setting | Default | Effect |
| --- | --- | --- |
| `VISA_AUTO_SUBMIT_LOGIN` | on (`0` disables) | Clicks Sign In once after filling credentials (after the CAPTCHA, if one is shown) |
| `VISA_RESTORE_SESSION` | on (`0` disables) | Reuses a saved, still-valid portal session so a restart skips login |
| `VISA_DEBUG_HTTP` | off (`1` enables) | Logs the request and response body of failed platform calls (local debugging only) |

After a successful login, and after each background token refresh, the worker
saves the portal's sessionStorage and auth headers to `portal-session.json` in
the user's Chrome profile directory. The file is encrypted with
`VISA_SECRET_KEY`. On the next start the token is checked with a read-only
`getuser` call; if it has expired, is rejected, or the dashboard redirects to
login, the file is deleted and the normal login runs.
