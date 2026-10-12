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

- Uses the product name, description, material and selected region to search for direct retail product pages.
- Uses free search and page-fetch operations only. Paid browser-agent fallback is disabled.
- Checks up to two direct product pages per search in the current limited production mode.
- Extracts a retail price only when the page provides a usable price in the requested currency.
- Returns the specific product-detail-page link rather than a general search-results link.
- Omits inaccessible pages and pages without an unambiguous price, and reports the omission reason.

## Estimate Summary

- **Price range:** Lowest and highest retail prices among the usable products returned by the search.
- **Single estimate:** Median of the returned retail prices.
- **Confidence:** Based on the number of priced matches. With the current two-source limit, confidence will normally be Low.
- **Single-price details:** Expandable list showing each individual price, product title, product image, marketplace and product link.

All usable returned products are included in the estimate. Accept, reject, Accept all and Reject all controls are not part of the production workflow.

## Source Table

Each result row contains:

1. **Image:** Image extracted from that matched product's source page. It is not the image uploaded by the user. If no usable source image is found, the row shows "Not found."
2. **Source item:** Product title and price-extraction note.
3. **Marketplace:** Website or marketplace hosting the product page, such as Amazon, eBay or Etsy.
4. **Seller:** Seller name found on the product page. Shows "Not listed" when unavailable.
5. **Price:** Extracted retail price in the selected region's currency.
6. **MOQ:** Currently paused while wholesale lookup is deferred.
7. **Open:** Direct link to the matched retail product page.

## Downloads

- A single **Download** button opens the available PDF and Excel CSV options.
- The button remains disabled until search results are available.
- CSV output includes the image URL, marketplace, seller, title, retail price, currency, MOQ fields, product URL and extraction notes.
- PDF output prints the current estimate view through the browser's print-to-PDF flow.

## Currently Paused

- Reverse-image search and temporary image hosting.
- Wholesale seller research.
- Product-specific MOQ and wholesale-price extraction.
- Persistent storage of searches or results.
