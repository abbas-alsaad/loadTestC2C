#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════════
// Scenario 02 — Presence Ramp (Connection Scalability)
// ═══════════════════════════════════════════════════════════════════════════════
// Ramps from 0 → 5000 concurrent PresenceHub connections in tiers.
// Measures connection success rate, latency, and server metrics at each tier.
// Each tier holds for observation before ramping further.
// ═══════════════════════════════════════════════════════════════════════════════

import {
  runScenario,
  sleep,
  fetchServerMetrics,
} from "../helpers/scenario-runner.js";
import { generateTokenBatch } from "../helpers/jwt-helper.js";
import {
  PresenceUser,
  connectPresenceUsers,
  disconnectAll,
} from "../helpers/presence-user.js";

await runScenario("02-Presence-Ramp", async (stats, config) => {
  const profile = config.profiles.ramp;
  const allUsers = [];

  // Generate all tokens upfront (fast, in-memory)
  console.log(`  🔑 Generating ${profile.totalUsers} JWT tokens...`);
  const allTokens = generateTokenBatch(profile.totalUsers);
  console.log("  ✅ Tokens generated\n");

  let tokenOffset = 0;

  // ── Ramp through tiers ────────────────────────────────────────────────────
  for (const tierTarget of profile.tiers) {
    const needed = tierTarget - allUsers.filter((u) => u.isConnected).length;
    if (needed <= 0) continue;

    console.log(
      `\n  📈 Ramping to ${tierTarget} connections (adding ${needed})...`,
    );

    const tierTokens = allTokens.slice(tokenOffset, tokenOffset + needed);
    tokenOffset += needed;

    const startTime = Date.now();
    const newUsers = await connectPresenceUsers(
      tierTokens,
      stats,
      profile.rampPerSec,
    );
    allUsers.push(...newUsers);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    const active = allUsers.filter((u) => u.isConnected).length;
    console.log(
      `  ✅ Tier ${tierTarget}: ${active} active connections (ramp took ${elapsed}s)`,
    );

    // Take server metrics snapshot
    const serverMetrics = await fetchServerMetrics();
    if (serverMetrics) {
      console.log(
        `  📊 Server reports: ${serverMetrics.total} total (presence=${serverMetrics.presenceHub}, message=${serverMetrics.messageHub})`,
      );
    }

    // Record tier snapshot
    stats.takeTierSnapshot(`tier-${tierTarget}`);

    // Brief hold between tiers to let the system stabilize
    console.log(`  ⏸  Holding at ${tierTarget} for 30s...`);
    await sleep(30_000);
  }

  // ── Steady state hold ─────────────────────────────────────────────────────
  const active = allUsers.filter((u) => u.isConnected).length;
  console.log(
    `\n  🏔  Peak: ${active} connections. Holding for ${profile.holdSec}s...`,
  );

  const holdEnd = Date.now() + profile.holdSec * 1000;
  while (Date.now() < holdEnd) {
    await sleep(30_000);

    const currentActive = allUsers.filter((u) => u.isConnected).length;
    const serverMetrics = await fetchServerMetrics();
    const serverTotal = serverMetrics?.total ?? "?";

    console.log(
      `  📊 Hold check: ${currentActive} client-side | ${serverTotal} server-side`,
    );
    stats.takeTierSnapshot("hold");
  }

  // ── Ramp down ─────────────────────────────────────────────────────────────
  console.log("\n  📉 Ramping down...");
  await disconnectAll(allUsers);

  const finalMetrics = await fetchServerMetrics();
  if (finalMetrics) {
    console.log(`  📊 Server after drain: ${finalMetrics.total} connections`);
  }

  console.log("  ✅ Presence ramp complete");
});
