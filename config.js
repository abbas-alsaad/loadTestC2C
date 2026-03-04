/**
 * k6 Load Test Configuration
 * Target: C2C Backend (UAT)
 *
 * Usage:
 *   k6 run --env TARGET_URL=https://c2c-uat.gini.iq scenarios/presence-hub.js
 *   k6 run --env TARGET_URL=https://c2c-uat.gini.iq --env STAGE=medium scenarios/presence-hub.js
 */

// ─── Environment ──────────────────────────────────────────────
export const BASE_URL = __ENV.TARGET_URL || "https://c2c-api.gini.iq";

// SignalR URL — CloudFront VPC Origins don't support WebSocket,
// so ALL SignalR traffic (negotiate + WS) goes directly to the ALB.
// Both negotiate and WS must hit the same backend so the connection
// token created by negotiate is valid for the WS upgrade.
const signalrBase = __ENV.WS_URL || BASE_URL;
export const SIGNALR_HTTP_URL = signalrBase
  .replace("wss://", "https://")
  .replace("ws://", "http://");
export const WS_URL = signalrBase
  .replace("https://", "wss://")
  .replace("http://", "ws://");

// Use /health/live for local (avoids Redis timeout), /health for UAT
export const HEALTH_URL = __ENV.HEALTH_URL || `${BASE_URL}/health/live`;

// ─── JWT Parameters (QiServiceScheme) ─────────────────────────
export const JWT_CONFIG = {
  secret:
    __ENV.JWT_SECRET ||
    "9vc62Jwz36OF8Ax2eSjRJ5wqcFQko59Hn8UgpCnjMuSYQo7kCJMO4ZK0AixDAGO1SsmaSW",
  issuer: "qi-services",
  audience: "F0E62818-F5CE-4844-B01D-5F1A9F105967",
  expiresInSeconds: 3600,
};

// ─── SignalR Hubs ─────────────────────────────────────────────
export const HUBS = {
  presence: "/hubs/presence",
  message: "/hubs/message",
};
// ─── Timing ───────────────────────────────────────────────────
export const TIMING = {
  heartbeatIntervalMs: 45000, // Call Heartbeat() every 45s (Redis TTL is 120s)
  pingIntervalMs: 15000, // SignalR keep-alive ping every 15s
  holdDurationMs: 60000, // How long each VU holds the connection
  messageDelayMs: 2000, // Delay between chat messages
  handshakeTimeoutMs: 10000, // Max wait for SignalR handshake response
};

// ─── Progressive Ramp Stages (AWS Cloud Target) ──────────────
// Each stage defines a VU ramp pattern for production-grade infrastructure.
// Use "breakpoint" to find the exact failure point (slow continuous ramp).
export const STAGES = {
  smoke: [
    { duration: "30s", target: 10 },
    { duration: "1m", target: 10 },
    { duration: "15s", target: 0 },
  ],
  low: [
    { duration: "1m", target: 50 },
    { duration: "3m", target: 50 },
    { duration: "30s", target: 0 },
  ],
  medium: [
    { duration: "1m", target: 200 },
    { duration: "3m", target: 500 },
    { duration: "3m", target: 500 },
    { duration: "1m", target: 0 },
  ],
  high: [
    { duration: "1m", target: 500 },
    { duration: "2m", target: 2000 },
    { duration: "5m", target: 2000 },
    { duration: "2m", target: 0 },
  ],
  // Breakpoint test: slow continuous ramp 0 → 5000 over ~20 minutes.
  // abortOnFail thresholds will auto-stop at the exact breaking point.
  // The HTML report will show the peak VUs reached before failure.
  breakpoint: [
    { duration: "1m", target: 100 },
    { duration: "2m", target: 500 },
    { duration: "3m", target: 1000 },
    { duration: "3m", target: 2000 },
    { duration: "3m", target: 4000 },
    { duration: "3m", target: 6000 },
    { duration: "3m", target: 8000 },
    { duration: "3m", target: 10000 },
    { duration: "3m", target: 13000 },
    { duration: "3m", target: 16000 },
    { duration: "3m", target: 20000 },
    { duration: "1m", target: 0 },
  ],
  extreme: [
    { duration: "2m", target: 1000 },
    { duration: "3m", target: 5000 },
    { duration: "5m", target: 10000 },
    { duration: "5m", target: 10000 },
    { duration: "3m", target: 0 },
  ],
};

// ─── Message Types (matches server MessageTypeEnum) ──────────
export const MessageType = {
  Text: 1,
  Offer: 2,
  System: 3,
};

// ─── Thresholds ───────────────────────────────────────────────
// Base thresholds used by all scenarios. Scenario-specific thresholds
// (e.g. notification_delivery_latency) are added in individual scenario files.
export const THRESHOLDS = {
  ws_connecting_duration: ["p(95)<2000"],
  ws_handshake_duration: ["p(95)<1000"],
  ws_errors: ["rate<0.01"],
  http_req_duration: ["p(95)<3000"],
  http_req_failed: ["rate<0.05"],
};

// Breakpoint thresholds: same limits but abortOnFail stops the test
// the moment a threshold is breached, so you know the exact VU count.
export const BREAKPOINT_THRESHOLDS = {
  ws_connecting_duration: [
    { threshold: "p(95)<5000", abortOnFail: true, delayAbortEval: "10s" },
  ],
  ws_handshake_duration: [
    { threshold: "p(95)<3000", abortOnFail: true, delayAbortEval: "10s" },
  ],
  ws_errors: [
    { threshold: "rate<0.05", abortOnFail: true, delayAbortEval: "10s" },
  ],
  http_req_duration: [
    { threshold: "p(95)<5000", abortOnFail: true, delayAbortEval: "10s" },
  ],
  http_req_failed: [
    { threshold: "rate<0.10", abortOnFail: true, delayAbortEval: "10s" },
  ],
};

// ─── Helpers ──────────────────────────────────────────────────

/**
 * Derive MAX_VUS from the selected stage definition.
 * Returns the highest `target` value found across all ramp steps.
 *
 * @param {string} [stageName] - Stage key (default: from __ENV.STAGE or "smoke")
 * @returns {number}
 */
export function getMaxVUs(stageName) {
  const name = stageName || __ENV.STAGE || "smoke";
  const steps = STAGES[name] || STAGES.smoke;
  let max = 0;
  for (const s of steps) {
    if (s.target > max) max = s.target;
  }
  return max || 10; // fallback to 10 if all targets are 0
}
