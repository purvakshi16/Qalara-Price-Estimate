import { NextResponse } from "next/server";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { load } from "cheerio";
import { deleteReference, uploadReference } from "../../../lib/temporary-images";

type Region = "UK" | "US" | "EU" | "AU";
type ImageSearchProvider = "searchapi" | "serpapi";
type Dimensions = { length?: string; width?: string; height?: string; unit?: "cm" | "in" };
type SearchRequest = { productName: string; description?: string; material?: string; dimensions?: Dimensions; region: Region; stage?: string; imageDataUrl?: string; imageSearchProvider?: ImageSearchProvider };
type RecordValue = Record<string, unknown>;
type ProductResult = {
  title: string; price: number | null; currency: string; seller: string; marketplace: string;
  productUrl: string; imageUrl: string; notes: string;
  minPrice: number | null; maxPrice: number | null; pageType: "PDP" | "Visual match";
  matchScore: number;
};
const regions = {
  US: { currency: "USD", location: "US", language: "en", market: "United States", marketplaceDomains: ["amazon.com", "etsy.com", "ebay.com", "alibaba.com"] },
  UK: { currency: "GBP", location: "GB", language: "en", market: "United Kingdom", marketplaceDomains: ["amazon.co.uk", "etsy.com", "ebay.co.uk", "alibaba.com"] },
  EU: { currency: "EUR", location: "DE", language: "de", market: "Germany", marketplaceDomains: ["amazon.de", "etsy.com", "ebay.de", "alibaba.com"] },
  AU: { currency: "AUD", location: "AU", language: "en", market: "Australia", marketplaceDomains: ["amazon.com.au", "etsy.com", "ebay.com.au", "alibaba.com"] },
};
const TARGET_VALID_PDPS = 6;
const FETCH_BATCH_SIZE = 6;
const FIRECRAWL_FETCH_FALLBACK_LIMIT = 2;
const SEARCH_BUDGET_MS = 85_000;
export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(request: Request) {
  let cleanupReceipt = "";
  try {
    const deadline = Date.now() + SEARCH_BUDGET_MS;
    const input = await request.json() as SearchRequest;
    if (input.stage === "wholesale") return NextResponse.json({ error: "Wholesale lookup is paused." }, { status: 400 });
    input.productName = text(input.productName);
    const imageDataUrl = text(input.imageDataUrl);
    const hasImage = Boolean(imageDataUrl);
    if (!input.productName && !hasImage) return NextResponse.json({ error: "Enter a product name or upload a product image." }, { status: 400 });
    if (hasImage && !/^data:image\/(?:jpeg|png|webp);base64,/i.test(imageDataUrl)) {
      return NextResponse.json({ error: "The product image must be JPEG, PNG or WebP." }, { status: 400 });
    }
    const config = regions[input.region] ?? regions.US;
    const apiKey = getApiKey();
    if (!apiKey) throw new Error("Set TINYFISH_API_KEY in the project's environment variables.");
    const firecrawlKey = getFirecrawlKey();
    const signal = AbortSignal.timeout(SEARCH_BUDGET_MS);
    const dimensionQuery = dimensionText(input.dimensions);
    const query = [input.productName.trim(), input.material?.trim(), dimensionQuery, input.description?.trim().slice(0, 150), config.currency, "retail price"].filter(Boolean).join(" ");
    let visualSearch: RecordValue = {};
    if (hasImage) {
      const uploaded = await uploadReference(imageDataUrl);
      cleanupReceipt = uploaded.receipt;
      visualSearch = await visualSearchJson(uploaded.url, input, dimensionQuery, config, signal);
    }
    const generalParams = new URLSearchParams({ query: `${query} product detail`, location: config.location, language: config.language,
      purpose: `Find direct retail product-detail pages for ${input.productName} sold in ${config.market}. Exclude homepages, seller profiles, search pages, categories, collections, filters, wholesale pages and articles.`,
    });
    const marketplaceQuery = `${query} product detail (${config.marketplaceDomains.map((domain) => `site:${domain}`).join(" OR ")})`;
    const marketplaceParams = new URLSearchParams({ query: marketplaceQuery, location: config.location, language: config.language,
      purpose: `Find direct product-detail pages for ${input.productName} on Amazon, Etsy, eBay or Alibaba in ${config.market}. Exclude marketplace search, category, filter and collection pages.`,
    });
    const hasProductName = Boolean(input.productName);
    const [generalSearch, marketplaceSearch, firecrawlSearch] = await Promise.all([
      hasProductName ? providerJson(`https://api.search.tinyfish.ai?${generalParams}`, apiKey, signal) : Promise.resolve({}),
      hasProductName ? providerJson(`https://api.search.tinyfish.ai?${marketplaceParams}`, apiKey, signal) : Promise.resolve({}),
      hasProductName && firecrawlKey ? firecrawlSearchJson(query, config, firecrawlKey, signal).catch((error) => {
        console.warn("Firecrawl discovery was skipped after an error", safeError(error));
        return {};
      }) : Promise.resolve({}),
    ]);
    const visualCandidates = records(visualSearch.visual_matches).map((row, index) => ({ ...row, url: text(row.link), visualMatch: true,
      position: positiveNumber(row.position) ?? index + 1, sourceImage: visualResultImage(row) }))
      .filter((row) => isDirectProductUrl(text(row.url)) && !isNonPhysicalCandidate(text(asRecord(row).title))
        && isRegionCandidate(row, input.region, config.currency));
    const generalCandidates = rankedCandidates(generalSearch)
      .filter((row) => !isMarketplaceUrl(text(row.url)) && isDirectProductUrl(text(row.url)) && isRegionCandidate(row, input.region, config.currency));
    const marketplaceCandidates = rankedCandidates(marketplaceSearch)
      .filter((row) => isMarketplaceProductUrl(text(row.url)) && isRegionCandidate(row, input.region, config.currency));
    const firecrawlCandidates = rankedCandidates(firecrawlSearch)
      .filter((row) => isDirectProductUrl(text(row.url)) && isRegionCandidate(row, input.region, config.currency));
    const unique = interleaveCandidates([
      rankByAttributes(visualCandidates, input),
      rankByAttributes(generalCandidates, input),
      rankByAttributes(marketplaceCandidates, input),
      rankByAttributes(firecrawlCandidates, input),
    ]);
    if (!unique.length) return NextResponse.json({ error: "No direct retail product links were found. Try a more specific product name." }, { status: 422 });
    const products: ProductResult[] = [];
    let pagesAccessed = 0;
    let firecrawlFallbacks = 0;
    let cursor = 0;
    while (products.length < TARGET_VALID_PDPS && cursor < unique.length && Date.now() < deadline - 4_000) {
      const batch = unique.slice(cursor, cursor + FETCH_BATCH_SIZE);
      cursor += batch.length;
      let fetched: RecordValue;
      try {
        fetched = await providerJson("https://api.fetch.tinyfish.ai", apiKey, signal, {
          urls: batch.map((row) => text(row.url)), format: "html", image_links: true, ttl: 0, per_url_timeout_ms: 15_000,
          purpose: "Read the main retail product's current price, currency, product image and listed seller. Do not research wholesale.",
        });
      } catch (error) {
        if (firecrawlKey && !(error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name))) {
          console.warn("TinyFish fetch failed; trying limited Firecrawl recovery", safeError(error));
          fetched = { results: [] };
        } else if (products.length || (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name))) break;
        else throw error;
      }
      const fetchedPages = records(fetched.results);
      pagesAccessed += fetchedPages.length;
      for (const page of fetchedPages) {
        const candidate = batch.find((row) => text(row.url) === text(page.url));
        if (!candidate) continue;
        const product = extractProduct(page, candidate, config.currency, input);
        if (product) products.push(product);
        if (products.length === TARGET_VALID_PDPS) break;
      }
      if (firecrawlKey && products.length < TARGET_VALID_PDPS && firecrawlFallbacks < FIRECRAWL_FETCH_FALLBACK_LIMIT) {
        const returnedUrls = new Set(fetchedPages.flatMap((page) => [text(page.url), text(page.final_url)]).filter(Boolean));
        const missing = batch.filter((candidate) => !returnedUrls.has(text(candidate.url)));
        for (const candidate of missing) {
          if (firecrawlFallbacks >= FIRECRAWL_FETCH_FALLBACK_LIMIT || products.length >= TARGET_VALID_PDPS || Date.now() >= deadline - 4_000) break;
          firecrawlFallbacks += 1;
          const page = await firecrawlScrapePage(text(candidate.url), firecrawlKey, signal).catch((error) => {
            console.warn("Firecrawl PDP recovery failed", safeError(error));
            return null;
          });
          if (!page) continue;
          pagesAccessed += 1;
          const product = extractProduct(page, candidate, config.currency, input);
          if (product) products.push(product);
        }
      }
    }
    const searched = {
      visualMatchesReturned: records(visualSearch.visual_matches).length,
      pagesAccessed,
      validPagesFound: products.length,
    };
    const pricedUrls = new Set(products.map((product) => product.productUrl.split("#")[0]));
    const unpricedMatches = rankByAttributes(visualCandidates, input)
      .filter((candidate) => !pricedUrls.has(text((candidate as RecordValue).url).split("#")[0]))
      .map((candidate) => unpricedVisualMatch(candidate, config.currency, input))
      .filter((product): product is ProductResult => product !== null)
      .slice(0, Math.max(0, TARGET_VALID_PDPS - products.length));
    if (!products.length && !unpricedMatches.length) return NextResponse.json({ error: "The product pages were checked, but no usable retail prices or relevant visual product links were accessible. No paid Agent fallback was used.", searched }, { status: 422 });
    const displayProducts = [...products, ...unpricedMatches]
      .sort((a, b) => b.matchScore - a.matchScore)
      .map(({ matchScore: _matchScore, ...product }) => product);
    return NextResponse.json({
      currency: config.currency, displayProducts, searched,
    });
  } catch (error) {
    console.error("Retail search request failed", error instanceof Error ? { name: error.name, message: error.message } : { message: "Unknown error" });
    const timedOut = error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name);
    return NextResponse.json({ error: timedOut ? "The free search or page fetch timed out. No paid Agent was started." : error instanceof Error ? error.message : "Retail search failed." }, { status: 502 });
  } finally {
    if (cleanupReceipt) await deleteReference(cleanupReceipt).catch(() => undefined);
  }
}

