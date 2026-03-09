#!/usr/bin/env node
// Debug script: Send a single message — test both WS and main API domains
// Now uses only buyers who have Profile records (all 4 sellers)

import * as signalR from "@microsoft/signalr";
import { WebSocket } from "ws";
import config from "./config.js";
import { generateToken } from "./helpers/jwt-helper.js";
import { loadSeedData } from "./helpers/seed-loader.js";

const WS_URL = config.BASE_URL; // ws-c2c-api-uat.gini.iq
const MAIN_URL = "https://c2c-api-uat.gini.iq"; // main API domain

console.log("\n── Config ─────────────────────────────────────────");
console.log("WS   URL:", WS_URL);
console.log("Main URL:", MAIN_URL);
console.log("JWT Algo:", config.jwt.ALGORITHM);

const seed = loadSeedData(1);
const item = seed[0];
console.log("\n── Test Data ──────────────────────────────────────");
console.log("Item:", item.itemId, `(${item.name})`);
console.log("Seller:", item.sellerUsername);
console.log("Buyer:", item.buyerUsername);

const sellerToken = generateToken(0, {
  username: item.sellerUsername,
  userId: item.sellerUserId,
});
console.log("Token:", sellerToken.token.substring(0, 40) + "...");

const payload = {
  recipientUsername: item.buyerUsername,
  itemId: item.itemId,
  content: "Load test curl-equivalent " + Date.now(),
  // NOTE: Do NOT send messageType — frontend doesn't send it either.
  // Text=1 in the enum, so sending 0 causes validation failure.
};

// ── Test on each domain ─────────────────────────────────────────────────────
for (const [label, baseUrl] of [
  ["WS domain", WS_URL],
  ["Main domain", MAIN_URL],
]) {
  console.log(`\n══ ${label}: ${baseUrl} ══════════════════════════`);

  const hubUrl = `${baseUrl}/hubs/message?recipientUsername=${item.buyerUsername}&itemId=${item.itemId}&access_token=${sellerToken.token}`;

  const conn = new signalR.HubConnectionBuilder()
    .withUrl(hubUrl, {
      skipNegotiation: true,
      transport: signalR.HttpTransportType.WebSockets,
      WebSocket: WebSocket,
    })
    .configureLogging(signalR.LogLevel.Warning)
    .build();

  conn.serverTimeoutInMilliseconds = 60000;
  conn.keepAliveIntervalInMilliseconds = 15000;

  try {
    await conn.start();
    console.log("  ✅ Connected");

    console.log("  📨 SendMessage:", JSON.stringify(payload));
    const result = await conn.invoke("SendMessage", payload);
    console.log(
      "  ✅ SUCCESS! ID:",
      result?.id,
      "sender:",
      result?.senderUsername,
      "→",
      result?.recipientUsername,
    );
  } catch (err) {
    console.log("  ❌", err.message);
  }

  try {
    await conn.stop();
  } catch {}
}

// ── Also test REST thread endpoint to confirm data access ───────────────────
console.log("\n══ REST curl-equivalent: GET message thread ══════════");
const threadUrl = `${MAIN_URL}/api/pos/Messages/thread/${item.buyerUsername}?itemId=${item.itemId}`;
console.log("  URL:", threadUrl);
try {
  const resp = await fetch(threadUrl, {
    headers: { Authorization: `Bearer ${sellerToken.token}` },
  });
  const body = await resp.text();
  console.log("  HTTP", resp.status, "— body length:", body.length, "chars");
  if (body.length < 500) console.log("  Body:", body);
} catch (err) {
  console.log("  ❌", err.message);
}

process.exit(0);
