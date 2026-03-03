/**
 * SignalR JSON Protocol Helpers for k6
 *
 * Handles negotiate, WebSocket connection, handshake,
 * message framing (Record Separator 0x1E), and hub invocations.
 */

import http from "k6/http";
import { check } from "k6";
import { BASE_URL, WS_URL, HUBS, TIMING } from "../config.js";

// SignalR uses ASCII Record Separator (0x1E) as message delimiter
export const RECORD_SEPARATOR = "\x1e";

// SignalR message types
export const MSG_TYPE = {
  INVOCATION: 1,
  STREAM_ITEM: 2,
  COMPLETION: 3,
  STREAM_INVOCATION: 4,
  CANCEL_INVOCATION: 5,
  PING: 6,
  CLOSE: 7,
};

// ─── Negotiate ────────────────────────────────────────────────

/**
 * Perform SignalR negotiate handshake over HTTP.
 *
 * @param {string} hubPath - e.g. '/hubs/presence'
 * @param {string} token   - JWT token
 * @param {object} [queryParams] - Additional query params (e.g. { user: 'bob', itemId: '...' })
 * @returns {{ connectionId: string, connectionToken: string, negotiateVersion: number } | null}
 */
export function negotiate(hubPath, token, queryParams) {
  let url = `${BASE_URL}${hubPath}/negotiate?negotiateVersion=1`;

  if (queryParams) {
    for (const [k, v] of Object.entries(queryParams)) {
      url += `&${encodeURIComponent(k)}=${encodeURIComponent(v)}`;
    }
  }

  const res = http.post(url, null, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
    tags: { name: "negotiate" },
  });

  const ok = check(res, {
    "negotiate status 200": (r) => r.status === 200,
  });

  if (!ok) {
    console.error(`Negotiate failed: ${res.status} ${res.body}`);
    return null;
  }

  return JSON.parse(res.body);
}

// ─── WebSocket URL builder ────────────────────────────────────

/**
 * Build the WebSocket URL for a hub connection.
 *
 * @param {string} hubPath     - e.g. '/hubs/presence'
 * @param {string} token       - JWT token (sent as query param for WebSocket)
 * @param {string} [connId]    - Connection ID from negotiate (optional)
 * @param {object} [queryParams] - Additional query params
 * @returns {string} Full wss:// URL
 */
export function buildWsUrl(hubPath, token, connId, queryParams) {
  let url = `${WS_URL}${hubPath}?access_token=${encodeURIComponent(token)}`;

  if (connId) {
    url += `&id=${encodeURIComponent(connId)}`;
  }

  if (queryParams) {
    for (const [k, v] of Object.entries(queryParams)) {
      url += `&${encodeURIComponent(k)}=${encodeURIComponent(v)}`;
    }
  }

  return url;
}

// ─── Message framing ──────────────────────────────────────────

/**
 * Create the SignalR handshake request message.
 * Must be sent immediately after WebSocket open.
 *
 * @returns {string} Handshake message with record separator
 */
export function handshakeMessage() {
  return JSON.stringify({ protocol: "json", version: 1 }) + RECORD_SEPARATOR;
}

/**
 * Create a hub invocation message.
 *
 * @param {string} target     - Hub method name (e.g. 'Heartbeat', 'SendMessage')
 * @param {Array}  args       - Arguments array
 * @param {string} [invocationId] - Optional invocation ID for non-fire-and-forget
 * @returns {string} Framed message
 */
export function invocationMessage(target, args, invocationId) {
  const msg = {
    type: MSG_TYPE.INVOCATION,
    target: target,
    arguments: args || [],
  };

  if (invocationId) {
    msg.invocationId = invocationId;
  }

  return JSON.stringify(msg) + RECORD_SEPARATOR;
}

/**
 * Create a SignalR ping message.
 *
 * @returns {string} Framed ping
 */
export function pingMessage() {
  return JSON.stringify({ type: MSG_TYPE.PING }) + RECORD_SEPARATOR;
}

/**
 * Parse raw WebSocket data into individual SignalR messages.
 * Messages are delimited by Record Separator (0x1E).
 *
 * @param {string} rawData - Raw WebSocket frame data
 * @returns {Array<object>} Parsed messages (JSON objects)
 */
export function parseMessages(rawData) {
  if (!rawData) return [];

  const messages = [];
  const parts = rawData.split(RECORD_SEPARATOR);

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    try {
      messages.push(JSON.parse(trimmed));
    } catch (e) {
      // Log parse errors in debug mode (partial frames are common under load)
      if (__ENV.DEBUG) {
        console.warn(
          `SignalR parse error: ${e.message} | data: ${trimmed.substring(0, 100)}`,
        );
      }
    }
  }

  return messages;
}

/**
 * Check if a parsed message is a specific hub event.
 *
 * @param {object} msg    - Parsed SignalR message
 * @param {string} target - Event name (e.g. 'UserIsOnline', 'InPersonOfferReceived')
 * @returns {boolean}
 */
export function isEvent(msg, target) {
  return msg && msg.type === MSG_TYPE.INVOCATION && msg.target === target;
}

/**
 * Check if a parsed message is a completion (response to an invocation).
 *
 * @param {object} msg          - Parsed SignalR message
 * @param {string} invocationId - The invocation ID to match
 * @returns {boolean}
 */
export function isCompletion(msg, invocationId) {
  return (
    msg && msg.type === MSG_TYPE.COMPLETION && msg.invocationId === invocationId
  );
}

/**
 * Check if a parsed message is a close message.
 *
 * @param {object} msg - Parsed SignalR message
 * @returns {boolean}
 */
export function isClose(msg) {
  return msg && msg.type === MSG_TYPE.CLOSE;
}

/**
 * Check if a parsed message is the handshake response.
 * A successful handshake response is an empty JSON object {}.
 *
 * @param {object} msg - Parsed message
 * @returns {boolean}
 */
export function isHandshakeResponse(msg) {
  return msg && typeof msg === "object" && !msg.type && !msg.error;
}

/**
 * Check if a parsed message is a handshake error.
 *
 * @param {object} msg - Parsed message
 * @returns {boolean}
 */
export function isHandshakeError(msg) {
  return msg && typeof msg.error === "string";
}
