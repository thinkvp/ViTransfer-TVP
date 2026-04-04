-- Refactor: extract item data into a global SalesItem library.
-- SalesPreset now just stores which SalesItem IDs to check (via join table).

-- 1. Create global SalesItem table
CREATE TABLE "SalesItem" (
    "id"             TEXT            NOT NULL,
    "description"    VARCHAR(500)    NOT NULL,
    "details"        TEXT            NOT NULL DEFAULT '',
    "quantity"       DOUBLE PRECISION NOT NULL,
    "unitPriceCents" INTEGER         NOT NULL,
    "taxRatePercent" DOUBLE PRECISION NOT NULL,
    "taxRateName"    VARCHAR(200),
    "sortOrder"      INTEGER         NOT NULL DEFAULT 0,
    "createdAt"      TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SalesItem_pkey" PRIMARY KEY ("id")
);

-- 2. Migrate existing preset items into the global library (preserve IDs)
INSERT INTO "SalesItem" ("id", "description", "details", "quantity", "unitPriceCents",
                         "taxRatePercent", "taxRateName", "sortOrder", "createdAt", "updatedAt")
SELECT "id", "description", "details", "quantity", "unitPriceCents",
       "taxRatePercent", "taxRateName", "sortOrder", "createdAt", "updatedAt"
FROM   "SalesPresetItem";

-- 3. Build new join table (rename old presetId+own-id relationship to presetId+itemId)
CREATE TABLE "SalesPresetItem_new" (
    "id"        TEXT         NOT NULL,
    "presetId"  TEXT         NOT NULL,
    "itemId"    TEXT         NOT NULL,
    "sortOrder" INTEGER      NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SalesPresetItem_new_pkey" PRIMARY KEY ("id")
);

-- 4. Populate join table — old SalesPresetItem.id is now the SalesItem.id
INSERT INTO "SalesPresetItem_new" ("id", "presetId", "itemId", "sortOrder", "createdAt")
SELECT gen_random_uuid()::text, "presetId", "id", "sortOrder", "createdAt"
FROM   "SalesPresetItem";

-- 5. Drop old table and rename new one
DROP TABLE "SalesPresetItem";
ALTER TABLE "SalesPresetItem_new" RENAME TO "SalesPresetItem";

-- 6. Add foreign key constraints
ALTER TABLE "SalesPresetItem"
    ADD CONSTRAINT "SalesPresetItem_presetId_fkey"
    FOREIGN KEY ("presetId") REFERENCES "SalesPreset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SalesPresetItem"
    ADD CONSTRAINT "SalesPresetItem_itemId_fkey"
    FOREIGN KEY ("itemId") REFERENCES "SalesItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 7. Unique constraint (a preset can reference each item at most once)
ALTER TABLE "SalesPresetItem"
    ADD CONSTRAINT "SalesPresetItem_presetId_itemId_key" UNIQUE ("presetId", "itemId");

-- 8. Indexes
CREATE INDEX "SalesItem_sortOrder_idx"       ON "SalesItem"("sortOrder");
CREATE INDEX "SalesItem_createdAt_idx"       ON "SalesItem"("createdAt");
CREATE INDEX "SalesPresetItem_presetId_idx"  ON "SalesPresetItem"("presetId");
CREATE INDEX "SalesPresetItem_itemId_idx"    ON "SalesPresetItem"("itemId");
