# Booking Worker Audit

This document captures the current behavior of the Playwright booking worker in [main/index.js](main/index.js) and separates the flow by mode.

## High-Level Shape

The worker has one shared booking loop. The only major branch is the mode gate in [openAppointmentMode](main/index.js#L1083), which determines whether the worker enters the booking UI from the dashboard pending tile or from the my-appointments reschedule flow.

After the booking UI is ready, both modes share the same calendar scan, slot hunt, applicant validation, and final-action recovery logic in [attemptBooking](main/index.js#L2483).

## Mode Comparison

| Stage                 | PENDING                                                                     | RESCHEDULE                                                      | Implementation Detail                                                                               |
| --------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Entry point           | Opens dashboard and clicks the pending appointment tile                     | Opens my appointments and clicks RESCHEDULE                     | [openAppointmentMode](main/index.js#L515)                                                           |
| Confirmation handling | None                                                                        | May accept a native dialog or an Angular confirm dialog         | Same function, reschedule branch only                                                               |
| Booking UI wait       | Waits for `.ofc-book-slot-block` to appear and settle                       | Same                                                            | [waitForAppointmentBookingPageReady](main/index.js#L972)                                            |
| Pickup selection      | Selects the configured pickup point, usually Accra                          | Skipped                                                         | [selectPickupPoint](main/index.js#L1211)                                                            |
| Calendar scan         | Hunts the first valid green date in range                                   | Same                                                            | [huntGreenDate](main/index.js#L1869)                                                                |
| Slot search           | Waits briefly for time slots, then advances to the next date if none appear | Same                                                            | [clickEarliestTimeSlot](main/index.js#L2086) and [clickNextAvailableDateAfter](main/index.js#L1603) |
| Applicant validation  | Rechecks the Applicant list checkbox before final click                     | Same                                                            | [ensureApplicantChecked](main/index.js#L1395)                                                       |
| Final action          | Clicks SELECT POST AND PROCEED at most twice, with a 2-second gap           | Clicks BOOK POST APPOINTMENT at most twice, with a 2-second gap | [safeClickProceed](main/index.js#L2281), [clickBookPostAppointmentButton](main/index.js#L2237)      |
| Success condition     | Requires a real redirect away from the slot page                            | Same, then returns to dashboard before pausing                  | [waitForFinalActionOutcome](main/index.js#L2409)                                                    |
| Exit behavior         | Worker exits after final success                                            | Same                                                            | [main](main/index.js#L2625)                                                                         |

## PENDING Flow

| Step | What Happens                                                      | Notes                                                                                      |
| ---- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 1    | The worker logs `MODE` and opens the dashboard                    | It uses the dashboard path, not the appointment history path                               |
| 2    | It clicks the pending appointment tile                            | The click is routed through the nearest actionable ancestor, not a loose text match        |
| 3    | It waits for the booking UI to load                               | Spinner and booking block visibility are used as readiness signals                         |
| 4    | It selects the pickup point                                       | The pickup select is scoped to the booking block so the sidebar language select is avoided |
| 5    | It hunts for a green date                                         | The helper returns the actual clicked day text, not a boolean                              |
| 6    | If the selected date has no slot, it moves to the next green date | The slot wait is intentionally short so the loop does not stall                            |
| 7    | It rechecks the Applicant list checkbox                           | This happens immediately before the final button click                                     |
| 8    | It clicks SELECT POST AND PROCEED, at most twice                  | Each attempt is separated by a 2-second gap                                                |
| 9    | It confirms success only if the page actually redirects           | A disappearing booking block alone is not treated as success                               |
| 10   | It exits the worker loop                                          | A completed final action breaks the main loop                                              |

## RESCHEDULE Flow

| Step | What Happens                                              | Notes                                                                   |
| ---- | --------------------------------------------------------- | ----------------------------------------------------------------------- |
| 1    | The worker logs `MODE` and opens the my-appointments page | The reschedule route is explicit                                        |
| 2    | It waits for the RESCHEDULE control                       | A reload fallback exists if the page does not hydrate on the first pass |
| 3    | It clicks RESCHEDULE                                      | The click is forced to reduce UI flakiness                              |
| 4    | It handles whichever confirmation path appears            | Native browser confirm, Angular confirm dialog, or direct navigation    |
| 5    | It waits for the booking UI                               | Same readiness checks as PENDING                                        |
| 6    | It skips pickup selection                                 | The reschedule branch goes directly to date hunting                     |
| 7    | It hunts dates and slots exactly like PENDING             | Shared calendar and slot logic                                          |
| 8    | It rechecks the Applicant list checkbox                   | This is still required before final submit                              |
| 9    | It clicks BOOK POST APPOINTMENT, at most twice            | Each attempt is separated by a 2-second gap                             |
| 10   | It confirms success only on a real redirect               | Same redirect-based success rule                                        |
| 11   | It returns to the dashboard after success                 | The user lands on a stable page for manual follow-up                    |
| 12   | It exits the worker loop                                  | No repeated reprocessing after success                                  |

## Applicant Checkbox Behavior

The current checkbox handling is intentionally defensive.

| Helper                                          | Behavior                                                                                                                                  |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| [setApplicantCheckboxState](main/index.js#L657) | Searches around the `Applicant List` area and tries multiple checkbox, label, and ancestor click paths to force a requested checked state |
| [ensureApplicantChecked](main/index.js#L813)    | Runs the checked-state confirmation twice with a short delay                                                                              |
| [resetApplicantCheckbox](main/index.js#L831)    | Forces the checkbox off, waits briefly, then forces it back on                                                                            |
| [hasSelectApplicantToast](main/index.js#L837)   | Detects the red `Select a applicant` toast                                                                                                |

If the red toast appears during the final action, the worker currently logs the toast event, performs the off/on reset cycle, and retries the final action once.

## Date and Slot Behavior

| Helper                                            | Behavior                                                                                  |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| [clickFirstGreenDate](main/index.js#L848)         | Selects the first valid green date in the visible calendar month and returns the day text |
| [clickNextAvailableDateAfter](main/index.js#L979) | Moves to the next later green date or the next month                                      |
| [clickEarliestTimeSlot](main/index.js#L1399)      | Chooses the earliest visible slot after a short wait                                      |
| [waitForTimeSlotsUiReady](main/index.js#L397)     | Uses a short probing window so a date without slots does not hang the loop                |

If a selected date does not show a slot quickly enough, the worker advances to the next date instead of waiting indefinitely.

## Final Action and Success Rules

The final click goes through [clickExactActionButton](main/index.js#L1587), which exact-matches the button text and scopes the search to the booking block first.
The helper now limits the final action to two clicks total and waits 2 seconds between attempts, which keeps the bot from hammering the booking button while the page is still settling.

Success is determined by [waitForFinalActionOutcome](main/index.js#L1704):

| Condition                                             | Outcome              |
| ----------------------------------------------------- | -------------------- |
| URL changes away from the slot page                   | Success              |
| Red `Select a applicant` toast appears                | Retry path           |
| Neither redirect nor toast appears within the timeout | Failure / retry loop |

This prevents false positives where the booking block disappears without the page actually navigating.

In RESCHEDULE mode, a confirmed booking now sends the browser back to the dashboard before the worker pauses, so the user lands on a stable page for manual follow-up.

After the worker reports `COMPLETED`, the backend queues email notification jobs for all active administrators through the existing notification service. The worker now also emits structured `DATE_SELECTED` and `SLOT_SELECTED` messages so the email payload can include the booked date and time slot when available.

## Main Loop Behavior

The outer loop in [main](main/index.js#L1855) keeps trying until `attemptBooking` returns `done`.

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
5. Rechecks the Applicant list checkbox.
6. Clicks SELECT POST AND PROCEED.
7. Exits only if the browser actually redirects.

In RESCHEDULE mode, the worker:

1. Opens my appointments.
2. Clicks RESCHEDULE.
3. Handles any confirmation dialog.
4. Hunts dates and slots.
5. Rechecks the Applicant list checkbox.
6. Clicks BOOK POST APPOINTMENT at most twice, with a 2-second gap between attempts.
7. Returns to the dashboard after a confirmed booking.
8. Pauses there for manual verification.

The two modes diverge at entry and final button text, but otherwise share the same defensive recovery rules.
