// ═══════════════════════════════════════════════════════════════════════════════
// Chat User Pair — Virtual user pair for MessageHub load testing
// ═══════════════════════════════════════════════════════════════════════════════
// Simulates TWO users in a chat conversation: seller + buyer.
// Each pair has:
//   - 2 MessageHub connections (one per user, same chat group)
//   - 2 PresenceHub connections (for notification cross-delivery)
// Exercises: SendMessage, NewMessage, MessageRead, Typing, ReceiveMessageThread
// ═══════════════════════════════════════════════════════════════════════════════

import {
  createPresenceConnection,
  createMessageConnection,
  startWithTimeout,
  stopGracefully,
} from "./signalr-client.js";
import config from "../config.js";
import crypto from "node:crypto";

export class ChatPair {
  /**
   * @param {object} seller — { token, username }
   * @param {object} buyer — { token, username }
   * @param {string} itemId — GUID of the shared item
   * @param {object} stats — Stats collector
   */
  constructor(seller, buyer, itemId, stats) {
    this.seller = seller;
    this.buyer = buyer;
    this.itemId = itemId;
    this.stats = stats;

    // Connections
    this.sellerPresence = null;
    this.buyerPresence = null;
    this.sellerMessage = null;
    this.buyerMessage = null;

    // State
    this._connected = false;
    this._stopped = false;
    this._messageLoop = null;
    this._typingLoop = null;
    this._heartbeatTimers = [];

    // Message tracking (for delivery verification)
    // Key = server-assigned message ID (from invoke result), Value = { sentAt, sender }
    this._pendingMessages = new Map();
    this._sentCount = 0; // total messages successfully sent
    this._receivedThread = { seller: false, buyer: false };
  }

  /**
   * Connect both users to PresenceHub + MessageHub.
   * @returns {Promise<boolean>}
   */
  async start() {
    try {
      // Create all 4 connections
      this.sellerPresence = createPresenceConnection(this.seller.token);
      this.buyerPresence = createPresenceConnection(this.buyer.token);
      this.sellerMessage = createMessageConnection(
        this.seller.token,
        this.buyer.username,
        this.itemId,
      );
      this.buyerMessage = createMessageConnection(
        this.buyer.token,
        this.seller.username,
        this.itemId,
      );

      // Register event listeners BEFORE connecting
      this._registerListeners();

      // Connect presence first (required for notification routing)
      const presenceStart = Date.now();
      const [sellerPresenceResult, buyerPresenceResult] =
        await Promise.allSettled([
          startWithTimeout(this.sellerPresence),
          startWithTimeout(this.buyerPresence),
        ]);
      const presenceElapsed = Date.now() - presenceStart;
      // Record each connection with the parallel batch time (realistic upper bound)
      if (sellerPresenceResult.status === "fulfilled")
        this.stats.recordConnectionTime(presenceElapsed);
      else this.stats.recordConnectionFailure(sellerPresenceResult.reason);
      if (buyerPresenceResult.status === "fulfilled")
        this.stats.recordConnectionTime(presenceElapsed);
      else this.stats.recordConnectionFailure(buyerPresenceResult.reason);

      // Connect message hubs
      const messageStart = Date.now();
      const [sellerMsgResult, buyerMsgResult] = await Promise.allSettled([
        startWithTimeout(this.sellerMessage),
        startWithTimeout(this.buyerMessage),
      ]);
      const messageElapsed = Date.now() - messageStart;
      if (sellerMsgResult.status === "fulfilled")
        this.stats.recordConnectionTime(messageElapsed);
      else this.stats.recordConnectionFailure(sellerMsgResult.reason);
      if (buyerMsgResult.status === "fulfilled")
        this.stats.recordConnectionTime(messageElapsed);
      else this.stats.recordConnectionFailure(buyerMsgResult.reason);

      // All 4 must connect for the pair to be usable
      const allConnected = [
        sellerPresenceResult,
        buyerPresenceResult,
        sellerMsgResult,
        buyerMsgResult,
      ].every((r) => r.status === "fulfilled");

      if (!allConnected) {
        // Partial failure — stop whatever connected and report failure
        await Promise.allSettled([
          stopGracefully(this.sellerPresence),
          stopGracefully(this.buyerPresence),
          stopGracefully(this.sellerMessage),
          stopGracefully(this.buyerMessage),
        ]);
        return false;
      }

      this._connected = true;

      // Start heartbeat for both presence connections
      this._startHeartbeats();

      return true;
    } catch (error) {
      this.stats.recordConnectionFailure(error);
      return false;
    }
  }

