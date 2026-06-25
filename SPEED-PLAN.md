# High-Speed Adaptive Availability Scanner

## Summary

Replace the current request-duration-plus-2-second sleep with a 750 ms start-to-start scanner. Preserve booking quality by accelerating only read-only availability calls, traversing the complete configured month window, and keeping the final booking mutation single-shot.

The current log averaged 695 ms per `getFirstAvailableMonth` request with zero 429s, so this should reduce scan starts from roughly every 2.7 seconds to approximately every 750–900 ms.

## Implementation Changes

- Add a dedicated availability scheduler:

  - Default poll cadence: `VISA_FIRST_MONTH_POLL_MS=750`.
  - Never overlap two first-month requests from the same worker.
  - Measure cadence from request start, not response completion.
  - Add 0–100 ms local jitter; workers otherwise remain independent.
  - Emit one aggregated scan heartbeat about every 10 seconds instead of persisting several status messages per poll.

- Add adaptive pressure handling:

  - Successful 2xx/no-date scans immediately return to the 750 ms cadence.
  - First-month requests use one attempt and a 4-second timeout so internal retries cannot stall the hot loop.
  - Network/5xx failures back off 1, 2, 4, 8, then 15 seconds maximum.
  - 429 honors `Retry-After`; otherwise back off 5, 10, 20, 40, then 60 seconds maximum.
  - Reset all penalties after a successful response.
  - Keep 401 reauthentication and 403/manual-block behavior unchanged.

- Correct and accelerate date selection:

  - Log the returned first-available date and configured window.
  - If the returned month is after the configured maximum, skip date calls and continue polling.
  - If it is before the configured minimum, begin at the minimum month.
  - Traverse every month intersecting the configured window in chronological order, capped by `VISA_API_MAX_MONTHS=12`.
  - Stop traversing as soon as an acceptable date/slot is found.
  - Do not insert sleeps between first-month, date, slot, and final booking calls.

- Accelerate slot discovery without sacrificing ordering:

  - Query the earliest two candidate dates concurrently using `VISA_SLOT_LOOKUP_CONCURRENCY=2`.
  - Wait for both reads, then choose the earliest date and earliest usable slot—not whichever response finishes first.
  - Process later dates in batches of two only when the earlier batch has no usable slot.
  - Date/slot reads get one fast retry after 150 ms and a 4-second per-request timeout.
  - Exact-date and reschedule same-date constraints remain authoritative.

- Preserve booking safety:

  - Final POST/PUT remains one attempt with its existing timeout.
  - No automatic mutation replay after timeout or ambiguous response.
  - Continue read-only appointment-search verification, then pause for manual review if unconfirmed.

## Interfaces and Observability

- Add environment controls:

  - `VISA_FIRST_MONTH_POLL_MS=750`
  - `VISA_API_MAX_MONTHS=12`
  - `VISA_SLOT_LOOKUP_CONCURRENCY=2`
  - Optional backoff/timeout variables with the defaults above.

- Add an `AVAILABILITY_SCAN_HEARTBEAT` status containing scan count, average latency, last first-available date, configured window, and current throttle state.
- Emit immediate `DATE_WINDOW_MATCH`, `DATE_SELECTED`, `SLOT_SELECTED`, `RATE_LIMITED`, and booking states when meaningful transitions occur.
- Keep existing frontend/backend REST interfaces unchanged.

## Test Plan

- Verify 750 ms start-to-start scheduling with fast and slow responses and no overlapping first-month requests.
- Verify successful no-date responses reset 5xx/429 penalties.
- Verify 429 `Retry-After` and fallback exponential limits.
- Verify 5xx/network backoff while retaining the session.
- Verify first-available dates before, inside, and after the configured window.
- Verify chronological multi-month traversal and the 12-month cap.
- Verify two concurrent slot reads still select the earliest date and earliest slot.
- Verify exact-date and reschedule exclusions remain intact.
- Verify no sleep occurs after availability is detected and before final submission.
- Verify final mutations remain single-shot and ambiguous results use read-only verification.
- Run backend build, full tests, and `git diff --check`.

## Assumptions

- Use the selected 750 ms adaptive profile.
- Use two concurrent slot lookups.
- Workers remain independent; no global token bucket or server-wide coordination is added.
- Local jitter is retained only to avoid accidental request synchronization.
