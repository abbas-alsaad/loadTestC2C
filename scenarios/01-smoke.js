#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════════
// Scenario 01 — Smoke Test
// ═══════════════════════════════════════════════════════════════════════════════
// Quick validation: 10 presence users + 2 chat pairs.
// Pass criteria: 100% connect, 100% message delivery, all latencies < 2s.
// Expected duration: ~30 seconds.
// ═══════════════════════════════════════════════════════════════════════════════

import { runScenario, sleep } from "../helpers/scenario-runner.js";
import { generateToken, generateTokenBatch } from "../helpers/jwt-helper.js";
import {
  PresenceUser,
  connectPresenceUsers,
  disconnectAll,
} from "../helpers/presence-user.js";
import {
  ChatPair,
  connectChatPairs,
  disconnectAllPairs,
} from "../helpers/chat-user.js";
import { loadSeedData } from "../helpers/seed-loader.js";

await runScenario("01-Smoke", async (stats, config) => {
  const profile = config.profiles.smoke;

  // ── Phase 1: Presence connections ─────────────────────────────────────────
  console.log("  📡 Phase 1: Connecting presence users...");
  const presenceTokens = generateTokenBatch(profile.totalUsers);
  const presenceUsers = await connectPresenceUsers(
    presenceTokens,
    stats,
    profile.rampPerSec,
  );

  const connected = presenceUsers.filter((u) => u.isConnected).length;
  console.log(
    `  ✅ ${connected}/${profile.totalUsers} presence users connected`,
  );

  // ── Phase 2: IsUserOnline check ───────────────────────────────────────────
  console.log("  🔍 Phase 2: Testing IsUserOnline...");
  if (presenceUsers[0]?.isConnected && presenceUsers[1]?.isConnected) {
    const result = await presenceUsers[0].isUserOnline(
      presenceTokens[1].username,
    );
    console.log(
      `  📋 IsUserOnline(${presenceTokens[1].username}): ${JSON.stringify(result)}`,
    );
  }

  // ── Phase 3: Hold with heartbeat ──────────────────────────────────────────
  console.log(
    `  💓 Phase 3: Holding for ${profile.durationSec}s with heartbeat...`,
  );
  await sleep(profile.durationSec * 1000);

  // ── Phase 4: Chat pairs ───────────────────────────────────────────────────
  console.log("  💬 Phase 4: Testing chat pairs...");
  const seedData = loadSeedData(profile.chatPairs);

  if (seedData.length > 0) {
    // Build chat pair configs with real usernames/userIds from seed
    const chatPairConfigsFinal = seedData.map((item, i) => {
      const sellerIdx = profile.totalUsers + i * 2;
      const buyerIdx = profile.totalUsers + i * 2 + 1;
      const sellerToken = generateToken(sellerIdx, {
        username: item.sellerUsername,
        userId: item.sellerUserId,
      });
      const buyerToken = generateToken(buyerIdx, {
        username: item.buyerUsername,
        userId: item.buyerUserId,
      });
      return {
        seller: { token: sellerToken.token, username: item.sellerUsername },
        buyer: { token: buyerToken.token, username: item.buyerUsername },
        itemId: item.itemId,
      };
    });

    const chatPairs = await connectChatPairs(chatPairConfigsFinal, stats, 5);
    const connectedPairs = chatPairs.filter((p) => p.isConnected).length;
    console.log(
      `  ✅ ${connectedPairs}/${profile.chatPairs} chat pairs connected`,
    );

    // Exchange messages
    for (const pair of chatPairs) {
      if (pair.isConnected) {
        pair.startMessaging(2000); // 1 msg every 2s for smoke
      }
    }

    console.log("  📨 Exchanging messages for 15s...");
    await sleep(15_000);

    // Cleanup chat pairs
    await disconnectAllPairs(chatPairs);
    console.log("  ✅ Chat pairs disconnected");
  } else {
    console.log("  ⚠️  No seed data — skipping chat test (run seed SQL first)");
  }

  // ── Phase 5: Disconnect ───────────────────────────────────────────────────
  console.log("  🔌 Phase 5: Disconnecting all...");
  await disconnectAll(presenceUsers);

  console.log("  ✅ Smoke test complete");
});
