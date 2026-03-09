// ═══════════════════════════════════════════════════════════════════════════════
// SignalR Client Factory — Creates real @microsoft/signalr connections
// ═══════════════════════════════════════════════════════════════════════════════
// Uses the official Microsoft SignalR client — same protocol the MiniApp uses.
// Ensures 100% correct WebSocket handshake, binary framing, and ping/pong.
// ═══════════════════════════════════════════════════════════════════════════════

import * as signalR from "@microsoft/signalr";
import { WebSocket } from "ws";
import config from "../config.js";

const LogLevel = signalR.LogLevel;

/**
 * Create a PresenceHub connection.
 *
 * @param {string} token — Valid QiServiceScheme JWT
 * @param {object} [opts] — Optional overrides
 * @returns {signalR.HubConnection}
 */
export function createPresenceConnection(token, opts = {}) {
  const url = `${opts.baseUrl || config.BASE_URL}${config.PRESENCE_HUB}`;

  const connection = new signalR.HubConnectionBuilder()
    .withUrl(`${url}?access_token=${encodeURIComponent(token)}`, {
      skipNegotiation: true,
      transport: signalR.HttpTransportType.WebSockets,
      WebSocket,
    })
    .withAutomaticReconnect({
      nextRetryDelayInMilliseconds: (ctx) => {
        const delays = [0, 2000, 5000, 10_000, 30_000];
        return ctx.previousRetryCount < delays.length
          ? delays[ctx.previousRetryCount]
          : null;
      },
    })
    .configureLogging(opts.logLevel ?? LogLevel.None)
    .build();

  applyTimeouts(connection);
  return connection;
}

/**
 * Create a MessageHub connection.
 * Requires recipientUsername + itemId query params (validated by OnConnectedAsync).
 *
 * @param {string} token — Valid QiServiceScheme JWT
 * @param {string} recipientUsername — The other user in the chat
 * @param {string} itemId — GUID of the item being discussed
 * @param {object} [opts] — Optional overrides
 * @returns {signalR.HubConnection}
 */
export function createMessageConnection(
  token,
  recipientUsername,
  itemId,
  opts = {},
) {
  const url = `${opts.baseUrl || config.BASE_URL}${config.MESSAGE_HUB}`;
  const qs = new URLSearchParams({
    access_token: token,
    recipientUsername,
    itemId,
  });

  const connection = new signalR.HubConnectionBuilder()
    .withUrl(`${url}?${qs.toString()}`, {
      skipNegotiation: true,
      transport: signalR.HttpTransportType.WebSockets,
      WebSocket,
    })
    .withAutomaticReconnect({
      nextRetryDelayInMilliseconds: (ctx) => {
        const delays = [0, 2000, 5000, 10_000, 30_000];
        return ctx.previousRetryCount < delays.length
          ? delays[ctx.previousRetryCount]
          : null;
      },
    })
    .configureLogging(opts.logLevel ?? LogLevel.None)
    .build();

  applyTimeouts(connection);
  return connection;
}

/**
 * Apply standard timeouts to a connection.
 * Matches the server's Program.cs SignalR hub options.
 *
 * @param {signalR.HubConnection} connection
 */
export function applyTimeouts(connection) {
  connection.serverTimeoutInMilliseconds = config.signalr.SERVER_TIMEOUT_MS;
  connection.keepAliveIntervalInMilliseconds = config.signalr.KEEP_ALIVE_MS;
}

/**
 * Start a connection with timeout protection.
 *
 * @param {signalR.HubConnection} connection
 * @param {number} [timeoutMs] — Max time to wait for connect
 * @returns {Promise<void>}
 */
export async function startWithTimeout(
  connection,
  timeoutMs = config.signalr.HANDSHAKE_TIMEOUT_MS,
) {
  return Promise.race([
    connection.start(),
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error(`Connection timed out after ${timeoutMs}ms`)),
        timeoutMs,
      ),
    ),
  ]);
}

/**
 * Gracefully stop a connection (swallows errors).
 *
 * @param {signalR.HubConnection} connection
 */
export async function stopGracefully(connection) {
  try {
    if (
      connection?.state === signalR.HubConnectionState.Connected ||
      connection?.state === signalR.HubConnectionState.Connecting ||
      connection?.state === signalR.HubConnectionState.Reconnecting
    ) {
      await connection.stop();
    }
  } catch {
    // Swallow — disconnection errors are expected during load tests
  }
}
