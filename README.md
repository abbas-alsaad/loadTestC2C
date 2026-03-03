# C2C SignalR Load Test Suite

k6-based load testing suite for validating SignalR WebSocket connections across multiple server instances with Redis backplane.

## Prerequisites

```bash
brew install k6
```

## Directory Structure

```
load-tests/
├── config.js                          # Shared configuration (URLs, JWT, stages, thresholds)
├── run.sh                             # Progressive runner script
├── README.md
├── helpers/
│   ├── jwt.js                         # HS256 JWT token generator (per-VU identity)
│   └── signalr.js                     # SignalR JSON protocol helpers
├── scenarios/
│   ├── presence-hub.js                # PresenceHub connection lifecycle + heartbeat
│   ├── message-hub.js                 # MessageHub chat flow (send/receive messages)
│   ├── notification-broadcast.js      # Notification listener (Redis backplane verification)
│   └── full-flow.js                   # E2E: QR scan → offer → accept → pay → notifications
└── results/                           # Auto-created, contains test output JSON files
```

## Quick Start

### Smoke Test (10 VUs)
```bash
# Single scenario
k6 run --env TARGET_URL=https://c2c-uat.gini.iq scenarios/presence-hub.js

# All core scenarios via runner
./load-tests/run.sh
```

### Progressive Ramp (smoke → low → medium → high)
```bash
./load-tests/run.sh --progressive
```

### Specific Stage
```bash
./load-tests/run.sh --stage medium --scenario presence-hub
```

## Scenarios

### 1. `presence-hub.js` — Connection & Heartbeat
Tests the core PresenceHub WebSocket lifecycle:
- JWT authentication via `?access_token=` query param
- SignalR negotiate + WebSocket upgrade
- JSON protocol handshake
- Periodic `Heartbeat()` invocations (Redis TTL refresh)
- `UserIsOnline` / `UserIsOffline` event reception
- Graceful disconnect after hold duration

**Metrics:** `ws_connecting_duration`, `ws_handshake_duration`, `ws_errors`, `heartbeats_sent`

### 2. `message-hub.js` — Chat Flow
Tests MessageHub with paired VUs exchanging messages:
- Connects with `recipientUsername` + `itemId` query params
- Receives `ReceiveMessageThread` on connect
- Sends messages via `SendMessage` hub invocation
- Tracks `NewMessage` delivery and completion latency
- Tests `Typing` indicators

**Requires:** `--env ITEM_ID=<guid>` (pre-seeded item where both users are authorized)

**Metrics:** `messages_sent`, `messages_received`, `message_delivery_latency`

### 3. `notification-broadcast.js` — Redis Backplane Verification
Connects many VUs to PresenceHub and listens for notification events:
- `InPersonOfferReceived`
- `InPersonOfferStatusChanged`
- `PaymentCompleted`
- `OfferReceived` / `OfferStatusChanged`
- `InvoiceCreated`
- `ChatMessageNotification`

Use alongside manual or automated triggers to verify notifications cross server instances.

**Metrics:** `notification_delivery_latency`, per-event counters (`event_InPersonOfferReceived`, etc.)

### 4. `full-flow.js` — End-to-End Lifecycle
Simulates complete in-person offer flow with HTTP + WebSocket:
1. Seller & buyer connect to PresenceHub
2. Buyer scans QR → creates in-person offer
3. Seller receives notification → accepts
4. Buyer pays → both receive PaymentCompleted

**Requires:** `--env SELLER_ID=<guid>` (pre-seeded seller)

**Metrics:** `e2e_flow_latency`, `full_flow_completed`, `full_flow_failed`

## Load Stages

| Stage    | Peak VUs | Duration | Use Case                          |
|----------|----------|----------|-----------------------------------|
| smoke    | 10       | 1m       | Verify setup works                |
| low      | 100      | 4m       | Baseline performance              |
| medium   | 1,000    | 7m       | Normal production load            |
| high     | 5,000    | 10m      | Peak load / stress test           |
| extreme  | 100,000  | 18m      | Breaking point / capacity planning|

## Custom Target URL

```bash
# Local development
k6 run --env TARGET_URL=http://localhost:9224 scenarios/presence-hub.js

# Via ngrok
k6 run --env TARGET_URL=https://mini2.ngrok.app scenarios/presence-hub.js

# UAT (default)
k6 run --env TARGET_URL=https://c2c-uat.gini.iq scenarios/presence-hub.js
```

## JWT Authentication

Each VU generates its own JWT token client-side using the shared HS256 secret. Tokens match the `QiServiceScheme` configuration:

- **Algorithm:** HS256
- **Issuer:** `qi-services`
- **Audience:** `F0E62818-F5CE-4844-B01D-5F1A9F105967`
- **Claims:** `username`, `UserId`, `nameid`, `sub`

To use a different secret:
```bash
k6 run --env JWT_SECRET=your-secret-here scenarios/presence-hub.js
```

## Thresholds

Default pass/fail thresholds:

| Metric                          | Threshold   |
|---------------------------------|-------------|
| `ws_connecting_duration` (p95)  | < 2000ms    |
| `ws_handshake_duration` (p95)   | < 1000ms    |
| `ws_errors` (rate)              | < 1%        |
| `notification_delivery_latency` | < 500ms     |
| `http_req_duration` (p95)       | < 3000ms    |
| `http_req_failed` (rate)        | < 5%        |

## Results

Results are saved to `load-tests/results/` with the format:
```
{scenario}_{stage}_{timestamp}.json        # Summary export
{scenario}_{stage}_{timestamp}_raw.json    # Raw k6 output (for Grafana/InfluxDB)
```

## Tips

1. **Start with smoke tests** to verify connectivity and auth
2. **Check server logs** during tests for auth failures or Redis errors
3. **Monitor Redis** — ElastiCache metrics show pub/sub throughput
4. **Scale k6 runners** — For extreme stage, consider running from multiple machines with `k6 cloud` or distributed k6
5. **WebSocket auth** — Ensure `OnMessageReceived` handler is configured in `QiServiceScheme` to extract tokens from query string during WebSocket upgrade
