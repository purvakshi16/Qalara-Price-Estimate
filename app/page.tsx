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
  searched: {
    maxVisitedLinks: number;
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

const SEARCH_TIMEOUT_MS = 75_000;

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
  const [acceptedUrls, setAcceptedUrls] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const accepted = useMemo(() => {
    const rows = response?.displayProducts ?? [];
    return rows.filter((product) => acceptedUrls.has(product.productUrl));
  }, [acceptedUrls, response]);

  const estimate = useMemo(() => {
    const products = response?.estimateProducts ?? [];
    const acceptedEstimateProducts = products.filter((product) => acceptedUrls.has(product.productUrl));
    const source = acceptedEstimateProducts.length ? acceptedEstimateProducts : products;
    const prices = source.map((product) => product.price);
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
  }, [acceptedUrls, form.region, response]);

  async function handleImageChange(fileList: FileList | null) {
    const file = fileList?.[0];
    if (!file) {
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

    try {
      const controller = new AbortController();
      const timeoutId = window.setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
      const res = await fetch("/api/search-products", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          ...form,
          imageName: uploadedImage?.name,
        }),
      });
      window.clearTimeout(timeoutId);

      const responseText = await res.text();
      let payload;
      try {
        payload = JSON.parse(responseText);
      } catch {
        throw new Error(`Server returned a non-JSON response: ${responseText.replace(/\s+/g, " ").trim().slice(0, 220)}`);
      }

      if (!res.ok) throw new Error(payload.error ?? "Search failed.");

      setResponse(payload);
      setAcceptedUrls(new Set(payload.displayProducts.map((product: ProductResult) => product.productUrl)));
    } catch (searchError) {
      if (searchError instanceof DOMException && searchError.name === "AbortError") {
        setError("Search took too long and was stopped. Please try again with a simpler product name or retry in a moment.");
      } else {
        setError(searchError instanceof Error ? searchError.message : "Search failed.");
      }
    } finally {
      setLoading(false);
    }
  }

  function toggleProduct(url: string) {
    setAcceptedUrls((current) => {
      const next = new Set(current);
      if (next.has(url)) next.delete(url);
      else next.add(url);
      return next;
    });
  }

  function exportCsv() {
    if (!response) return;
    const header = [
      "Status",
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
      acceptedUrls.has(product.productUrl) ? "Accepted" : "Rejected",
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
          <div className="button-row">
            <button className="btn secondary" onClick={() => window.print()} disabled={!response} title="Download as PDF">
              PDF
            </button>
            <button className="btn secondary" onClick={exportCsv} disabled={!response} title="Download as Excel-compatible CSV">
              Excel CSV
            </button>
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
                  <input id="productImages" type="file" accept="image/*" onChange={(event) => handleImageChange(event.target.files)} />
                  <p className="field-help">Used as a visual reference for TinyFish search. Source rows use images from matched product pages.</p>
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

                  <details className="details">
                    <summary>View single estimate prices with sources</summary>
                    <div className="details-list">
                      {accepted.map((product) => (
                        <div className="detail-item" key={product.productUrl}>
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img className="product-thumb" src={product.imageUrl} alt={product.title} />
                          <strong>{formatMoney(product.price, product.currency)}</strong>
                          <span>{product.title}</span>
                          <a href={product.productUrl} target="_blank" rel="noreferrer">
                            {product.marketplace}
                          </a>
                        </div>
                      ))}
                    </div>
                  </details>

                  <div className="results-header">
                    <div>
                      <h2 className="panel-title">Candidate Sources</h2>
                      <p className="source-meta">
                        Visited up to {response.searched.maxVisitedLinks} links. Showing top {response.displayProducts.length} source rows.
                      </p>
                    </div>
                    <div className="button-row">
                      <button className="btn secondary" type="button" onClick={() => setAcceptedUrls(new Set(response.displayProducts.map((item) => item.productUrl)))}>
                        Accept all
                      </button>
                      <button className="btn secondary" type="button" onClick={() => setAcceptedUrls(new Set())}>
                        Reject all
                      </button>
                    </div>
                  </div>

                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Status</th>
                          <th>Source item</th>
                          <th>Marketplace</th>
                          <th>Seller</th>
                          <th>Price</th>
                          <th>MOQ</th>
                          <th>Open</th>
                        </tr>
                      </thead>
                      <tbody>
                        {response.displayProducts.map((product) => {
                          const isAccepted = acceptedUrls.has(product.productUrl);
                          return (
                            <tr key={product.productUrl}>
                              <td>
                                <button className={`status ${isAccepted ? "accepted" : "rejected"}`} type="button" onClick={() => toggleProduct(product.productUrl)}>
                                  {isAccepted ? "Accepted" : "Rejected"}
                                </button>
                              </td>
                              <td>
                                <div className="source-item">
                                  {/* eslint-disable-next-line @next/next/no-img-element */}
                                  <img className="product-thumb" src={product.imageUrl} alt={product.title} />
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
                                <MoqCell moq={product.moq} />
                              </td>
                              <td>
                                <a href={product.productUrl} target="_blank" rel="noreferrer">
                                  Product
                                </a>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </>
              ) : (
                <div className="empty">
                  <div>
                    <div className="empty-icon">⌕</div>
                    <p>Enter a product and run a search to generate comparable market prices.</p>
                    <p className="muted">The backend will visit up to 15 links, estimate from up to 10 priced matches, and show 6 source rows.</p>
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
