-- AlterTable
ALTER TABLE "corporate_actions" ADD COLUMN     "source_tier" TEXT;

-- AlterTable
ALTER TABLE "daily_prices" ADD COLUMN     "avg_volume_10d" DECIMAL(18,2),
ADD COLUMN     "avg_volume_30d" DECIMAL(18,2),
ADD COLUMN     "delay_seconds" INTEGER,
ADD COLUMN     "dividend_growth_years" INTEGER,
ADD COLUMN     "dividend_streak_years" INTEGER,
ADD COLUMN     "dividend_yield_current_raw" DECIMAL(10,4),
ADD COLUMN     "dividend_yield_raw" DECIMAL(10,4),
ADD COLUMN     "eps_diluted_ttm" DECIMAL(10,4),
ADD COLUMN     "high_all" DECIMAL(12,4),
ADD COLUMN     "last_update_time" TIMESTAMP(3),
ADD COLUMN     "low_all" DECIMAL(12,4),
ADD COLUMN     "perf_1m" DECIMAL(10,4),
ADD COLUMN     "perf_1w" DECIMAL(10,4),
ADD COLUMN     "perf_1y" DECIMAL(10,4),
ADD COLUMN     "perf_3m" DECIMAL(10,4),
ADD COLUMN     "perf_6m" DECIMAL(10,4),
ADD COLUMN     "perf_ytd" DECIMAL(10,4),
ADD COLUMN     "relative_volume_10d" DECIMAL(10,4);

-- AlterTable
ALTER TABLE "fundamentals" ADD COLUMN     "source_tier" TEXT;
