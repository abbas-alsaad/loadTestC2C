#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════════
// Scenario 07 — Breakpoint (Find the Ceiling)
// ═══════════════════════════════════════════════════════════════════════════════
// Starts at 1000 connections, increases by 500 every 2 minutes.
// Stops when: connection failure rate > 5% OR p99 > 5s OR error threshold.
// Outputs: exact connection count where system degrades.
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
import { createStats } from "../helpers/stats.js";

await runScenario("07-Breakpoint", async (stats, config) => {
  const profile = config.profiles.breakpoint;
  const allUsers = [];
  let currentTarget = profile.startUsers;
  let tokenIdx = 0;
  let breakpointFound = false;
  let maxStableConnections = 0;

  console.log(
    `  🎯 Starting breakpoint test: ${profile.startUsers} initial, +${profile.stepSize} per step`,
  );
  console.log(
    `  🛑 Stop criteria: failure rate > ${profile.maxFailureRate * 100}% OR p99 > ${profile.maxP99Ms}ms\n`,
  );

  // Pre-generate a large token pool (generous upper bound)
  const maxPossible = 20_000;
  console.log(`  🔑 Pre-generating token pool (up to ${maxPossible})...`);
  const tokenPool = generateTokenBatch(maxPossible);
  console.log("  ✅ Token pool ready\n");

  while (!breakpointFound) {
    const needed = currentTarget - allUsers.filter((u) => u.isConnected).length;
    if (needed <= 0 || tokenIdx + needed > maxPossible) {
      console.log(`  🛑 Token pool exhausted at ${currentTarget}`);
      break;
    }

    console.log(
      `  ─────────────────────────────────────────────────────────────`,
    );
    console.log(`  📈 TIER ${currentTarget}: Adding ${needed} connections...`);

    // Reset tier-specific failure tracking
    const tierStartErrors = stats.counters.connectionsFailed;
    const tierStartConnections = stats.counters.connectionsOpened;

    const tierTokens = tokenPool.slice(tokenIdx, tokenIdx + needed);
    tokenIdx += needed;

    const rampStart = Date.now();
    const newUsers = await connectPresenceUsers(tierTokens, stats, 100); // Fast ramp
    allUsers.push(...newUsers);
    const rampSec = ((Date.now() - rampStart) / 1000).toFixed(1);

    const active = allUsers.filter((u) => u.isConnected).length;
    const tierNewConnections =
      stats.counters.connectionsOpened - tierStartConnections;
    const tierNewFailures = stats.counters.connectionsFailed - tierStartErrors;
    const tierFailureRate =
      tierNewConnections > 0
        ? tierNewFailures / (tierNewConnections + tierNewFailures)
        : 0;

    console.log(
      `  ✅ Active: ${active} | Ramp: ${rampSec}s | Tier failures: ${tierNewFailures}/${tierNewConnections + tierNewFailures} (${(tierFailureRate * 100).toFixed(1)}%)`,
    );

    // ── Check degradation during ramp ─────────────────────────────────────
    if (tierFailureRate > profile.maxFailureRate) {
      console.log(
        `  🛑 BREAKPOINT: Failure rate ${(tierFailureRate * 100).toFixed(1)}% exceeded ${profile.maxFailureRate * 100}% during ramp at ${currentTarget}`,
      );
      breakpointFound = true;
      break;
    }

    // ── Hold and observe ────────────────────────────────────────────────────
    console.log(
      `  ⏸  Holding at ${currentTarget} for ${profile.stepDurationSec}s...`,
    );

    const holdEnd = Date.now() + profile.stepDurationSec * 1000;
    let holdCheck = 0;

    while (Date.now() < holdEnd) {
      await sleep(30_000);
      holdCheck++;

      const currentActive = allUsers.filter((u) => u.isConnected).length;
      const snap = stats.snapshot();
      const connP99 = snap.latencies.connectionTime?.p99 ?? 0;
      const serverMetrics = await fetchServerMetrics();

      console.log(
        `  📊 Hold ${holdCheck}: active=${currentActive} | connP99=${connP99}ms | disconnects=${stats.counters.unexpectedDisconnects} | server=${serverMetrics?.total ?? "?"}`,
      );

      // Check p99 degradation
      if (connP99 > profile.maxP99Ms) {
        console.log(
          `  🛑 BREAKPOINT: Connection p99 ${connP99}ms exceeded ${profile.maxP99Ms}ms at ${currentTarget}`,
        );
        breakpointFound = true;
        break;
      }

      // Check if active connections are dropping (server rejecting/killing)
      const expectedActive = currentTarget;
      const dropRate = 1 - currentActive / expectedActive;
      if (dropRate > profile.maxFailureRate) {
        console.log(
          `  🛑 BREAKPOINT: Active connections dropped to ${currentActive} (${(dropRate * 100).toFixed(1)}% drop) at ${currentTarget}`,
        );
        breakpointFound = true;
        break;
      }
    }

    if (!breakpointFound) {
      maxStableConnections = active;
      stats.takeTierSnapshot(`stable-${currentTarget}`);
      console.log(
        `  ✅ Tier ${currentTarget} STABLE. Max stable: ${maxStableConnections}\n`,
      );
      currentTarget += profile.stepSize;
    }
  }

  // ── Final snapshot ────────────────────────────────────────────────────────
  stats.takeTierSnapshot("breakpoint-final");

  console.log(`\n  ${"═".repeat(50)}`);
  console.log(`  🏆 BREAKPOINT RESULT`);
  console.log(`  ${"═".repeat(50)}`);
  console.log(`  Max Stable Connections: ${maxStableConnections}`);
  console.log(`  Broke at:              ${currentTarget}`);
  console.log(
    `  Total Attempted:       ${stats.counters.connectionsOpened + stats.counters.connectionsFailed}`,
  );
  console.log(`  Total Errors:          ${stats.counters.errors}`);
  console.log(`  ${"═".repeat(50)}`);

  // ── Disconnect all ────────────────────────────────────────────────────────
  console.log("\n  🔌 Disconnecting all...");
  await disconnectAll(allUsers);

  console.log("  ✅ Breakpoint test complete");
});
