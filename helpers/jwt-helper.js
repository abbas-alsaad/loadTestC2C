// ═══════════════════════════════════════════════════════════════════════════════
// JWT Helper — Generate valid QiServiceScheme tokens for load testing
// ═══════════════════════════════════════════════════════════════════════════════
// Signs JWTs locally using the same symmetric key as the .NET backend.
// Claim contract (from MiniAppTokenGenrator.cs + ClaimsPrincipalExtensions.cs):
//   - "superQiCustomerId" → national ID (same as username for QI customers)
//   - "userId"            → AppUserId (GUID)
//   - "username"          → login username, extracted by GetUsername()
//   - "nameid"            → AppUserId (GUID), NameId registered claim
//   - "profileId"         → Seller/Profile ID (optional)
//   - "iss"               → "qi-services"
//   - "aud"               → "F0E62818-F5CE-4844-B01D-5F1A9F105967"
// Algorithm: HS512 (HmacSha512Signature) matching MiniAppTokenGenrator.cs
// ═══════════════════════════════════════════════════════════════════════════════

import jwt from "jsonwebtoken";
import config from "../config.js";

/**
 * Generate a valid JWT for a virtual load-test user.
 * Matches the claim structure of MiniAppTokenGenrator.cs.
 *
 * @param {number} userIndex — Unique index (0-based) for this virtual user
 * @param {object} [overrides] — Optional claim overrides
 * @param {string} [overrides.username]   — Real username (e.g. national ID)
 * @param {string} [overrides.userId]     — Real AppUserId (GUID string)
 * @param {string} [overrides.profileId]  — Seller/Profile ID (GUID string)
 * @returns {{ token: string, username: string, userId: string }}
 */
export function generateToken(userIndex, overrides = {}) {
  const username =
    overrides.username || `${config.jwt.USERNAME_PREFIX}${userIndex}`;
  const userId =
    overrides.userId ||
    `00000000-0000-0000-0000-${String(10_000 + userIndex).padStart(12, "0")}`;

  const payload = {
    superQiCustomerId: overrides.superQiCustomerId || username,
    userId: String(userId),
    username,
    nameid: String(userId),
    // .NET ClaimTypes.NameIdentifier maps to both "nameid" and full URI
    "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier":
      String(userId),
    iss: config.jwt.ISSUER,
    aud: config.jwt.AUDIENCE,
    iat: Math.floor(Date.now() / 1000),
    ...overrides.extraClaims,
  };

  // Add profileId only if provided (optional claim)
  if (overrides.profileId) {
    payload.profileId = overrides.profileId;
  }

  const token = jwt.sign(payload, config.jwt.TOKEN_KEY, {
    algorithm: config.jwt.ALGORITHM,
    expiresIn: config.jwt.EXPIRY,
    noTimestamp: false,
  });

  return { token, username, userId };
}

/**
 * Generate tokens for N users in bulk.
 *
 * @param {number} count — Number of users
 * @param {number} [startIndex=0] — Starting index
 * @returns {Array<{ token: string, username: string, userId: number }>}
 */
export function generateTokenBatch(count, startIndex = 0) {
  const users = [];
  for (let i = 0; i < count; i++) {
    users.push(generateToken(startIndex + i));
  }
  return users;
}

/**
 * Decode a token without verification (for debugging).
 */
export function decodeToken(token) {
  return jwt.decode(token, { complete: true });
}
