# LightingBot - Application Documentation

## Overview

LightingBot is an automated visa appointment booking system. It automates the process of logging into the US Visa Appointment platform (usvisaappt.com), searching for available appointment dates, and booking them — all without manual intervention.

The system is designed for administrators who manage multiple visa applicants and want to continuously monitor and book appointments as soon as slots become available.

---

## Architecture

The application consists of three main components:

| Component | Technology | Purpose |
|-----------|-----------|---------|
| **Backend** | Node.js + Express | REST API, worker orchestration, data persistence |
| **Frontend** | React 19 + Vite + TypeScript | Admin dashboard web interface |
| **Desktop App** | Electron | Standalone desktop version (wraps both backend + frontend) |

### How It Works (High-Level Flow)

```
Admin logs in → Creates a "Booking User" (applicant credentials) → Starts a booking hunt →
Backend spawns an isolated worker process → Worker opens a headless Chrome browser →
Logs into visa platform → Navigates to appointment booking → Searches for available dates →
Books the appointment → Sends email notification to admin
```

---

## Backend

### Tech Stack

- **Runtime**: Node.js 20+
- **Framework**: Express.js
- **Browser Automation**: Playwright (primary) + Selenium WebDriver (legacy)
- **Data Storage**: File-based JSON (no external database required)
- **Email**: Nodemailer (SMTP)
- **Package Manager**: pnpm

### Server

The backend runs as a single Express server (default port `3001`). It exposes a REST API for the frontend and manages worker processes for booking automation.

**Key environment variables:**

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | `3001` |
| `MAX_CONCURRENT` | Maximum parallel booking workers | `3` |
| `VISA_EXECUTION_MODE` | Booking execution mode: `api` for authenticated API booking, `dom` for the legacy Playwright DOM flow | `api` |
| `ADMIN_EMAIL` | Bootstrap admin email | — |
| `ADMIN_PASSWORD` | Bootstrap admin password | — |
| `VISA_SECRET_KEY` | Encryption key for stored passwords | — |
| `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS` | Email notification SMTP config | — |
| `PROXY_API_KEY` | Proxy11 API key for rotating proxies | — |

### API Endpoints

#### Public

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Health check |
| GET | `/api/health` | Health check (alias) |

#### Authentication

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/login` | Login with email/password, returns bearer token |
| GET | `/api/auth/me` | Get current user info from token |
| POST | `/api/auth/logout` | Revoke current token |
| POST | `/api/auth/create-admin` | Create a new admin user (requires auth or setup token) |

#### Users (Booking Applicants) — Requires Auth

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/users` | List all booking user profiles |
| GET | `/api/users/:id` | Get a specific user's details |
| GET | `/api/users/:id/logs` | Get activity logs for a user |
| POST | `/api/users` | Create a new booking user |
| PUT | `/api/users/:id` | Update a booking user |
| DELETE | `/api/users/:id` | Delete a booking user |

#### Sessions (Booking Hunts) — Requires Auth

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/sessions/:id/start` | Start a booking hunt for a user |
| POST | `/api/sessions/:id/stop` | Stop a running booking hunt |

#### Queue — Requires Auth

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/queue` | Get current worker queue status |

#### Analytics — Requires Auth

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/analytics` | Get system-wide analytics snapshot |
| GET | `/api/analytics/stream` | Real-time analytics via Server-Sent Events (SSE) |

#### Notifications — Requires Auth

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/notifications` | Get notification email recipient |
| PUT | `/api/notifications` | Set/update notification email recipient |
| DELETE | `/api/notifications` | Remove notification recipient |

