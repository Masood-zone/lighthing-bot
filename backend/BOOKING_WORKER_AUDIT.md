# Booking Worker Audit

This document captures the current behavior of the Playwright booking worker in `backend/main/index.js` and separates the flow by mode.

## High-Level Shape

The worker has one shared booking loop. The only major branch is the mode gate in `openAppointmentMode()`, which determines whether the worker enters the booking UI from the dashboard pending tile or from the my-appointments reschedule flow.

After the booking UI is ready, both modes share the same calendar scan, slot hunt, applicant validation, pickup refresh, and final-action recovery logic in the main booking attempt flow.

## API Engine Addition

The repository now uses the API execution path by default:

| Area | Implementation |
| ---- | -------------- |
| Feature flag | `VISA_EXECUTION_MODE=api`; `dom` remains available as explicit fallback |
| Worker entry | `backend/src/workerEntry.js` chooses `backend/main/api-worker.js` for API mode |
| API worker | `backend/main/api-worker.js` launches Playwright for login/CAPTCHA, captures session state, then books through API calls |
| API helpers | `backend/src/services/visaApi/*` contains the client, session extractor, applicant resolver, date selector, slot selector, payload builder, verifier, errors, and redaction helpers |
| Accra post | API mode uses post user id `483`; post-configuration lookup is not on the critical path |
| Final pending request | `POST /visaappointmentapi/appointments/schedule/group` with one appointment object |
| Final reschedule request | `PUT /visaappointmentapi/appointments/schedule/group` with one appointment object |
| Completion rule | The final booking response must match selected appointment id, applicant id, application id, date, time, slot id, and `SCHEDULED` |
| Locking | `WorkerPool` rejects another queued/running session for the same visa login host and booking email |

API mode does not scan green calendar colors, click time slots, manipulate the applicant checkbox, or click final booking buttons. DOM mode remains available for fallback before any API final submission is attempted.

## Mode Comparison

| Stage                 | PENDING                                                                     | RESCHEDULE                                                              | Implementation detail                                         |
| --------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------- |
| Entry point           | Opens the dashboard and clicks the pending appointment tile                 | Opens My Appointments and clicks RESCHEDULE                             | `openAppointmentMode()`                                       |
| Confirmation handling | None                                                                        | May accept a native dialog or an Angular confirm dialog                 | Reschedule branch only                                        |
| Booking UI wait       | Waits for the booking block and spinner state to settle                     | Same                                                                    | `waitForAppointmentBookingPageReady()`                        |
| Pickup selection      | Selects the configured pickup point                                         | Skipped after the reschedule entry path                                 | `selectPickupPoint()`                                         |
| Calendar scan         | Hunts the first valid green date in range                                   | Same                                                                    | `huntGreenDate()` and `scanVisibleMonthForGreenDate()`        |
| Slot search           | Waits briefly for time slots, then advances to the next date if none appear | Same                                                                    | `clickEarliestTimeSlot()` and `clickNextAvailableDateAfter()` |
| Applicant validation  | Rechecks the Applicant List checkbox before final click                     | Same                                                                    | `ensureApplicantChecked()`                                    |
| Final action          | Clicks SELECT POST AND PROCEED at most twice, with a gap between attempts   | Clicks BOOK POST APPOINTMENT at most twice, with a gap between attempts | `safeClickProceed()` and `clickBookPostAppointmentButton()`   |
| Success condition     | Requires a real redirect or success signal away from the slot page          | Same, then returns to dashboard before pausing                          | `waitForFinalActionOutcome()`                                 |
| Exit behavior         | Worker exits after final success                                            | Same                                                                    | `main()`                                                      |

## Pending Flow

| Step | What Happens                                                                  | Notes                                                                                      |
| ---- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 1    | The worker logs MODE and opens the dashboard                                  | It uses the dashboard path, not the appointment history path                               |
| 2    | It clicks the pending appointment tile                                        | The click is routed through the nearest actionable ancestor, not a loose text match        |
| 3    | It waits for the booking UI to load                                           | Spinner and booking block visibility are used as readiness signals                         |
| 4    | It selects the pickup point                                                   | The pickup select is scoped to the booking block so the sidebar language select is avoided |
| 5    | It hunts for a green date                                                     | The helper returns the clicked day text, not just a boolean                                |
| 6    | If the selected date has no slot, it moves to the next green date             | The slot wait is intentionally short so the loop does not stall                            |
| 7    | It rechecks the Applicant List checkbox                                       | This happens immediately before the final button click                                     |
| 8    | It clicks SELECT POST AND PROCEED, at most twice                              | Each attempt is separated by a short gap                                                   |
| 9    | It confirms success only if the page actually redirects or signals completion | A disappearing booking block alone is not treated as success                               |
| 10   | It exits the worker loop                                                      | A completed final action breaks the main loop                                              |

## Reschedule Flow

