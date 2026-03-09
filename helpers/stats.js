// ═══════════════════════════════════════════════════════════════════════════════
// Stats Engine — Real-time HDR Histogram metrics for load tests
// ═══════════════════════════════════════════════════════════════════════════════
// Collects latency distributions + counters + throughput for every operation.
// Thread-safe (single-threaded Node.js, but safe for async interleaving).
// ═══════════════════════════════════════════════════════════════════════════════

import hdr from "hdr-histogram-js";

/**
 * Create a new Stats collector instance.
 *
 * @param {string} scenarioName — Name of the test scenario
 * @returns {Stats}
 */
export function createStats(scenarioName) {
  return new Stats(scenarioName);
}

class Stats {
  constructor(scenarioName) {
    this.scenarioName = scenarioName;
    this.startTime = Date.now();
    this.endTime = null;

    // ── Latency Histograms (microsecond precision, up to 60s range) ────────
    this.histograms = {
      connectionTime: hdr.build({
        lowestDiscernibleValue: 1,
        highestTrackableValue: 60_000,
        numberOfSignificantValueDigits: 3,
      }),
      messageLatency: hdr.build({
        lowestDiscernibleValue: 1,
        highestTrackableValue: 60_000,
        numberOfSignificantValueDigits: 3,
      }),
      heartbeatLatency: hdr.build({
        lowestDiscernibleValue: 1,
        highestTrackableValue: 60_000,
        numberOfSignificantValueDigits: 3,
      }),
      isUserOnlineLatency: hdr.build({
        lowestDiscernibleValue: 1,
        highestTrackableValue: 60_000,
        numberOfSignificantValueDigits: 3,
      }),
      notificationLatency: hdr.build({
        lowestDiscernibleValue: 1,
        highestTrackableValue: 60_000,
        numberOfSignificantValueDigits: 3,
      }),
      messageReadLatency: hdr.build({
        lowestDiscernibleValue: 1,
        highestTrackableValue: 60_000,
        numberOfSignificantValueDigits: 3,
      }),
      apiLatency: hdr.build({
        lowestDiscernibleValue: 1,
        highestTrackableValue: 60_000,
        numberOfSignificantValueDigits: 3,
      }),
    };

    // ── Atomic Counters ────────────────────────────────────────────────────
    this.counters = {
      connectionsOpened: 0,
      connectionsFailed: 0,
      connectionsActive: 0,
      peakActive: 0,
      reconnections: 0,
      unexpectedDisconnects: 0,
      messagesSent: 0,
      messagesReceived: 0,
      messagesLost: 0,
      messagesDuplicate: 0,
      heartbeatsSent: 0,
      heartbeatsSucceeded: 0,
      notificationsReceived: 0,
      isUserOnlineCalls: 0,
      typingIndicatorsSent: 0,
      apiCalls: 0,
      apiErrors: 0,
      errors: 0,
    };

    // ── Throughput Tracking (sliding window) ───────────────────────────────
    this._messageTimes = []; // timestamps of messages sent
    this._connectionTimes = []; // timestamps of connections opened
    this._windowMs = 10_000; // 10s sliding window

    // ── Per-tier snapshots (for breakpoint/ramp tests) ─────────────────────
    this.tierSnapshots = [];

    // ── Error log (last N errors for debugging) ────────────────────────────
    this._errors = [];
    this._maxErrors = 100;
  }

  // ── Recording Methods ─────────────────────────────────────────────────────

  recordConnectionTime(ms) {
    this.histograms.connectionTime.recordValue(Math.max(1, Math.round(ms)));
    this.counters.connectionsOpened++;
    this.counters.connectionsActive++;
    if (this.counters.connectionsActive > this.counters.peakActive) {
      this.counters.peakActive = this.counters.connectionsActive;
    }
    this._connectionTimes.push(Date.now());
  }

  recordConnectionFailure(error) {
    this.counters.connectionsFailed++;
    this.counters.errors++;
    this._addError("connection", error);
  }

  recordDisconnect(expected = true) {
    this.counters.connectionsActive = Math.max(
      0,
      this.counters.connectionsActive - 1,
    );
    if (!expected) {
      this.counters.unexpectedDisconnects++;
    }
  }

  recordReconnection() {
    this.counters.reconnections++;
  }

  recordMessageSent() {
    this.counters.messagesSent++;
    this._messageTimes.push(Date.now());
  }

  recordMessageReceived(latencyMs) {
    this.counters.messagesReceived++;
    this.histograms.messageLatency.recordValue(
      Math.max(1, Math.round(latencyMs)),
    );
  }

  recordMessageLost() {
    this.counters.messagesLost++;
  }

  recordMessageDuplicate() {
    this.counters.messagesDuplicate++;
  }

  recordHeartbeat(latencyMs) {
    this.counters.heartbeatsSent++;
    this.counters.heartbeatsSucceeded++;
    this.histograms.heartbeatLatency.recordValue(
      Math.max(1, Math.round(latencyMs)),
    );
  }

  recordHeartbeatFailure(error) {
    this.counters.heartbeatsSent++;
    this.counters.errors++;
    this._addError("heartbeat", error);
  }

