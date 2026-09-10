/*
  Warnings:

  - You are about to drop the column `currency` on the `security_master` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "security_master" DROP COLUMN "currency",
ADD COLUMN     "exchange_currency" TEXT NOT NULL DEFAULT 'KES',
ADD COLUMN     "reporting_currency" TEXT NOT NULL DEFAULT 'KES';
