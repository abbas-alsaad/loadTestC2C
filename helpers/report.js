/**
 * Professional HTML Report Generator for k6 Load Tests
 *
 * Generates a self-contained HTML report with:
 *   - Executive summary (overall PASS/FAIL)
 *   - Test configuration
 *   - Threshold results (green/red)
 *   - Key metrics dashboard with pre-computed values
 *   - Detailed metrics tables (p50/p90/p95/p99/max)
 *   - Throughput calculations (TPS, connections/sec)
 *   - Recommendations based on results
 *
 * Usage in scenario files:
 *   import { generateReport } from "../helpers/report.js";
 *   export function handleSummary(data) {
 *     return generateReport(data, { scenario, stage, metrics: [...] });
 *   }
 */

import { BASE_URL, STAGES } from "../config.js";

// ─── Helpers ──────────────────────────────────────────────────

function fmt(n, decimals) {
  if (n === undefined || n === null || isNaN(n)) return "—";
  const d = decimals !== undefined ? decimals : 2;
  if (Math.abs(n) >= 1000000) return (n / 1000000).toFixed(1) + "M";
  if (Math.abs(n) >= 10000) return (n / 1000).toFixed(1) + "K";
  return Number(n).toFixed(d);
}

function fmtMs(n) {
  if (n === undefined || n === null || isNaN(n)) return "—";
  if (n >= 60000) return (n / 60000).toFixed(1) + " min";
  if (n >= 1000) return (n / 1000).toFixed(2) + " s";
  return n.toFixed(1) + " ms";
}

function fmtRate(n) {
  if (n === undefined || n === null || isNaN(n)) return "—";
  return (n * 100).toFixed(2) + "%";
}

function fmtCount(n) {
  if (n === undefined || n === null || isNaN(n)) return "—";
  // k6's JS runtime doesn't support toLocaleString with arguments
  const str = Math.round(n).toString();
  const parts = [];
  for (let i = str.length; i > 0; i -= 3) {
    parts.unshift(str.slice(Math.max(0, i - 3), i));
  }
  return parts.join(",");
}

function getTestDurationSec(data) {
  // k6 stores state.testRunDurationMs in some versions
  // Fallback: sum stage durations from config
  if (data.state && data.state.testRunDurationMs) {
    return data.state.testRunDurationMs / 1000;
  }
  // Try to infer from http_reqs or iterations
  const iters = data.metrics["iterations"];
  if (iters && iters.values && iters.values.count) {
    // Rough estimate: use vus_max * avg iteration time
    const avgDur = data.metrics["iteration_duration"];
    if (avgDur && avgDur.values) {
      return (iters.values.count * avgDur.values.avg) / 1000;
    }
  }
  return 0;
}

function getStageDuration(stageName) {
  const steps = STAGES[stageName] || STAGES.smoke;
  let totalSec = 0;
  for (const s of steps) {
    const d = s.duration;
    if (d.endsWith("s")) totalSec += parseInt(d);
    else if (d.endsWith("m")) totalSec += parseInt(d) * 60;
    else if (d.endsWith("h")) totalSec += parseInt(d) * 3600;
  }
  return totalSec;
}

function getMaxVUsFromStage(stageName) {
  const steps = STAGES[stageName] || STAGES.smoke;
  let max = 0;
  for (const s of steps) {
    if (s.target > max) max = s.target;
  }
  return max;
}

// ─── Threshold Evaluation ─────────────────────────────────────

function evaluateThresholds(data) {
  const results = [];
  for (const [metricName, metric] of Object.entries(data.metrics)) {
    if (metric.thresholds) {
      for (const [expr, result] of Object.entries(metric.thresholds)) {
        results.push({
          metric: metricName,
          threshold: expr,
          passed: result.ok,
        });
      }
    }
  }
  return results;
}

// ─── Metric Extraction ────────────────────────────────────────

function extractMetric(data, name) {
  const m = data.metrics[name];
  if (!m || !m.values) return null;
  return m.values;
}

// ─── Report Section Builders ──────────────────────────────────

