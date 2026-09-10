# AVITS Reschedule Account Booking Session: Video API Analysis

Source video: `C:\Users\Masood\Downloads\Video\Reschedule Account Booking Process .mp4`  
Recording length: about 4 minutes 17 seconds.

## Outcome shown in the recording

The recording shows an AVITS account with an existing POST appointment entering the **Reschedule** flow. The user confirms the change, AVITS finds an available date, returns unbooked time slots, and the user chooses **22 March 2027 at 7:30 AM**. The final request succeeds with HTTP `200`.

The server response creates a replacement appointment record whose `appointmentStatus` is `RESCHEDULED`. It also returns the message that one reschedule was successful and one reschedule remains available. The original appointment ID and selected `slotId` are not retained: AVITS returns a different appointment ID and slot ID.

Credentials, bearer tokens, names, phone/passport data, identifiers, and transaction values displayed in the recording are intentionally redacted below.

## What rescheduling means here

Rescheduling is a replacement operation on an existing appointment, not a brand-new application booking:

1. AVITS loads the account's existing appointment and enables **RESCHEDULE** because the account still has reschedule allowance.
2. The confirmation dialog requires an explicit choice before the calendar flow begins.
3. The calendar searches available months, then dates, then times for the same application, applicant, post, visa class, and visa type.
4. Selecting a green date or an unbooked time only discovers availability. It does not reserve anything.
5. The one final `PUT` is the state-changing operation. Its response establishes whether a replacement appointment was actually made.

```mermaid
sequenceDiagram
    participant UI as AVITS browser UI
    participant Appointment as Appointment API
    participant Availability as Administration API

    UI->>Appointment: GET landing-page details
    Appointment-->>UI: Existing appointment and application context
    UI->>UI: User clicks Reschedule and confirms
    UI->>Availability: POST getFirstAvailableMonth
    Availability-->>UI: First available date marker
    UI->>Availability: POST getSlotDates
    Availability-->>UI: Available calendar dates
    UI->>Availability: POST getSlotTime
    Availability-->>UI: Unbooked slots with slotId values
    UI->>Appointment: PUT appointments/reschedule with [replacement request]
    Appointment-->>UI: 200; replacement appointment is RESCHEDULED
    UI->>UI: Toast reports successful reschedule and remaining allowance
```

## Timeline evidence

| Video time | What is shown | What it proves |
|---|---|---|
| 00:00–00:09 | Sign-in and account dashboard | The session is authenticated; the dashboard shows one existing appointment. |
| 00:12–00:51 | Existing appointment card and DevTools | The account has a POST appointment and a visible **RESCHEDULE** action with two reschedules available. |
| 00:54 | Confirmation dialog | Rescheduling is an explicit user-confirmed action. |
| 01:00–02:57 | Reschedule calendar and availability calls | Availability is discovered in stages; the chosen date is 22 March 2027. |
| 03:18 | 7:30 AM and 9:00 AM buttons; **BOOK POST APPOINTMENT** | These are candidate slots. The selected request uses 7:30 AM. |
| 03:21–03:24 | `PUT` request, `200 OK`, request payload | The final mutation is sent to the reschedule endpoint. |
| 03:27–03:48 | Dashboard toast and response object | AVITS reports a successful reschedule; the response record is `RESCHEDULED`. |

## API endpoint inventory visible in the recording

Base host: `https://www.usvisaappt.com`

| Method | Endpoint | Visible payload / response | Role |
|---|---|---|---|
| GET | `/visaappointmentapi/appointments/getLandingPageDetails` | `200 OK`; response contains application and applicant context, including appointment details | Loads the account context shown on the landing page. Personal fields were visible and are excluded here. |
| GET | `/visaadministrationapi/v1/appointmentrequest/getallbyuser?type=GROUPREQUEST` | `404 Not Found` in this recording | A surrounding dashboard request. It is not the final reschedule call and its `404` does not prevent the successful reschedule. |
| POST | `/visaadministrationapi/v1/modifyslot/getFirstAvailableMonth` | `200 OK`; `{ date: "2027-03-22T00:00:00.000+00:00", message: "Slot is available", present: true }` | Finds the first available appointment date. |
| POST | `/visaadministrationapi/v1/modifyslot/getSlotDates` | `200 OK`; calendar dates are rendered | Gets the available dates for the selected period. |
| POST | `/visaadministrationapi/v1/modifyslot/getSlotTime` | `200 OK`; array of slots with `slotDate`, `startTime`, `endTime`, `slotStatus: "UNBOOKED"`, and `slotId` | Gets the bookable times after a date is selected. |
| PUT | `/visaappointmentapi/appointments/reschedule` | `200 OK`; array containing the replacement appointment | Performs the actual reschedule. |

The video contains many other dashboard, workflow, language, notification, and history calls in the DevTools list. They are supporting page activity. The table only labels an endpoint as part of rescheduling where its full path or directly relevant request/response is readable in the recording.

## Availability request contracts