export async function GET() {
  return NextResponse.json({ error: "This app now uses Search and Fetch. Start a retail search from the form." }, { status: 410 });
}

function getApiKey() {
  if (process.env.TINYFISH_API_KEY) return process.env.TINYFISH_API_KEY.trim();
  const path = join(process.cwd(), "API keys.txt");
  if (!existsSync(path)) return "";
  const content = readFileSync(path, "utf8");
  return content.match(/TINYFISH_API_KEY\s*=\s*["']?([^\s"']+)/)?.[1] ?? content.match(/sk-tinyfish-[A-Za-z0-9_-]+/)?.[0] ?? "";
}

function getSearchApiKey() {
  if (process.env.SEARCHAPI_API_KEY) return process.env.SEARCHAPI_API_KEY.trim();
  const path = join(process.cwd(), "API keys.txt");
  if (!existsSync(path)) return "";
  const content = readFileSync(path, "utf8");
  return content.match(/SEARCHAPI_API_KEY\s*=\s*["']?([^\s"']+)/)?.[1] ?? "";
}

function getSerpApiKey() {
  if (process.env.SERPAPI_API_KEY) return process.env.SERPAPI_API_KEY.trim();
  const path = join(process.cwd(), "API keys.txt");
  if (!existsSync(path)) return "";
  const content = readFileSync(path, "utf8");
  return content.match(/SERPAPI_API_KEY\s*=\s*["']?([^\s"']+)/)?.[1] ?? "";
}

function getFirecrawlKey() {
  if (process.env.FIRECRAWL_API_KEY) return process.env.FIRECRAWL_API_KEY.trim();
  const path = join(process.cwd(), "API keys.txt");
  if (!existsSync(path)) return "";
  const content = readFileSync(path, "utf8");
  return content.match(/FIRECRAWL_API_KEY\s*=\s*["']?([^\s"']+)/)?.[1] ?? "";
}

function imageSearchProvider(input: SearchRequest): ImageSearchProvider {
  if (input.imageSearchProvider === "searchapi" || input.imageSearchProvider === "serpapi") return input.imageSearchProvider;
  return process.env.IMAGE_SEARCH_PROVIDER?.trim().toLowerCase() === "searchapi" ? "searchapi" : "serpapi";
}

async function visualSearchJson(imageUrl: string, input: SearchRequest, dimensionQuery: string,
  config: (typeof regions)[keyof typeof regions], signal: AbortSignal) {
  const query = [input.productName.trim(), input.material?.trim(), dimensionQuery,
    input.description?.trim().slice(0, 100), config.market, config.currency].filter(Boolean).join(" ");
  if (imageSearchProvider(input) === "searchapi") {
    const key = getSearchApiKey();
    if (!key) throw new Error("Set SEARCHAPI_API_KEY in the project's environment variables to use SearchAPI image search.");
    const params = new URLSearchParams({ engine: "google_lens", search_type: "visual_matches", url: imageUrl,
      q: query, country: config.location, hl: config.language });
    return searchApiJson(`https://www.searchapi.io/api/v1/search?${params}`, key, signal);
  }
  const key = getSerpApiKey();
  if (!key) throw new Error("Set SERPAPI_API_KEY in the project's environment variables to use image search.");
  const params = new URLSearchParams({ engine: "google_lens", type: "visual_matches", url: imageUrl,
    q: query, country: config.location.toLowerCase(), hl: config.language, api_key: key });
  return serpApiJson(`https://serpapi.com/search.json?${params}`, signal);
}

async function serpApiJson(url: string, signal: AbortSignal): Promise<RecordValue> {
  const response = await fetch(url, { signal, cache: "no-store" });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new Error("SerpApi rejected SERPAPI_API_KEY.");
    if (response.status === 429) throw new Error("SerpApi's free image-search allowance or rate limit was reached.");
    throw new Error(`SerpApi image search returned HTTP ${response.status}.`);
  }
  try {
    const payload = JSON.parse(await response.text()) as RecordValue;
    if (text(payload.error)) throw new Error(`SerpApi image search failed: ${text(payload.error)}`);
    return payload;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("SerpApi image search failed:")) throw error;
    throw new Error("SerpApi returned an unreadable image-search response.");
  }
}

async function searchApiJson(url: string, key: string, signal: AbortSignal): Promise<RecordValue> {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${key}` }, signal, cache: "no-store" });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new Error("SearchApi rejected SEARCHAPI_API_KEY.");
    if (response.status === 429) throw new Error("SearchApi's free image-search allowance or rate limit was reached.");
    throw new Error(`SearchApi image search returned HTTP ${response.status}.`);
  }
  try { return JSON.parse(await response.text()) as RecordValue; }
  catch { throw new Error("SearchApi returned an unreadable image-search response."); }
}

function visualResultImage(row: RecordValue) {
  return text(row.image) || text(asRecord(row.image).link) || text(row.thumbnail);
}

async function providerJson(url: string, key: string, signal: AbortSignal, body?: RecordValue): Promise<RecordValue> {
  // Provider hosts stay fixed; errors never fall back to Agent or Browser.
  const response = await fetch(url, {
    method: body ? "POST" : "GET", headers: { "X-API-Key": key, ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal, cache: "no-store",
  });
  if (!response.ok) {
    if (response.status === 429) throw new Error("TinyFish's free API rate limit was reached. Wait before searching again.");
    if (response.status === 402) throw new Error("TinyFish's free allowance is exhausted. Wait for its reset; no paid fallback will run.");
    if (response.status === 401) throw new Error("TinyFish rejected the API key. Check TINYFISH_API_KEY in Vercel.");
    throw new Error(`TinyFish ${new URL(url).hostname.startsWith("api.search") ? "Search" : "Fetch"} returned HTTP ${response.status}.`);
  }
  try { return JSON.parse(await response.text()) as RecordValue; }
  catch { throw new Error("TinyFish returned an unreadable response. No paid fallback was used."); }
}

async function firecrawlSearchJson(query: string, config: (typeof regions)[keyof typeof regions], key: string, signal: AbortSignal): Promise<RecordValue> {
  const payload = await firecrawlJson("https://api.firecrawl.dev/v2/search", key, signal, {
    query: `${query} ${config.market} direct product page`, limit: 10, sources: [{ type: "web" }],
  });
  const data = asRecord(payload.data);
  const web = records(data.web).length ? records(data.web) : records(payload.data);
  return { results: web.map((row) => ({ ...row, url: text(row.url), snippet: text(row.description) })) };
}

async function firecrawlScrapePage(url: string, key: string, signal: AbortSignal): Promise<RecordValue | null> {
  const payload = await firecrawlJson("https://api.firecrawl.dev/v2/scrape", key, signal, {
    url, formats: ["html"], onlyMainContent: false, proxy: "basic", timeout: 15_000,
  });
  const data = asRecord(payload.data);
  const html = text(data.html);
  if (!html) return null;
  const metadata = asRecord(data.metadata);
  return { url, final_url: text(metadata.sourceURL) || text(metadata.url) || url, title: text(metadata.title), text: html };
}

async function firecrawlJson(url: string, key: string, signal: AbortSignal, body: RecordValue): Promise<RecordValue> {
  const response = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body), signal, cache: "no-store" });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new Error("Firecrawl rejected FIRECRAWL_API_KEY.");
    if ([402, 429].includes(response.status)) throw new Error("Firecrawl's free allowance or rate limit was reached.");
    throw new Error(`Firecrawl returned HTTP ${response.status}.`);
  }
  const payload = JSON.parse(await response.text()) as RecordValue;
  if (payload.success === false) throw new Error(text(payload.error) || "Firecrawl request failed.");
  return payload;
}

function safeError(error: unknown) {
  return error instanceof Error ? { name: error.name, message: error.message } : { message: "Unknown error" };
}

function extractProduct(page: RecordValue, candidate: RecordValue, currency: string, input: SearchRequest): ProductResult | null {
  const url = text(page.final_url) || text(page.url);
  if (candidate.visualMatch === true ? !isRetailCandidateUrl(url) : !isDirectProductUrl(url)) return null;
  const $ = load(text(page.text));
  const heading = $("h1").first().text().trim();
  const title = heading || text(page.title) || text(candidate.title);
  const marketplaceName = marketplace(url);
  if (isNonPhysicalProductPage(title, $)) return null;
  const structuredProducts: RecordValue[] = [];
  for (const element of $('script[type="application/ld+json"]').toArray()) {
    let json: unknown;
    try { json = JSON.parse($(element).text()); } catch { continue; }
    structuredProducts.push(...schemaProducts(json));
  }
  let price: number | null = null;
  let seller = "Not listed";
  let imageUrl = "";
  let evidence = "";
  const pricedProducts = structuredProducts.flatMap((product) => {
    const offers = Array.isArray(product.offers) ? records(product.offers) : records([product.offers]);
    const valid = offers.filter((offer) => text(offer.priceCurrency).toUpperCase() === currency && amount(offer.price) !== null);
    return valid.map((offer) => ({ product, offer, price: amount(offer.price) as number }));
  });
  const structuredPrices = [...new Set(pricedProducts.map((entry) => entry.price))];
  const structuredIdentities = [...new Set(pricedProducts.map((entry) => productIdentity(entry.product, url)).filter(Boolean))];
  if (structuredPrices.length === 1 && structuredIdentities.length <= 1) {
    const selected = pricedProducts[0];
    price = selected.price;
    const sellerRecord = selected.offer.seller;
    seller = typeof sellerRecord === "string" ? sellerRecord : text(asRecord(sellerRecord).name) || "Not listed";
    const image = Array.isArray(selected.product.image) ? selected.product.image[0] : selected.product.image;
    imageUrl = resolveUrl(typeof image === "string" ? image : text(asRecord(image).url), url);
    evidence = "Price from the product's listed offer.";
  }
  if (price === null) {
    const metaCurrency = $("meta[property='product:price:currency'], meta[property='og:price:currency'], meta[itemprop='priceCurrency']").first().attr("content");
    if (metaCurrency?.toUpperCase() === currency) {
      price = amount($("meta[property='product:price:amount'], meta[property='og:price:amount'], meta[itemprop='price']").first().attr("content"));
      if (price !== null) evidence = "Price from product page metadata.";
    }
  }
  if (price === null) {
    price = visiblePdpPrice($, currency);
    if (price !== null) evidence = "Price from the product page's primary price element.";
  }
  if (price === null) {
    price = primaryPdpTextPrice($, heading, currency);
    if (price !== null) evidence = "Price from the product's primary PDP text.";
  }
  if (price === null) return null;
  $("script,style,nav,header,footer,aside,del,s,[aria-hidden='true']").remove();
  $("p,div,section,h1,h2,h3,li,br").before("\n").after("\n");
  const lines = $.root().text().split(/\n+/).map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean);
  const start = heading ? lines.findIndex((line) => line === heading) : 0;
  const primary = lines.slice(Math.max(0, start), Math.max(0, start) + 100);
  const stop = primary.findIndex((line) => /you may also|related products|recommended products|customers also|recently viewed/i.test(line));
  const content = (stop >= 0 ? primary.slice(0, stop) : primary).join("\n").slice(0, 5000);
  if (!passesPdpRelevance(title, content, input)) return null;
  seller = resolveSeller($, url, marketplaceName, seller, content);
  if (!imageUrl) {
    imageUrl = resolveUrl($("meta[property='og:image']").first().attr("content") || "", url);
    if (!imageUrl) {
      const terms = title.toLowerCase().split(/\W+/).filter((word) => word.length > 3);
      const image = $("img").toArray().find((element) => terms.some((term) => ($(element).attr("alt") || "").toLowerCase().includes(term)));
      if (image) imageUrl = resolveUrl($(image).attr("src") || "", url);
    }
    if (!imageUrl) imageUrl = text(candidate.sourceImage);
  }
  const matchScore = candidateAttributeScore({ ...candidate, title, description: content }, input);
  return { title, price, minPrice: price, maxPrice: price, currency, seller, marketplace: marketplaceName, productUrl: url, imageUrl, pageType: "PDP", notes: evidence, matchScore };
}

function unpricedVisualMatch(candidate: RecordValue, currency: string, input: SearchRequest): ProductResult | null {
  const productUrl = text(candidate.url);
  const title = text(candidate.title);
  const imageUrl = text(candidate.sourceImage);
  const description = [candidate.snippet, candidate.description].map(text).filter(Boolean).join(" ");
  if (!productUrl || !title || !imageUrl || !passesUnpricedVisualRelevance(candidate, input)) return null;
  const marketplaceName = marketplace(productUrl);
  let seller = "Not listed";
  if (marketplaceName === "Seller website") {
    try { seller = new URL(productUrl).hostname.replace(/^www\./, ""); } catch { seller = "Not listed"; }
  }
  return {
    title, price: null, minPrice: null, maxPrice: null, currency, seller, marketplace: marketplaceName,
    productUrl, imageUrl, pageType: "Visual match", notes: "Visual match. PDP price was not verified.",
    matchScore: candidateAttributeScore(candidate, input),
  };
}

function passesUnpricedVisualRelevance(candidate: RecordValue, input: SearchRequest) {
  const position = positiveNumber(candidate.position);
  if (position === null || position > 10) return false;

  const haystack = [candidate.title, candidate.snippet, candidate.description].map(text).filter(Boolean).join(" ");
  const pageTokens = meaningfulTokens(haystack);
  const nameTokens = meaningfulTokens(input.productName);
  const matchedNameTokens = nameTokens.filter((token) => tokenMatch(token, pageTokens)).length;
  const minimumNameMatches = nameTokens.length <= 1 ? nameTokens.length : Math.max(2, Math.ceil(nameTokens.length * 0.6));
  if (matchedNameTokens < minimumNameMatches) return false;

  const materialOptions = (input.material ?? "").split(/[,/|]+/)
    .map((value) => meaningfulTokens(value)).filter((tokens) => tokens.length);
  if (materialOptions.length && !materialOptions.some((option) => option.every((token) => tokenMatch(token, pageTokens)))) return false;

  const excluded = new Set([...nameTokens, ...materialOptions.flat()]);
  const descriptionTokens = meaningfulDescriptionTokens(input.description ?? "").filter((token) => !excluded.has(token));
  const matchedDescriptionTokens = descriptionTokens.filter((token) => tokenMatch(token, pageTokens)).length;
  const minimumDescriptionMatches = descriptionTokens.length ? Math.min(2, Math.ceil(descriptionTokens.length * 0.5)) : 0;
  if (matchedDescriptionTokens < minimumDescriptionMatches) return false;

  return dimensionsAreCompatible(haystack, input.dimensions);
}

function dimensionsAreCompatible(value: string, dimensions?: Dimensions) {
  const requested = [dimensions?.length, dimensions?.width, dimensions?.height]
    .map((entry) => positiveNumber(entry)).filter((entry): entry is number => entry !== null);
  if (requested.length < 2) return true;
  const published = [...value.matchAll(/(\d+(?:\.\d+)?)\s*(?:x|×|by)\s*(\d+(?:\.\d+)?)(?:\s*(?:x|×|by)\s*(\d+(?:\.\d+)?))?\s*(cm|centimet(?:er|re)s?|in|inch(?:es)?|\")/gi)];
  if (!published.length) return true;
  return published.some((match) => {
    const factor = /^cm|centimet/i.test(match[4]) ? 1 : 2.54;
    const actual = [match[1], match[2], match[3]].filter(Boolean).map((entry) => Number(entry) * factor).sort((a, b) => a - b);
    const expectedFactor = dimensions?.unit === "in" ? 2.54 : 1;
    const expected = requested.map((entry) => entry * expectedFactor).sort((a, b) => a - b);
    const comparisons = Math.min(actual.length, expected.length);
    return comparisons >= 2 && actual.slice(0, comparisons).every((entry, index) => Math.abs(entry - expected[index]) / Math.max(expected[index], 1) <= 0.25);
  });
}

function positiveNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(text(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function resolveSeller($: ReturnType<typeof load>, url: string, marketplaceName: string, current: string, content: string) {
  const structuredSeller = validSellerName(current);
  if (structuredSeller) return structuredSeller;
  if (marketplaceName === "Seller website") return websiteName($, url);
  const selectors: Record<string, string[]> = {
    Etsy: ['a[href*="/shop/"]'],
    Amazon: ["#sellerProfileTriggerId", "#merchant-info a", ".tabular-buybox-text a"],
    eBay: ['.ux-seller-section__item--seller a', '[data-testid*="seller"] a'],
    Alibaba: ['[class*="supplier"] a', '[class*="company"] a'],
  };
  const candidates = (selectors[marketplaceName] ?? []).flatMap((selector) =>
    $(selector).toArray().map((element) => $(element).text().replace(/\s+/g, " ").trim()));
  const explicit = content.match(/(?:sold|dispatched|ships?)\s+by\s*[:\-]?\s*([^\n|]{2,80})/i)?.[1] ?? "";
  return [...candidates, explicit].map(validSellerName).find(Boolean) || "Not listed";
}

function websiteName($: ReturnType<typeof load>, url: string) {
  const candidates = [
    $("meta[property='og:site_name']").first().attr("content") ?? "",
    $("meta[name='application-name']").first().attr("content") ?? "",
  ];
  const named = candidates.map(validSellerName).find(Boolean);
  if (named) return named;
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ""); }
  catch { return "Not listed"; }
}

function validSellerName(value: string) {
  const name = value.replace(/\s+/g, " ").trim().replace(/^[\s:|,\-]+|[\s:|,\-]+$/g, "");
  if (!name || name === "Not listed" || name.length < 2 || name.length > 80) return "";
  if (/\b(?:accept|return|refund|delivery|shipping|dispatch|policy|instruction|condition|quantity|warranty|payment|checkout|basket|cart)\b/i.test(name)) return "";
  return name;
}

function amount(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : null;
  if (typeof value !== "string" || !/^\d+(?:[.,]\d+)*$/.test(value.trim())) return null;
  const raw = value.trim();
  const separator = Math.max(raw.lastIndexOf("."), raw.lastIndexOf(","));
  const normalized = separator >= 0 && raw.length - separator - 1 <= 2
    ? raw.slice(0, separator).replace(/[.,]/g, "") + "." + raw.slice(separator + 1) : raw.replace(/[.,]/g, "");
  const price = Number(normalized);
  return Number.isFinite(price) && price > 0 ? price : null;
}
function visiblePdpPrice($: ReturnType<typeof load>, currency: string): number | null {
  const selectors = [
    "[data-product-price]", "[data-product-price-final]", "[itemprop='offers'] [itemprop='price']",
    ".price-item--sale", ".price__sale .price-item", ".price-item--regular", ".price__regular .price-item",
    ".product__price", ".product-price", "#price_inside_buybox", "#priceblock_ourprice", "#priceblock_dealprice",
    "#corePrice_feature_div .a-price .a-offscreen", ".x-price-primary .ux-textspans",
  ];
  for (const selector of selectors) {
    const prices = $(selector).toArray().filter((element) => {
      const ancestry = $(element).parents().addBack().map((_, node) => `${$(node).attr("id") ?? ""} ${$(node).attr("class") ?? ""}`).get().join(" ");
      return !$(element).is("del,s") && !$(element).parents("del,s,nav,footer,aside").length
        && !/(?:related|recommend|recently|also-like|card--product|product-card)/i.test(ancestry);
    }).flatMap((element) => currencyAmounts($(element).attr("content") || $(element).text(), currency));
    const unique = [...new Set(prices)];
    if (unique.length === 1) return unique[0];
  }
  return null;
}
function primaryPdpTextPrice($: ReturnType<typeof load>, heading: string, currency: string): number | null {
  const copy = load($.html());
  copy("script,style,nav,header,footer,aside,del,s,[aria-hidden='true']").remove();
  copy("[class*='related'],[id*='related'],[class*='recommend'],[id*='recommend'],[class*='recently'],[id*='recently'],.product-card,.card--product").remove();
  copy("p,div,section,h1,h2,h3,li,br").before("\n").after("\n");
  const lines = copy.root().text().split(/\n+/).map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean);
  const start = heading ? Math.max(0, lines.findIndex((line) => line === heading)) : 0;
  const primary = lines.slice(start, start + 60);
  const stop = primary.findIndex((line) => /you may also|related products|recommended products|customers also|recently viewed/i.test(line));
  const productLines = (stop >= 0 ? primary.slice(0, stop) : primary)
    .filter((line) => !/shipping|delivery|postage|per count|per item|\/\s*(?:count|item|kg|metre)/i.test(line));
  const prices = productLines.flatMap((line) => currencyAmounts(line, currency));
  const unique = [...new Set(prices)];
  if (unique.length === 1) return unique[0];
  const primaryOffer = productLines.slice(0, 20).join(" ");
  const primaryPrices = [...new Set(currencyAmounts(primaryOffer, currency))];
  if (primaryPrices.length === 2 && /\b(?:sale|regular|original|was|now|buy from)\b/i.test(primaryOffer)) {
    return Math.min(...primaryPrices);
  }
  return null;
}
function currencyAmounts(value: string, currency: string): number[] {
  const explicitCodes = value.toUpperCase().match(/\b(?:USD|EUR|GBP|CAD|AUD|INR)\b/g) ?? [];
  if (explicitCodes.some((code) => code !== currency)) return [];
  const token = currency === "USD" ? "(?:US\\$|\\$|USD)"
    : currency === "EUR" ? "(?:€|EUR)"
      : currency === "AUD" ? "(?:AU\\$|A\\$|AUD)"
        : "(?:£|GBP)";
  const matches = [
    ...value.matchAll(new RegExp(`${token}\\s*([0-9]+(?:[.,][0-9]{1,2})?)`, "gi")),
    ...value.matchAll(new RegExp(`([0-9]+(?:[.,][0-9]{1,2})?)\\s*${token}`, "gi")),
  ];
  return matches.map((match) => amount(match[1])).filter((price): price is number => price !== null);
}
function schemaProducts(value: unknown): RecordValue[] {
  if (Array.isArray(value)) return value.flatMap(schemaProducts);
  const record = asRecord(value);
  const types = Array.isArray(record["@type"]) ? record["@type"] : [record["@type"]];
  if (types.includes("Product")) return [record];
  return schemaProducts(record["@graph"] ?? []);
}
function productIdentity(product: RecordValue, pageUrl: string) {
  const id = text(product["@id"]).replace(/#.*$/, "");
  const productUrl = text(product.url).replace(/#.*$/, "");
  const name = text(product.name).toLowerCase().replace(/\s+/g, " ");
  const canonical = pageUrl.replace(/[?#].*$/, "");
  if (id && id !== canonical) return id;
  if (productUrl && productUrl !== canonical) return productUrl;
  return name;
}
function text(value: unknown) { return typeof value === "string" ? value.trim() : ""; }
function asRecord(value: unknown): RecordValue { return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {}; }
function records(value: unknown): RecordValue[] { return Array.isArray(value) ? value.filter((item) => item && typeof item === "object" && !Array.isArray(item)) : []; }
function dimensionText(dimensions?: Dimensions) {
  if (!dimensions) return "";
  const unit = dimensions.unit === "in" ? "in" : "cm";
  const values = [dimensions.length, dimensions.width, dimensions.height].map((value) => text(value)).filter(Boolean);
  return values.length ? `${values.join(" x ")} ${unit}` : "";
}
function rankByAttributes(rows: RecordValue[], input: SearchRequest) {
  return rows.map((row) => ({ ...row, attributeScore: candidateAttributeScore(row, input) }))
    .sort((a, b) => Number(b.attributeScore) - Number(a.attributeScore));
}
function candidateAttributeScore(row: RecordValue, input: SearchRequest) {
  const haystack = [row.title, row.snippet, row.description, row.source, row.price]
    .map((entry) => typeof entry === "string" ? entry : text(asRecord(entry).value)).join(" ").toLowerCase();
  const nameTokens = meaningfulTokens(input.productName);
  const descriptionTokens = meaningfulTokens(input.description ?? "");
  let score = tokenCoverage(nameTokens, haystack) * 40 + tokenCoverage(descriptionTokens, haystack) * 15;
  if (input.productName.trim() && haystack.includes(input.productName.trim().toLowerCase())) score += 10;
  const materials = (input.material ?? "").toLowerCase().split(/[,/|]+/).map((value) => value.trim()).filter(Boolean);
  if (materials.length && materials.some((material) => haystack.includes(material))) score += 15;
  const dimensions = [input.dimensions?.length, input.dimensions?.width, input.dimensions?.height].map((value) => text(value)).filter(Boolean);
  if (dimensions.length) score += dimensions.filter((value) => new RegExp(`(?:^|\\D)${escapeRegExp(value)}(?:\\D|$)`).test(haystack)).length / dimensions.length * 10;
  if (row.visualMatch === true) {
    const position = Number(row.position);
    score += Number.isFinite(position) && position > 0 ? 20 / Math.sqrt(position) : 5;
  }
  return score;
}
function meaningfulTokens(value: string) {
  const ignored = new Set(["and", "the", "for", "with", "from", "this", "that", "product", "item"]);
  return [...new Set(value.toLowerCase().match(/[a-z0-9]+/g) ?? [])].filter((token) => token.length > 2 && !ignored.has(token));
}
function tokenCoverage(tokens: string[], haystack: string) {
  return tokens.length ? tokens.filter((token) => haystack.includes(token)).length / tokens.length : 0;
}
function passesPdpRelevance(title: string, content: string, input: SearchRequest) {
  const pageTokens = meaningfulTokens(`${title} ${content}`);
  const nameTokens = meaningfulTokens(input.productName);
  const matchedNameTokens = nameTokens.filter((token) => tokenMatch(token, pageTokens)).length;
  const minimumNameMatches = nameTokens.length <= 1 ? nameTokens.length : Math.max(1, Math.ceil(nameTokens.length * 0.4));
  if (matchedNameTokens < minimumNameMatches) return false;

  const materialOptions = (input.material ?? "").split(/[,/|]+/)
    .map((value) => meaningfulTokens(value)).filter((tokens) => tokens.length);
  if (materialOptions.length && !materialOptions.some((option) => option.every((token) => tokenMatch(token, pageTokens)))) return false;

  const excluded = new Set([...nameTokens, ...materialOptions.flat()]);
  const descriptionTokens = meaningfulDescriptionTokens(input.description ?? "").filter((token) => !excluded.has(token));
  if (descriptionTokens.length && !descriptionTokens.some((token) => tokenMatch(token, pageTokens))) return false;
  return true;
}
function meaningfulDescriptionTokens(value: string) {
  const ignored = new Set([
    "black", "blue", "brown", "colour", "color", "cream", "gold", "gray", "green", "grey", "orange", "pink", "purple", "red", "silver", "white", "yellow",
    "beautiful", "classic", "finish", "finished", "good", "great", "large", "medium", "modern", "premium", "quality", "small", "style", "stylish", "use", "used",
  ]);
  return meaningfulTokens(value).filter((token) => !ignored.has(token));
}
function tokenMatch(expected: string, actualTokens: string[]) {
  return actualTokens.some((actual) => actual === expected
    || (expected.length >= 4 && actual.length >= 4 && (actual.startsWith(expected) || expected.startsWith(actual))));
}
function escapeRegExp(value: string) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function rankedCandidates(search: RecordValue) {
  return records(search.results).filter((row) => isRetailCandidateUrl(text(row.url)))
    .sort((a, b) => Number(hasProductPath(text(b.url))) - Number(hasProductPath(text(a.url))));
}
function dedupeCandidates(rows: RecordValue[]) {
  return rows.filter((row, index) => rows.findIndex((other) => text(other.url).split("#")[0] === text(row.url).split("#")[0]) === index);
}
function interleaveCandidates(groups: RecordValue[][]) {
  const rows: RecordValue[] = [];
  const longest = Math.max(0, ...groups.map((group) => group.length));
  for (let index = 0; index < longest; index++) {
    for (const group of groups) if (group[index]) rows.push(group[index]);
  }
  return dedupeCandidates(rows);
}
function resolveUrl(value: string, base: string) { try { const url = new URL(value, base); return value && ["http:", "https:"].includes(url.protocol) ? url.toString() : ""; } catch { return ""; } }
function hasProductPath(url: string) { return /\/(?:products?|product-detail|dp|gp\/product|ip|itm|listing|p)\//i.test(new URL(url).pathname); }
function isRetailCandidateUrl(value: string) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && url.pathname !== "/" && !/(?:^|\.)(?:google|bing|duckduckgo|pinterest|youtube|facebook)\./i.test(url.hostname)
      && !/\/(?:blog|blogs|articles?|news)(?:\/|$)/i.test(url.pathname);
  } catch { return false; }
}
function isNonPhysicalCandidate(value: string) {
  return /\b(?:free\s+)?(?:crochet|knitting|sewing)?\s*pattern\b|\b(?:pdf|digital)\s+download\b|\btutorial\b/i.test(value);
}
function isNonPhysicalProductPage(title: string, $: ReturnType<typeof load>) {
  if (isNonPhysicalCandidate(title)) return true;
  const primaryText = $("h1").first().nextAll().slice(0, 12).text().replace(/\s+/g, " ");
  return /\bfree download\b|\bdownload(?:able)?\s+(?:pdf|pattern)\b|\bdigital\s+download\b/i.test(primaryText)
    && /\bpattern\b/i.test(`${title} ${primaryText}`);
}
function isRegionCandidate(row: RecordValue, region: Region, currency: string) {
  const value = text(row.url) || text(row.link);
  let host = "";
  try { host = new URL(value).hostname.toLowerCase().replace(/^www\./, ""); } catch { return false; }
  const signals = [row.title, row.snippet, row.description, row.source, row.price]
    .map((entry) => typeof entry === "string" ? entry : text(asRecord(entry).value)).join(" ");
  if (/\b(?:INR|India)\b|₹|\bRs\.?\s*\d/i.test(signals) || /(?:^|\.)co\.in$|(?:^|\.)in$/.test(host)) return false;
  const currencySignals = signals.toUpperCase().match(/\b(?:USD|EUR|GBP|CAD|AUD|INR)\b/g) ?? [];
  if (currencySignals.some((candidateCurrency) => candidateCurrency !== currency)) return false;
  const suffix = countrySuffix(host);
  if (!suffix) return true;
  if (region === "US") return suffix === "us";
  if (region === "UK") return suffix === "uk";
  if (region === "AU") return suffix === "au";
  return EU_SUFFIXES.has(suffix);
}
const EU_SUFFIXES = new Set(["at", "be", "bg", "hr", "cy", "cz", "de", "dk", "ee", "es", "eu", "fi", "fr", "gr", "hu", "ie", "it", "lt", "lu", "lv", "mt", "nl", "pl", "pt", "ro", "se", "si", "sk"]);
function countrySuffix(host: string) {
  const suffix = host.split(".").at(-1) ?? "";
  return suffix.length === 2 ? suffix : "";
}
function isListingUrl(value: string) {
  const url = new URL(value);
  return /\/(?:search|collections?|category|categories|catalog|shop)(?:\/|$)/i.test(url.pathname) || url.searchParams.has("q") || url.searchParams.has("s");
}
function isDirectProductUrl(value: string) {
  return isRetailCandidateUrl(value) && hasProductPath(value) && !isListingUrl(value);
}
function isMarketplaceUrl(value: string) {
  const host = new URL(value).hostname.replace(/^www\./, "");
  return ["amazon.", "etsy.com", "ebay.", "alibaba.com"].some((marketplace) => host.includes(marketplace));
}
function isMarketplaceProductUrl(value: string) {
  if (!isMarketplaceUrl(value) || !isDirectProductUrl(value)) return false;
  const url = new URL(value);
  return !/\/(?:s|search|shop|category|categories|collections?|b)(?:\/|$)/i.test(url.pathname)
    && !url.searchParams.has("q") && !url.searchParams.has("k") && !url.searchParams.has("_nkw");
}
function marketplace(value: string) {
  const host = new URL(value).hostname.replace(/^www\./, "");
  const known: Record<string, string> = { amazon: "Amazon", ebay: "eBay", etsy: "Etsy", alibaba: "Alibaba", walmart: "Walmart" };
  return Object.entries(known).find(([name]) => host === `${name}.com` || host.startsWith(`${name}.`))?.[1] ?? "Seller website";
}
