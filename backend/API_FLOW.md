# Visa API endpoint and booking flow

## Runtime selection

`src/workerEntry.js` defaults to `VISA_EXECUTION_MODE=api` and loads
`main/api-worker.js`. `main/index.js` is the Playwright DOM fallback and
`main/visa-bot.js` is the Selenium fallback.

## US Visa endpoints used by API mode

| Phase | Method | Endpoint | Purpose |
| --- | --- | --- | --- |
| Identity | GET | `/visauserapi/portal/getuser` | Validate the captured bearer session and obtain authenticated user/application fields. |
| Context fallback | GET | `/visaworkflowprocessor/workflow/getUserHistoryApplicantPaymentStatus` | Used only when DevTools traffic plus `getuser` cannot resolve the application/appointment. It is non-critical, single-attempt, and capped at 3 seconds. |
| First availability | POST | `/visaadministrationapi/v1/modifyslot/getFirstAvailableMonth` | Return the first month containing availability. |
| Date availability | POST | `/visaadministrationapi/v1/modifyslot/getSlotDates` | Return available dates inside the selected month/range. |
| Time availability | POST | `/visaadministrationapi/v1/modifyslot/getSlotTime` | Return slot records for a selected date. |
| Pending booking | POST | `/visaappointmentapi/appointments/schedule/group` | Schedule a new/pending appointment. |
| Reschedule | PUT | `/visaappointmentapi/appointments/schedule/group` | Replace an existing scheduled appointment. |

The client still contains helpers for the following endpoints, but they are not
part of the current critical booking path because their output is not needed to
scan or submit and their failure must not delay/close a session:

- `GET /visaadministrationapi/v1/postconfiguration/get/:postUserId`
- `GET /visaworkflowprocessor/workflow/getTransformData/:applicationId`

The network bridge also observes browser calls to
`/visaappointmentapi/appointments/search` and the workflow endpoints. It uses
their already-returned response bodies to resolve appointment context; it does
not issue an extra appointment-search request.

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
6. Applicant/application/appointment context is resolved from captured traffic
   and `getuser`. The history endpoint is called only as a short fallback.
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
- Missing/incomplete context and response-contract mismatches retain the
  authenticated session and retry instead of terminating the worker.
- Missing token capture or failed reauthentication retries the browser-to-API
  session bridge in the same Chrome session instead of reaching cleanup.
- The final POST/PUT is never automatically replayed after an ambiguous failure;
  this prevents duplicate booking. Its result must be verified.
- 401 triggers reauthentication, 429 respects retry timing, and 403 remains a
  blocked/manual-review state.

## LightingBot APIs that start and monitor this flow

| Method | Endpoint | Purpose |
| --- | --- | --- |
| POST | `/api/users` | Store encrypted applicant credentials/configuration. |
| PUT | `/api/users/:id` | Update a stopped applicant configuration. |
| POST | `/api/sessions/:id/start` | Queue and fork the selected API worker. |
| POST | `/api/sessions/:id/stop` | Stop the worker explicitly. |
| GET | `/api/users/:id/logs?tail=N` | Read worker state/API retry logs. |
| GET | `/api/queue` | Read queued and active worker state. |
| GET | `/api/analytics` | Read aggregate session state. |
| GET | `/api/analytics/stream` | Stream aggregate state over SSE. |
