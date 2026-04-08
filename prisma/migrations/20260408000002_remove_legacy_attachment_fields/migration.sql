-- Remove legacy single-file attachment columns from BankTransaction
ALTER TABLE "BankTransaction" DROP COLUMN IF EXISTS "attachmentPath";
ALTER TABLE "BankTransaction" DROP COLUMN IF EXISTS "attachmentOriginalName";

-- Remove legacy single-file receipt columns from Expense
ALTER TABLE "Expense" DROP COLUMN IF EXISTS "receiptPath";
ALTER TABLE "Expense" DROP COLUMN IF EXISTS "receiptOriginalName";
