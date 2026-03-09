// ═══════════════════════════════════════════════════════════════════════════════
// API Client — HTTP REST API calls for load testing
// ═══════════════════════════════════════════════════════════════════════════════
// Simulates real user HTTP browsing: fetching items, categories, etc.
// Uses native fetch() (Node.js ≥ 18).
// ═══════════════════════════════════════════════════════════════════════════════

import config from "../config.js";

/**
 * Base URL for REST API (separate domain from WebSocket hubs).
 */
function getApiBaseUrl() {
  return config.API_BASE_URL;
}

/**
 * Make an authenticated GET request.
 *
 * @param {string} path — API path (e.g. "/api/pos/Item")
 * @param {string} token — JWT token
 * @param {Record<string, string>} [queryParams] — Query parameters
 * @param {number} [timeoutMs=10000] — Request timeout
 * @returns {Promise<{ status: number, data: any, latencyMs: number }>}
 */
async function apiGet(path, token, queryParams = {}, timeoutMs = 10_000) {
  const url = new URL(path, getApiBaseUrl());
  for (const [key, value] of Object.entries(queryParams)) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }

  const startMs = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
      signal: controller.signal,
    });

    const latencyMs = Date.now() - startMs;
    let data = null;

    try {
      data = await response.json();
    } catch {
      // Non-JSON response
    }

    return { status: response.status, data, latencyMs };
  } finally {
    clearTimeout(timer);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// POS Item Endpoints
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/pos/Item — Get all items (paginated).
 *
 * @param {string} token
 * @param {object} [params]
 * @param {number} [params.page=1]
 * @param {number} [params.pageSize=20]
 * @param {string} [params.sortBy]
 * @param {string} [params.sortOrder]
 * @param {string} [params.search]
 * @returns {Promise<{ status: number, data: any, latencyMs: number }>}
 */
export async function getAllItems(token, params = {}) {
  return apiGet("/api/pos/Item", token, {
    Page: params.page ?? 1,
    PageSize: params.pageSize ?? 20,
    SortBy: params.sortBy,
    SortOrder: params.sortOrder,
    Search: params.search,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// POS Category Endpoints
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/pos/Category/GetCategories — Get all categories.
 *
 * @param {string} token
 * @returns {Promise<{ status: number, data: any, latencyMs: number }>}
 */
export async function getCategories(token) {
  return apiGet("/api/pos/Category/GetCategories", token);
}

/**
 * GET /api/pos/Category/GetParentCategories — Get parent (root) categories
 * or children of a specific parent.
 *
 * @param {string} token
 * @param {number} [parentCategoryId] — Optional parent ID to get children
 * @returns {Promise<{ status: number, data: any, latencyMs: number }>}
 */
export async function getParentCategories(token, parentCategoryId) {
  return apiGet("/api/pos/Category/GetParentCategories", token, {
    parentCategoryId,
  });
}
