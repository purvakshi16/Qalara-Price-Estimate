# Qalara Price Estimate

Backend-supported Vercel app for estimating current market selling prices in the UK, US, and EU from comparable product sources.

## Current MVP

- Product input: name, description, material and region. Image matching is paused.
- Region-based currency assumption: GBP, USD, EUR
- `/api/search-products` uses TinyFish Search and Fetch only, with no paid Agent or Browser fallback
- Fetch up to two individual product pages and display available retail prices
- Source list with marketplace, listed seller, retail price, product page link and source product image where accessible. Wholesale and MOQ research are paused.
- Accept/reject workflow for comparable listings
- Estimated range, median single estimate and confidence
- Download dropdown with print-to-PDF and Excel-compatible CSV export

## Run Locally

Create `.env.local`:

```bash
TINYFISH_API_KEY=sk-tinyfish-your-key-here
```

Then run:

```bash
npm install
npm run dev
```

## Deploy on Vercel

Add `TINYFISH_API_KEY` as a Vercel environment variable before deploying. Blob storage is not required for retail-only search.

For this update, upload `app/page.tsx`, `app/api/search-products/route.ts`, `package.json`, `pnpm-lock.yaml` and `vercel.json` through GitHub, then redeploy. The package and lockfile include the HTML parser used to extract prices.

## Notes

- Amazon is included only when a similar Amazon product naturally appears in search results. The app does not use Amazon credentials.
- Search finds candidate product links; Fetch returns their page content. The app extracts explicit prices in the requested currency and skips missing or ambiguous prices. It does not invent a price or seller.
- Products without images still appear. Fetch errors and skipped-page explanations are returned with available results.
- TinyFish publishes free allowances and rate limits for Search and Fetch. Allowance and rate-limit errors stop the request instead of triggering paid automation.
- Old Agent-run bookmarks no longer load results through this endpoint.

## Verification

`node --test tests/retail-search.cjs` runs mocked extraction and provider-routing tests (Node 22.6 or newer).

`node scripts/check-free-search.cjs` verifies a live retail search using the local key and only the Search/Fetch hosts. It does not start an Agent run.
