TASK TITLE:
Research and Replace LightingBot’s Post-Login Playwright DOM Workflow with an Authenticated API Booking Engine

PROJECT:
LightingBot — automated visa appointment monitoring and booking system.

CURRENT TECHNOLOGY:

- Backend: Node.js + Express
- Browser automation: Playwright
- Frontend: React + Vite + TypeScript
- Worker orchestration: Node child processes and worker pool
- Current data persistence: JSON files
- Notifications: Nodemailer
- Existing desktop wrapper: Electron

IMPORTANT PROJECT FILES TO READ FIRST:

- DOCUMENTATION.md
- DEVELOPMENT_GUIDELINES.md
- ALGORITHM_README.md
- BOOKING_WORKER_AUDIT.md
- backend/main/index.js
- backend/src/server.js
- backend/src/workerEntry.js
- backend/src/queue/workerPool.js
- backend/src/services/notifications.js
- All session, user, queue, proxy, authentication, and persistence modules used by those files

PRIMARY OBJECTIVE:

Replace the current post-login Playwright element-interaction workflow with authenticated API requests.

Playwright must remain responsible for:

1. Launching the browser.
2. Opening the visa-platform login page.
3. Allowing the user to enter credentials.
4. Allowing the user to complete CAPTCHA manually.
5. Detecting successful authentication.
6. Retaining the authenticated BrowserContext.
7. Handling reauthentication when the visa session expires.
8. Acting as a temporary fallback while the API workflow is being verified.

The API booking engine must eventually replace Playwright DOM interaction for:

1. Loading applicant and application information.
2. Obtaining the current appointment or application state.
3. Obtaining the first available appointment month.
4. Retrieving available appointment dates.
5. Filtering available dates using the administrator’s configured date preference.
6. Retrieving available time slots for a selected date.
7. Selecting the appropriate time slot.
8. Submitting the appointment booking or rescheduling request.
9. Verifying that the appointment was successfully booked.
10. Returning structured status information to the current worker pool and frontend.

NON-NEGOTIABLE ARCHITECTURAL RULES:

1. Do not hard-code:
   - applicantId
   - applicationId
   - appointmentId
   - missionId
   - postUserId
   - slotId
   - groupId
   - visaType
   - visaClass
   - locationType
   - appointment dates
   - appointment times
   - access tokens
   - refresh tokens
   - cookies
   - CSRF tokens
   - correlation identifiers
   - user-specific UUIDs

2. Every account-specific value must be discovered dynamically from:
   - the successful login response;
   - authenticated browser storage;
   - cookies;
   - response headers;
   - the authenticated user endpoint;
   - applicant/application bootstrap endpoints;
   - appointment search endpoints;
   - or another confirmed API response.

3. Visa-platform tokens, cookies, and session data must never be:
   - returned to the React frontend;
   - stored in frontend localStorage;
   - stored in frontend sessionStorage;
   - exposed through SSE;
   - printed in logs;
   - committed to source control;
   - included in test fixtures without redaction.

4. Only one active booking session may run for a specific booking account at a time.

5. Different accounts may continue to use the existing controlled worker queue.

6. Do not attempt to bypass CAPTCHA.

7. Do not attempt to bypass access controls, authentication controls, or server-side restrictions.

8. Do not perform a real final appointment booking during automated tests.

9. Preserve the existing:
   - worker pool;
   - queue behavior;
   - proxy assignment;
   - applicant configuration;
   - session statuses;
   - admin notifications;
   - SSE analytics;
   - start and stop controls;
   - pending and reschedule modes;
   - Electron compatibility.

RESEARCH-FIRST REQUIREMENT:

Do not begin modifying production code immediately.

Your first response must contain:

1. A thorough audit of the current implementation.
2. A file-by-file explanation of where the current Playwright workflow is implemented.
3. Identification of the exact functions responsible for:
   - login;
   - CAPTCHA waiting;
   - session persistence;
   - opening pending mode;
   - opening reschedule mode;
   - pickup selection;
   - date scanning;
   - time-slot selection;
   - applicant-checkbox handling;
   - final booking submission;
   - booking-success verification;
   - worker status reporting;
   - email notification.
4. A proposed migration architecture.
5. A list of code that can be reused.
6. A list of code that should be replaced.
7. A list of risks and unknowns.
8. The complete endpoint questionnaire below.

After presenting the audit and questions, STOP and wait for my answers.

Do not implement the API booking engine until I answer the endpoint questionnaire.

