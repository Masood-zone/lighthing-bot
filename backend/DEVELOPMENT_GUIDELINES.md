# Development Guidelines: Automation Service Architecture

## 1) Core reframing: this is not "a bot", it's an **Automation Service**

At scale, the system has four distinct planes:

1. **User Interface (Control Plane)**  
   Where humans configure, start, pause, and observe.

2. **Execution Engine (Automation Plane)**  
   Where Playwright instances live, breathe, and handle CAPTCHAs automatically.

3. **State & Queue Manager (Coordination Plane)**  
   Where multiple accounts, retries, and priorities are orchestrated.

4. **Notification & Reporting (Feedback Plane)**  
   Where outcomes are communicated and audited.

Once these are treated as separate concerns, the overall design becomes tractable.

---

## 2) Interface concept #1: "Paste link → Start"

### What the user sees

A boring, safe UI:

- **Login URL**
- **Email**
- **Password**
- **2Captcha API Key**
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
  "captchaApiKey": "...",
  "visible": true
}
```
