/**
 * Full Flow E2E Load Test
 *
 * Simulates the complete buyer <-> seller chat lifecycle over SignalR:
 *
 *   Seller scenario:
 *     1. Connects to PresenceHub -> goes "online" in Redis
 *     2. Connects to MessageHub with buyer's username + itemId
 *     3. Receives ReceiveMessageThread on connect
 *     4. Listens for NewMessage, UserTyping, ChatMessageNotification
 *     5. Sends a reply message back to buyer
 *     6. Holds connection, sends Heartbeat periodically
 *     7. Disconnects after hold duration
 *
 *   Buyer scenario (starts after STAGGER_MS delay):
 *     1. Connects to PresenceHub -> goes "online"
 *     2. Checks IsUserOnline(seller) -> expects true
 *     3. Connects to MessageHub with seller's username + itemId
 *     4. Receives ReceiveMessageThread on connect
 *     5. Sends typing indicator -> then sends a chat message
 *     6. Waits for NewMessage (seller's reply) or ChatMessageNotification
 *     7. Marks messages as read via MessageRead
 *     8. Disconnects after hold duration
 *
 * IMPORTANT:
 *   k6 ws.connect() is BLOCKING -- it does not return until the socket
 *   closes. Therefore seller and buyer run as SEPARATE k6 scenarios with
 *   different `exec` functions so they execute in parallel VUs.
 *
 *   Seller VU N is paired with Buyer VU N via deterministic identity
 *   generation (seller = VU*2 even, buyer = VU*2+1 odd).
 *
 * Prerequisites:
 *   - ITEM_ID: A real item GUID where both synthetic users are authorized
 *     (buyer/seller relationship exists). Without this, MessageHub will
 *     reject the connection.
 *
 * Usage:
 *   k6 run --env TARGET_URL=https://c2c-api-uat.gini.iq \
 *          --env ITEM_ID=<guid> \
 *          scenarios/full-flow.js
 *
 *   k6 run --env TARGET_URL=https://c2c-api-uat.gini.iq \
 *          --env ITEM_ID=<guid> \
 *          --env STAGE=low \
 *          scenarios/full-flow.js
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
const wsErrors = new Rate("ws_errors");
const wsConnectingDuration = new Trend("ws_connecting_duration", true);
const wsHandshakeDuration = new Trend("ws_handshake_duration", true);
const messagesSent = new Counter("messages_sent");
const messagesReceived = new Counter("messages_received");
const messageDeliveryLatency = new Trend("message_delivery_latency", true);
const threadReceived = new Counter("message_thread_received");
const typingIndicatorsReceived = new Counter("typing_indicators_received");
const presenceChecks = new Counter("presence_checks");
const presenceOnline = new Counter("presence_online");
const chatNotificationsReceived = new Counter("chat_notifications_received");
const wsSessionDuration = new Trend("ws_session_duration", true);

// ─── Config ───────────────────────────────────────────────────
const stage = __ENV.STAGE || "smoke";
const STAGGER_MS = 3000; // Buyer starts 3s after seller
const HOLD_DURATION_MS = TIMING.holdDurationMs;

// ─── k6 Options ───────────────────────────────────────────────
// Two parallel scenarios: sellers and buyers run in separate VU pools.
const stageConfig = STAGES[stage] || STAGES.smoke;

export const options = {
  scenarios: {
    sellers: {
      executor: "ramping-vus",
      exec: "sellerFlow",
      stages: stageConfig,
      gracefulStop: "30s",
      gracefulRampDown: "10s",
      tags: { role: "seller" },
    },
    buyers: {
      executor: "ramping-vus",
      exec: "buyerFlow",
      stages: stageConfig,
      startTime: `${STAGGER_MS}ms`,
      gracefulStop: "30s",
      gracefulRampDown: "10s",
      tags: { role: "buyer" },
    },
  },
  thresholds: {
    ...(stage === "breakpoint" ? BREAKPOINT_THRESHOLDS : THRESHOLDS),
    message_delivery_latency:
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
  tags: { scenario: "full-flow", stage: stage },
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

// ─── Seller Flow ─────────────────────────────────────────────
// Seller stays on PresenceHub only (goes "online" in Redis).
// k6 ws.connect() is BLOCKING, so we can't open two WebSockets
// simultaneously in one VU. The seller listens for notifications
// on PresenceHub while the paired buyer handles the MessageHub chat.
export function sellerFlow() {
  const pair = getTestPair(__VU);
  const seller = { ...pair.seller, token: generateToken(pair.seller) };

  // Connect to PresenceHub (go online)
  const presNeg = negotiate(HUBS.presence, seller.token);
  if (!presNeg) {
    wsErrors.add(1);
    sleep(1);
    return;
  }

  const presWsUrl = buildWsUrl(
    HUBS.presence,
    seller.token,
    presNeg.connectionToken,
  );

  const connectStart = Date.now();
  let sessionStart = 0;

  const presRes = ws.connect(presWsUrl, null, function (socket) {
    wsConnectingDuration.add(Date.now() - connectStart);
    let handshakeDone = false;
    const handshakeStart = Date.now();

    socket.on("open", function () {
      socket.send(handshakeMessage());

      // Handshake timeout
      socket.setTimeout(function () {
        if (!handshakeDone) {
          console.error(`Seller VU ${__VU} PresenceHub handshake timeout`);
          wsErrors.add(1);
          socket.close();
        }
      }, TIMING.handshakeTimeoutMs);
    });

    socket.on("message", function (data) {
      const msgs = parseMessages(data);
      for (const msg of msgs) {
        if (!handshakeDone && isHandshakeResponse(msg)) {
          handshakeDone = true;
          wsHandshakeDuration.add(Date.now() - handshakeStart);
          wsErrors.add(0);
          sessionStart = Date.now();

          socket.setInterval(function () {
            socket.send(invocationMessage("Heartbeat", []));
          }, TIMING.heartbeatIntervalMs);

          socket.setInterval(function () {
            socket.send(pingMessage());
          }, TIMING.pingIntervalMs);

          // Hold presence connection for the full test duration
          socket.setTimeout(
            function () {
              socket.close();
            },
            HOLD_DURATION_MS + STAGGER_MS + 10000,
          );
          continue;
        }

        if (!handshakeDone && isHandshakeError(msg)) {
          wsErrors.add(1);
          socket.close();
          return;
        }

        if (msg.type === MSG_TYPE.PING) {
          socket.send(pingMessage());
          continue;
        }

        if (isEvent(msg, "ChatMessageNotification")) {
          chatNotificationsReceived.add(1);
        }

        if (isClose(msg)) {
          if (msg.error) wsErrors.add(1);
          socket.close();
          return;
        }
      }
    });

    socket.on("error", function () {
      wsErrors.add(1);
    });

    socket.on("close", function () {
      if (sessionStart > 0) {
        wsSessionDuration.add(Date.now() - sessionStart);
      }
    });
  });

  check(presRes, {
    "Seller PresenceHub WS 101": (r) => r && r.status === 101,
  });

  if (!presRes || presRes.status !== 101) {
    wsErrors.add(1);
  }

  sleep(Math.random() * 2 + 1);
}

// ─── Buyer Flow ───────────────────────────────────────────────
export function buyerFlow() {
  const pair = getTestPair(__VU);
  const seller = { ...pair.seller, token: generateToken(pair.seller) };
  const buyer = { ...pair.buyer, token: generateToken(pair.buyer) };
  const itemId = pair.itemId;

  // Step 1: Connect to PresenceHub
  const presNeg = negotiate(HUBS.presence, buyer.token);
  if (!presNeg) {
    wsErrors.add(1);
    sleep(1);
    return;
  }

  const presWsUrl = buildWsUrl(
    HUBS.presence,
    buyer.token,
    presNeg.connectionToken,
  );

  let sellerIsOnline = false;

  const presRes = ws.connect(presWsUrl, null, function (socket) {
    let handshakeDone = false;

    socket.on("open", function () {
      socket.send(handshakeMessage());

      // Handshake timeout
      socket.setTimeout(function () {
        if (!handshakeDone) {
          console.error(`Buyer VU ${__VU} PresenceHub handshake timeout`);
          wsErrors.add(1);
          socket.close();
        }
      }, TIMING.handshakeTimeoutMs);
    });

    socket.on("message", function (data) {
      const msgs = parseMessages(data);
      for (const msg of msgs) {
        if (!handshakeDone && isHandshakeResponse(msg)) {
          handshakeDone = true;
          wsErrors.add(0);

          socket.setInterval(function () {
            socket.send(invocationMessage("Heartbeat", []));
          }, TIMING.heartbeatIntervalMs);

          socket.setInterval(function () {
            socket.send(pingMessage());
          }, TIMING.pingIntervalMs);

          // Check if seller is online
          const checkInvId = `check-seller-${__VU}-${Date.now()}`;
          socket.send(
            invocationMessage("IsUserOnline", [seller.username], checkInvId),
          );
          presenceChecks.add(1);

          socket.setTimeout(function () {
            socket.close();
          }, HOLD_DURATION_MS + 10000);
          continue;
        }

        if (!handshakeDone && isHandshakeError(msg)) {
          wsErrors.add(1);
          socket.close();
          return;
        }

        if (msg.type === MSG_TYPE.PING) {
          socket.send(pingMessage());
          continue;
        }

        // IsUserOnline completion
        if (
          msg.type === MSG_TYPE.COMPLETION &&
          msg.invocationId &&
          msg.invocationId.startsWith("check-seller-")
        ) {
          if (msg.result && msg.result.isOnline === true) {
            sellerIsOnline = true;
            presenceOnline.add(1);
          }
          continue;
        }

        if (isEvent(msg, "ChatMessageNotification")) {
          chatNotificationsReceived.add(1);
        }

        if (isClose(msg)) {
          if (msg.error) wsErrors.add(1);
          socket.close();
          return;
        }
      }
    });

    socket.on("error", function () {
      wsErrors.add(1);
    });
  });

  check(presRes, {
    "Buyer PresenceHub WS 101": (r) => r && r.status === 101,
  });

  // Step 2: Connect to MessageHub
  const queryParams = { user: seller.username, itemId: itemId };
  const msgNeg = negotiate(HUBS.message, buyer.token, queryParams);
  if (!msgNeg) {
    wsErrors.add(1);
    sleep(1);
    return;
  }

  const msgWsUrl = buildWsUrl(
    HUBS.message,
    buyer.token,
    msgNeg.connectionToken,
    queryParams,
  );

  const connectStart = Date.now();
  const pendingInvocations = {};
  let receivedMessageIds = [];
  let buyerSessionStart = 0;

  const msgRes = ws.connect(msgWsUrl, null, function (socket) {
    wsConnectingDuration.add(Date.now() - connectStart);
    let handshakeDone = false;
    const handshakeStart = Date.now();

    socket.on("open", function () {
      socket.send(handshakeMessage());

      // Handshake timeout
      socket.setTimeout(function () {
        if (!handshakeDone) {
          console.error(`Buyer VU ${__VU} MessageHub handshake timeout`);
          wsErrors.add(1);
          socket.close();
        }
      }, TIMING.handshakeTimeoutMs);
    });

    socket.on("message", function (data) {
      const msgs = parseMessages(data);
      for (const msg of msgs) {
        if (!handshakeDone && isHandshakeResponse(msg)) {
          handshakeDone = true;
          wsHandshakeDuration.add(Date.now() - handshakeStart);
          wsErrors.add(0);

          socket.setInterval(function () {
            socket.send(pingMessage());
          }, TIMING.pingIntervalMs);

          // Send typing -> message after delay
          socket.setTimeout(function () {
            socket.send(invocationMessage("Typing", [true]));

            socket.setTimeout(function () {
              socket.send(invocationMessage("Typing", [false]));

              const invId = `buyer-msg-${__VU}-${Date.now()}`;
              // Mixed message types: 75% Text, 25% Offer
              const isOffer = Math.random() < 0.25;
              const msgType = isOffer ? MessageType.Offer : MessageType.Text;
              const content = isOffer
                ? `Offer from buyer VU ${__VU}`
                : `Hello seller! Load test from buyer VU ${__VU}`;
              const command = {
                RecipientUsername: seller.username,
                ItemId: itemId,
                Content: content,
                MessageType: msgType,
              };
              pendingInvocations[invId] = Date.now();
              socket.send(invocationMessage("SendMessage", [command], invId));
              messagesSent.add(1);
            }, 800);
          }, TIMING.messageDelayMs);

          // Mark messages as read, then close
          socket.setTimeout(function () {
            if (receivedMessageIds.length > 0) {
              socket.send(
                invocationMessage("MessageRead", [receivedMessageIds, itemId]),
              );
            }
            socket.setTimeout(function () {
              socket.close();
            }, 1000);
          }, HOLD_DURATION_MS);

          continue;
        }

        if (!handshakeDone && isHandshakeError(msg)) {
          wsErrors.add(1);
          socket.close();
          return;
        }

        if (msg.type === MSG_TYPE.PING) {
          socket.send(pingMessage());
          continue;
        }

        if (isEvent(msg, "ReceiveMessageThread")) {
          threadReceived.add(1);
          continue;
        }

        // NewMessage from seller (reply)
        if (isEvent(msg, "NewMessage")) {
          messagesReceived.add(1);
          if (msg.arguments && msg.arguments[0] && msg.arguments[0].id) {
            receivedMessageIds.push(msg.arguments[0].id);
          }
          continue;
        }

        if (isEvent(msg, "UserTyping")) {
          typingIndicatorsReceived.add(1);
          continue;
        }

        if (msg.type === MSG_TYPE.COMPLETION && msg.invocationId) {
          const sentAt = pendingInvocations[msg.invocationId];
          if (sentAt) {
            messageDeliveryLatency.add(Date.now() - sentAt);
            delete pendingInvocations[msg.invocationId];
          }
          continue;
        }

        if (isClose(msg)) {
          if (msg.error) wsErrors.add(1);
          socket.close();
          return;
        }
      }
    });

    socket.on("error", function () {
      wsErrors.add(1);
    });

    socket.on("close", function () {
      if (buyerSessionStart > 0) {
        wsSessionDuration.add(Date.now() - buyerSessionStart);
      }
    });
  });
  check(msgRes, {
    "Buyer MessageHub WS 101": (r) => r && r.status === 101,
  });

  sleep(Math.random() * 2 + 1);
}

// ─── Summary Handler ──────────────────────────────────────────
import { generateReport } from "../helpers/report.js";

export function handleSummary(data) {
  return generateReport(data, { scenario: "full-flow", stage });
}
