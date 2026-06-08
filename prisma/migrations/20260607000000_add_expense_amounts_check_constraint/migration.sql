-- Add CHECK constraint to ensure Expense amount columns stay consistent.
-- Allows ±1 cent rounding tolerance (e.g. $100 + $10 = $110, but rounding
-- can produce $100 + $10 = $111 in edge cases).
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_amounts_consistency_check"
  CHECK (ABS(("amountExGst" + "gstAmount") - "amountIncGst") <= 1);
