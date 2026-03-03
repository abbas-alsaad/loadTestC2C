/**
 * Chat + Offers — Full Lifecycle Load Test
 *
 * Simulates the complete buyer → seller offer lifecycle:
 *
 *   1. Buyer connects to MessageHub (WebSocket + SignalR handshake)
 *   2. Buyer sends 1-2 text chat messages via SendMessage
 *   3. Buyer creates an offer via REST API:
 *      POST /api/pos/items/{itemId}/offers { offerType: 1, offeredAmount, message }
 *   4. Buyer waits for NewMessage (offer card pushed by the server)
 *   5. Seller accepts the offer via REST API:
 *      POST /api/pos/offers/{offerId}/accept { responseMessage }
 *   6. Buyer optionally receives OfferStatusChanged / InvoiceCreated events
 *   7. Session closes after hold duration
 *
 * IMPORTANT:
 *   This scenario uses REAL database users. The server's ChatAuthorizationService
 *   validates that one participant is the item's seller. Synthetic identities
 *   will be rejected with a 401/403.
 *
 * Environment Variables:
 *   TARGET_URL       - Server URL (default: https://c2c-api-uat.gini.iq)
 *   ITEM_ID          - Real item GUID owned by the seller
 *   SELLER_USER_ID   - Seller's AppUserId GUID
 *   SELLER_USERNAME  - Seller's phone/username
 *   BUYER_USER_ID    - Buyer's AppUserId GUID
 *   BUYER_USERNAME   - Buyer's phone/username
 *   STAGE            - Load stage (smoke, low, medium, high, breakpoint, extreme)
 *
 * Usage:
 *   k6 run --env TARGET_URL=https://c2c-api-uat.gini.iq \
 *          --env ITEM_ID=7fc1be00-ff62-41e2-8c06-bbff64ee1a6c \
 *          scenarios/chat-offers.js
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
const wsSessionDuration = new Trend("ws_session_duration", true);

// Chat metrics
const messagesSent = new Counter("messages_sent");
const messagesReceived = new Counter("messages_received");
const messageDeliveryLatency = new Trend("message_delivery_latency", true);
const threadReceived = new Counter("message_thread_received");

// Offer metrics
const offerCreationLatency = new Trend("offer_creation_latency", true);
const offerAcceptLatency = new Trend("offer_accept_latency", true);
const offersCreated = new Counter("offers_created");
const offersAccepted = new Counter("offers_accepted");
const offersFailed = new Counter("offers_failed");

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
      : ["p(95)<1500"],
    offer_creation_latency: isBreakpoint
      ? [{ threshold: "p(95)<5000", abortOnFail: true, delayAbortEval: "10s" }]
      : ["p(95)<3000"],
    offer_accept_latency: isBreakpoint
      ? [{ threshold: "p(95)<5000", abortOnFail: true, delayAbortEval: "10s" }]
      : ["p(95)<3000"],
  },
  tags: { scenario: "chat-offers", stage: stage },
};

// ─── Config ───────────────────────────────────────────────────
const MESSAGES_PER_SESSION = parseInt(__ENV.MESSAGES_PER_SESSION || "2");

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
  console.log(
    `Using test data pool (1000 pairs). Ensure seed-test-data.sql has been run.`,
  );
}

// ─── REST: Create Offer ───────────────────────────────────────
function createOffer(token, itemId) {
  const amount = Math.floor(Math.random() * 9750) + 250; // 250 - 10000 IQD
  const payload = JSON.stringify({
    offerType: 1, // PriceOffer
    offeredAmount: amount,
    message: `Load test offer $${amount} from VU ${__VU}`,
    expirationHours: 24,
  });

  const start = Date.now();
  const res = http.post(`${BASE_URL}/api/pos/items/${itemId}/offers`, payload, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    tags: { name: "create-offer" },
    responseCallback: http.expectedStatuses(200, 201, 400),
  });
  const latency = Date.now() - start;
  offerCreationLatency.add(latency);

  const created = check(res, {
    "offer created (200/201)": (r) => r.status === 200 || r.status === 201,
  });

  if (!created) {
    // Item locked after a previous accept is expected — not a test failure
    if (res.status === 400) {
      const body = res.body || "";
      if (
        body.indexOf("\u063A\u064A\u0631 \u0645\u062A\u0627\u062D") > -1 || // "غير متاح"
        body.indexOf("not available") > -1 ||
        body.indexOf("InTransaction") > -1
      ) {
        // Expected: item was locked by a prior accepted offer
        offersFailed.add(1);
        return "item-locked";
      }
    }
    console.error(
      `Create offer failed: ${res.status} ${res.body ? res.body.substring(0, 200) : "no body"}`,
    );
    offersFailed.add(1);
    return null;
  }

  offersCreated.add(1);

  try {
    const body = res.json();
    // Server wraps in ClientResponse<T>: { hasError, result: { offerId, ... } }
    const offerId =
      body.result && body.result.offerId
        ? body.result.offerId
        : body.result && body.result.id
          ? body.result.id
          : null;
    if (!offerId) {
      console.warn(
        `Offer created but no offerId in response: ${res.body ? res.body.substring(0, 200) : ""}`,
      );
    }
    return offerId;
  } catch (e) {
    console.warn(`Failed to parse offer response: ${e.message}`);
    return null;
  }
}

// ─── REST: Accept Offer ───────────────────────────────────────
function acceptOffer(offerId, token) {
  if (!offerId) return false;

  const payload = JSON.stringify({
    responseMessage: `Accepted by load test VU ${__VU}`,
  });

  const start = Date.now();
  const res = http.post(
    `${BASE_URL}/api/pos/offers/${offerId}/accept`,
    payload,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      tags: { name: "accept-offer" },
      responseCallback: http.expectedStatuses(200, 400, 409),
    },
  );
  const latency = Date.now() - start;
  offerAcceptLatency.add(latency);

  const accepted = check(res, {
    "offer accepted (200)": (r) => r.status === 200,
  });

  if (!accepted) {
    // 400/409 likely means offer was superseded by another VU's offer
    if (res.status === 400 || res.status === 409) {
      if (__ENV.DEBUG) {
        console.warn(
          `Offer ${offerId} superseded/invalid: ${res.status} ${res.body ? res.body.substring(0, 150) : ""}`,
        );
      }
      offersFailed.add(1);
      return false;
    }
    console.error(
      `Accept offer failed: ${res.status} ${res.body ? res.body.substring(0, 200) : "no body"}`,
    );
    offersFailed.add(1);
    return false;
  }

  offersAccepted.add(1);
  return true;
}

// ─── Main VU Function ─────────────────────────────────────────
export default function () {
  // Each VU gets a unique seller/buyer/item pair from the test data pool.
  const pair = getTestPair(__VU);
  const buyerToken = generateToken(pair.buyer);
  const sellerToken = generateToken(pair.seller);
  const itemId = pair.itemId;

  const queryParams = {
    user: pair.seller.username,
    itemId: itemId,
  };

  // 1. Negotiate
  const negotiateResult = negotiate(HUBS.message, buyerToken, queryParams);
  if (!negotiateResult) {
    wsErrors.add(1);
    sleep(1);
    return;
  }

  // 2. Build WebSocket URL
  const wsUrl = buildWsUrl(
    HUBS.message,
    buyerToken,
    negotiateResult.connectionToken,
    queryParams,
  );

  // 3. Connect to MessageHub as buyer
  const connectStart = Date.now();
  let handshakeCompleted = false;
  let handshakeStart = 0;
  let sessionStart = 0;
  let msgCount = 0;
  let invocationCounter = 0;
  const pendingInvocations = {};
  let offerCreatedInSession = false;

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

          // Start sending text messages after a short delay
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

        // ReceiveMessageThread — sent on connect
        if (isEvent(msg, "ReceiveMessageThread")) {
          threadReceived.add(1);
          continue;
        }

        // NewMessage — real-time message from server (text or offer card)
        if (isEvent(msg, "NewMessage")) {
          messagesReceived.add(1);
          continue;
        }

        // OfferStatusChanged — fired when seller accepts/rejects
        if (isEvent(msg, "OfferStatusChanged")) {
          // Expected after seller accepts
          continue;
        }

        // InvoiceCreated — fired after offer acceptance
        if (isEvent(msg, "InvoiceCreated")) {
          continue;
        }

        // Completion — response to our SendMessage invocation
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
      if (sessionStart > 0) {
        wsSessionDuration.add(Date.now() - sessionStart);
      }
    });

    // ─── Send text messages, then create + accept offer ───────
    function sendNextMessage(sock) {
      if (msgCount >= MESSAGES_PER_SESSION) {
        // Done sending text messages — now do the offer lifecycle
        if (!offerCreatedInSession) {
          sock.setTimeout(function () {
            doOfferLifecycle(sock);
          }, TIMING.messageDelayMs);
        }
        return;
      }

      invocationCounter++;
      const invId = `msg-${__VU}-${invocationCounter}`;

      // Typing indicator
      sock.send(invocationMessage("Typing", [true]));

      sock.setTimeout(function () {
        sock.send(invocationMessage("Typing", [false]));

        const content = `Load test chat msg ${msgCount + 1} from VU ${__VU}`;
        const command = {
          RecipientUsername: pair.seller.username,
          ItemId: itemId,
          Content: content,
          MessageType: MessageType.Text,
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

    // ─── Offer lifecycle (runs after text messages) ───────────
    function doOfferLifecycle(sock) {
      offerCreatedInSession = true;

      // Create offer via REST (buyer creates)
      const offerId = createOffer(buyerToken, itemId);

      if (offerId === "item-locked") {
        // Item was locked by a prior accepted offer — expected on repeat iterations
        sock.setTimeout(function () {
          sock.close();
        }, TIMING.messageDelayMs);
      } else if (offerId) {
        // Small delay to let server process the offer + push NewMessage
        sock.setTimeout(function () {
          // Seller accepts the offer via REST
          acceptOffer(offerId, sellerToken);

          // Hold connection briefly to receive any events, then close
          sock.setTimeout(function () {
            sock.close();
          }, TIMING.messageDelayMs * 2);
        }, TIMING.messageDelayMs);
      } else {
        // Offer creation failed — close after short delay
        sock.setTimeout(function () {
          sock.close();
        }, TIMING.messageDelayMs);
      }
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
  return generateReport(data, { scenario: "chat-offers", stage });
}
