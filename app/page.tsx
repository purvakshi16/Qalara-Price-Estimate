"use client";

import { FormEvent, useMemo, useState } from "react";

type Region = "UK" | "US" | "EU";

type ProductResult = {
  title: string;
  price: number;
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

type SearchResponse = {
  generatedAt: string;
  currency: string;
  estimateProducts: ProductResult[];
  displayProducts: ProductResult[];
  skipped?: { url: string; reason: string }[];
  searched: {
    maxVisitedLinks: number;
    searchResultsReturned: number;
    directProductCandidates: number;
    visitedLinks: number;
    fetchedPages: number;
    validPricePages: number;
    rejectedPages: number;
    maxEstimateProducts: number;
    maxDisplayedSources: number;
    imageSearchRequested: boolean;
  };
};

type UploadedImage = {
  name: string;
  dataUrl: string;
};

const initialForm = {
  productName: "",
  description: "",
  material: "",
  region: "US" as Region,
};

const SEARCH_TIMEOUT_MS = 60_000;

function formatMoney(value: number, currency: string) {
  return new Intl.NumberFormat("en", {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(value);
}

function median(values: number[]) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function fileToDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export default function Home() {
  const [form, setForm] = useState(initialForm);
  const [uploadedImage, setUploadedImage] = useState<UploadedImage | null>(null);
  const [imagePreview, setImagePreview] = useState("");
  const [response, setResponse] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [downloadOpen, setDownloadOpen] = useState(false);
  const [searchProgress, setSearchProgress] = useState("");
  const [lastDiagnostics, setLastDiagnostics] = useState<Pick<SearchResponse, "searched" | "skipped"> | null>(null);

  const estimate = useMemo(() => {
    const products = response?.estimateProducts ?? [];
    const prices = products.map((product) => product.price);
    const currency = response?.currency ?? (form.region === "UK" ? "GBP" : form.region === "US" ? "USD" : "EUR");

    if (!prices.length) {
      return { currency, min: 0, max: 0, median: 0, confidence: "No priced products" };
    }

    const confidence = prices.length >= 8 ? "High" : prices.length >= 4 ? "Medium" : "Low";

    return {
      currency,
      min: Math.min(...prices),
      max: Math.max(...prices),
      median: median(prices),
      confidence,
    };
  }, [form.region, response]);

  async function handleImageChange(fileList: FileList | null) {
    const file = fileList?.[0];
    if (!file) {
      setUploadedImage(null);
      setImagePreview("");
      return;
    }

    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > 2 * 1024 * 1024) {
      setError("Choose a JPEG, PNG or WebP image smaller than 2 MB.");
      setUploadedImage(null);
      setImagePreview("");
      return;
    }

    const dataUrl = await fileToDataUrl(file);
    setUploadedImage({ name: file.name, dataUrl });
    setImagePreview(dataUrl);
  }

  async function runSearch(event: FormEvent) {
    event.preventDefault();
    setError("");
    setLoading(true);
    setResponse(null);
    setLastDiagnostics(null);
    setSearchProgress("Finding product pages and reading retail prices...");

    let timeoutId: number | undefined;
    try {
      const controller = new AbortController();
      timeoutId = window.setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
      const res = await fetch("/api/search-products", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          ...form,
        }),
      });

      const responseText = await res.text();
      let payload;
      try {
        payload = JSON.parse(responseText);
      } catch {
        throw new Error(`Server returned a non-JSON response: ${responseText.replace(/\s+/g, " ").trim().slice(0, 220)}`);
      }

      if (!res.ok) {
        if (payload.searched) setLastDiagnostics({ searched: payload.searched, skipped: payload.skipped });
        const reasons = payload.skipped?.map((item: { reason: string }) => item.reason).join("; ");
        throw new Error([payload.error ?? "Search failed.", reasons].filter(Boolean).join(" "));
      }

      setResponse(payload);
      setLastDiagnostics({ searched: payload.searched, skipped: payload.skipped });
    } catch (searchError) {
      if (searchError instanceof DOMException && searchError.name === "AbortError") {
        setError("Search timed out while reading product pages. No paid automation was started.");
      } else {
        setError(searchError instanceof Error ? searchError.message : "Search failed.");
      }
    } finally {
      if (timeoutId) window.clearTimeout(timeoutId);
      setLoading(false);
    }
  }

  function exportCsv() {
    if (!response) return;
    const header = [
      "Image URL",
      "Marketplace",
      "Seller",
      "Title",
      "Retail Price",
      "Currency",
      "Suggested MOQ",
      "Wholesale Price",
      "MOQ Source",
      "MOQ Source URL",
      "Retail Product URL",
      "Notes",
    ];
    const rows = response.displayProducts.map((product) => [
      product.imageUrl,
      product.marketplace,
      product.seller,
      product.title,
      product.price,
      product.currency,
      product.moq?.suggestedMoq ?? "Not found",
      product.moq?.wholesalePrice ?? "",
      product.moq?.sourceLabel ?? "",
      product.moq?.sourceUrl ?? "",
      product.productUrl,
      product.notes,
    ]);
    const csv = [header, ...rows].map((row) => row.map((value) => `"${String(value).replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${form.productName || "price-estimate"}-${form.region}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  return (
    <main className="page">
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand">
            <div className="brand-mark" aria-hidden="true">
              ⌕
            </div>
            <div>
              <h1 className="brand-title">Market Price Estimator</h1>
              <p className="brand-subtitle">UK, US and EU selling price estimates from comparable sources</p>
            </div>
          </div>
          <div className="download-menu">
            <button className="btn secondary" onClick={() => setDownloadOpen((open) => !open)} disabled={!response} type="button">
              Download
            </button>
            <div className="download-options" hidden={!downloadOpen}>
              <button
                type="button"
                onClick={() => {
                  setDownloadOpen(false);
                  window.print();
                }}
              >
                PDF
              </button>
              <button
                type="button"
                onClick={() => {
                  setDownloadOpen(false);
                  exportCsv();
                }}
              >
                Excel CSV
              </button>
            </div>
          </div>
        </div>
      </header>

      <div className="shell">
        <div className="workspace">
          <section className="panel input-panel">
            <div className="panel-header">
              <h2 className="panel-title">Product Details</h2>
            </div>
            <div className="panel-body">
              <form className="form-grid" onSubmit={runSearch}>
                <div className="field">
                  <label htmlFor="productName">Product name</label>
                  <input
                    id="productName"
                    value={form.productName}
                    onChange={(event) => setForm({ ...form, productName: event.target.value })}
                    placeholder="Tote bag"
                    required
                  />
                </div>
                <div className="field">
                  <label htmlFor="description">Description</label>
                  <textarea
                    id="description"
                    value={form.description}
                    onChange={(event) => setForm({ ...form, description: event.target.value })}
                    placeholder="Short product details, finish, use case, shape, pack size"
                  />
                </div>
                <div className="field">
                  <label htmlFor="material">Material</label>
                  <input
                    id="material"
                    value={form.material}
                    onChange={(event) => setForm({ ...form, material: event.target.value })}
                    placeholder="Cotton, jute, canvas"
                  />
                </div>
                <div className="field">
                  <label htmlFor="productImages">Upload image</label>
                  <input id="productImages" type="file" accept="image/jpeg,image/png,image/webp" disabled />
                  <p className="field-help">Image search is paused. Retail search uses product name, description and material.</p>
                  <div className="image-preview-grid" aria-live="polite">
                    {imagePreview ? (
                      <>
                        <div className="image-preview">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={imagePreview} alt={uploadedImage?.name ?? "Uploaded reference"} />
                        </div>
                        <p className="image-count">1 image selected</p>
                      </>
                    ) : null}
                  </div>
                </div>
                <div className="field">
                  <label htmlFor="region">Region</label>
                  <select id="region" value={form.region} onChange={(event) => setForm({ ...form, region: event.target.value as Region })}>
                    <option value="US">US - USD</option>
                    <option value="UK">UK - GBP</option>
                    <option value="EU">EU - EUR / Germany</option>
                  </select>
                </div>
                {error ? (
                  <p className="source-meta error" role="alert">
                    {error}
                  </p>
                ) : null}
                <button className="btn" disabled={loading || !form.productName.trim()} type="submit">
                  {loading ? "Searching live products..." : "Find Similar Items"}
                </button>
                {loading ? <p className="source-meta" role="status">{searchProgress}</p> : null}
              </form>
            </div>
          </section>

          <section className="panel">
            <div className="panel-header">
              <h2 className="panel-title">Estimate</h2>
            </div>
            <div className="panel-body">
              {response ? (
                <>
                  <div className="estimate-grid">
                    <div className="metric">
                      <p className="metric-label">Price range</p>
                      <p className="metric-value">
                        {formatMoney(estimate.min, estimate.currency)} - {formatMoney(estimate.max, estimate.currency)}
                      </p>
                      <p className="metric-note">From up to {response.searched.maxEstimateProducts} priced products</p>
                    </div>
                    <div className="metric">
                      <p className="metric-label">Single estimate</p>
                      <p className="metric-value">{formatMoney(estimate.median, estimate.currency)}</p>
                      <p className="metric-note">Median of estimate set</p>
                    </div>
                    <div className="metric">
                      <p className="metric-label">Confidence</p>
                      <p className="metric-value">{estimate.confidence}</p>
                      <p className="metric-note">Based on priced matches</p>
                    </div>
                  </div>

                  <SearchDiagnostics diagnostics={lastDiagnostics} />

                  <div className="results-header">
                    <div>
                      <h2 className="panel-title">Candidate Sources</h2>
                      <p className="source-meta">
                        Visited up to {response.searched.maxVisitedLinks} links. Showing top {response.displayProducts.length} source rows.
                      </p>
                    </div>
                  </div>
                  {response.skipped?.length ? <p className="source-meta">{response.skipped.length} page(s) omitted: {response.skipped.map((item) => item.reason).join("; ")}</p> : null}

                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Image</th>
                          <th>Source item</th>
                          <th>Marketplace</th>
                          <th>Seller</th>
                          <th>Price</th>
                          <th>MOQ</th>
                          <th>Open</th>
                        </tr>
                      </thead>
                      <tbody>
                        {response.displayProducts.map((product) => (
                            <tr key={product.productUrl}>
                              <td className="image-cell">
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                {product.imageUrl ? <img className="product-thumb" src={product.imageUrl} alt={product.title} /> : <span className="source-meta">Not found</span>}
                              </td>
                              <td>
                                <div className="source-item">
                                  <div>
                                    <p className="source-title">{product.title}</p>
                                    <p className="source-meta">
                                      {product.marketplace}. {product.notes}
                                    </p>
                                  </div>
                                </div>
                              </td>
                              <td>{product.marketplace}</td>
                              <td>{product.seller}</td>
                              <td>{formatMoney(product.price, product.currency)}</td>
                              <td>
                                <span>Paused</span>
                              </td>
                              <td>
                                <a href={product.productUrl} target="_blank" rel="noreferrer">
                                  Product
                                </a>
                              </td>
                            </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              ) : lastDiagnostics ? (
                <SearchDiagnostics diagnostics={lastDiagnostics} />
              ) : (
                <div className="empty">
                  <div>
                    <div className="empty-icon">⌕</div>
                    <p>Enter a product and run a search to generate comparable market prices.</p>
                    <p className="muted">Checks up to seven retail product sources.</p>
                  </div>
                </div>
              )}
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}

function SearchDiagnostics({ diagnostics }: { diagnostics: Pick<SearchResponse, "searched" | "skipped"> | null }) {
  if (!diagnostics) return null;
  const { searched, skipped = [] } = diagnostics;
  return (
    <section className="diagnostics" aria-labelledby="diagnostics-title">
      <h2 id="diagnostics-title" className="panel-title">Search diagnostics</h2>
      <div className="diagnostic-grid">
        <div><strong>{searched.searchResultsReturned}</strong><span>Search results returned</span></div>
        <div><strong>{searched.directProductCandidates}</strong><span>Direct product candidates</span></div>
        <div><strong>{searched.visitedLinks}</strong><span>Pages selected</span></div>
        <div><strong>{searched.fetchedPages}</strong><span>Pages fetched</span></div>
        <div><strong>{searched.validPricePages}</strong><span>Valid retail prices</span></div>
        <div><strong>{searched.rejectedPages}</strong><span>Rejected pages</span></div>
      </div>
      {skipped.length ? (
        <div className="diagnostic-list">
          {skipped.map((item) => (
            <p key={`${item.url}-${item.reason}`}><a href={item.url} target="_blank" rel="noreferrer">Rejected page</a><span>{item.reason}</span></p>
          ))}
        </div>
      ) : <p className="source-meta">No selected pages were rejected.</p>}
    </section>
  );
}

function MoqCell({ moq }: { moq: MoqEvidence | null }) {
  if (!moq) return <span className="moq-not-found">Not found</span>;

  return (
    <div className="moq-cell">
      <div>
        <strong>Suggested MOQ:</strong> {moq.suggestedMoq}
      </div>
      <div>
        <strong>Wholesale price:</strong> {moq.wholesalePrice}
      </div>
      <div>
        <strong>Source:</strong>{" "}
        <a href={moq.sourceUrl} target="_blank" rel="noreferrer">
          {moq.sourceLabel}
        </a>
      </div>
    </div>
  );
}
