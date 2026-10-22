# Market Price Estimator Search Logic

Last updated: 22 October 2026

This is the canonical implementation rulebook for the production application. It records the small validation decisions as well as the full search flow. Update this file whenever search behavior, thresholds, providers, interface fields or output rules change.

## 1 Input Contract

- Product name is optional when an image is supplied. When entered, it must contain non-whitespace text.
- One JPEG, PNG or WebP image is optional when a product name is supplied. The current upload limit is 2 MB.
- At least one primary search input is required: product name or image. Both may be supplied together.
- Description is optional and supplies shape, design, finish, use and pack-size evidence.
- Material is optional. Comma, slash or vertical-bar separated values are treated as alternatives.
- Dimensions are optional structured length, width and height values. Unit is centimetres or inches.
- Region is required. Supported choices are United States USD, United Kingdom GBP, Europe EUR using Germany as the locale, and Australia AUD. United States USD is the default.
- The image-search provider is chosen per search. SearchAPI and SerpApi are available; only the selected provider is called, and neither is called during a product-name-only search.

## 2 Temporary Image Handling

1. When an image is selected, the browser converts it to a data URL and sends it with the form.
2. The API validates its media type.
3. The image is uploaded to the connected public Vercel Blob store because reverse-image providers need a reachable URL.
4. The Blob receipt is retained only for cleanup.
5. The temporary image is deleted in a `finally` block whether the search succeeds, fails or times out.
6. The uploaded image is never used as a result-row image. Result images must come from the matched product source or the visual-search record.

## 3 Query Construction

- The retail query combines product name, material, dimensions, the first 150 description characters, requested currency and the words `retail price`.
- Dimension text uses the entered values in length by width by height order followed by the selected unit.
- General discovery asks for direct product-detail pages and explicitly excludes homepages, seller profiles, search pages, categories, collections, filters, wholesale pages and articles.
- Marketplace discovery adds region-appropriate Amazon and eBay domains plus Etsy and Alibaba.
- The visual-search query combines product name, material, dimensions and description to help the provider interpret the uploaded image.

## 4 Discovery Providers

- The selected visual provider returns visual matches. Provider position is preserved; when absent, array order becomes the position.
- TinyFish runs one general text search and one marketplace-specific text search in parallel when a product name is supplied.
- When configured, Firecrawl runs one additional text discovery search when a product name is supplied.
- A product-name-only search skips Blob upload and visual search. An image-only search skips TinyFish and Firecrawl text discovery but still uses TinyFish, with limited Firecrawl recovery, to read candidate PDPs. Supplying both combines both candidate sets.
- SearchAPI and SerpApi are alternatives, not automatic fallbacks. This prevents an unexpected second image-search credit charge.
- TinyFish is the primary PDP reader. Firecrawl basic-proxy scraping is attempted for at most two selected pages omitted by TinyFish.
- Paid browser-agent fallback is disabled.

## 5 Candidate Admission Before Fetch

- A candidate needs an HTTP or HTTPS URL that resembles a direct retail product page.
- Marketplace candidates must match a known direct product URL pattern. Search, category, filter and collection URLs are rejected.
- Pattern, tutorial, article and other non-physical-product candidates are rejected.
- Region screening rejects obvious conflicting country domains, market terms and currencies before fetch.
- Visual candidates need a source image to qualify later as unpriced results.
- Duplicate canonical URLs are removed by comparing the URL before any fragment.

## 6 Candidate Ranking and Ordering

- Product-name token coverage contributes up to 40 ranking points.
- Description-token coverage contributes up to 15 points.
- An exact full product-name phrase contributes 10 points.
- A supplied material found in candidate text contributes 15 points.
- Supplied dimension values found in candidate text contribute up to 10 points.
- Visual candidates receive a position bonus of `20 / square root of position`.
- Ranked visual, general, marketplace and Firecrawl candidates are interleaved so one source type cannot consume every early fetch slot.
- Ranking is prioritization, not acceptance. A fetched page must still pass PDP, price and relevance validation.

## 7 Fetch Loop and Limits

- Candidates are fetched in batches of six.
- The search stops as soon as six priced PDPs are valid, all candidates are exhausted, or the backend deadline is reached.
- The backend processing budget is 85 seconds within a 120-second function allowance. The browser request ceiling is 105 seconds.
- Results return immediately when work finishes; the app does not wait for the full timeout.
- Successfully validated results are retained if a later batch times out.
- Diagnostics count visual matches returned, pages accessed and valid priced PDPs found.

## 8 PDP Validation

- The final URL must still be a direct product URL.
- A page is rejected when it contains multiple structured products and therefore behaves like a listing page.
- Product title is taken from structured product data, the page heading, fetched title or candidate title in that order.
- PLPs, homepages, search pages, collections, categories, seller profiles and filtered results are not valid PDP results.
- A visible currency somewhere on the page is not enough. Price evidence must belong to the primary product.

