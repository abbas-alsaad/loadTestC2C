/**
 * Enhanced HTML Report Generator for k6 Load Tests
 *
 * Generates a self-contained, human-friendly HTML report with:
 *   - Plain-English "What Happened" narrative
 *   - Health verdicts per area (Connection / Chat / API / Presence)
 *   - Executive summary cards with color coding
 *   - Grouped threshold results with descriptions
 *   - Detailed metric tables (p50/p90/p95/p99/max)
 *   - Throughput calculations
 *   - Smart recommendations with context and next-steps
 *
 * Usage:
 *   import { generateReport } from "../helpers/report.js";
 *   export function handleSummary(data) {
 *     return generateReport(data, { scenario, stage });
 *   }
 */

import { BASE_URL, STAGES } from "../config.js";

// ════════════════════════════════════════════════════════════════
// FORMATTING HELPERS
// ════════════════════════════════════════════════════════════════

function fmt(n, decimals) {
  if (n === undefined || n === null || isNaN(n)) return "\u2014";
  const d = decimals !== undefined ? decimals : 2;
  if (Math.abs(n) >= 1000000) return (n / 1000000).toFixed(1) + "M";
  if (Math.abs(n) >= 10000) return (n / 1000).toFixed(1) + "K";
  return Number(n).toFixed(d);
}

function fmtMs(n) {
  if (n === undefined || n === null || isNaN(n)) return "\u2014";
  if (n >= 60000) return (n / 60000).toFixed(1) + " min";
  if (n >= 1000) return (n / 1000).toFixed(2) + " s";
  return n.toFixed(1) + " ms";
}

function fmtRate(n) {
  if (n === undefined || n === null || isNaN(n)) return "\u2014";
  return (n * 100).toFixed(2) + "%";
}

function fmtCount(n) {
  if (n === undefined || n === null || isNaN(n)) return "\u2014";
  const str = Math.round(n).toString();
  const parts = [];
  for (let i = str.length; i > 0; i -= 3) {
    parts.unshift(str.slice(Math.max(0, i - 3), i));
  }
  return parts.join(",");
}

function fmtNum(n) {
  if (n >= 1000) return (n / 1000).toFixed(1) + "K";
  return String(n);
}

function fmtDuration(sec) {
  if (sec >= 3600) return (sec / 3600).toFixed(1) + "h";
  if (sec >= 60) return Math.round(sec / 60) + " min";
  return sec + "s";
}