function buildMetricDefinitions(scenarioName) {
  const defs = {
    "presence-hub": [
      {
        key: "ws_connecting_duration",
        label: "WebSocket Connect Time",
        type: "trend",
        unit: "ms",
        desc: "TCP + TLS connection establishment",
      },
      {
        key: "ws_handshake_duration",
        label: "SignalR Handshake Time",
        type: "trend",
        unit: "ms",
        desc: "SignalR JSON protocol handshake",
      },
      {
        key: "ws_session_duration",
        label: "Session Duration",
        type: "trend",
        unit: "ms",
        desc: "Total WebSocket session lifetime",
      },
      {
        key: "ws_errors",
        label: "WebSocket Error Rate",
        type: "rate",
        desc: "Percentage of failed connections",
      },
      {
        key: "ws_connections_opened",
        label: "Connections Opened",
        type: "counter",
        desc: "Total successful WebSocket connections",
      },
      {
        key: "ws_connections_closed",
        label: "Connections Closed",
        type: "counter",
        desc: "Total graceful disconnections",
      },
      {
        key: "heartbeats_sent",
        label: "Heartbeats Sent",
        type: "counter",
        desc: "Total Heartbeat() invocations (Redis TTL refresh)",
      },
      {
        key: "is_user_online_checks",
        label: "IsUserOnline Calls",
        type: "counter",
        desc: "Total IsUserOnline() invocations",
      },
      {
        key: "is_user_online_latency",
        label: "IsUserOnline Latency",
        type: "trend",
        unit: "ms",
        desc: "Round-trip time for IsUserOnline hub call",
      },
      {
        key: "http_req_duration",
        label: "HTTP Request Duration",
        type: "trend",
        unit: "ms",
        desc: "Negotiate endpoint response time",
      },
      {
        key: "http_req_failed",
        label: "HTTP Failure Rate",
        type: "rate",
        desc: "Percentage of failed HTTP requests",
      },
    ],
    "message-hub": [
      {
        key: "ws_connecting_duration",
        label: "WebSocket Connect Time",
        type: "trend",
        unit: "ms",
        desc: "TCP + TLS connection establishment",
      },
      {
        key: "ws_handshake_duration",
        label: "SignalR Handshake Time",
        type: "trend",
        unit: "ms",
        desc: "SignalR JSON protocol handshake",
      },
      {
        key: "ws_session_duration",
        label: "Session Duration",
        type: "trend",
        unit: "ms",
        desc: "Total WebSocket session lifetime",
      },
      {
        key: "ws_errors",
        label: "WebSocket Error Rate",
        type: "rate",
        desc: "Percentage of failed connections",
      },
      {
        key: "messages_sent",
        label: "Messages Sent",
        type: "counter",
        desc: "Total SendMessage() invocations",
      },
      {
        key: "messages_received",
        label: "Messages Received",
        type: "counter",
        desc: "Total NewMessage events received",
      },
      {
        key: "message_delivery_latency",
        label: "Message Delivery Latency",
        type: "trend",
        unit: "ms",
        desc: "SendMessage invoke → server completion",
      },
      {
        key: "message_thread_received",
        label: "Thread History Loaded",
        type: "counter",
        desc: "ReceiveMessageThread events on connect",
      },
      {
        key: "http_req_duration",
        label: "HTTP Request Duration",
        type: "trend",
        unit: "ms",
        desc: "Negotiate endpoint response time",
      },
      {
        key: "http_req_failed",
        label: "HTTP Failure Rate",
        type: "rate",
        desc: "Percentage of failed HTTP requests",
      },
    ],
    "full-flow": [
      {
        key: "ws_connecting_duration",
        label: "WebSocket Connect Time",
        type: "trend",
        unit: "ms",
        desc: "TCP + TLS connection establishment",
      },
      {
        key: "ws_handshake_duration",
        label: "SignalR Handshake Time",
        type: "trend",
        unit: "ms",
        desc: "SignalR JSON protocol handshake",
      },
      {
        key: "ws_session_duration",
        label: "Session Duration",
        type: "trend",
        unit: "ms",
        desc: "Total WebSocket session lifetime",
      },
      {
        key: "ws_errors",
        label: "WebSocket Error Rate",
        type: "rate",
        desc: "Percentage of failed connections",
      },
      {
        key: "messages_sent",
        label: "Messages Sent",
        type: "counter",
        desc: "Total messages sent (buyer + seller)",
      },
      {
        key: "messages_received",
        label: "Messages Received",
        type: "counter",
        desc: "Total NewMessage events received",
      },
      {
        key: "message_delivery_latency",
        label: "Message Delivery Latency",
        type: "trend",
        unit: "ms",
        desc: "SendMessage invoke → server completion",
      },
      {
        key: "message_thread_received",
        label: "Thread History Loaded",
        type: "counter",
        desc: "ReceiveMessageThread on connect",
      },
      {
        key: "typing_indicators_received",
        label: "Typing Indicators",
        type: "counter",
        desc: "UserTyping events delivered cross-user",
      },
      {
        key: "presence_checks",
        label: "Presence Checks",
        type: "counter",
        desc: "IsUserOnline calls from buyer → seller",
      },
      {
        key: "presence_online",
        label: "Seller Found Online",
        type: "counter",
        desc: "Successful online status confirmations",
      },
      {
        key: "chat_notifications_received",
        label: "Chat Notifications",
        type: "counter",
        desc: "ChatMessageNotification via PresenceHub",
      },
      {
        key: "http_req_duration",
        label: "HTTP Request Duration",
        type: "trend",
        unit: "ms",
        desc: "Negotiate endpoint response time",
      },
      {
        key: "http_req_failed",
        label: "HTTP Failure Rate",
        type: "rate",
        desc: "Percentage of failed HTTP requests",
      },
    ],
    "presence-stress": [
      {
        key: "ws_connecting_duration",
        label: "WebSocket Connect Time",
        type: "trend",
        unit: "ms",
        desc: "TCP + TLS connection establishment",
      },
      {
        key: "ws_handshake_duration",
        label: "SignalR Handshake Time",
        type: "trend",
        unit: "ms",
        desc: "SignalR JSON protocol handshake",
      },
      {
        key: "ws_session_duration",
        label: "Session Duration",
        type: "trend",
        unit: "ms",
        desc: "Total WebSocket session lifetime",
      },
      {
        key: "ws_errors",
        label: "WebSocket Error Rate",
        type: "rate",
        desc: "Percentage of failed connections",
      },
      {
        key: "presence_online_rate",
        label: "Presence Online Rate",
        type: "rate",
        desc: "% of checks finding target user online",
      },
      {
        key: "presence_check_latency",
        label: "Presence Check Latency",
        type: "trend",
        unit: "ms",
        desc: "IsUserOnline round-trip time",
      },
      {
        key: "presence_checks_total",
        label: "Total Presence Checks",
        type: "counter",
        desc: "Total IsUserOnline invocations",
      },
      {
        key: "presence_online_count",
        label: "Online Results",
        type: "counter",
        desc: "Checks returning isOnline=true",
      },
      {
        key: "presence_offline_count",
        label: "Offline Results",
        type: "counter",
        desc: "Checks returning isOnline=false",
      },
      {
        key: "http_req_duration",
        label: "HTTP Request Duration",
        type: "trend",
        unit: "ms",
        desc: "Negotiate endpoint response time",
      },
      {
        key: "http_req_failed",
        label: "HTTP Failure Rate",
        type: "rate",
        desc: "Percentage of failed HTTP requests",
      },
    ],
    "notification-broadcast": [
      {
        key: "ws_connecting_duration",
        label: "WebSocket Connect Time",
        type: "trend",
        unit: "ms",
        desc: "TCP + TLS connection establishment",
      },
      {
        key: "ws_handshake_duration",
        label: "SignalR Handshake Time",
        type: "trend",
        unit: "ms",
        desc: "SignalR JSON protocol handshake",
      },
      {
        key: "ws_session_duration",
        label: "Session Duration",
        type: "trend",
        unit: "ms",
        desc: "Total WebSocket session lifetime",
      },
      {
        key: "ws_errors",
        label: "WebSocket Error Rate",
        type: "rate",
        desc: "Percentage of failed connections",
      },
      {
        key: "notifications_received",
        label: "Notifications Received",
        type: "counter",
        desc: "Total notification events",
      },
      {
        key: "notification_delivery_latency",
        label: "Notification Latency",
        type: "trend",
        unit: "ms",
        desc: "Server send → client receive",
      },
      {
        key: "event_InPersonOfferReceived",
        label: "InPersonOfferReceived",
        type: "counter",
        desc: "",
      },
      {
        key: "event_InPersonOfferStatusChanged",
        label: "InPersonOfferStatusChanged",
        type: "counter",
        desc: "",
      },
      {
        key: "event_PaymentCompleted",
        label: "PaymentCompleted",
        type: "counter",
        desc: "",
      },
      {
        key: "event_OfferReceived",
        label: "OfferReceived",
        type: "counter",
        desc: "",
      },
      {
        key: "event_OfferStatusChanged",
        label: "OfferStatusChanged",
        type: "counter",
        desc: "",
      },
      {
        key: "event_InvoiceCreated",
        label: "InvoiceCreated",
        type: "counter",
        desc: "",
      },
      {
        key: "event_ChatMessageNotification",
        label: "ChatMessageNotification",
        type: "counter",
        desc: "",
      },
      {
        key: "http_req_duration",
        label: "HTTP Request Duration",
        type: "trend",
        unit: "ms",
        desc: "Negotiate endpoint response time",
      },
      {
        key: "http_req_failed",
        label: "HTTP Failure Rate",
        type: "rate",
        desc: "Percentage of failed HTTP requests",
      },
    ],

    "chat-offers": [
      {
        key: "ws_connecting_duration",
        label: "WS Connect Duration",
        type: "trend",
        unit: "ms",
        desc: "Time to establish WebSocket connection",
      },
      {
        key: "ws_handshake_duration",
        label: "SignalR Handshake",
        type: "trend",
        unit: "ms",
        desc: "Time to complete SignalR handshake",
      },
      {
        key: "ws_errors",
        label: "WebSocket Errors",
        type: "rate",
        desc: "Percentage of failed WebSocket connections",
      },
      {
        key: "ws_session_duration",
        label: "Session Duration",
        type: "trend",
        unit: "ms",
        desc: "Total WebSocket session time",
      },
      {
        key: "messages_sent",
        label: "Messages Sent",
        type: "counter",
        desc: "Total text messages sent via SendMessage",
      },
      {
        key: "messages_received",
        label: "Messages Received",
        type: "counter",
        desc: "Total NewMessage events received",
      },
      {
        key: "message_delivery_latency",
        label: "Message Delivery Latency",
        type: "trend",
        unit: "ms",
        desc: "Time from SendMessage to server completion",
      },
      {
        key: "message_thread_received",
        label: "Thread Received",
        type: "counter",
        desc: "ReceiveMessageThread events on connect",
      },
      {
        key: "offer_creation_latency",
        label: "Offer Creation Latency",
        type: "trend",
        unit: "ms",
        desc: "REST API latency to create an offer",
      },
      {
        key: "offer_accept_latency",
        label: "Offer Accept Latency",
        type: "trend",
        unit: "ms",
        desc: "REST API latency to accept an offer",
      },
      {
        key: "offers_created",
        label: "Offers Created",
        type: "counter",
        desc: "Total offers successfully created",
      },
      {
        key: "offers_accepted",
        label: "Offers Accepted",
        type: "counter",
        desc: "Total offers successfully accepted",
      },
      {
        key: "offers_failed",
        label: "Offers Failed",
        type: "counter",
        desc: "Offers that failed (superseded/rejected/error)",
      },
      {
        key: "http_req_duration",
        label: "HTTP Request Duration",
        type: "trend",
        unit: "ms",
        desc: "All HTTP request response times",
      },
      {
        key: "http_req_failed",
        label: "HTTP Failure Rate",
        type: "rate",
        desc: "Percentage of failed HTTP requests",
      },
    ],
  };
  return defs[scenarioName] || [];
}