  /**
   * Start the messaging loop — seller and buyer alternate sending messages.
   * @param {number} intervalMs — Time between messages per pair
   */
  startMessaging(intervalMs = config.profiles.chat.messageIntervalMs) {
    if (!this._connected) return;

    let turn = 0; // 0 = seller sends, 1 = buyer sends

    this._messageLoop = setInterval(async () => {
      if (!this._connected || this._stopped) return;

      try {
        const sender = turn % 2 === 0 ? "seller" : "buyer";
        const senderConn =
          sender === "seller" ? this.sellerMessage : this.buyerMessage;
        const recipientUsername =
          sender === "seller" ? this.buyer.username : this.seller.username;

        const sentAt = Date.now();
        const traceId = crypto.randomUUID();

        // Track BEFORE sending — NewMessage can arrive before invoke() returns
        this._pendingMessages.set(traceId, { sentAt, sender });

        // Invoke SendMessage on the hub (same command shape as the frontend)
        // NOTE: Do NOT send messageType — enum starts at Text=1, sending 0 causes validation failure
        const command = {
          recipientUsername,
          itemId: this.itemId,
          content: `[${traceId}] Load test`,
        };

        const result = await senderConn.invoke("SendMessage", command);
        this.stats.recordMessageSent();
        this._sentCount++;

        turn++;
      } catch (error) {
        this.stats.recordError("sendMessage", error);
      }
    }, intervalMs);
  }

  /**
   * Start typing indicator loop.
   * @param {number} intervalMs
   */
  startTyping(intervalMs = config.profiles.chat.typingIntervalMs) {
    if (!this._connected) return;

    let typingState = false;

    this._typingLoop = setInterval(async () => {
      if (!this._connected || this._stopped) return;

      try {
        typingState = !typingState;
        // Alternate: seller types, then buyer types
        const conn = typingState ? this.sellerMessage : this.buyerMessage;
        await conn.invoke("Typing", typingState);
        this.stats.recordTypingSent();
      } catch {
        // Non-critical — typing errors are swallowed (matches server behavior)
      }
    }, intervalMs);
  }

  /**
   * Disconnect all connections.
   */
  async stop() {
    this._stopped = true;

    if (this._messageLoop) clearInterval(this._messageLoop);
    if (this._typingLoop) clearInterval(this._typingLoop);
    for (const timer of this._heartbeatTimers) clearInterval(timer);

    // Wait briefly for in-flight messages to arrive before counting losses
    if (this._pendingMessages.size > 0) {
      await new Promise((r) => setTimeout(r, 3000));
    }

    // Only count messages that were never received (still pending after wait)
    for (const [id, meta] of this._pendingMessages) {
      this.stats.recordMessageLost();
    }

    await Promise.allSettled([
      stopGracefully(this.sellerPresence),
      stopGracefully(this.buyerPresence),
      stopGracefully(this.sellerMessage),
      stopGracefully(this.buyerMessage),
    ]);

    if (this._connected) {
      // 4 connections closed (2 presence + 2 message)
      for (let i = 0; i < 4; i++) this.stats.recordDisconnect(true);
      this._connected = false;
    }
  }

  get isConnected() {
    return this._connected && !this._stopped;
  }

  // ── Private ─────────────────────────────────────────────────────────────

