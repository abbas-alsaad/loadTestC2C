-- ═══════════════════════════════════════════════════════════════════
-- C2C Load Test — UAT Database Seed Script
-- ═══════════════════════════════════════════════════════════════════
--
-- Seeds 1000 seller/buyer pairs + 1000 items into the UAT database.
-- Uses md5('loadtest-seller-{N}')::uuid so UUIDs match k6's test-data.js.
--
-- Usage:
--   psql "host=<UAT_HOST> dbname=c2c user=postgres password=<PW>" -f load-tests/seed-uat.sql
--
-- Safe to re-run: uses ON CONFLICT DO NOTHING.
-- ═══════════════════════════════════════════════════════════════════

BEGIN;

-- ─── 0. Ensure a leaf category exists for test items ─────────────
-- Use existing category if available; otherwise insert id=9999.
INSERT INTO "Category" (
    "Id", "Name", "NameAr", "Domain", "IsLeaf", "Status",
    "CreatedAt", "IsDeleted"
)
VALUES (
    9999, 'Load Test Items', 'عناصر اختبار الحمل', 5, true, 1,
    NOW(), false
)
ON CONFLICT ("Id") DO NOTHING;

-- We'll use whichever leaf category is available (prefer existing ones).
-- This CTE picks the first leaf category.
DO $$
DECLARE
    v_cat_id INT;