UNVERIFIED ENDPOINT INVENTORY FROM DEVTOOLS RECORDINGS:

The following endpoints were observed in DevTools recordings. Treat them as candidate endpoints only. Verify their exact methods, paths, headers, request shapes, response shapes, and purpose with me.

1. Authenticated user:
   GET /visauserapi/portal/getuser

2. First available appointment month:
   POST /visaadministrationapi/v1/modifyslot/getFirstAvailableMonth

3. Available appointment dates:
   POST /visaadministrationapi/v1/modifyslot/getSlotDates

4. Available appointment times:
   POST /visaadministrationapi/v1/modifyslot/getSlotTime

5. Existing appointment search:
   POST /visaappointmentapi/appointments/search

6. Workflow transform/bootstrap data:
   GET /visaworkflowprocessor/workflow/getTransformData/{applicationId}

7. Wizard template/bootstrap:
   POST /visaappointmentapi/template/generatewizardtemplate

Observed dynamic payload fields include:

{
applicantId,
applicationId,
postUserId,
visaType,
visaClass,
locationType
}

The slot-date request appears to additionally include:

{
fromDate,
toDate
}

These observations are incomplete and must not be treated as the final API contract.

MANDATORY ENDPOINT QUESTIONNAIRE:

Ask me these questions in an organized, numbered format.

SECTION A — LOGIN AND SESSION CREATION

1. What is the exact login endpoint URL?

2. What HTTP method does the login endpoint use?

3. What is the exact login request payload?

4. Which values are entered by the user and which values are generated by the page?

5. How is the CAPTCHA token included?

6. Does the login request use:
   - Basic authorization;
   - bearer authorization;
   - cookies;
   - CSRF token;
   - captchaToken;
   - or another security header?

7. What is the complete sanitized login response?

8. Where is the access token returned:
   - response body;
   - response header;
   - Set-Cookie;
   - localStorage;
   - sessionStorage;
   - IndexedDB;
   - JavaScript memory;
   - or another location?

9. Is a refresh token returned?

10. Where is the refresh token stored?

11. Is there a token-refresh endpoint?

12. What indicates that the visa-platform login is fully successful?

13. Which request immediately follows successful login?

14. Does the login response itself contain all required applicant information, or must additional bootstrap calls be made?

SECTION B — REQUIRED AUTHENTICATION STATE

15. Which of the following are required for subsequent API calls:

- Authorization bearer token;
- RefreshToken header;
- cookies;
- csrfToken;
- Origin;
- Referer;
- User-Agent;
- X-Correlation-Key;
- application-specific headers?

16. Is X-Correlation-Key:

- constant;
- generated per login;
- generated per request;
- returned by the server;
- or created by the frontend?

17. Must API calls come from the same browser cookie session?

18. Must API calls use the same IP or proxy used during login?

19. Does the API reject requests when browser-only headers are missing?

20. What response means that the session has expired?

SECTION C — USER, APPLICANT, AND APPLICATION DISCOVERY

21. What is the exact role of:
    GET /visauserapi/portal/getuser?

22. Provide a sanitized response from the getuser endpoint.

23. Which response provides:

- userId;
- applicantId;
- applicationId;
- appointmentId;
- missionId;
- postUserId;
- groupId;
- visaType;
- visaClass;
- locationType;
- primary applicant;
- current appointment status?

24. Which fields identify the application currently being booked?

25. Can one login contain multiple applicants or applications?

26. If multiple applications are returned, how should the correct application be chosen?

27. What is the purpose and contract of:
    POST /visaappointmentapi/appointments/search?

28. What is its exact request payload?

29. What is its complete sanitized response?

30. What is the purpose of the workflow transform-data endpoint?

31. Is generatewizardtemplate required before slot requests or only for rendering the UI?

SECTION D — FIRST AVAILABLE MONTH

32. Confirm the exact endpoint, method, and request payload for:
    getFirstAvailableMonth.

33. Confirm whether this request body is accurate:

{
postUserId,
applicantId,
applicationId,
locationType,
visaClass,
visaType
}

34. Is the payload an object or an array containing an object?

35. Provide the sanitized response.

36. What does the API return when no future month is available?

37. Is getFirstAvailableMonth mandatory, or can getSlotDates be called directly?

SECTION E — AVAILABLE DATES

38. Confirm the exact endpoint, method, and request payload for:
    getSlotDates.

39. Confirm whether this request shape is accurate:

