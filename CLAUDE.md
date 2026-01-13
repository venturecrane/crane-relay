# CLAUDE.md - DFG Workers (Cloudflare)

This file provides worker-specific guidance for DFG Cloudflare Workers.

## About DFG Workers

- **dfg-api**: REST API for opportunities CRUD and listing management
- **dfg-scout**: Auction scraping pipeline (scheduled)
- **dfg-analyst**: AI-powered opportunity analysis using Claude API
- **dfg-relay**: GitHub issue integration for notifications

## Build Commands

```bash
# From workers/[worker-name]/
npx wrangler dev         # Local dev server
npx wrangler deploy      # Deploy to Cloudflare
npx tsc --noEmit         # TypeScript validation
npm run test             # Run tests (if available)
```

## Tech Stack

- Cloudflare Workers (JavaScript runtime)
- Hono (HTTP router)
- Cloudflare D1 (SQLite database)
- Cloudflare R2 (object storage)
- Vitest (testing)

## Code Patterns

### Router Setup (Hono)
```typescript
import { Hono } from 'hono'
import { cors } from 'hono/cors'

const app = new Hono<{ Bindings: Env }>()

app.use('/*', cors())
app.get('/health', (c) => c.json({ status: 'ok' }))

export default app
```

### Database Queries (D1)
Always use `.bind()` for parameterization:
```typescript
// ✅ CORRECT
const result = await env.DB.prepare(
  'SELECT * FROM opportunities WHERE id = ?'
).bind(opportunityId).first()

// ❌ WRONG - SQL injection risk
const result = await env.DB.prepare(
  `SELECT * FROM opportunities WHERE id = ${opportunityId}`
).first()
```

### R2 Storage
```typescript
// Put object
await env.R2_BUCKET.put('key', data, {
  httpMetadata: { contentType: 'application/json' }
})

// Get object
const object = await env.R2_BUCKET.get('key')
const data = await object?.json()
```

### Error Handling
```typescript
try {
  // Worker logic
} catch (error) {
  console.error('Worker error:', error)
  return c.json({ error: 'Internal server error' }, 500)
}
```

## Money Math (Non-negotiable)

Use these exact definitions everywhere:
- **Acquisition Cost** = Bid + Buyer Premium + Transport + Immediate Repairs
- **Net Proceeds** = Sale Price − Listing Fees − Payment Processing
- **Profit** = Net Proceeds − Acquisition Cost
- **Margin %** = (Profit / Acquisition Cost) * 100

**CRITICAL**: Listing fees are SELLING COSTS ONLY. Never include in acquisition cost.

For shared calculations, use `@dfg/money-math` package:
```typescript
import { calculateProfit, calculateMargin } from '@dfg/money-math'
```

## Worker-Specific Notes

### dfg-api
- Primary CRUD operations for opportunities and listings
- D1 database migrations: `npm run db:migrate` (remote) or `npm run db:migrate:local`
- Vitest tests: `npm run test`
- Authentication: Validates session tokens from dfg-app

### dfg-scout
- Scheduled trigger: Runs scraping pipeline on cron
- Dev server includes `--test-scheduled` flag
- Scrapes auction sites → stores in D1 listings table
- Triggers dfg-analyst for new listings

### dfg-analyst
- AI-powered analysis using Claude API (Anthropic)
- Category-specific prompts and market data:
  - Power Tools: `prompts-power-tools.ts`, `analysis-power-tools.ts`
  - Vehicles: `prompts-vehicles.ts`, `analysis-vehicles.ts`
  - Trailers: `prompts.ts`, `analysis.ts` (default)
- Test suites: `npm run test` (acquisition), `npm run test:full`
- Uses R2 for photo storage and snapshot immutability

### dfg-relay
- GitHub issue creation for opportunity notifications
- Integrates with dfg-api webhook events

## Testing

### Vitest
```typescript
import { describe, it, expect } from 'vitest'

describe('calculateProfit', () => {
  it('should calculate profit correctly', () => {
    const profit = calculateProfit(1000, 800)
    expect(profit).toBe(200)
  })
})
```

### Local Development
```bash
# Start local dev server with D1 local database
npx wrangler dev

# Test scheduled triggers
npx wrangler dev --test-scheduled

# Tail production logs
npx wrangler tail
```

## Environment Variables

Defined in `wrangler.toml`:
```toml
[vars]
ENVIRONMENT = "production"

[[d1_databases]]
binding = "DB"
database_name = "dfg-production"
database_id = "..."

[[r2_buckets]]
binding = "R2_BUCKET"
bucket_name = "dfg-storage"
```

Secrets (not in source control):
```bash
npx wrangler secret put CLAUDE_API_KEY
npx wrangler secret put GITHUB_TOKEN
```

## Security

- No `Access-Control-Allow-Origin: *` in production
- No exposed `/debug/*` or `/test/*` endpoints without auth
- Validate all input at API boundaries
- Use prepared statements for all SQL queries
- R2 snapshots must be immutable (new key per snapshot)

## Deployment

```bash
# Deploy to production
npx wrangler deploy

# Deploy with migrations
npm run db:migrate && npx wrangler deploy

# Check deployment
npx wrangler tail --format pretty
```

## Common Pitfalls

1. **Forgetting `.bind()` in SQL queries** → SQL injection risk
2. **Using `console.log()` without checking production** → Logs are expensive
3. **Not handling D1 errors** → Silent failures
4. **Hardcoding environment values** → Use `env` bindings
5. **Mutable R2 keys** → Always generate unique keys for new data