// ─── Throughput Calculator ────────────────────────────────────

function computeThroughput(data, scenarioName, durationSec) {
  const items = [];
  if (durationSec <= 0) return items;

  const iterCount = extractMetric(data, "iterations");
  if (iterCount && iterCount.count) {
    items.push({
      label: "Iterations / sec",
      value: fmt(iterCount.count / durationSec, 1),
    });
  }

  const httpReqs = extractMetric(data, "http_reqs");
  if (httpReqs && httpReqs.count) {
    items.push({
      label: "HTTP Requests / sec",
      value: fmt(httpReqs.count / durationSec, 1),
    });
  }

  if (scenarioName === "message-hub" || scenarioName === "full-flow") {
    const sent = extractMetric(data, "messages_sent");
    if (sent && sent.count) {
      items.push({
        label: "Messages / sec (sent)",
        value: fmt(sent.count / durationSec, 1),
      });
    }
    const recv = extractMetric(data, "messages_received");
    if (recv && recv.count) {
      items.push({
        label: "Messages / sec (received)",
        value: fmt(recv.count / durationSec, 1),
      });
    }
  }

  if (scenarioName === "presence-hub" || scenarioName === "presence-stress") {
    const checks = extractMetric(
      data,
      scenarioName === "presence-stress"
        ? "presence_checks_total"
        : "is_user_online_checks",
    );
    if (checks && checks.count) {
      items.push({
        label: "Presence Checks / sec",
        value: fmt(checks.count / durationSec, 1),
      });
    }
  }

  if (scenarioName === "chat-offers") {
    const sent = extractMetric(data, "messages_sent");
    if (sent && sent.count) {
      items.push({
        label: "Messages / sec (sent)",
        value: fmt(sent.count / durationSec, 1),
      });
    }
    const created = extractMetric(data, "offers_created");
    if (created && created.count) {
      items.push({
        label: "Offers / sec (created)",
        value: fmt(created.count / durationSec, 1),
      });
    }
    const accepted = extractMetric(data, "offers_accepted");
    if (accepted && accepted.count) {
      items.push({
        label: "Offers / sec (accepted)",
        value: fmt(accepted.count / durationSec, 1),
      });
    }
  }

  return items;
}

