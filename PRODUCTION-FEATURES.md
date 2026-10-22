# Market Price Estimator: Production Features

Last updated: 22 October 2026

This document records the functionality intended to be active in the current production application. It should be updated alongside every production-facing feature change.

## Product Search Inputs

- **Product name:** Optional when an image is supplied. Supplies the main text-search phrase.
- **Description:** Optional. Adds product characteristics such as finish, shape, use case and pack size.
- **Material:** Optional. Narrows the search to the requested material.
- **Product dimensions:** Optional structured length, width and height fields with centimetre or inch units. Enter only known finished-product dimensions.
- **Image:** Optional when a product name is supplied. Accepts one JPEG, PNG or WebP image up to 2 MB. The user chooses SearchAPI or SerpApi for the Google Lens visual-match search before submitting; SearchAPI is selected by default. Only the chosen provider is called and its candidates receive first priority.
- At least one primary input is required: product name or image. Name-only searches skip image upload and reverse-image search. Image-only searches skip general and marketplace text discovery. Supplying both combines the two discovery paths.
- The image is temporarily uploaded to public Vercel Blob storage so the visual-search provider can read it, then deleted in the API route's `finally` cleanup whether the search succeeds or fails.
- Product name, description, optional material and optional dimensions are sent alongside the image to improve visual-match relevance. Colour differences are allowed; material and dimensions only influence the search when entered.
- **Region and currency:** US - USD is the default. UK - GBP, EU - EUR (Germany) and Australia - AUD are also available.

## Retail Search

- Uses a two-stage search and validation flow. Stage one discovers and ranks direct PDP candidates using image-search position plus product name, description, material and dimensions. Stage two fetches those candidates and admits only accessible PDPs with a matching product type, an explicit material match when material was supplied, a meaningful description-detail match when available, and a defensible region-currency price. Colour differences do not block a match.
- Uses free search and page-fetch operations only. Paid browser-agent fallback is disabled.
- Runs one general retail search and one region-aware marketplace search.
- When `FIRECRAWL_API_KEY` is configured, runs one additional Firecrawl web search and merges its direct PDP candidates. TinyFish remains the primary page reader; Firecrawl uses its basic proxy to recover at most two candidate PDPs that TinyFish omits, preventing uncontrolled credit use.
- Applies no fixed candidate or marketplace-page cap. It interleaves visual, general retail and marketplace PDP candidates, fetches them in operational batches, and stops when six valid PDPs are found, all returned candidates are exhausted or the Vercel-safe execution deadline is reached.
- Marketplace discovery targets Amazon, Etsy, eBay and Alibaba using the appropriate Amazon/eBay domain for the selected region.
- Marketplace candidates must be direct product-detail URLs. Marketplace search, category, filter and collection pages are excluded.
- Candidate domains, country signals and currencies are checked against the selected US, UK, EU or Australian market before a page is fetched.
- Extracts retail price evidence in layers: structured `Product` offers, explicit product-price metadata (including Shopify Open Graph fields), recognized primary-price elements, and finally unambiguous currency-marked price text near the PDP heading. Crossed-out, shipping, related-product and conflicting prices are excluded.
- Skips pages when the required structured data or product metadata is inaccessible. Visible currency text alone is not accepted as proof of a product price.
- Rejects PLPs, homepages, seller profiles, search pages, categories, collections and filtered result pages.
- Returns the specific product-detail-page link rather than a general search-results link.
- Omits inaccessible pages and pages without an unambiguous price.
- The current visual signal is the external visual-search result position. A true numerical CLIP/SigLIP similarity score is not yet active and must not be interpreted as trained model output.

## Estimate Summary

- **Price range:** Lowest and highest retail prices across the usable PDPs returned by the search.
- **Search diagnostics:** Shows only visual matches returned, pages successfully accessed and valid product pages found.
- The browser has a 105-second request ceiling and the backend keeps an 85-second processing budget so it can return JSON before the connection deadline. Results return immediately when six valid PDPs are found or candidates are exhausted, and already validated products are preserved if a later fetch batch fails.

All usable returned products are included in the estimate. Accept, reject, Accept all and Reject all controls are not part of the production workflow.

## Source Table

Each result row contains:

1. **Image:** Image extracted from that matched product's source page. It is not the image uploaded by the user. If no usable source image is found, the row shows "Not found."
   Relevant visual-search candidates may still appear with their image and product link when no PDP price can be verified. These rows show "Not found" for price and never contribute to the Price Range. An unpriced row must be within the first ten visual results, satisfy a stronger product-name match, match supplied material and distinctive description details, and agree with supplied dimensions when its search text publishes dimensions.
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

- Wholesale seller research, MOQ and wholesale-price extraction.
- Persistent storage of searches or results.

The complete operational rules and thresholds are maintained in `SEARCH-LOGIC.md`. This feature list is the shorter production summary.