  recordIsUserOnline(latencyMs) {
    this.counters.isUserOnlineCalls++;
    this.histograms.isUserOnlineLatency.recordValue(
      Math.max(1, Math.round(latencyMs)),
    );
  }

  recordNotification(latencyMs) {
    this.counters.notificationsReceived++;
    this.histograms.notificationLatency.recordValue(
      Math.max(1, Math.round(latencyMs)),
    );
  }

  recordMessageRead(latencyMs) {
    this.histograms.messageReadLatency.recordValue(
      Math.max(1, Math.round(latencyMs)),
    );
  }

  recordTypingSent() {
    this.counters.typingIndicatorsSent++;
  }

  recordError(category, error) {
    this.counters.errors++;
    this._addError(category, error);
  }

  recordApiCall(latencyMs) {
    this.counters.apiCalls++;
    this.histograms.apiLatency.recordValue(Math.max(1, Math.round(latencyMs)));
  }

  recordApiError(endpoint, error) {
    this.counters.apiErrors++;
    this.counters.errors++;
    this._addError(`api:${endpoint}`, error);
  }

  // ── Tier Snapshot (for ramp/breakpoint) ───────────────────────────────────

  takeTierSnapshot(tierName) {
    this.tierSnapshots.push({
      tier: tierName,
      timestamp: new Date().toISOString(),
      ...this.snapshot(),
    });
  }

  // ── Throughput ────────────────────────────────────────────────────────────

  getMessageThroughput() {
    const now = Date.now();
    this._messageTimes = this._messageTimes.filter(
      (t) => now - t < this._windowMs,
    );
    return (this._messageTimes.length / this._windowMs) * 1000; // per second
  }

  getConnectionThroughput() {
    const now = Date.now();
    this._connectionTimes = this._connectionTimes.filter(
      (t) => now - t < this._windowMs,
    );
    return (this._connectionTimes.length / this._windowMs) * 1000;
  }

  // ── Snapshot ──────────────────────────────────────────────────────────────

  snapshot() {
    const elapsed = ((this.endTime || Date.now()) - this.startTime) / 1000;
    const snap = {
      scenario: this.scenarioName,
      elapsedSec: Math.round(elapsed),
      counters: { ...this.counters },
      throughput: {
        messagesPerSec: Math.round(this.getMessageThroughput() * 100) / 100,
        connectionsPerSec:
          Math.round(this.getConnectionThroughput() * 100) / 100,
      },
      latencies: {},
    };

    for (const [name, hist] of Object.entries(this.histograms)) {
      if (hist.totalCount > 0) {
        snap.latencies[name] = {
          count: hist.totalCount,
          mean: Math.round(hist.mean * 100) / 100,
          p50: hist.getValueAtPercentile(50),
          p95: hist.getValueAtPercentile(95),
          p99: hist.getValueAtPercentile(99),
          max: hist.maxValue,
        };
      }
    }

    return snap;
  }

  // ── Completion ────────────────────────────────────────────────────────────

  finish() {
    this.endTime = Date.now();
    return this.snapshot();
  }

  // ── Live Logging ──────────────────────────────────────────────────────────

  printLive() {
    const s = this.snapshot();
    const parts = [
      `⏱  ${s.elapsedSec}s`,
      `🔗 ${s.counters.connectionsActive} active`,
      `✅ ${s.counters.connectionsOpened} opened`,
      `❌ ${s.counters.connectionsFailed} failed`,
    ];

    if (s.counters.messagesSent > 0) {
      parts.push(`📨 ${s.counters.messagesSent} sent`);
      parts.push(`📩 ${s.counters.messagesReceived} recv`);
      parts.push(`⚡ ${s.throughput.messagesPerSec} msg/s`);
    }

    if (s.counters.notificationsReceived > 0) {
      parts.push(`🔔 ${s.counters.notificationsReceived} notif`);
    }

    if (s.counters.errors > 0) {
      parts.push(`🚨 ${s.counters.errors} errors`);
    }

    if (s.latencies.connectionTime) {
      parts.push(`🕐 conn p95=${s.latencies.connectionTime.p95}ms`);
    }

    if (s.latencies.messageLatency) {
      parts.push(`💬 msg p95=${s.latencies.messageLatency.p95}ms`);
    }

    console.log(parts.join(" | "));
  }

  // ── Error Tracking ────────────────────────────────────────────────────────

  _addError(category, error) {
    if (this._errors.length < this._maxErrors) {
      this._errors.push({
        time: new Date().toISOString(),
        category,
        message: error?.message || String(error),
      });
    }
  }

  getErrors() {
    return [...this._errors];
  }

  // ── Connection Success Rate ───────────────────────────────────────────────

  getConnectionSuccessRate() {
    const total =
      this.counters.connectionsOpened + this.counters.connectionsFailed;
    return total > 0 ? this.counters.connectionsOpened / total : 1;
  }

  getMessageDeliveryRate() {
    return this.counters.messagesSent > 0
      ? this.counters.messagesReceived / this.counters.messagesSent
      : 1;
  }
}
