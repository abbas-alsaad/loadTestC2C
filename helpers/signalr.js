/**
 * SignalR JSON Protocol Helpers for k6 (NO NEGOTIATE)
 *
 * ✅ Direct WS URL:  wss://<ws-host>/hubs/<hub>?access_token=<jwt>
 * ✅ Handshake framing using Record Separator 0x1E
 * ✅ Buffered parsing (handles partial frames safely)
 * ✅ Invocation + Completion helpers
 */

import { WS_URL } from "../config.js";

export const RECORD_SEPARATOR = "\x1e";

export const MSG_TYPE = {
  INVOCATION: 1,
  STREAM_ITEM: 2,
  COMPLETION: 3,
  STREAM_INVOCATION: 4,
  CANCEL_INVOCATION: 5,
  PING: 6,
  CLOSE: 7,
};

export function buildWsUrl(hubPath, token, queryParams) {
  let url = `${WS_URL}${hubPath}?access_token=${encodeURIComponent(token)}`;
  if (queryParams) {
    for (const [k, v] of Object.entries(queryParams)) {
      url += `&${encodeURIComponent(k)}=${encodeURIComponent(v)}`;
    }
  }
  return url;
}

export function handshakeMessage() {
  return JSON.stringify({ protocol: "json", version: 1 }) + RECORD_SEPARATOR;
}

export function invocationMessage(target, args, invocationId) {
  const msg = { type: MSG_TYPE.INVOCATION, target, arguments: args || [] };
  if (invocationId) msg.invocationId = invocationId;
  return JSON.stringify(msg) + RECORD_SEPARATOR;
}

/**
 * Robust buffered parser:
 * - Keeps incomplete tail between frames.
 * - Returns { messages, buffer }
 */
export function parseMessagesBuffered(rawData, existingBuffer = "") {
  const buffer = (existingBuffer || "") + (rawData || "");
  if (!buffer) return { messages: [], buffer: "" };

  const parts = buffer.split(RECORD_SEPARATOR);
  const tail = parts.pop(); // may be incomplete

  const messages = [];
  for (const part of parts) {
    const trimmed = (part || "").trim();
    if (!trimmed) continue;
    try {
      messages.push(JSON.parse(trimmed));
    } catch (e) {
      if (__ENV.DEBUG) {
        console.warn(
          `SignalR parse error: ${e.message} | data: ${trimmed.substring(0, 160)}`,
        );
      }
    }
  }

  return { messages, buffer: tail || "" };
}

// Legacy non-buffered parser (kept for other scenarios that still use it)
export function parseMessages(rawData) {
  const { messages } = parseMessagesBuffered(rawData, "");
  return messages;
}

export function isHandshakeResponse(msg) {
  return msg && typeof msg === "object" && !msg.type && !msg.error;
}

export function isHandshakeError(msg) {
  return msg && typeof msg.error === "string";
}

export function isClose(msg) {
  return msg && msg.type === MSG_TYPE.CLOSE;
}

export function isEvent(msg, target) {
  return msg && msg.type === MSG_TYPE.INVOCATION && msg.target === target;
}

export function pingMessage() {
  return JSON.stringify({ type: MSG_TYPE.PING }) + RECORD_SEPARATOR;
}

export function isCompletion(msg, prefix) {
  return (
    msg &&
    msg.type === MSG_TYPE.COMPLETION &&
    typeof msg.invocationId === "string" &&
    (!prefix || msg.invocationId.startsWith(prefix))
  );
}