{
fromDate,
toDate,
postUserId,
applicantId,
applicationId,
locationType,
visaClass,
visaType
}

40. Is the payload an object or an array?

41. What date format is required?

42. Is the toDate inclusive?

43. What is the maximum supported date range in one request?

44. Provide a sanitized successful response containing available dates.

45. Provide a sanitized response when no dates are available.

46. Which field definitively means a date is bookable?

47. Can the response contain dates that are displayed but cannot actually be booked?

SECTION F — ADMIN DATE PREFERENCE

48. How does the administrator currently configure the preferred date?

49. Is the preference:

- one exact date;
- earliest date after a minimum date;
- earliest date inside a range;
- any date before a maximum date;
- a month;
- days from now;
- weeks from now?

50. Should the engine always choose the earliest acceptable available date?

51. If an exact preferred date is unavailable, should it:

- wait;
- choose the next date;
- choose an earlier date;
- or notify the administrator?

52. Should pending and reschedule sessions use the same date-selection strategy?

SECTION G — AVAILABLE TIME SLOTS

53. Confirm the exact endpoint, method, and payload for:
    getSlotTime.

54. Which date value must be sent?

55. Does getSlotTime require all the same applicant and visa fields as getSlotDates?

56. Provide a sanitized successful response containing multiple slots.

57. Which response fields identify:

- slotId;
- slot date;
- start time;
- end time;
- slot status;
- slot capacity;
- ruleId?

58. Which status value definitively means the slot is bookable?

59. Should the engine select the earliest available time automatically?

60. If the first date has no usable time slots, should the engine try the next available date?

SECTION H — FINAL BOOKING ENDPOINT

61. What is the exact final appointment-booking endpoint?

62. What HTTP method does it use?

63. Provide the exact sanitized request payload.

64. Identify the source of every required payload field.

65. Which fields come from:

- login session;
- getuser;
- application lookup;
- appointment search;
- getSlotDates;
- getSlotTime;
- administrator configuration?

66. Does the booking endpoint expect:

- appointmentId;
- applicationId;
- applicantId;
- appointmentLocationType;
- appointment date;
- appointment time;
- appointment type;
- slotId;
- postUserId;
- pickup location;
- applicant list;
- workflow data;
- wizard-template data?

67. Is the booking payload different for:

- new/pending appointments;
- rescheduling existing appointments?

68. Is a confirmation endpoint called after the initial booking request?

69. Does the final submission require more than one API call?

70. Is there an intermediate reservation or slot-locking request?

71. Can a slot expire between getSlotTime and the booking request?

72. What response confirms the booking succeeded?

73. What response means the slot was taken by another applicant?

74. Is there a booking confirmation number?

75. Is the booking request safe to retry?

76. Is there any idempotency identifier?

SECTION I — POST-BOOKING VERIFICATION

77. Which endpoint should be called after submission to verify the appointment?

78. Should appointments/search be called again?

79. Which fields must match before the worker emits COMPLETED?

80. Should the worker compare:

- selected date;
- selected time;
- appointment status;
- appointmentId;
- confirmation/reference number?

81. What response means the booking is pending rather than completed?

82. Should the browser remain open after a successful API booking?

SECTION J — ERRORS AND SESSION RECOVERY

83. Provide known responses for:

- expired access token;
- expired refresh token;
- unauthorized;
- forbidden;
- no dates;
- no time slots;
- slot conflict;
- duplicate appointment;
- invalid applicant;
- invalid application;
- platform maintenance;
- rate limit;
- blocked account.

84. What endpoint or page should be used to refresh or recreate the session?

85. When should Playwright reopen the login page?

86. Should the worker pause for manual login again or automatically restart the profile?

87. Which errors are retryable?

88. Which errors should permanently stop the session?

REQUESTED MATERIAL FROM ME:

Ask me to provide sanitized versions of:

1. Copy as cURL for each required request.
2. Request URL.
3. HTTP method.
4. Request headers.
5. Request payload.
6. Response status.
7. Response headers.
8. Response body.
9. The request sequence in chronological order.
10. Separate captures for pending and reschedule modes.
11. A successful booking capture, if available.
12. A failed or slot-conflict response, if available.

Explicitly tell me not to include:

- live bearer tokens;
- refresh tokens;
- passwords;
- CAPTCHA tokens;
- full cookies;
- real applicant names;
- passport numbers;
- real email addresses;
- real appointment confirmation numbers.

