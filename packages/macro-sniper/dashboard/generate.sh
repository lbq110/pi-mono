#!/bin/bash
# Generate USD model dashboard with latest data
# Usage: ./dashboard/generate.sh
set -euo pipefail
cd "$(dirname "$0")/.."

echo "Extracting data from DB..."
DATA=$(node --env-file=.env --import tsx -e "
import { getDb, closeDb } from './src/db/client.js';
import { analysisResults, hourlyPrices } from './src/db/schema.js';
import { eq, asc, sql, and, gte } from 'drizzle-orm';
import { runMigrations } from './src/db/migrate.js';
runMigrations();
const db = getDb();
const usd = db.select().from(analysisResults).where(eq(analysisResults.type, 'usd_model')).orderBy(asc(analysisResults.date)).all();
const prices = {};
for (const sym of ['SPY','QQQ','IWM','BTCUSD']) {
  prices[sym] = db.select({ date: sql\`substr(datetime, 1, 10)\`, close: sql\`max(close)\` })
    .from(hourlyPrices).where(and(eq(hourlyPrices.symbol, sym), gte(hourlyPrices.datetime, '2026-03-01')))
    .groupBy(sql\`substr(datetime, 1, 10)\`).orderBy(sql\`substr(datetime, 1, 10)\`).all();
}
const signals = {};
for (const t of ['liquidity_signal','yield_curve','credit_risk','sentiment_signal','btc_signal','market_bias','auction_health','funding_stress','correlation_matrix']) {
  signals[t] = db.select().from(analysisResults).where(eq(analysisResults.type, t)).orderBy(asc(analysisResults.date)).all().map(r => ({
    date: r.date, signal: r.signal, metadata: r.metadata
  }));
}
console.log(JSON.stringify({
  usdModel: usd.map(r => ({ date: r.date, signal: r.signal, ...(typeof r.metadata === 'string' ? JSON.parse(r.metadata) : r.metadata) })),
  prices, signals
}));
closeDb();
" 2>&1 | grep '^{')

echo "Generating dashboard HTML..."
sed "s|DASHBOARD_DATA_PLACEHOLDER|$DATA|" dashboard/usd-model.html > dashboard/usd-model-live.html

echo "Done! Open dashboard/usd-model-live.html in browser"
echo "Or serve: python3 -m http.server 8080 --directory dashboard"
