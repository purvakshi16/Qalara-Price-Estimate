# Qalara Price Estimate

Backend-supported Vercel app for estimating current market selling prices in the UK, US, and EU from comparable product sources.

## Current MVP

- Product input: name, description, material, image upload, region
- Region-based currency assumption: GBP, USD, EUR
- TinyFish-backed `/api/search-products` route for live product discovery
- Search target: visit up to 15 candidate links, estimate from up to 10 priced products, display 6 source rows
- Candidate source list with marketplace, seller, retail price, product page link, source product image, and evidence-backed MOQ details where found
- Accept/reject workflow for comparable listings
- Estimated range, median single estimate, average, and confidence
- Print-to-PDF export
- Excel-compatible CSV export

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

Add `TINYFISH_API_KEY` as a Vercel environment variable before deploying.

## Notes

- Amazon is included only when a similar Amazon product naturally appears in search results. The app does not use Amazon credentials.
- The uploaded image is captured in the frontend, but true Google-Lens-style image search still needs a public temporary image URL or a supported TinyFish image-upload flow so the external browser agent can access the image itself.
