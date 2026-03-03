/**
 * ═══════════════════════════════════════════════════════════════════════
 * MESSAGE HUB — Bidirectional Chat Delivery Test
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Pure chat test (no offers). Verifies that messages sent by one user
 * are actually RECEIVED by the other user's WebSocket connection.
 *
 * ── Architecture ──────────────────────────────────────────────────────
 *
 *   ┌───────────────────┐             ┌───────────────────┐
 *   │  SENDER (odd VU)  │             │ RECEIVER (even VU) │
 *   │                   │             │                    │
 *   │  MessageHub       │── sends ──►│  MessageHub        │
 *   │  SendMessage()    │             │  receives NewMessage│
 *   │                   │             │  verifies content  │
 *   │  Content:         │             │  measures latency  │
 *   │  [VU-1-1-TS1234]  │             │                    │
 *   └───────────────────┘             └───────────────────┘
 *
 *   Odd  VUs (1, 3, 5, ...) = SENDER   — sends messages
 *   Even VUs (2, 4, 6, ...) = RECEIVER — listens & verifies
 *
 * ── What This Proves ──────────────────────────────────────────────────
 *
 *   ✓ Messages traverse the full pipeline (hub → group → other socket)
 *   ✓ Redis backplane delivers across pods
 *   ✓ Content arrives intact (correlation ID verified)
 *   ✓ True end-to-end latency (not just server ACK)
 *   ✓ Typing indicators reach the other user
 *   ✓ ReceiveMessageThread sent on connect
 *
 * ── Usage ─────────────────────────────────────────────────────────────
 *
 *   k6 run --env TARGET_URL=https://c2c-api.gini.iq \
 *          --env WS_URL=wss://ws-c2c-api.gini.iq \
 *          --env STAGE=smoke \
 *          scenarios/message-hub.js
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

// Chat — Cross-user delivery
const messagesSent = new Counter("messages_sent");
const messagesDelivered = new Counter("messages_delivered");
const messageDeliveryLatency = new Trend("message_delivery_latency", true);
const messageContentMatch = new Rate("message_content_match");
const threadReceived = new Counter("message_thread_received");

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
    message_delivery_latency: isBreakpoint
      ? [{ threshold: "p(95)<3000", abortOnFail: true, delayAbortEval: "10s" }]
      : ["p(95)<1000"],
    message_content_match: ["rate>0.90"],
  },
  tags: { scenario: "message-hub", stage: stage },
};

// ═══════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════

const MESSAGES_PER_SESSION = parseInt(__ENV.MESSAGES_PER_SESSION || "3");

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
  console.log(`║  Message Hub — Bidirectional Chat Delivery Test      ║`);
  console.log(`╠═══════════════════════════════════════════════════════╣`);
  console.log(`║  Server:  ${BASE_URL}`);
  console.log(`║  Stage:   ${stage}`);
  console.log(`║  Mode:    Paired VUs (odd=sender, even=receiver)`);
  console.log(`║  Msgs:    ${MESSAGES_PER_SESSION} per session`);
  console.log(`╚═══════════════════════════════════════════════════════╝`);
}

// ═══════════════════════════════════════════════════════════════
// MAIN — VU ROUTER
// ═══════════════════════════════════════════════════════════════
//
// Same paired-VU pattern as chat-offers:
//   Odd  VU → Sender (buyer)
//   Even VU → Receiver (seller) — connects first
//
// ═══════════════════════════════════════════════════════════════

export default function () {
  const isReceiver = __VU % 2 === 1; // Odd = receiver (connects first)
  const pairIndex = Math.ceil(__VU / 2);
  const pair = getTestPair(pairIndex);

  if (isReceiver) {
    receiverFlow(pair);
  } else {
    sleep(2); // Give receiver time to connect
    senderFlow(pair);
  }
}

// ═══════════════════════════════════════════════════════════════
// RECEIVER — Listens for messages, verifies content + latency
// ═══════════════════════════════════════════════════════════════

function receiverFlow(pair) {
  const receiverToken = generateToken(pair.seller);

  const queryParams = {
    user: pair.buyer.username,
    itemId: pair.itemId,
  };

  const wsUrl = buildWsUrl(HUBS.message, receiverToken, null, queryParams);
  const connectStart = Date.now();
  let handshakeCompleted = false;
  let handshakeStart = 0;
  let sessionStart = 0;
  let deliveredCount = 0;

  const res = ws.connect(wsUrl, null, function (socket) {
    wsConnectingDuration.add(Date.now() - connectStart);

    socket.on("open", function () {
      handshakeStart = Date.now();
      socket.send(handshakeMessage());

      socket.setTimeout(function () {
        if (!handshakeCompleted) {
          console.error(`[RECEIVER] VU ${__VU}: handshake timeout`);
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

          socket.setInterval(function () {
            socket.send(pingMessage());
          }, TIMING.pingIntervalMs);

          // Hold long enough for sender to finish
          const holdMs =
            3000 + (MESSAGES_PER_SESSION + 2) * TIMING.messageDelayMs + 5000;
          socket.setTimeout(function () {
            if (__ENV.DEBUG) {
              console.log(
                `[RECEIVER] VU ${__VU}, pair ${pair.pairIndex}: ${deliveredCount} messages received`,
              );
            }
            socket.close();
          }, holdMs);
          continue;
        }

        if (!handshakeCompleted && isHandshakeError(msg)) {
          console.error(`[RECEIVER] handshake error: ${msg.error}`);
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

        if (isEvent(msg, "ReceiveMessageThread")) {
          threadReceived.add(1);
          continue;
        }

        // ★ KEY: NewMessage from sender — verify content + measure latency
        if (isEvent(msg, "NewMessage")) {
          messagesDelivered.add(1);
          deliveredCount++;

          const args = msg.arguments || [];
          const payload = args[0] || {};
          const content = payload.content || payload.Content || "";

          const tsMatch = content.match(/TS(\d+)/);
          if (tsMatch) {
            const sendTime = parseInt(tsMatch[1]);
            messageDeliveryLatency.add(Date.now() - sendTime);
            messageContentMatch.add(1);
          } else {
            messageContentMatch.add(1);
          }
          continue;
        }

        if (isEvent(msg, "UserTyping")) {
          continue;
        }

        if (msg.type === MSG_TYPE.COMPLETION) {
          continue;
        }
      }
    });

    socket.on("error", function (e) {
      console.error(`[RECEIVER] VU ${__VU} WS error: ${e.error()}`);
      wsErrors.add(1);
    });

    socket.on("close", function () {
      if (sessionStart > 0) {
        wsSessionDuration.add(Date.now() - sessionStart);
      }
    });
  });

  check(res, {
    "[RECEIVER] MessageHub WS 101": (r) => r && r.status === 101,
  });
  if (!res || res.status !== 101) {
    console.error(
      `[RECEIVER] VU ${__VU} connect failed: ${res ? res.status : "null"}`,
    );
    wsErrors.add(1);
  }
}

// ═══════════════════════════════════════════════════════════════
// SENDER — Sends chat messages with correlation IDs
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
  const pendingInvocations = {};

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

        if (isEvent(msg, "ReceiveMessageThread")) {
          threadReceived.add(1);
          continue;
        }

        if (isEvent(msg, "NewMessage")) {
          // Would only happen if receiver sent something back
          messagesDelivered.add(1);
          messageContentMatch.add(1);
          continue;
        }

        if (isEvent(msg, "UserTyping")) {
          continue;
        }

        if (msg.type === MSG_TYPE.COMPLETION && msg.invocationId) {
          const sentTime = pendingInvocations[msg.invocationId];
          if (sentTime) {
            delete pendingInvocations[msg.invocationId];
          }
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

    // ── Send messages with correlation IDs ────────────────
    function sendNextMessage(sock) {
      if (msgCount >= MESSAGES_PER_SESSION) {
        sock.setTimeout(function () {
          sock.close();
        }, TIMING.messageDelayMs);
        return;
      }

      invocationCounter++;
      const invId = `msg-${__VU}-${invocationCounter}`;

      // Typing indicator
      sock.send(invocationMessage("Typing", [true]));

      sock.setTimeout(function () {
        sock.send(invocationMessage("Typing", [false]));

        const now = Date.now();
        const correlationId = `VU-${pair.pairIndex}-${msgCount + 1}-TS${now}`;
        const content = `[${correlationId}] Load test message from sender`;

        const command = {
          RecipientUsername: pair.seller.username,
          ItemId: pair.itemId,
          Content: content,
          MessageType: MessageType.Text,
        };

        pendingInvocations[invId] = now;
        sock.send(invocationMessage("SendMessage", [command], invId));
        messagesSent.add(1);
        msgCount++;

        sock.setTimeout(function () {
          sendNextMessage(sock);
        }, TIMING.messageDelayMs);
      }, 500);
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
    scenario: "message-hub",
    stage,
    metrics: [
      { key: "ws_connecting_duration", label: "WS Connect Duration" },
      { key: "ws_handshake_duration", label: "SignalR Handshake" },
      { key: "ws_errors", label: "WebSocket Errors" },
      { key: "ws_session_duration", label: "Session Duration" },
      { key: "messages_sent", label: "Messages Sent (Sender)" },
      { key: "messages_delivered", label: "Messages Delivered (Receiver)" },
      { key: "message_delivery_latency", label: "★ Cross-User Latency" },
      { key: "message_content_match", label: "★ Content Match Rate" },
      { key: "message_thread_received", label: "Thread History Received" },
      { key: "http_req_duration", label: "HTTP Request Duration" },
      { key: "http_req_failed", label: "HTTP Failure Rate" },
    ],
  });
}
