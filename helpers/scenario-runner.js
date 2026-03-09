// ═══════════════════════════════════════════════════════════════════════════════
// Scenario Runner — Shared lifecycle for all test scenarios
// ═══════════════════════════════════════════════════════════════════════════════

import config, { validateConfig } from "../config.js";
import { createStats } from "./stats.js";
import { generateReport } from "../report-generator.js";

/**
 * Run a test scenario with standard lifecycle:
 *   1. Validate config
 *   2. Health check
 *   3. Execute scenario
 *   4. Generate report
 *   5. Print verdict
 *
 * @param {string} name — Scenario name
 * @param {function} scenarioFn — async (stats, config) => finalSnapshot
 */
export async function runScenario(name, scenarioFn) {
  console.log(`\n${"═".repeat(70)}`);
  console.log(`  C2C SignalR Load Test — ${name}`);
  console.log(`${"═".repeat(70)}`);
  console.log(`  Target:    ${config.BASE_URL}`);
  console.log(`  Started:   ${new Date().toISOString()}`);
  console.log(`${"═".repeat(70)}\n`);

  // 1. Validate
  validateConfig();

  // 2. Health check
  await healthCheck();

  // 3. Execute
  const stats = createStats(name);
  let logTimer = null;

  try {
    // Periodic live stats
    logTimer = setInterval(() => stats.printLive(), config.LOG_INTERVAL_MS);

    await scenarioFn(stats, config);
  } catch (error) {
    console.error(`\n🚨 Scenario failed with error: ${error.message}`);
    stats.recordError("scenario", error);
  } finally {
    if (logTimer) clearInterval(logTimer);
  }

  // 4. Finalize
  const finalSnapshot = stats.finish();

  // 5. Report
  console.log(`\n${"─".repeat(70)}`);
  console.log("  FINAL RESULTS");
  console.log(`${"─".repeat(70)}`);
  printFinalResults(finalSnapshot);

  const reportPath = await generateReport(
    finalSnapshot,
    stats.tierSnapshots,
    stats.getErrors(),
  );
  console.log(`\n  📄 Report:  ${reportPath}`);

  // 6. Verdict
  const passed = evaluateThresholds(finalSnapshot);
  console.log(`\n  ${passed ? "✅ PASSED" : "❌ FAILED"}`);
  console.log(`${"═".repeat(70)}\n`);

  process.exit(passed ? 0 : 1);
}

/**
 * Health check — verify the target server is reachable.
 */
async function healthCheck() {
  const url = `${config.BASE_URL.replace("wss://", "https://").replace("ws://", "http://")}${config.HEALTH_ENDPOINT}`;
  console.log(`  🏥 Health check: ${url}`);

  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (resp.ok) {
      console.log("  ✅ Server is healthy\n");
    } else {
      console.warn(
        `  ⚠️  Health check returned ${resp.status} — continuing anyway\n`,
      );
    }
  } catch (error) {
    console.warn(
      `  ⚠️  Health check failed: ${error.message} — continuing anyway\n`,
    );
  }
}

/**
 * Print formatted final results.
 */
