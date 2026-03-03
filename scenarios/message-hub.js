/**
 * Message Hub Load Test
 *
 * Tests the MessageHub WebSocket chat flow:
 *   1. Generate JWT pairs (sender + recipient) per VU
 *   2. Each VU connects to MessageHub with recipientUsername + itemId
 *   3. Receives ReceiveMessageThread on connect
 *   4. Sends messages via SendMessage hub invocation
 *   5. Tracks message delivery latency
 *   6. Tests typing indicators
 *
 * Note: MessageHub requires chat authorization (both users must be
 * buyer/seller for the item). In load testing, this may need a
 * pre-seeded itemId or mocked auth. Set ITEM_ID env var.
 *
 * Usage:
 *   k6 run --env TARGET_URL=https://c2c-uat.gini.iq \
 *          --env ITEM_ID=<guid> \
 *          scenarios/message-hub.js
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
const messagesSent = new Counter("messages_sent");
const messagesReceived = new Counter("messages_received");
const messageDeliveryLatency = new Trend("message_delivery_latency", true);
const threadReceived = new Counter("message_thread_received");
const wsSessionDuration = new Trend("ws_session_duration", true);

// ─── k6 Options ───────────────────────────────────────────────
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
  },
  tags: { scenario: "message-hub", stage: stage },
};

// ─── Config ───────────────────────────────────────────────────
const MESSAGES_PER_SESSION = parseInt(__ENV.MESSAGES_PER_SESSION || "3");

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
  // Each VU gets a unique seller/buyer/item pair from the test data pool.
  const pair = getTestPair(__VU);
  const sender = { ...pair.buyer, token: generateToken(pair.buyer) };
  const recipientUsername = pair.seller.username;
  const itemId = pair.itemId;

  // Query params required by MessageHub OnConnectedAsync.
  const queryParams = {
    user: recipientUsername,
    itemId: itemId,
  };

  // 1. Negotiate
  const negotiateResult = negotiate(HUBS.message, sender.token, queryParams);
  if (!negotiateResult) {
    wsErrors.add(1);
    sleep(1);
    return;
  }

  // 2. Build WebSocket URL
  const wsUrl = buildWsUrl(
    HUBS.message,
    sender.token,
    negotiateResult.connectionToken,
    queryParams,
  );

  // 3. Connect
  const connectStart = Date.now();
  let handshakeCompleted = false;
  let handshakeStart = 0;
  let sessionStart = 0;
  let msgCount = 0;
  let invocationCounter = 0;
  const pendingInvocations = {};

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
            `VU ${__VU} MessageHub handshake timeout after ${TIMING.handshakeTimeoutMs}ms`,
          );
          wsErrors.add(1);
          socket.close();
        }
      }, TIMING.handshakeTimeoutMs);
    });

    socket.on("message", function (data) {
      const messages = parseMessages(data);

      for (const msg of messages) {
        // Handshake response
        if (!handshakeCompleted && isHandshakeResponse(msg)) {
          handshakeCompleted = true;
          wsHandshakeDuration.add(Date.now() - handshakeStart);
          wsErrors.add(0);
          sessionStart = Date.now();

          // Start sending messages after a short delay
          socket.setTimeout(function () {
            sendNextMessage(socket);
          }, TIMING.messageDelayMs);

          // Ping interval
          socket.setInterval(function () {
            socket.send(pingMessage());
          }, TIMING.pingIntervalMs);

          continue;
        }

        // Handshake error
        if (!handshakeCompleted && isHandshakeError(msg)) {
          console.error(`MessageHub handshake error: ${msg.error}`);
          wsErrors.add(1);
          socket.close();
          return;
        }

        // Ping
        if (msg.type === MSG_TYPE.PING) {
          socket.send(pingMessage());
          continue;
        }

        // Close
        if (isClose(msg)) {
          if (msg.error) {
            console.error(`MessageHub close: ${msg.error}`);
            wsErrors.add(1);
          }
          socket.close();
          return;
        }

        // ReceiveMessageThread - sent on connect
        if (isEvent(msg, "ReceiveMessageThread")) {
          threadReceived.add(1);
          continue;
        }

        // NewMessage - message from the other user
        if (isEvent(msg, "NewMessage")) {
          messagesReceived.add(1);
          continue;
        }

        // Completion - response to our SendMessage invocation
        if (msg.type === MSG_TYPE.COMPLETION && msg.invocationId) {
          const sentTime = pendingInvocations[msg.invocationId];
          if (sentTime) {
            messageDeliveryLatency.add(Date.now() - sentTime);
            delete pendingInvocations[msg.invocationId];
          }
          continue;
        }
      }
    });

    socket.on("error", function (e) {
      console.error(`MessageHub WS error: ${e.error()}`);
      wsErrors.add(1);
    });

    socket.on("close", function () {
      // Track session duration
      if (sessionStart > 0) {
        wsSessionDuration.add(Date.now() - sessionStart);
      }
    });

    // ─── Send messages function ────────────────────────────
    function sendNextMessage(sock) {
      if (msgCount >= MESSAGES_PER_SESSION) {
        // Done sending, wait a bit then close
        sock.setTimeout(function () {
          sock.close();
        }, TIMING.messageDelayMs);
        return;
      }

      invocationCounter++;
      const invId = `msg-${__VU}-${invocationCounter}`;

      // Send typing indicator first
      sock.send(invocationMessage("Typing", [true]));

      // Small delay to simulate typing
      sock.setTimeout(function () {
        // Stop typing
        sock.send(invocationMessage("Typing", [false]));

        // Send the actual message (75% Text, 25% Offer for realistic mix)
        const isOffer = Math.random() < 0.25;
        const msgType = isOffer ? MessageType.Offer : MessageType.Text;
        const content = isOffer
          ? `Load test offer ${msgCount + 1} from VU ${__VU}`
          : `Load test message ${msgCount + 1} from VU ${__VU}`;

        const command = {
          RecipientUsername: recipientUsername,
          ItemId: itemId,
          Content: content,
          MessageType: msgType,
        };

        pendingInvocations[invId] = Date.now();
        sock.send(invocationMessage("SendMessage", [command], invId));
        messagesSent.add(1);
        msgCount++;

        // Schedule next message
        sock.setTimeout(function () {
          sendNextMessage(sock);
        }, TIMING.messageDelayMs);
      }, 500);
    }
  });

  check(res, {
    "MessageHub WS status 101": (r) => r && r.status === 101,
  });

  if (!res || res.status !== 101) {
    wsErrors.add(1);
  }

  sleep(Math.random() * 2 + 1);
}

// ─── Summary Handler ──────────────────────────────────────────
import { generateReport } from "../helpers/report.js";

export function handleSummary(data) {
  return generateReport(data, { scenario: "message-hub", stage });
}
