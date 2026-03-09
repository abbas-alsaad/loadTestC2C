# C2C SignalR Load Testing Suite

Enterprise-grade load testing for the C2C marketplace SignalR real-time infrastructure.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     Load Test Runner                     │
│  Node.js + @microsoft/signalr (real SignalR client)      │
├─────────────┬───────────────┬───────────────────────────┤
│ JWT Helper  │ Stats Engine  │ Report Generator           │
│ (HS256 sign)│ (HDR Histogram)│ (HTML + JSON)             │
├─────────────┴───────────────┴───────────────────────────┤
│           Scenarios (01-smoke → 07-breakpoint)           │
│                                                          │
│  PresenceUser           ChatPair                         │
│  ┌─────────────┐       ┌─────────────────────┐          │
│  │ /hubs/presence│      │ Seller PresenceHub  │          │
│  │ • Connect    │       │ Seller MessageHub   │          │
│  │ • Heartbeat  │       │ Buyer  PresenceHub  │          │
│  │ • IsUserOnline│      │ Buyer  MessageHub   │          │
│  │ • Listen     │       │ • SendMessage       │          │
│  │   Notifications│     │ • MessageRead       │          │
│  └──────┬──────┘       │ • Typing            │          │
│         │ WSS           └──────────┬──────────┘          │
└─────────┼──────────────────────────┼────────────────────┘
          │                          │
          ▼                          ▼
┌──────────────────────────────────────────────────────────┐
│  AWS Infrastructure (UAT / Production)                    │
│  ┌─────────────────┐  ┌──────────────────────┐           │
│  │ ALB (WebSocket)  │  │ Redis ElastiCache     │          │
│  │ wss://ws-c2c-api │  │ • Presence tracking   │          │
│  │ .gini.iq         │  │ • SignalR backplane   │          │
│  └────────┬────────┘  │ • Session cache       │          │
│           │            └──────────────────────┘           │
│  ┌────────▼────────┐                                      │
│  │  ECS Pods (N)    │  ← KEDA scales on                  │
│  │  .NET 8 + SignalR│    signalr_connections_active < 100 │
│  └─────────────────┘                                      │
└──────────────────────────────────────────────────────────┘
```

## Why Node.js + @microsoft/signalr (not k6)?

k6 has no native SignalR protocol support. SignalR over WebSocket uses a specific framing protocol:
- JSON text frames with `\x1e` (record separator) terminators
- Ping/pong frames at `KeepAliveInterval` (15s)
- Server timeout at `ClientTimeoutInterval` (60s)
- Invocation IDs for request/response correlation
- Handshake negotiation with protocol version

Using the **official `@microsoft/signalr` client** guarantees:
- 100% correct protocol encoding/decoding
- Automatic reconnection with exponential backoff
- Native heartbeat handling (same as the MiniApp frontend)
- Correct invocation/streaming semantics

## Prerequisites

- **Node.js ≥ 18.0.0** (for native `fetch` and top-level `await`)
- **C2C_TOKEN_KEY** env var — The symmetric JWT signing key (matches `TokenKey` in .NET `appsettings.json`)
- **Database seed** (for chat scenarios only) — Test items + users in UAT database

## Quick Start

```bash
cd C2C.Back/load-tests

# Install dependencies
npm install

# Set the JWT signing key (get from your .NET appsettings or AWS SSM)
export C2C_TOKEN_KEY="your-secret-token-key"

# Run smoke test (10 users, ~30 seconds)
./run.sh --scenario smoke

# Run connection scalability test (0 → 5000 users)
./run.sh --scenario ramp

# Find the server ceiling
./run.sh --scenario breakpoint
```

## Scenarios

| # | Scenario | Connections | Duration | What it tests |
|---|----------|-------------|----------|---------------|
| 01 | **Smoke** | 10 presence + 2 chat pairs | ~30s | Basic connectivity, message delivery |
| 02 | **Presence Ramp** | 0 → 5000 PresenceHub | ~17 min | Connection scalability per tier |
| 03 | **Heartbeat Sustained** | 2000 for 30 min | 30 min | Redis TTL refresh, connection stability |
| 04 | **Chat Throughput** | 500 pairs (2000 connections) | ~15 min | Message delivery latency, 100 msg/s |
| 05 | **Notification Fanout** | 2000 presence users | 10 min | Server → client notification delivery |
| 06 | **Mixed Realistic** | 5000 (80% presence, 20% chat) | 20 min | Production traffic simulation |
| 07 | **Breakpoint** | Ramp until failure | Variable | Find max stable connection count |

## Configuration

All configuration is centralized in `config.js`. Override via environment variables:

| Env Var | Default | Description |
|---------|---------|-------------|
| `C2C_TOKEN_KEY` | *(required)* | JWT signing key |
| `C2C_BASE_URL` | `wss://ws-c2c-api-uat.gini.iq` | Target WebSocket URL |
| `C2C_USER_PREFIX` | `loadtest_user_` | Virtual user name prefix |
| `C2C_SEED_FILE` | `./seed/test-items.json` | Chat test seed data |
| `C2C_RESULTS_DIR` | `./results` | Report output directory |
| `C2C_VERBOSE` | `false` | Per-user connection logs |