BEGIN
    SELECT "Id" INTO v_cat_id
    FROM "Category"
    WHERE "IsLeaf" = true AND "IsDeleted" = false
    ORDER BY "Id"
    LIMIT 1;

    IF v_cat_id IS NULL THEN
        RAISE EXCEPTION 'No leaf category found — seed aborted';
    END IF;

    RAISE NOTICE 'Using category ID: %', v_cat_id;

    -- ─── 1. Seed 1000 Sellers ────────────────────────────────────
    INSERT INTO "AspNetUsers" (
        "Id", "UserName", "NormalizedUserName",
        "Email", "NormalizedEmail", "EmailConfirmed",
        "PasswordHash", "SecurityStamp", "ConcurrencyStamp",
        "PhoneNumberConfirmed", "TwoFactorEnabled",
        "LockoutEnabled", "AccessFailedCount",
        "FullName", "IsFirstLogin"
    )
    SELECT
        md5('loadtest-seller-' || i)::uuid,
        'loadtest-seller-' || i,
        UPPER('loadtest-seller-' || i),
        'loadtest-seller-' || i || '@test.local',
        UPPER('loadtest-seller-' || i || '@test.local'),
        false,
        NULL, gen_random_uuid()::text, gen_random_uuid()::text,
        false, false, false, 0,
        'Load Test Seller ' || i,
        false
    FROM generate_series(1, 1000) AS i
    ON CONFLICT ("Id") DO NOTHING;

    -- ─── 2. Seed 1000 Buyers ─────────────────────────────────────
    INSERT INTO "AspNetUsers" (
        "Id", "UserName", "NormalizedUserName",
        "Email", "NormalizedEmail", "EmailConfirmed",
        "PasswordHash", "SecurityStamp", "ConcurrencyStamp",
        "PhoneNumberConfirmed", "TwoFactorEnabled",
        "LockoutEnabled", "AccessFailedCount",
        "FullName", "IsFirstLogin"
    )
    SELECT
        md5('loadtest-buyer-' || i)::uuid,
        'loadtest-buyer-' || i,
        UPPER('loadtest-buyer-' || i),
        'loadtest-buyer-' || i || '@test.local',
        UPPER('loadtest-buyer-' || i || '@test.local'),
        false,
        NULL, gen_random_uuid()::text, gen_random_uuid()::text,
        false, false, false, 0,
        'Load Test Buyer ' || i,
        false
    FROM generate_series(1, 1000) AS i
    ON CONFLICT ("Id") DO NOTHING;

    -- ─── 3. Seed Seller Profiles ─────────────────────────────────
    INSERT INTO "Profile" (
        "Id", "AppUserId", "Status",
        "CustomerAccountNumber", "LogoPath",
        "CreatedAt", "IsDeleted", "KnownAs"
    )
    SELECT
        gen_random_uuid(),
        md5('loadtest-seller-' || i)::uuid,
        1,  -- Active
        '', '',
        NOW(), false,
        'loadtest-seller-' || i
    FROM generate_series(1, 1000) AS i
    WHERE NOT EXISTS (
        SELECT 1 FROM "Profile" WHERE "AppUserId" = md5('loadtest-seller-' || i)::uuid
    );

    -- ─── 4. Seed Buyer Profiles ──────────────────────────────────
    INSERT INTO "Profile" (
        "Id", "AppUserId", "Status",
        "CustomerAccountNumber", "LogoPath",
        "CreatedAt", "IsDeleted", "KnownAs"
    )
    SELECT
        gen_random_uuid(),
        md5('loadtest-buyer-' || i)::uuid,
        1,  -- Active
        '', '',
        NOW(), false,
        'loadtest-buyer-' || i
    FROM generate_series(1, 1000) AS i
    WHERE NOT EXISTS (
        SELECT 1 FROM "Profile" WHERE "AppUserId" = md5('loadtest-buyer-' || i)::uuid
    );

    -- ─── 5. Seed 1000 Items (owned by sellers) ──────────────────
    -- Item ID = md5('loadtest-item-{N}')::uuid (matches k6 test-data.js)
    -- SellerId = Profile.Id where AppUserId = seller's UUID
    INSERT INTO "Items" (
        "Id", "Title", "Description", "SellType",
        "SearchText", "Price", "Gov", "ContactPhoneNumber",
        "WhatsappPhoneNumber", "LastCategoryId",
        "LifecycleStatus", "ItemStatus", "Status",
        "SellerId", "CreatedAt", "IsDeleted"
    )
    SELECT
        md5('loadtest-item-' || i)::uuid,
        'Load Test Item #' || i,
        'Automated load test item for pair ' || i,
        2,              -- MarketplaceListing
        'loadtest item ' || i,
        (1000 + (i * 17) % 9000)::numeric,  -- Random-ish price 1000-10000
        11,             -- Baghdad
        '07700000000',
        '07700000000',
        v_cat_id,
        9,              -- Published (so it shows up in browse)
        2,              -- Used
        1,              -- Active
        p."Id",
        NOW(),
        false
    FROM generate_series(1, 1000) AS i
    JOIN "Profile" p ON p."AppUserId" = md5('loadtest-seller-' || i)::uuid
    ON CONFLICT ("Id") DO NOTHING;

END $$;

-- ─── Summary ─────────────────────────────────────────────────────
DO $$
DECLARE
    seller_count INT;
    buyer_count  INT;
    profile_count INT;
    item_count   INT;
BEGIN
    SELECT COUNT(*) INTO seller_count FROM "AspNetUsers" WHERE "UserName" LIKE 'loadtest-seller-%';
    SELECT COUNT(*) INTO buyer_count  FROM "AspNetUsers" WHERE "UserName" LIKE 'loadtest-buyer-%';
    SELECT COUNT(*) INTO profile_count FROM "Profile" WHERE "KnownAs" LIKE 'loadtest-%';
    SELECT COUNT(*) INTO item_count   FROM "Items" WHERE "Title" LIKE 'Load Test Item%';

    RAISE NOTICE '════════════════════════════════════════════';
    RAISE NOTICE '  Load Test Seed Summary';
    RAISE NOTICE '  Sellers:  %', seller_count;
    RAISE NOTICE '  Buyers:   %', buyer_count;
    RAISE NOTICE '  Profiles: %', profile_count;
    RAISE NOTICE '  Items:    %', item_count;
    RAISE NOTICE '════════════════════════════════════════════';
END $$;

COMMIT;
