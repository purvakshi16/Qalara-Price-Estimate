# Market Price Estimator: Production Features

Last updated: 12 October 2026

This document records the functionality intended to be active in the current production application. It should be updated alongside every production-facing feature change.

## Product Search Inputs

- **Product name:** Required. Supplies the main retail search phrase.
- **Description:** Optional. Adds product characteristics such as finish, shape, use case and pack size.
- **Material:** Optional. Narrows the search to the requested material.
- **Image:** Accepts one JPEG, PNG or WebP image up to 2 MB and displays a local preview. Reverse-image search is currently paused; the uploaded image is not yet sent to the search provider.
- **Region and currency:** US - USD is the default. UK - GBP and EU - EUR (Germany) are also available.

## Retail Search

- Uses the product name, description, material and selected region to search only for direct retail product-detail pages (PDPs).
- Uses free search and page-fetch operations only. Paid browser-agent fallback is disabled.
- Runs one general retail search and one region-aware marketplace search.
- Selects up to four general retail/seller pages and up to three recognized marketplace pages, then deduplicates and fetches no more than seven pages in total.
- Marketplace discovery targets Amazon, Etsy, eBay and Alibaba using the appropriate Amazon/eBay domain for the selected region.
- Marketplace candidates must be direct product-detail URLs. Marketplace search, category, filter and collection pages are excluded from the three reserved marketplace slots.
- Extracts retail price evidence in layers: structured `Product` offers, explicit product-price metadata (including Shopify Open Graph fields), recognized primary-price elements, and finally unambiguous currency-marked price text near the PDP heading. Crossed-out, shipping, related-product and conflicting prices are excluded.
- Skips pages when the required structured data or product metadata is inaccessible. Visible currency text alone is not accepted as proof of a product price.
- Rejects PLPs, homepages, seller profiles, search pages, categories, collections and filtered result pages.
- Returns the specific product-detail-page link rather than a general search-results link.
- Omits inaccessible pages and pages without an unambiguous price, and reports the omission reason.

## Estimate Summary

- **Price range:** Lowest and highest retail prices across the usable PDPs returned by the search.
- **Search diagnostics:** Separates general and marketplace search counts and shows direct-product candidates, selected marketplace pages, fetched pages, valid retail prices and rejected pages. Rejected-page links and reasons are listed when available.

All usable returned products are included in the estimate. Accept, reject, Accept all and Reject all controls are not part of the production workflow.

## Source Table

Each result row contains:

1. **Image:** Image extracted from that matched product's source page. It is not the image uploaded by the user. If no usable source image is found, the row shows "Not found."
2. **Source item:** Product title and price-extraction note.
3. **Marketplace:** Known platforms are labelled Amazon, eBay, Etsy or Alibaba. Independent retail domains are labelled "Seller website."
4. **Seller:** Seller name found on the product page. Shows "Not listed" when unavailable.
5. **Price:** Extracted retail price in the selected region's currency.
6. **MOQ:** Currently paused while wholesale lookup is deferred.
7. **Open:** Direct link to the matched retail product page.

## Downloads

- A single **Download** button opens the available PDF and Excel CSV options.
- The button remains disabled until search results are available.
- CSV output includes the image URL, marketplace, seller, title, retail price, currency, MOQ fields, product URL and extraction notes.
- PDF output prints the current estimate view through the browser's print-to-PDF flow.

## Interface Shape

- Form fields, buttons, download menus and result tables use rectangular edges without rounded corners.

## Currently Paused

- Reverse-image search and temporary image hosting.
- Wholesale seller research.
- Product-specific MOQ and wholesale-price extraction.
- Persistent storage of searches or results.
