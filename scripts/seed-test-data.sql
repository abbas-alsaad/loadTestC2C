-- ═══════════════════════════════════════════════════════════════
-- Load Test Data Seed Script
-- ═══════════════════════════════════════════════════════════════
--
-- Creates 1000 seller/buyer pairs with items for k6 load testing.
--
-- UUIDs are DETERMINISTIC: md5('loadtest-seller-{N}')::uuid
-- k6 generates identical UUIDs client-side using the same md5 seed.
-- No JSON export needed — k6 computes UUIDs at runtime.
--
-- Usage:
--   psql -h <host> -U <user> -d <database> -f seed-test-data.sql
--
-- To change pair count:
--   Edit the number in every generate_series(1, 1000) call below.
--
-- To clean up:
--   psql ... -f cleanup-test-data.sql
--
-- Categories used: 429, 135, 189, 140, 141 (must be leaf categories)
-- ═══════════════════════════════════════════════════════════════

BEGIN;

-- ─── Cleanup existing test data (safe to re-run) ─────────────

-- Null out FK references that might block deletion
UPDATE "Offers" SET "MessageId" = NULL, "InvoiceId" = NULL
WHERE "ItemId" IN (
  SELECT "Id" FROM "Items" WHERE "Title" LIKE 'Load Test Item %'
);

UPDATE "Message" SET "OfferId" = NULL
WHERE "OfferId" IN (
  SELECT o."Id" FROM "Offers" o
  WHERE o."ItemId" IN (
    SELECT "Id" FROM "Items" WHERE "Title" LIKE 'Load Test Item %'
  )
);

-- Delete in dependency order
DELETE FROM "Invoices"
WHERE "ItemId" IN (
  SELECT "Id" FROM "Items" WHERE "Title" LIKE 'Load Test Item %'
);

DELETE FROM "Message"
WHERE "ItemId" IN (
  SELECT "Id" FROM "Items" WHERE "Title" LIKE 'Load Test Item %'
);

DELETE FROM "Offers"
WHERE "ItemId" IN (
  SELECT "Id" FROM "Items" WHERE "Title" LIKE 'Load Test Item %'
);

DELETE FROM "Items"
WHERE "Title" LIKE 'Load Test Item %';

DELETE FROM "Profile"
WHERE "KnownAs" LIKE 'LT Seller %' OR "KnownAs" LIKE 'LT Buyer %';

DELETE FROM "AspNetUsers"
WHERE "UserName" LIKE 'loadtest-seller-%' OR "UserName" LIKE 'loadtest-buyer-%';

-- ─── 1. Seller AppUsers (1000) ────────────────────────────────

INSERT INTO "AspNetUsers" (
  "Id", "UserName", "NormalizedUserName",
  "Email", "NormalizedEmail", "EmailConfirmed",
  "SecurityStamp", "ConcurrencyStamp",
  "PhoneNumber", "PhoneNumberConfirmed",
  "TwoFactorEnabled", "LockoutEnabled", "AccessFailedCount",
  "FullName", "IsFirstLogin", "UserType"
)
SELECT
  md5('loadtest-seller-' || i)::uuid,
  'loadtest-seller-' || i,
  UPPER('loadtest-seller-' || i),
  'loadtest-seller-' || i || '@loadtest.local',
  UPPER('loadtest-seller-' || i || '@LOADTEST.LOCAL'),
  true,
  md5('secstamp-seller-' || i),
  md5('concstamp-seller-' || i),
  '9647700' || LPAD(i::text, 5, '0'),
  true,
  false, false, 0,
  'Load Test Seller ' || i,
  false,
  2  -- Customer
FROM generate_series(1, 1000) AS i;

-- ─── 2. Buyer AppUsers (1000) ─────────────────────────────────

INSERT INTO "AspNetUsers" (
  "Id", "UserName", "NormalizedUserName",
  "Email", "NormalizedEmail", "EmailConfirmed",
  "SecurityStamp", "ConcurrencyStamp",
  "PhoneNumber", "PhoneNumberConfirmed",
  "TwoFactorEnabled", "LockoutEnabled", "AccessFailedCount",
  "FullName", "IsFirstLogin", "UserType"
)
SELECT
  md5('loadtest-buyer-' || i)::uuid,
  'loadtest-buyer-' || i,
  UPPER('loadtest-buyer-' || i),
  'loadtest-buyer-' || i || '@loadtest.local',
  UPPER('loadtest-buyer-' || i || '@LOADTEST.LOCAL'),
  true,
  md5('secstamp-buyer-' || i),
  md5('concstamp-buyer-' || i),
  '9647800' || LPAD(i::text, 5, '0'),
  true,
  false, false, 0,
  'Load Test Buyer ' || i,
  false,
  2  -- Customer
