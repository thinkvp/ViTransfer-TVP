-- Make Expense.supplierName optional (nullable)
ALTER TABLE "Expense" ALTER COLUMN "supplierName" DROP NOT NULL;
