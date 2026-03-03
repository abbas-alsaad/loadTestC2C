/**
 * JWT HS256 Token Generator for k6
 *
 * Mints QiServiceScheme-compatible JWTs client-side so each VU gets
 * a unique identity without hitting the real auth endpoint.
 *
 * Uses k6's built-in crypto module for HMAC-SHA256.
 */

import encoding from "k6/encoding";
import crypto from "k6/crypto";
import { JWT_CONFIG } from "../config.js";

// ─── Base64url helpers ────────────────────────────────────────
function base64urlEncode(data) {
  // data is a string; encode to base64 then convert to base64url
  return encoding
    .b64encode(data, "rawstd")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64urlEncodeBytes(bytes) {
  // bytes is an ArrayBuffer — encode to base64 then convert to url-safe
  return encoding
    .b64encode(bytes, "rawstd")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// ─── Token generation ─────────────────────────────────────────

/**
 * Generate a HS256 JWT token for a virtual user.
 *
 * @param {object} opts
 * @param {string} opts.userId   - Unique user ID (GUID-like or numeric)
 * @param {string} opts.username - Username claim
 * @param {number} [opts.expiresIn] - Seconds until expiry (default from config)
 * @returns {string} Signed JWT
 */
export function generateToken({ userId, username, expiresIn }) {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + (expiresIn || JWT_CONFIG.expiresInSeconds);

  const header = {
    alg: "HS256",
    typ: "JWT",
  };

  const payload = {
    // Standard claims
    iss: JWT_CONFIG.issuer,
    aud: JWT_CONFIG.audience,
    iat: now,
    nbf: now,
    exp: exp,

    // App-specific claims (matches C2C token structure)
    username: username,
    UserId: userId,
    nameid: userId,
    sub: userId,
  };

  const headerEncoded = base64urlEncode(JSON.stringify(header));
  const payloadEncoded = base64urlEncode(JSON.stringify(payload));

  const signingInput = `${headerEncoded}.${payloadEncoded}`;

  // HMAC-SHA256 using the shared secret key
  const signatureBytes = crypto.hmac(
    "sha256",
    JWT_CONFIG.secret,
    signingInput,
    "binary",
  );
  const signatureEncoded = base64urlEncodeBytes(signatureBytes);

  return `${signingInput}.${signatureEncoded}`;
}

/**
 * Generate a unique user identity for a VU.
 *
 * @param {number} vuId     - k6 VU id (__VU)
 * @param {number} iteration - k6 iteration (__ITER)
 * @returns {{ userId: string, username: string, token: string }}
 */
export function generateVuIdentity(vuId, iteration) {
  // Create a deterministic but unique userId per VU+iteration
  const userId = `10000000-0000-0000-0000-${String(vuId * 10000 + iteration).padStart(12, "0")}`;
  const username = `loadtest-user-${vuId}-${iteration}`;

  const token = generateToken({ userId, username });

  return { userId, username, token };
}
