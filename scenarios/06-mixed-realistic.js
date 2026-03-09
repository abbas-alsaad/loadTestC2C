#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════════
// Scenario 06 — Mixed Realistic Production Simulation
// ═══════════════════════════════════════════════════════════════════════════════
// 5000 total connections mimicking real production traffic:
//   - 80% PresenceHub only (users browsing the app)
//   - 20% also connected to MessageHub (users actively chatting)
// Activity: 70% idle+heartbeat, 20% IsUserOnline probes, 10% chat messages
// Random connect/disconnect simulating real user sessions.
// ═══════════════════════════════════════════════════════════════════════════════

import {
  runScenario,
  sleep,
  fetchServerMetrics,
} from "../helpers/scenario-runner.js";
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

await runScenario("06-Mixed-Realistic", async (stats, config) => {
  const profile = config.profiles.mixed;

  const presenceOnlyCount = Math.floor(
    (profile.totalUsers * profile.presenceOnlyPercent) / 100,
  );
  const chatPairCount = Math.floor(
    (profile.totalUsers - presenceOnlyCount) / 4,
  ); // 4 connections per pair

  console.log(
    `  📐 Plan: ${presenceOnlyCount} presence-only + ${chatPairCount} chat pairs (${chatPairCount * 4} conns)\n`,
  );

  // ── Phase 1: Presence users ───────────────────────────────────────────────
  console.log(`  📡 Connecting ${presenceOnlyCount} presence-only users...`);
  const presenceTokens = generateTokenBatch(presenceOnlyCount);
  const presenceUsers = await connectPresenceUsers(
    presenceTokens,
    stats,
    profile.rampPerSec,
  );

  const presenceActive = presenceUsers.filter((u) => u.isConnected).length;
  console.log(`  ✅ ${presenceActive} presence users connected`);

  // ── Phase 2: Chat pairs ───────────────────────────────────────────────────
  const seedData = loadSeedData(chatPairCount);
  let chatPairs = [];

  if (seedData.length > 0) {
    console.log(
      `  💬 Connecting ${Math.min(seedData.length, chatPairCount)} chat pairs...`,
    );

    let tokenIdx = presenceOnlyCount;
    const pairConfigs = seedData.slice(0, chatPairCount).map((item) => {
      const seller = generateToken(tokenIdx++, {
        username: item.sellerUsername,
        userId: item.sellerUserId,
      });
      const buyer = generateToken(tokenIdx++, {
        username: item.buyerUsername,
        userId: item.buyerUserId,
      });
      return {
        seller: { token: seller.token, username: item.sellerUsername },
        buyer: { token: buyer.token, username: item.buyerUsername },
        itemId: item.itemId,
      };
    });

    chatPairs = await connectChatPairs(pairConfigs, stats, 10);

    for (const pair of chatPairs) {
      if (pair.isConnected) {
        pair.startMessaging(config.profiles.chat.messageIntervalMs);
        pair.startTyping(config.profiles.chat.typingIntervalMs);
      }
    }

    const chatActive = chatPairs.filter((p) => p.isConnected).length;
    console.log(`  ✅ ${chatActive} chat pairs active`);
  } else {
    console.log("  ⚠️  No seed data — running presence-only simulation");
  }

  // ── Phase 3: Mixed activity simulation ────────────────────────────────────
  const totalActive =
    presenceUsers.filter((u) => u.isConnected).length +
    chatPairs.filter((p) => p.isConnected).length * 4;
  console.log(
    `\n  🏔  Total active: ~${totalActive} connections. Simulating for ${profile.durationSec}s...\n`,
  );

  const durationMs = profile.durationSec * 1000;
  const startTime = Date.now();
  let minute = 0;

  while (Date.now() - startTime < durationMs) {
    await sleep(60_000);
    minute++;

    const connectedPresence = presenceUsers.filter((u) => u.isConnected);

    // ── 20% do IsUserOnline probes ────────────────────────────────────────
    const probeCount = Math.ceil(connectedPresence.length * 0.2);
    const probePromises = [];
    for (let i = 0; i < probeCount && i < connectedPresence.length; i++) {
      const targetIdx = Math.floor(Math.random() * presenceTokens.length);
      probePromises.push(
        connectedPresence[i].isUserOnline(presenceTokens[targetIdx].username),
      );
    }
    await Promise.allSettled(probePromises);

    // ── Random churn: 5% disconnect, 5% reconnect ────────────────────────
    const churnCount = Math.ceil(connectedPresence.length * 0.05);

    // Disconnect random users
    for (let i = 0; i < churnCount && i < connectedPresence.length; i++) {
      const idx = Math.floor(Math.random() * connectedPresence.length);
      await connectedPresence[idx].stop();
    }

    // Reconnect same number
    const disconnectedUsers = presenceUsers.filter((u) => !u.isConnected);
    for (let i = 0; i < churnCount && i < disconnectedUsers.length; i++) {
      // Create new user with same token
      const idx = presenceUsers.indexOf(disconnectedUsers[i]);
      if (idx >= 0 && idx < presenceTokens.length) {
        const newUser = new PresenceUser(
          presenceTokens[idx].token,
          presenceTokens[idx].username,
          stats,
        );
        await newUser.start();
        presenceUsers[idx] = newUser;
      }
    }

    // Status
    const currentPresence = presenceUsers.filter((u) => u.isConnected).length;
    const currentChat = chatPairs.filter((p) => p.isConnected).length;
    const serverMetrics = await fetchServerMetrics();
    const throughput = stats.getMessageThroughput();

    console.log(
      `  📊 Min ${minute}: presence=${currentPresence} chat=${currentChat} | ${Math.round(throughput)} msg/s | server=${serverMetrics?.total ?? "?"}`,
    );

    if (minute % 5 === 0) {
      stats.takeTierSnapshot(`mixed-min-${minute}`);
    }
  }

  // ── Disconnect all ────────────────────────────────────────────────────────
  console.log("\n  🔌 Disconnecting all...");
  await Promise.all([
    disconnectAll(presenceUsers),
    disconnectAllPairs(chatPairs),
  ]);

  console.log("  ✅ Mixed realistic test complete");
});