#### Administrators — Requires Auth

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/administrators` | List notification admin recipients |
| POST | `/api/administrators` | Add a notification admin recipient |
| DELETE | `/api/administrators/:id` | Remove a notification admin |

### Data Storage

All data is stored as JSON files in a local `data/` directory:

| File | Contents |
|------|----------|
| `data/store.json` | All booking user sessions and their states |
| `data/users.json` | Admin user accounts (email, hashed passwords, roles) |
| `data/notification-email.json` | Notification email recipient |
| `data/admins.json` | Seeded admin recipients |

### Authentication System

- Bearer token-based authentication (tokens are random 32-byte strings)
- Tokens expire after 12 hours (configurable via `AUTH_TOKEN_TTL_MS`)
- Passwords are hashed with scrypt (for admin accounts)
- Visa platform passwords are encrypted at rest with AES-256-GCM (requires `VISA_SECRET_KEY`)

### Worker Pool & Booking Automation

When an admin starts a booking hunt:

1. The backend adds the session to a **worker queue**
2. If a worker slot is available (up to `MAX_CONCURRENT`), a **child process** is forked
3. The child process runs the booking automation script (Playwright-based)
4. The worker communicates status updates back to the backend via IPC
5. The backend updates the session status and logs in real time

**Session States:**
- `CREATED` — User profile created, not yet started
- `QUEUED` — Waiting for an available worker slot
- `RUNNING` — Worker is actively automating the booking
- `STOPPED` — Manually stopped by admin
- `COMPLETED` — Booking was successfully made
- `ERROR` — Worker encountered an error
- `BLOCKED` — Access restriction detected on the platform

### Booking Automation Logic

The worker supports two execution modes:

- `VISA_EXECUTION_MODE=api` uses Playwright for browser launch, manual login/CAPTCHA, authenticated session capture, and reauthentication. Appointment discovery, date/slot retrieval, submission, and verification then run through backend-only authenticated API calls. This is the default app mode.
- `VISA_EXECUTION_MODE=dom` keeps the legacy Playwright DOM workflow available as an explicit fallback.

Visa-platform bearer tokens, refresh tokens, CSRF values, cookies, CAPTCHA tokens, and session-storage values are never returned to the React frontend or SSE payloads.

The worker performs the following steps:

1. **Launch browser** — Opens a headless (or visible) Chrome instance, optionally with a proxy
2. **Login** — Navigates to the visa platform login page, fills in credentials, waits for CAPTCHA (manual or auto)
3. **Navigate to booking** — Goes to "Pending Appointment" or "Reschedule" mode
4. **Select pickup point** — Chooses the configured location (e.g., "Accra")
5. **Scan calendar** — Looks for **green-colored dates** (indicating availability) within the allowed date range
6. **Select date & time** — Clicks an available date, then selects a time slot
7. **Confirm booking** — Clicks through confirmation dialogs
8. **Verify** — Detects success signals (URL change to dashboard, success toasts)
9. **Notify** — Sends email notification to configured administrators

**Key automation features:**
- **Date range filtering** — Can filter by absolute dates, days-from-now, or weeks-from-now
- **Proxy support** — Supports per-session proxies, proxy pools, and Proxy11 rotating proxies
- **Proxy health checks** — Pre-flight TCP and HTTP CONNECT checks before launching workers
- **Calendar traversal** — Scans multiple months looking for available dates
- **Reschedule mode** — Can reschedule existing appointments instead of creating new ones
- **Persistent Chrome profiles** — Maintains login state between sessions

### API Booking Engine

In API mode the worker:

1. Opens the visa login page in Playwright and waits for manual CAPTCHA/login.
2. Captures the backend-only browser session, including `sessionStorage.authToken`, cookies, user-agent, CSRF/refresh headers, and dynamic correlation headers when observed.
3. Calls `GET /visauserapi/portal/getuser`.
4. Calls `GET /visaadministrationapi/v1/postconfiguration/get/483` to load the selected Accra post configuration.
5. Resolves application and appointment context from authenticated bootstrap/browser data.
6. Calls `POST /visaadministrationapi/v1/modifyslot/getFirstAvailableMonth`.
7. Calls `POST /visaadministrationapi/v1/modifyslot/getSlotDates`.
8. Filters dates using the configured absolute, days-from-now, or weeks-from-now window.
9. Calls `POST /visaadministrationapi/v1/modifyslot/getSlotTime` for candidate dates and selects the earliest `UNBOOKED` + active slot.
10. Submits pending appointments with `POST /visaappointmentapi/appointments/schedule/group` using a single object body.
11. Submits reschedules with `PUT /visaappointmentapi/appointments/schedule/group` using a single object body.
12. Verifies completion by matching the returned appointment fields from the final booking response.

The selected Accra post id defaults to `483` and can be overridden with `VISA_SELECTED_POST_USER_ID` for a future post/location.

Final submission requests are not automatically retried after an ambiguous timeout or disconnect. The worker requires the final response to match the selected booking before reporting completion.

### Account-Level Locking

Only one queued or running worker may exist for a specific visa booking account at a time. The lock key is based on the visa login host and the booking email. Starting a second session for the same account returns `409 account_session_locked` with the existing session id. Locks are released when the session is stopped, fails to start, completes, errors, or the worker exits.

### Returning to DOM Mode

Set:

```bash
VISA_EXECUTION_MODE=dom
```

to use the original Playwright DOM workflow. API mode is now the normal app path.

### Proxy System

The system supports multiple proxy configurations:

1. **Session-level proxy** — Each booking user can have its own proxy URL
2. **Proxy pool** — A list of proxies from which the least-used one is assigned
3. **Proxy11 integration** — Dynamic proxy rotation via the Proxy11 API
4. **Fallback proxy** — A single proxy used when no pool is configured

Proxies are tested before use (TCP connectivity + HTTP CONNECT tunnel to the target platform).

---

## Frontend

### Tech Stack

- **Framework**: React 19 with TypeScript
- **Build Tool**: Vite 7
- **Styling**: Tailwind CSS 4
- **UI Components**: Radix UI (shadcn/ui pattern)
- **State Management**: Zustand (client state) + Tanstack React Query (server state)
- **Routing**: React Router DOM 7
- **Forms**: React Hook Form + Zod validation
- **Charts**: Recharts

### Pages & Features

#### Login Page (`/`)
- Email/password login form
- Redirects to admin dashboard on success
- Token stored in client state (Zustand)

#### Admin Dashboard (`/admin`)
- **Summary cards** — Total users, active sessions, completed bookings, errors
- **Admins list** — Shows configured notification administrators
- **Notification email** — Displays current notification recipient
- **Visa users status** — Breakdown of users by status (created, running, completed, error, etc.)
- **Queue status** — Active and queued workers
- **Recent activity** — Latest completed bookings and errors

#### Users Management (`/admin/users`)
- **User list table** — Shows all booking users with email, name, timeline preferences, and reschedule mode
- **Create user** — Form to add a new booking user with:
  - Platform login URL
  - Email and password (for the visa platform)
  - Display name
  - Pickup point (e.g., "Accra")
  - Headless browser mode toggle
  - Reschedule mode toggle
  - Date range preferences (absolute dates, days-from-now, weeks-from-now)
  - Proxy URL (optional)
- **Edit user** — Update any user configuration
- **Delete user** — Remove a user and their Chrome profile
- **User details** (`/admin/users/:id`) — View individual user logs and status

#### Bookings Management (`/admin/bookings`)
- **Start session** — Select a user and click "Start booking hunt" to begin automation
- **Session cards** — Each active session shows:
  - User name and email
  - Session status (Idle / Started / Stopped)
  - Session ID
  - Last event timestamp
  - Last API response
- **Stop session** — Kill a running worker

---

## Desktop Application (Electron)

The desktop app is an Electron wrapper that bundles both the backend server and the frontend into a single standalone application.

### Features
- **Embedded backend** — Runs the Express server + worker pool inside the Electron main process
- **Bundled frontend** — Serves the React admin dashboard
- **Auto-updater** — Supports automatic updates via `electron-updater`
- **Cross-platform builds** — Can be built for Windows, macOS, and Linux

### Building

```bash
# Install dependencies
npm run backend:prepare

