/**
 * Test Data Pool Helper
 *
 * Generates deterministic user identities matching the SQL seed script.
 * Uses MD5 hashing to create UUIDs identical to PostgreSQL's md5()::uuid.
 *
 * The SQL seed script creates users/items with:
 *   md5('loadtest-seller-{N}')::uuid
 *   md5('loadtest-buyer-{N}')::uuid
 *   md5('loadtest-item-{N}')::uuid
 *
 * This module generates the EXACT same UUIDs in k6 JavaScript,
 * so no JSON data file or DB queries are needed at runtime.
 *
 * Usage:
 *   import { getTestPair } from '../helpers/test-data.js';
 *
 *   export default function () {
 *     const pair = getTestPair(__VU);
 *     // pair.seller.userId, pair.seller.username
 *     // pair.buyer.userId, pair.buyer.username
 *     // pair.itemId
 *   }
 */

import crypto from "k6/crypto";

const DEFAULT_PAIR_COUNT = 1000;

/**
 * Generate a deterministic UUID from a seed string.
 * Matches PostgreSQL's md5(seed)::uuid exactly.
 *
 * @param {string} seed - Input string
 * @returns {string} UUID string (e.g. "5d41402a-bc4b-2a76-b971-9d911017c592")
 */
export function genTestUuid(seed) {
  const h = crypto.md5(seed, "hex");
  return (
    h.slice(0, 8) +
    "-" +
    h.slice(8, 12) +
    "-" +
    h.slice(12, 16) +
    "-" +
    h.slice(16, 20) +
    "-" +
    h.slice(20, 32)
  );
}

/**
 * Get a test data pair for a given VU.
 *
 * Each VU gets a unique seller/buyer/item combination (up to pairCount).
 * VUs beyond pairCount wrap around (VU 1001 → pair 1).
 *
 * @param {number} vuId      - k6 __VU (1-based)
 * @param {number} [pairCount] - Total pairs available (default: 1000)
 * @returns {{
 *   seller:    { userId: string, username: string },
 *   buyer:     { userId: string, username: string },
 *   itemId:    string,
 *   pairIndex: number
 * }}
 */
export function getTestPair(vuId, pairCount) {
  const count =
    pairCount || parseInt(__ENV.PAIR_COUNT || String(DEFAULT_PAIR_COUNT));
  const i = ((vuId - 1) % count) + 1; // 1-based, wraps around

  return {
    seller: {
      userId: genTestUuid("loadtest-seller-" + i),
      username: "loadtest-seller-" + i,
    },
    buyer: {
      userId: genTestUuid("loadtest-buyer-" + i),
      username: "loadtest-buyer-" + i,
    },
    itemId: genTestUuid("loadtest-item-" + i),
    pairIndex: i,
  };
}
