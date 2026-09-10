/*
  Warnings:

  - You are about to drop the column `amount_per_share_kes` on the `corporate_actions` table. All the data in the column will be lost.
  - You are about to drop the column `book_value_per_share_kes` on the `fundamentals` table. All the data in the column will be lost.
  - You are about to drop the column `dps_declared_kes` on the `fundamentals` table. All the data in the column will be lost.
  - You are about to drop the column `eps_basic_kes` on the `fundamentals` table. All the data in the column will be lost.
  - You are about to drop the column `pat_kes` on the `fundamentals` table. All the data in the column will be lost.
  - You are about to drop the column `revenue_kes` on the `fundamentals` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "corporate_actions" DROP COLUMN "amount_per_share_kes",
ADD COLUMN     "amount_per_share" DECIMAL(10,4);

-- AlterTable
ALTER TABLE "fundamentals" DROP COLUMN "book_value_per_share_kes",
DROP COLUMN "dps_declared_kes",
DROP COLUMN "eps_basic_kes",
DROP COLUMN "pat_kes",
DROP COLUMN "revenue_kes",
ADD COLUMN     "book_value_per_share" DECIMAL(10,4),
ADD COLUMN     "dps_declared" DECIMAL(10,4),
ADD COLUMN     "eps_basic" DECIMAL(10,4),
ADD COLUMN     "pat" DECIMAL(18,2),
ADD COLUMN     "revenue" DECIMAL(18,2);