TARGET IMPLEMENTATION AFTER I ANSWER:

After receiving my answers, implement the migration in phases.

PHASE 1 — SESSION BRIDGE

Create a backend-only session abstraction such as:

VisaSessionContext {
sessionId;
bookingUserId;
browserContext;
requestContext;
accessToken?;
refreshToken?;
csrfToken?;
correlationKey?;
cookies?;
userAgent?;
proxyUrl?;
tokenExpiresAt?;
authenticatedAt;
lastValidatedAt;
user;
applicant;
application;
appointment;
}

Requirements:

1. Derive all fields dynamically.
2. Keep the object backend-only.
3. Redact secrets from logs.
4. Destroy the session on logout or terminal completion.
5. Support reauthentication.
6. Continue using the same proxy assigned during login.
7. Prefer Playwright browserContext.request for the first version because it can reuse the authenticated browser session.
8. Only introduce a separate Python service after the Node.js API flow is fully verified and a concrete benefit is demonstrated.

PHASE 2 — TYPED VISA API CLIENT

Create a dedicated module, for example:

backend/src/services/visaApi/
visaApiClient.js or visaApiClient.ts
visaApiTypes.js or visaApiTypes.ts
sessionExtractor.js
applicantResolver.js
dateSelector.js
bookingVerifier.js
errors.js
index.js

The client should expose clearly separated methods similar to:

- getAuthenticatedUser()
- resolveApplicantContext()
- searchCurrentAppointments()
- getWorkflowData()
- getFirstAvailableMonth()
- getAvailableDates()
- getAvailableTimeSlots()
- submitPendingAppointment()
- submitRescheduleAppointment()
- verifyAppointment()
- refreshSessionIfPossible()

Do not use generic untyped objects throughout the booking engine.

PHASE 3 — API BOOKING ENGINE

Create a booking engine that performs:

1. Validate authenticated session.
2. Resolve applicant and application.
3. Resolve current appointment state.
4. Read the administrator’s preferred date configuration.
5. Request first available month when required.
6. Request available dates.
7. Filter dates using the administrator’s preferences.
8. Select the earliest acceptable date unless configured otherwise.
9. Request available time slots.
10. Select the preferred or earliest usable time.
11. Submit the correct pending or reschedule payload.
12. Verify the appointment through an independent follow-up request.
13. Emit COMPLETED only after verification.
14. Send the selected date and time to the current notification service.

PHASE 4 — WORKER INTEGRATION

Integrate the API engine with the current worker process.

Preserve existing IPC communication with WorkerPool.

Introduce structured statuses such as:

- LOGIN_BROWSER_STARTING
- WAITING_FOR_LOGIN
- WAITING_FOR_CAPTCHA
- SESSION_CAPTURED
- SESSION_READY
- RESOLVING_APPLICATION
- SCANNING_DATES
- NO_DATES_AVAILABLE
- DATE_SELECTED
- FETCHING_SLOTS
- NO_SLOTS_AVAILABLE
- SLOT_SELECTED
- SUBMITTING_BOOKING
- VERIFYING_BOOKING
- REAUTHENTICATION_REQUIRED
- RATE_LIMITED
- BOOKING_CONFLICT
- COMPLETED
- STOPPED
- ERROR

PHASE 5 — FEATURE FLAG AND SAFE ROLLOUT

Introduce a configuration option similar to:

VISA_EXECUTION_MODE=dom
VISA_EXECUTION_MODE=api

Requirements:

1. Keep DOM mode working during migration.
2. Default to DOM mode until API mode passes tests.
3. Never silently fall back to DOM final submission after an uncertain API booking response because that could create duplicate submissions.
4. Allow explicit fallback only before a final booking request has been sent.
5. Record which execution mode produced each worker event.

PHASE 6 — ACCOUNT-LEVEL LOCK

Implement a strict account-level execution lock.

Requirements:

1. One active session per booking account.
2. Starting another session for the same account must:
   - return the existing active session;
   - reject the new start;
   - or queue it behind the existing session.
3. The behavior must be deterministic and documented.
4. Locks must be released on:
   - completion;
   - stop;
   - worker crash;
   - authentication failure;
   - terminal error.
5. Different accounts may run according to MAX_CONCURRENT.

PHASE 7 — DATE SELECTION

Implement date selection as a pure, testable function.

It must accept:

- available dates returned by the API;
- minimum date;
- maximum date;
- exact preferred date if configured;
- pending or reschedule mode;
- current appointment date if relevant;
- selection strategy.

