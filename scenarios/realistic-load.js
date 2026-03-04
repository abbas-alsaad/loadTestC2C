/**
 * ═══════════════════════════════════════════════════════════════════════
 * REALISTIC LOAD — Mixed Traffic Simulation (FINAL)
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Simulates REAL production traffic with realistic user behavior mix.
 * Instead of all VUs doing the same thing, this test distributes users
 * across 4 scenarios with production-like ratios:
 *
 * ┌──────────────────────────────────────────────────────────────────┐
 * │              TOTAL CONCURRENT USERS (e.g. 50,000)               │
 * ├─────────────────────────────────────────────┬─────────┬─────────┤
 * │ ████████████████████████████████████████████ │█████████│███      │
 * │ Chat + Offers  75%           (37,500 VUs)   │Browse 20│Idle 5%  │
 * │ ┌─────────────────┬─────────────────┐       │(10,000) │(2,500)  │
 * │ │ Sellers  37.5%  │ Buyers  37.5%   │       │         │         │
 * │ │ (18,750 VUs)    │ (18,750 VUs)    │       │         │         │
 * │ │ MessageHub      │ MessageHub      │       │REST API │Presence │
 * │ │ listen for msgs │ send messages   │       │browse   │Hub only │
 * │ │ mark as read ★  │ verify read ★   │       │search   │heartbeat│
 * │ │ verify delivery │ create offers   │       │view     │online   │
 * │ └─────────────────┴─────────────────┘       │         │         │
 * └─────────────────────────────────────────────┴─────────┴─────────┘
 *
 * ── Full Chat Lifecycle ───────────────────────────────────────────────
 *
 *   1. Buyer  → SendMessage (with CID + timestamp)
 *   2. Seller ← NewMessage  (verifies CID, measures latency)
 *   3. Seller → MessageRead (marks message IDs as read in DB)
 *   4. Buyer  ← MessageRead event (verifies read receipt arrived)
 *   5. Buyer  → CreateOffer (REST)
 *   6. Seller → AcceptOffer (REST)
 *
 * ── Stages ────────────────────────────────────────────────────────────
 *
 *   micro:    5 total users      → quick local validation
 *   smoke:    20 total users     → quick validation
 *   low:     100 total users     → baseline
 *   medium: 1,000 total users    → moderate load
 *   high:   5,000 total users    → heavy load
 *   massive: 10,000 total users  → large production simulation
 *   extreme: 50,000 total users  → maximum stress test (~5 min)
 *
 * ── Usage ─────────────────────────────────────────────────────────────
 *
 *   # Smoke test (20 users)
 *   k6 run --env TARGET_URL=https://c2c-api.gini.iq \
 *          --env WS_URL=wss://ws-c2c-api.gini.iq \
 *          --env STAGE=smoke \
 *          load-tests/scenarios/realistic-load.js
 *
 *   # 50,000 users — extreme (~5 min)
 *   k6 run --env TARGET_URL=https://c2c-api.gini.iq \
 *          --env WS_URL=wss://ws-c2c-api.gini.iq \
 *          --env STAGE=extreme \
 *          load-tests/scenarios/realistic-load.js
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
import exec from "k6/execution";

// ═══════════════════════════════════════════════════════════════
// METRICS
// ═══════════════════════════════════════════════════════════════

// ── WebSocket Connection ─────────────────────────────────────
const wsConnectingDuration = new Trend("ws_connecting_duration", true);
const wsHandshakeDuration = new Trend("ws_handshake_duration", true);
const wsErrors = new Rate("ws_errors");
const wsSessionDuration = new Trend("ws_session_duration", true);

// ── Chat Delivery (★ Key metrics) ────────────────────────────
const messagesSent = new Counter("messages_sent");
const messagesDelivered = new Counter("messages_delivered");
const messageDeliveryLatency = new Trend("message_delivery_latency", true);
const messageContentMatch = new Rate("message_content_match");
const threadReceived = new Counter("message_thread_received");

// ── Mark-as-Read (★ New) ─────────────────────────────────────
const messagesMarkedRead = new Counter("messages_marked_read");
const markReadLatency = new Trend("mark_read_latency", true);
const readReceiptsReceived = new Counter("read_receipts_received");
const readReceiptMatch = new Rate("read_receipt_match");

// ── Offer Lifecycle ──────────────────────────────────────────
const offerCreationLatency = new Trend("offer_creation_latency", true);
const offerAcceptLatency = new Trend("offer_accept_latency", true);
const offersCreated = new Counter("offers_created");
const offersAccepted = new Counter("offers_accepted");
const offersFailed = new Counter("offers_failed");

// ── Browsing Performance ─────────────────────────────────────
const browseItemsLatency = new Trend("browse_items_latency", true);
const viewItemLatency = new Trend("view_item_latency", true);
const browseCategoriesLatency = new Trend("browse_categories_latency", true);
const browseRequests = new Counter("browse_requests");
const browseErrors = new Rate("browse_errors");

// ── Idle / Presence ──────────────────────────────────────────
const idleConnections = new Counter("idle_connections");
const idleHeartbeats = new Counter("idle_heartbeats");

// ── Reliability ──────────────────────────────────────────────
const handshakeFailures = new Counter("handshake_failures");
const wsReconnects = new Counter("ws_reconnects");
const messagesDuplicated = new Counter("messages_duplicated");

// ═══════════════════════════════════════════════════════════════
// TRAFFIC MIX — Production-like ratios
// ═══════════════════════════════════════════════════════════════

const MIX = {
  sellers: 0.375, // 37.5% — half of the 75% chat users
  buyers: 0.375, // 37.5% — half of the 75% chat users
  browsers: 0.2, // 20%   — browsing REST APIs
  idle: 0.05, // 5%    — connected but inactive
};

// ═══════════════════════════════════════════════════════════════
// TOTAL USER STAGES
// ═══════════════════════════════════════════════════════════════

const TOTAL_STAGES = {
  micro: [
    { duration: "10s", target: 5 },
    { duration: "1m", target: 5 },
    { duration: "10s", target: 0 },
  ],
  smoke: [
    { duration: "30s", target: 20 },
    { duration: "1m", target: 20 },
    { duration: "15s", target: 0 },
  ],
  low: [
    { duration: "1m", target: 100 },
    { duration: "3m", target: 100 },
    { duration: "30s", target: 0 },
  ],
  medium: [
    { duration: "2m", target: 500 },
    { duration: "3m", target: 1000 },
    { duration: "3m", target: 1000 },
    { duration: "1m", target: 0 },
  ],
  high: [
    { duration: "2m", target: 2000 },
    { duration: "3m", target: 5000 },
    { duration: "5m", target: 5000 },
    { duration: "2m", target: 0 },
  ],
  massive: [
    { duration: "3m", target: 2000 },
    { duration: "5m", target: 10000 },
    { duration: "10m", target: 10000 },
    { duration: "3m", target: 0 },
  ],
  // ★ EXTREME — 50,000 VUs in ~5 minutes
  extreme: [
    { duration: "1m", target: 10000 },
    { duration: "1m", target: 50000 },
    { duration: "2m", target: 50000 },
    { duration: "1m", target: 0 },
  ],
  extremeSmall: [
    { duration: "1m", target: 5000 },
    { duration: "1m", target: 10000 },
    { duration: "2m", target: 15000 },
    { duration: "1m", target: 0 },
  ],
};

function scaleStages(stages, ratio) {
  return stages.map((s) => ({
    duration: s.duration,
    target: s.target === 0 ? 0 : Math.max(1, Math.round(s.target * ratio)),
  }));
}

function getMaxFromStages(stages) {
  let max = 0;
  for (const s of stages) {
    if (s.target > max) max = s.target;
  }
  return max;
}

// ═══════════════════════════════════════════════════════════════
// k6 OPTIONS — 4 parallel scenarios
// ═══════════════════════════════════════════════════════════════

const stage = __ENV.STAGE || "smoke";
const isBreakpoint = stage === "breakpoint";
const baseThresholds = isBreakpoint ? BREAKPOINT_THRESHOLDS : THRESHOLDS;
const totalStages = TOTAL_STAGES[stage] || TOTAL_STAGES.smoke;
const maxTotal = getMaxFromStages(totalStages);

// Messages per VU session — higher for extreme
const MESSAGES_PER_SESSION = parseInt(
  __ENV.MESSAGES_PER_SESSION || (stage === "extreme" ? "5" : "3"),
);

// Message delay between sends — faster for extreme (1s vs 2s)
const MSG_DELAY_MS = parseInt(
  __ENV.MSG_DELAY_MS ||
    (stage === "extreme" ? "1000" : String(TIMING.messageDelayMs)),
);

// ── Pair Pool ─────────────────────────────────────────────────
// Capped at 1000 — matches the seeded DB pairs
const MAX_SEEDED_PAIRS = 1000;
const maxSellerVUs = getMaxFromStages(scaleStages(totalStages, MIX.sellers));
const NUM_PAIRS =
  maxTotal <= 20
    ? 1
    : Math.min(
        MAX_SEEDED_PAIRS,
        Math.max(1, Math.floor(Math.sqrt(maxSellerVUs))),
      );

export const options = {
  scenarios: {
    sellers: {
      executor: "ramping-vus",
      exec: "sellerFlow",
      stages: scaleStages(totalStages, MIX.sellers),
      gracefulStop: "30s",
      gracefulRampDown: "10s",
      tags: { role: "seller" },
    },
    buyers: {
      executor: "ramping-vus",
      exec: "buyerFlow",
      startTime: "3s",
      stages: scaleStages(totalStages, MIX.buyers),
      gracefulStop: "30s",
      gracefulRampDown: "10s",
      tags: { role: "buyer" },
    },
    browsers: {
      executor: "ramping-vus",
      exec: "browserFlow",
      stages: scaleStages(totalStages, MIX.browsers),
      gracefulStop: "15s",
      gracefulRampDown: "5s",
      tags: { role: "browser" },
    },
    idle_users: {
      executor: "ramping-vus",
      exec: "idleFlow",
      stages: scaleStages(totalStages, MIX.idle),
      gracefulStop: "30s",
      gracefulRampDown: "10s",
      tags: { role: "idle" },
    },
  },
  thresholds: {
    ...baseThresholds,
    // ★ Cross-user delivery
    message_delivery_latency: isBreakpoint
      ? [{ threshold: "p(95)<3000", abortOnFail: true, delayAbortEval: "10s" }]
      : ["p(95)<2000"],
    message_content_match: ["rate>0.85"],
    // ★ Mark-as-read
    mark_read_latency: ["p(95)<2000"],
    read_receipt_match: ["rate>0.80"],
    // Reliability
    handshake_failures: ["count<50"],
    // Browsing
    browse_items_latency: isBreakpoint
      ? [{ threshold: "p(95)<5000", abortOnFail: true, delayAbortEval: "10s" }]
      : ["p(95)<3000"],
    browse_errors: ["rate<0.05"],
    // Offers
    offer_creation_latency: isBreakpoint
      ? [{ threshold: "p(95)<5000", abortOnFail: true, delayAbortEval: "10s" }]
      : ["p(95)<3000"],
  },
  tags: { scenario: "realistic-load", stage: stage },
};

// ═══════════════════════════════════════════════════════════════
// SETUP — Health check + banner
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

  const sellerVUs = Math.round(maxTotal * MIX.sellers);
  const buyerVUs = Math.round(maxTotal * MIX.buyers);
  const browserVUs = Math.round(maxTotal * MIX.browsers);
  const idleVUs = Math.round(maxTotal * MIX.idle);

  console.log(
    `╔══════════════════════════════════════════════════════════════╗`,
  );
  console.log(`║  C2C REALISTIC LOAD TEST — FINAL                           ║`);
  console.log(
    `╠══════════════════════════════════════════════════════════════╣`,
  );
  console.log(`║  Server:     ${BASE_URL}`);
  console.log(
    `║  Stage:      ${stage} (${fmtNum(maxTotal)} total users, ${NUM_PAIRS} pair pool)`,
  );
  console.log(
    `║  Msgs/VU:    ${MESSAGES_PER_SESSION}  |  Delay: ${MSG_DELAY_MS}ms`,
  );
  console.log(`║`);
  console.log(`║  Traffic Distribution:`);
  console.log(
    `║  ${"█".repeat(30)} Chat 75%  (${fmtNum(sellerVUs + buyerVUs)} VUs)`,
  );
  console.log(
    `║  ${"█".repeat(8)}                      Browse 20% (${fmtNum(browserVUs)} VUs)`,
  );
  console.log(
    `║  ${"█".repeat(2)}                            Idle 5%   (${fmtNum(idleVUs)} VUs)`,
  );
  console.log(`║`);
  console.log(
    `║  Sellers: ${fmtNum(sellerVUs)}  |  Buyers: ${fmtNum(buyerVUs)}  |  Browsers: ${fmtNum(browserVUs)}  |  Idle: ${fmtNum(idleVUs)}`,
  );
  console.log(`║`);
  console.log(`║  ★ Full lifecycle: Send → Deliver → MarkRead → ReadReceipt`);
  console.log(
    `╚══════════════════════════════════════════════════════════════╝`,
  );
}

function fmtNum(n) {
  if (n >= 1000) return (n / 1000).toFixed(1) + "K";
  return String(n);
}

// ═══════════════════════════════════════════════════════════════
//
//  ███████╗███████╗██╗     ██╗     ███████╗██████╗
//  ██╔════╝██╔════╝██║     ██║     ██╔════╝██╔══██╗
//  ███████╗█████╗  ██║     ██║     █████╗  ██████╔╝
//  ╚════██║██╔══╝  ██║     ██║     ██╔══╝  ██╔══██╗
//  ███████║███████╗███████╗███████╗███████╗██║  ██║
//  ╚══════╝╚══════╝╚══════╝╚══════╝╚══════╝╚═╝  ╚═╝
//
//  37.5% — Connect to MessageHub as seller, listen for messages,
//  verify delivery via CID, then mark messages as read via
//  SignalR MessageRead() — persists to DB and broadcasts
//  read receipt back to buyer.
//
// ═══════════════════════════════════════════════════════════════

export function sellerFlow() {
  const vuId = exec.vu.idInInstance;
  const pairIdx = (vuId % NUM_PAIRS) + 1;
  if (exec.vu.iterationInInstance > 0) wsReconnects.add(1);

  const pair = getTestPair(pairIdx);
  const sellerToken = generateToken(pair.seller);

  const queryParams = {
    recipientUsername: pair.buyer.username,
    user: pair.buyer.username,
    itemId: pair.itemId,
  };

  const wsUrl = buildWsUrl(HUBS.message, sellerToken, null, queryParams);
  const connectStart = Date.now();
  let handshakeCompleted = false;
  let handshakeStart = 0;
  let sessionStart = 0;
  let deliveredCount = 0;
  const seenCIDs = new Set();
  const receivedMessageIds = []; // ★ Collect IDs for mark-as-read
  let markReadDone = false;
  let markReadInvId = "";
  let markReadSentAt = 0;

  const res = ws.connect(wsUrl, null, function (socket) {
    wsConnectingDuration.add(Date.now() - connectStart);

    socket.on("open", function () {
      handshakeStart = Date.now();
      socket.send(handshakeMessage());

      socket.setTimeout(function () {
        if (!handshakeCompleted) {
          handshakeFailures.add(1);
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

          // Max session duration — fallback if messages arrive late
          const holdMs =
            5000 + (MESSAGES_PER_SESSION + 4) * MSG_DELAY_MS + 15000;
          socket.setTimeout(function () {
            if (!markReadDone) doMarkAsRead(socket);
            else socket.close();
          }, holdMs);
          continue;
        }

        if (!handshakeCompleted && isHandshakeError(msg)) {
          handshakeFailures.add(1);
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

        // ══════════════════════════════════════════════════════
        // ★ NewMessage from buyer → verify delivery via CID
        // ══════════════════════════════════════════════════════
        if (isEvent(msg, "NewMessage")) {
          const args = msg.arguments || [];
          const payload = args[0] || {};
          const content = payload.content || payload.Content || "";
          const msgId =
            payload.id || payload.Id || payload.messageId || payload.MessageId;

          // ★ Collect message ID for mark-as-read
          if (msgId) receivedMessageIds.push(String(msgId));

          const cidMatch = content.match(/\[CID:(\d+):(\d+):(\d+)\]/);
          if (cidMatch) {
            const [, cidPair, cidSrcVu, cidSeq] = cidMatch;
            const cidKey = `${cidPair}:${cidSrcVu}:${cidSeq}`;

            if (parseInt(cidPair) === pair.pairIndex && !seenCIDs.has(cidKey)) {
              seenCIDs.add(cidKey);
              messagesDelivered.add(1);
              deliveredCount++;
              messageContentMatch.add(1);

              const tsMatch = content.match(/\[TS:(\d+)\]/);
              if (tsMatch) {
                messageDeliveryLatency.add(Date.now() - parseInt(tsMatch[1]));
              }

              // ★ Mark as read once we've received all expected messages
              if (deliveredCount === MESSAGES_PER_SESSION && !markReadDone) {
                socket.setTimeout(function () {
                  doMarkAsRead(socket);
                }, 2000); // 2s simulate reading delay
              }
            } else if (
              parseInt(cidPair) === pair.pairIndex &&
              seenCIDs.has(cidKey)
            ) {
              messagesDuplicated.add(1);
            } else {
              messageContentMatch.add(0);
            }
          } else {
            messageContentMatch.add(0);
          }
          continue;
        }

        if (isEvent(msg, "UserTyping")) continue;
        if (isEvent(msg, "OfferStatusChanged")) continue;
        if (isEvent(msg, "InvoiceCreated")) continue;
        if (isEvent(msg, "ChatStatusChanged")) continue;
        if (isEvent(msg, "MessageRead")) continue; // echo of our own mark-read

        // ★ Track mark-read round-trip latency via completion
        if (msg.type === MSG_TYPE.COMPLETION) {
          if (markReadInvId && msg.invocationId === markReadInvId) {
            markReadLatency.add(Date.now() - markReadSentAt);
          }
          continue;
        }
      }
    });

    // ══════════════════════════════════════════════════════════
    // ★ MARK AS READ — calls SignalR MessageRead() which:
    //   1. Persists read status to DB (IsRead=true, ReadAt=now)
    //   2. Broadcasts "MessageRead" event to buyer in the group
    // ══════════════════════════════════════════════════════════
    function doMarkAsRead(sock) {
      if (markReadDone) {
        sock.close();
        return;
      }
      markReadDone = true;

      if (receivedMessageIds.length > 0) {
        markReadInvId = `mr-${__VU}-${Date.now()}`;
        markReadSentAt = Date.now();
        sock.send(
          invocationMessage(
            "MessageRead",
            [receivedMessageIds, pair.itemId],
            markReadInvId,
          ),
        );
        messagesMarkedRead.add(receivedMessageIds.length);
      }

      // Wait for server to process + completion to arrive, then close
      sock.setTimeout(function () {
        sock.close();
      }, 3000);
    }

    socket.on("error", function (e) {
      wsErrors.add(1);
    });

    socket.on("close", function () {
      if (sessionStart > 0) {
        wsSessionDuration.add(Date.now() - sessionStart);
      }
    });
  });

  check(res, { "[SELLER] WS 101": (r) => r && r.status === 101 });
  check(null, { "[SELLER] Handshake OK": () => handshakeCompleted });
  if (!res || res.status !== 101) wsErrors.add(1);
}

// ═══════════════════════════════════════════════════════════════
//
//  ██████╗ ██╗   ██╗██╗   ██╗███████╗██████╗
//  ██╔══██╗██║   ██║╚██╗ ██╔╝██╔════╝██╔══██╗
//  ██████╔╝██║   ██║ ╚████╔╝ █████╗  ██████╔╝
//  ██╔══██╗██║   ██║  ╚██╔╝  ██╔══╝  ██╔══██╗
//  ██████╔╝╚██████╔╝   ██║   ███████╗██║  ██║
//  ╚═════╝  ╚═════╝    ╚═╝   ╚══════╝╚═╝  ╚═╝
//
//  37.5% — Connect to MessageHub as buyer, send messages with
//  CID + timestamp, verify "MessageRead" event comes back from
//  seller (proves read-status persisted to DB), then create offer.
//
// ═══════════════════════════════════════════════════════════════

export function buyerFlow() {
  const vuId = exec.vu.idInInstance;
  const pairIdx = (vuId % NUM_PAIRS) + 1;
  if (exec.vu.iterationInInstance > 0) wsReconnects.add(1);

  const pair = getTestPair(pairIdx);
  const buyerToken = generateToken(pair.buyer);
  const sellerToken = generateToken(pair.seller);

  const queryParams = {
    recipientUsername: pair.seller.username,
    user: pair.seller.username,
    itemId: pair.itemId,
  };

  const wsUrl = buildWsUrl(HUBS.message, buyerToken, null, queryParams);
  const connectStart = Date.now();
  let handshakeCompleted = false;
  let handshakeStart = 0;
  let sessionStart = 0;
  let msgCount = 0;
  let invocationCounter = 0;
  let offerDone = false;
  let readReceiptSeen = false; // ★ Track if we got MessageRead back

  const res = ws.connect(wsUrl, null, function (socket) {
    wsConnectingDuration.add(Date.now() - connectStart);

    socket.on("open", function () {
      handshakeStart = Date.now();
      socket.send(handshakeMessage());

      socket.setTimeout(function () {
        if (!handshakeCompleted) {
          handshakeFailures.add(1);
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
          }, MSG_DELAY_MS);

          socket.setInterval(function () {
            socket.send(pingMessage());
          }, TIMING.pingIntervalMs);
          continue;
        }

        if (!handshakeCompleted && isHandshakeError(msg)) {
          handshakeFailures.add(1);
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
          // Buyer receives echo — seller counts delivery
          continue;
        }

        // ══════════════════════════════════════════════════════
        // ★ MessageRead — seller marked our messages as read
        // This proves the DB was updated AND the event broadcast
        // ══════════════════════════════════════════════════════
        if (isEvent(msg, "MessageRead")) {
          if (!readReceiptSeen) {
            readReceiptSeen = true;
            readReceiptsReceived.add(1);
            readReceiptMatch.add(1);
            // ★ Close soon after confirming read receipt
            socket.setTimeout(function () {
              socket.close();
            }, 2000);
          }
          continue;
        }

        if (isEvent(msg, "OfferStatusChanged")) continue;
        if (isEvent(msg, "InvoiceCreated")) continue;
        if (isEvent(msg, "ChatStatusChanged")) continue;
        if (isEvent(msg, "UserTyping")) continue;
        if (msg.type === MSG_TYPE.COMPLETION) continue;
      }
    });

    socket.on("error", function (e) {
      wsErrors.add(1);
    });

    socket.on("close", function () {
      // ★ If we never received a read receipt, track the miss
      if (!readReceiptSeen && msgCount > 0) {
        readReceiptMatch.add(0);
      }
      if (sessionStart > 0) {
        wsSessionDuration.add(Date.now() - sessionStart);
      }
    });

    // ── Send messages with CID + timestamp ────────────────
    function sendNextMessage(sock) {
      if (msgCount >= MESSAGES_PER_SESSION) {
        if (!offerDone) {
          sock.setTimeout(function () {
            doOfferLifecycle(sock);
          }, MSG_DELAY_MS);
        }
        return;
      }

      invocationCounter++;
      const invId = `msg-${__VU}-${invocationCounter}`;

      // Typing indicator
      sock.send(invocationMessage("Typing", [true]));

      sock.setTimeout(function () {
        sock.send(invocationMessage("Typing", [false]));

        const now = Date.now();
        const content = `[CID:${pair.pairIndex}:${vuId}:${msgCount + 1}] [TS:${now}] Load test message`;

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
        }, MSG_DELAY_MS);
      }, 300);
    }

    // ── Offer lifecycle ───────────────────────────────────
    function doOfferLifecycle(sock) {
      offerDone = true;

      const offerId = createOffer(buyerToken, pair.itemId);

      if (offerId === "item-locked") {
        // Wait for possible read receipt then close
        sock.setTimeout(function () {
          sock.close();
        }, 5000);
      } else if (offerId) {
        sock.setTimeout(function () {
          acceptOffer(offerId, sellerToken);
          sock.setTimeout(function () {
            sock.close();
          }, 5000);
        }, MSG_DELAY_MS);
      } else {
        sock.setTimeout(function () {
          sock.close();
        }, 5000);
      }
    }
  });

  check(res, { "[BUYER] WS 101": (r) => r && r.status === 101 });
  check(null, { "[BUYER] Handshake OK": () => handshakeCompleted });
  if (!res || res.status !== 101) wsErrors.add(1);

  sleep(Math.random() * 2 + 1);
}

// ═══════════════════════════════════════════════════════════════
//
//  ██████╗ ██████╗  ██████╗ ██╗    ██╗███████╗███████╗
//  ██╔══██╗██╔══██╗██╔═══██╗██║    ██║██╔════╝██╔════╝
//  ██████╔╝██████╔╝██║   ██║██║ █╗ ██║███████╗█████╗
//  ██╔══██╗██╔══██╗██║   ██║██║███╗██║╚════██║██╔══╝
//  ██████╔╝██║  ██║╚██████╔╝╚███╔███╔╝███████║███████╗
//  ╚═════╝ ╚═╝  ╚═╝ ╚═════╝  ╚══╝╚══╝ ╚══════╝╚══════╝
//
//  20% — HTTP-only browsing simulation
//
// ═══════════════════════════════════════════════════════════════

export function browserFlow() {
  const vuId = exec.vu.idInInstance;
  const pairIdx = (vuId % NUM_PAIRS) + 1;
  const pair = getTestPair(pairIdx);
  const token = generateToken(pair.seller);
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  // Step 1: Categories
  const catRes = http.get(`${BASE_URL}/api/pos/category/GetCategories`, {
    headers,
    tags: { name: "browse-categories" },
  });
  browseCategoriesLatency.add(catRes.timings.duration);
  browseRequests.add(1);
  browseErrors.add(catRes.status !== 200 ? 1 : 0);
  check(catRes, { "[BROWSE] categories 200": (r) => r.status === 200 });

  thinkTime();

  // Step 2: Banners
  const bannerRes = http.get(`${BASE_URL}/api/pos/banners`, {
    headers,
    tags: { name: "browse-banners" },
  });
  browseRequests.add(1);
  browseErrors.add(bannerRes.status !== 200 ? 1 : 0);

  thinkTime();

  // Step 3: Browse items
  const itemsRes = http.get(
    `${BASE_URL}/api/pos/item?pageSize=20&pageNumber=1`,
    {
      headers,
      tags: { name: "browse-items" },
    },
  );
  browseItemsLatency.add(itemsRes.timings.duration);
  browseRequests.add(1);
  browseErrors.add(itemsRes.status !== 200 ? 1 : 0);
  check(itemsRes, { "[BROWSE] items list 200": (r) => r.status === 200 });

  thinkTime();

  // Step 4: View item detail
  const detailRes = http.get(`${BASE_URL}/api/pos/item/${pair.itemId}`, {
    headers,
    tags: { name: "view-item-detail" },
  });
  viewItemLatency.add(detailRes.timings.duration);
  browseRequests.add(1);
  browseErrors.add(detailRes.status !== 200 ? 1 : 0);
  check(detailRes, { "[BROWSE] item detail 200": (r) => r.status === 200 });

  thinkTime();

  // Step 5: Governorates
  const locRes = http.get(`${BASE_URL}/api/pos/location/GetGovs`, {
    headers,
    tags: { name: "browse-locations" },
  });
  browseRequests.add(1);
  browseErrors.add(locRes.status !== 200 ? 1 : 0);

  thinkTime();

  // Step 6: Search filters
  const filterRes = http.get(`${BASE_URL}/api/public/search/filters`, {
    headers,
    tags: { name: "browse-search-filters" },
  });
  browseRequests.add(1);
  browseErrors.add(filterRes.status !== 200 ? 1 : 0);

  thinkTime();

  // Step 7: Unread count
  const unreadRes = http.get(`${BASE_URL}/api/pos/messages/unread-count`, {
    headers,
    tags: { name: "browse-unread-count" },
  });
  browseRequests.add(1);
  browseErrors.add(unreadRes.status !== 200 ? 1 : 0);

  thinkTime();

  // Step 8: Profile
  const profileRes = http.get(`${BASE_URL}/api/pos/profile`, {
    headers,
    tags: { name: "browse-profile" },
  });
  browseRequests.add(1);
  browseErrors.add(profileRes.status !== 200 ? 1 : 0);

  thinkTime();
}

function thinkTime() {
  sleep(1 + Math.random() * 2); // 1-3 seconds
}

// ═══════════════════════════════════════════════════════════════
//
//  ██╗██████╗ ██╗     ███████╗
//  ██║██╔══██╗██║     ██╔════╝
//  ██║██║  ██║██║     █████╗
//  ██║██║  ██║██║     ██╔══╝
//  ██║██████╔╝███████╗███████╗
//  ╚═╝╚═════╝ ╚══════╝╚══════╝
//
//  5% — PresenceHub + Heartbeat (background app)
//
// ═══════════════════════════════════════════════════════════════

export function idleFlow() {
  const vuId = exec.vu.idInInstance;
  const pairIdx = (vuId % NUM_PAIRS) + 1;
  if (exec.vu.iterationInInstance > 0) wsReconnects.add(1);

  const pair = getTestPair(pairIdx);
  const token = generateToken(pair.seller);
  const wsUrl = buildWsUrl(HUBS.presence, token);

  const connectStart = Date.now();
  let handshakeCompleted = false;
  let handshakeStart = 0;
  let sessionStart = 0;

  const res = ws.connect(wsUrl, null, function (socket) {
    wsConnectingDuration.add(Date.now() - connectStart);

    socket.on("open", function () {
      handshakeStart = Date.now();
      socket.send(handshakeMessage());

      socket.setTimeout(function () {
        if (!handshakeCompleted) {
          handshakeFailures.add(1);
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
          idleConnections.add(1);

          socket.send(invocationMessage("Heartbeat", []));
          idleHeartbeats.add(1);

          socket.setInterval(function () {
            socket.send(invocationMessage("Heartbeat", []));
            idleHeartbeats.add(1);
          }, TIMING.heartbeatIntervalMs);

          socket.setInterval(function () {
            socket.send(pingMessage());
          }, TIMING.pingIntervalMs);

          socket.setTimeout(
            function () {
              const otherPair = getTestPair((vuId % 999) + 2);
              socket.send(
                invocationMessage("IsUserOnline", [otherPair.buyer.username]),
              );
            },
            10000 + Math.random() * 20000,
          );

          socket.setTimeout(function () {
            socket.close();
          }, 60000);
          continue;
        }

        if (!handshakeCompleted && isHandshakeError(msg)) {
          handshakeFailures.add(1);
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
        if (msg.type === MSG_TYPE.COMPLETION) continue;
        if (msg.type === MSG_TYPE.INVOCATION) continue;
      }
    });

    socket.on("error", function (e) {
      wsErrors.add(1);
    });

    socket.on("close", function () {
      if (sessionStart > 0) wsSessionDuration.add(Date.now() - sessionStart);
    });
  });

  check(res, { "[IDLE] WS 101": (r) => r && r.status === 101 });
  check(null, { "[IDLE] Handshake OK": () => handshakeCompleted });
  if (!res || res.status !== 101) wsErrors.add(1);

  sleep(Math.random() * 3 + 1);
}

// ═══════════════════════════════════════════════════════════════
// REST HELPERS — Offer lifecycle
// ═══════════════════════════════════════════════════════════════

function createOffer(token, itemId) {
  const amount = Math.floor(Math.random() * 9750) + 250;
  const payload = JSON.stringify({
    offerType: 1,
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
  offerCreationLatency.add(Date.now() - start);

  const created = check(res, {
    "offer created (200/201)": (r) => r.status === 200 || r.status === 201,
  });

  if (!created) {
    if (res.status === 400) {
      const body = res.body || "";
      if (
        body.indexOf("\u063A\u064A\u0631 \u0645\u062A\u0627\u062D") > -1 ||
        body.indexOf("not available") > -1 ||
        body.indexOf("InTransaction") > -1
      ) {
        offersFailed.add(1);
        return "item-locked";
      }
    }
    offersFailed.add(1);
    return null;
  }

  offersCreated.add(1);
  try {
    const body = res.json();
    return body.result?.offerId || body.result?.id || null;
  } catch (e) {
    return null;
  }
}

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
  offerAcceptLatency.add(Date.now() - start);

  const accepted = check(res, {
    "offer accepted (200)": (r) => r.status === 200,
  });

  if (!accepted) {
    offersFailed.add(1);
    return false;
  }
  offersAccepted.add(1);
  return true;
}

// ═══════════════════════════════════════════════════════════════
// REPORT
// ═══════════════════════════════════════════════════════════════

import { generateReport } from "../helpers/report.js";

export function handleSummary(data) {
  const sellerVUs = Math.round(maxTotal * MIX.sellers);
  const buyerVUs = Math.round(maxTotal * MIX.buyers);
  const browserVUs = Math.round(maxTotal * MIX.browsers);
  const idleVUs = Math.round(maxTotal * MIX.idle);

  return generateReport(data, {
    scenario: "realistic-load",
    stage,
    trafficMix: [
      {
        label: "Chat — Sellers",
        percentage: MIX.sellers * 100,
        vus: sellerVUs,
        color: "#22c55e",
      },
      {
        label: "Chat — Buyers",
        percentage: MIX.buyers * 100,
        vus: buyerVUs,
        color: "#3b82f6",
      },
      {
        label: "Browsing",
        percentage: MIX.browsers * 100,
        vus: browserVUs,
        color: "#f59e0b",
      },
      {
        label: "Idle",
        percentage: MIX.idle * 100,
        vus: idleVUs,
        color: "#64748b",
      },
    ],
  });
}
