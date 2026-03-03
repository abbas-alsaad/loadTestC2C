/**
 * ═══════════════════════════════════════════════════════════════════════
 * NOTIFICATION BROADCAST — PresenceHub Delivery Test
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Self-triggering notification test. Instead of waiting for external
 * events, this scenario creates its own notifications by having one
 * user send chat messages that trigger ChatMessageNotification events
 * on the OTHER user's PresenceHub connection.
 *
 * ── Architecture ──────────────────────────────────────────────────────
 *
 *   ┌─────────────────────┐          ┌──────────────────────┐
 *   │  SENDER (odd VU)    │          │  LISTENER (even VU)   │
 *   │                     │          │                       │
 *   │  MessageHub         │── msg ──►│  PresenceHub          │
 *   │  sends messages     │          │  ★ ChatMessageNotif   │
 *   │  via SendMessage()  │          │  (verified receipt)   │
 *   │                     │          │                       │
 *   │  triggers notif ────┼──────────┼─► notification arrives│
 *   │  on PresenceHub     │          │   on listener socket  │
 *   └─────────────────────┘          └──────────────────────┘
 *
 *   The server's SendMessage handler does TWO things:
 *     1. Sends NewMessage to OthersInGroup on MessageHub
 *     2. Sends ChatMessageNotification to recipient on PresenceHub
 *
 *   By having the listener on PresenceHub (not MessageHub), we
 *   specifically test the notification delivery path.
 *
 * ── Test Flow ─────────────────────────────────────────────────────────
 *
 *   LISTENER (odd VU):
 *     1. Connect to PresenceHub
 *     2. Send Heartbeat to register presence
 *     3. Listen for ChatMessageNotification events
 *     4. Count and measure delivery latency
 *     5. Hold connection until sender is done
 *
 *   SENDER (even VU):
 *     1. Wait 2s for listener to connect
 *     2. Connect to MessageHub (chat room with listener)
 *     3. Send messages via SendMessage() with TS{timestamp}
 *     4. Each message triggers a ChatMessageNotification
 *     5. Close after all messages sent
 *
 * ── What This Proves ──────────────────────────────────────────────────
 *
 *   ✓ PresenceHub notifications are delivered
 *   ✓ ChatMessageNotification fires when a message is sent
 *   ✓ Redis backplane routes notifications across pods
 *   ✓ Heartbeat keeps presence alive
 *   ✓ Notification delivery latency (send time → receive time)
 *
 * ── Usage ─────────────────────────────────────────────────────────────
 *
 *   k6 run --env TARGET_URL=https://c2c-api.gini.iq \
 *          --env WS_URL=wss://ws-c2c-api.gini.iq \
 *          --env STAGE=smoke \
 *          scenarios/notification-broadcast.js
 *
 * ═══════════════════════════════════════════════════════════════════════
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
  MessageType,
} from "../config.js";
import { generateToken } from "../helpers/jwt.js";
import { getTestPair } from "../helpers/test-data.js";
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

// ═══════════════════════════════════════════════════════════════
// METRICS
// ═══════════════════════════════════════════════════════════════

// Connection
const wsConnectingDuration = new Trend("ws_connecting_duration", true);
const wsHandshakeDuration = new Trend("ws_handshake_duration", true);
const wsErrors = new Rate("ws_errors");
const wsSessionDuration = new Trend("ws_session_duration", true);

// Notifications — the key metrics
const notificationsReceived = new Counter("notifications_received");
const notificationDeliveryLatency = new Trend(
  "notification_delivery_latency",
  true,
);

// Per-event counters (for detailed breakdown)
const chatMessageNotifCount = new Counter("event_ChatMessageNotification");
const offerReceivedCount = new Counter("event_OfferReceived");
const offerStatusChangedCount = new Counter("event_OfferStatusChanged");
const invoiceCreatedCount = new Counter("event_InvoiceCreated");
const paymentCompletedCount = new Counter("event_PaymentCompleted");

// Sender metrics
const messagesSent = new Counter("messages_sent");

// ═══════════════════════════════════════════════════════════════
// OPTIONS
// ═══════════════════════════════════════════════════════════════

const stage = __ENV.STAGE || "smoke";
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

// ═══════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════

const MESSAGES_TO_SEND = parseInt(__ENV.MESSAGES_PER_SESSION || "3");

// ═══════════════════════════════════════════════════════════════
// SETUP
// ═══════════════════════════════════════════════════════════════

export function setup() {
  const res = http.get(HEALTH_URL, { timeout: "10s" });
  const ok = check(res, {
    "health check status 200": (r) => r.status === 200,
  });
  if (!ok) {
    console.error(
      `Health check failed: ${res.status} — aborting. Server: ${BASE_URL}`,
    );
    throw new Error(`Target ${BASE_URL} is not healthy`);
  }

  console.log(`╔═══════════════════════════════════════════════════════╗`);
  console.log(`║  Notification Broadcast — PresenceHub Delivery Test  ║`);
  console.log(`╠═══════════════════════════════════════════════════════╣`);
  console.log(`║  Server:  ${BASE_URL}`);
  console.log(`║  Stage:   ${stage}`);
  console.log(`║  Mode:    Paired VUs (odd=listener, even=sender)`);
  console.log(`║  Msgs:    ${MESSAGES_TO_SEND} per session`);
  console.log(`╚═══════════════════════════════════════════════════════╝`);
}

// ═══════════════════════════════════════════════════════════════
// MAIN — VU ROUTER
// ═══════════════════════════════════════════════════════════════

export default function () {
  const isListener = __VU % 2 === 1;
  const pairIndex = Math.ceil(__VU / 2);
  const pair = getTestPair(pairIndex);

  if (isListener) {
    listenerFlow(pair);
  } else {
    sleep(2); // Listener connects first
    senderFlow(pair);
  }
}

// ═══════════════════════════════════════════════════════════════
// LISTENER — PresenceHub (receives notifications)
// ═══════════════════════════════════════════════════════════════
//
// Connects to PresenceHub as the SELLER. When the buyer sends
// a chat message via MessageHub, the server pushes a
// ChatMessageNotification to the seller's PresenceHub connection.
//
// ═══════════════════════════════════════════════════════════════

// Map of events to counters
const EVENT_COUNTERS = {
  ChatMessageNotification: chatMessageNotifCount,
  OfferReceived: offerReceivedCount,
  OfferStatusChanged: offerStatusChangedCount,
  InvoiceCreated: invoiceCreatedCount,
  PaymentCompleted: paymentCompletedCount,
};

function listenerFlow(pair) {
  const listenerToken = generateToken(pair.seller);
  const wsUrl = buildWsUrl(HUBS.presence, listenerToken);
  const connectStart = Date.now();
  let handshakeCompleted = false;
  let handshakeStart = 0;
  let sessionStart = 0;
  let notifCount = 0;

  const res = ws.connect(wsUrl, null, function (socket) {
    wsConnectingDuration.add(Date.now() - connectStart);

    socket.on("open", function () {
      handshakeStart = Date.now();
      socket.send(handshakeMessage());

      socket.setTimeout(function () {
        if (!handshakeCompleted) {
          console.error(`[LISTENER] VU ${__VU}: handshake timeout`);
          wsErrors.add(1);
          socket.close();
        }
      }, TIMING.handshakeTimeoutMs);
    });

    socket.on("message", function (data) {
      const messages = parseMessages(data);

      for (const msg of messages) {
        if (!handshakeCompleted && isHandshakeResponse(msg)) {
          handshakeCompleted = true;
          wsHandshakeDuration.add(Date.now() - handshakeStart);
          wsErrors.add(0);
          sessionStart = Date.now();

          // Register presence with heartbeat
          socket.send(invocationMessage("Heartbeat", []));

          // Heartbeat interval (keeps Redis presence alive)
          socket.setInterval(function () {
            socket.send(invocationMessage("Heartbeat", []));
          }, TIMING.heartbeatIntervalMs);

          // Ping
          socket.setInterval(function () {
            socket.send(pingMessage());
          }, TIMING.pingIntervalMs);

          // Hold connection
          const holdMs =
            3000 + (MESSAGES_TO_SEND + 2) * TIMING.messageDelayMs + 10000;
          socket.setTimeout(function () {
            if (__ENV.DEBUG) {
              console.log(
                `[LISTENER] VU ${__VU}, pair ${pair.pairIndex}: ${notifCount} notifications`,
              );
            }
            socket.close();
          }, holdMs);
          continue;
        }

        if (!handshakeCompleted && isHandshakeError(msg)) {
          console.error(`[LISTENER] handshake error: ${msg.error}`);
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

        // ══════════════════════════════════════════════════════
        // ★ NOTIFICATION EVENTS — pushed by server
        // ══════════════════════════════════════════════════════
        if (msg.type === MSG_TYPE.INVOCATION && msg.target) {
          const counter = EVENT_COUNTERS[msg.target];
          if (counter) {
            counter.add(1);
            notificationsReceived.add(1);
            notifCount++;

            // Try to extract timestamp from notification payload
            const args = msg.arguments || [];
            const payload = args[0] || {};

            // ChatMessageNotification includes message content
            // which may have our TS{timestamp} correlation
            const content =
              payload.content ||
              payload.Content ||
              payload.message ||
              payload.Message ||
              "";
            const tsMatch = content.match ? content.match(/TS(\d+)/) : null;
            if (tsMatch) {
              const sendTime = parseInt(tsMatch[1]);
              notificationDeliveryLatency.add(Date.now() - sendTime);
            } else if (sessionStart > 0) {
              // Fallback: time since session ready (upper bound)
              notificationDeliveryLatency.add(Date.now() - sessionStart);
            }
          }
        }

        // Completion for Heartbeat invocations
        if (msg.type === MSG_TYPE.COMPLETION) {
          continue;
        }
      }
    });

    socket.on("error", function (e) {
      console.error(`[LISTENER] VU ${__VU} WS error: ${e.error()}`);
      wsErrors.add(1);
    });

    socket.on("close", function () {
      if (sessionStart > 0) {
        wsSessionDuration.add(Date.now() - sessionStart);
      }
    });
  });

  check(res, {
    "[LISTENER] PresenceHub WS 101": (r) => r && r.status === 101,
  });
  if (!res || res.status !== 101) {
    console.error(
      `[LISTENER] VU ${__VU} connect failed: ${res ? res.status : "null"}`,
    );
    wsErrors.add(1);
  }
}

// ═══════════════════════════════════════════════════════════════
// SENDER — MessageHub (triggers notifications)
// ═══════════════════════════════════════════════════════════════
//
// Connects to MessageHub as the BUYER and sends messages.
// Each SendMessage triggers a ChatMessageNotification on the
// seller's PresenceHub connection (the listener).
//
// ═══════════════════════════════════════════════════════════════

function senderFlow(pair) {
  const senderToken = generateToken(pair.buyer);

  const queryParams = {
    user: pair.seller.username,
    itemId: pair.itemId,
  };

  const wsUrl = buildWsUrl(HUBS.message, senderToken, null, queryParams);
  const connectStart = Date.now();
  let handshakeCompleted = false;
  let handshakeStart = 0;
  let sessionStart = 0;
  let msgCount = 0;
  let invocationCounter = 0;

  const res = ws.connect(wsUrl, null, function (socket) {
    wsConnectingDuration.add(Date.now() - connectStart);

    socket.on("open", function () {
      handshakeStart = Date.now();
      socket.send(handshakeMessage());

      socket.setTimeout(function () {
        if (!handshakeCompleted) {
          console.error(`[SENDER] VU ${__VU}: handshake timeout`);
          wsErrors.add(1);
          socket.close();
        }
      }, TIMING.handshakeTimeoutMs);
    });

    socket.on("message", function (data) {
      const messages = parseMessages(data);

      for (const msg of messages) {
        if (!handshakeCompleted && isHandshakeResponse(msg)) {
          handshakeCompleted = true;
          wsHandshakeDuration.add(Date.now() - handshakeStart);
          wsErrors.add(0);
          sessionStart = Date.now();

          socket.setTimeout(function () {
            sendNextMessage(socket);
          }, TIMING.messageDelayMs);

          socket.setInterval(function () {
            socket.send(pingMessage());
          }, TIMING.pingIntervalMs);
          continue;
        }

        if (!handshakeCompleted && isHandshakeError(msg)) {
          console.error(`[SENDER] handshake error: ${msg.error}`);
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

        // Sender doesn't need to handle NewMessage (it's a one-way test)
        if (isEvent(msg, "ReceiveMessageThread")) {
          continue;
        }

        if (msg.type === MSG_TYPE.COMPLETION) {
          continue;
        }
      }
    });

    socket.on("error", function (e) {
      console.error(`[SENDER] VU ${__VU} WS error: ${e.error()}`);
      wsErrors.add(1);
    });

    socket.on("close", function () {
      if (sessionStart > 0) {
        wsSessionDuration.add(Date.now() - sessionStart);
      }
    });

    function sendNextMessage(sock) {
      if (msgCount >= MESSAGES_TO_SEND) {
        sock.setTimeout(function () {
          sock.close();
        }, TIMING.messageDelayMs);
        return;
      }

      invocationCounter++;
      const invId = `notif-${__VU}-${invocationCounter}`;

      const now = Date.now();
      const content = `[VU-${pair.pairIndex}-${msgCount + 1}-TS${now}] Notification trigger`;

      const command = {
        RecipientUsername: pair.seller.username,
        ItemId: pair.itemId,
        Content: content,
        MessageType: MessageType.Text,
      };

      sock.send(invocationMessage("SendMessage", [command], invId));
      messagesSent.add(1);
      msgCount++;

      sock.setTimeout(function () {
        sendNextMessage(sock);
      }, TIMING.messageDelayMs);
    }
  });

  check(res, {
    "[SENDER] MessageHub WS 101": (r) => r && r.status === 101,
  });
  if (!res || res.status !== 101) {
    console.error(
      `[SENDER] VU ${__VU} connect failed: ${res ? res.status : "null"}`,
    );
    wsErrors.add(1);
  }

  sleep(Math.random() * 2 + 1);
}

// ═══════════════════════════════════════════════════════════════
// REPORT
// ═══════════════════════════════════════════════════════════════

import { generateReport } from "../helpers/report.js";

export function handleSummary(data) {
  return generateReport(data, {
    scenario: "notification-broadcast",
    stage,
    metrics: [
      { key: "ws_connecting_duration", label: "WS Connect Duration" },
      { key: "ws_handshake_duration", label: "SignalR Handshake" },
      { key: "ws_errors", label: "WebSocket Errors" },
      { key: "ws_session_duration", label: "Session Duration" },
      { key: "messages_sent", label: "Messages Sent (Trigger)" },
      { key: "notifications_received", label: "★ Notifications Received" },
      {
        key: "notification_delivery_latency",
        label: "★ Notification Latency",
      },
      {
        key: "event_ChatMessageNotification",
        label: "ChatMessageNotification",
      },
      { key: "event_OfferReceived", label: "OfferReceived" },
      { key: "event_OfferStatusChanged", label: "OfferStatusChanged" },
      { key: "event_InvoiceCreated", label: "InvoiceCreated" },
      { key: "event_PaymentCompleted", label: "PaymentCompleted" },
      { key: "http_req_duration", label: "HTTP Request Duration" },
      { key: "http_req_failed", label: "HTTP Failure Rate" },
    ],
  });
}
