/**
 * Presence Hub Load Test
 *
 * Tests the PresenceHub WebSocket connection lifecycle:
 *   1. Generate JWT for VU
 *   2. Negotiate
 *   3. Open WebSocket
 *   4. Complete SignalR handshake
 *   5. Send periodic Heartbeat() calls
 *   6. Invoke IsUserOnline() to check another user's status
 *   7. Receive targeted notifications (offers, payments, etc.)
 *   8. Gracefully close after hold duration
 *
 * Usage:
 *   k6 run --env TARGET_URL=https://c2c-uat.gini.iq scenarios/presence-hub.js
 *   k6 run --env TARGET_URL=https://c2c-uat.gini.iq --env STAGE=medium scenarios/presence-hub.js
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
import { generateVuIdentity } from "../helpers/jwt.js";
import {
  buildWsUrl,
  handshakeMessage,
  invocationMessage,
  pingMessage,
  parseMessages,
  isEvent,
  isClose,
  isHandshakeResponse,
  isHandshakeError,
  MSG_TYPE,
} from "../helpers/signalr.js";

// ─── Custom Metrics ───────────────────────────────────────────
const wsConnectingDuration = new Trend("ws_connecting_duration", true);
const wsHandshakeDuration = new Trend("ws_handshake_duration", true);
const wsErrors = new Rate("ws_errors");
const wsConnectionsOpened = new Counter("ws_connections_opened");
const wsConnectionsClosed = new Counter("ws_connections_closed");
const heartbeatsSent = new Counter("heartbeats_sent");
const isUserOnlineChecks = new Counter("is_user_online_checks");
const isUserOnlineLatency = new Trend("is_user_online_latency", true);
const wsSessionDuration = new Trend("ws_session_duration", true);

// ─── k6 Options ───────────────────────────────────────────────
const stage = __ENV.STAGE || "smoke";

const isBreakpoint = stage === "breakpoint";

export const options = {
  stages: STAGES[stage] || STAGES.smoke,
  thresholds: isBreakpoint ? BREAKPOINT_THRESHOLDS : THRESHOLDS,
  tags: { scenario: "presence-hub", stage: stage },
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
  // 1. Generate unique identity for this VU
  const { userId, username, token } = generateVuIdentity(__VU, __ITER);

  // 2. Direct WebSocket connect (skipNegotiation — no negotiate round-trip)
  const wsUrl = buildWsUrl(HUBS.presence, token);
  if (__VU <= 2) console.log(`VU ${__VU} wsUrl: ${wsUrl.substring(0, 120)}...`);

  // 3. Connect and run WebSocket session
  const connectStart = Date.now();
  let handshakeCompleted = false;
  let handshakeStart = 0;
  let sessionStart = 0;
  const pendingIsOnline = {};

  const res = ws.connect(wsUrl, null, function (socket) {
    wsConnectionsOpened.add(1);
    const connectDuration = Date.now() - connectStart;
    wsConnectingDuration.add(connectDuration);

    // ─── On Open: send handshake ────────────────────────
    socket.on("open", function () {
      handshakeStart = Date.now();
      socket.send(handshakeMessage());

      // Handshake timeout: close if no response within limit
      socket.setTimeout(function () {
        if (!handshakeCompleted) {
          console.error(
            `VU ${__VU} handshake timeout after ${TIMING.handshakeTimeoutMs}ms`,
          );
          wsErrors.add(1);
          socket.close();
        }
      }, TIMING.handshakeTimeoutMs);
    });

    // ─── On Message: handle SignalR protocol ─────────────
    socket.on("message", function (data) {
      if (__VU <= 2)
        console.log(`VU ${__VU} received: ${data.substring(0, 200)}`);
      const messages = parseMessages(data);

      for (const msg of messages) {
        // Handshake response
        if (!handshakeCompleted && isHandshakeResponse(msg)) {
          handshakeCompleted = true;
          wsHandshakeDuration.add(Date.now() - handshakeStart);
          wsErrors.add(0);
          sessionStart = Date.now();

          // Start heartbeat interval
          socket.setInterval(function () {
            socket.send(invocationMessage("Heartbeat", []));
            heartbeatsSent.add(1);
          }, TIMING.heartbeatIntervalMs);

          // Periodically invoke IsUserOnline to check a random user's status
          socket.setInterval(function () {
            const maxVu = getMaxVUs(stage);
            const targetUser = `loadtest-user-${Math.floor(Math.random() * maxVu) + 1}-0`;
            const invId = `iuo-${__VU}-${Date.now()}`;
            pendingIsOnline[invId] = Date.now();
            socket.send(invocationMessage("IsUserOnline", [targetUser], invId));
            isUserOnlineChecks.add(1);
          }, 10000); // every 10s

          // Send periodic pings
          socket.setInterval(function () {
            socket.send(pingMessage());
          }, TIMING.pingIntervalMs);

          // Schedule close after hold duration
          socket.setTimeout(function () {
            socket.close();
          }, TIMING.holdDurationMs);

          continue;
        }

        // Handshake error
        if (!handshakeCompleted && isHandshakeError(msg)) {
          console.error(`Handshake error: ${msg.error}`);
          wsErrors.add(1);
          socket.close();
          return;
        }

        // Ping — respond with ping
        if (msg.type === MSG_TYPE.PING) {
          socket.send(pingMessage());
          continue;
        }

        // Close message from server
        if (isClose(msg)) {
          if (msg.error) {
            console.error(`Server close: ${msg.error}`);
            wsErrors.add(1);
          }
          socket.close();
          return;
        }

        // Track IsUserOnline completion responses
        if (
          msg.type === MSG_TYPE.COMPLETION &&
          msg.invocationId &&
          msg.invocationId.startsWith("iuo-")
        ) {
          const sentAt = pendingIsOnline[msg.invocationId];
          if (sentAt) {
            isUserOnlineLatency.add(Date.now() - sentAt);
            delete pendingIsOnline[msg.invocationId];
          }
          continue;
        }
      }
    });

    // ─── On Error ────────────────────────────────────────
    socket.on("error", function (e) {
      console.error(`WebSocket error: ${e.error()}`);
      wsErrors.add(1);
    });

    // ─── On Close ────────────────────────────────────────
    socket.on("close", function (code, reason) {
      if (__VU <= 2)
        console.log(`VU ${__VU} WS closed: code=${code}, reason=${reason}`);
      wsConnectionsClosed.add(1);
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

  // Small sleep between iterations to stagger reconnects
  sleep(Math.random() * 2 + 1);
}

// ─── Summary Handler ──────────────────────────────────────────
import { generateReport } from "../helpers/report.js";

export function handleSummary(data) {
  return generateReport(data, { scenario: "presence-hub", stage });
}
