# Development Guidelines: Automation Service Architecture

## 1) Core reframing: this is not “a bot”, it’s an **Automation Service**

At scale, the system has four distinct planes:

1. **User Interface (Control Plane)**  
    Where humans configure, start, pause, and observe.

2. **Execution Engine (Automation Plane)**  
    Where Selenium instances live, breathe, and occasionally misbehave.

3. **State & Queue Manager (Coordination Plane)**  
    Where multiple accounts, retries, and priorities are orchestrated.

4. **Notification & Reporting (Feedback Plane)**  
    Where outcomes are communicated and audited.

Once these are treated as separate concerns, the overall design becomes tractable.

---

## 2) Interface concept #1: “Paste link → Start”

### What the user sees
A boring, safe UI:

- **Login URL**
- **Email**
- **Password**
- **Start Session** button

Optional:
- **Open visible browser** (checkbox)
- **Pickup location preference** (dropdown)

### What actually happens

**React app → backend payload:**
```json
{
  "loginUrl": "...",
  "email": "...",
  "password": "...",
  "visible": true
}
```

**Backend responsibilities:**
- Validate URL pattern (basic sanity, not trust)
- Create a session record
- Spawn a Selenium worker with those parameters

**Selenium worker flow:**
- Open Chrome
- Navigate to provided URL
- Execute the standardized login flow
- Wait for CAPTCHA (human step)
- Continue autonomously

**Important constraint:**  
The automation does not “discover” flows. It applies a known workflow to a user-supplied entry point.  
This prevents complexity explosion.

---

## 3) Interface concept #2: Bulk / queue-based login

This is where the system becomes commercially interesting.

### UI (React)
A table-based interface:

| Account | Email   | Status            | Action |
|--------:|---------|-------------------|--------|
| #1      | a@x.com  | Idle              | Start  |
| #2      | b@x.com  | Waiting CAPTCHA   | View   |
| #3      | c@x.com  | Scanning          | Pause  |

Controls:
- Add Account
- Bulk Start
- Pause All
- Resume

Implementation can be plain React + `fetch`. No heroics.

---

## 4) Backend architecture (this matters)

### Recommended stack
- **Node.js backend**
- **Job queue:** BullMQ (or simple in-memory queue initially)
- **Worker pool:** 1 Selenium instance = 1 worker
- **Persistent store:** SQLite is fine to start

### Conceptual model
```text
[ React UI ]
      |
      v
[ API Server ]
      |
      v
[ Queue Manager ] ---> [ Worker #1 (Chrome) ]
                        ---> [ Worker #2 (Chrome) ]
                        ---> [ Worker #3 (Chrome) ]
```

### Worker contract
Each worker:
- owns exactly one browser
- owns exactly one account session
- reports status periodically

---

## 5) Multiple Chrome instances (yes, but controlled)

Rule: **One Chrome instance per account, never uncontrolled concurrency.**

Enforce:
- Max concurrent browsers (e.g., 3–5)
- Others stay queued

Why:
- system stability
- memory usage
- CAPTCHA sanity
- human oversight

Technical detail:
- Each worker runs Selenium with its own Chrome **profile directory**
- This preserves cookies and session state

---

## 6) Session persistence & resume (very important)

### Persist per-session fields
- current URL
- last successful state (e.g., `DASHBOARD`, `APPOINTMENT_PAGE`, `SCANNING`)
- timestamp of last action

### On restart
Worker:
- reopens browser
- navigates to last known URL
- runs session health check
- resumes state machine

State machines enable this; linear scripts do not.

---

## 7) Notifications (email-first, others later)

### Trigger conditions
- appointment found
- appointment booked
- session expired
- manual intervention required

### Flow
**Worker → Backend → Notification service**

Email is easiest:
- SMTP or transactional provider
- template-driven messages
- no real-time dependency

Later additions:
- WhatsApp
- SMS
- Push (mobile)

---

## 8) Appointment prioritization logic (keep it simple at first)

Avoid over-engineering.

- **Phase 1:** first available date wins  
- **Phase 2:** earliest date within preferred range  
- **Phase 3:** priority tiers (VIP clients, earlier scanning intervals)

This logic belongs in the **backend**, not Selenium.

Selenium asks: “Is this date acceptable?”  
Backend answers: **yes/no**.

---

## 9) Practical roadmap (what to build next)

### Week 1
- backend API
- one worker, one session
- UI to start/stop

### Week 2
- queue + multiple sessions
- status reporting
- email notifications

### Week 3
- persistence
- resume logic
- basic prioritization

Only after that: polish UX.

---

## Final reality check

You’re not building “a hack.” You’re building:
- a workflow automation system
- with human checkpoints
- and observable state

Next useful move: **draw the state machine explicitly** (states + transitions). After that, implementation becomes boring—in the best possible way.