# Build for Windows
npm run build:win

# Build for macOS
npm run build:mac

# Build for Linux
npm run build:linux
```

---

## Security Considerations

- Admin passwords are hashed using scrypt (password-based key derivation)
- Visa platform passwords are encrypted at rest using AES-256-GCM with a server-side secret key
- Proxy URLs are also encrypted at rest
- Bearer tokens are cryptographically random and expire after 12 hours
- The API requires authentication for all endpoints except health checks and login
- CORS is enabled for cross-origin requests

---

## Deployment

### Backend (Server)

```bash
cd backend
pnpm install
# Set environment variables (ADMIN_EMAIL, ADMIN_PASSWORD, VISA_SECRET_KEY, SMTP_*)
pnpm start
```

### Frontend (Web)

```bash
cd frontend
pnpm install
pnpm build    # Produces static files in dist/
# Serve dist/ with any static file server or deploy to Vercel/Netlify
```

### Desktop App

```bash
cd desktop-app
npm run build:win   # or build:mac / build:linux
```

---

## Summary

LightingBot is a full-stack visa appointment automation system that:

1. Provides an admin dashboard to manage multiple visa applicant profiles
2. Automates the browser-based booking process using headless Chrome
3. Supports concurrent booking sessions with configurable worker limits
4. Includes proxy support for IP rotation and anti-detection
5. Sends email notifications when appointments are booked
6. Offers both web-based and standalone desktop deployment options
7. Stores all data locally with encrypted credentials
