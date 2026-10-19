# Market Price Estimator: Production Features

Last updated: 16 October 2026

This document records the functionality intended to be active in the current production application. It should be updated alongside every production-facing feature change.

## Product Search Inputs

- **Product name:** Required. Supplies the main retail search phrase.
- **Description:** Optional. Adds product characteristics such as finish, shape, use case and pack size.
- **Material:** Optional. Narrows the search to the requested material.
- **Product dimensions:** Optional structured length, width and height fields with centimetre or inch units. Enter only known finished-product dimensions.
- **Image:** Accepts one JPEG, PNG or WebP image up to 2 MB. When supplied, an experimental Google Lens visual-match search runs before text discovery and its candidates receive first priority.
- The image is temporarily uploaded to public Vercel Blob storage so the visual-search provider can read it, then deleted in the API route's `finally` cleanup whether the search succeeds or fails.
- Product name, description, optional material and optional dimensions are sent alongside the image to improve visual-match relevance. Colour differences are allowed; material and dimensions only influence the search when entered.
- **Region and currency:** US - USD is the default. UK - GBP and EU - EUR (Germany) are also available.

## Retail Search

- Uses a two-stage search and validation flow. Stage one discovers and ranks direct PDP candidates using image-search position plus product name, description, material and dimensions. Stage two fetches those candidates, admits only accessible PDPs with defensible region-currency prices, and reranks the valid products using the content found on each PDP.
- Uses free search and page-fetch operations only. Paid browser-agent fallback is disabled.
- Runs one general retail search and one region-aware marketplace search.
- Applies no fixed candidate or marketplace-page cap. It interleaves visual, general retail and marketplace PDP candidates, fetches them in operational batches, and stops when six valid PDPs are found, all returned candidates are exhausted or the Vercel-safe execution deadline is reached.
- Marketplace discovery targets Amazon, Etsy, eBay and Alibaba using the appropriate Amazon/eBay domain for the selected region.
- Marketplace candidates must be direct product-detail URLs. Marketplace search, category, filter and collection pages are excluded.
- Candidate domains, country signals and currencies are checked against the selected US, UK or EU market before a page is fetched.
- Extracts retail price evidence in layers: structured `Product` offers, explicit product-price metadata (including Shopify Open Graph fields), recognized primary-price elements, and finally unambiguous currency-marked price text near the PDP heading. Crossed-out, shipping, related-product and conflicting prices are excluded.
- Skips pages when the required structured data or product metadata is inaccessible. Visible currency text alone is not accepted as proof of a product price.
- Rejects PLPs, homepages, seller profiles, search pages, categories, collections and filtered result pages.
- Returns the specific product-detail-page link rather than a general search-results link.
- Omits inaccessible pages and pages without an unambiguous price.
- The current visual signal is the external visual-search result position. A true numerical CLIP/SigLIP similarity score is not yet active and must not be interpreted as trained model output.

## Estimate Summary

- **Price range:** Lowest and highest retail prices across the usable PDPs returned by the search.
- **Search diagnostics:** Shows only visual matches returned, pages successfully accessed and valid product pages found.
- The search has a two-minute request ceiling and an internal 110-second processing budget. Results return immediately when six valid PDPs are found or candidates are exhausted.

All usable returned products are included in the estimate. Accept, reject, Accept all and Reject all controls are not part of the production workflow.

## Source Table

Each result row contains:

1. **Image:** Image extracted from that matched product's source page. It is not the image uploaded by the user. If no usable source image is found, the row shows "Not found."
2. **Source item:** Product title and price-extraction note.
3. **Marketplace:** Known platforms are labelled Amazon, eBay, Etsy or Alibaba. Independent retail domains are labelled "Seller website."
4. **Seller:** Independent stores use the website's published site name, falling back to its domain. Known marketplaces use only an explicit shop or merchant identity from the PDP; policy and instruction text is rejected. Shows "Not listed" when a marketplace seller is unavailable.
5. **Price:** Extracted retail price in the selected region's currency.

The Source item title is the direct link to the matched retail product page; there is no separate Open column.

## Downloads

- A single **Download** button opens the available PDF and Excel CSV options.
- The button remains disabled until search results are available.
- CSV output includes the image URL, marketplace, seller, title, retail price, currency, product URL and extraction notes.
- PDF output prints the current estimate view through the browser's print-to-PDF flow.
- PDF and CSV filenames use the searched product name and selected region.

## Interface Shape

- Form fields, buttons, download menus and result tables use rectangular edges without rounded corners.

## Currently Paused

- Promotion of image search to the primary required field; this remains experimental while visual relevance is being improved.
- Wholesale seller research, MOQ and wholesale-price extraction.
- Persistent storage of searches or results.