## 9 Priced PDP Relevance

- Product-name tokens are normalized to lowercase meaningful tokens. Generic words such as `product` and `item` are ignored.
- A one-token product name requires that token. A multi-token name requires at least 40 percent of its tokens, rounded up.
- Matching accepts exact tokens and conservative prefix variants for words of at least four characters.
- When material is supplied, every token in at least one material alternative must appear.
- Distinctive description tokens exclude colors and generic quality or style words. When distinctive tokens remain, at least one must appear.
- Color differences do not reject a result.
- This gate is textual. It does not claim a trained numerical image-similarity score.

## 10 Price Extraction

Price extraction follows this order:

1. Structured `Product` offer with the requested currency.
2. Product price metadata such as Shopify or Open Graph amount and currency.
3. Recognized primary product-price elements, preferring sale-price selectors.
4. One unambiguous currency-marked price near the product heading.

- Sale price is preferred when the PDP identifies it as the current price.
- Crossed-out original prices are excluded.
- Shipping, delivery, postage, installment, per-count and related-product prices are excluded.
- When multiple conflicting values remain and no primary price can be identified, the page is not admitted as a priced PDP.
- Currency must match the selected region. Currency conversion is not currently performed.

## 11 Unpriced Visual Result Gate

An unpriced visual row is a recovery result, not equivalent to a verified priced PDP. It is considered only after priced PDP extraction and only to fill remaining result slots up to six.

All of these conditions are required:

- The candidate is from the selected reverse-image provider.
- It has a direct product URL, title and result image.
- It is ranked within the first ten visual matches.
- For a multi-token product name, at least 60 percent of tokens must match, with a minimum of two. A one-token name must match exactly or by the conservative prefix rule.
- When material is supplied, one complete material alternative must match.
- When distinctive description tokens remain, at least 50 percent must match, capped at two required matches.
- If both the request and candidate text publish at least two dimensions, the values are converted to centimetres, sorted to tolerate orientation order and must be within 25 percent of the requested values.
- If candidate text publishes no dimensions, dimensions alone do not reject it.
- A URL already represented by a priced PDP is excluded.

Accepted unpriced rows show `Not found` for price, use the provider image, link directly to the candidate product page and never affect the Price Range. This stricter gate is intended to reject loosely related results such as a rectangular marble frame when the request specifies an arched or scalloped frame.

## 12 Product Image Logic

- For a priced PDP, image priority is structured product image, Open Graph image, a product-relevant image element and then the visual-provider source image.
- Relative image URLs are resolved against the PDP URL.
- When no valid image is available, the row displays `Not found`.
- An unpriced visual result uses the visual-provider image because the PDP image could not be verified.

## 13 Marketplace and Seller Logic

- Amazon, Etsy, eBay and Alibaba URLs receive their marketplace names.
- Other retail domains are labelled `Seller website`.
- For an independent website, seller is the published site name and falls back to the hostname.
- For a marketplace, seller is accepted only from a structured offer or marketplace-specific seller element.
- Return, refund, shipping, delivery, warranty, checkout and similar instruction text is rejected as a seller name.
- If a marketplace seller cannot be identified, the value is `Not listed`.

## 14 Result Assembly

- Priced PDPs and qualifying unpriced visual matches are combined and sorted by their internal match score.
- The internal match score is not displayed as a confidence percentage.
- Price Range uses priced PDPs only and shows the minimum and maximum in the requested currency.
- Price Range is hidden when no price was verified.
- Source Item text links directly to the product URL. There is no separate Open column.
- Table columns are Image, Source Item, PDP Price, Marketplace and Seller.
- Accept, Reject, Accept all, Reject all, Average, Median, Confidence and MOQ are not active features.

## 15 Error and Empty States

- Missing both product name and image returns a validation error before provider calls.
- No direct candidate URLs returns a specific no-links error.
- No priced or qualifying unpriced result returns a no-usable-results error and includes diagnostics.
- Provider allowance, authentication and request failures are surfaced as errors. They do not start a paid fallback.
- Timeouts return a timeout-specific message.
- While the request is running, the interface displays a loading state and disables duplicate submission.

## 16 Downloads

- Download is disabled until results exist.
- Clicking Download reveals PDF and Excel CSV options.
- CSV contains image URL, marketplace, seller, title, retail price, currency, product URL and notes.
- PDF uses the browser print flow for the current result view.
- Filenames combine the sanitized product name and selected region.

## 17 Data Retention and Paused Work

- Search inputs and results are not stored in an application database.
- Temporary uploaded images are deleted after each request.
- Wholesale research, MOQ and wholesale pricing remain paused.
- There is no model training or feedback-learning loop.
- CLIP or SigLIP embeddings are not implemented. Provider result position plus textual and dimensional evidence are the current visual-quality controls.