All three availability calls carry the same context values. The recorded values are replaced with safe placeholders.

### 1. First available month

`POST /visaadministrationapi/v1/modifyslot/getFirstAvailableMonth`

```json
{
  "postUserId": "<post-user-id>",
  "applicantId": "<applicant-id>",
  "applicationId": "<application-id>",
  "locationType": "POST",
  "visaClass": "F1",
  "visaType": "NIV"
}
```

The visible response marks `2027-03-22` as present with the message `Slot is available`.

### 2. Available dates

`POST /visaadministrationapi/v1/modifyslot/getSlotDates`

```json
{
  "fromDate": "2027-03-22",
  "toDate": "2027-03-31",
  "postUserId": "<post-user-id>",
  "applicantId": "<applicant-id>",
  "applicationId": "<application-id>",
  "locationType": "POST",
  "visaClass": "F1",
  "visaType": "NIV"
}
```

The UI renders green dates after this response. A green date is a discovery result, not a booking confirmation.

### 3. Available times

`POST /visaadministrationapi/v1/modifyslot/getSlotTime`

```json
{
  "fromDate": "2026-09-10",
  "toDate": "2026-09-30",
  "slotDate": "2027-03-22",
  "postUserId": "<post-user-id>",
  "applicantId": "<applicant-id>",
  "applicationId": "<application-id>",
  "visaClass": "F1",
  "visaType": "NIV"
}
```

The returned objects include fields like:

```json
{
  "slotDate": "2027-03-22T00:00:00.000+00:00",
  "startTime": "2027-03-22T07:30:00.000+00:00",
  "endTime": "2027-03-22T07:45:00.000+00:00",
  "slotStatus": "UNBOOKED",
  "slotId": "<available-slot-id>",
  "status": "A"
}
```

The visible UI lists 7:30 AM and 9:00 AM. The final request uses the 7:30 AM slot.

## Final reschedule contract

`PUT /visaappointmentapi/appointments/reschedule`

The body is a **one-item JSON array**, even for a single applicant. The body shown in DevTools has this structure:

```json
[
  {
    "appointmentId": "<current-appointment-id>",
    "applicantUUID": null,
    "appointmentLocationType": "POST",
    "applicantId": "<applicant-id>",
    "applicationId": "<application-id>",
    "appointmentDt": "2027-03-22T00:00:00.000+00:00",
    "appointmentStatus": "SCHEDULED",
    "appointmentTime": "7:30 AM",
    "postUserId": "<post-user-id>",
    "rescheduleType": "POST",
    "slotId": "<selected-slot-id>"
  }
]
```

`appointmentLocationType` and `rescheduleType` being `POST` describe the appointment location/type. They do not mean this HTTP call uses the `POST` method; the actual final method is `PUT`.

## Final response and verification rule

The request receives `HTTP 200 OK` and returns an array with one replacement appointment. Key response properties visible in DevTools are:

```json
[
  {
    "appointmentId": "<new-appointment-id>",
    "applicationId": "<application-id>",
    "applicantId": "<applicant-id>",
    "appointmentDt": "2027-03-22T00:00:00.000+00:00",
    "appointmentLocationType": "POST",
    "appointmentStatus": "RESCHEDULED",
    "appointmentTime": "7:30 AM",
    "appointmentType": "REGULAR_NIV",
    "isReschedule": null,
    "rescheduleLimit": 1,
    "responseMsg": "You have made 1 successful reschedule and 1 more reschedule slots are available.",
    "slotId": "<server-returned-slot-id>"
  }
]
```

Use the response to confirm success. In this recording the service substitutes both the appointment ID and the slot ID, so a client should confirm stable meaning instead of demanding literal ID equality:

- HTTP status is `200`.
- The returned appointment belongs to the intended application and applicant.
- `appointmentStatus` is `RESCHEDULED`.
- Returned date and time are `2027-03-22` and `7:30 AM`.
- The response message and `rescheduleLimit` agree with the dashboard toast.

Do not retry this final `PUT` automatically after an ambiguous timeout or connection failure. First reload or read the appointment state: the provider may have completed the reschedule even if the client did not receive its response.

## How this should guide an AVITS reschedule worker

1. Start only with a known existing appointment and a user-authorized target date/time policy.
2. Keep the application, applicant, post, visa class, and visa type together through every availability request.
3. Treat first-month, date, and time APIs as sequential discovery calls. Refresh the time slot immediately before the final mutation.
4. Send exactly one one-item-array `PUT` request after selecting a still-unbooked slot.
5. Mark the operation successful only after validating the returned response record, then persist the server-returned appointment ID and slot ID.
6. On `409`, refresh availability; on a timeout or `5xx`, treat the result as unknown and inspect state before deciding whether another attempt is safe.

## Evidence limits

This report describes the network calls and UI states visible in this one recording. It does not claim that every endpoint is stable across AVITS accounts, posts, visa categories, deployments, or future sessions. The file does not replay the transaction, does not expose credentials or tokens, and does not independently validate a live appointment.