function escHtml(str) {
  if (typeof str !== "string") str = String(str);
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ════════════════════════════════════════════════════════════════
// DATA HELPERS
// ════════════════════════════════════════════════════════════════

function getTestDurationSec(data) {
  if (data.state && data.state.testRunDurationMs) {
    return data.state.testRunDurationMs / 1000;
  }
  const iters = data.metrics["iterations"];
  if (iters && iters.values && iters.values.count) {
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

function evaluateThresholds(data) {
  const results = [];
  for (const metricName of Object.keys(data.metrics)) {
    const metric = data.metrics[metricName];
    if (metric.thresholds) {
      for (const expr of Object.keys(metric.thresholds)) {
        const result = metric.thresholds[expr];
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

function extractMetric(data, name) {
  const m = data.metrics[name];
  if (!m || !m.values) return null;
  return m.values;
}

// ════════════════════════════════════════════════════════════════
// HEALTH VERDICT ENGINE
// ════════════════════════════════════════════════════════════════

function computeConnectionHealth(data) {
  var wsErr = extractMetric(data, "ws_errors");
  var wsConn = extractMetric(data, "ws_connecting_duration");
  var hs = extractMetric(data, "ws_handshake_duration");
  var hsRate = extractMetric(data, "ws_handshake_success_rate");
  var hsFails = extractMetric(data, "handshake_failures");

  var errRate = wsErr ? wsErr.rate : 0;
  var connP95 = wsConn ? wsConn["p(95)"] : 0;
  var hsP95 = hs ? hs["p(95)"] : 0;
  var hsSuccessRate = hsRate ? hsRate.rate : 1;
  var failCount = hsFails ? hsFails.count : 0;

  if (errRate > 0.05 || hsSuccessRate < 0.90 || failCount > 20) {
    return {
      verdict: "critical", icon: "\uD83D\uDD34", color: "var(--fail)",
      summary: "Connection failures are high (" + fmtRate(errRate) + " error rate, " + fmtCount(failCount) + " handshake failures). Server may be rejecting connections under load.",
    };
  }
  if (errRate > 0.01 || connP95 > 3000 || hsP95 > 2000 || failCount > 5) {
    return {
      verdict: "degraded", icon: "\uD83D\uDFE1", color: "var(--warn)",
      summary: "Connections mostly succeed but with some pressure (" + fmtRate(errRate) + " errors, connect p95=" + fmtMs(connP95) + ", handshake p95=" + fmtMs(hsP95) + ").",
    };
  }
  return {
    verdict: "healthy", icon: "\uD83D\uDFE2", color: "var(--pass)",
    summary: "All connections established successfully. Error rate " + fmtRate(errRate) + ", connect p95=" + fmtMs(connP95) + ", handshake p95=" + fmtMs(hsP95) + ".",
  };
}

function computeChatHealth(data) {
  var sent = extractMetric(data, "messages_sent");
  var deliveredKey = data.metrics["messages_delivered"] ? "messages_delivered" : "messages_received";
  var delivered = extractMetric(data, deliveredKey);
  var latency = extractMetric(data, "message_delivery_latency");
  var contentMatch = extractMetric(data, "message_content_match");
  var readReceipt = extractMetric(data, "read_receipt_match");

  if (!sent || !delivered) return null;

  var deliveryRatio = sent.count > 0 ? delivered.count / sent.count : 0;
  var latP95 = latency ? latency["p(95)"] : 0;
  var matchRate = contentMatch ? contentMatch.rate : 1;
  var readRate = readReceipt ? readReceipt.rate : null;

  if (deliveryRatio < 0.8 || matchRate < 0.8) {
    return {
      verdict: "critical", icon: "\uD83D\uDD34", color: "var(--fail)",
      summary: "Messages are being lost! Only " + fmtRate(deliveryRatio) + " delivered (" + fmtCount(delivered.count) + "/" + fmtCount(sent.count) + "). Content match: " + fmtRate(matchRate) + ".",
    };
  }
  if (deliveryRatio < 0.95 || latP95 > 2000 || matchRate < 0.9) {
    var s = "Chat is under pressure. Delivery: " + fmtRate(deliveryRatio) + ", latency p95: " + fmtMs(latP95) + ".";
    if (readRate !== null && readRate < 0.9) s += " Read receipt match: " + fmtRate(readRate) + ".";
    return { verdict: "degraded", icon: "\uD83D\uDFE1", color: "var(--warn)", summary: s };
  }
  var s2 = "Chat working well. " + fmtCount(sent.count) + " sent, " + fmtCount(delivered.count) + " delivered (" + fmtRate(deliveryRatio) + "). Latency p95: " + fmtMs(latP95) + ".";
  if (readRate !== null) s2 += " Read receipts: " + fmtRate(readRate) + ".";
  return { verdict: "healthy", icon: "\uD83D\uDFE2", color: "var(--pass)", summary: s2 };
}

function computeApiHealth(data) {
  var browseErr = extractMetric(data, "browse_errors");
  var browseLat = extractMetric(data, "browse_items_latency");
  var httpFail = extractMetric(data, "http_req_failed");

  if (!browseErr && !httpFail) return null;

  var errRate = browseErr ? browseErr.rate : (httpFail ? httpFail.rate : 0);
  var latP95 = browseLat ? browseLat["p(95)"] : 0;

  if (errRate > 0.05) {
    return {
      verdict: "critical", icon: "\uD83D\uDD34", color: "var(--fail)",
      summary: "REST API is failing under load. Error rate: " + fmtRate(errRate) + ". Browse items p95: " + fmtMs(latP95) + ".",
    };
  }
  if (errRate > 0.01 || latP95 > 3000) {
    return {
      verdict: "degraded", icon: "\uD83D\uDFE1", color: "var(--warn)",
      summary: "API responds but with some errors (" + fmtRate(errRate) + ") or slow responses (browse p95: " + fmtMs(latP95) + ").",
    };
  }
  return {
    verdict: "healthy", icon: "\uD83D\uDFE2", color: "var(--pass)",
    summary: "API healthy. Error rate: " + fmtRate(errRate) + ", browse items p95: " + fmtMs(latP95) + ".",
  };
}

function computePresenceHealth(data) {
  var onlineRate = extractMetric(data, "presence_online_rate");
  var checkLat = extractMetric(data, "presence_check_latency");
  var hbAckLat = extractMetric(data, "heartbeat_ack_latency");
  var iuoLat = extractMetric(data, "is_user_online_latency");

  if (!onlineRate && !hbAckLat && !iuoLat) return null;

  if (onlineRate && onlineRate.rate < 0.8) {
    return {
      verdict: "critical", icon: "\uD83D\uDD34", color: "var(--fail)",
      summary: "Presence tracking unreliable \u2014 only " + fmtRate(onlineRate.rate) + " of users found online. Check Redis TTL and Heartbeat alignment.",
    };
  }

  var latVal = checkLat ? checkLat["p(95)"] : (iuoLat ? iuoLat["p(95)"] : (hbAckLat ? hbAckLat["p(95)"] : 0));
  if (latVal > 2000) {
    return {
      verdict: "degraded", icon: "\uD83D\uDFE1", color: "var(--warn)",
      summary: "Presence latency elevated at p95=" + fmtMs(latVal) + "." + (onlineRate ? " Online rate: " + fmtRate(onlineRate.rate) + "." : ""),
    };
  }

  var s = "Presence system healthy.";
  if (onlineRate) s += " Online rate: " + fmtRate(onlineRate.rate) + ".";
  if (latVal > 0) s += " Latency p95: " + fmtMs(latVal) + ".";
  return { verdict: "healthy", icon: "\uD83D\uDFE2", color: "var(--pass)", summary: s };
}

// ════════════════════════════════════════════════════════════════
// NARRATIVE BUILDER
// ════════════════════════════════════════════════════════════════

function buildNarrative(data, scenario, stageName, maxVUs, durationSec, overallPass, trafficMix) {
  var parts = [];

  if (scenario === "realistic-load") {
    parts.push(
      "This test simulated <strong>" + fmtNum(maxVUs) + " concurrent users</strong> performing realistic marketplace actions for <strong>" + fmtDuration(durationSec) + "</strong>."
    );
    parts.push(
      "The traffic was split into 4 groups: <strong>75% chatting</strong> (sellers listening + buyers sending), <strong>20% browsing</strong> the REST API, and <strong>5% idle</strong> with background presence heartbeats."
    );
  } else if (scenario === "presence-hub-final" || scenario === "presence-hub") {
    parts.push(
      "This test connected <strong>" + fmtNum(maxVUs) + " users</strong> to the Presence Hub for <strong>" + fmtDuration(durationSec) + "</strong>, sending heartbeats and checking online status."
    );
  } else if (scenario === "chat-offers") {
    parts.push(
      "This test ran <strong>" + fmtNum(maxVUs) + " users</strong> through the full chat + offer lifecycle for <strong>" + fmtDuration(durationSec) + "</strong>."
    );
  } else {
    parts.push(
      "This test ran <strong>" + fmtNum(maxVUs) + " virtual users</strong> against the " + escHtml(scenario) + " scenario for <strong>" + fmtDuration(durationSec) + "</strong>."
    );
  }

  var iters = extractMetric(data, "iterations");
  var iterCount = iters ? iters.count : 0;
  if (overallPass) {
    parts.push(
      '<span style="color:var(--pass);font-weight:700">All thresholds passed.</span> The system completed <strong>' + fmtCount(iterCount) + " iterations</strong> without exceeding any performance limits."
    );
  } else {
    parts.push(
      '<span style="color:var(--fail);font-weight:700">Some thresholds were breached.</span> The system completed <strong>' + fmtCount(iterCount) + " iterations</strong> but hit performance limits. See details below."
    );
  }

  var sent = extractMetric(data, "messages_sent");
  var deliveredKey = data.metrics["messages_delivered"] ? "messages_delivered" : "messages_received";
  var delivered = extractMetric(data, deliveredKey);
  if (sent && delivered && sent.count > 0) {
    var ratio = delivered.count / sent.count;
    parts.push(
      "<strong>" + fmtCount(sent.count) + "</strong> messages were sent and <strong>" + fmtCount(delivered.count) + "</strong> were delivered cross-user (" + fmtRate(ratio) + " delivery rate)."
    );
  }

  var browseReqs = extractMetric(data, "browse_requests");
  if (browseReqs && browseReqs.count > 0) {
    parts.push("Browsers made <strong>" + fmtCount(browseReqs.count) + "</strong> REST API requests.");
  }

  return parts.join(" ");
}

// ════════════════════════════════════════════════════════════════
// THRESHOLD DESCRIPTIONS
// ════════════════════════════════════════════════════════════════

var THRESHOLD_DESCRIPTIONS = {
  ws_connecting_duration: "How fast WebSocket TCP+TLS connections are established",
  ws_handshake_duration: "How fast the SignalR JSON protocol handshake completes",
  ws_errors: "Percentage of WebSocket connections that failed",
  ws_handshake_success_rate: "Percentage of SignalR handshakes that succeeded",
  ws_session_ok_rate: "Percentage of sessions that stayed alive for full duration",
  heartbeat_ack_latency: "Round-trip time for server to acknowledge a heartbeat",
  is_user_online_latency: "Round-trip time for IsUserOnline hub call",
  message_delivery_latency: "Time from buyer sending a message to seller receiving it",
  message_content_match: "Messages arriving with correct content (verified via CID)",
  mark_read_latency: "Time for server to process mark-as-read and return completion",
  read_receipt_match: "Buyers that received a read-receipt back from the seller",
  handshake_failures: "Total number of handshake timeouts or errors",
  browse_items_latency: "Response time for the item listing API endpoint",
  browse_errors: "Percentage of REST API requests that returned errors",
  offer_creation_latency: "Response time for the create-offer REST API",
  http_req_duration: "Overall HTTP request response time",
  http_req_failed: "Overall HTTP failure rate across all endpoints",
  presence_online_rate: "Percentage of users found online via presence check",
  presence_check_latency: "Round-trip time for presence check",
};

// ════════════════════════════════════════════════════════════════
// METRIC DEFINITIONS PER SCENARIO
// ════════════════════════════════════════════════════════════════

function buildMetricDefinitions(scenarioName) {
  var defs = {
    "presence-hub": [
      { key: "ws_connecting_duration", label: "WebSocket Connect Time", type: "trend", unit: "ms", desc: "TCP + TLS connection establishment" },
      { key: "ws_handshake_duration", label: "SignalR Handshake Time", type: "trend", unit: "ms", desc: "SignalR JSON protocol handshake" },
      { key: "ws_session_duration", label: "Session Duration", type: "trend", unit: "ms", desc: "Total WebSocket session lifetime" },
      { key: "ws_errors", label: "WebSocket Error Rate", type: "rate", desc: "Percentage of failed connections" },
      { key: "ws_connections_opened", label: "Connections Opened", type: "counter", desc: "Total successful WebSocket connections" },
      { key: "ws_connections_closed", label: "Connections Closed", type: "counter", desc: "Total graceful disconnections" },
      { key: "heartbeats_sent", label: "Heartbeats Sent", type: "counter", desc: "Total Heartbeat() invocations (Redis TTL refresh)" },
      { key: "is_user_online_checks", label: "IsUserOnline Calls", type: "counter", desc: "Total IsUserOnline() invocations" },
      { key: "is_user_online_latency", label: "IsUserOnline Latency", type: "trend", unit: "ms", desc: "Round-trip time for IsUserOnline hub call" },
      { key: "http_req_duration", label: "HTTP Request Duration", type: "trend", unit: "ms", desc: "Negotiate endpoint response time" },
      { key: "http_req_failed", label: "HTTP Failure Rate", type: "rate", desc: "Percentage of failed HTTP requests" },
    ],
    "presence-hub-final": [
      { key: "ws_connecting_duration", label: "WebSocket Connect Time", type: "trend", unit: "ms", desc: "TCP + TLS connection establishment" },
      { key: "ws_handshake_duration", label: "SignalR Handshake Time", type: "trend", unit: "ms", desc: "SignalR JSON protocol handshake" },
      { key: "ws_session_duration", label: "Session Duration", type: "trend", unit: "ms", desc: "Total WebSocket session lifetime" },
      { key: "ws_errors", label: "WebSocket Error Rate", type: "rate", desc: "Percentage of failed connections" },
      { key: "ws_handshake_success_rate", label: "Handshake Success Rate", type: "rate", desc: "Percentage of handshakes that succeeded" },
      { key: "ws_session_ok_rate", label: "Session OK Rate", type: "rate", desc: "Sessions alive for full hold duration" },
      { key: "ws_connections_opened", label: "Connections Opened", type: "counter", desc: "Total WebSocket connections opened" },
      { key: "ws_connections_closed", label: "Connections Closed", type: "counter", desc: "Total disconnections" },
      { key: "heartbeats_sent", label: "Heartbeats Sent", type: "counter", desc: "Total Heartbeat() calls" },
      { key: "heartbeat_acks", label: "Heartbeat ACKs", type: "counter", desc: "Server-confirmed heartbeats (with invocationId)" },
      { key: "heartbeat_ack_latency", label: "Heartbeat ACK Latency", type: "trend", unit: "ms", desc: "Round-trip for heartbeat confirmation" },
      { key: "is_user_online_checks", label: "IsUserOnline Calls", type: "counter", desc: "Total IsUserOnline() invocations" },
      { key: "is_user_online_latency", label: "IsUserOnline Latency", type: "trend", unit: "ms", desc: "Round-trip time for IsUserOnline" },
      { key: "ws_close_1000", label: "Close 1000 (Normal)", type: "counter", desc: "Clean client-initiated close" },
      { key: "ws_close_1006", label: "Close 1006 (Abnormal)", type: "counter", desc: "Connection cut by ALB/proxy" },
      { key: "ws_close_1011", label: "Close 1011 (Server Error)", type: "counter", desc: "Server-side error close" },
      { key: "ws_close_other", label: "Close Other", type: "counter", desc: "Other close codes" },
    ],
    "message-hub": [
      { key: "ws_connecting_duration", label: "WebSocket Connect Time", type: "trend", unit: "ms", desc: "TCP + TLS establishment" },
      { key: "ws_handshake_duration", label: "SignalR Handshake Time", type: "trend", unit: "ms", desc: "SignalR handshake" },
      { key: "ws_session_duration", label: "Session Duration", type: "trend", unit: "ms", desc: "Session lifetime" },
      { key: "ws_errors", label: "WebSocket Error Rate", type: "rate", desc: "Failed connections" },
      { key: "messages_sent", label: "Messages Sent", type: "counter", desc: "Total SendMessage() calls" },
      { key: "messages_received", label: "Messages Received", type: "counter", desc: "Total NewMessage events" },
      { key: "message_delivery_latency", label: "Delivery Latency", type: "trend", unit: "ms", desc: "Send \u2192 receive latency" },
      { key: "message_thread_received", label: "Thread History", type: "counter", desc: "ReceiveMessageThread events" },
      { key: "http_req_duration", label: "HTTP Duration", type: "trend", unit: "ms", desc: "HTTP response time" },
      { key: "http_req_failed", label: "HTTP Failures", type: "rate", desc: "Failed HTTP requests" },
    ],
    "full-flow": [
      { key: "ws_connecting_duration", label: "WebSocket Connect Time", type: "trend", unit: "ms", desc: "TCP + TLS establishment" },
      { key: "ws_handshake_duration", label: "SignalR Handshake", type: "trend", unit: "ms", desc: "SignalR handshake" },
      { key: "ws_session_duration", label: "Session Duration", type: "trend", unit: "ms", desc: "Session lifetime" },
      { key: "ws_errors", label: "WebSocket Errors", type: "rate", desc: "Failed connections" },
      { key: "messages_sent", label: "Messages Sent", type: "counter", desc: "Total messages" },
      { key: "messages_received", label: "Messages Received", type: "counter", desc: "NewMessage events" },
      { key: "message_delivery_latency", label: "Delivery Latency", type: "trend", unit: "ms", desc: "Send \u2192 receive" },
      { key: "message_thread_received", label: "Thread History", type: "counter", desc: "ReceiveMessageThread" },
      { key: "typing_indicators_received", label: "Typing Indicators", type: "counter", desc: "UserTyping events" },
      { key: "presence_checks", label: "Presence Checks", type: "counter", desc: "IsUserOnline calls" },
      { key: "presence_online", label: "Found Online", type: "counter", desc: "Online confirmations" },
      { key: "chat_notifications_received", label: "Chat Notifications", type: "counter", desc: "ChatMessageNotification events" },
      { key: "http_req_duration", label: "HTTP Duration", type: "trend", unit: "ms", desc: "HTTP response time" },
      { key: "http_req_failed", label: "HTTP Failures", type: "rate", desc: "Failed HTTP requests" },
    ],
    "presence-stress": [
      { key: "ws_connecting_duration", label: "WebSocket Connect", type: "trend", unit: "ms", desc: "TCP + TLS" },
      { key: "ws_handshake_duration", label: "SignalR Handshake", type: "trend", unit: "ms", desc: "Handshake time" },
      { key: "ws_session_duration", label: "Session Duration", type: "trend", unit: "ms", desc: "Session lifetime" },
      { key: "ws_errors", label: "WebSocket Errors", type: "rate", desc: "Failed connections" },
      { key: "presence_online_rate", label: "Online Rate", type: "rate", desc: "Users found online" },
      { key: "presence_check_latency", label: "Check Latency", type: "trend", unit: "ms", desc: "IsUserOnline round-trip" },
      { key: "presence_checks_total", label: "Total Checks", type: "counter", desc: "Total invocations" },
      { key: "presence_online_count", label: "Online Results", type: "counter", desc: "isOnline=true" },
      { key: "presence_offline_count", label: "Offline Results", type: "counter", desc: "isOnline=false" },
      { key: "http_req_duration", label: "HTTP Duration", type: "trend", unit: "ms", desc: "HTTP response time" },
      { key: "http_req_failed", label: "HTTP Failures", type: "rate", desc: "Failed HTTP requests" },
    ],
    "notification-broadcast": [
      { key: "ws_connecting_duration", label: "WebSocket Connect", type: "trend", unit: "ms", desc: "TCP + TLS" },
      { key: "ws_handshake_duration", label: "SignalR Handshake", type: "trend", unit: "ms", desc: "Handshake time" },
      { key: "ws_session_duration", label: "Session Duration", type: "trend", unit: "ms", desc: "Session lifetime" },
      { key: "ws_errors", label: "WebSocket Errors", type: "rate", desc: "Failed connections" },
      { key: "notifications_received", label: "Notifications", type: "counter", desc: "Events received" },
      { key: "notification_delivery_latency", label: "Notification Latency", type: "trend", unit: "ms", desc: "Server \u2192 client" },
      { key: "event_InPersonOfferReceived", label: "InPersonOfferReceived", type: "counter", desc: "" },
      { key: "event_InPersonOfferStatusChanged", label: "InPersonOfferStatusChanged", type: "counter", desc: "" },
      { key: "event_PaymentCompleted", label: "PaymentCompleted", type: "counter", desc: "" },
      { key: "event_OfferReceived", label: "OfferReceived", type: "counter", desc: "" },
      { key: "event_OfferStatusChanged", label: "OfferStatusChanged", type: "counter", desc: "" },
      { key: "event_InvoiceCreated", label: "InvoiceCreated", type: "counter", desc: "" },
      { key: "event_ChatMessageNotification", label: "ChatMessageNotification", type: "counter", desc: "" },
      { key: "http_req_duration", label: "HTTP Duration", type: "trend", unit: "ms", desc: "HTTP response time" },
      { key: "http_req_failed", label: "HTTP Failures", type: "rate", desc: "Failed HTTP requests" },
    ],
    "chat-offers": [
      { key: "ws_connecting_duration", label: "WS Connect Duration", type: "trend", unit: "ms", desc: "WebSocket connection time" },
      { key: "ws_handshake_duration", label: "SignalR Handshake", type: "trend", unit: "ms", desc: "SignalR handshake time" },
      { key: "ws_errors", label: "WebSocket Errors", type: "rate", desc: "Failed connections" },
      { key: "ws_session_duration", label: "Session Duration", type: "trend", unit: "ms", desc: "Session lifetime" },
      { key: "messages_sent", label: "Messages Sent", type: "counter", desc: "Via SendMessage" },
      { key: "messages_received", label: "Messages Received", type: "counter", desc: "NewMessage events" },
      { key: "message_delivery_latency", label: "Delivery Latency", type: "trend", unit: "ms", desc: "Send \u2192 receive" },
      { key: "message_thread_received", label: "Thread History", type: "counter", desc: "ReceiveMessageThread events" },
      { key: "offer_creation_latency", label: "Create Offer Latency", type: "trend", unit: "ms", desc: "REST create offer" },
      { key: "offer_accept_latency", label: "Accept Offer Latency", type: "trend", unit: "ms", desc: "REST accept offer" },
      { key: "offers_created", label: "Offers Created", type: "counter", desc: "Successful creates" },
      { key: "offers_accepted", label: "Offers Accepted", type: "counter", desc: "Successful accepts" },
      { key: "offers_failed", label: "Offers Failed", type: "counter", desc: "Failed offers" },
      { key: "http_req_duration", label: "HTTP Duration", type: "trend", unit: "ms", desc: "All HTTP response times" },
      { key: "http_req_failed", label: "HTTP Failures", type: "rate", desc: "Failed HTTP requests" },
    ],
  };

  defs["realistic-load"] = [
    { key: "ws_connecting_duration", label: "WS Connect Duration", type: "trend", unit: "ms", desc: "TCP+TLS connection time", group: "Connection" },
    { key: "ws_handshake_duration", label: "SignalR Handshake", type: "trend", unit: "ms", desc: "Protocol handshake time", group: "Connection" },
    { key: "ws_errors", label: "WebSocket Errors", type: "rate", desc: "Failed WS connections", group: "Connection" },
    { key: "ws_handshake_success_rate", label: "Handshake Success", type: "rate", desc: "Successful handshakes", group: "Connection" },
    { key: "ws_session_ok_rate", label: "Session OK Rate", type: "rate", desc: "Sessions alive for full duration", group: "Connection" },
    { key: "handshake_failures", label: "Handshake Failures", type: "counter", desc: "Timeouts/errors during handshake", group: "Connection" },
    { key: "ws_reconnects", label: "VU Reconnects", type: "counter", desc: "Iteration re-connections (expected)", group: "Connection" },
    { key: "ws_session_duration", label: "Session Duration", type: "trend", unit: "ms", desc: "WebSocket session lifetime", group: "Connection" },
    { key: "ws_close_1000", label: "Close 1000 (Normal)", type: "counter", desc: "Clean close", group: "Connection" },
    { key: "ws_close_1006", label: "Close 1006 (ALB Cut)", type: "counter", desc: "Connection cut by proxy", group: "Connection" },
    { key: "ws_close_1011", label: "Close 1011 (Server)", type: "counter", desc: "Server error", group: "Connection" },
    { key: "ws_close_other", label: "Close Other", type: "counter", desc: "Other close codes", group: "Connection" },
    { key: "messages_sent", label: "Messages Sent", type: "counter", desc: "Buyer \u2192 SendMessage", group: "Chat Delivery" },
    { key: "messages_delivered", label: "Messages Delivered", type: "counter", desc: "Seller \u2190 NewMessage", group: "Chat Delivery" },
    { key: "message_delivery_latency", label: "\u2605 Delivery Latency", type: "trend", unit: "ms", desc: "Buyer send \u2192 Seller receive", group: "Chat Delivery" },
    { key: "message_content_match", label: "\u2605 Content Match", type: "rate", desc: "Verified correct CID", group: "Chat Delivery" },
    { key: "message_thread_received", label: "Thread History", type: "counter", desc: "ReceiveMessageThread events", group: "Chat Delivery" },
    { key: "messages_duplicated", label: "Duplicates", type: "counter", desc: "Same CID received twice", group: "Chat Delivery" },
    { key: "messages_marked_read", label: "Marked as Read", type: "counter", desc: "MessageRead() calls by seller", group: "Read Receipts" },
    { key: "mark_read_latency", label: "Mark-Read Latency", type: "trend", unit: "ms", desc: "Server processing time", group: "Read Receipts" },
    { key: "read_receipts_received", label: "Receipts Received", type: "counter", desc: "MessageRead events to buyer", group: "Read Receipts" },
    { key: "read_receipt_match", label: "Receipt Match Rate", type: "rate", desc: "Buyers that got read receipt", group: "Read Receipts" },
    { key: "offer_creation_latency", label: "Create Offer", type: "trend", unit: "ms", desc: "REST create offer", group: "Offers" },
    { key: "offer_accept_latency", label: "Accept Offer", type: "trend", unit: "ms", desc: "REST accept offer", group: "Offers" },
    { key: "offers_created", label: "Created", type: "counter", desc: "Successful creates", group: "Offers" },
    { key: "offers_accepted", label: "Accepted", type: "counter", desc: "Successful accepts", group: "Offers" },
    { key: "offers_failed", label: "Failed", type: "counter", desc: "Failed operations", group: "Offers" },
    { key: "browse_items_latency", label: "Items Listing", type: "trend", unit: "ms", desc: "GET /api/pos/item", group: "Browse API" },
    { key: "view_item_latency", label: "Item Detail", type: "trend", unit: "ms", desc: "GET /api/pos/item/{id}", group: "Browse API" },
    { key: "browse_categories_latency", label: "Categories", type: "trend", unit: "ms", desc: "GET /api/pos/category", group: "Browse API" },
    { key: "browse_requests", label: "Total Requests", type: "counter", desc: "All browser HTTP requests", group: "Browse API" },
    { key: "browse_errors", label: "Error Rate", type: "rate", desc: "Failed requests", group: "Browse API" },
    { key: "idle_connections", label: "Idle Connections", type: "counter", desc: "Background presence users", group: "Idle" },
    { key: "idle_heartbeats", label: "Idle Heartbeats", type: "counter", desc: "Background heartbeat calls", group: "Idle" },
    { key: "http_req_duration", label: "HTTP Duration", type: "trend", unit: "ms", desc: "All HTTP requests", group: "Global" },
    { key: "http_req_failed", label: "HTTP Failure Rate", type: "rate", desc: "Overall failure rate", group: "Global" },
  ];

  return defs[scenarioName] || [];
}

// ════════════════════════════════════════════════════════════════
// THROUGHPUT CALCULATOR
// ════════════════════════════════════════════════════════════════

function computeThroughput(data, scenarioName, durationSec) {
  var items = [];
  if (durationSec <= 0) return items;

  var iterCount = extractMetric(data, "iterations");
  if (iterCount && iterCount.count) {
    items.push({ label: "Iterations / sec", value: fmt(iterCount.count / durationSec, 1) });
  }

  var httpReqs = extractMetric(data, "http_reqs");
  if (httpReqs && httpReqs.count) {
    items.push({ label: "HTTP Requests / sec", value: fmt(httpReqs.count / durationSec, 1) });
  }

  if (scenarioName === "message-hub" || scenarioName === "full-flow") {
    var sent = extractMetric(data, "messages_sent");
    if (sent && sent.count) items.push({ label: "Messages / sec (sent)", value: fmt(sent.count / durationSec, 1) });
    var recv = extractMetric(data, "messages_received");
    if (recv && recv.count) items.push({ label: "Messages / sec (received)", value: fmt(recv.count / durationSec, 1) });
  }

  if (scenarioName === "presence-hub" || scenarioName === "presence-hub-final" || scenarioName === "presence-stress") {
    var checks = extractMetric(data, scenarioName === "presence-stress" ? "presence_checks_total" : "is_user_online_checks");
    if (checks && checks.count) items.push({ label: "Presence Checks / sec", value: fmt(checks.count / durationSec, 1) });
  }

  if (scenarioName === "chat-offers" || scenarioName === "realistic-load") {
    var sent2 = extractMetric(data, "messages_sent");
    if (sent2 && sent2.count) items.push({ label: "Messages / sec (sent)", value: fmt(sent2.count / durationSec, 1) });
    var deliveredKey = data.metrics["messages_delivered"] ? "messages_delivered" : "messages_received";
    var delivered = extractMetric(data, deliveredKey);
    if (delivered && delivered.count) items.push({ label: "Messages / sec (delivered)", value: fmt(delivered.count / durationSec, 1) });
    var created = extractMetric(data, "offers_created");
    if (created && created.count) items.push({ label: "Offers / sec", value: fmt(created.count / durationSec, 1) });
    if (scenarioName === "realistic-load") {
      var browseReqs = extractMetric(data, "browse_requests");
      if (browseReqs && browseReqs.count) items.push({ label: "Browse Requests / sec", value: fmt(browseReqs.count / durationSec, 1) });
    }
  }

  return items;
}

// ════════════════════════════════════════════════════════════════
// RECOMMENDATIONS ENGINE
// ════════════════════════════════════════════════════════════════

function generateRecommendations(data, scenarioName, thresholdResults) {
  var recs = [];
  var failedThresholds = thresholdResults.filter(function(t) { return !t.passed; });

  if (failedThresholds.length > 0) {
    recs.push({
      severity: "critical", title: "Thresholds Breached",
      text: failedThresholds.length + " threshold(s) failed: " + failedThresholds.map(function(t) { return t.metric; }).join(", ") + ". Fix these before increasing load.",
      action: "Check the Threshold Results section below for specific limits that were exceeded.",
    });
  }

  var wsErr = extractMetric(data, "ws_errors");
  if (wsErr && wsErr.rate > 0.05) {
    recs.push({
      severity: "critical", title: "High WebSocket Error Rate",
      text: "Error rate is " + fmtRate(wsErr.rate) + ". Server is rejecting or dropping connections.",
      action: "Check server logs for connection rejections, auth failures, or resource exhaustion (file descriptors, memory).",
    });
  } else if (wsErr && wsErr.rate > 0.01) {
    recs.push({
      severity: "warning", title: "Elevated WebSocket Errors",
      text: "Error rate is " + fmtRate(wsErr.rate) + " \u2014 marginal but watch closely at higher load.",
      action: "Monitor server resource utilization and connection logs during next test stage.",
    });
  }

  var wsConn = extractMetric(data, "ws_connecting_duration");
  if (wsConn && wsConn["p(95)"] > 3000) {
    recs.push({
      severity: "warning", title: "Slow WebSocket Connections",
      text: "Connect p95 is " + fmtMs(wsConn["p(95)"]) + ". TLS or load balancer may be bottleneck.",
      action: "Check ALB connection draining, TLS session reuse, and network latency.",
    });
  }

  var handshake = extractMetric(data, "ws_handshake_duration");
  if (handshake && handshake["p(95)"] > 2000) {
    recs.push({
      severity: "warning", title: "Slow SignalR Handshake",
      text: "Handshake p95 is " + fmtMs(handshake["p(95)"]) + ". Server is slow during connection setup.",
      action: "Check if authentication (JWT validation) or Redis connection is slow during high load.",
    });
  }

  if (scenarioName === "message-hub" || scenarioName === "full-flow" || scenarioName === "realistic-load") {
    var latency = extractMetric(data, "message_delivery_latency");
    if (latency && latency["p(95)"] > 2000) {
      recs.push({
        severity: "critical", title: "Slow Message Delivery",
        text: "Cross-user delivery p95 is " + fmtMs(latency["p(95)"]) + ". Messages are taking too long.",
        action: "Check database write performance, Redis pub/sub throughput, and SignalR group routing.",
      });
    }

    var sent = extractMetric(data, "messages_sent");
    var recvKey = scenarioName === "realistic-load" ? "messages_delivered" : "messages_received";
    var recv = extractMetric(data, recvKey);
    if (sent && recv && sent.count > 0) {
      var deliveryRate = recv.count / sent.count;
      if (deliveryRate < 0.9) {
        recs.push({
          severity: "critical", title: "Messages Being Lost",
          text: "Only " + fmtRate(deliveryRate) + " of messages delivered (" + fmtCount(recv.count) + " / " + fmtCount(sent.count) + ").",
          action: "Check Redis backplane connectivity, SignalR group membership, and whether pods are restarting.",
        });
      }
    }
  }

  if (scenarioName === "realistic-load") {
    var browseErr = extractMetric(data, "browse_errors");
    if (browseErr && browseErr.rate > 0.05) {
      recs.push({
        severity: "critical", title: "REST API Failing",
        text: "Browse error rate is " + fmtRate(browseErr.rate) + ". API endpoints are failing under load.",
        action: "Check database query performance, connection pool limits, and API pod resource utilization.",
      });
    }

    var browseLat = extractMetric(data, "browse_items_latency");
    if (browseLat && browseLat["p(95)"] > 3000) {
      recs.push({
        severity: "warning", title: "Slow Item Listing",
        text: "Browse items p95 is " + fmtMs(browseLat["p(95)"]) + ". Listing queries are slow.",
        action: "Add database indexes, enable query caching, or implement pagination optimization.",
      });
    }

    var contentMatch = extractMetric(data, "message_content_match");
    if (contentMatch && contentMatch.rate < 0.9) {
      recs.push({
        severity: "critical", title: "Message Content Mismatch",
        text: "Only " + fmtRate(contentMatch.rate) + " of messages have correct content.",
        action: "Check SignalR group routing \u2014 messages may be delivered to wrong chat sessions.",
      });
    }

    var hsFails = extractMetric(data, "handshake_failures");
    if (hsFails && hsFails.count > 10) {
      recs.push({
        severity: "critical", title: "Handshake Failures",
        text: fmtCount(hsFails.count) + " handshakes failed. Auth or sticky sessions may be broken.",
        action: "Check JWT validation, DataProtection key ring, and whether sticky sessions are configured for SignalR.",
      });
    }

    var reconnects = extractMetric(data, "ws_reconnects");
    if (reconnects && reconnects.count > 0) {
      var iters = extractMetric(data, "iterations");
      var iterCount = iters ? iters.count || 0 : 0;
      var unexpected = iterCount > 0 && reconnects.count > iterCount * 1.5;
      if (unexpected) {
        recs.push({
          severity: "warning", title: "Unexpected Reconnections",
          text: fmtCount(reconnects.count) + " reconnects vs " + fmtCount(iterCount) + " iterations \u2014 connections are dropping mid-session.",
          action: "Check server memory pressure, Redis backplane health, and ALB idle timeout settings.",
        });
      }
    }

    var dupes = extractMetric(data, "messages_duplicated");
    if (dupes && dupes.count > 100) {
      recs.push({
        severity: "warning", title: "Message Duplicates",
        text: fmtCount(dupes.count) + " duplicate deliveries. May indicate group overlap or SignalR retries.",
        action: "Review pair pool size vs VU count. With shared pairs, duplicates are expected.",
      });
    }
  }

  if (scenarioName === "presence-stress") {
    var onlineRate = extractMetric(data, "presence_online_rate");
    if (onlineRate && onlineRate.rate < 0.8) {
      recs.push({
        severity: "critical", title: "Presence Tracking Unreliable",
        text: "Online rate is " + fmtRate(onlineRate.rate) + ". Redis presence data is stale or missing.",
        action: "Check Heartbeat TTL vs interval alignment and Redis write throughput.",
      });
    }
  }

  var httpFail = extractMetric(data, "http_req_failed");
  if (httpFail && httpFail.rate > 0.05) {
    recs.push({
      severity: "critical", title: "High HTTP Failure Rate",
      text: "Overall HTTP failure rate is " + fmtRate(httpFail.rate) + ".",
      action: "Check API server logs and health endpoints.",
    });
  }

  if (recs.length === 0) {
    recs.push({
      severity: "info", title: "All Clear",
      text: "All metrics within acceptable ranges.",
      action: "Consider testing at the next load stage to find breaking points.",
    });
  }

  return recs;
}

// ════════════════════════════════════════════════════════════════
// SCENARIO LABELS
// ════════════════════════════════════════════════════════════════

function scenarioLabel(name) {
  var labels = {
    "presence-hub": "Presence Hub \u2014 Connection Lifecycle",
    "presence-hub-final": "Presence Hub \u2014 Final (Heartbeat ACK Proof)",
    "message-hub": "Message Hub \u2014 Chat Flow",
    "full-flow": "Full Flow \u2014 E2E Buyer \u2194 Seller",
    "presence-stress": "Presence Stress \u2014 Redis Tracking",
    "notification-broadcast": "Notification Broadcast \u2014 Event Delivery",
    "chat-offers": "Chat + Offers \u2014 Full Lifecycle",
    "realistic-load": "Realistic Load \u2014 Mixed Traffic Simulation",
  };
  return labels[name] || name;
}

// ════════════════════════════════════════════════════════════════
// MAIN REPORT GENERATOR
// ════════════════════════════════════════════════════════════════

export function generateReport(data, opts) {
  var scenario = opts.scenario;
  var stageName = opts.stage || "smoke";
  var trafficMix = opts.trafficMix || null;
  var now = new Date().toISOString();
  var d = new Date();
  var months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  var nowDisplay = months[d.getMonth()] + " " + d.getDate() + ", " + d.getFullYear() + ", " + String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0") + ":" + String(d.getSeconds()).padStart(2, "0");

  var maxVUs = trafficMix
    ? trafficMix.reduce(function(sum, t) { return sum + (t.vus || 0); }, 0)
    : getMaxVUsFromStage(stageName);
  var plannedDurationSec = getStageDuration(stageName);
  var actualDurationSec = getTestDurationSec(data);
  var durationSec = actualDurationSec > 0 ? actualDurationSec : plannedDurationSec;

  var thresholdResults = evaluateThresholds(data);
  var failedCount = thresholdResults.filter(function(t) { return !t.passed; }).length;
  var passedCount = thresholdResults.filter(function(t) { return t.passed; }).length;
  var overallPass = failedCount === 0;

  var metricDefs = buildMetricDefinitions(scenario);
  var throughput = computeThroughput(data, scenario, durationSec);
  var recs = generateRecommendations(data, scenario, thresholdResults);

  var iterMetric = extractMetric(data, "iterations");
  var vusMax = extractMetric(data, "vus_max");

  // Health verdicts
  var connHealth = computeConnectionHealth(data);
  var chatHealth = computeChatHealth(data);
  var apiHealth = computeApiHealth(data);
  var presHealth = computePresenceHealth(data);

  // Narrative
  var narrative = buildNarrative(data, scenario, stageName, maxVUs, durationSec, overallPass, trafficMix);

  var html = buildHtml({
    scenario: scenario, stageName: stageName, nowDisplay: nowDisplay, now: now,
    maxVUs: maxVUs, durationSec: durationSec, overallPass: overallPass,
    passedCount: passedCount, failedCount: failedCount,
    thresholdResults: thresholdResults, metricDefs: metricDefs,
    throughput: throughput, recs: recs, iterMetric: iterMetric,
    vusMax: vusMax, trafficMix: trafficMix,
    connHealth: connHealth, chatHealth: chatHealth,
    apiHealth: apiHealth, presHealth: presHealth,
    narrative: narrative, data: data,
  });

  var jsonSummary = {
    scenario: scenario, stage: stageName, timestamp: now, target: BASE_URL,
    maxVUs: maxVUs, durationSec: durationSec, overallPass: overallPass,
    thresholds: { passed: passedCount, failed: failedCount, details: thresholdResults },
    health: {
      connection: connHealth.verdict,
      chat: chatHealth ? chatHealth.verdict : null,
      api: apiHealth ? apiHealth.verdict : null,
      presence: presHealth ? presHealth.verdict : null,
    },
    throughput: throughput, recommendations: recs, metrics: {},
  };
  for (var i = 0; i < metricDefs.length; i++) {
    var m = extractMetric(data, metricDefs[i].key);
    if (m) jsonSummary.metrics[metricDefs[i].key] = m;
  }

  var reportBaseName = scenario + "_" + stageName;
  return {
    ["./results/" + reportBaseName + "_report.html"]: html,
    ["./results/" + reportBaseName + "_report.json"]: JSON.stringify(jsonSummary, null, 2),
    stdout: buildTextSummary(scenario, stageName, overallPass, thresholdResults, throughput, recs, data, metricDefs, trafficMix, connHealth, chatHealth, apiHealth, presHealth),
  };
}

// ════════════════════════════════════════════════════════════════
// HTML BUILDER
// ════════════════════════════════════════════════════════════════

function buildHtml(ctx) {
  var scenario = ctx.scenario;
  var stageName = ctx.stageName;
  var nowDisplay = ctx.nowDisplay;
  var now = ctx.now;
  var maxVUs = ctx.maxVUs;
  var durationSec = ctx.durationSec;
  var overallPass = ctx.overallPass;
  var passedCount = ctx.passedCount;
  var failedCount = ctx.failedCount;
  var thresholdResults = ctx.thresholdResults;
  var metricDefs = ctx.metricDefs;
  var throughput = ctx.throughput;
  var recs = ctx.recs;
  var iterMetric = ctx.iterMetric;
  var vusMax = ctx.vusMax;
  var trafficMix = ctx.trafficMix;
  var connHealth = ctx.connHealth;
  var chatHealth = ctx.chatHealth;
  var apiHealth = ctx.apiHealth;
  var presHealth = ctx.presHealth;
  var narrative = ctx.narrative;
  var data = ctx.data;

  var thresholdRows = "";
  for (var i = 0; i < thresholdResults.length; i++) {
    var t = thresholdResults[i];
    var tdesc = THRESHOLD_DESCRIPTIONS[t.metric] || "";
    thresholdRows += '    <tr>\n'
      + '      <td><strong>' + escHtml(t.metric) + '</strong></td>\n'
      + '      <td class="th-desc">' + escHtml(tdesc) + '</td>\n'
      + '      <td class="text-mono">' + escHtml(t.threshold) + '</td>\n'
      + '      <td class="text-center ' + (t.passed ? 'th-pass' : 'th-fail') + '">' + (t.passed ? '&#10003; PASS' : '&#10007; FAIL') + '</td>\n'
      + '    </tr>\n';
  }
  if (thresholdResults.length === 0) {
    thresholdRows = '    <tr><td colspan="4" class="text-center" style="color:var(--text3)">No thresholds defined</td></tr>\n';
  }

  var throughputCards = "";
  for (var i = 0; i < throughput.length; i++) {
    throughputCards += '  <div class="stat-card">\n'
      + '    <div class="stat-label">' + escHtml(throughput[i].label) + '</div>\n'
      + '    <div class="stat-value">' + escHtml(throughput[i].value) + '</div>\n'
      + '  </div>\n';
  }

  var recCards = "";
  for (var i = 0; i < recs.length; i++) {
    var r = recs[i];
    recCards += '<div class="rec-card rec-' + r.severity + '">\n'
      + '  <div class="rec-header">\n'
      + '    <span class="rec-severity rec-sev-' + r.severity + '">' + r.severity + '</span>\n'
      + '    <span class="rec-title">' + escHtml(r.title || "") + '</span>\n'
      + '  </div>\n'
      + '  <div class="rec-text">' + escHtml(r.text) + '</div>\n'
      + (r.action ? '  <div class="rec-action"><strong>Next step:</strong> ' + escHtml(r.action) + '</div>\n' : '')
      + '</div>\n';
  }

  return '<!DOCTYPE html>\n'
+ '<html lang="en">\n'
+ '<head>\n'
+ '<meta charset="UTF-8">\n'
+ '<meta name="viewport" content="width=device-width, initial-scale=1.0">\n'
+ '<title>Load Test Report \u2014 ' + escHtml(scenarioLabel(scenario)) + '</title>\n'
+ '<style>\n'
+ ':root {\n'
+ '  --pass: #22c55e; --fail: #ef4444; --warn: #f59e0b; --info: #3b82f6;\n'
+ '  --bg: #0f172a; --surface: #1e293b; --surface2: #334155; --surface3: #1a2332;\n'
+ '  --text: #f1f5f9; --text2: #94a3b8; --text3: #64748b; --border: #475569;\n'
+ '  --accent: #818cf8; --accent2: #6366f1;\n'
+ '}\n'
+ '* { margin: 0; padding: 0; box-sizing: border-box; }\n'
+ 'body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: var(--bg); color: var(--text); line-height: 1.6; }\n'
+ '.container { max-width: 1140px; margin: 0 auto; padding: 32px 24px; }\n'
+ 'h1 { font-size: 1.75rem; font-weight: 800; letter-spacing: -0.5px; }\n'
+ 'h2 { font-size: 1.2rem; font-weight: 700; margin: 36px 0 16px; padding-bottom: 8px; border-bottom: 2px solid var(--border); display: flex; align-items: center; gap: 8px; }\n'
+ 'h2 .section-icon { font-size: 1.1rem; }\n'
+ 'h3 { font-size: 0.78rem; font-weight: 600; color: var(--text2); margin: 12px 0 8px; text-transform: uppercase; letter-spacing: 0.5px; }\n'
+ '.banner { background: linear-gradient(135deg, var(--surface) 0%, var(--surface2) 100%); border: 1px solid var(--border); border-radius: 12px; padding: 28px 32px; margin-bottom: 24px; }\n'
+ '.banner-top { display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 16px; margin-bottom: 20px; }\n'
+ '.banner-title h1 { margin-bottom: 4px; }\n'
+ '.banner-title .subtitle { color: var(--text2); font-size: 0.9rem; }\n'
+ '.badge { display: inline-flex; align-items: center; gap: 8px; padding: 8px 24px; border-radius: 8px; font-weight: 800; font-size: 1.05rem; letter-spacing: 0.5px; }\n'
+ '.badge-pass { background: linear-gradient(135deg, #166534, #22c55e); color: #fff; }\n'
+ '.badge-fail { background: linear-gradient(135deg, #991b1b, #ef4444); color: #fff; }\n'
+ '.config-pills { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }\n'
+ '.config-pill { background: var(--surface2); border: 1px solid var(--border); border-radius: 20px; padding: 5px 14px; font-size: 0.78rem; display: flex; align-items: center; gap: 6px; }\n'
+ '.config-pill .pill-label { color: var(--text3); }\n'
+ '.config-pill .pill-value { color: var(--text); font-weight: 600; }\n'
+ '.narrative { background: var(--surface3); border: 1px solid var(--border); border-left: 4px solid var(--accent); border-radius: 8px; padding: 20px 24px; margin-bottom: 24px; font-size: 0.9rem; line-height: 1.7; color: var(--text2); }\n'
+ '.narrative strong { color: var(--text); }\n'
+ '.card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 20px 24px; margin-bottom: 16px; }\n'
+ '.card-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; }\n'
+ '.stat-card { background: var(--surface2); border-radius: 8px; padding: 16px 18px; border: 1px solid transparent; transition: border-color 0.2s; }\n'
+ '.stat-card:hover { border-color: var(--border); }\n'
+ '.stat-label { font-size: 0.7rem; color: var(--text3); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px; font-weight: 600; }\n'
+ '.stat-value { font-size: 1.5rem; font-weight: 800; line-height: 1.2; }\n'
+ '.stat-sub { font-size: 0.72rem; color: var(--text3); margin-top: 4px; }\n'
+ '.health-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 12px; margin-bottom: 24px; }\n'
+ '.health-card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 16px 20px; }\n'
+ '.health-header { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }\n'
+ '.health-icon { font-size: 1.2rem; }\n'
+ '.health-title { font-weight: 700; font-size: 0.88rem; }\n'
+ '.health-verdict { font-size: 0.72rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; padding: 2px 8px; border-radius: 4px; }\n'
+ '.health-body { font-size: 0.82rem; color: var(--text2); line-height: 1.5; }\n'
+ 'table { width: 100%; border-collapse: collapse; font-size: 0.82rem; }\n'
+ 'thead tr { background: var(--surface2); }\n'
+ 'th { text-align: left; padding: 10px 14px; color: var(--text3); font-weight: 700; text-transform: uppercase; font-size: 0.68rem; letter-spacing: 0.5px; }\n'
+ 'td { padding: 10px 14px; border-bottom: 1px solid rgba(71,85,105,0.4); }\n'
+ 'tr:last-child td { border-bottom: none; }\n'
+ 'tr:hover td { background: rgba(71,85,105,0.15); }\n'
+ '.text-right { text-align: right; }\n'
+ '.text-center { text-align: center; }\n'
+ '.text-mono { font-family: "SF Mono","Cascadia Code","Fira Code", monospace; font-size: 0.78rem; }\n'
+ '.th-pass { color: var(--pass); font-weight: 800; }\n'
+ '.th-fail { color: var(--fail); font-weight: 800; }\n'
+ '.th-desc { color: var(--text3); font-size: 0.75rem; font-style: italic; }\n'
+ '.rec-card { border-radius: 8px; padding: 16px 20px; margin-bottom: 10px; }\n'
+ '.rec-critical { background: rgba(239,68,68,0.08); border: 1px solid rgba(239,68,68,0.3); }\n'
+ '.rec-warning { background: rgba(245,158,11,0.08); border: 1px solid rgba(245,158,11,0.3); }\n'
+ '.rec-info { background: rgba(59,130,246,0.08); border: 1px solid rgba(59,130,246,0.3); }\n'
+ '.rec-header { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }\n'
+ '.rec-severity { font-size: 0.68rem; font-weight: 800; text-transform: uppercase; letter-spacing: 0.5px; padding: 2px 8px; border-radius: 4px; }\n'
+ '.rec-sev-critical { background: var(--fail); color: #fff; }\n'
+ '.rec-sev-warning { background: var(--warn); color: #000; }\n'
+ '.rec-sev-info { background: var(--info); color: #fff; }\n'
+ '.rec-title { font-weight: 700; font-size: 0.88rem; }\n'
+ '.rec-text { font-size: 0.82rem; color: var(--text2); margin-bottom: 4px; }\n'
+ '.rec-action { font-size: 0.78rem; color: var(--text3); }\n'
+ '.rec-action strong { color: var(--text2); }\n'
+ '.mix-bar { display: flex; height: 40px; border-radius: 8px; overflow: hidden; margin-bottom: 16px; }\n'
+ '.mix-segment { display: flex; align-items: center; justify-content: center; font-size: 0.72rem; font-weight: 700; color: #000; min-width: 40px; }\n'
+ '.mix-legend { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; }\n'
+ '.mix-item { display: flex; align-items: center; gap: 8px; }\n'
+ '.mix-dot { width: 14px; height: 14px; border-radius: 4px; flex-shrink: 0; }\n'
+ '.mix-label { font-weight: 600; font-size: 0.82rem; }\n'
+ '.mix-detail { color: var(--text3); font-size: 0.72rem; }\n'
+ '.group-header td { background: var(--surface2); font-weight: 700; text-transform: uppercase; font-size: 0.72rem; letter-spacing: 0.5px; color: var(--accent); padding: 8px 14px; border-bottom: 2px solid var(--accent2); }\n'
+ '.footer { margin-top: 40px; padding-top: 16px; border-top: 1px solid var(--border); color: var(--text3); font-size: 0.7rem; text-align: center; }\n'
+ '@media (max-width: 768px) {\n'
+ '  .container { padding: 16px; }\n'
+ '  .banner { padding: 20px; }\n'
+ '  .card-grid { grid-template-columns: 1fr; }\n'
+ '  .health-grid { grid-template-columns: 1fr; }\n'
+ '}\n'
+ '@media print {\n'
+ '  body { background: #fff; color: #000; }\n'
+ '  .card, .health-card, .banner { border-color: #ccc; background: #fafafa; }\n'
+ '  .stat-card { background: #f0f0f0; }\n'
+ '}\n'
+ '</style>\n'
+ '</head>\n'
+ '<body>\n'
+ '<div class="container">\n'
+ '\n'
+ '<!-- BANNER -->\n'
+ '<div class="banner">\n'
+ '  <div class="banner-top">\n'
+ '    <div class="banner-title">\n'
+ '      <h1>C2C Load Test Report</h1>\n'
+ '      <div class="subtitle">' + escHtml(scenarioLabel(scenario)) + '</div>\n'
+ '    </div>\n'
+ '    <span class="badge ' + (overallPass ? 'badge-pass' : 'badge-fail') + '">\n'
+ '      ' + (overallPass ? '&#10003; ALL PASSED' : '&#10007; FAILED') + '\n'
+ '    </span>\n'
+ '  </div>\n'
+ '  <div class="config-pills">\n'
+ '    <div class="config-pill"><span class="pill-label">Target</span><span class="pill-value">' + escHtml(BASE_URL) + '</span></div>\n'
+ '    <div class="config-pill"><span class="pill-label">Stage</span><span class="pill-value">' + escHtml(stageName) + '</span></div>\n'
+ '    <div class="config-pill"><span class="pill-label">Peak VUs</span><span class="pill-value">' + (vusMax ? fmtCount(vusMax.max) : maxVUs) + '</span></div>\n'
+ '    <div class="config-pill"><span class="pill-label">Duration</span><span class="pill-value">' + fmtDuration(durationSec) + '</span></div>\n'
+ '    <div class="config-pill"><span class="pill-label">Iterations</span><span class="pill-value">' + (iterMetric ? fmtCount(iterMetric.count) : '\u2014') + '</span></div>\n'
+ '    <div class="config-pill"><span class="pill-label">Time</span><span class="pill-value">' + escHtml(nowDisplay) + '</span></div>\n'
+ '  </div>\n'
+ '</div>\n'
+ '\n'
+ '<!-- WHAT HAPPENED -->\n'
+ '<div class="narrative">\n'
+ '  ' + narrative + '\n'
+ '</div>\n'
+ '\n'
+ (trafficMix ? buildTrafficMixSection(trafficMix) : '')
+ '\n'
+ '<!-- SYSTEM HEALTH -->\n'
+ '<h2><span class="section-icon">&#9881;</span> System Health</h2>\n'
+ '<div class="health-grid">\n'
+ buildHealthCard("Connection Layer", "WebSocket + SignalR handshake", connHealth)
+ (chatHealth ? buildHealthCard("Chat Delivery", "Message send \u2192 receive \u2192 read receipt", chatHealth) : '')
+ (apiHealth ? buildHealthCard("REST API", "Browse, search, profile endpoints", apiHealth) : '')
+ (presHealth ? buildHealthCard("Presence System", "Heartbeat, online status, Redis tracking", presHealth) : '')
+ '</div>\n'
+ '\n'
+ '<!-- KEY NUMBERS -->\n'
+ '<h2><span class="section-icon">&#128200;</span> Key Numbers</h2>\n'
+ '<div class="card-grid">\n'
+ '  <div class="stat-card">\n'
+ '    <div class="stat-label">Thresholds</div>\n'
+ '    <div class="stat-value" style="color:' + (overallPass ? 'var(--pass)' : 'var(--fail)') + '">' + passedCount + ' / ' + (passedCount + failedCount) + '</div>\n'
+ '    <div class="stat-sub">' + (failedCount === 0 ? 'All passed' : failedCount + ' failed') + '</div>\n'
+ '  </div>\n'
+ buildExecutiveSummaryCards(data, scenario) + '\n'
+ '</div>\n'
+ '\n'
+ (throughput.length > 0 ? (
  '<!-- THROUGHPUT -->\n'
  + '<h2><span class="section-icon">&#9889;</span> Throughput</h2>\n'
  + '<div class="card-grid">\n'
  + throughputCards
  + '</div>\n'
) : '')
+ '\n'
+ '<!-- THRESHOLD RESULTS -->\n'
+ '<h2><span class="section-icon">&#9989;</span> Threshold Results</h2>\n'
+ '<div class="card">\n'
+ '<table>\n'
+ '  <thead><tr><th style="width:28%">Metric</th><th style="width:35%">What It Measures</th><th>Limit</th><th class="text-center">Result</th></tr></thead>\n'
+ '  <tbody>\n'
+ thresholdRows
+ '  </tbody>\n'
+ '</table>\n'
+ '</div>\n'
+ '\n'
+ '<!-- DETAILED METRICS -->\n'
+ '<h2><span class="section-icon">&#128202;</span> Detailed Metrics</h2>\n'
+ buildDetailedMetricsTable(data, metricDefs)
+ '\n'
+ '<!-- RECOMMENDATIONS -->\n'
+ '<h2><span class="section-icon">&#128161;</span> Recommendations</h2>\n'
+ recCards
+ '\n'
+ '<!-- CHECKS -->\n'
+ buildChecksSection(data)
+ '\n'
+ '<div class="footer">\n'
+ '  Generated by C2C Load Test Suite &middot; ' + escHtml(now) + '\n'
+ '</div>\n'
+ '</div>\n'
+ '</body>\n'
+ '</html>';
}

// ════════════════════════════════════════════════════════════════
// HTML COMPONENT BUILDERS
// ════════════════════════════════════════════════════════════════

function buildHealthCard(title, subtitle, health) {
  if (!health) return "";
  var bgMap = { healthy: "rgba(34,197,94,0.06)", degraded: "rgba(245,158,11,0.06)", critical: "rgba(239,68,68,0.06)" };
  var borderMap = { healthy: "rgba(34,197,94,0.3)", degraded: "rgba(245,158,11,0.3)", critical: "rgba(239,68,68,0.3)" };
  var verdictColor = { healthy: "var(--pass)", degraded: "var(--warn)", critical: "var(--fail)" };
  return '<div class="health-card" style="background:' + bgMap[health.verdict] + ';border-color:' + borderMap[health.verdict] + '">\n'
    + '  <div class="health-header">\n'
    + '    <span class="health-icon">' + health.icon + '</span>\n'
    + '    <span class="health-title">' + escHtml(title) + '</span>\n'
    + '    <span class="health-verdict" style="color:' + verdictColor[health.verdict] + '">' + health.verdict + '</span>\n'
    + '  </div>\n'
    + '  <div style="color:var(--text3);font-size:0.72rem;margin-bottom:6px">' + escHtml(subtitle) + '</div>\n'
    + '  <div class="health-body">' + escHtml(health.summary) + '</div>\n'
    + '</div>\n';
}

function buildExecutiveSummaryCards(data, scenario) {
  var cards = [];

  var wsErr = extractMetric(data, "ws_errors");
  if (wsErr) {
    var color = wsErr.rate < 0.01 ? "var(--pass)" : wsErr.rate < 0.05 ? "var(--warn)" : "var(--fail)";
    cards.push(statCard("Error Rate", fmtRate(wsErr.rate), "WebSocket errors", color));
  }

  var wsConn = extractMetric(data, "ws_connecting_duration");
  if (wsConn) {
    var color2 = wsConn["p(95)"] < 2000 ? "var(--pass)" : "var(--warn)";
    cards.push(statCard("Connect p95", fmtMs(wsConn["p(95)"]), "TCP+TLS time", color2));
  }

  var hs = extractMetric(data, "ws_handshake_duration");
  if (hs) {
    var color3 = hs["p(95)"] < 1000 ? "var(--pass)" : "var(--warn)";
    cards.push(statCard("Handshake p95", fmtMs(hs["p(95)"]), "SignalR handshake", color3));
  }

  var hsRate = extractMetric(data, "ws_handshake_success_rate");
  if (hsRate) {
    var color4 = hsRate.rate > 0.99 ? "var(--pass)" : hsRate.rate > 0.95 ? "var(--warn)" : "var(--fail)";
    cards.push(statCard("Handshake Success", fmtRate(hsRate.rate), "Successful handshakes", color4));
  }

  if (scenario === "message-hub" || scenario === "full-flow" || scenario === "realistic-load") {
    var lat = extractMetric(data, "message_delivery_latency");
    if (lat) {
      var lc = lat["p(95)"] < 1500 ? "var(--pass)" : lat["p(95)"] < 3000 ? "var(--warn)" : "var(--fail)";
      cards.push(statCard("\u2605 Delivery p95", fmtMs(lat["p(95)"]), "Buyer \u2192 Seller", lc));
    }
    var sent = extractMetric(data, "messages_sent");
    var recvKey = scenario === "realistic-load" ? "messages_delivered" : "messages_received";
    var recv = extractMetric(data, recvKey);
    if (sent && recv && sent.count > 0) {
      var ratio = recv.count / sent.count;
      var rc = ratio > 0.95 ? "var(--pass)" : ratio > 0.8 ? "var(--warn)" : "var(--fail)";
      cards.push(statCard("\u2605 Delivery Rate", fmtRate(ratio), fmtCount(recv.count) + " / " + fmtCount(sent.count), rc));
    }
    var readReceipt = extractMetric(data, "read_receipt_match");
    if (readReceipt) {
      var rrc = readReceipt.rate > 0.9 ? "var(--pass)" : readReceipt.rate > 0.7 ? "var(--warn)" : "var(--fail)";
      cards.push(statCard("\u2605 Read Receipts", fmtRate(readReceipt.rate), "Buyer got receipt back", rrc));
    }
  }

  if (scenario === "realistic-load") {
    var browseLat = extractMetric(data, "browse_items_latency");
    if (browseLat) {
      var bc = browseLat["p(95)"] < 3000 ? "var(--pass)" : "var(--warn)";
      cards.push(statCard("Browse p95", fmtMs(browseLat["p(95)"]), "Item listing API", bc));
    }
    var browseErr = extractMetric(data, "browse_errors");
    if (browseErr) {
      var bec = browseErr.rate < 0.01 ? "var(--pass)" : browseErr.rate < 0.05 ? "var(--warn)" : "var(--fail)";
      cards.push(statCard("Browse Errors", fmtRate(browseErr.rate), "REST failure rate", bec));
    }
  }

  if (scenario === "presence-hub-final" || scenario === "presence-hub") {
    var hbLat = extractMetric(data, "heartbeat_ack_latency");
    if (hbLat) {
      var hc = hbLat["p(95)"] < 1500 ? "var(--pass)" : "var(--warn)";
      cards.push(statCard("Heartbeat ACK p95", fmtMs(hbLat["p(95)"]), "Server confirmation", hc));
    }
    var iuoLat = extractMetric(data, "is_user_online_latency");
    if (iuoLat) {
      var ic = iuoLat["p(95)"] < 2000 ? "var(--pass)" : "var(--warn)";
      cards.push(statCard("IsUserOnline p95", fmtMs(iuoLat["p(95)"]), "Presence check", ic));
    }
  }

  if (scenario === "presence-stress") {
    var rate = extractMetric(data, "presence_online_rate");
    if (rate) {
      var pc = rate.rate > 0.9 ? "var(--pass)" : rate.rate > 0.8 ? "var(--warn)" : "var(--fail)";
      cards.push(statCard("Online Rate", fmtRate(rate.rate), "IsUserOnline accuracy", pc));
    }
  }

  return cards.join("\n");
}

function statCard(label, value, sub, color) {
  return '  <div class="stat-card">\n'
    + '    <div class="stat-label">' + escHtml(label) + '</div>\n'
    + '    <div class="stat-value" style="color:' + (color || 'var(--text)') + '">' + escHtml(value) + '</div>\n'
    + '    <div class="stat-sub">' + escHtml(sub || '') + '</div>\n'
    + '  </div>';
}

function buildDetailedMetricsTable(data, metricDefs) {
  var hasGroups = false;
  for (var i = 0; i < metricDefs.length; i++) {
    if (metricDefs[i].group) { hasGroups = true; break; }
  }

  if (hasGroups) {
    return buildGroupedMetricsTable(data, metricDefs);
  }

  var trendDefs = metricDefs.filter(function(d) { return d.type === "trend"; });
  var rateDefs = metricDefs.filter(function(d) { return d.type === "rate"; });
  var counterDefs = metricDefs.filter(function(d) { return d.type === "counter"; });
  var html = "";

  if (trendDefs.length > 0) html += buildTrendTable(data, trendDefs, "Latency / Duration");
  if (rateDefs.length > 0 || counterDefs.length > 0) html += buildRatesCountersTable(data, rateDefs, counterDefs, "Rates & Counters");
  return html;
}

function buildGroupedMetricsTable(data, metricDefs) {
  var groupOrder = [];
  var groupMap = {};
  for (var i = 0; i < metricDefs.length; i++) {
    var g = metricDefs[i].group || "Other";
    if (!groupMap[g]) { groupMap[g] = []; groupOrder.push(g); }
    groupMap[g].push(metricDefs[i]);
  }

  var html = "";
  for (var gi = 0; gi < groupOrder.length; gi++) {
    var group = groupOrder[gi];
    var defs = groupMap[group];
    var trendDefs = defs.filter(function(d) { return d.type === "trend"; });
    var rateDefs = defs.filter(function(d) { return d.type === "rate"; });
    var counterDefs = defs.filter(function(d) { return d.type === "counter"; });

    if (trendDefs.length > 0) html += buildTrendTable(data, trendDefs, group + " \u2014 Latency");
    if (rateDefs.length > 0 || counterDefs.length > 0) html += buildRatesCountersTable(data, rateDefs, counterDefs, group + " \u2014 Rates & Counts");
  }
  return html;
}

function buildTrendTable(data, defs, title) {
  var rows = "";
  for (var i = 0; i < defs.length; i++) {
    var d = defs[i];
    var m = extractMetric(data, d.key);
    if (!m) {
      rows += '    <tr><td>' + escHtml(d.label) + ' <span style="color:var(--text3);font-size:0.72rem">' + escHtml(d.desc) + '</span></td><td colspan="7" class="text-center" style="color:var(--text3)">No data</td></tr>\n';
    } else {
      rows += '    <tr>\n'
        + '      <td>' + escHtml(d.label) + ' <span style="color:var(--text3);font-size:0.72rem;display:block">' + escHtml(d.desc) + '</span></td>\n'
        + '      <td class="text-right text-mono">' + fmtMs(m.avg) + '</td>\n'
        + '      <td class="text-right text-mono">' + fmtMs(m.min) + '</td>\n'
        + '      <td class="text-right text-mono">' + fmtMs(m.med) + '</td>\n'
        + '      <td class="text-right text-mono">' + fmtMs(m["p(90)"]) + '</td>\n'
        + '      <td class="text-right text-mono" style="font-weight:700">' + fmtMs(m["p(95)"]) + '</td>\n'
        + '      <td class="text-right text-mono">' + fmtMs(m["p(99)"]) + '</td>\n'
        + '      <td class="text-right text-mono">' + fmtMs(m.max) + '</td>\n'
        + '    </tr>\n';
    }
  }
  return '<div class="card">\n<h3>' + escHtml(title) + '</h3>\n<table>\n'
    + '  <thead><tr><th>Metric</th><th class="text-right">Avg</th><th class="text-right">Min</th><th class="text-right">p50</th><th class="text-right">p90</th><th class="text-right">p95</th><th class="text-right">p99</th><th class="text-right">Max</th></tr></thead>\n'
    + '  <tbody>\n' + rows + '  </tbody>\n</table>\n</div>\n';
}

function buildRatesCountersTable(data, rateDefs, counterDefs, title) {
  var rows = "";
  for (var i = 0; i < rateDefs.length; i++) {
    var d = rateDefs[i];
    var m = extractMetric(data, d.key);
    if (!m) {
      rows += '    <tr><td>' + escHtml(d.label) + '</td><td style="color:var(--text3)">' + escHtml(d.desc) + '</td><td class="text-right" style="color:var(--text3)">\u2014</td></tr>\n';
    } else {
      var isError = d.key.indexOf("error") >= 0 || d.key.indexOf("fail") >= 0;
      var pct = m.rate * 100;
      var color;
      if (isError) { color = pct < 1 ? "var(--pass)" : pct < 5 ? "var(--warn)" : "var(--fail)"; }
      else { color = pct > 95 ? "var(--pass)" : pct > 80 ? "var(--warn)" : "var(--fail)"; }
      rows += '    <tr>\n      <td>' + escHtml(d.label) + '</td>\n      <td style="color:var(--text3)">' + escHtml(d.desc) + '</td>\n      <td class="text-right" style="color:' + color + ';font-weight:700">' + fmtRate(m.rate) + '</td>\n    </tr>\n';
    }
  }
  for (var j = 0; j < counterDefs.length; j++) {
    var d2 = counterDefs[j];
    var m2 = extractMetric(data, d2.key);
    if (!m2) {
      rows += '    <tr><td>' + escHtml(d2.label) + '</td><td style="color:var(--text3)">' + escHtml(d2.desc) + '</td><td class="text-right" style="color:var(--text3)">\u2014</td></tr>\n';
    } else {
      rows += '    <tr>\n      <td>' + escHtml(d2.label) + '</td>\n      <td style="color:var(--text3)">' + escHtml(d2.desc) + '</td>\n      <td class="text-right text-mono" style="font-weight:700">' + fmtCount(m2.count) + '</td>\n    </tr>\n';
    }
  }
  return '<div class="card">\n<h3>' + escHtml(title) + '</h3>\n<table>\n'
    + '  <thead><tr><th>Metric</th><th>Description</th><th class="text-right" style="width:120px">Value</th></tr></thead>\n'
    + '  <tbody>\n' + rows + '  </tbody>\n</table>\n</div>\n';
}

function buildChecksSection(data) {
  if (!data.root_group) return "";
  var allChecks = [];
  collectChecks(data.root_group, allChecks);
  if (allChecks.length === 0) return "";

  var rows = "";
  for (var i = 0; i < allChecks.length; i++) {
    var c = allChecks[i];
    var total = c.passes + c.fails;
    var rate = total > 0 ? c.passes / total : 0;
    var color = rate >= 1.0 ? "var(--pass)" : rate > 0.9 ? "var(--warn)" : "var(--fail)";
    rows += '    <tr>\n'
      + '      <td>' + escHtml(c.name) + '</td>\n'
      + '      <td class="text-right">' + fmtCount(c.passes) + '</td>\n'
      + '      <td class="text-right" style="color:' + (c.fails > 0 ? 'var(--fail)' : 'var(--text3)') + '">' + fmtCount(c.fails) + '</td>\n'
      + '      <td class="text-right" style="color:' + color + ';font-weight:700">' + fmtRate(rate) + '</td>\n'
      + '    </tr>\n';
  }

  return '<h2><span class="section-icon">&#9745;</span> Checks</h2>\n'
    + '<div class="card">\n<table>\n'
    + '  <thead><tr><th>Check</th><th class="text-right">Passes</th><th class="text-right">Failures</th><th class="text-right" style="width:100px">Rate</th></tr></thead>\n'
    + '  <tbody>\n' + rows + '  </tbody>\n</table>\n</div>';
}

function collectChecks(group, arr) {
  if (group.checks) {
    var checkKeys = Object.keys(group.checks);
    for (var i = 0; i < checkKeys.length; i++) {
      var check = group.checks[checkKeys[i]];
      arr.push({ name: check.name || checkKeys[i], passes: check.passes || 0, fails: check.fails || 0 });
    }
  }
  if (group.groups) {
    var groupKeys = Object.keys(group.groups);
    for (var j = 0; j < groupKeys.length; j++) {
      collectChecks(group.groups[groupKeys[j]], arr);
    }
  }
}

function buildTrafficMixSection(mix) {
  if (!mix || mix.length === 0) return "";
  var total = mix.reduce(function(s, t) { return s + (t.vus || 0); }, 0);
  var segments = "";
  for (var i = 0; i < mix.length; i++) {
    var t = mix[i];
    var pct = total > 0 ? ((t.vus / total) * 100).toFixed(1) : 0;
    segments += '\n    <div class="mix-segment" style="flex:' + t.vus + ';background:' + t.color + '" title="' + escHtml(t.label) + ': ' + pct + '%">' + pct + '%</div>';
  }
  var legend = "";
  for (var j = 0; j < mix.length; j++) {
    var t2 = mix[j];
    legend += '\n    <div class="mix-item">\n'
      + '      <div class="mix-dot" style="background:' + t2.color + '"></div>\n'
      + '      <div>\n'
      + '        <div class="mix-label">' + escHtml(t2.label) + '</div>\n'
      + '        <div class="mix-detail">' + t2.percentage.toFixed(1) + '% &mdash; ' + fmtCount(t2.vus) + ' VUs</div>\n'
      + '      </div>\n'
      + '    </div>';
  }
  return '\n<h2><span class="section-icon">&#128101;</span> Traffic Distribution</h2>\n'
    + '<div class="card">\n'
    + '  <div class="mix-bar">' + segments + '\n  </div>\n'
    + '  <div class="mix-legend">' + legend + '\n  </div>\n'
    + '</div>\n';
}

// ════════════════════════════════════════════════════════════════
// TEXT SUMMARY (stdout)
// ════════════════════════════════════════════════════════════════

function buildTextSummary(scenario, stageName, overallPass, thresholds, throughput, recs, data, metricDefs, trafficMix, connHealth, chatHealth, apiHealth, presHealth) {
  var lines = [];
  lines.push("");
  lines.push("\u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557");
  lines.push("\u2551  C2C LOAD TEST REPORT                                       \u2551");
  lines.push("\u2560\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2563");
  lines.push("\u2551  Scenario:  " + scenarioLabel(scenario).padEnd(48) + "\u2551");
  lines.push("\u2551  Stage:     " + stageName.padEnd(48) + "\u2551");
  lines.push("\u2551  Target:    " + BASE_URL.padEnd(48) + "\u2551");
  lines.push(("\u2551  Result:    " + (overallPass ? "\u2713 ALL THRESHOLDS PASSED" : "\u2717 THRESHOLD(S) FAILED")).padEnd(63) + "\u2551");
  lines.push("\u255A\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255D");
  lines.push("");

  // Health verdicts
  lines.push("\u2500\u2500\u2500 System Health \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500");
  lines.push("  " + connHealth.icon + " Connection:  " + connHealth.verdict.toUpperCase());
  if (chatHealth) lines.push("  " + chatHealth.icon + " Chat:        " + chatHealth.verdict.toUpperCase());
  if (apiHealth) lines.push("  " + apiHealth.icon + " REST API:    " + apiHealth.verdict.toUpperCase());
  if (presHealth) lines.push("  " + presHealth.icon + " Presence:    " + presHealth.verdict.toUpperCase());
  lines.push("");

  // Traffic mix
  if (trafficMix && trafficMix.length > 0) {
    lines.push("\u2500\u2500\u2500 Traffic Distribution \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500");
    var total = trafficMix.reduce(function(s, t) { return s + (t.vus || 0); }, 0);
    for (var i = 0; i < trafficMix.length; i++) {
      var t = trafficMix[i];
      var pct = total > 0 ? ((t.vus / total) * 100).toFixed(1) : "0.0";
      var bar = "\u2588".repeat(Math.round(t.percentage / 2.5));
      lines.push("  " + t.label.padEnd(20) + " " + bar.padEnd(32) + " " + pct.padStart(5) + "% (" + fmtCount(t.vus) + " VUs)");
    }
    lines.push("  " + "".padEnd(20) + " Total: " + fmtCount(total) + " VUs");
    lines.push("");
  }

  // Thresholds
  lines.push("\u2500\u2500\u2500 Thresholds \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500");
  for (var i = 0; i < thresholds.length; i++) {
    var t2 = thresholds[i];
    var icon = t2.passed ? "\u2713" : "\u2717";
    lines.push("  " + icon + " " + t2.metric.padEnd(35) + " " + t2.threshold.padEnd(20) + " " + (t2.passed ? "PASS" : "FAIL"));
  }
  lines.push("");

  // Key metrics
  lines.push("\u2500\u2500\u2500 Key Metrics \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500");
  for (var i = 0; i < metricDefs.length; i++) {
    var def = metricDefs[i];
    var m = extractMetric(data, def.key);
    if (!m) continue;
    if (def.type === "trend") {
      lines.push("  " + def.label.padEnd(30) + " avg=" + fmtMs(m.avg).padEnd(10) + " p50=" + fmtMs(m.med).padEnd(10) + " p95=" + fmtMs(m["p(95)"]));
    } else if (def.type === "rate") {
      lines.push("  " + def.label.padEnd(30) + " " + fmtRate(m.rate));
    } else if (def.type === "counter") {
      lines.push("  " + def.label.padEnd(30) + " " + fmtCount(m.count));
    }
  }
  lines.push("");

  // Throughput
  if (throughput.length > 0) {
    lines.push("\u2500\u2500\u2500 Throughput \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500");
    for (var i = 0; i < throughput.length; i++) {
      lines.push("  " + throughput[i].label.padEnd(30) + " " + throughput[i].value);
    }
    lines.push("");
  }

  // Recommendations
  lines.push("\u2500\u2500\u2500 Recommendations \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500");
  for (var i = 0; i < recs.length; i++) {
    var r = recs[i];
    var prefix = r.severity === "critical" ? "\uD83D\uDD34" : r.severity === "warning" ? "\uD83D\uDFE1" : "\uD83D\uDFE2";
    lines.push("  " + prefix + " " + (r.title || "") + ": " + r.text);
    if (r.action) lines.push("     \u2192 " + r.action);
  }
  lines.push("");
  lines.push("\u2500\u2500\u2500 Report files saved to ./results/ directory \u2500\u2500\u2500");
  lines.push("");

  return lines.join("\n");
}
