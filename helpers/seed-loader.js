// ═══════════════════════════════════════════════════════════════════════════════
// Seed Loader — Load test item seed data for chat scenarios
// ═══════════════════════════════════════════════════════════════════════════════

import { readFileSync, existsSync } from "node:fs";
import config from "../config.js";

let _cachedSeedData = null;

/**
 * Load seed data from JSON file.
 * Returns array of { itemId, sellerUsername, buyerUsername }.
 *
 * @param {number} [maxPairs] — Limit the number of pairs returned
 * @returns {Array<{ itemId: string, sellerUsername: string, buyerUsername: string }>}
 */
export function loadSeedData(maxPairs = Infinity) {
  if (_cachedSeedData !== null) {
    return _cachedSeedData.slice(0, maxPairs);
  }

  const seedPath = config.SEED_FILE;

  if (!existsSync(seedPath)) {
    console.warn(`  ⚠️  Seed file not found: ${seedPath}`);
    console.warn(
      "     Chat scenarios require seeded test data. See seed/README.md",
    );
    _cachedSeedData = [];
    return [];
  }

  try {
    const raw = readFileSync(seedPath, "utf-8");
    const data = JSON.parse(raw);

    if (!Array.isArray(data)) {
      throw new Error("Seed file must contain a JSON array");
    }

    // Validate shape
    for (const item of data) {
      if (!item.itemId || !item.sellerUsername || !item.buyerUsername) {
        throw new Error(
          "Each seed item must have: itemId, sellerUsername, buyerUsername",
        );
      }
    }

    _cachedSeedData = data;
    console.log(`  📦 Loaded ${data.length} test item(s) from seed file`);
    return data.slice(0, maxPairs);
  } catch (error) {
    console.warn(`  ⚠️  Failed to load seed data: ${error.message}`);
    _cachedSeedData = [];
    return [];
  }
}
