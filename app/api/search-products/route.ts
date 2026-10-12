import { NextResponse } from "next/server";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { load } from "cheerio";
import { deleteReference, uploadReference } from "../../../lib/temporary-images";

type Region = "UK" | "US" | "EU";
type SearchRequest = { productName: string; description?: string; material?: string; region: Region; stage?: string; imageDataUrl?: string };
type RecordValue = Record<string, unknown>;
type ProductResult = {
  title: string; price: number; currency: string; seller: string; marketplace: string;
  productUrl: string; imageUrl: string; similarity: number; moq: null; notes: string;
  minPrice: number; maxPrice: number; pageType: "PDP";
};
const regions = {
  US: { currency: "USD", location: "US", language: "en", market: "United States", marketplaceDomains: ["amazon.com", "etsy.com", "ebay.com", "alibaba.com"] },
  UK: { currency: "GBP", location: "GB", language: "en", market: "United Kingdom", marketplaceDomains: ["amazon.co.uk", "etsy.com", "ebay.co.uk", "alibaba.com"] },
  EU: { currency: "EUR", location: "DE", language: "de", market: "Germany", marketplaceDomains: ["amazon.de", "etsy.com", "ebay.de", "alibaba.com"] },
};
const MAX_PRODUCTS = 7;
const GENERAL_SLOTS = 4;
const MARKETPLACE_SLOTS = 3;
export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  let cleanupReceipt = "";
  try {
    const input = await request.json() as SearchRequest;
    if (input.stage === "wholesale") return NextResponse.json({ error: "Wholesale lookup is paused." }, { status: 400 });
    if (typeof input.productName !== "string" || !input.productName.trim()) return NextResponse.json({ error: "Product name is required." }, { status: 400 });
    const config = regions[input.region] ?? regions.US;
    const apiKey = getApiKey();
    if (!apiKey) throw new Error("Set TINYFISH_API_KEY in the project's environment variables.");
    const signal = AbortSignal.timeout(50_000);
    const query = [input.productName.trim(), input.material?.trim(), input.description?.trim().slice(0, 150), config.currency, "retail price"].filter(Boolean).join(" ");
    let visualSearch: RecordValue = {};
    if (input.imageDataUrl) {
      const searchApiKey = getSearchApiKey();
      if (!searchApiKey) throw new Error("Set SEARCHAPI_API_KEY in the project's environment variables to use image search.");
      const uploaded = await uploadReference(input.imageDataUrl);
      cleanupReceipt = uploaded.receipt;
      const params = new URLSearchParams({ engine: "google_lens", search_type: "visual_matches", url: uploaded.url,
        q: [input.productName.trim(), input.material?.trim(), input.description?.trim().slice(0, 100)].filter(Boolean).join(" "),
        country: config.location, hl: config.language,
      });
      visualSearch = await searchApiJson(`https://www.searchapi.io/api/v1/search?${params}`, searchApiKey, signal);
    }
    const generalParams = new URLSearchParams({ query: `${query} product detail`, location: config.location, language: config.language,
      purpose: `Find direct retail product-detail pages for ${input.productName} sold in ${config.market}. Exclude homepages, seller profiles, search pages, categories, collections, filters, wholesale pages and articles.`,
    });
    const marketplaceQuery = `${query} product detail (${config.marketplaceDomains.map((domain) => `site:${domain}`).join(" OR ")})`;
    const marketplaceParams = new URLSearchParams({ query: marketplaceQuery, location: config.location, language: config.language,
      purpose: `Find direct product-detail pages for ${input.productName} on Amazon, Etsy, eBay or Alibaba in ${config.market}. Exclude marketplace search, category, filter and collection pages.`,
    });
    const [generalSearch, marketplaceSearch] = await Promise.all([
      providerJson(`https://api.search.tinyfish.ai?${generalParams}`, apiKey, signal),
      providerJson(`https://api.search.tinyfish.ai?${marketplaceParams}`, apiKey, signal),
    ]);
    const visualCandidates = records(visualSearch.visual_matches).map((row) => ({ ...row, url: text(row.link), visualMatch: true,
      sourceImage: text(asRecord(row.image).link) || text(row.thumbnail) })).filter((row) => isRetailCandidateUrl(text(row.url)));
    const generalCandidates = rankedCandidates(generalSearch).filter((row) => !isMarketplaceUrl(text(row.url)) && isDirectProductUrl(text(row.url))).slice(0, GENERAL_SLOTS);
    const marketplaceCandidates = rankedCandidates(marketplaceSearch).filter((row) => isMarketplaceProductUrl(text(row.url))).slice(0, MARKETPLACE_SLOTS);
    const allCandidates = [...rankedCandidates(generalSearch), ...rankedCandidates(marketplaceSearch)];
    const unique = dedupeCandidates([...visualCandidates, ...generalCandidates, ...marketplaceCandidates]).slice(0, MAX_PRODUCTS);
    if (!unique.length) return NextResponse.json({ error: "No direct retail product links were found. Try a more specific product name." }, { status: 422 });
    const fetched = await providerJson("https://api.fetch.tinyfish.ai", apiKey, signal, {
      urls: unique.map((row) => text(row.url)), format: "html", image_links: true, ttl: 0, per_url_timeout_ms: 30_000,
      purpose: "Read the main retail product's current price, currency, product image and listed seller. Do not research wholesale.",
    });
    const products: ProductResult[] = [];
    const skipped = records(fetched.errors).map((row) => ({ url: text(row.url), reason: text(row.error) || "Page could not be fetched." }));
    for (const page of records(fetched.results)) {
      const candidate = unique.find((row) => text(row.url) === text(page.url));
      if (!candidate) continue;
      const product = extractProduct(page, candidate, config.currency);
      if (product) products.push(product);
      else skipped.push({ url: text(page.url), reason: "No unambiguous retail price in the requested currency was found." });
    }
    const searched = {
      maxVisitedLinks: MAX_PRODUCTS,
      searchResultsReturned: records(generalSearch.results).length + records(marketplaceSearch.results).length,
      generalSearchResults: records(generalSearch.results).length,
      marketplaceSearchResults: records(marketplaceSearch.results).length,
      directProductCandidates: dedupeCandidates(allCandidates).length,
      marketplaceCandidatesSelected: unique.filter((row) => isMarketplaceProductUrl(text(row.url))).length,
      visitedLinks: unique.length,
      fetchedPages: records(fetched.results).length,
      validPricePages: products.length,
      rejectedPages: skipped.length,
      maxEstimateProducts: MAX_PRODUCTS,
      maxDisplayedSources: MAX_PRODUCTS,
      imageSearchRequested: Boolean(input.imageDataUrl),
      visualMatchesReturned: visualCandidates.length,
      visualCandidatesSelected: unique.filter((row) => row.visualMatch === true).length,
    };
    if (!products.length) return NextResponse.json({ error: "The product pages were checked, but no usable retail prices were accessible. No paid Agent fallback was used.", skipped, searched }, { status: 422 });
    return NextResponse.json({
      generatedAt: new Date().toISOString(), region: input.region, currency: config.currency, providerMode: "search-fetch",
      estimateProducts: products, displayProducts: products, rawCount: products.length, skipped,
      searched,
    });
  } catch (error) {
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

function extractProduct(page: RecordValue, candidate: RecordValue, currency: string): ProductResult | null {
  const url = text(page.final_url) || text(page.url);
  if (candidate.visualMatch === true ? !isRetailCandidateUrl(url) : !isDirectProductUrl(url)) return null;
  const $ = load(text(page.text));
  const heading = $("h1").first().text().trim();
  const title = heading || text(page.title) || text(candidate.title);
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
    if (metaCurrency === currency) {
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
  if (seller === "Not listed") seller = content.match(/(?:sold by|seller|verkauft von)\s*[:\-]?\s*([^\n]{2,100})/i)?.[1]?.trim() || "Not listed";
  if (!imageUrl) {
    imageUrl = resolveUrl($("meta[property='og:image']").first().attr("content") || "", url);
    if (!imageUrl) {
      const terms = title.toLowerCase().split(/\W+/).filter((word) => word.length > 3);
      const image = $("img").toArray().find((element) => terms.some((term) => ($(element).attr("alt") || "").toLowerCase().includes(term)));
      if (image) imageUrl = resolveUrl($(image).attr("src") || "", url);
    }
    if (!imageUrl) imageUrl = text(candidate.sourceImage);
  }
  return { title, price, minPrice: price, maxPrice: price, currency, seller, marketplace: marketplace(url), productUrl: url, imageUrl, similarity: 0, moq: null, pageType: "PDP", notes: evidence };
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
  return unique.length === 1 ? unique[0] : null;
}
function currencyAmounts(value: string, currency: string): number[] {
  const explicitCodes = value.toUpperCase().match(/\b(?:USD|EUR|GBP|CAD|AUD|INR)\b/g) ?? [];
  if (explicitCodes.some((code) => code !== currency)) return [];
  const token = currency === "USD" ? "(?:US\\$|\\$|USD)" : currency === "EUR" ? "(?:€|EUR)" : "(?:£|GBP)";
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
function rankedCandidates(search: RecordValue) {
  return records(search.results).filter((row) => isRetailCandidateUrl(text(row.url)))
    .sort((a, b) => Number(hasProductPath(text(b.url))) - Number(hasProductPath(text(a.url))));
}
function dedupeCandidates(rows: RecordValue[]) {
  return rows.filter((row, index) => rows.findIndex((other) => text(other.url).split("#")[0] === text(row.url).split("#")[0]) === index);
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