// ─── Recommendations Engine ───────────────────────────────────

function generateRecommendations(data, scenarioName, thresholdResults) {
  const recs = [];
  const failedThresholds = thresholdResults.filter((t) => !t.passed);

  if (failedThresholds.length > 0) {
    recs.push({
      severity: "critical",
      text: `${failedThresholds.length} threshold(s) FAILED: ${failedThresholds.map((t) => t.metric).join(", ")}. Investigate before increasing load.`,
    });
  }

  const wsErr = extractMetric(data, "ws_errors");
  if (wsErr && wsErr.rate > 0.05) {
    recs.push({
      severity: "critical",
      text: `WebSocket error rate is ${fmtRate(wsErr.rate)} (>${fmtRate(0.05)}). Check server logs for connection rejections, auth failures, or resource exhaustion.`,
    });
  } else if (wsErr && wsErr.rate > 0.01) {
    recs.push({
      severity: "warning",
      text: `WebSocket error rate is ${fmtRate(wsErr.rate)}. Marginal — monitor closely at higher load.`,
    });
  }

  const wsConn = extractMetric(data, "ws_connecting_duration");
  if (wsConn && wsConn["p(95)"] > 3000) {
    recs.push({
      severity: "warning",
      text: `WebSocket connect p(95) is ${fmtMs(wsConn["p(95)"])}. Consider checking TLS overhead, load balancer config, or network latency.`,
    });
  }

  const handshake = extractMetric(data, "ws_handshake_duration");
  if (handshake && handshake["p(95)"] > 2000) {
    recs.push({
      severity: "warning",
      text: `SignalR handshake p(95) is ${fmtMs(handshake["p(95)"])}. May indicate server-side pressure during connection setup.`,
    });
  }

  if (scenarioName === "message-hub" || scenarioName === "full-flow") {
    const latency = extractMetric(data, "message_delivery_latency");
    if (latency && latency["p(95)"] > 2000) {
      recs.push({
        severity: "critical",
        text: `Message delivery p(95) is ${fmtMs(latency["p(95)"])}. The SendMessage handler or database may be a bottleneck.`,
      });
    }

    const sent = extractMetric(data, "messages_sent");
    const recv = extractMetric(data, "messages_received");
    if (sent && recv && sent.count > 0) {
      const deliveryRate = recv.count / sent.count;
      if (deliveryRate < 0.9) {
        recs.push({
          severity: "critical",
          text: `Message delivery ratio is ${fmtRate(deliveryRate)} (${fmtCount(recv.count)} received / ${fmtCount(sent.count)} sent). Messages are being lost.`,
        });
      }
    }
  }

  if (scenarioName === "presence-stress") {
    const onlineRate = extractMetric(data, "presence_online_rate");
    if (onlineRate && onlineRate.rate < 0.8) {
      recs.push({
        severity: "critical",
        text: `Presence online rate is ${fmtRate(onlineRate.rate)}. Redis presence tracking is unreliable — check Heartbeat TTL alignment and Redis performance.`,
      });
    }
  }

  const httpFail = extractMetric(data, "http_req_failed");
  if (httpFail && httpFail.rate > 0.05) {
    recs.push({
      severity: "critical",
      text: `HTTP failure rate is ${fmtRate(httpFail.rate)}. Negotiate endpoint may be rejecting connections under load.`,
    });
  }

  if (recs.length === 0) {
    recs.push({
      severity: "info",
      text: "All metrics within acceptable ranges. Consider testing at the next load stage to find breaking points.",
    });
  }

  return recs;
}

// ─── HTML Generator ───────────────────────────────────────────

function scenarioLabel(name) {
  const labels = {
    "presence-hub": "Presence Hub — Connection Lifecycle",
    "message-hub": "Message Hub — Chat Flow",
    "full-flow": "Full Flow — E2E Buyer ↔ Seller",
    "presence-stress": "Presence Stress — Redis Tracking",
    "notification-broadcast": "Notification Broadcast — Event Delivery",
    "chat-offers": "Chat + Offers — Full Lifecycle",
  };
  return labels[name] || name;
}