It must return either:

{
selectedDate,
reason
}

or:

{
selectedDate: null,
reason
}

Do not mix date-selection logic into HTTP request code.

PHASE 8 — ERROR HANDLING

Create typed errors such as:

- VisaAuthenticationExpiredError
- VisaSessionInvalidError
- VisaApiUnauthorizedError
- VisaApiForbiddenError
- VisaApiRateLimitedError
- VisaNoDatesAvailableError
- VisaNoSlotsAvailableError
- VisaSlotConflictError
- VisaBookingRejectedError
- VisaBookingVerificationError
- VisaApiContractError
- VisaPlatformUnavailableError

Respect server responses such as Retry-After when they occur.

Do not implement an uncontrolled tight polling loop.

Do not introduce arbitrary request limits unless required by:

- existing administrator configuration;
- observed platform behavior;
- or a confirmed server response.

PHASE 9 — LOGGING AND REDACTION

Implement structured logging.

Log:

- session ID;
- booking user ID;
- endpoint operation name;
- request start and finish;
- HTTP status;
- response duration;
- selected date;
- selected slot;
- state transition;
- sanitized error type.

Never log:

- Authorization headers;
- bearer tokens;
- refresh tokens;
- CAPTCHA tokens;
- cookies;
- passwords;
- complete request headers;
- sensitive applicant data;
- unredacted API responses.

PHASE 10 — TESTING

Create:

1. Unit tests for date filtering.
2. Unit tests for slot selection.
3. Unit tests for payload construction.
4. Unit tests for response parsing.
5. Unit tests for session extraction.
6. Unit tests for secret redaction.
7. Unit tests for account-level locking.
8. Integration tests using mocked API responses.
9. Tests for token expiration.
10. Tests for slot conflict.
11. Tests for verification failure.
12. Tests ensuring COMPLETED is not emitted after only an HTTP 200 response.
13. Tests ensuring a real booking endpoint is never called during normal automated tests.

Use sanitized fixtures.

Do not use production credentials.

Do not send real booking requests.

PHASE 11 — DOCUMENTATION

Update:

- DOCUMENTATION.md
- ALGORITHM_README.md
- BOOKING_WORKER_AUDIT.md
- environment-variable documentation
- session-state documentation

Document:

1. Browser login flow.
2. API session bridge.
3. API endpoint sequence.
4. Dynamic value sources.
5. Pending flow.
6. Reschedule flow.
7. Account locking.
8. Error recovery.
9. Feature flag.
10. Security and redaction.
11. How to return temporarily to DOM mode.

ACCEPTANCE CRITERIA:

The work is complete only when:

1. Successful login creates a backend-only authenticated session.
2. No visa-platform token is exposed to React.
3. No applicant-specific identifier is hard-coded.
4. API mode does not inspect calendar colors or calendar DOM elements.
5. API mode does not click time-slot elements.
6. API mode does not click the final booking button.
7. API mode retrieves dates through the confirmed API.
8. API mode retrieves time slots through the confirmed API.
9. API mode constructs the final booking payload dynamically.
10. API mode verifies the booking through a separate confirmed response or lookup.
11. Only one worker can operate on a specific account.
12. Existing queue functionality remains operational.
13. Existing notifications still receive the selected date and time.
14. Existing stop controls terminate the API workflow.
15. Pending and reschedule modes remain supported.
16. Session expiration transitions to reauthentication rather than corrupting the worker.
17. Secrets are redacted from logs.
18. Tests pass.
19. Lint and type checks pass.
20. DOM mode remains available during rollout.
21. Documentation accurately reflects the new implementation.

DO NOT:

- Guess missing endpoint contracts.
- Infer a final booking payload from field names alone.
- Use values copied from screenshots as constants.
- Store visa tokens in the frontend.
- remove Playwright login support.
- automate CAPTCHA solving.
- remove the existing worker pool.
- rewrite the entire application.
- introduce Python merely because it may sound faster.
- perform a production booking while developing.
- mark a booking COMPLETED based only on HTTP status 200.
- expose sensitive DevTools captures in committed files.

EXPECTED FIRST RESPONSE:

Your first response must:

1. Audit the repository.
2. Explain the existing worker flow.
3. Propose the migration boundaries.
4. Present the complete endpoint questionnaire.
5. Identify any additional questions discovered from the codebase.
6. Stop and wait for my answers.

Do not modify code before I provide those answers.
