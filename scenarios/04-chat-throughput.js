#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════════
// Scenario 04 — Chat Throughput
// ═══════════════════════════════════════════════════════════════════════════════
// Ramps up chat pairs: 50 → 200 → 500 (total 1000 MessageHub + 1000 PresenceHub).
// Each pair exchanges messages every 5s = up to 100 msg/s at peak.
// Measures: message delivery latency, read receipts, notifications.
// Requires: seed data (test items seeded into DB).
// ═══════════════════════════════════════════════════════════════════════════════

import {
  runScenario,
  sleep,
  fetchServerMetrics,
} from "../helpers/scenario-runner.js";
import { generateToken } from "../helpers/jwt-helper.js";
import { connectChatPairs, disconnectAllPairs } from "../helpers/chat-user.js";
import { loadSeedData } from "../helpers/seed-loader.js";

await runScenario("04-Chat-Throughput", async (stats, config) => {
  const profile = config.profiles.chat;

  // ── Load seed data ────────────────────────────────────────────────────────
  const seedData = loadSeedData(profile.chatPairs);
  if (seedData.length === 0) {
    console.error(
      "  ❌ No seed data available. Chat throughput test requires seeded items.",
    );
    console.error("     Run: psql -f load-tests/seed/seed-load-test.sql");
    return;
  }

  console.log(
    `  📦 Loaded ${seedData.length} test items for ${Math.min(seedData.length, profile.chatPairs)} chat pairs\n`,
  );

  const allPairs = [];
  let tokenIdx = 0;

  // ── Ramp through tiers ────────────────────────────────────────────────────
  for (const tierTarget of profile.tiers) {
    const currentPairs = allPairs.filter((p) => p.isConnected).length;
    const needed = tierTarget - currentPairs;
    if (needed <= 0) continue;

    const available = seedData.length - allPairs.length;
    const toCreate = Math.min(needed, available);

    if (toCreate <= 0) {
      console.log(
        `  ⚠️  Only ${seedData.length} seed items available — cannot reach ${tierTarget} pairs`,
      );
      break;
    }

    console.log(
      `  📈 Ramping to ${tierTarget} chat pairs (adding ${toCreate})...`,
    );

    // Build pair configs from seed data
    const pairConfigs = [];
    for (let i = 0; i < toCreate; i++) {
      const idx = allPairs.length + i;
      if (idx >= seedData.length) break;

      const item = seedData[idx];
      const sellerToken = generateToken(tokenIdx++, {
        username: item.sellerUsername,
        userId: item.sellerUserId,
      });
      const buyerToken = generateToken(tokenIdx++, {
        username: item.buyerUsername,
        userId: item.buyerUserId,
      });

      pairConfigs.push({
        seller: { token: sellerToken.token, username: item.sellerUsername },
        buyer: { token: buyerToken.token, username: item.buyerUsername },
        itemId: item.itemId,
      });
    }

    const newPairs = await connectChatPairs(
      pairConfigs,
      stats,
      profile.rampPerSec,
    );
    allPairs.push(...newPairs);

    // Start messaging for new pairs
    for (const pair of newPairs) {
      if (pair.isConnected) {
        pair.startMessaging(profile.messageIntervalMs);
        pair.startTyping(profile.typingIntervalMs);
      }
    }

    const activePairs = allPairs.filter((p) => p.isConnected).length;
    console.log(
      `  ✅ Tier ${tierTarget}: ${activePairs} active chat pairs (${activePairs * 4} total connections)`,
    );

    const serverMetrics = await fetchServerMetrics();
    if (serverMetrics) {
      console.log(
        `  📊 Server: total=${serverMetrics.total} (presence=${serverMetrics.presenceHub}, message=${serverMetrics.messageHub})`,
      );
    }

    stats.takeTierSnapshot(`chat-tier-${tierTarget}`);

    // Brief stabilization between tiers
    await sleep(15_000);
  }

  // ── Steady state hold ─────────────────────────────────────────────────────
  const activePairs = allPairs.filter((p) => p.isConnected).length;
  console.log(
    `\n  🏔  Peak: ${activePairs} chat pairs. Holding for ${profile.holdSec}s...`,
  );

  const holdEnd = Date.now() + profile.holdSec * 1000;
  while (Date.now() < holdEnd) {
    await sleep(30_000);

    const current = allPairs.filter((p) => p.isConnected).length;
    const serverMetrics = await fetchServerMetrics();
    const throughput = stats.getMessageThroughput();

    console.log(
      `  📊 Hold: ${current} pairs | ${Math.round(throughput)} msg/s | sent=${stats.counters.messagesSent} recv=${stats.counters.messagesReceived}`,
    );
  }

  // ── Disconnect ────────────────────────────────────────────────────────────
  console.log("\n  🔌 Disconnecting all chat pairs...");
  await disconnectAllPairs(allPairs);

  console.log("  ✅ Chat throughput test complete");
  console.log(
    `  📋 Messages: ${stats.counters.messagesSent} sent / ${stats.counters.messagesReceived} received / ${stats.counters.messagesLost} lost`,
  );
});