FROM generate_series(1, 1000) AS i;

-- ─── 3. Seller Profiles (1000) ────────────────────────────────

INSERT INTO "Profile" (
  "Id", "AppUserId",
  "Description", "KnownAs",
  "CustomerAccountNumber", "LogoPath",
  "CreatedAt", "IsDeleted", "Status"
)
SELECT
  md5('loadtest-seller-profile-' || i)::uuid,
  md5('loadtest-seller-' || i)::uuid,
  'Load test seller profile ' || i,
  'LT Seller ' || i,
  '', '',
  NOW(), false, 1  -- Active
FROM generate_series(1, 1000) AS i;

-- ─── 4. Buyer Profiles (1000) ─────────────────────────────────

INSERT INTO "Profile" (
  "Id", "AppUserId",
  "Description", "KnownAs",
  "CustomerAccountNumber", "LogoPath",
  "CreatedAt", "IsDeleted", "Status"
)
SELECT
  md5('loadtest-buyer-profile-' || i)::uuid,
  md5('loadtest-buyer-' || i)::uuid,
  'Load test buyer profile ' || i,
  'LT Buyer ' || i,
  '', '',
  NOW(), false, 1  -- Active
FROM generate_series(1, 1000) AS i;

-- ─── 5. Items (1000 — one per seller) ────────────────────────

INSERT INTO "Items" (
  "Id", "Title", "Description",
  "SellType", "SearchText", "Price",
  "Gov", "City",
  "ContactPhoneNumber", "WhatsappPhoneNumber",
  "LastCategoryId", "LifecycleStatus", "ItemStatus",
  "SellerId",
  "CreatedAt", "IsDeleted", "Status"
)
SELECT
  md5('loadtest-item-' || i)::uuid,
  'Load Test Item ' || i,
  'Load test item for seller-buyer pair ' || i,
  2,                                                        -- MarketplaceListing
  'load test item ' || i,
  (250 + (i * 7) % 9750)::decimal,                          -- Price 250–9999
  (ARRAY[11, 14, 22, 21, 25])[1 + ((i - 1) % 5)],         -- Baghdad/Basra/Erbil/Sulaymaniyah/Kirkuk
  'Test City',
  '9647700' || LPAD(i::text, 5, '0'),
  '',
  (ARRAY[429, 135, 189, 140, 141])[1 + ((i - 1) % 5)],    -- Category rotation
  9,                                                        -- Published (can receive offers)
  (ARRAY[1, 2, 3])[1 + ((i - 1) % 3)],                    -- New / Used / Refurbished
  md5('loadtest-seller-profile-' || i)::uuid,               -- SellerId = Seller's Profile.Id
  NOW(), false, 1                                           -- Active
FROM generate_series(1, 1000) AS i;

-- ─── Verify ───────────────────────────────────────────────────

DO $$
DECLARE
  cnt_sellers    INT;
  cnt_buyers     INT;
  cnt_s_profiles INT;
  cnt_b_profiles INT;
  cnt_items      INT;
BEGIN
  SELECT COUNT(*) INTO cnt_sellers    FROM "AspNetUsers" WHERE "UserName" LIKE 'loadtest-seller-%';
  SELECT COUNT(*) INTO cnt_buyers     FROM "AspNetUsers" WHERE "UserName" LIKE 'loadtest-buyer-%';
  SELECT COUNT(*) INTO cnt_s_profiles FROM "Profile"     WHERE "KnownAs"  LIKE 'LT Seller %';
  SELECT COUNT(*) INTO cnt_b_profiles FROM "Profile"     WHERE "KnownAs"  LIKE 'LT Buyer %';
  SELECT COUNT(*) INTO cnt_items      FROM "Items"       WHERE "Title"    LIKE 'Load Test Item %';

  RAISE NOTICE '';
  RAISE NOTICE '╔══════════════════════════════════════════╗';
  RAISE NOTICE '║  ✅ Load Test Data Seeded Successfully    ║';
  RAISE NOTICE '╠══════════════════════════════════════════╣';
  RAISE NOTICE '║  Sellers:          %                      ', cnt_sellers;
  RAISE NOTICE '║  Buyers:           %                      ', cnt_buyers;
  RAISE NOTICE '║  Seller Profiles:  %                      ', cnt_s_profiles;
  RAISE NOTICE '║  Buyer Profiles:   %                      ', cnt_b_profiles;
  RAISE NOTICE '║  Items:            %                      ', cnt_items;
  RAISE NOTICE '╚══════════════════════════════════════════╝';
  RAISE NOTICE '';
  RAISE NOTICE 'Run your load tests:';
  RAISE NOTICE '  ./load-tests/run.sh --scenario chat-offers --stage smoke';
  RAISE NOTICE '';
END $$;

COMMIT;
