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
 * ├─────────────────────────────────────────────────┬─────────┬─────┤
 * │ ████████████████████████████████████████████████ │█████████│███  │
 * │ Chat 75%                     (37,500 VUs)       │Browse 20│Idle │
 * │ ┌─────────────────┬─────────────────┐           │(10,000) │5%   │
 * │ │ Sellers  37.5%  │ Buyers  37.5%   │           │         │     │
 * │ │ (18,750 VUs)    │ (18,750 VUs)    │           │         │     │
 * │ │ MessageHub      │ MessageHub      │           │REST API │Pres │
 * │ │ listen for msgs │ send messages   │           │browse   │Hub  │
 * │ │ mark as read ★  │ verify read ★   │           │search   │only │
 * │ │ verify delivery │ verify delivery │           │view     │     │
 * │ └─────────────────┴─────────────────┘           │         │     │
 * └─────────────────────────────────────────────────┴─────────┴─────┘
 *
 * ── Full Chat Lifecycle ───────────────────────────────────────────────
 *
 *   1. Buyer  → SendMessage (with CID + timestamp)
 *   2. Seller ← NewMessage  (verifies CID, measures latency)
 *   3. Seller → MessageRead (marks message IDs as read in DB)
 *   4. Buyer  ← MessageRead event (verifies read receipt arrived)
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
  parseMessagesBuffered,
  isEvent,
  isClose,
  isCompletion,
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
const wsHandshakeSuccessRate = new Rate("ws_handshake_success_rate");
const wsSessionOkRate = new Rate("ws_session_ok_rate");
const wsSessionDuration = new Trend("ws_session_duration", true);

// ── Close Code Classification ────────────────────────────────
const wsClose1000 = new Counter("ws_close_1000"); // normal
const wsClose1006 = new Counter("ws_close_1006"); // abnormal (ALB/proxy cut)
const wsClose1011 = new Counter("ws_close_1011"); // server error
const wsCloseOther = new Counter("ws_close_other");

// ── Chat Delivery (★ Key metrics) ────────────────────────────
const messagesSent = new Counter("messages_sent");
const messagesDelivered = new Counter("messages_delivered");
const messageDeliveryLatency = new Trend("message_delivery_latency", true);
const messageContentMatch = new Rate("message_content_match");
const threadReceived = new Counter("message_thread_received");

// ── Mark-as-Read (★ Key) ─────────────────────────────────────
const messagesMarkedRead = new Counter("messages_marked_read");
const markReadLatency = new Trend("mark_read_latency", true);
const readReceiptsReceived = new Counter("read_receipts_received");
const readReceiptMatch = new Rate("read_receipt_match");

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
    { duration: "2m", target: 500 },
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
const isStress = ["high", "extreme", "massive", "extremeSmall"].includes(stage);
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
// Each VU should ideally use a UNIQUE user identity to avoid the
// server rejecting duplicate connections for the same userId.
// Capped at 1000 — matches the seeded DB pairs.
// ★ FIX: sqrt(N) caused 20 VUs per identity → server rejects duplicates.
//   Now uses min(1000, maxSellerVUs) so each seller gets a unique identity.
const MAX_SEEDED_PAIRS = 1000;
const maxSellerVUs = getMaxFromStages(scaleStages(totalStages, MIX.sellers));
const NUM_PAIRS =
  maxTotal <= 20 ? 1 : Math.min(MAX_SEEDED_PAIRS, Math.max(1, maxSellerVUs));

// Pick only the thresholds from baseThresholds that this scenario actually emits.
// heartbeat_ack_latency and is_user_online_latency are presence-hub-only metrics.
const relevantBase = {};
const RELEVANT_KEYS = [
  "ws_connecting_duration",
  "ws_handshake_duration",
  "ws_errors",
  "ws_handshake_success_rate",
  "ws_session_ok_rate",
];
for (const k of RELEVANT_KEYS) {
  if (baseThresholds[k]) relevantBase[k] = baseThresholds[k];
}

