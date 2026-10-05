-- Data fix: an EXPENSE-matched bank transaction must not carry an accountId (the linked
-- Expense owns the account). The expense editor used to copy a changed account onto the
-- bank transaction, which made the Chart of Accounts ledger list the amount twice.
UPDATE "BankTransaction"
SET "accountId" = NULL
WHERE "matchType" = 'EXPENSE' AND "accountId" IS NOT NULL;
