-- AlterTable: add optional CoA account link to BankAccount
ALTER TABLE "BankAccount" ADD COLUMN "coaAccountId" TEXT;

-- CreateIndex: enforce uniqueness (one bank account per CoA account)
CREATE UNIQUE INDEX "BankAccount_coaAccountId_key" ON "BankAccount"("coaAccountId");

-- AddForeignKey
ALTER TABLE "BankAccount" ADD CONSTRAINT "BankAccount_coaAccountId_fkey" FOREIGN KEY ("coaAccountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;