function printFinalResults(snap) {
  const totalAttempts =
    snap.counters.connectionsOpened + snap.counters.connectionsFailed;
  const connSuccessRate =
    totalAttempts > 0
      ? ((snap.counters.connectionsOpened / totalAttempts) * 100).toFixed(1)
      : "100.0";

  console.log(`  Duration:            ${snap.elapsedSec}s`);
  console.log(
    `  Conn Success Rate:   ${connSuccessRate}% (${snap.counters.connectionsOpened}/${totalAttempts})`,
  );
  console.log(`  Peak Active:         ${snap.counters.peakActive}`);
  console.log(`  Currently Active:    ${snap.counters.connectionsActive}`);
  console.log(`  Connections Failed:  ${snap.counters.connectionsFailed}`);
  console.log(`  Reconnections:       ${snap.counters.reconnections}`);
  console.log(`  Unexpected Disconn:  ${snap.counters.unexpectedDisconnects}`);

  if (snap.counters.messagesSent > 0) {
    const deliveryRate = (
      (snap.counters.messagesReceived / snap.counters.messagesSent) *
      100
    ).toFixed(1);
    console.log(`  Messages Sent:       ${snap.counters.messagesSent}`);
    console.log(`  Messages Received:   ${snap.counters.messagesReceived}`);
    console.log(`  Delivery Rate:       ${deliveryRate}%`);
    console.log(`  Messages Lost:       ${snap.counters.messagesLost}`);
    console.log(`  Messages Duplicate:  ${snap.counters.messagesDuplicate}`);
    console.log(
      `  Notifications:       ${snap.counters.notificationsReceived}`,
    );
  }

  if (snap.counters.heartbeatsSent > 0) {
    console.log(
      `  Heartbeats:          ${snap.counters.heartbeatsSucceeded}/${snap.counters.heartbeatsSent}`,
    );
  }

  if (snap.counters.isUserOnlineCalls > 0) {
    console.log(`  IsUserOnline Calls:  ${snap.counters.isUserOnlineCalls}`);
  }

  console.log(`  Total Errors:        ${snap.counters.errors}`);

  if (snap.latencies.connectionTime) {
    const ct = snap.latencies.connectionTime;
    console.log(
      `  Connection Time:     p50=${ct.p50}ms  p95=${ct.p95}ms  p99=${ct.p99}ms  max=${ct.max}ms`,
    );
  }

  if (snap.latencies.messageLatency) {
    const ml = snap.latencies.messageLatency;
    console.log(
      `  Message Latency:     p50=${ml.p50}ms  p95=${ml.p95}ms  p99=${ml.p99}ms  max=${ml.max}ms`,
    );
  }

  if (snap.latencies.heartbeatLatency) {
    const hl = snap.latencies.heartbeatLatency;
    console.log(
      `  Heartbeat Latency:   p50=${hl.p50}ms  p95=${hl.p95}ms  p99=${hl.p99}ms  max=${hl.max}ms`,
    );
  }

  if (snap.latencies.isUserOnlineLatency) {
    const iol = snap.latencies.isUserOnlineLatency;
    console.log(
      `  IsUserOnline:        p50=${iol.p50}ms  p95=${iol.p95}ms  p99=${iol.p99}ms  max=${iol.max}ms`,
    );
  }
}

/**
 * Evaluate thresholds — returns true if all pass.
 */
function evaluateThresholds(snap) {
  const t = config.thresholds;
  let passed = true;

  const total =
    snap.counters.connectionsOpened + snap.counters.connectionsFailed;
  if (total > 0) {
    const rate = snap.counters.connectionsOpened / total;
    if (rate < t.connectionSuccessRate) {
      console.log(
        `  ❌ Connection success rate ${(rate * 100).toFixed(1)}% < ${t.connectionSuccessRate * 100}%`,
      );
      passed = false;
    }
  }

  if (snap.counters.messagesSent > 0) {
    const deliveryRate =
      snap.counters.messagesReceived / snap.counters.messagesSent;
    if (deliveryRate < t.messageDeliveryRate) {
      console.log(
        `  ❌ Message delivery rate ${(deliveryRate * 100).toFixed(1)}% < ${t.messageDeliveryRate * 100}%`,
      );
      passed = false;
    }
  }

  if (snap.latencies.connectionTime?.p99 > t.maxConnectionTimeMs) {
    console.log(
      `  ❌ Connection p99 ${snap.latencies.connectionTime.p99}ms > ${t.maxConnectionTimeMs}ms`,
    );
    passed = false;
  }

  if (snap.latencies.messageLatency?.p99 > t.maxMessageLatencyP99Ms) {
    console.log(
      `  ❌ Message latency p99 ${snap.latencies.messageLatency.p99}ms > ${t.maxMessageLatencyP99Ms}ms`,
    );
    passed = false;
  }

  return passed;
}

/**
 * Fetch real-time connection metrics from the server's /metrics/signalr endpoint.
 * Returns { total, messageHub, presenceHub, timestamp } or null on failure.
 */
export async function fetchServerMetrics() {
  const baseUrl = config.BASE_URL.replace("wss://", "https://").replace(
    "ws://",
    "http://",
  );
  const url = `${baseUrl}${config.METRICS_ENDPOINT}`;

  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null; // Non-critical — server may not expose metrics
  }
}

/**
 * Sleep helper.
 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