/**
 * Generate a professional HTML load test report.
 *
 * @param {object} data         - k6 handleSummary data object
 * @param {object} opts
 * @param {string} opts.scenario - Scenario name (e.g. "presence-hub")
 * @param {string} opts.stage    - Stage name (e.g. "smoke")
 * @returns {object} k6 handleSummary return value (stdout + file outputs)
 */
export function generateReport(data, opts) {
  const scenario = opts.scenario;
  const stageName = opts.stage || "smoke";
  const now = new Date().toISOString();
  // k6's JS runtime doesn't support toLocaleString with options
  const d = new Date();
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const nowDisplay = `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}, ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;

  const maxVUs = getMaxVUsFromStage(stageName);
  const plannedDurationSec = getStageDuration(stageName);
  // Use actual test duration when available (important for breakpoint tests
  // that abort early). Fall back to planned stage duration.
  const actualDurationSec = getTestDurationSec(data);
  const durationSec =
    actualDurationSec > 0 ? actualDurationSec : plannedDurationSec;
  const durationDisplay =
    durationSec >= 60
      ? `${Math.round(durationSec / 60)} min`
      : `${durationSec}s`;

  // Evaluate thresholds
  const thresholdResults = evaluateThresholds(data);
  const failedCount = thresholdResults.filter((t) => !t.passed).length;
  const passedCount = thresholdResults.filter((t) => t.passed).length;
  const overallPass = failedCount === 0;

  // Metrics
  const metricDefs = buildMetricDefinitions(scenario);

  // Throughput
  const throughput = computeThroughput(data, scenario, durationSec);

  // Recommendations
  const recs = generateRecommendations(data, scenario, thresholdResults);

  // Build the k6 default summary text (iterations, vus, checks, etc.)
  const iterMetric = extractMetric(data, "iterations");
  const vusMax = extractMetric(data, "vus_max");
  const checks = data.root_group ? data.root_group.checks : {};

  // ─── Build HTML ────────────────────────────────────────
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Load Test Report — ${escHtml(scenarioLabel(scenario))}</title>
<style>
  :root {
    --pass: #22c55e; --fail: #ef4444; --warn: #f59e0b; --info: #3b82f6;
    --bg: #0f172a; --surface: #1e293b; --surface2: #334155;
    --text: #f1f5f9; --text2: #94a3b8; --border: #475569;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', monospace; background: var(--bg); color: var(--text); padding: 24px; line-height: 1.6; }
  .container { max-width: 1100px; margin: 0 auto; }
  h1 { font-size: 1.6rem; font-weight: 700; margin-bottom: 4px; }
  h2 { font-size: 1.15rem; font-weight: 600; margin: 32px 0 12px; padding-bottom: 8px; border-bottom: 1px solid var(--border); }
  h3 { font-size: 0.95rem; font-weight: 600; margin: 16px 0 8px; color: var(--text2); }

  /* Header */
  .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 24px; flex-wrap: wrap; gap: 16px; }
  .header-left h1 { color: var(--text); }
  .header-left .subtitle { color: var(--text2); font-size: 0.85rem; }

  /* Badge */
  .badge { display: inline-block; padding: 6px 20px; border-radius: 6px; font-weight: 700; font-size: 1.1rem; letter-spacing: 1px; }
  .badge-pass { background: var(--pass); color: #000; }
  .badge-fail { background: var(--fail); color: #fff; }

  /* Cards */
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 16px 20px; margin-bottom: 16px; }
  .card-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
  .stat-card { background: var(--surface2); border-radius: 6px; padding: 14px 16px; }
  .stat-label { font-size: 0.75rem; color: var(--text2); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; }
  .stat-value { font-size: 1.4rem; font-weight: 700; }
  .stat-sub { font-size: 0.7rem; color: var(--text2); margin-top: 2px; }

  /* Tables */
  table { width: 100%; border-collapse: collapse; font-size: 0.82rem; }
  th { text-align: left; padding: 10px 12px; background: var(--surface2); color: var(--text2); font-weight: 600; text-transform: uppercase; font-size: 0.7rem; letter-spacing: 0.5px; }
  td { padding: 8px 12px; border-bottom: 1px solid var(--border); }
  tr:last-child td { border-bottom: none; }
  .text-right { text-align: right; }
  .text-center { text-align: center; }

  /* Threshold indicators */
  .th-pass { color: var(--pass); font-weight: 700; }
  .th-fail { color: var(--fail); font-weight: 700; }

  /* Severity */
  .sev-critical { border-left: 4px solid var(--fail); padding-left: 12px; margin-bottom: 8px; }
  .sev-warning  { border-left: 4px solid var(--warn); padding-left: 12px; margin-bottom: 8px; }
  .sev-info     { border-left: 4px solid var(--info); padding-left: 12px; margin-bottom: 8px; }
  .sev-label { font-size: 0.7rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; }
  .sev-label-critical { color: var(--fail); }
  .sev-label-warning  { color: var(--warn); }
  .sev-label-info     { color: var(--info); }

  /* Config list */
  .config-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 8px 24px; }
  .config-item { display: flex; justify-content: space-between; padding: 4px 0; border-bottom: 1px dotted var(--border); }
  .config-key { color: var(--text2); font-size: 0.8rem; }
  .config-val { font-weight: 600; font-size: 0.8rem; }

  /* Footer */
  .footer { margin-top: 32px; padding-top: 16px; border-top: 1px solid var(--border); color: var(--text2); font-size: 0.7rem; text-align: center; }

  @media print {
    body { background: #fff; color: #000; }
    .card { border-color: #ccc; }
    .stat-card { background: #f0f0f0; }
    .badge-pass { background: #22c55e; }
    .badge-fail { background: #ef4444; }
  }
</style>
</head>
<body>
<div class="container">

<!-- ═══ HEADER ══════════════════════════════════════════════ -->
<div class="header">
  <div class="header-left">
    <h1>C2C SignalR Load Test Report</h1>
    <div class="subtitle">${escHtml(scenarioLabel(scenario))}</div>
  </div>
  <div>
    <span class="badge ${overallPass ? "badge-pass" : "badge-fail"}">${overallPass ? "✓ ALL PASSED" : "✗ FAILED"}</span>
  </div>
</div>

<!-- ═══ TEST CONFIGURATION ═════════════════════════════════ -->
<div class="card">
  <h3>Test Configuration</h3>
  <div class="config-grid">
    <div class="config-item"><span class="config-key">Target</span><span class="config-val">${escHtml(BASE_URL)}</span></div>
    <div class="config-item"><span class="config-key">Scenario</span><span class="config-val">${escHtml(scenario)}</span></div>
    <div class="config-item"><span class="config-key">Stage</span><span class="config-val">${escHtml(stageName)}</span></div>
    <div class="config-item"><span class="config-key">Max VUs</span><span class="config-val">${maxVUs}</span></div>
    <div class="config-item"><span class="config-key">Duration</span><span class="config-val">${durationDisplay}</span></div>
    <div class="config-item"><span class="config-key">Timestamp</span><span class="config-val">${escHtml(nowDisplay)}</span></div>
    <div class="config-item"><span class="config-key">Total Iterations</span><span class="config-val">${iterMetric ? fmtCount(iterMetric.count) : "—"}</span></div>
    <div class="config-item"><span class="config-key">Peak VUs</span><span class="config-val">${vusMax ? fmtCount(vusMax.max) : "—"}</span></div>
  </div>
</div>

<!-- ═══ EXECUTIVE SUMMARY ══════════════════════════════════ -->
<h2>Executive Summary</h2>
<div class="card-grid">
  <div class="stat-card">
    <div class="stat-label">Thresholds</div>
    <div class="stat-value" style="color: ${overallPass ? "var(--pass)" : "var(--fail)"}">${passedCount} / ${passedCount + failedCount}</div>
    <div class="stat-sub">${failedCount === 0 ? "All passed" : failedCount + " failed"}</div>
  </div>
${buildExecutiveSummaryCards(data, scenario)}
</div>

<!-- ═══ THROUGHPUT ══════════════════════════════════════════ -->
${
  throughput.length > 0
    ? `
<h2>Throughput</h2>
<div class="card-grid">
${throughput
  .map(
    (t) => `  <div class="stat-card">
    <div class="stat-label">${escHtml(t.label)}</div>
    <div class="stat-value">${escHtml(t.value)}</div>
  </div>`,
  )
  .join("\n")}
</div>`
    : ""
}

<!-- ═══ THRESHOLD RESULTS ══════════════════════════════════ -->
<h2>Threshold Results</h2>
<div class="card">
<table>
  <thead><tr><th>Metric</th><th>Threshold</th><th class="text-center">Result</th></tr></thead>
  <tbody>
${thresholdResults
  .map(
    (t) => `    <tr>
      <td>${escHtml(t.metric)}</td>
      <td><code>${escHtml(t.threshold)}</code></td>
      <td class="text-center ${t.passed ? "th-pass" : "th-fail"}">${t.passed ? "✓ PASS" : "✗ FAIL"}</td>
    </tr>`,
  )
  .join("\n")}
${thresholdResults.length === 0 ? '    <tr><td colspan="3" class="text-center" style="color:var(--text2)">No thresholds defined</td></tr>' : ""}
  </tbody>
</table>
</div>

<!-- ═══ DETAILED METRICS ═══════════════════════════════════ -->
<h2>Detailed Metrics</h2>
${buildDetailedMetricsTable(data, metricDefs)}

<!-- ═══ RECOMMENDATIONS ════════════════════════════════════ -->
<h2>Recommendations</h2>
<div class="card">
${recs
  .map(
    (r) => `  <div class="sev-${r.severity}">
    <div class="sev-label sev-label-${r.severity}">${r.severity.toUpperCase()}</div>
    <div>${escHtml(r.text)}</div>
  </div>`,
  )
  .join("\n")}
</div>

<!-- ═══ CHECKS ═════════════════════════════════════════════ -->
${buildChecksSection(data)}

<div class="footer">
  Generated by C2C Load Test Suite · ${escHtml(now)}
</div>

</div>
</body>
</html>`;

  // Also produce a compact JSON summary for programmatic use
  const jsonSummary = {
    scenario: scenario,
    stage: stageName,
    timestamp: now,
    target: BASE_URL,
    maxVUs: maxVUs,
    durationSec: durationSec,
    overallPass: overallPass,
    thresholds: {
      passed: passedCount,
      failed: failedCount,
      details: thresholdResults,
    },
    throughput: throughput,
    recommendations: recs,
    metrics: {},
  };

  for (const def of metricDefs) {
    const m = extractMetric(data, def.key);
    if (m) jsonSummary.metrics[def.key] = m;
  }

  // Return both HTML and JSON files, plus text summary to stdout
  const reportBaseName = `${scenario}_${stageName}`;
  return {
    [`./results/${reportBaseName}_report.html`]: html,
    [`./results/${reportBaseName}_report.json`]: JSON.stringify(
      jsonSummary,
      null,
      2,
    ),
    stdout: buildTextSummary(
      scenario,
      stageName,
      overallPass,
      thresholdResults,
      throughput,
      recs,
      data,
      metricDefs,
    ),
  };
}

