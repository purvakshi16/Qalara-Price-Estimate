import { NextResponse } from "next/server";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

type Region = "UK" | "US" | "EU";

type SearchRequest = {
  productName: string;
  description: string;
  material: string;
  region: Region;
  imageName?: string;
  imageDataUrl?: string;
};

type ProductResult = {
  title: string;
  price: number | null;
  currency: string;
  seller: string;
  marketplace: string;
  productUrl: string;
  imageUrl: string;
  similarity: number;
  moq: MoqEvidence | null;
  notes: string;
};

type MoqEvidence = {
  suggestedMoq: string;
  wholesalePrice: string;
  sourceLabel: string;
  sourceUrl: string;
};

const regionConfig: Record<Region, { currency: string; countryCode: "GB" | "US" | "DE"; market: string }> = {
  UK: { currency: "GBP", countryCode: "GB", market: "United Kingdom" },
  US: { currency: "USD", countryCode: "US", market: "United States" },
  EU: { currency: "EUR", countryCode: "DE", market: "Germany / EU" },
};

const MAX_VISIT = 15;
const MAX_ESTIMATE_PRODUCTS = 10;
const MAX_DISPLAY_PRODUCTS = 6;

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    const input = (await request.json()) as SearchRequest;

    if (!input.productName?.trim()) {
      return NextResponse.json({ error: "Product name is required." }, { status: 400 });
    }

    const config = regionConfig[input.region] ?? regionConfig.UK;
    const apiKey = getTinyFishApiKey();

    if (!apiKey) {
      return NextResponse.json(
        {
          error: "TinyFish API key is not configured. Add TINYFISH_API_KEY to .env.local and Vercel environment variables.",
        },
        { status: 500 },
      );
    }

    const tinyFishResult = await runTinyFishSearch(input, config, apiKey);
    const products = normalizeProducts(tinyFishResult, config.currency);
    const pricedProducts = products.filter((product) => typeof product.price === "number").slice(0, MAX_ESTIMATE_PRODUCTS);

    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      region: input.region,
      currency: config.currency,
      searched: {
        maxVisitedLinks: MAX_VISIT,
        maxEstimateProducts: MAX_ESTIMATE_PRODUCTS,
        maxDisplayedSources: MAX_DISPLAY_PRODUCTS,
        imageSearchRequested: Boolean(input.imageDataUrl || input.imageName),
      },
      estimateProducts: pricedProducts,
      displayProducts: pricedProducts.slice(0, MAX_DISPLAY_PRODUCTS),
      rawCount: products.length,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Live product search failed.",
      },
      { status: 500 },
    );
  }
}

function getTinyFishApiKey() {
  if (process.env.TINYFISH_API_KEY) return process.env.TINYFISH_API_KEY;

  // Local convenience only. This file is gitignored and should not be deployed.
  const localKeyFile = join(process.cwd(), "API keys.txt");
  if (!existsSync(localKeyFile)) return "";

  const content = readFileSync(localKeyFile, "utf8");
  const match = content.match(/sk-tinyfish-[A-Za-z0-9_-]+/);
  return match?.[0] ?? "";
}

async function runTinyFishSearch(
  input: SearchRequest,
  config: { currency: string; countryCode: "GB" | "US" | "DE"; market: string },
  apiKey: string,
) {
  const goal = [
    `Find visually and textually similar products for: ${input.productName}.`,
    input.description ? `Description: ${input.description}.` : "",
    input.material ? `Material: ${input.material}.` : "",
    `Market/region: ${config.market}. Currency should be ${config.currency}.`,
    input.imageName
      ? `The user uploaded a reference image named "${input.imageName}". Use visual-search style matching where possible from the product name and image filename context.`
      : "No reference image was provided; use product name, description, and material.",
    `Visit up to ${MAX_VISIT} candidate product links, not just search result pages.`,
    `Return up to ${MAX_ESTIMATE_PRODUCTS} real product listings with exact product page URLs.`,
    "Include only listings where the URL is a direct product/detail page, not a general search page.",
    "For each retail listing, extract title, numeric retail price, currency, seller/store name from the product detail page, marketplace/platform name, product URL, product image URL, and a similarity score from 0-100.",
    "Marketplace means the website or platform hosting the product, such as Amazon, eBay, Alibaba, Etsy, Wayfair, or a retailer website.",
    "Seller means the actual seller, store, brand, or vendor field shown on that product detail page. Do not repeat the marketplace name as seller unless no seller field is visible.",
    "For each seller, separately investigate MOQ and wholesale price evidence.",
    "MOQ evidence must be product-specific or product-category-specific for the same or clearly similar product. Do not infer MOQ from seller type alone.",
    "Allowed MOQ sources are seller wholesale pages, trade pages, B2B pages, bulk-order pages, supplier profiles, or wholesale listings that show product-relevant MOQ or wholesale pricing.",
    "The MOQ sourceUrl must point to the seller's listed wholesale, bulk, trade, B2B, supplier, or product-category wholesale page.",
    "Do not use the retail product detail page as the MOQ source.",
    "Do not use ordinary marketplace retail product links as MOQ sources.",
    "Do not use general search result pages as MOQ sources.",
    "If product-relevant MOQ or wholesale price is not found, return moq as null.",
    "When found, return moq as an object with suggestedMoq, wholesalePrice, sourceLabel, and sourceUrl.",
    "Amazon may be included only if it naturally appears in the search results. Do not log in to Amazon.",
    "Return strict JSON with a top-level products array.",
  ]
    .filter(Boolean)
    .join(" ");

  const response = await fetch("https://agent.tinyfish.ai/v1/automation/run", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": apiKey,
    },
    body: JSON.stringify({
      url: "https://www.google.com/search?tbm=shop",
      goal,
      browser_profile: "lite",
      proxy_config: {
        enabled: true,
        country_code: config.countryCode,
      },
      agent_config: {
        max_duration_seconds: 55,
        max_steps: 90,
      },
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`TinyFish request failed: ${response.status} ${text.slice(0, 300)}`);
  }

  return response.json();
}

