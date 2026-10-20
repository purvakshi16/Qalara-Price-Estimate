# Qalara Price Estimate

Backend-supported Vercel app for estimating current market selling prices in Australia, Europe, the United States and the United Kingdom from comparable product sources.

## Current MVP

- Product input: required name and image, optional description, material and dimensions, and region.
- Region-based currency assumption: AUD, EUR, USD or GBP.
- The user chooses SearchAPI or SerpApi Google Lens for each visual search; TinyFish Search and Fetch supply text discovery and PDP content.
- Search continues until six valid PDPs are found, candidates are exhausted or the request deadline is reached.
- Source list with marketplace, seller, retail price, product-page link and source product image where accessible. Wholesale and MOQ research are paused.
- Price range and compact search diagnostics.
- Download dropdown with print-to-PDF and Excel-compatible CSV export

## Run Locally

Create `.env.local`:

```bash
TINYFISH_API_KEY=sk-tinyfish-your-key-here
SERPAPI_API_KEY=your-serpapi-key-here
SEARCHAPI_API_KEY=your-searchapi-key-here
BLOB_READ_WRITE_TOKEN=your-vercel-blob-read-write-token
```

Then run:

```bash
npm install
npm run dev
```

## Deploy on Vercel

Add `TINYFISH_API_KEY`, `SEARCHAPI_API_KEY` and `SERPAPI_API_KEY` to Vercel Production and Preview. Connect a public Vercel Blob store so `BLOB_READ_WRITE_TOKEN` is available. The form calls only the image-search provider selected by the user.

For this update, upload `app/page.tsx`, `app/api/search-products/route.ts`, `package.json`, `pnpm-lock.yaml` and `vercel.json` through GitHub, then redeploy. The package and lockfile include the HTML parser used to extract prices.

## Notes

- Amazon is included only when a similar Amazon product naturally appears in search results. The app does not use Amazon credentials.
- Search finds candidate product links; Fetch returns their page content. The app extracts explicit prices in the requested currency and skips missing or ambiguous prices. It does not invent a price or seller.
- Products without source-page images still appear after a valid image-led search.
- TinyFish publishes free allowances and rate limits for Search and Fetch. Allowance and rate-limit errors stop the request instead of triggering paid automation.
- Old Agent-run bookmarks no longer load results through this endpoint.

## Verification

`node --test tests/retail-search.cjs` runs mocked extraction and provider-routing tests (Node 22.6 or newer).

`node scripts/check-free-search.cjs` verifies a live retail search using the local key and only the Search/Fetch hosts. It does not start an Agent run.