  _registerListeners() {
    // ── Seller's MessageHub listeners ──────────────────────────────────────
    this.sellerMessage.on("ReceiveMessageThread", () => {
      this._receivedThread.seller = true;
    });

    this.sellerMessage.on("NewMessage", (payload) => {
      this._handleNewMessage(payload, "seller");
    });

    this.sellerMessage.on("MessageRead", (payload) => {
      this.stats.recordMessageRead(1); // Presence of event = success
    });

    this.sellerMessage.on("UserTyping", () => {
      // Just verify it arrives — no metrics needed
    });

    // ── Buyer's MessageHub listeners ──────────────────────────────────────
    this.buyerMessage.on("ReceiveMessageThread", () => {
      this._receivedThread.buyer = true;
    });

    this.buyerMessage.on("NewMessage", (payload) => {
      this._handleNewMessage(payload, "buyer");
    });

    this.buyerMessage.on("MessageRead", (payload) => {
      this.stats.recordMessageRead(1);
    });

    this.buyerMessage.on("UserTyping", () => {});

    // ── Presence notification listeners (cross-delivery) ──────────────────
    const notificationEvents = [
      "ChatMessageNotification",
      "OfferReceived",
      "OfferStatusChanged",
      "InPersonOfferReceived",
      "InPersonOfferStatusChanged",
      "InvoiceCreated",
      "PaymentCompleted",
      "ChatStatusChanged",
    ];

    for (const event of notificationEvents) {
      this.sellerPresence.on(event, () => this.stats.recordNotification(1));
      this.buyerPresence.on(event, () => this.stats.recordNotification(1));
    }

    // ── Disconnect handlers ───────────────────────────────────────────────
    for (const conn of [
      this.sellerPresence,
      this.buyerPresence,
      this.sellerMessage,
      this.buyerMessage,
    ]) {
      conn.onclose((error) => {
        if (!this._stopped) {
          this.stats.recordDisconnect(false);
        }
      });
      conn.onreconnected(() => {
        this.stats.recordReconnection();
      });
    }
  }

  _handleNewMessage(payload, receiver) {
    const now = Date.now();
    let latencyMs = 1;

    // Extract traceId from content: format is "[<uuid>] Load test"
    const content = payload?.content || "";
    const match = content.match(/^\[([0-9a-f-]{36})\]/);
    const traceId = match ? match[1] : null;

    // Remove from pending using traceId extracted from content
    if (traceId && this._pendingMessages.has(traceId)) {
      const meta = this._pendingMessages.get(traceId);
      latencyMs = Math.max(1, now - meta.sentAt);
      this._pendingMessages.delete(traceId);
    } else if (payload?.messageSent) {
      // Fallback: use server timestamp for latency if traceId not found
      const sent = new Date(payload.messageSent).getTime();
      if (!isNaN(sent)) latencyMs = Math.max(1, now - sent);
    }

    this.stats.recordMessageReceived(latencyMs);
  }

  _startHeartbeats() {
    for (const conn of [this.sellerPresence, this.buyerPresence]) {
      const timer = setInterval(async () => {
        if (this._stopped) return;
        try {
          await conn.invoke("Heartbeat");
          this.stats.recordHeartbeat(1);
        } catch (error) {
          this.stats.recordHeartbeatFailure(error);
        }
      }, config.HEARTBEAT_INTERVAL_MS);
      this._heartbeatTimers.push(timer);
    }
  }
}

/**
 * Connect N chat pairs with pacing.
 *
 * @param {Array<{seller: object, buyer: object, itemId: string}>} pairConfigs
 * @param {object} stats
 * @param {number} rampPerSec — Pairs per second
 * @returns {Promise<ChatPair[]>}
 */
export async function connectChatPairs(pairConfigs, stats, rampPerSec = 20) {
  const pairs = [];
  const delayMs = Math.max(1, Math.floor(1000 / rampPerSec));

  for (let i = 0; i < pairConfigs.length; i++) {
    const { seller, buyer, itemId } = pairConfigs[i];
    const pair = new ChatPair(seller, buyer, itemId, stats);
    pairs.push(pair);

    pair.start().catch(() => {}); // Errors recorded in stats

    if ((i + 1) % rampPerSec === 0) {
      await sleep(1000);
    } else {
      await sleep(delayMs);
    }
  }

  // Wait for all connections to settle
  await sleep(5000);
  return pairs;
}

/**
 * Disconnect all chat pairs.
 * @param {ChatPair[]} pairs
 */
export async function disconnectAllPairs(pairs) {
  const batchSize = 50;
  for (let i = 0; i < pairs.length; i += batchSize) {
    const batch = pairs.slice(i, i + batchSize);
    await Promise.allSettled(batch.map((p) => p.stop()));
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
