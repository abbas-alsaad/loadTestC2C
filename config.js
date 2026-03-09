// ═══════════════════════════════════════════════════════════════════════════════
// C2C SignalR Load Test — Central Configuration
// ═══════════════════════════════════════════════════════════════════════════════
// All tunables in one place. Override via CLI flags or env vars.
// ═══════════════════════════════════════════════════════════════════════════════

const config = {
  // ── Target Environment ──────────────────────────────────────────────────────
  // The dedicated WS subdomain bypasses CloudFront → direct ALB → pods
  BASE_URL: process.env.C2C_BASE_URL || "https://ws-c2c-api-uat.gini.iq",
  // REST API base (different host from WebSocket)
  API_BASE_URL: process.env.C2C_API_BASE_URL || "https://c2c-api-uat.gini.iq",
  PRESENCE_HUB: "/hubs/presence",
  MESSAGE_HUB: "/hubs/message",
  HEALTH_ENDPOINT: "/health/live",
  METRICS_ENDPOINT: "/metrics/signalr",

  // ── JWT Configuration (QiServiceScheme) ─────────────────────────────────────
  // NEVER hardcode the secret — always from env var
  jwt: {
    TOKEN_KEY: process.env.C2C_TOKEN_KEY || "",
    ISSUER: "qi-services",
    AUDIENCE: "F0E62818-F5CE-4844-B01D-5F1A9F105967",
    ALGORITHM: "HS512",
    EXPIRY: "2h",
    USERNAME_PREFIX: process.env.C2C_USER_PREFIX || "loadtest_user_",
  },

  // ── SignalR Client Tuning (must match server Program.cs) ────────────────────
  signalr: {
    SERVER_TIMEOUT_MS: 65_000, // slightly > server's ClientTimeoutInterval (60s)
    KEEP_ALIVE_MS: 15_000, // matches server KeepAliveInterval
    HANDSHAKE_TIMEOUT_MS: 15_000, // matches server HandshakeTimeout
  },

  // ── Heartbeat ───────────────────────────────────────────────────────────────
  HEARTBEAT_INTERVAL_MS: 45_000, // 45s interval vs 120s Redis TTL = safe margin

  // ── Scale Profiles ──────────────────────────────────────────────────────────
  profiles: {
    smoke: {
      totalUsers: 10,
      chatPairs: 2,
      durationSec: 30,
      rampPerSec: 10,
    },
    ramp: {
      totalUsers: 5000,
      durationSec: 1020, // 10 min ramp + 5 min hold + 2 min drain
      rampPerSec: 50,
      tiers: [500, 1000, 2000, 3000, 5000],
      holdSec: 300, // 5 min hold at peak
    },
    heartbeat: {
      totalUsers: 2000,
      durationSec: 1800, // 30 minutes
      rampPerSec: 100,
      isUserOnlinePercent: 10, // 10% of users probe IsUserOnline each minute
    },
    chat: {
      chatPairs: 500, // 1000 MessageHub + 1000 PresenceHub
      messageIntervalMs: 5000, // 1 msg per pair per 5s = 100 msg/s
      typingIntervalMs: 10_000,
      rampPerSec: 20, // 20 pairs/sec
      holdSec: 600, // 10 min hold
      tiers: [50, 200, 500],
    },
    notification: {
      totalUsers: 2000,
      durationSec: 600,
      rampPerSec: 100,
    },
    mixed: {
      totalUsers: 5000,
      presenceOnlyPercent: 80, // 80% presence-only, 20% also chatting
      durationSec: 1200, // 20 minutes
      rampPerSec: 50,
      idlePercent: 70, // 70% idle, 20% IsUserOnline, 10% chatting
    },
    breakpoint: {
      startUsers: 1000,
      stepSize: 500,
      stepDurationSec: 120, // 2 min per tier
      maxFailureRate: 0.05, // stop at 5% failure
      maxP99Ms: 5000, // stop at 5s p99
    },
  },

  // ── Thresholds ──────────────────────────────────────────────────────────────
  thresholds: {
    connectionSuccessRate: 0.99, // 99% must connect
    messageDeliveryRate: 1.0, // 100% messages must arrive
    maxConnectionTimeMs: 5000, // 5s max to connect
    maxMessageLatencyP99Ms: 500, // p99 < 500ms for messages
    maxHeartbeatLatencyP99Ms: 1000, // p99 < 1s for heartbeat
  },

  // ── Chat Seed Data ──────────────────────────────────────────────────────────
  SEED_FILE:
    process.env.C2C_SEED_FILE ||
    new URL("./seed/test-items.json", import.meta.url).pathname,

  // ── Report Output ───────────────────────────────────────────────────────────
  RESULTS_DIR:
    process.env.C2C_RESULTS_DIR ||
    new URL("./results", import.meta.url).pathname,

  // ── Connection Pacing ───────────────────────────────────────────────────────
  // Maximum concurrent connection attempts to avoid overwhelming the server
  MAX_CONCURRENT_CONNECTS: 200,

  // ── Logging ─────────────────────────────────────────────────────────────────
  LOG_INTERVAL_MS: 5000, // print stats every 5s
  VERBOSE: process.env.C2C_VERBOSE === "true",
};

// ── Validation ──────────────────────────────────────────────────────────────
export function validateConfig() {
  const errors = [];
  if (!config.jwt.TOKEN_KEY) {
    errors.push("C2C_TOKEN_KEY environment variable is required");
  }
  if (!config.BASE_URL) {
    errors.push("C2C_BASE_URL environment variable is required");
  }
  if (errors.length > 0) {
    console.error("\n❌ Configuration errors:");
    errors.forEach((e) => console.error(`   • ${e}`));
    console.error(
      '\nUsage: C2C_TOKEN_KEY="<secret>" node scenarios/01-smoke.js\n',
    );
    process.exit(1);
  }
}

export default config;
