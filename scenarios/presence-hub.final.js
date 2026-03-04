/**
 * FINAL: Presence Hub Load Test (NO NEGOTIATE) — Real infra validation
 *
 * Purpose:
 * 1) Validate SignalR stability under load (WS open + handshake + long hold)
 * 2) Validate Hub behavior under load (Heartbeat + IsUserOnline completions/latency)
 * 3) Validate DevOps config robustness:
 *    - ALB idle timeout
 *    - pod scaling (HPA) while connections exist
 *    - draining behavior (terminationGracePeriod + preStop)
 *
 * KEY: This test PROVES the hub is actually processing calls (Completion ACKs),
 * not just keeping sockets open.
 *
 * Usage:
 *  k6 run \
 *    --env TARGET_URL=https://c2c-api-uat.gini.iq \
 *    --env WS_URL=https://ws-c2c-api-uat.gini.iq \
 *    --env STAGE=production \
 *    scenarios/presence-hub.final.js
 *
 * Optional tuning:
 *  --env HEARTBEAT_ACK_EVERY=6
 *  --env HOLD_DURATION_MS=600000
 *  --env HANDSHAKE_TIMEOUT_MS=10000
 */

import ws from "k6/ws";
import http from "k6/http";
import { check, sleep } from "k6";
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
  parseMessagesBuffered,
  isHandshakeResponse,
  isHandshakeError,
  isClose,
  isCompletion,
  MSG_TYPE,
} from "../helpers/signalr.js";

// ─── Metrics ──────────────────────────────────────────────────────────────
const wsConnectingDuration = new Trend("ws_connecting_duration", true);
const wsHandshakeDuration = new Trend("ws_handshake_duration", true);
const wsSessionDuration = new Trend("ws_session_duration", true);

const wsErrors = new Rate("ws_errors");

// Rates that explicitly validate correctness
const wsHandshakeSuccessRate = new Rate("ws_handshake_success_rate");
const wsSessionOkRate = new Rate("ws_session_ok_rate");

const wsConnectionsOpened = new Counter("ws_connections_opened");
const wsConnectionsClosed = new Counter("ws_connections_closed");

// Close codes (helps detect ALB/proxy/server issues)
const wsClose1000 = new Counter("ws_close_1000");
const wsClose1006 = new Counter("ws_close_1006");
const wsClose1011 = new Counter("ws_close_1011");
const wsCloseOther = new Counter("ws_close_other");

const heartbeatsSent = new Counter("heartbeats_sent");
const heartbeatAcks = new Counter("heartbeat_acks");
const heartbeatAckLatency = new Trend("heartbeat_ack_latency", true);

const isUserOnlineChecks = new Counter("is_user_online_checks");
const isUserOnlineLatency = new Trend("is_user_online_latency", true);

// ─── Options ─────────────────────────────────────────────────────────────
const stage = __ENV.STAGE || "smoke";
const isBreakpoint = stage === "breakpoint";

// Compute total stage duration so holdDuration can auto-cap
function getStageDurationMs(stageName) {
  const steps = STAGES[stageName] || STAGES.smoke;
  let totalMs = 0;
  for (const s of steps) {
    const d = s.duration || "0s";
    const match = d.match(/^(\d+(?:\.\d+)?)(s|m|h)$/);
    if (match) {
      const val = parseFloat(match[1]);
      const unit = match[2];
      if (unit === "s") totalMs += val * 1000;
      else if (unit === "m") totalMs += val * 60000;
      else if (unit === "h") totalMs += val * 3600000;
    }
  }
  return totalMs;
}

const stageTotalMs = getStageDurationMs(stage);
// For breakpoint: VUs hold for the ENTIRE test so concurrent connections = VU count.
//   This finds the max concurrent connections ceiling, not max connection rate.
// For normal stages: hold = min(configured hold, 70% of stage total) so VUs can finish.
const effectiveHoldMs = isBreakpoint
  ? stageTotalMs
  : Math.min(TIMING.holdDurationMs, Math.floor(stageTotalMs * 0.7));

export const options = {
  stages: STAGES[stage] || STAGES.smoke,
  thresholds: isBreakpoint ? BREAKPOINT_THRESHOLDS : THRESHOLDS,
  tags: { scenario: "presence-hub-final", stage },
};

// ─── Setup ───────────────────────────────────────────────────────────────
export function setup() {
  const res = http.get(HEALTH_URL, { timeout: "10s" });
  const ok = check(res, { "health 200": (r) => r.status === 200 });
  if (!ok)
    throw new Error(`Health check failed ${res.status} at ${HEALTH_URL}`);
  console.log(`Health OK: ${HEALTH_URL}`);
  console.log(
    `Stage: ${stage} | Total: ${(stageTotalMs / 1000).toFixed(0)}s | Hold: ${(effectiveHoldMs / 1000).toFixed(0)}s (configured: ${(TIMING.holdDurationMs / 1000).toFixed(0)}s)`,
  );
}

