---

## Updated File 2: Booking Worker Audit

```markdown
# Booking Worker Audit

This document captures the current behavior of the Playwright booking worker in [main/index.js](main/index.js) and separates the flow by mode.

## High-Level Shape

The worker has one shared booking loop. The only major branch is the mode gate in [openAppointmentMode](main/index.js#L515), which determines whether the worker enters the booking UI from the dashboard pending tile or from the my-appointments reschedule flow.

After the booking UI is ready, both modes share the same calendar scan, slot hunt, applicant validation, and final-action recovery logic in [attemptBooking](main/index.js#L1732).

### Login: Fully Automated

The login flow in [login](main/index.js) now includes automatic CAPTCHA solving via 2Captcha:

1. Worker fills email and password.
2. Worker calls [solveAndSubmitCaptcha](main/index.js) which:
   - Detects the reCAPTCHA site key from the page.
   - Sends the CAPTCHA to 2Captcha for solving.
   - Receives the solved token.
   - Injects the token into the page.
   - Clicks the Sign In button.
3. If 2Captcha fails, the worker falls back to the manual `WAITING_CAPTCHA` state.

## Mode Comparison

| Stage                 | PENDING                                                                     | RESCHEDULE                                              | Implementation Detail                                                                              |
| --------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Login                 | Automated CAPTCHA solving with 2Captcha fallback                            | Same                                                    | [solveAndSubmitCaptcha](main/index.js)                                                             |
| Entry point           | Opens dashboard and clicks the pending appointment tile                     | Opens my appointments and clicks RESCHEDULE             | [openAppointmentMode](main/index.js#L515)                                                          |
| Confirmation handling | None                                                                        | May accept a native dialog or an Angular confirm dialog | Same function, reschedule branch only                                                              |
| Booking UI wait       | Waits for `.ofc-book-slot-block` to appear and settle                       | Same                                                    | [waitForAppointmentBookingPageReady](main/index.js#L333)                                           |
| Pickup selection      | Selects the configured pickup point, usually Accra                          | Skipped                                                 | [selectPickupPoint](main/index.js#L641)                                                            |
| Calendar scan         | Hunts the first valid green date in range                                   | Same                                                    | [huntGreenDate](main/index.js#L1210)                                                               |
| Slot search           | Waits briefly for time slots, then advances to the next date if none appear | Same                                                    | [clickEarliestTimeSlot](main/index.js#L1399) and [clickNextAvailableDateAfter](main/index.js#L979) |
| Applicant validation  | Rechecks the Applicant list checkbox before final click                     | Same                                                    | [ensureApplicantChecked](main/index.js#L813)                                                       |
| Final action          | Clicks SELECT POST AND PROCEED                                              | Clicks BOOK POST APPOINTMENT                            | [clickProceedButton](main/index.js#L1565), [clickBookPostAppointmentButton](main/index.js#L1549)   |
| Success condition     | Requires the "Appointment Booked Successfully" toast to persist             | Same                                                    | [waitForFinalActionOutcome](main/index.js#L1704)                                                   |
| Exit behavior         | Worker exits after final success                                            | Same                                                    | [main](main/index.js#L1855)                                                                        |

## PENDING Flow

| Step | What Happens                                                  | Notes                                                                    |
| ---- | ------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 1    | Worker navigates to login page                                | Uses `VISA_PLATFORM_URL`                                                 |
| 2    | Worker fills credentials                                      | Email and password from env                                              |
| 3    | Worker solves CAPTCHA automatically                           | 2Captcha integration; falls back to manual if needed                     |
| 4    | Worker clicks Sign In                                         | Automated after CAPTCHA token injection                                  |
| 5    | Worker opens the dashboard                                    | Uses the dashboard path, not the appointment history path                |
| 6    | Worker clicks the pending appointment tile                    | Click routed through nearest actionable ancestor, not a loose text match |
| 7    | Worker waits for the booking UI to load                       | Spinner and booking block visibility used as readiness signals           |
| 8    | Worker selects the pickup point                               | Pickup select scoped to booking block to avoid sidebar language select   |
| 9    | Worker hunts for a green date                                 | Returns the actual clicked day text, not a boolean                       |
| 10   | If selected date has no slot, worker moves to next green date | Slot wait is intentionally short so the loop does not stall              |
| 11   | Worker rechecks the Applicant list checkbox                   | Happens immediately before the final button click                        |
| 12   | Worker clicks SELECT POST AND PROCEED                         | Button matched by exact text                                             |
| 13   | Worker confirms success only if the booking toast appears     | "Appointment Booked Successfully" toast must persist                     |
| 14   | Worker exits the loop                                         | A completed final action breaks the main loop                            |

## RESCHEDULE Flow

| Step | What Happens                                                | Notes                                                                   |
| ---- | ----------------------------------------------------------- | ----------------------------------------------------------------------- |
| 1    | Worker navigates to login page                              | Uses `VISA_PLATFORM_URL`                                                |
| 2    | Worker fills credentials                                    | Email and password from env                                             |
| 3    | Worker solves CAPTCHA automatically                         | 2Captcha integration; falls back to manual if needed                    |
| 4    | Worker clicks Sign In                                       | Automated after CAPTCHA token injection                                 |
| 5    | Worker opens the my-appointments page                       | The reschedule route is explicit                                        |
| 6    | Worker waits for the RESCHEDULE control                     | A reload fallback exists if the page does not hydrate on the first pass |
| 7    | Worker clicks RESCHEDULE                                    | Click is forced to reduce UI flakiness                                  |
| 8    | Worker handles whichever confirmation path appears          | Native browser confirm, Angular confirm dialog, or direct navigation    |
| 9    | Worker waits for the booking UI                             | Same readiness checks as PENDING                                        |
| 10   | Worker skips pickup selection                               | The reschedule branch goes directly to date hunting                     |
| 11   | Worker hunts dates and slots exactly like PENDING           | Shared calendar and slot logic                                          |
| 12   | Worker rechecks the Applicant list checkbox                 | Still required before final submit                                      |
| 13   | Worker clicks BOOK POST APPOINTMENT                         | Exact text match is required                                            |
| 14   | Worker confirms success only when the booking toast appears | Same toast-based success rule                                           |
| 15   | Worker exits the loop                                       | No repeated reprocessing after success                                  |

## CAPTCHA Solving Flow

| Step | What Happens                                           | Notes                                                              |
| ---- | ------------------------------------------------------ | ------------------------------------------------------------------ |
| 1    | Worker detects reCAPTCHA on login page                 | Searches for site key in script tags and DOM elements              |
| 2    | Worker sends CAPTCHA to 2Captcha                       | Uses `@2captcha/captcha-solver` package                            |
| 3    | 2Captcha workers solve the CAPTCHA                     | Typical solve time: 15-45 seconds                                  |
| 4    | Worker receives solved token                           | Token is a long string that validates the CAPTCHA                  |
| 5    | Worker injects token into `g-recaptcha-response` field | Also triggers reCAPTCHA callback if available                      |
| 6    | Worker clicks Sign In button                           | Multiple selector fallbacks if button is not immediately found     |
| 7    | If 2Captcha fails                                      | Worker logs error and falls back to `WAITING_CAPTCHA` manual state |

## Applicant Checkbox Behavior

The current checkbox handling is intentionally defensive.

| Helper                                          | Behavior                                                                                                                                  |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| [setApplicantCheckboxState](main/index.js#L657) | Searches around the `Applicant List` area and tries multiple checkbox, label, and ancestor click paths to force a requested checked state |
| [ensureApplicantChecked](main/index.js#L813)    | Runs the checked-state confirmation twice with a short delay                                                                              |
| [resetApplicantCheckbox](main/index.js#L831)    | Forces the checkbox off, waits briefly, then forces it back on                                                                            |
| [hasSelectApplicantToast](main/index.js#L837)   | Detects the red `Select a applicant` toast                                                                                                |

If the red toast appears during the final action, the worker logs the toast event, performs the off/on reset cycle, and retries the final action once.

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

Success is determined by [waitForFinalActionOutcome](main/index.js#L1704):

| Condition                                        | Outcome              |
| ------------------------------------------------ | -------------------- |
| "Appointment Booked Successfully" toast persists | Success              |
| Red `Select a applicant` toast appears           | Retry path           |
| Neither toast appears within the timeout         | Failure / retry loop |

This prevents false positives where the booking block disappears without the page actually confirming the booking.

After the worker reports `COMPLETED`, the backend queues email notification jobs for all active administrators through the existing notification service. The worker also emits structured `DATE_SELECTED` and `SLOT_SELECTED` messages so the email payload can include the booked date and time slot when available.

## Main Loop Behavior

The outer loop in [main](main/index.js#L1855) keeps trying until `attemptBooking` returns `done`.

| Return Value | Meaning                                      | Loop Action                            |
| ------------ | -------------------------------------------- | -------------------------------------- |
| `done`       | Final action succeeded                       | Log success and exit                   |
| `date`       | No usable slot after advancing through dates | Sleep briefly and retry                |
| `slot`       | Final button was not ready                   | Sleep briefly and retry                |
| `idle`       | Calendar or navigation was not ready         | Sleep on the normal interval and retry |

## Practical Summary

### In PENDING mode, the worker:

1. Logs in automatically with 2Captcha CAPTCHA solving.
2. Opens the dashboard.
3. Clicks the pending appointment tile.
4. Selects pickup.
5. Hunts dates and slots.
6. Rechecks the Applicant list checkbox.
7. Clicks SELECT POST AND PROCEED.
8. Exits only if the booking success toast is confirmed.

### In RESCHEDULE mode, the worker:

1. Logs in automatically with 2Captcha CAPTCHA solving.
2. Opens my appointments.
3. Clicks RESCHEDULE.
4. Handles any confirmation dialog.
5. Hunts dates and slots.
6. Rechecks the Applicant list checkbox.
7. Clicks BOOK POST APPOINTMENT.
8. Exits only if the booking success toast is confirmed.

The two modes diverge at entry and final button text, but otherwise share the same defensive recovery rules.

### CAPTCHA handling is fully automated:

1. Detects reCAPTCHA on the login page.
2. Solves via 2Captcha service.
3. Injects token and proceeds automatically.
4. Falls back to manual CAPTCHA only if 2Captcha fails.
```
