-- ═══════════════════════════════════════════════════════════════════════════════
-- C2C SignalR Load Test — Database Seed Script
-- ═══════════════════════════════════════════════════════════════════════════════
-- Creates ADDITIONAL test users and items for large-scale chat scenarios.
-- ChatAuthorizationService requires: one user is the item seller, the other is NOT.
--
-- NOTE: For small-scale tests (smoke, ≤22 chat pairs), use the 22 real items
-- already in seed/test-items.json — no seeding needed.
-- This script is for SCALING to 500+ chat pairs in scenarios 04/06.
--
-- Table schema reference (AppUserEntity : IdentityUser<Guid>):
--   "Id" (UUID), "FullName", "IsFirstLogin", "ModifiedAt", "TenantId",
--   "SuperQiCustomerId", "UserType", "UserName", "NormalizedUserName",
--   "Email", "NormalizedEmail", "EmailConfirmed", "PasswordHash",
--   "SecurityStamp", "ConcurrencyStamp", "PhoneNumber",
--   "PhoneNumberConfirmed", "TwoFactorEnabled", "LockoutEnd",
--   "LockoutEnabled", "AccessFailedCount"
--
-- Usage:
--   psql -h <host> -U <user> -d <db> -f seed-load-test.sql
--
-- IMPORTANT: Run this ONLY against UAT/test environments, NEVER production.
-- ═══════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── Configuration ─────────────────────────────────────────────────────────────
DO $$
DECLARE
  pair_count INT := 1000;
  seller_user_id UUID;
  buyer_user_id UUID;
  profile_id UUID;
  item_id UUID;
  category_id INT;
  i INT;
  seller_username TEXT;
  buyer_username TEXT;
BEGIN

  -- Get a valid category ID (any active leaf category)
  SELECT "Id" INTO category_id
  FROM "Category"
  WHERE "IsDeleted" = false
    AND "IsLeaf" = true
  LIMIT 1;

  IF category_id IS NULL THEN
    RAISE EXCEPTION 'No active categories found. Seed categories first.';
  END IF;

  FOR i IN 0..pair_count-1 LOOP
    seller_user_id := gen_random_uuid();
    buyer_user_id := gen_random_uuid();
    seller_username := 'loadtest_seller_' || i;
    buyer_username := 'loadtest_buyer_' || i;

    -- ── Create seller user ──────────────────────────────────────────────────
    INSERT INTO "AspNetUsers" (
      "Id", "FullName", "IsFirstLogin", "ModifiedAt", "TenantId",
      "SuperQiCustomerId", "UserType",
      "UserName", "NormalizedUserName",
      "Email", "NormalizedEmail", "EmailConfirmed",
      "PasswordHash", "SecurityStamp", "ConcurrencyStamp",
      "PhoneNumber", "PhoneNumberConfirmed", "TwoFactorEnabled",
      "LockoutEnd", "LockoutEnabled", "AccessFailedCount"
    )
    VALUES (
      seller_user_id,
      'Load Test Seller ' || i,     -- FullName
      false,                         -- IsFirstLogin
      NULL,                          -- ModifiedAt
      NULL,                          -- TenantId
      seller_username,               -- SuperQiCustomerId (same as UserName for QI users)
      2,                             -- UserType = 2 (Customer)
      seller_username,               -- UserName (login identifier)
      UPPER(seller_username),        -- NormalizedUserName
      seller_username || '@test.local',
      UPPER(seller_username || '@test.local'),
      false,
      'LOAD_TEST_HASH_NOT_REAL',     -- PasswordHash placeholder
      gen_random_uuid()::TEXT,
      gen_random_uuid()::TEXT,
      NULL,                          -- PhoneNumber
      false,
      false,
      NULL,
      false,
      0
    )
    ON CONFLICT ("NormalizedUserName") DO NOTHING;

    -- Get seller_user_id in case of conflict
    SELECT "Id" INTO seller_user_id FROM "AspNetUsers"
    WHERE "UserName" = seller_username;

    -- ── Create buyer user ───────────────────────────────────────────────────
    INSERT INTO "AspNetUsers" (
      "Id", "FullName", "IsFirstLogin", "ModifiedAt", "TenantId",
      "SuperQiCustomerId", "UserType",
      "UserName", "NormalizedUserName",
      "Email", "NormalizedEmail", "EmailConfirmed",
      "PasswordHash", "SecurityStamp", "ConcurrencyStamp",
      "PhoneNumber", "PhoneNumberConfirmed", "TwoFactorEnabled",
      "LockoutEnd", "LockoutEnabled", "AccessFailedCount"
    )
    VALUES (
      buyer_user_id,
      'Load Test Buyer ' || i,
      false,
      NULL,
      NULL,
      buyer_username,
      2,
      buyer_username,
      UPPER(buyer_username),
      buyer_username || '@test.local',
      UPPER(buyer_username || '@test.local'),
      false,
      'LOAD_TEST_HASH_NOT_REAL',
      gen_random_uuid()::TEXT,
      gen_random_uuid()::TEXT,
      NULL,
      false,
      false,
      NULL,
      false,
      0
    )
    ON CONFLICT ("NormalizedUserName") DO NOTHING;

    -- ── Create seller profile (table is "Profile", not "Sellers") ───────────
    profile_id := gen_random_uuid();

    INSERT INTO "Profile" ("Id", "AppUserId", "IsDeleted", "CustomerAccountNumber", "LogoPath", "CreatedAt", "Status")
    VALUES (
      profile_id,
      seller_user_id,
      false,
      'LOADTEST_' || i,
      '',
      NOW(),
      1
    )
    ON CONFLICT DO NOTHING;

    -- Get profile_id in case of conflict
    IF NOT FOUND THEN
      SELECT "Id" INTO profile_id FROM "Profile"
      WHERE "AppUserId" = seller_user_id
      LIMIT 1;
    END IF;

    -- ── Create test item ────────────────────────────────────────────────────
    item_id := gen_random_uuid();

    INSERT INTO "Items" (
      "Id", "Title", "Description", "Price", "SellerId",
      "LastCategoryId", "Status", "IsDeleted", "CreatedAt", "UpdatedAt",
      "ItemStatus", "SearchText", "ContactPhoneNumber", "WhatsappPhoneNumber",
      "SellType", "LifecycleStatus", "Gov"
    )
    VALUES (
      item_id,
      'Load Test Item ' || i,
      'Item created for load testing — pair ' || i,
      10000 + (i * 100),
      profile_id,
      category_id,
      1,
      false,
      NOW(),
      NOW(),
      0,                             -- ItemStatus (e.g. 0 = New)
      'load test item ' || i,        -- SearchText
      '',                            -- ContactPhoneNumber
      '',                            -- WhatsappPhoneNumber
      0,                             -- SellType = MarketplaceListing
      1,                             -- LifecycleStatus = Published
      0                              -- Gov
    )
    ON CONFLICT DO NOTHING;

    -- Progress logging every 100 pairs
    IF i % 100 = 0 THEN
      RAISE NOTICE 'Created pair %/%', i, pair_count;
    END IF;

  END LOOP;

  RAISE NOTICE 'Successfully created % test pairs', pair_count;