// ─── VU ─────────────────────────────────────────────────────────────────
export default function () {
  const { token } = generateVuIdentity(__VU, __ITER);

  // IMPORTANT: WS_URL should be the WS ALB host
  const wsUrl = buildWsUrl(HUBS.presence, token);

  const connectStart = Date.now();
  let handshakeCompleted = false;
  let handshakeStart = 0;
  let sessionStart = 0;

  let buffer = "";

  const pendingIuo = {}; // invId -> sentAt
  const pendingHb = {}; // invId -> sentAt
  let hbCounter = 0;

  const HEARTBEAT_ACK_EVERY = parseInt(__ENV.HEARTBEAT_ACK_EVERY || "6", 10);
  const sessionTargetMs = effectiveHoldMs;

  const res = ws.connect(wsUrl, null, function (socket) {
    wsConnectionsOpened.add(1);
    wsConnectingDuration.add(Date.now() - connectStart);

    socket.on("open", function () {
      handshakeStart = Date.now();
      socket.send(handshakeMessage());

      socket.setTimeout(function () {
        if (!handshakeCompleted) {
          wsHandshakeSuccessRate.add(false);
          wsErrors.add(1);
          socket.close();
        }
      }, TIMING.handshakeTimeoutMs);
    });

    socket.on("message", function (data) {
      const parsed = parseMessagesBuffered(data, buffer);
      buffer = parsed.buffer;

      for (const msg of parsed.messages) {
        // handshake success
        if (!handshakeCompleted && isHandshakeResponse(msg)) {
          handshakeCompleted = true;
          wsHandshakeSuccessRate.add(true);
          wsHandshakeDuration.add(Date.now() - handshakeStart);
          sessionStart = Date.now();

          // Heartbeat loop (presence semantics) with ACK proof every N
          socket.setInterval(function () {
            hbCounter += 1;
            heartbeatsSent.add(1);

            if (hbCounter % HEARTBEAT_ACK_EVERY === 0) {
              const invId = `hb-${__VU}-${__ITER}-${Date.now()}-${hbCounter}`;
              pendingHb[invId] = Date.now();
              socket.send(invocationMessage("Heartbeat", [], invId));
            } else {
              socket.send(invocationMessage("Heartbeat", []));
            }
          }, TIMING.heartbeatIntervalMs);

          // IsUserOnline checks
          socket.setInterval(function () {
            const maxVu = getMaxVUs(stage);
            const targetUser = `loadtest-user-${Math.floor(Math.random() * maxVu) + 1}-0`;
            const invId = `iuo-${__VU}-${__ITER}-${Date.now()}`;
            pendingIuo[invId] = Date.now();
            socket.send(invocationMessage("IsUserOnline", [targetUser], invId));
            isUserOnlineChecks.add(1);
          }, TIMING.isUserOnlineEveryMs);

          // Close after hold (with jitter to avoid herds)
          socket.setTimeout(
            function () {
              socket.close();
            },
            sessionTargetMs + Math.floor(Math.random() * TIMING.closeJitterMs),
          );

          continue;
        }

        // handshake error
        if (!handshakeCompleted && isHandshakeError(msg)) {
          wsHandshakeSuccessRate.add(false);
          wsErrors.add(1);
          socket.close();
          return;
        }

        // ignore server ping
        if (msg && msg.type === MSG_TYPE.PING) continue;

        // server close
        if (isClose(msg)) {
          if (msg.error) wsErrors.add(1);
          socket.close();
          return;
        }

        // completions: IsUserOnline
        if (isCompletion(msg, "iuo-")) {
          const sentAt = pendingIuo[msg.invocationId];
          if (sentAt) {
            isUserOnlineLatency.add(Date.now() - sentAt);
            delete pendingIuo[msg.invocationId];
          }
          continue;
        }

        // completions: Heartbeat ACK proof
        if (isCompletion(msg, "hb-")) {
          const sentAt = pendingHb[msg.invocationId];
          if (sentAt) {
            heartbeatAckLatency.add(Date.now() - sentAt);
            heartbeatAcks.add(1);
            delete pendingHb[msg.invocationId];
          }
          continue;
        }
      }
    });

    socket.on("error", function (e) {
      // Do NOT count errors here — the close handler or timeout callback
      // already handles accounting. Counting here would double-count.
      if (__ENV.DEBUG) console.error(`WS error VU=${__VU}: ${e.error()}`);
    });

    socket.on("close", function (code) {
      wsConnectionsClosed.add(1);

      // classify close codes (helps diagnose LB/proxy/server)
      if (code === 1000) wsClose1000.add(1);
      else if (code === 1006) wsClose1006.add(1);
      else if (code === 1011) wsClose1011.add(1);
      else wsCloseOther.add(1);

      // session OK means:
      // - handshake completed
      // - session stayed alive for at least 90% of hold duration
      let sessionOk = false;
      if (handshakeCompleted && sessionStart > 0) {
        const dur = Date.now() - sessionStart;
        wsSessionDuration.add(dur);
        sessionOk = dur >= sessionTargetMs * 0.9;
      }
      wsSessionOkRate.add(sessionOk);

      // ws_errors: ONLY record in close handler for successful sessions.
      // Failed connections are already counted at their point of failure
      // (timeout callback, error handler, handshake error message handler).
      // Do NOT add(1) here — that double-counts failed connections.
      if (handshakeCompleted) {
        wsErrors.add(0);
      }

      if (__ENV.DEBUG && __VU <= 2) {
        console.log(`VU ${__VU} closed code=${code} session=${sessionOk}`);
      }
    });
  });

  check(res, { "WS 101": (r) => r && r.status === 101 });
  if (!res || res.status !== 101) {
    wsErrors.add(1);
    // Connection never upgraded — also counts as handshake failure
    wsHandshakeSuccessRate.add(false);
  } else {
    wsErrors.add(0);
  }

  sleep(Math.random() * 2 + 1);
}

// ─── Report ──────────────────────────────────────────────────────────────
import { generateReport } from "../helpers/report.js";
export function handleSummary(data) {
  return generateReport(data, { scenario: "presence-hub-final", stage });
}
