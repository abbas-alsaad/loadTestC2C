/**
 * Presence Stress Test (Redis Presence Tracking)
 *
 * Stress-tests the Redis-backed presence system under concurrent load:
 *   - Many VUs connect to PresenceHub simultaneously (SADD to Redis SET)
 *   - Each VU periodically calls IsUserOnline() for random other VUs
 *     (SISMEMBER on shared Redis SET)
 *   - Each VU sends Heartbeat() to refresh Redis key TTL (EXPIRE)
 *   - On disconnect, SREM removes the user from the Redis SET
 *
 * What this validates:
 *   - Redis presence tracking accuracy under high concurrency
 *   - IsUserOnline latency at scale (SISMEMBER performance)
 *   - Heartbeat reliability (keys don't expire prematurely)
 *   - Connection/disconnection churn (SADD/SREM throughput)
 *
 * What this does NOT validate:
 *   - SignalR Redis backplane (cross-instance message delivery).
 *     IsUserOnline calls Redis directly — it doesn't test pub/sub.
 *     Use message-hub.js or full-flow.js behind a load balancer with
 *     multiple pods to implicitly test the backplane.
 *
 * Key metrics:
 *   - presence_online_rate: % of checks that find the target user online
 *     (should approach 100% when all VUs are connected and settled)
 *   - presence_check_latency: round-trip time for IsUserOnline hub call
 *
 * Usage:
 *   k6 run scenarios/presence-stress.js
 *   k6 run --env STAGE=low scenarios/presence-stress.js
 *   k6 run --env STAGE=medium scenarios/presence-stress.js
 */

import ws from "k6/ws";
import { check, sleep } from "k6";
import http from "k6/http";
import { Counter, Rate, Trend } from "k6/metrics";
import {
  HUBS,
  TIMING,
  STAGES,
  THRESHOLDS,
  BREAKPOINT_THRESHOLDS,
  BASE_URL,
  HEALTH_URL,
  getMaxVUs,
} from "../config.js";
import { generateToken } from "../helpers/jwt.js";
import {
  buildWsUrl,
  handshakeMessage,
  invocationMessage,
  pingMessage,
  parseMessages,
  isClose,
  isHandshakeResponse,
  isHandshakeError,
  MSG_TYPE,
} from "../helpers/signalr.js";

// ─── Custom Metrics ───────────────────────────────────────────
const presenceOnlineRate = new Rate("presence_online_rate");
const presenceCheckLatency = new Trend("presence_check_latency", true);
const presenceChecksTotal = new Counter("presence_checks_total");
const presenceOnlineCount = new Counter("presence_online_count");
const presenceOfflineCount = new Counter("presence_offline_count");
const wsErrors = new Rate("ws_errors");
const wsConnectingDuration = new Trend("ws_connecting_duration", true);
const wsHandshakeDuration = new Trend("ws_handshake_duration", true);
const wsSessionDuration = new Trend("ws_session_duration", true);

// ─── Pre-generate stable usernames per VU ─────────────────────
function getStableIdentity(vuId) {
  const userId = `20000000-0000-0000-0000-${String(vuId).padStart(12, "0")}`;
  const username = `prestest-user-${vuId}`;
  const token = generateToken({ userId, username });
  return { userId, username, token };
}

// ─── k6 Options ───────────────────────────────────────────────
const stage = __ENV.STAGE || "smoke";

export const options = {
  scenarios: {
    "presence-stress": {
      executor: "ramping-vus",
      stages: STAGES[stage] || STAGES.smoke,
      gracefulStop: "30s",
      gracefulRampDown: "10s",
    },
  },
  thresholds: {
    ...(stage === "breakpoint" ? BREAKPOINT_THRESHOLDS : THRESHOLDS),
    presence_online_rate:
      stage === "breakpoint"
        ? [{ threshold: "rate>0.60", abortOnFail: true, delayAbortEval: "10s" }]
        : ["rate>0.80"],
    presence_check_latency:
      stage === "breakpoint"
        ? [
            {
              threshold: "p(95)<5000",
              abortOnFail: true,
              delayAbortEval: "10s",
            },
          ]
        : ["p(95)<2000"],
  },
  tags: { scenario: "presence-stress", stage: stage },
};

// ─── Setup: Health Check ──────────────────────────────────────
export function setup() {
  const res = http.get(HEALTH_URL, { timeout: "10s" });
  const ok = check(res, {
    "health check status 200": (r) => r.status === 200,
  });
  if (!ok) {
    console.error(
      `Health check failed: ${res.status} — aborting test. Is the server running at ${BASE_URL}?`,
    );
    throw new Error(`Target ${BASE_URL} is not healthy`);
  }
  console.log(`Health check passed: ${BASE_URL} is up`);
}

