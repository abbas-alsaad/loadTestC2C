// ═══════════════════════════════════════════════════════════════════════════════
// Report Generator — HTML + JSON output for load test results
// ═══════════════════════════════════════════════════════════════════════════════

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import config from "./config.js";

/**
 * Generate HTML and JSON reports from test results.
 *
 * @param {object} snapshot — Final stats snapshot
 * @param {Array} tierSnapshots — Per-tier snapshots
 * @param {Array} errors — Error log
 * @returns {string} — Path to HTML report
 */
export async function generateReport(
  snapshot,
  tierSnapshots = [],
  errors = [],
) {
  mkdirSync(config.RESULTS_DIR, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const scenarioSlug = snapshot.scenario
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-");
  const baseName = `${scenarioSlug}_${timestamp}`;

  // ── JSON Report ─────────────────────────────────────────────────────────
  const totalAttempts =
    snapshot.counters.connectionsOpened + snapshot.counters.connectionsFailed;
  const connSuccessRate =
    totalAttempts > 0 ? snapshot.counters.connectionsOpened / totalAttempts : 1;
  const msgDeliveryRate =
    snapshot.counters.messagesSent > 0
      ? snapshot.counters.messagesReceived / snapshot.counters.messagesSent
      : 1;

  const jsonData = {
    scenario: snapshot.scenario,
    timestamp: new Date().toISOString(),
    target: config.BASE_URL,
    summary: {
      connectionSuccessRate: Math.round(connSuccessRate * 10000) / 100,
      messageDeliveryRate: Math.round(msgDeliveryRate * 10000) / 100,
      peakActiveConnections: snapshot.counters.peakActive,
    },
    ...snapshot,
    tierSnapshots,
    errors: errors.slice(0, 50), // Limit errors in report
    thresholds: config.thresholds,
  };

  const jsonPath = join(config.RESULTS_DIR, `${baseName}_report.json`);
  writeFileSync(jsonPath, JSON.stringify(jsonData, null, 2));

  // ── HTML Report ─────────────────────────────────────────────────────────
  const htmlPath = join(config.RESULTS_DIR, `${baseName}_report.html`);
  const html = buildHtml(snapshot, tierSnapshots, errors);
  writeFileSync(htmlPath, html);

  return htmlPath;
}

function buildHtml(snap, tierSnapshots, errors) {
  const passed = evaluatePass(snap);
  const statusEmoji = passed ? "✅ PASSED" : "❌ FAILED";
  const statusColor = passed ? "#22c55e" : "#ef4444";

  // Pre-compute rates
  const totalAttempts =
    snap.counters.connectionsOpened + snap.counters.connectionsFailed;
  const connSuccessRate =
    totalAttempts > 0 ? snap.counters.connectionsOpened / totalAttempts : 1;
  const msgDeliveryRate =
    snap.counters.messagesSent > 0
      ? snap.counters.messagesReceived / snap.counters.messagesSent
      : 1;
  const connSuccessPct = (connSuccessRate * 100).toFixed(1);
  const msgDeliveryPct = (msgDeliveryRate * 100).toFixed(1);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>C2C SignalR Load Test — ${snap.scenario}</title>
  <style>
    :root { --bg: #0f172a; --card: #1e293b; --text: #e2e8f0; --muted: #94a3b8; --accent: #3b82f6; --green: #22c55e; --red: #ef4444; --yellow: #eab308; }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace; background: var(--bg); color: var(--text); padding: 2rem; }
    h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
    h2 { font-size: 1.1rem; color: var(--accent); margin: 1.5rem 0 0.75rem; border-bottom: 1px solid #334155; padding-bottom: 0.25rem; }
    .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 2rem; }
    .status { font-size: 1.25rem; font-weight: bold; color: ${statusColor}; }
    .meta { color: var(--muted); font-size: 0.85rem; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 1rem; margin-bottom: 1.5rem; }
    .card { background: var(--card); border-radius: 0.5rem; padding: 1rem; }
    .card .label { color: var(--muted); font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; }
    .card .value { font-size: 1.5rem; font-weight: bold; margin-top: 0.25rem; }
    .card .value.green { color: var(--green); }
    .card .value.red { color: var(--red); }
    .card .value.yellow { color: var(--yellow); }
    .card .desc { color: var(--muted); font-size: 0.7rem; margin-top: 0.35rem; direction: rtl; text-align: right; line-height: 1.4; }
    table { width: 100%; border-collapse: collapse; background: var(--card); border-radius: 0.5rem; overflow: hidden; margin-bottom: 1rem; }
    th, td { padding: 0.5rem 0.75rem; text-align: left; border-bottom: 1px solid #334155; font-size: 0.85rem; }
    th { background: #334155; color: var(--muted); text-transform: uppercase; font-size: 0.7rem; letter-spacing: 0.05em; }
    .bar-container { width: 100%; background: #334155; border-radius: 4px; height: 20px; position: relative; overflow: hidden; }
    .bar { height: 100%; border-radius: 4px; transition: width 0.3s; }
    .bar.p50 { background: var(--green); }
    .bar.p95 { background: var(--yellow); }
    .bar.p99 { background: var(--red); }
    .error-log { background: var(--card); border-radius: 0.5rem; padding: 1rem; max-height: 300px; overflow-y: auto; font-size: 0.8rem; }
    .error-entry { padding: 0.25rem 0; border-bottom: 1px solid #334155; color: var(--muted); }
    .error-entry .cat { color: var(--red); font-weight: bold; }
    footer { margin-top: 2rem; color: var(--muted); font-size: 0.75rem; text-align: center; }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <h1>C2C SignalR Load Test</h1>
      <div class="meta">${snap.scenario} — ${new Date().toISOString()} — ${config.BASE_URL}</div>
    </div>
    <div class="status">${statusEmoji}</div>
  </div>

  <!-- Summary Cards -->
  <div class="grid">
    <div class="card">
      <div class="label">Duration</div>
      <div class="value">${snap.elapsedSec}s</div>
      <div class="desc">المدة الكلية لتشغيل الاختبار من البداية للنهاية</div>
    </div>
    <div class="card">
      <div class="label">Connection Success Rate</div>
      <div class="value ${connSuccessRate >= 0.99 ? "green" : connSuccessRate >= 0.95 ? "yellow" : "red"}">${connSuccessPct}%</div>
      <div class="desc">نسبة الاتصالات الناجحة من مجموع المحاولات — الهدف ≥ 99%</div>
    </div>
    <div class="card">
      <div class="label">Connections Opened</div>
      <div class="value green">${snap.counters.connectionsOpened}</div>
      <div class="desc">عدد اتصالات WebSocket التي تم فتحها بنجاح</div>
    </div>
    <div class="card">
      <div class="label">Connections Failed</div>
      <div class="value ${snap.counters.connectionsFailed > 0 ? "red" : "green"}">${snap.counters.connectionsFailed}</div>
      <div class="desc">عدد الاتصالات التي فشلت أثناء المحاولة (timeout أو رفض)</div>
    </div>
    <div class="card">
      <div class="label">Peak Active</div>
      <div class="value">${snap.counters.peakActive}</div>
      <div class="desc">أعلى عدد اتصالات نشطة في نفس اللحظة خلال الاختبار</div>
    </div>
    <div class="card">
      <div class="label">Currently Active</div>
      <div class="value">${snap.counters.connectionsActive}</div>
      <div class="desc">عدد الاتصالات النشطة حالياً عند انتهاء الاختبار</div>
    </div>
    <div class="card">
      <div class="label">Reconnections</div>
      <div class="value ${snap.counters.reconnections > 10 ? "yellow" : ""}">${snap.counters.reconnections}</div>
      <div class="desc">عدد مرات إعادة الاتصال التلقائية بعد انقطاع مؤقت</div>
    </div>
    <div class="card">
      <div class="label">Unexpected Disconnects</div>
      <div class="value ${snap.counters.unexpectedDisconnects > 0 ? "red" : "green"}">${snap.counters.unexpectedDisconnects}</div>
      <div class="desc">عدد الانقطاعات غير المتوقعة — السيرفر قطع الاتصال بدون طلب</div>
    </div>
    ${
      snap.counters.messagesSent > 0
        ? `
    <div class="card">
      <div class="label">Message Delivery Rate</div>
      <div class="value ${msgDeliveryRate >= 1.0 ? "green" : msgDeliveryRate >= 0.95 ? "yellow" : "red"}">${msgDeliveryPct}%</div>
      <div class="desc">نسبة الرسائل التي وصلت للمستلم من مجموع المرسلة — الهدف 100%</div>
    </div>
    <div class="card">
      <div class="label">Messages Sent</div>
      <div class="value">${snap.counters.messagesSent}</div>
      <div class="desc">عدد الرسائل التي تم إرسالها عبر SendMessage في الشات</div>
    </div>
    <div class="card">
      <div class="label">Messages Received</div>
      <div class="value ${snap.counters.messagesReceived < snap.counters.messagesSent ? "yellow" : "green"}">${snap.counters.messagesReceived}</div>
      <div class="desc">عدد الرسائل التي وصلت للطرف الآخر عبر حدث NewMessage</div>
    </div>
    <div class="card">
      <div class="label">Messages Lost</div>
      <div class="value ${snap.counters.messagesLost > 0 ? "red" : "green"}">${snap.counters.messagesLost}</div>
      <div class="desc">عدد الرسائل المفقودة — أُرسلت لكن لم تصل خلال 10 ثواني</div>
    </div>
    <div class="card">
      <div class="label">Messages Duplicated</div>
      <div class="value ${snap.counters.messagesDuplicate > 0 ? "yellow" : "green"}">${snap.counters.messagesDuplicate}</div>
      <div class="desc">عدد الرسائل المكررة — وصلت أكثر من مرة للمستلم</div>
    </div>
    `
        : ""
    }
    ${
      snap.counters.heartbeatsSent > 0
        ? `
    <div class="card">
      <div class="label">Heartbeats Sent</div>
      <div class="value">${snap.counters.heartbeatsSent}</div>
      <div class="desc">عدد نبضات القلب المرسلة للسيرفر لتجديد الحضور في Redis</div>
    </div>
    <div class="card">
      <div class="label">Heartbeats Succeeded</div>
      <div class="value green">${snap.counters.heartbeatsSucceeded}</div>
      <div class="desc">عدد النبضات التي نجحت — السيرفر استجاب وجدد الـ TTL</div>
    </div>
    `
        : ""
    }
    ${
      snap.counters.isUserOnlineCalls > 0
        ? `
    <div class="card">
      <div class="label">IsUserOnline Calls</div>
      <div class="value">${snap.counters.isUserOnlineCalls}</div>
      <div class="desc">عدد استدعاءات فحص حالة المستخدم (متصل/غير متصل) من Redis</div>
    </div>
    `
        : ""
    }
    ${
      snap.counters.typingIndicatorsSent > 0
        ? `
    <div class="card">
      <div class="label">Typing Indicators</div>
      <div class="value">${snap.counters.typingIndicatorsSent}</div>
      <div class="desc">عدد مؤشرات الكتابة المرسلة (يكتب الآن...)</div>
    </div>
    `
        : ""
    }
    <div class="card">
      <div class="label">Notifications Received</div>
      <div class="value">${snap.counters.notificationsReceived}</div>
      <div class="desc">عدد الإشعارات المستلمة عبر PresenceHub (عروض، دفع، شات)</div>
    </div>
    <div class="card">
      <div class="label">Total Errors</div>
      <div class="value ${snap.counters.errors > 0 ? "red" : "green"}">${snap.counters.errors}</div>
      <div class="desc">مجموع كل الأخطاء — اتصال، رسائل، نبضات، أو أخطاء أخرى</div>
    </div>
    ${
      snap.throughput
        ? `
    <div class="card">
      <div class="label">Msg Throughput</div>
      <div class="value">${snap.throughput.messagesPerSec} msg/s</div>
      <div class="desc">معدل إرسال الرسائل في الثانية (آخر 10 ثواني)</div>
    </div>
    <div class="card">
      <div class="label">Conn Throughput</div>
      <div class="value">${snap.throughput.connectionsPerSec} conn/s</div>
      <div class="desc">معدل فتح الاتصالات الجديدة في الثانية (آخر 10 ثواني)</div>
    </div>
    `
        : ""
    }
  </div>

  <!-- Latency Distribution -->
  <h2>Latency Distribution (ms)</h2>
  ${buildLatencyTable(snap.latencies)}

  <!-- Latency Bars -->
  <h2>Latency Visualization</h2>
  ${buildLatencyBars(snap.latencies)}

  <!-- Tier Snapshots -->
  ${
    tierSnapshots.length > 0
      ? `
  <h2>Tier Progression</h2>
  ${buildTierTable(tierSnapshots)}
  `
      : ""
  }

  <!-- Error Log -->
  ${
    errors.length > 0
      ? `
  <h2>Error Log (last ${Math.min(errors.length, 50)})</h2>
  <div class="error-log">
    ${errors
      .slice(0, 50)
      .map(
        (e) =>
          `<div class="error-entry"><span class="cat">[${e.category}]</span> ${e.time} — ${escapeHtml(e.message)}</div>`,
      )
      .join("\n    ")}
  </div>
  `
      : ""
  }

  <!-- Thresholds -->
  <h2>Threshold Evaluation</h2>
  <table>
    <tr><th>Metric</th><th>Threshold</th><th>Actual</th><th>Result</th></tr>
    <tr>
      <td>Connection Success Rate</td>
      <td>≥ ${config.thresholds.connectionSuccessRate * 100}%</td>
      <td>${connSuccessPct}%</td>
      <td>${connSuccessRate >= config.thresholds.connectionSuccessRate ? "✅ PASS" : "❌ FAIL"}</td>
    </tr>
    ${
      snap.counters.messagesSent > 0
        ? `
    <tr>
      <td>Message Delivery Rate</td>
      <td>≥ ${config.thresholds.messageDeliveryRate * 100}%</td>
      <td>${msgDeliveryPct}%</td>
      <td>${msgDeliveryRate >= config.thresholds.messageDeliveryRate ? "✅ PASS" : "❌ FAIL"}</td>
    </tr>
    `
        : ""
    }
    ${
      snap.latencies.connectionTime
        ? `
    <tr>
      <td>Connection Time p99</td>
      <td>≤ ${config.thresholds.maxConnectionTimeMs}ms</td>
      <td>${snap.latencies.connectionTime.p99}ms</td>
      <td>${snap.latencies.connectionTime.p99 <= config.thresholds.maxConnectionTimeMs ? "✅ PASS" : "❌ FAIL"}</td>
    </tr>
    `
        : ""
    }
    ${
      snap.latencies.messageLatency
        ? `
    <tr>
      <td>Message Latency p99</td>
      <td>≤ ${config.thresholds.maxMessageLatencyP99Ms}ms</td>
      <td>${snap.latencies.messageLatency.p99}ms</td>
      <td>${snap.latencies.messageLatency.p99 <= config.thresholds.maxMessageLatencyP99Ms ? "✅ PASS" : "❌ FAIL"}</td>
    </tr>
    `
        : ""
    }
    ${
      snap.latencies.heartbeatLatency
        ? `
    <tr>
      <td>Heartbeat Latency p99</td>
      <td>≤ ${config.thresholds.maxHeartbeatLatencyP99Ms}ms</td>
      <td>${snap.latencies.heartbeatLatency.p99}ms</td>
      <td>${snap.latencies.heartbeatLatency.p99 <= config.thresholds.maxHeartbeatLatencyP99Ms ? "✅ PASS" : "❌ FAIL"}</td>
    </tr>
    `
        : ""
    }
  </table>

  <!-- Test Configuration -->
  <h2>Test Configuration</h2>
  <table>
    <tr><th>Parameter</th><th>Value</th></tr>
    <tr><td>Target</td><td>${config.BASE_URL}</td></tr>
    <tr><td>Presence Hub</td><td>${config.PRESENCE_HUB}</td></tr>
    <tr><td>Message Hub</td><td>${config.MESSAGE_HUB}</td></tr>
    <tr><td>JWT Algorithm</td><td>${config.jwt.ALGORITHM}</td></tr>
    <tr><td>Server Timeout</td><td>${config.signalr.SERVER_TIMEOUT_MS}ms</td></tr>
    <tr><td>Keep Alive</td><td>${config.signalr.KEEP_ALIVE_MS}ms</td></tr>
    <tr><td>Heartbeat Interval</td><td>${config.HEARTBEAT_INTERVAL_MS}ms</td></tr>
    <tr><td>Max Concurrent Connects</td><td>${config.MAX_CONCURRENT_CONNECTS}</td></tr>
    <tr><td>Node.js</td><td>${process.version}</td></tr>
    <tr><td>Platform</td><td>${process.platform} ${process.arch}</td></tr>
  </table>

  <footer>
    Generated by C2C SignalR Load Test Suite — ${new Date().toISOString()}
  </footer>
</body>
</html>`;
}

function buildLatencyTable(latencies) {
  const entries = Object.entries(latencies);
  if (entries.length === 0)
    return '<p style="color: var(--muted);">No latency data recorded</p>';

  let html = `<table><tr><th>Metric</th><th>Count</th><th>Mean</th><th>p50</th><th>p95</th><th>p99</th><th>Max</th></tr>`;
  for (const [name, data] of entries) {
    html += `<tr>
      <td>${name}</td>
      <td>${data.count}</td>
      <td>${data.mean}ms</td>
      <td>${data.p50}ms</td>
      <td>${data.p95}ms</td>
      <td>${data.p99}ms</td>
      <td>${data.max}ms</td>
    </tr>`;
  }
  html += "</table>";
  return html;
}

function buildLatencyBars(latencies) {
  const entries = Object.entries(latencies);
  if (entries.length === 0) return "";

  let html = "";
  for (const [name, data] of entries) {
    const maxVal = Math.max(data.max, 1);
    html += `<div style="margin-bottom: 0.75rem;">
      <div style="font-size: 0.8rem; color: var(--muted); margin-bottom: 0.25rem;">${name}</div>
      <div class="bar-container">
        <div class="bar p99" style="width: ${Math.min(100, (data.p99 / maxVal) * 100)}%;" title="p99: ${data.p99}ms"></div>
      </div>
      <div style="display: flex; gap: 1rem; font-size: 0.7rem; color: var(--muted); margin-top: 0.15rem;">
        <span>p50: ${data.p50}ms</span>
        <span>p95: ${data.p95}ms</span>
        <span style="color: var(--red);">p99: ${data.p99}ms</span>
        <span>max: ${data.max}ms</span>
      </div>
    </div>`;
  }
  return html;
}

function buildTierTable(tiers) {
  if (tiers.length === 0) return "";

  let html = `<table><tr><th>Tier</th><th>Time</th><th>Peak Active</th><th>Active</th><th>Failed</th><th>Sent</th><th>Recv</th><th>Errors</th><th>Conn p99</th><th>Msg p99</th></tr>`;
  for (const t of tiers) {
    html += `<tr>
      <td>${t.tier}</td>
      <td>${t.timestamp?.slice(11, 19) ?? ""}</td>
      <td>${t.counters?.peakActive ?? 0}</td>
      <td>${t.counters?.connectionsActive ?? 0}</td>
      <td>${t.counters?.connectionsFailed ?? 0}</td>
      <td>${t.counters?.messagesSent ?? 0}</td>
      <td>${t.counters?.messagesReceived ?? 0}</td>
      <td>${t.counters?.errors ?? 0}</td>
      <td>${t.latencies?.connectionTime?.p99 ?? "-"}ms</td>
      <td>${t.latencies?.messageLatency?.p99 ?? "-"}ms</td>
    </tr>`;
  }
  html += "</table>";
  return html;
}

function evaluatePass(snap) {
  const total =
    snap.counters.connectionsOpened + snap.counters.connectionsFailed;
  if (total > 0) {
    const rate = snap.counters.connectionsOpened / total;
    if (rate < config.thresholds.connectionSuccessRate) return false;
  }
  if (snap.counters.messagesSent > 0) {
    const delRate = snap.counters.messagesReceived / snap.counters.messagesSent;
    if (delRate < config.thresholds.messageDeliveryRate) return false;
  }
  if (
    snap.latencies.connectionTime?.p99 > config.thresholds.maxConnectionTimeMs
  )
    return false;
  if (
    snap.latencies.messageLatency?.p99 >
    config.thresholds.maxMessageLatencyP99Ms
  )
    return false;
  return true;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