// ─── Text Summary (stdout) ───────────────────────────────────

function buildTextSummary(
  scenario,
  stageName,
  overallPass,
  thresholds,
  throughput,
  recs,
  data,
  metricDefs,
) {
  const lines = [];
  lines.push("");
  lines.push(
    "╔══════════════════════════════════════════════════════════════╗",
  );
  lines.push(`║  C2C LOAD TEST REPORT                                       ║`);
  lines.push(
    "╠══════════════════════════════════════════════════════════════╣",
  );
  lines.push(`║  Scenario:  ${scenarioLabel(scenario).padEnd(48)}║`);
  lines.push(`║  Stage:     ${stageName.padEnd(48)}║`);
  lines.push(`║  Target:    ${BASE_URL.padEnd(48)}║`);
  lines.push(
    `║  Result:    ${overallPass ? "✓ ALL THRESHOLDS PASSED" : "✗ THRESHOLD(S) FAILED"}`.padEnd(
      63,
    ) + "║",
  );
  lines.push(
    "╚══════════════════════════════════════════════════════════════╝",
  );
  lines.push("");

  // Thresholds
  lines.push("─── Thresholds ──────────────────────────────────────────────");
  for (const t of thresholds) {
    const icon = t.passed ? "✓" : "✗";
    lines.push(
      `  ${icon} ${t.metric.padEnd(35)} ${t.threshold.padEnd(20)} ${t.passed ? "PASS" : "FAIL"}`,
    );
  }
  lines.push("");

  // Key metrics
  lines.push("─── Key Metrics ─────────────────────────────────────────────");
  for (const def of metricDefs) {
    const m = extractMetric(data, def.key);
    if (!m) continue;
    if (def.type === "trend") {
      lines.push(
        `  ${def.label.padEnd(30)} avg=${fmtMs(m.avg).padEnd(10)} p50=${fmtMs(m.med).padEnd(10)} p95=${fmtMs(m["p(95)"])}`,
      );
    } else if (def.type === "rate") {
      lines.push(`  ${def.label.padEnd(30)} ${fmtRate(m.rate)}`);
    } else if (def.type === "counter") {
      lines.push(`  ${def.label.padEnd(30)} ${fmtCount(m.count)}`);
    }
  }
  lines.push("");

  // Throughput
  if (throughput.length > 0) {
    lines.push("─── Throughput ──────────────────────────────────────────────");
    for (const t of throughput) {
      lines.push(`  ${t.label.padEnd(30)} ${t.value}`);
    }
    lines.push("");
  }

  // Recommendations
  lines.push("─── Recommendations ─────────────────────────────────────────");
  for (const r of recs) {
    const prefix =
      r.severity === "critical" ? "🔴" : r.severity === "warning" ? "🟡" : "🟢";
    lines.push(`  ${prefix} ${r.text}`);
  }
  lines.push("");
  lines.push("─── Report files saved to ./results/ directory ─────────────");
  lines.push("");

  return lines.join("\n");
}