// ─── Main VU Function ─────────────────────────────────────────
export default function () {
  // Each VU gets a stable identity based on its VU number
  const { userId, username, token } = getStableIdentity(__VU);

  // Direct WebSocket connect (skipNegotiation — no negotiate round-trip)
  const wsUrl = buildWsUrl(HUBS.presence, token);

  // Connect
  const connectStart = Date.now();
  let handshakeCompleted = false;
  let handshakeStart = 0;
  let sessionStart = 0;

  // Track pending IsUserOnline invocations for latency measurement
  const pendingChecks = {};

  const res = ws.connect(wsUrl, null, function (socket) {
    const connectDuration = Date.now() - connectStart;
    wsConnectingDuration.add(connectDuration);

    // ─── On Open: send SignalR handshake ──────────────
    socket.on("open", function () {
      handshakeStart = Date.now();
      socket.send(handshakeMessage());
      // Handshake timeout
      socket.setTimeout(function () {
        if (!handshakeCompleted) {
          console.error(
            `VU ${__VU} presence-stress handshake timeout after ${TIMING.handshakeTimeoutMs}ms`,
          );
          wsErrors.add(1);
          socket.close();
        }
      }, TIMING.handshakeTimeoutMs);
    });

    // ─── On Message ──────────────────────────────────
    socket.on("message", function (data) {
      const messages = parseMessages(data);

      for (const msg of messages) {
        // Handshake response
        if (!handshakeCompleted && isHandshakeResponse(msg)) {
          handshakeCompleted = true;
          wsHandshakeDuration.add(Date.now() - handshakeStart);
          wsErrors.add(0);
          sessionStart = Date.now();

          // Wait 3s for Redis presence to settle, then start probing
          socket.setTimeout(function () {
            startPresenceChecks(socket);
          }, 3000);

          // Keep-alive pings
          socket.setInterval(function () {
            socket.send(pingMessage());
          }, TIMING.pingIntervalMs);

          // Heartbeat to keep Redis presence alive
          socket.setInterval(function () {
            socket.send(invocationMessage("Heartbeat", []));
          }, TIMING.heartbeatIntervalMs);

          // Close after hold duration
          socket.setTimeout(function () {
            socket.close();
          }, TIMING.holdDurationMs);

          continue;
        }

        // Handshake error
        if (!handshakeCompleted && isHandshakeError(msg)) {
          console.error(`VU ${__VU} handshake error: ${msg.error}`);
          wsErrors.add(1);
          socket.close();
          return;
        }

        // Ping — reply
        if (msg.type === MSG_TYPE.PING) {
          socket.send(pingMessage());
          continue;
        }

        // Close from server
        if (isClose(msg)) {
          if (msg.error) {
            wsErrors.add(1);
          }
          socket.close();
          return;
        }

        // ─── Completion: IsUserOnline response ────────
        if (
          msg.type === MSG_TYPE.COMPLETION &&
          msg.invocationId &&
          msg.invocationId.startsWith("pres-")
        ) {
          const sentAt = pendingChecks[msg.invocationId];
          if (sentAt) {
            presenceCheckLatency.add(Date.now() - sentAt);
            delete pendingChecks[msg.invocationId];
          }

          presenceChecksTotal.add(1);

          if (msg.result && msg.result.isOnline === true) {
            presenceOnlineRate.add(1);
            presenceOnlineCount.add(1);
          } else {
            presenceOnlineRate.add(0);
            presenceOfflineCount.add(1);
          }

          continue;
        }
      }
    });

    // Periodically invoke IsUserOnline for random other VUs
    function startPresenceChecks(sock) {
      const maxVu = getMaxVUs(stage);

      // Every 3s, check 5 random other VUs that should be connected
      sock.setInterval(function () {
        for (let i = 0; i < 5; i++) {
          let targetVu = __VU;
          while (targetVu === __VU) {
            targetVu = Math.floor(Math.random() * maxVu) + 1;
          }

          const targetUsername = `prestest-user-${targetVu}`;
          const invId = `pres-${__VU}-${targetVu}-${Date.now()}`;
          pendingChecks[invId] = Date.now();

          sock.send(invocationMessage("IsUserOnline", [targetUsername], invId));
        }
      }, 3000);
    }

    // ─── On Error ────────────────────────────────────
    socket.on("error", function (e) {
      console.error(`VU ${__VU} WS error: ${e.error()}`);
      wsErrors.add(1);
    });

    // ─── On Close ────────────────────────────────────
    socket.on("close", function () {
      if (sessionStart > 0) {
        wsSessionDuration.add(Date.now() - sessionStart);
      }
    });
  });

  check(res, {
    "WS status 101": (r) => r && r.status === 101,
  });

  if (!res || res.status !== 101) {
    wsErrors.add(1);
  }

  sleep(Math.random() * 2 + 1);
}

// ─── Summary Handler ──────────────────────────────────────────
import { generateReport } from "../helpers/report.js";

export function handleSummary(data) {
  return generateReport(data, { scenario: "presence-stress", stage });
}
