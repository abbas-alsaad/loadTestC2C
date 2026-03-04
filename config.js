/**
 * Load Test Config (NO NEGOTIATE)
 *
 * IMPORTANT:
 * - TARGET_URL should be your API ALB domain (health endpoints)
 * - WS_URL should be your WebSocket ALB domain (SignalR hubs)
 */

// ─── Environment ──────────────────────────────────────────────
export const BASE_URL = __ENV.TARGET_URL || "https://c2c-api-uat.gini.iq";

const wsBase = __ENV.WS_URL || BASE_URL;
export const WS_URL = wsBase
  .replace("https://", "wss://")
  .replace("http://", "ws://");

export const HEALTH_URL = __ENV.HEALTH_URL || `${BASE_URL}/health`;

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
  handshakeTimeoutMs: parseInt(__ENV.HANDSHAKE_TIMEOUT_MS || "10000", 10),

  // Business presence load
  heartbeatIntervalMs: parseInt(__ENV.HEARTBEAT_INTERVAL_MS || "45000", 10),

  // Session durations (default 10 minutes — realistic mobile session)
  holdDurationMs: parseInt(__ENV.HOLD_DURATION_MS || "600000", 10),

  // Queries
  isUserOnlineEveryMs: parseInt(__ENV.IS_USER_ONLINE_EVERY_MS || "10000", 10),

  // Close grace jitter (not pod termination)
  closeJitterMs: parseInt(__ENV.CLOSE_JITTER_MS || "2000", 10),

  // Legacy (used by other scenarios)
  pingIntervalMs: 15000,
  messageDelayMs: 2000,
};

// ─── Stages ───────────────────────────────────────────────────
// Tuned to validate:
// - WebSocket stability (hold)
// - HPA scaling (ramp)
// - ALB idle timeout + draining (long hold)
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
    { duration: "5m", target: 500 }, // HOLD long enough to see disconnect patterns
    { duration: "1m", target: 0 },
  ],
  // Production target for Iraqi C2C marketplace:
  // Validates 500 → 1000 concurrent WS with zero errors.
  // Long holds validate ALB idle timeout + pod drain.
  production: [
    { duration: "1m", target: 100 }, // warm-up
    { duration: "2m", target: 500 }, // ramp to 500
    { duration: "10m", target: 500 }, // long hold — validates ingress idle/drain
    { duration: "2m", target: 1000 }, // ramp to 1000
    { duration: "10m", target: 1000 }, // long hold — validates at peak
    { duration: "1m", target: 0 }, // cool-down
  ],
  high: [
    { duration: "1m", target: 500 },
    { duration: "2m", target: 2000 },
    { duration: "5m", target: 2000 },
    { duration: "2m", target: 0 },
  ],
  // Breakpoint: slower ramp gives HPA time to scale.
  // abortOnFail auto-stops at the exact breaking point.
  breakpoint: [
    { duration: "2m", target: 100 },
    { duration: "2m", target: 500 },
    { duration: "2m", target: 1000 },
    { duration: "3m", target: 2000 },
    { duration: "3m", target: 3000 },
    { duration: "3m", target: 4000 },
    { duration: "3m", target: 5000 },
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
export const THRESHOLDS = {
  ws_connecting_duration: ["p(95)<2500"],
  ws_handshake_duration: ["p(95)<1500"],
  ws_errors: ["rate<0.01"],

  ws_handshake_success_rate: ["rate>0.99"],
  ws_session_ok_rate: ["rate>0.98"],

  heartbeat_ack_latency: ["p(95)<1500"],
  is_user_online_latency: ["p(95)<2000"],
};

// Breakpoint thresholds: abortOnFail stops at the exact breaking point.
// Primary abort trigger: ws_handshake_success_rate — sampled immediately on each
// connect attempt, works correctly even when VUs hold connections for the full test.
// ws_errors and ws_session_ok_rate are informational only (no abort) because
// long-hold VUs don't produce "success" samples until interrupted at test end.
export const BREAKPOINT_THRESHOLDS = {
  ws_connecting_duration: [
    { threshold: "p(95)<5000", abortOnFail: true, delayAbortEval: "15s" },
  ],
  ws_handshake_duration: [
    { threshold: "p(95)<3000", abortOnFail: true, delayAbortEval: "15s" },
  ],
  // Informational only — do NOT abort on ws_errors for breakpoint
  ws_errors: ["rate<0.10"],
  // PRIMARY abort trigger: sampled at the moment of connect, not at session end
  ws_handshake_success_rate: [
    { threshold: "rate>0.95", abortOnFail: true, delayAbortEval: "30s" },
  ],
  // Informational only — VUs never complete sessions in breakpoint
  ws_session_ok_rate: ["rate>0.50"],
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
