#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════════
// Scenario 03 — Sustained Presence + Heartbeat
// ═══════════════════════════════════════════════════════════════════════════════
// Holds 2000 connections for 30 minutes with active heartbeat.
// Verifies Redis TTL (120s) doesn't expire under sustained load.
// Every minute, 10% of users call IsUserOnline(random) to measure query latency.
// ═══════════════════════════════════════════════════════════════════════════════

import {
  runScenario,
  sleep,
  fetchServerMetrics,
} from "../helpers/scenario-runner.js";
import { generateTokenBatch } from "../helpers/jwt-helper.js";
import {
  connectPresenceUsers,
  disconnectAll,
} from "../helpers/presence-user.js";

await runScenario("03-Heartbeat-Sustained", async (stats, config) => {
  const profile = config.profiles.heartbeat;

  // ── Connect all users ─────────────────────────────────────────────────────
  console.log(`  🔑 Generating ${profile.totalUsers} tokens...`);
  const tokens = generateTokenBatch(profile.totalUsers);

  console.log(`  📡 Connecting ${profile.totalUsers} presence users...`);
  const users = await connectPresenceUsers(tokens, stats, profile.rampPerSec);

  const active = users.filter((u) => u.isConnected).length;
  console.log(`  ✅ ${active}/${profile.totalUsers} connected\n`);

  // ── Sustained hold with periodic IsUserOnline probing ─────────────────────
  const durationMs = profile.durationSec * 1000;
  const startTime = Date.now();
  let minuteCounter = 0;

  while (Date.now() - startTime < durationMs) {
    await sleep(60_000); // Every minute
    minuteCounter++;

    const currentActive = users.filter((u) => u.isConnected).length;

    // 10% of users probe IsUserOnline
    const probeCount = Math.ceil(
      currentActive * (profile.isUserOnlinePercent / 100),
    );
    const connectedUsers = users.filter((u) => u.isConnected);

    const probePromises = [];
    for (let i = 0; i < probeCount && i < connectedUsers.length; i++) {
      // Pick a random target
      const targetIdx = Math.floor(Math.random() * tokens.length);
      probePromises.push(
        connectedUsers[i].isUserOnline(tokens[targetIdx].username),
      );
    }
    await Promise.allSettled(probePromises);

    // Server metrics check
    const serverMetrics = await fetchServerMetrics();
    const serverTotal = serverMetrics?.total ?? "?";

    console.log(
      `  📊 Minute ${minuteCounter}: active=${currentActive} | server=${serverTotal} | disconnects=${stats.counters.unexpectedDisconnects} | probes=${probeCount}`,
    );

    // Snapshot every 5 minutes
    if (minuteCounter % 5 === 0) {
      stats.takeTierSnapshot(`minute-${minuteCounter}`);
    }
  }

  // ── Disconnect ────────────────────────────────────────────────────────────
  console.log("\n  🔌 Disconnecting...");
  await disconnectAll(users);

  console.log("  ✅ Heartbeat sustained test complete");
  console.log(
    `  📋 Unexpected disconnections: ${stats.counters.unexpectedDisconnects}`,
  );
  console.log(`  📋 Reconnections: ${stats.counters.reconnections}`);
});
