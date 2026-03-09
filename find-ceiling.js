#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════════
// Quick Ceiling Finder — Connects slowly and reports exactly when/why failures start
// ═══════════════════════════════════════════════════════════════════════════════

import * as signalR from "@microsoft/signalr";
import { WebSocket } from "ws";
import config from "./config.js";
import { generateTokenBatch } from "./helpers/jwt-helper.js";

const TARGET = 150; // Reduced - we know limit is ~100
const RATE = 5; // Slower to be precise
const BATCH_SIZE = 10; // Finer reporting
const CONNECT_TIMEOUT = 10_000;

console.log(`\n═══ Ceiling Finder ═══════════════════════════════════`);
console.log(`Target: ${TARGET} connections @ ${RATE}/sec`);
console.log(`Server: ${config.BASE_URL}`);
console.log(`═══════════════════════════════════════════════════════\n`);

const tokens = generateTokenBatch(TARGET);
const connections = [];
let succeeded = 0;
let failed = 0;
let firstFailReason = null;
let firstFailAt = 0;

for (let i = 0; i < TARGET; i++) {
  const url = `${config.BASE_URL}${config.PRESENCE_HUB}?access_token=${encodeURIComponent(tokens[i].token)}`;

  const conn = new signalR.HubConnectionBuilder()
    .withUrl(url, {
      skipNegotiation: true,
      transport: signalR.HttpTransportType.WebSockets,
      WebSocket,
    })
    .configureLogging(signalR.LogLevel.None)
    .build();

  conn.serverTimeoutInMilliseconds = 60_000;
  conn.keepAliveIntervalInMilliseconds = 15_000;

  try {
    await Promise.race([
      conn.start(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Timeout")), CONNECT_TIMEOUT),
      ),
    ]);
    connections.push(conn);
    succeeded++;
  } catch (err) {
    failed++;
    if (failed <= 3) {
      console.log(
        `    ⚠️  Connection #${i + 1} failed: ${err.message.substring(0, 150)}`,
      );
    }
    if (!firstFailReason) {
      firstFailReason = err.message;
      firstFailAt = i + 1;
    }
  }

  // Progress report
  if ((i + 1) % BATCH_SIZE === 0 || i === TARGET - 1) {
    console.log(
      `  [${i + 1}/${TARGET}] ✅ ${succeeded} connected | ❌ ${failed} failed`,
    );
  }

  // Pace connections
  if ((i + 1) % RATE === 0) {
    await new Promise((r) => setTimeout(r, 1000));
  }
}

console.log(`\n═══ Results ════════════════════════════════════════════`);
console.log(`  Total attempted:  ${TARGET}`);
console.log(`  Connected:        ${succeeded}`);
console.log(`  Failed:           ${failed}`);
console.log(`  Success rate:     ${((succeeded / TARGET) * 100).toFixed(1)}%`);
if (firstFailReason) {
  console.log(`  First failure at: connection #${firstFailAt}`);
  console.log(`  Failure reason:   ${firstFailReason.substring(0, 200)}`);
}
console.log(`═══════════════════════════════════════════════════════\n`);

// Disconnect all
console.log(`  🔌 Disconnecting ${connections.length} connections...`);
const batchDisconnect = 50;
for (let i = 0; i < connections.length; i += batchDisconnect) {
  await Promise.allSettled(
    connections.slice(i, i + batchDisconnect).map((c) => c.stop()),
  );
}
console.log(`  ✅ Done`);
process.exit(0);
