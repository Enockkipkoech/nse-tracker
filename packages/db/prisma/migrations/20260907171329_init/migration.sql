-- CreateEnum
CREATE TYPE "InstrumentType" AS ENUM ('ORDINARY', 'PREFERENCE', 'ETF', 'REIT', 'DR', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "SecurityStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'DELISTED');

-- CreateEnum
CREATE TYPE "PriceSource" AS ENUM ('TV_DIRECT', 'OANOR_SCREENER', 'OANOR_QUOTE', 'NSE_PDF', 'MANUAL');

-- CreateEnum
CREATE TYPE "CorpActionType" AS ENUM ('CASH_DIVIDEND', 'BONUS', 'SPLIT', 'RIGHTS', 'BUYBACK', 'CAPITAL_REDUCTION', 'SCRIP');

-- CreateEnum
CREATE TYPE "DividendType" AS ENUM ('INTERIM', 'FINAL', 'SPECIAL', 'FIRST_INTERIM', 'SECOND_INTERIM');

-- CreateEnum
CREATE TYPE "ActionStatus" AS ENUM ('ANNOUNCED', 'APPROVED_AGM', 'PAID', 'CANCELLED', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "Severity" AS ENUM ('INFO', 'WARN', 'ERROR');

-- CreateTable
CREATE TABLE "security_master" (
    "ticker" TEXT NOT NULL,
    "tv_symbol" TEXT,
    "isin" TEXT,
    "company_name" TEXT NOT NULL,
    "nse_sector" TEXT,
    "sector_upstream" TEXT,
    "industry_upstream" TEXT,
    "instrument_type" "InstrumentType" NOT NULL DEFAULT 'ORDINARY',
    "parent_ticker" TEXT,
    "former_ticker" TEXT,
    "ticker_change_date" DATE,
    "board" TEXT NOT NULL DEFAULT 'MIMS',
    "shares_issued" BIGINT,
    "free_float_shares" BIGINT,
    "currency" TEXT NOT NULL DEFAULT 'KES',
    "status" "SecurityStatus" NOT NULL DEFAULT 'ACTIVE',
    "in_market_cap" BOOLEAN NOT NULL DEFAULT true,
    "covered_by_tv" BOOLEAN NOT NULL DEFAULT false,
    "listing_date" DATE,
    "fiscal_year_end" TEXT,
    "source_url" TEXT,
    "verified_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "security_master_pkey" PRIMARY KEY ("ticker")
);

-- CreateTable
CREATE TABLE "daily_prices" (
    "id" SERIAL NOT NULL,
    "trade_date" DATE NOT NULL,
    "ticker" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "open" DECIMAL(12,4),
    "high" DECIMAL(12,4),
    "low" DECIMAL(12,4),
    "close" DECIMAL(12,4),
    "prev_close" DECIMAL(12,4),
    "change_kes" DECIMAL(12,4),
    "change_pct" DECIMAL(8,4),
    "gap_pct" DECIMAL(8,4),
    "high_52w" DECIMAL(12,4),
    "low_52w" DECIMAL(12,4),
    "volume" BIGINT,
    "value_traded_kes" DECIMAL(18,2),
    "turnover_kes" DECIMAL(18,2),
    "deals" INTEGER,
    "market_cap_kes" DECIMAL(20,2),
    "shares_outstanding" DECIMAL(20,0),
    "pe_ratio" DECIMAL(10,4),
    "pb_ratio" DECIMAL(10,4),
    "eps_ttm" DECIMAL(10,4),
    "dividend_yield_pct" DECIMAL(8,4),
    "dps_derived_kes" DECIMAL(10,4),
    "dps_confidence" TEXT,
    "payout_ratio_pct" DECIMAL(8,4),
    "is_stale" BOOLEAN NOT NULL DEFAULT false,
    "traded_flag" BOOLEAN,
    "source" "PriceSource" NOT NULL,
    "request_id" TEXT,
    "captured_at" TIMESTAMP(3) NOT NULL,
    "raw_ref" TEXT,

    CONSTRAINT "daily_prices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "intraday_ticks" (
    "captured_at" TIMESTAMPTZ(3) NOT NULL,
    "ticker" TEXT NOT NULL,
    "price" DECIMAL(12,4),
    "change_pct" DECIMAL(8,4),
    "volume" BIGINT,
    "market_cap_kes" DECIMAL(20,2),
    "trade_date_inferred" DATE,

    CONSTRAINT "intraday_ticks_pkey" PRIMARY KEY ("captured_at","ticker")
);

-- CreateTable
CREATE TABLE "corporate_actions" (
    "action_id" TEXT NOT NULL,
    "ticker" TEXT NOT NULL,
    "action_type" "CorpActionType" NOT NULL,
    "dividend_type" "DividendType",
    "fiscal_year" INTEGER,
    "announcement_date" DATE,
    "amount_per_share_kes" DECIMAL(10,4),
    "ratio" TEXT,
    "books_closure_date" DATE,
    "ex_date" DATE,
    "payment_date" DATE,
    "status" "ActionStatus" NOT NULL DEFAULT 'ANNOUNCED',
    "source_url" TEXT,
    "verified_at" TIMESTAMP(3),

    CONSTRAINT "corporate_actions_pkey" PRIMARY KEY ("action_id")
);

-- CreateTable
CREATE TABLE "fundamentals" (
    "ticker" TEXT NOT NULL,
    "period_end" DATE NOT NULL,
    "period_type" TEXT,
    "is_audited" BOOLEAN,
    "revenue_kes" DECIMAL(18,2),
    "pat_kes" DECIMAL(18,2),
    "eps_basic_kes" DECIMAL(10,4),
    "dps_declared_kes" DECIMAL(10,4),
    "book_value_per_share_kes" DECIMAL(10,4),
    "report_url" TEXT,

    CONSTRAINT "fundamentals_pkey" PRIMARY KEY ("ticker","period_end")
);

-- CreateTable
CREATE TABLE "market_stats" (
    "trade_date" DATE NOT NULL,
    "nasi" DECIMAL(10,4),
    "nse20" DECIMAL(10,4),
    "nse25" DECIMAL(10,4),
    "nse10" DECIMAL(10,4),
    "banking_index" DECIMAL(10,4),
    "total_market_cap_kes" DECIMAL(20,2),
    "equity_turnover_kes" DECIMAL(18,2),
    "total_deals" INTEGER,
    "net_foreign_flow_kes" DECIMAL(18,2),
    "usd_kes_rate" DECIMAL(10,4),
    "tbill_91d_pct" DECIMAL(8,4),
    "advancers" INTEGER,
    "decliners" INTEGER,
    "unchanged" INTEGER,
    "source" TEXT,
    "captured_at" TIMESTAMP(3),

    CONSTRAINT "market_stats_pkey" PRIMARY KEY ("trade_date")
);

-- CreateTable
CREATE TABLE "market_calendar" (
    "cal_date" DATE NOT NULL,
    "is_trading_day" BOOLEAN NOT NULL,
    "holiday_name" TEXT,

    CONSTRAINT "market_calendar_pkey" PRIMARY KEY ("cal_date")
);

-- CreateTable
CREATE TABLE "quality_log" (
    "id" SERIAL NOT NULL,
    "logged_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "severity" "Severity" NOT NULL,
    "code" TEXT NOT NULL,
    "ticker" TEXT,
    "trade_date" DATE,
    "detail" TEXT NOT NULL,

    CONSTRAINT "quality_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "security_master_tv_symbol_key" ON "security_master"("tv_symbol");

-- CreateIndex
CREATE UNIQUE INDEX "security_master_isin_key" ON "security_master"("isin");

-- CreateIndex
CREATE INDEX "daily_prices_ticker_trade_date_idx" ON "daily_prices"("ticker", "trade_date" DESC);

-- CreateIndex
CREATE INDEX "daily_prices_trade_date_idx" ON "daily_prices"("trade_date" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "daily_prices_trade_date_ticker_revision_source_key" ON "daily_prices"("trade_date", "ticker", "revision", "source");

-- CreateIndex
CREATE INDEX "intraday_ticks_ticker_captured_at_idx" ON "intraday_ticks"("ticker", "captured_at" DESC);

-- CreateIndex
CREATE INDEX "corporate_actions_ticker_ex_date_idx" ON "corporate_actions"("ticker", "ex_date" DESC);

-- CreateIndex
CREATE INDEX "quality_log_logged_at_idx" ON "quality_log"("logged_at" DESC);

-- AddForeignKey
ALTER TABLE "daily_prices" ADD CONSTRAINT "daily_prices_ticker_fkey" FOREIGN KEY ("ticker") REFERENCES "security_master"("ticker") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "corporate_actions" ADD CONSTRAINT "corporate_actions_ticker_fkey" FOREIGN KEY ("ticker") REFERENCES "security_master"("ticker") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fundamentals" ADD CONSTRAINT "fundamentals_ticker_fkey" FOREIGN KEY ("ticker") REFERENCES "security_master"("ticker") ON DELETE RESTRICT ON UPDATE CASCADE;
