/**
 * Notification Broadcast Load Test (Redis Backplane Verification)
 *
 * Tests that notifications delivered via PresenceHub are correctly
 * broadcast across multiple server instances via the Redis backplane.
 *
 * Flow:
 *   1. "Seller" VUs connect to PresenceHub and wait for events
 *   2. After stabilization, we fire HTTP requests that trigger notifications
 *   3. Measure if sellers receive InPersonOfferReceived, PaymentCompleted, etc.
 *   4. Track delivery latency across the backplane
 *
 * This scenario focuses on the RECEIVE side — it connects many VUs
 * to PresenceHub and monitors for specific notification events.
 * A companion script or manual action triggers the actual notifications.
 *
 * For automated notification triggering, set TRIGGER_MODE=http and
 * provide API endpoints that generate notifications.
 *
 * Usage:
 *   k6 run --env TARGET_URL=https://c2c-uat.gini.iq \
 *          --env STAGE=low \
 *          scenarios/notification-broadcast.js
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
} from "../config.js";
import { generateVuIdentity } from "../helpers/jwt.js";
import {
  negotiate,
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
const notificationDeliveryLatency = new Trend(
  "notification_delivery_latency",
  true,
);
const notificationsReceived = new Counter("notifications_received");
const wsSessionDuration = new Trend("ws_session_duration", true);

// Track each notification type
const inPersonOfferReceivedCount = new Counter("event_InPersonOfferReceived");
const inPersonOfferStatusChangedCount = new Counter(
  "event_InPersonOfferStatusChanged",
);
const paymentCompletedCount = new Counter("event_PaymentCompleted");
const offerReceivedCount = new Counter("event_OfferReceived");
const offerStatusChangedCount = new Counter("event_OfferStatusChanged");
const invoiceCreatedCount = new Counter("event_InvoiceCreated");
const chatMessageNotificationCount = new Counter(
  "event_ChatMessageNotification",
);

// ─── k6 Options ───────────────────────────────────────────────
const stage = __ENV.STAGE || "smoke";

// Longer hold duration for notification listeners
const HOLD_DURATION = parseInt(
  __ENV.HOLD_DURATION || String(TIMING.holdDurationMs * 2),
);

const isBreakpoint = stage === "breakpoint";
const baseThresholds = isBreakpoint ? BREAKPOINT_THRESHOLDS : THRESHOLDS;

export const options = {
  stages: STAGES[stage] || STAGES.smoke,
  thresholds: {
    ...baseThresholds,
    notification_delivery_latency: isBreakpoint
      ? [{ threshold: "p(95)<2000", abortOnFail: true, delayAbortEval: "10s" }]
      : ["p(95)<500"],
  },
  tags: { scenario: "notification-broadcast", stage: stage },
};

// Map of notification events to their counters
const EVENT_COUNTERS = {
  InPersonOfferReceived: inPersonOfferReceivedCount,
  InPersonOfferStatusChanged: inPersonOfferStatusChangedCount,
  PaymentCompleted: paymentCompletedCount,
  OfferReceived: offerReceivedCount,
  OfferStatusChanged: offerStatusChangedCount,
  InvoiceCreated: invoiceCreatedCount,
  ChatMessageNotification: chatMessageNotificationCount,
};

const ALL_EVENTS = Object.keys(EVENT_COUNTERS);

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
  const { userId, username, token } = generateVuIdentity(__VU, __ITER);

  // 1. Negotiate
  const negotiateResult = negotiate(HUBS.presence, token);
  if (!negotiateResult) {
    wsErrors.add(1);
    sleep(1);
    return;
  }

  // 2. Build WebSocket URL
  const wsUrl = buildWsUrl(
    HUBS.presence,
    token,
    negotiateResult.connectionToken,
  );

  // 3. Connect and listen for notifications
  const connectStart = Date.now();
  let handshakeCompleted = false;
  let handshakeStart = 0;
  let connectionReadyTime = 0;

  const res = ws.connect(wsUrl, null, function (socket) {
    const connectDuration = Date.now() - connectStart;
    wsConnectingDuration.add(connectDuration);

    socket.on("open", function () {
      handshakeStart = Date.now();
      socket.send(handshakeMessage());

      // Handshake timeout
      socket.setTimeout(function () {
        if (!handshakeCompleted) {
          console.error(
            `VU ${__VU} notification handshake timeout after ${TIMING.handshakeTimeoutMs}ms`,
          );
          wsErrors.add(1);
          socket.close();
        }
      }, TIMING.handshakeTimeoutMs);
    });

    socket.on("message", function (data) {
      const messages = parseMessages(data);

      for (const msg of messages) {
        // Handshake
        if (!handshakeCompleted && isHandshakeResponse(msg)) {
          handshakeCompleted = true;
          connectionReadyTime = Date.now();
          wsHandshakeDuration.add(connectionReadyTime - handshakeStart);
          wsErrors.add(0);

          // Heartbeat to keep connection alive
          socket.setInterval(function () {
            socket.send(invocationMessage("Heartbeat", []));
          }, TIMING.heartbeatIntervalMs);

          // Ping
          socket.setInterval(function () {
            socket.send(pingMessage());
          }, TIMING.pingIntervalMs);

          // Hold connection for extended duration
          socket.setTimeout(function () {
            socket.close();
          }, HOLD_DURATION);

          continue;
        }

        if (!handshakeCompleted && isHandshakeError(msg)) {
          wsErrors.add(1);
          socket.close();
          return;
        }

        if (msg.type === MSG_TYPE.PING) {
          socket.send(pingMessage());
          continue;
        }

        if (isClose(msg)) {
          if (msg.error) wsErrors.add(1);
          socket.close();
          return;
        }

        // ─── Track notification events ──────────────────
        if (msg.type === MSG_TYPE.INVOCATION && msg.target) {
          const counter = EVENT_COUNTERS[msg.target];
          if (counter) {
            counter.add(1);
            notificationsReceived.add(1);

            // Measure delivery latency as time since connection was ready.
            // Server payloads don't include a _sentAt timestamp, so we use
            // the elapsed time since handshake as an upper-bound estimate.
            if (connectionReadyTime > 0) {
              notificationDeliveryLatency.add(Date.now() - connectionReadyTime);
            }

            // Log event for debugging at low VU counts
            if (__VU <= 5) {
              console.log(`VU ${__VU} received: ${msg.target}`);
            }
          }
        }
      }
    });

    socket.on("error", function (e) {
      console.error(`Notification WS error: ${e.error()}`);
      wsErrors.add(1);
    });

    socket.on("close", function () {
      // Track session duration
      if (connectionReadyTime > 0) {
        wsSessionDuration.add(Date.now() - connectionReadyTime);
      }
    });
  });

  check(res, {
    "Notification WS status 101": (r) => r && r.status === 101,
  });

  if (!res || res.status !== 101) {
    wsErrors.add(1);
  }

  sleep(Math.random() * 3 + 1);
}

// ─── Summary Handler ──────────────────────────────────────────
import { generateReport } from "../helpers/report.js";

export function handleSummary(data) {
  return generateReport(data, { scenario: "notification-broadcast", stage });
}