END $$;

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════════
-- After seeding, export items to test-items.json:
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- SELECT json_agg(row_to_json(t)) FROM (
--   SELECT
--     i."Id" AS "itemId",
--     seller_user."UserName" AS "sellerUsername",
--     seller_user."Id"::TEXT AS "sellerUserId",
--     buyer_user."UserName" AS "buyerUsername",
--     buyer_user."Id"::TEXT AS "buyerUserId",
--     i."Title" AS "name"
--   FROM "Items" i
--   JOIN "Profile" p ON i."SellerId" = p."Id"
--   JOIN "AspNetUsers" seller_user ON p."AppUserId" = seller_user."Id"
--   JOIN "AspNetUsers" buyer_user
--     ON buyer_user."UserName" = REPLACE(seller_user."UserName", 'seller', 'buyer')
--   WHERE i."Title" LIKE 'Load Test Item%'
--   ORDER BY i."CreatedAt"
-- ) t;
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- Verification:
-- ═══════════════════════════════════════════════════════════════════════════════
-- SELECT COUNT(*) AS test_items FROM "Items" WHERE "Title" LIKE 'Load Test Item%';
-- SELECT COUNT(*) AS test_users FROM "AspNetUsers" WHERE "UserName" LIKE 'loadtest_%';
-- SELECT COUNT(*) AS test_profiles FROM "Profile" p
--   JOIN "AspNetUsers" u ON p."AppUserId" = u."Id"
--   WHERE u."UserName" LIKE 'loadtest_seller_%';
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- Cleanup:
-- ═══════════════════════════════════════════════════════════════════════════════
-- DELETE FROM "Items" WHERE "Title" LIKE 'Load Test Item%';
-- DELETE FROM "Profile" WHERE "AppUserId" IN (
--   SELECT "Id" FROM "AspNetUsers" WHERE "UserName" LIKE 'loadtest_%'
-- );
-- DELETE FROM "AspNetUsers" WHERE "UserName" LIKE 'loadtest_%';
