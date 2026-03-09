// ═══════════════════════════════════════════════════════════════════════════════
// Presence User — Virtual user for PresenceHub load testing
// ═══════════════════════════════════════════════════════════════════════════════
// Simulates a real MiniApp user: connect, heartbeat, receive notifications.
// Each instance manages ONE WebSocket connection to /hubs/presence.
// ═══════════════════════════════════════════════════════════════════════════════

import {
  createPresenceConnection,
  startWithTimeout,
  stopGracefully,
} from "./signalr-client.js";
import config from "../config.js";

/**
 * @typedef {import('./stats.js').createStats} StatsInstance
 */

// All notification events that PresenceHub receives (from IRealtimeNotifier)
const NOTIFICATION_EVENTS = [
  "ChatMessageNotification",
  "OfferReceived",
  "OfferStatusChanged",
  "InPersonOfferReceived",
  "InPersonOfferStatusChanged",
  "InvoiceCreated",
  "PaymentCompleted",
  "ChatStatusChanged",
];

export class PresenceUser {
  /**
   * @param {string} token — JWT token
   * @param {string} username — Username for logging
   * @param {object} stats — Stats collector instance
   */
  constructor(token, username, stats) {
    this.token = token;
    this.username = username;
    this.stats = stats;
    this.connection = null;
    this._heartbeatTimer = null;
    this._connected = false;
    this._stopped = false;
  }

  /**
   * Connect to PresenceHub, set up event listeners, start heartbeat.
   * @returns {Promise<boolean>} true if connected successfully
   */
  async start() {
    const startMs = Date.now();

    try {
      this.connection = createPresenceConnection(this.token);
      this._registerEventListeners();

      await startWithTimeout(this.connection);

      const elapsed = Date.now() - startMs;
      this.stats.recordConnectionTime(elapsed);
      this._connected = true;

      // Start periodic heartbeat (45s interval vs 120s Redis TTL)
      this._startHeartbeat();

      return true;
    } catch (error) {
      this.stats.recordConnectionFailure(error);
      return false;
    }
  }

  /**
   * Call IsUserOnline(username) and measure round-trip latency.
   * @param {string} targetUsername
   * @returns {Promise<{ username: string, isOnline: boolean } | null>}
   */
  async isUserOnline(targetUsername) {
    if (!this._connected || this._stopped) return null;

    const startMs = Date.now();
    try {
      const result = await this.connection.invoke(
        "IsUserOnline",
        targetUsername,
      );
      this.stats.recordIsUserOnline(Date.now() - startMs);
      return result;
    } catch (error) {
      this.stats.recordError("isUserOnline", error);
      return null;
    }
  }

  /**
   * Gracefully disconnect.
   */
  async stop() {
    this._stopped = true;

    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }

    if (this.connection) {
      await stopGracefully(this.connection);
      if (this._connected) {
        this.stats.recordDisconnect(/* expected */ true);
        this._connected = false;
      }
    }
  }

  get isConnected() {
    return this._connected && !this._stopped;
  }

  // ── Private ─────────────────────────────────────────────────────────────

  _registerEventListeners() {
    // Listen for ALL notification events pushed via PresenceHub
    for (const event of NOTIFICATION_EVENTS) {
      this.connection.on(event, (payload) => {
        // Measure latency if payload has a timestamp we can compare against
        const now = Date.now();
        let latencyMs = 0;

        if (payload?.messageSent) {
          const sent = new Date(payload.messageSent).getTime();
          if (!isNaN(sent)) latencyMs = now - sent;
        } else if (payload?.timestamp) {
          const ts = new Date(payload.timestamp).getTime();
          if (!isNaN(ts)) latencyMs = now - ts;
        }

        this.stats.recordNotification(Math.max(1, latencyMs));
      });
    }

    // Track reconnections
    this.connection.onreconnecting((error) => {
      if (config.VERBOSE) {
        console.log(`  ↻ ${this.username} reconnecting: ${error?.message}`);
      }
    });

    this.connection.onreconnected(() => {
      this.stats.recordReconnection();
      if (config.VERBOSE) {
        console.log(`  ✓ ${this.username} reconnected`);
      }
    });

    // Track unexpected disconnections
    this.connection.onclose((error) => {
      if (!this._stopped && this._connected) {
        this.stats.recordDisconnect(/* expected */ false);
        this._connected = false;
        if (config.VERBOSE) {
          console.log(
            `  ✗ ${this.username} disconnected unexpectedly: ${error?.message}`,
          );
        }
      }
    });
  }

  _startHeartbeat() {
    this._heartbeatTimer = setInterval(async () => {
      if (!this._connected || this._stopped) return;

      const startMs = Date.now();
      try {
        await this.connection.invoke("Heartbeat");
        this.stats.recordHeartbeat(Date.now() - startMs);
      } catch (error) {
        this.stats.recordHeartbeatFailure(error);
      }
    }, config.HEARTBEAT_INTERVAL_MS);
  }
}

/**
 * Connect N presence users with pacing (MAX_CONCURRENT_CONNECTS at a time).
 *
 * @param {Array<{token: string, username: string}>} users
 * @param {object} stats
 * @param {number} rampPerSec — Connections per second
 * @returns {Promise<PresenceUser[]>}
 */
export async function connectPresenceUsers(users, stats, rampPerSec = 50) {
  const presenceUsers = [];
  const delayMs = Math.max(1, Math.floor(1000 / rampPerSec));

  for (let i = 0; i < users.length; i++) {
    const pu = new PresenceUser(users[i].token, users[i].username, stats);
    presenceUsers.push(pu);

    // Fire and forget with pacing (don't await each one for max throughput)
    pu.start().catch(() => {}); // Errors recorded in stats

    // Pace: wait between each connection attempt
    if ((i + 1) % rampPerSec === 0) {
      await sleep(1000);
    } else {
      await sleep(delayMs);
    }
  }

  // Wait for all pending connections to settle
  await sleep(3000);
  return presenceUsers;
}

/**
 * Gracefully disconnect all users.
 *
 * @param {PresenceUser[]} users
 */
export async function disconnectAll(users) {
  const batchSize = 100;
  for (let i = 0; i < users.length; i += batchSize) {
    const batch = users.slice(i, i + batchSize);
    await Promise.allSettled(batch.map((u) => u.stop()));
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
