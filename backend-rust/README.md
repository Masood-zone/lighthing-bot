# lightning-bot-api (Rust)

Rust rewrite of the Node.js backend for benchmarking purposes.
Lives on branch `perf/rust-backend`.

## Stack

| Concern | Crate |
|---|---|
| HTTP framework | [Axum 0.7](https://docs.rs/axum) |
| Async runtime | Tokio |
| Serialization | Serde / serde_json |
| Auth / JWT | jsonwebtoken |
| Password hashing | bcrypt |
| HTTP client | reqwest |
| Logging | tracing + tracing-subscriber |

## Routes (mirroring the Node backend)

| Method | Path | Status |
|---|---|---|
| GET | /api/health | ✅ done |
| POST | /api/auth/login | 🔧 scaffold |
| POST | /api/auth/logout | 🔧 scaffold |
| POST | /api/auth/refresh | 🔧 scaffold |
| GET/POST | /api/users | 🔧 scaffold |
| GET/PUT/DELETE | /api/users/:id | 🔧 scaffold |
| GET/POST | /api/administrators | 🔧 scaffold |
| GET/PUT/DELETE | /api/administrators/:id | 🔧 scaffold |
| GET | /api/analytics | 🔧 scaffold |
| GET | /api/analytics/summary | 🔧 scaffold |
| GET/POST | /api/notifications | 🔧 scaffold |
| GET/POST/DELETE | /api/queue | 🔧 scaffold |
| GET/POST/DELETE | /api/sessions | 🔧 scaffold |

## Running

```bash
cp .env.example .env
cargo run
# or for release (benchmark mode):
cargo run --release
```

## Benchmarking

Run both servers on different ports and use `wrk` or `hyperfine`:

```bash
# Node backend (port 3000)
cd ../backend && node src/server.js

# Rust backend (port 3001)
cd ../backend-rust && cargo run --release

# Benchmark
wrk -t4 -c100 -d10s http://localhost:3000/api/health
wrk -t4 -c100 -d10s http://localhost:3001/api/health
```