function normalizeProducts(payload: unknown, fallbackCurrency: string): ProductResult[] {
  const candidates = extractProductsArray(payload);

  return candidates
    .map((item, index) => {
      const record = item as Record<string, unknown>;
      const price = parsePrice(record.price);
      const productUrl = stringValue(record.productUrl ?? record.url ?? record.link);
      const imageUrl = stringValue(record.imageUrl ?? record.image ?? record.thumbnail);
      const moq = normalizeMoq(record.moq ?? record.wholesale ?? record.bulkPricing, productUrl);

      return {
        title: stringValue(record.title ?? record.name) || "Untitled product",
        price,
        currency: stringValue(record.currency) || fallbackCurrency,
        seller: stringValue(record.seller ?? record.store ?? record.vendor) || "Not listed",
        marketplace: stringValue(record.marketplace ?? record.source ?? record.site) || marketplaceFromUrl(productUrl),
        productUrl,
        imageUrl,
        similarity: clampNumber(record.similarity ?? record.similarityScore, 60, 100, 92 - index * 4),
        moq,
        notes: stringValue(record.notes ?? record.reason) || "Matched from live web search",
      };
    })
    .filter((item) => item.productUrl && item.imageUrl && !isSearchUrl(item.productUrl));
}

function normalizeMoq(value: unknown, productUrl: string): MoqEvidence | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const sourceUrl = stringValue(record.sourceUrl ?? record.url ?? record.link);
  const suggestedMoq = stringValue(record.suggestedMoq ?? record.moq ?? record.minimumOrderQuantity);
  const wholesalePrice = stringValue(record.wholesalePrice ?? record.price ?? record.bulkPrice);
  const sourceLabel = stringValue(record.sourceLabel ?? record.source ?? record.label) || marketplaceFromUrl(sourceUrl);

  if (!sourceUrl || !suggestedMoq || !wholesalePrice) return null;
  if (isSearchUrl(sourceUrl)) return null;
  if (normalizeUrl(sourceUrl) === normalizeUrl(productUrl)) return null;

  return {
    suggestedMoq,
    wholesalePrice,
    sourceLabel,
    sourceUrl,
  };
}

function normalizeUrl(url: string) {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return url.trim().replace(/\/$/, "");
  }
}

function extractProductsArray(payload: unknown): unknown[] {
  if (!payload || typeof payload !== "object") return [];
  const root = payload as Record<string, unknown>;
  const direct = root.products;
  if (Array.isArray(direct)) return direct;

  const result = root.result;
  if (result && typeof result === "object") {
    const resultRecord = result as Record<string, unknown>;
    if (Array.isArray(resultRecord.products)) return resultRecord.products;
    if (typeof resultRecord.text === "string") return parseProductsFromText(resultRecord.text);
  }

  if (typeof root.output === "string") return parseProductsFromText(root.output);
  return [];
}

function parseProductsFromText(text: string): unknown[] {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    return Array.isArray(parsed.products) ? parsed.products : [];
  } catch {
    return [];
  }
}

function parsePrice(value: unknown) {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return null;
  const normalized = value.replace(/,/g, "").match(/\d+(\.\d+)?/);
  return normalized ? Number(normalized[0]) : null;
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function clampNumber(value: unknown, min: number, max: number, fallback: number) {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function marketplaceFromUrl(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "Source";
  }
}

function isSearchUrl(url: string) {
  return /google\.|bing\.|duckduckgo\.|\/search|[?&]q=/.test(url);
}