## Chat Scenarios (Database Seed Required)

Chat scenarios (04, 06) require test items in the database because
`ChatAuthorizationService` validates that one user is the item seller
and the other is not.

### Step 1: Seed the database

```bash
# Edit seed/seed-load-test.sql to adjust pair count if needed
psql -h <db-host> -U <db-user> -d <db-name> -f seed/seed-load-test.sql
```

### Step 2: Export seed item data

After seeding, update `seed/test-items.json` with the actual item IDs:

```sql
SELECT json_agg(row_to_json(t))
FROM (
  SELECT
    i."Id" AS "itemId",
    u."UserName" AS "sellerUsername",
    'loadtest_buyer_' || ROW_NUMBER() OVER () - 1 AS "buyerUsername"
  FROM "Items" i
  JOIN "Sellers" s ON i."SellerId" = s."Id"
  JOIN "AspNetUsers" u ON s."AppUserId" = u."Id"
  WHERE i."Name" LIKE 'Load Test Item%'
  ORDER BY i."CreatedAt"
) t;
```

Copy the output to `seed/test-items.json`.

### Step 3: Run chat tests

```bash
./run.sh --scenario chat
```

## Reports

Each run generates both HTML and JSON reports in `results/`:

```
results/
├── 01-smoke_2026-03-08T14-30-00_report.html
├── 01-smoke_2026-03-08T14-30-00_report.json
├── 07-breakpoint_2026-03-08T15-00-00_report.html
└── 07-breakpoint_2026-03-08T15-00-00_report.json
```

**HTML report contents:**
- Summary cards (connections, messages, errors)
- Latency distribution table (p50/p95/p99/max)
- Visual latency bars
- Tier progression table (for ramp/breakpoint)
- Error log (last 50 errors)
- Pass/fail verdict

## Thresholds

Default pass/fail criteria (configurable in `config.js`):

| Metric | Threshold |
|--------|-----------|
| Connection success rate | ≥ 99% |
| Message delivery rate | 100% |
| Connection time p99 | < 5,000ms |
| Message latency p99 | < 500ms |
| Heartbeat latency p99 | < 1,000ms |

## Metrics Cross-Reference

During tests, the runner polls the server's `/metrics/signalr` endpoint to verify
client-side counts match server-side counts:

```json
{
  "total": 5000,
  "messageHub": 1000,
  "presenceHub": 4000,
  "timestamp": "2026-03-08T14:30:00Z"
}
```

Also check Redis directly:
```bash
redis-cli -h <redis-host> --tls INFO clients
redis-cli -h <redis-host> --tls DBSIZE
```

## AWS Infrastructure Notes

### KEDA Autoscaling
Your pods scale when `avg(signalr_connections_active) per pod > 100`.
During a 5000-connection test, expect ~50 pods.

### Redis Cluster Slots
- Presence keys use `{presence}:user:X` hash tag → all in one slot
- SignalR backplane uses `ptp-signalr` channel prefix
- Cache uses `PTP` instance name prefix

### CloudFront Bypass
WebSocket traffic uses `wss://ws-c2c-api-uat.gini.iq` which routes directly
to the ALB, bypassing CloudFront (which has WebSocket limitations).

## Cleanup

Remove load test data from UAT database:
```sql
DELETE FROM "Items" WHERE "Name" LIKE 'Load Test Item%';
DELETE FROM "Sellers" WHERE "AppUserId" IN (
  SELECT "Id" FROM "AspNetUsers" WHERE "UserName" LIKE 'loadtest_%'
);
DELETE FROM "AspNetUsers" WHERE "UserName" LIKE 'loadtest_%';
```

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `C2C_TOKEN_KEY is required` | Set the env var: `export C2C_TOKEN_KEY="..."` |
| Chat tests skip | Seed the DB first: `psql -f seed/seed-load-test.sql` |
| Connection timeouts | Check if `wss://ws-c2c-api-uat.gini.iq` is reachable |
| `EMFILE` (too many files) | Increase ulimit: `ulimit -n 65536` |
| Node.js memory | Run with: `node --max-old-space-size=4096 scenarios/...` |
| All users offline in IsUserOnline | Heartbeat may have expired — check Redis TTL (120s) |