| Step | What Happens                                                  | Notes                                                                   |
| ---- | ------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 1    | The worker logs MODE and opens My Appointments                | The reschedule route is explicit                                        |
| 2    | It waits for the RESCHEDULE control                           | A reload fallback exists if the page does not hydrate on the first pass |
| 3    | It clicks RESCHEDULE                                          | The click is forced to reduce UI flakiness                              |
| 4    | It handles whichever confirmation path appears                | Native browser confirm, Angular confirm dialog, or direct navigation    |
| 5    | It waits for the booking UI                                   | Same readiness checks as pending                                        |
| 6    | It skips pickup selection                                     | The reschedule branch goes directly to date hunting                     |
| 7    | It hunts dates and slots exactly like pending                 | Shared calendar and slot logic                                          |
| 8    | It rechecks the Applicant List checkbox                       | This is still required before final submit                              |
| 9    | It clicks BOOK POST APPOINTMENT, at most twice                | Each attempt is separated by a short gap                                |
| 10   | It confirms success only on a real redirect or success signal | Same success rule                                                       |
| 11   | It returns to the dashboard after success                     | The user lands on a stable page for manual follow-up                    |
| 12   | It exits the worker loop                                      | No repeated reprocessing after success                                  |

## Applicant Checkbox Behavior

The current checkbox handling is intentionally defensive.

| Helper                        | Behavior                                                                                                                                |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `setApplicantCheckboxState()` | Searches around the Applicant List area and tries multiple checkbox, label, and ancestor click paths to force a requested checked state |
| `ensureApplicantChecked()`    | Runs the checked-state confirmation twice with a short delay                                                                            |
| `resetApplicantCheckbox()`    | Forces the checkbox off, waits briefly, then forces it back on                                                                          |
| `hasSelectApplicantToast()`   | Detects the red Select a applicant toast                                                                                                |

If the red toast appears during the final action, the worker currently logs the toast event, performs the off/on reset cycle, and retries the final action once.

## Date and Slot Behavior

| Helper                          | Behavior                                                                                  |
| ------------------------------- | ----------------------------------------------------------------------------------------- |
| `clickFirstGreenDate()`         | Selects the first valid green date in the visible calendar month and returns the day text |
| `clickNextAvailableDateAfter()` | Moves to the next later green date or the next month                                      |
| `clickEarliestTimeSlot()`       | Chooses the earliest visible slot after a short wait                                      |
| `waitForTimeSlotsUiReady()`     | Uses a short probing window so a date without slots does not hang the loop                |

If a selected date does not show a slot quickly enough, the worker advances to the next date instead of waiting indefinitely.

## Final Action and Success Rules

The final click goes through `clickExactActionButton()`, which exact-matches the button text and scopes the search to the booking block first.
The helper limits the final action to two clicks total and waits between attempts, which keeps the bot from hammering the booking button while the page is still settling.

Success is determined by `waitForFinalActionOutcome()`:

| Condition                                             | Outcome              |
| ----------------------------------------------------- | -------------------- |
| URL changes away from the slot page                   | Success              |
| Red Select a applicant toast appears                  | Retry path           |
| Neither redirect nor toast appears within the timeout | Failure / retry loop |

This prevents false positives where the booking block disappears without the page actually navigating.

In reschedule mode, a confirmed booking sends the browser back to the dashboard before the worker pauses, so the user lands on a stable page for manual follow-up.

After the worker reports `COMPLETED`, the backend queues email notification jobs for all active administrators through the notification service. The worker also emits structured `DATE_SELECTED` and `SLOT_SELECTED` messages so the email payload can include the booked date and time slot when available.

## Main Loop Behavior

The outer loop in `main()` keeps trying until the booking cycle returns success.

| Return Value | Meaning                                      | Loop Action                            |
| ------------ | -------------------------------------------- | -------------------------------------- |
| `done`       | Final action succeeded                       | Log success and exit                   |
| `date`       | No usable slot after advancing through dates | Sleep briefly and retry                |
| `slot`       | Final button was not ready                   | Sleep briefly and retry                |
| `idle`       | Calendar or navigation was not ready         | Sleep on the normal interval and retry |

## Practical Summary

In PENDING mode, the worker:

1. Opens the dashboard.
2. Clicks the pending appointment tile.
3. Selects pickup.
4. Hunts dates and slots.
5. Rechecks the Applicant List checkbox.
6. Clicks SELECT POST AND PROCEED.
7. Exits only if the browser actually redirects or emits a success signal.

In RESCHEDULE mode, the worker:

1. Opens My Appointments.
2. Clicks RESCHEDULE.
3. Handles any confirmation dialog.
4. Hunts dates and slots.
5. Rechecks the Applicant List checkbox.
6. Clicks BOOK POST APPOINTMENT at most twice, with a 2-second gap between attempts.
7. Returns to the dashboard after a confirmed booking.
8. Pauses there for manual verification.

The two modes diverge at entry and final button text, but otherwise share the same defensive recovery rules.
