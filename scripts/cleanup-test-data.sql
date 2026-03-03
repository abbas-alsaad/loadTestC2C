-- ═══════════════════════════════════════════════════════════════
-- Load Test Data Cleanup Script
-- ═══════════════════════════════════════════════════════════════
--
-- Removes ALL data created by seed-test-data.sql.
-- Safe to run multiple times.
--
-- Usage:
--   psql -h <host> -U <user> -d <database> -f cleanup-test-data.sql
-- ═══════════════════════════════════════════════════════════════

BEGIN;

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

-- Verify cleanup
DO $$
DECLARE
  remaining INT;
BEGIN
  SELECT COUNT(*) INTO remaining
  FROM "AspNetUsers"
  WHERE "UserName" LIKE 'loadtest-seller-%' OR "UserName" LIKE 'loadtest-buyer-%';

  IF remaining = 0 THEN
    RAISE NOTICE '✅ All load test data removed successfully.';
  ELSE
    RAISE WARNING '⚠️  % load test user(s) still remain.', remaining;
  END IF;
END $$;

COMMIT;