// ─── Detail Builder Helpers ───────────────────────────────────

function buildExecutiveSummaryCards(data, scenario) {
  const cards = [];

  // WS Error Rate
  const wsErr = extractMetric(data, "ws_errors");
  if (wsErr) {
    const color =
      wsErr.rate < 0.01
        ? "var(--pass)"
        : wsErr.rate < 0.05
          ? "var(--warn)"
          : "var(--fail)";
    cards.push(
      statCard("Error Rate", fmtRate(wsErr.rate), "WebSocket errors", color),
    );
  }

  // WS Connect p95
  const wsConn = extractMetric(data, "ws_connecting_duration");
  if (wsConn) {
    const color = wsConn["p(95)"] < 2000 ? "var(--pass)" : "var(--warn)";
    cards.push(
      statCard(
        "Connect p95",
        fmtMs(wsConn["p(95)"]),
        "WebSocket connect time",
        color,
      ),
    );
  }

  // Handshake p95
  const hs = extractMetric(data, "ws_handshake_duration");
  if (hs) {
    const color = hs["p(95)"] < 1000 ? "var(--pass)" : "var(--warn)";
    cards.push(
      statCard("Handshake p95", fmtMs(hs["p(95)"]), "SignalR handshake", color),
    );
  }

  // Scenario-specific
  if (scenario === "message-hub" || scenario === "full-flow") {
    const lat = extractMetric(data, "message_delivery_latency");
    if (lat) {
      const color = lat["p(95)"] < 2000 ? "var(--pass)" : "var(--fail)";
      cards.push(
        statCard(
          "Msg Delivery p95",
          fmtMs(lat["p(95)"]),
          "SendMessage → completion",
          color,
        ),
      );
    }
    const sent = extractMetric(data, "messages_sent");
    const recv = extractMetric(data, "messages_received");
    if (sent && recv) {
      const ratio = sent.count > 0 ? recv.count / sent.count : 0;
      const color =
        ratio > 0.95
          ? "var(--pass)"
          : ratio > 0.8
            ? "var(--warn)"
            : "var(--fail)";
      cards.push(
        statCard(
          "Delivery Ratio",
          fmtRate(ratio),
          `${fmtCount(recv.count)} / ${fmtCount(sent.count)}`,
          color,
        ),
      );
    }
  }

  if (scenario === "presence-stress") {
    const rate = extractMetric(data, "presence_online_rate");
    if (rate) {
      const color =
        rate.rate > 0.9
          ? "var(--pass)"
          : rate.rate > 0.8
            ? "var(--warn)"
            : "var(--fail)";
      cards.push(
        statCard(
          "Online Rate",
          fmtRate(rate.rate),
          "IsUserOnline accuracy",
          color,
        ),
      );
    }
    const lat = extractMetric(data, "presence_check_latency");
    if (lat) {
      const color = lat["p(95)"] < 2000 ? "var(--pass)" : "var(--fail)";
      cards.push(
        statCard(
          "Check p95",
          fmtMs(lat["p(95)"]),
          "IsUserOnline latency",
          color,
        ),
      );
    }
  }

  return cards.join("\n");
}