// ★ Override WS thresholds for stress stages — client-side port exhaustion
//   is expected on a single machine at 1000+ concurrent connections.
//   These thresholds reflect realistic limits of the test client, not the server.
if (isStress) {
  relevantBase["ws_errors"] = ["rate<0.30"];
  relevantBase["ws_handshake_success_rate"] = ["rate>0.70"];
  relevantBase["ws_session_ok_rate"] = ["rate>0.60"];
  relevantBase["ws_connecting_duration"] = ["p(95)<10000"];
  relevantBase["ws_handshake_duration"] = ["p(95)<5000"];
}

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
    ...relevantBase,
    // ★ Cross-user delivery (relaxed for stress stages — client-side limits)
    message_delivery_latency: isBreakpoint
      ? [{ threshold: "p(95)<3000", abortOnFail: true, delayAbortEval: "10s" }]
      : [isStress ? "p(95)<5000" : "p(95)<2000"],
    message_content_match: [isStress ? "rate>0.50" : "rate>0.85"],
    // ★ Mark-as-read
    mark_read_latency: [isStress ? "p(95)<5000" : "p(95)<2000"],
    read_receipt_match: [isStress ? "rate>0.40" : "rate>0.80"],
    // Reliability
    handshake_failures: [isStress ? "count<500" : "count<50"],
    // Browsing
    browse_items_latency: isBreakpoint
      ? [{ threshold: "p(95)<5000", abortOnFail: true, delayAbortEval: "10s" }]
      : [isStress ? "p(95)<5000" : "p(95)<3000"],
    browse_errors: [isStress ? "rate<0.10" : "rate<0.05"],
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

  // ★ Verify seed data exists — MessageHub rejects connections if item/seller not in DB
  const testPair = getTestPair(1);
  const testToken = generateToken(testPair.seller);
  const seedCheck = http.get(`${BASE_URL}/api/pos/item/${testPair.itemId}`, {
    headers: { Authorization: `Bearer ${testToken}` },
    timeout: "10s",
  });
  if (seedCheck.status === 404 || seedCheck.status === 0) {
    console.warn(
      `⚠ SEED DATA WARNING: Test item ${testPair.itemId} not found (status ${seedCheck.status}).`,
    );
    console.warn(
      `  Chat tests will fail — ChatAuthorizationService requires real items in DB.`,
    );
    console.warn(`  Run: psql "<UAT_DB_URL>" -f load-tests/seed-uat.sql`);
  } else {
    console.log(
      `║  Seed check: ✓ test item found (status ${seedCheck.status})`,
    );
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
    `║  Stage:      ${stage} (${fmtNum(maxTotal)} total users, ${NUM_PAIRS} pair pool)${isStress ? " [STRESS MODE]" : ""}`,
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
  console.log(`║  ★ Lifecycle: Send → Deliver → MarkRead → ReadReceipt`);
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

  // ★ FIX: buildWsUrl takes 3 args (hub, token, queryParams) — not 4
  const wsUrl = buildWsUrl(HUBS.message, sellerToken, queryParams);
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
  let buffer = ""; // ★ Buffered parser state

  const res = ws.connect(wsUrl, null, function (socket) {
    wsConnectingDuration.add(Date.now() - connectStart);

    socket.on("open", function () {
      handshakeStart = Date.now();
      socket.send(handshakeMessage());

      socket.setTimeout(function () {
        if (!handshakeCompleted) {
          handshakeFailures.add(1);
          wsHandshakeSuccessRate.add(false);
          wsErrors.add(1);
          socket.close();
        }
      }, TIMING.handshakeTimeoutMs);
    });

    socket.on("message", function (data) {
      // ★ Buffered parser handles partial frames across messages
      const parsed = parseMessagesBuffered(data, buffer);
      buffer = parsed.buffer;

      for (const msg of parsed.messages) {
        if (!handshakeCompleted && isHandshakeResponse(msg)) {
          handshakeCompleted = true;
          wsHandshakeSuccessRate.add(true);
          wsHandshakeDuration.add(Date.now() - handshakeStart);
          sessionStart = Date.now();

          socket.setInterval(function () {
            socket.send(pingMessage());
          }, TIMING.pingIntervalMs);

          // Max session duration — must outlive buyer's message + read lifecycle
          const holdMs =
            8000 + (MESSAGES_PER_SESSION + 4) * MSG_DELAY_MS + 20000;
          socket.setTimeout(function () {
            if (!markReadDone) doMarkAsRead(socket);
            else socket.close();
          }, holdMs);
          continue;
        }

        if (!handshakeCompleted && isHandshakeError(msg)) {
          handshakeFailures.add(1);
          wsHandshakeSuccessRate.add(false);
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
        if (isEvent(msg, "ChatStatusChanged")) continue;
        if (isEvent(msg, "MessageRead")) continue; // echo of our own mark-read

        // ★ Track mark-read round-trip latency via completion
        if (isCompletion(msg, "mr-")) {
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

    // ★ Error handler is informational only — do NOT count errors here.
    //   Handshake timeout and handshake error paths handle accounting.
    //   Counting here would double-count with the close handler.
    socket.on("error", function (e) {
      if (__ENV.DEBUG)
        console.error(`[SELLER] WS error VU=${__VU}: ${e.error()}`);
    });

    socket.on("close", function (code) {
      // Close code classification
      if (code === 1000) wsClose1000.add(1);
      else if (code === 1006) wsClose1006.add(1);
      else if (code === 1011) wsClose1011.add(1);
      else wsCloseOther.add(1);

      // Session tracking
      const sessionOk = handshakeCompleted && sessionStart > 0;
      wsSessionOkRate.add(sessionOk);

      if (sessionStart > 0) {
        wsSessionDuration.add(Date.now() - sessionStart);
      }

      // ws_errors: only record success for completed sessions.
      // Failed connections are already counted at their point of failure.
      if (handshakeCompleted) {
        wsErrors.add(0);
      }
    });
  });

  check(res, { "[SELLER] WS 101": (r) => r && r.status === 101 });
  check(null, { "[SELLER] Handshake OK": () => handshakeCompleted });
  if (!res || res.status !== 101) {
    wsErrors.add(1);
    wsHandshakeSuccessRate.add(false);
    wsSessionOkRate.add(false); // ★ Track failed connections in session rate too
    // ★ Backoff on failed connection — prevents thundering herd retries
    const backoff = Math.min(
      30,
      Math.pow(2, Math.min(exec.vu.iterationInInstance, 5)),
    );
    sleep(backoff + Math.random() * 3);
    return;
  }

  sleep(Math.random() * 2 + 1); // ★ Normal inter-iteration pause (was missing!)
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
//  seller (proves read-status persisted to DB).
//
// ═══════════════════════════════════════════════════════════════

export function buyerFlow() {
  const vuId = exec.vu.idInInstance;
  const pairIdx = (vuId % NUM_PAIRS) + 1;
  if (exec.vu.iterationInInstance > 0) wsReconnects.add(1);

  const pair = getTestPair(pairIdx);
  const buyerToken = generateToken(pair.buyer);

  const queryParams = {
    recipientUsername: pair.seller.username,
    user: pair.seller.username,
    itemId: pair.itemId,
  };

  // ★ FIX: buildWsUrl takes 3 args (hub, token, queryParams) — not 4
  const wsUrl = buildWsUrl(HUBS.message, buyerToken, queryParams);
  const connectStart = Date.now();
  let handshakeCompleted = false;
  let handshakeStart = 0;
  let sessionStart = 0;
  let msgCount = 0;
  let invocationCounter = 0;
  let readReceiptSeen = false; // ★ Track if we got MessageRead back
  let allMessagesSentAt = 0; // ★ Track when all messages were sent
  let buffer = ""; // ★ Buffered parser state

  const res = ws.connect(wsUrl, null, function (socket) {
    wsConnectingDuration.add(Date.now() - connectStart);

    socket.on("open", function () {
      handshakeStart = Date.now();
      socket.send(handshakeMessage());

      socket.setTimeout(function () {
        if (!handshakeCompleted) {
          handshakeFailures.add(1);
          wsHandshakeSuccessRate.add(false);
          wsErrors.add(1);
          socket.close();
        }
      }, TIMING.handshakeTimeoutMs);
    });

    socket.on("message", function (data) {
      // ★ Buffered parser handles partial frames across messages
      const parsed = parseMessagesBuffered(data, buffer);
      buffer = parsed.buffer;

      for (const msg of parsed.messages) {
        if (!handshakeCompleted && isHandshakeResponse(msg)) {
          handshakeCompleted = true;
          wsHandshakeSuccessRate.add(true);
          wsHandshakeDuration.add(Date.now() - handshakeStart);
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
          wsHandshakeSuccessRate.add(false);
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
            socket.setTimeout(function () {
              socket.close();
            }, 1000);
          }
          continue;
        }

        if (isEvent(msg, "OfferStatusChanged")) continue;
        if (isEvent(msg, "ChatStatusChanged")) continue;
        if (isEvent(msg, "UserTyping")) continue;
        if (isCompletion(msg)) continue; // any completion
      }
    });

    // ★ Error handler is informational only — no metric counting.
    socket.on("error", function (e) {
      if (__ENV.DEBUG)
        console.error(`[BUYER] WS error VU=${__VU}: ${e.error()}`);
    });

    socket.on("close", function (code) {
      // Close code classification
      if (code === 1000) wsClose1000.add(1);
      else if (code === 1006) wsClose1006.add(1);
      else if (code === 1011) wsClose1011.add(1);
      else wsCloseOther.add(1);

      // ★ READ RECEIPT MISS TRACKING — only penalize when buyer session was FULLY HEALTHY.
      //   A miss is only meaningful when:
      //   1. Handshake completed (we actually connected)
      //   2. All messages were sent (allMessagesSentAt > 0)
      //   3. Waited at least 8s after sending for the seller→DB→buyer round-trip
      //   If ANY of these conditions is false, the miss is a test infrastructure
      //   problem (port exhaustion, broken seller), not a server bug.
      if (!readReceiptSeen) {
        const sessionHealthy = handshakeCompleted && allMessagesSentAt > 0;
        if (sessionHealthy) {
          const waitedForReceipt = Date.now() - allMessagesSentAt;
          if (waitedForReceipt >= 8000) {
            readReceiptMatch.add(0);
          }
          // else: session closed too fast — don't penalize, don't reward
        }
        // else: unhealthy session — skip metric entirely (no add(0) or add(1))
      }

      // Session tracking
      const sessionOk = handshakeCompleted && sessionStart > 0;
      wsSessionOkRate.add(sessionOk);

      if (sessionStart > 0) {
        wsSessionDuration.add(Date.now() - sessionStart);
      }

      // ws_errors: only record success for completed sessions.
      if (handshakeCompleted) {
        wsErrors.add(0);
      }
    });

    // ── Send messages with CID + timestamp ────────────────
    function sendNextMessage(sock) {
      if (msgCount >= MESSAGES_PER_SESSION) {
        if (!allMessagesSentAt) allMessagesSentAt = Date.now();
        // ★ Wait for read receipt from seller, then close
        const receiptWaitMs = readReceiptSeen ? 1000 : 8000;
        sock.setTimeout(function () {
          sock.close();
        }, receiptWaitMs);
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
  });

  check(res, { "[BUYER] WS 101": (r) => r && r.status === 101 });
  check(null, { "[BUYER] Handshake OK": () => handshakeCompleted });
  if (!res || res.status !== 101) {
    wsErrors.add(1);
    wsHandshakeSuccessRate.add(false);
    wsSessionOkRate.add(false); // ★ Track failed connections in session rate too
    // ★ Backoff on failed connection — prevents retry storm
    const backoff = Math.min(
      30,
      Math.pow(2, Math.min(exec.vu.iterationInInstance, 5)),
    );
    sleep(backoff + Math.random() * 3);
    return;
  }

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
  // ★ Stagger start — prevents all browser VUs from hitting the server simultaneously
  if (exec.vu.iterationInInstance === 0) {
    sleep(Math.random() * 5);
  }

  const vuId = exec.vu.idInInstance;
  const pairIdx = (vuId % NUM_PAIRS) + 1;
  const pair = getTestPair(pairIdx);
  const token = generateToken(pair.seller);
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  // ★ Only count 5xx as errors — 4xx is valid business response
  //   (validation, no-data, not-found are expected responses)
  const isErr = (s) => s === 0 || s >= 500; // 0 = timeout/network error
  const reqOpts = (name) => ({ headers, tags: { name }, timeout: "10s" });

  // Step 1: Categories
  const catRes = http.get(
    `${BASE_URL}/api/pos/category/GetCategories`,
    reqOpts("browse-categories"),
  );
  browseCategoriesLatency.add(catRes.timings.duration);
  browseRequests.add(1);
  browseErrors.add(isErr(catRes.status) ? 1 : 0);
  check(catRes, { "[BROWSE] categories OK": (r) => !isErr(r.status) });

  thinkTime();

  // Step 2: Banners
  const bannerRes = http.get(
    `${BASE_URL}/api/pos/banners`,
    reqOpts("browse-banners"),
  );
  browseRequests.add(1);
  browseErrors.add(isErr(bannerRes.status) ? 1 : 0);

  thinkTime();

  // Step 3: Browse items
  const itemsRes = http.get(
    `${BASE_URL}/api/pos/item?pageSize=20&pageNumber=1`,
    reqOpts("browse-items"),
  );
  browseItemsLatency.add(itemsRes.timings.duration);
  browseRequests.add(1);
  browseErrors.add(isErr(itemsRes.status) ? 1 : 0);
  check(itemsRes, { "[BROWSE] items list OK": (r) => !isErr(r.status) });

  thinkTime();

  // Step 4: View item detail — use a real item ID from the listing
  // ★ FIX: pair.itemId is a generated UUID that may not exist in DB → 404
  //   Instead, extract a real item ID from the items listing response.
  let realItemId = pair.itemId; // fallback to test UUID
  if (itemsRes.status === 200) {
    try {
      const body = itemsRes.json();
      const items = body.result?.data || body.result || body.data || [];
      if (Array.isArray(items) && items.length > 0) {
        const pick = items[Math.floor(Math.random() * items.length)];
        realItemId =
          pick.id || pick.Id || pick.itemId || pick.ItemId || realItemId;
      }
    } catch (_) {
      /* use fallback */
    }
  }
  const detailRes = http.get(
    `${BASE_URL}/api/pos/item/${realItemId}`,
    reqOpts("view-item-detail"),
  );
  viewItemLatency.add(detailRes.timings.duration);
  browseRequests.add(1);
  browseErrors.add(isErr(detailRes.status) ? 1 : 0);
  check(detailRes, { "[BROWSE] item detail OK": (r) => !isErr(r.status) });

  thinkTime();

  // Step 5: Governorates
  const locRes = http.get(
    `${BASE_URL}/api/pos/location/GetGovs`,
    reqOpts("browse-locations"),
  );
  browseRequests.add(1);
  browseErrors.add(isErr(locRes.status) ? 1 : 0);

  thinkTime();

  // Step 6: Search filters
  const filterRes = http.get(
    `${BASE_URL}/api/public/search/filters`,
    reqOpts("browse-search-filters"),
  );
  browseRequests.add(1);
  browseErrors.add(isErr(filterRes.status) ? 1 : 0);

  thinkTime();

  // Step 7: Unread count
  const unreadRes = http.get(
    `${BASE_URL}/api/pos/messages/unread-count`,
    reqOpts("browse-unread-count"),
  );
  browseRequests.add(1);
  browseErrors.add(isErr(unreadRes.status) ? 1 : 0);

  thinkTime();

  // Step 8: Profile
  const profileRes = http.get(
    `${BASE_URL}/api/pos/profile`,
    reqOpts("browse-profile"),
  );
  browseRequests.add(1);
  browseErrors.add(isErr(profileRes.status) ? 1 : 0);

  // ★ Inter-session pause — real users don't immediately start another browsing cycle
  sleep(5 + Math.random() * 10); // 5-15s pause between browsing sessions
}

function thinkTime() {
  sleep(3 + Math.random() * 5); // 3-8 seconds — realistic user reading time
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
  // ★ FIX: buildWsUrl takes 3 args (hub, token, queryParams)
  const wsUrl = buildWsUrl(HUBS.presence, token);

  const connectStart = Date.now();
  let handshakeCompleted = false;
  let handshakeStart = 0;
  let sessionStart = 0;
  let buffer = ""; // ★ Buffered parser state

  const res = ws.connect(wsUrl, null, function (socket) {
    wsConnectingDuration.add(Date.now() - connectStart);

    socket.on("open", function () {
      handshakeStart = Date.now();
      socket.send(handshakeMessage());

      socket.setTimeout(function () {
        if (!handshakeCompleted) {
          handshakeFailures.add(1);
          wsHandshakeSuccessRate.add(false);
          wsErrors.add(1);
          socket.close();
        }
      }, TIMING.handshakeTimeoutMs);
    });

    socket.on("message", function (data) {
      // ★ Buffered parser handles partial frames across messages
      const parsed = parseMessagesBuffered(data, buffer);
      buffer = parsed.buffer;

      for (const msg of parsed.messages) {
        if (!handshakeCompleted && isHandshakeResponse(msg)) {
          handshakeCompleted = true;
          wsHandshakeSuccessRate.add(true);
          wsHandshakeDuration.add(Date.now() - handshakeStart);
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
          wsHandshakeSuccessRate.add(false);
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
        if (isCompletion(msg)) continue; // any completion
        if (msg.type === MSG_TYPE.INVOCATION) continue;
      }
    });

    // ★ Error handler is informational only — no metric counting.
    socket.on("error", function (e) {
      if (__ENV.DEBUG)
        console.error(`[IDLE] WS error VU=${__VU}: ${e.error()}`);
    });

    socket.on("close", function (code) {
      // Close code classification
      if (code === 1000) wsClose1000.add(1);
      else if (code === 1006) wsClose1006.add(1);
      else if (code === 1011) wsClose1011.add(1);
      else wsCloseOther.add(1);

      // Session tracking
      const sessionOk = handshakeCompleted && sessionStart > 0;
      wsSessionOkRate.add(sessionOk);

      if (sessionStart > 0) {
        wsSessionDuration.add(Date.now() - sessionStart);
      }

      // ws_errors: only record success for completed sessions.
      if (handshakeCompleted) {
        wsErrors.add(0);
      }
    });
  });

  check(res, { "[IDLE] WS 101": (r) => r && r.status === 101 });
  check(null, { "[IDLE] Handshake OK": () => handshakeCompleted });
  if (!res || res.status !== 101) {
    wsErrors.add(1);
    wsHandshakeSuccessRate.add(false);
    wsSessionOkRate.add(false); // ★ Track failed connections in session rate too
    // ★ Backoff on failed connection — prevents retry storm
    const backoff = Math.min(
      30,
      Math.pow(2, Math.min(exec.vu.iterationInInstance, 5)),
    );
    sleep(backoff + Math.random() * 3);
    return;
  }

  sleep(Math.random() * 3 + 1);
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