function statCard(label, value, sub, color) {
  return `  <div class="stat-card">
    <div class="stat-label">${escHtml(label)}</div>
    <div class="stat-value" style="color: ${color || "var(--text)"}">${escHtml(value)}</div>
    <div class="stat-sub">${escHtml(sub || "")}</div>
  </div>`;
}

function buildDetailedMetricsTable(data, metricDefs) {
  const trendDefs = metricDefs.filter((d) => d.type === "trend");
  const rateDefs = metricDefs.filter((d) => d.type === "rate");
  const counterDefs = metricDefs.filter((d) => d.type === "counter");

  let html = "";

  if (trendDefs.length > 0) {
    html += `<div class="card">
<h3>Latency / Duration Metrics</h3>
<table>
  <thead><tr><th>Metric</th><th class="text-right">Avg</th><th class="text-right">Min</th><th class="text-right">p50</th><th class="text-right">p90</th><th class="text-right">p95</th><th class="text-right">p99</th><th class="text-right">Max</th></tr></thead>
  <tbody>
${trendDefs
  .map((d) => {
    const m = extractMetric(data, d.key);
    if (!m)
      return `    <tr><td>${escHtml(d.label)}</td><td colspan="7" class="text-center" style="color:var(--text2)">No data</td></tr>`;
    return `    <tr>
      <td title="${escHtml(d.desc)}">${escHtml(d.label)}</td>
      <td class="text-right">${fmtMs(m.avg)}</td>
      <td class="text-right">${fmtMs(m.min)}</td>
      <td class="text-right">${fmtMs(m.med)}</td>
      <td class="text-right">${fmtMs(m["p(90)"])}</td>
      <td class="text-right">${fmtMs(m["p(95)"])}</td>
      <td class="text-right">${fmtMs(m["p(99)"])}</td>
      <td class="text-right">${fmtMs(m.max)}</td>
    </tr>`;
  })
  .join("\n")}
  </tbody>
</table>
</div>\n`;
  }

  if (rateDefs.length > 0 || counterDefs.length > 0) {
    html += `<div class="card">
<h3>Rates &amp; Counters</h3>
<table>
  <thead><tr><th>Metric</th><th>Description</th><th class="text-right">Value</th></tr></thead>
  <tbody>
${rateDefs
  .map((d) => {
    const m = extractMetric(data, d.key);
    if (!m)
      return `    <tr><td>${escHtml(d.label)}</td><td>${escHtml(d.desc)}</td><td class="text-right" style="color:var(--text2)">—</td></tr>`;
    const color =
      m.rate < 0.01
        ? "var(--pass)"
        : m.rate < 0.05
          ? "var(--warn)"
          : "var(--fail)";
    return `    <tr>
      <td>${escHtml(d.label)}</td>
      <td style="color:var(--text2)">${escHtml(d.desc)}</td>
      <td class="text-right" style="color:${color};font-weight:700">${fmtRate(m.rate)}</td>
    </tr>`;
  })
  .join("\n")}
${counterDefs
  .map((d) => {
    const m = extractMetric(data, d.key);
    if (!m)
      return `    <tr><td>${escHtml(d.label)}</td><td>${escHtml(d.desc)}</td><td class="text-right" style="color:var(--text2)">—</td></tr>`;
    return `    <tr>
      <td>${escHtml(d.label)}</td>
      <td style="color:var(--text2)">${escHtml(d.desc)}</td>
      <td class="text-right" style="font-weight:700">${fmtCount(m.count)}</td>
    </tr>`;
  })
  .join("\n")}
  </tbody>
</table>
</div>\n`;
  }

  return html;
}

function buildChecksSection(data) {
  // Extract check results from root_group
  if (!data.root_group) return "";
  const allChecks = [];
  collectChecks(data.root_group, allChecks);
  if (allChecks.length === 0) return "";

  let html = `<h2>Checks</h2>
<div class="card">
<table>
  <thead><tr><th>Check</th><th class="text-right">Passes</th><th class="text-right">Failures</th><th class="text-right">Rate</th></tr></thead>
  <tbody>
`;

  for (const c of allChecks) {
    const total = c.passes + c.fails;
    const rate = total > 0 ? c.passes / total : 0;
    const color =
      rate >= 1.0 ? "var(--pass)" : rate > 0.9 ? "var(--warn)" : "var(--fail)";
    html += `    <tr>
      <td>${escHtml(c.name)}</td>
      <td class="text-right">${fmtCount(c.passes)}</td>
      <td class="text-right" style="color: ${c.fails > 0 ? "var(--fail)" : "var(--text2)"}">${fmtCount(c.fails)}</td>
      <td class="text-right" style="color: ${color}; font-weight: 700">${fmtRate(rate)}</td>
    </tr>\n`;
  }

  html += `  </tbody>
</table>
</div>`;
  return html;
}

function collectChecks(group, arr) {
  if (group.checks) {
    for (const [name, check] of Object.entries(group.checks)) {
      arr.push({
        name: check.name || name,
        passes: check.passes || 0,
        fails: check.fails || 0,
      });
    }
  }
  if (group.groups) {
    for (const [, sub] of Object.entries(group.groups)) {
      collectChecks(sub, arr);
    }
  }
}

function escHtml(str) {
  if (typeof str !== "string") str = String(str);
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
