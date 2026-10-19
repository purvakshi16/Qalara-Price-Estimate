"use client";

import { FormEvent, useMemo, useState } from "react";

type Region = "UK" | "US" | "EU" | "AU";

type ProductResult = {
  title: string;
  price: number;
  currency: string;
  seller: string;
  marketplace: string;
  productUrl: string;
  imageUrl: string;
  notes: string;
  minPrice: number;
  maxPrice: number;
  pageType: "PDP";
};

type SearchResponse = {
  currency: string;
  displayProducts: ProductResult[];
  searched: {
    visualMatchesReturned: number;
    pagesAccessed: number;
    validPagesFound: number;
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
  dimensionLength: "",
  dimensionWidth: "",
  dimensionHeight: "",
  dimensionUnit: "cm",
  region: "US" as Region,
};

const SEARCH_TIMEOUT_MS = 120_000;

function formatMoney(value: number, currency: string) {
  return new Intl.NumberFormat("en", {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(value);
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
  const [lastDiagnostics, setLastDiagnostics] = useState<Pick<SearchResponse, "searched"> | null>(null);
  const [searchStarted, setSearchStarted] = useState(false);

  const estimate = useMemo(() => {
    const products = response?.displayProducts ?? [];
    const minimums = products.map((product) => product.minPrice ?? product.price);
    const maximums = products.map((product) => product.maxPrice ?? product.price);
    const currency = response?.currency ?? ({ US: "USD", UK: "GBP", EU: "EUR", AU: "AUD" } as const)[form.region];

    if (!minimums.length) {
      return { currency, min: 0, max: 0 };
    }
    return { currency, min: Math.min(...minimums), max: Math.max(...maximums) };
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
    if (!uploadedImage) {
      setError("Upload a product image before searching.");
      return;
    }
    setError("");
    setSearchStarted(true);
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
          productName: form.productName,
          description: form.description,
          material: form.material,
          region: form.region,
          dimensions: {
            length: form.dimensionLength,
            width: form.dimensionWidth,
            height: form.dimensionHeight,
            unit: form.dimensionUnit,
          },
          imageDataUrl: uploadedImage?.dataUrl,
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
        if (payload.searched) setLastDiagnostics({ searched: payload.searched });
        throw new Error(payload.error ?? "Search failed.");
      }

      setResponse(payload);
      setLastDiagnostics({ searched: payload.searched });
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
      "Page Type",
      "Lowest Retail Price",
      "Highest Retail Price",
      "Currency",
      "Retail Product URL",
      "Notes",
    ];
    const rows = response.displayProducts.map((product) => [
      product.imageUrl,
      product.marketplace,
      product.seller,
      product.title,
      product.pageType,
      product.minPrice ?? product.price,
      product.maxPrice ?? product.price,
      product.currency,
      product.productUrl,
      product.notes,
    ]);
    const csv = [header, ...rows].map((row) => row.map((value) => `"${String(value).replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${downloadFileName(form.productName, form.region)}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  return (
    <main className="page">
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="brand-mark" src="/qalara-icon.ico" alt="Qalara" />
            <div>
              <h1 className="brand-title">Market Price Estimator</h1>
              <p className="brand-subtitle">US, UK, EU and Australian selling price estimates from comparable sources</p>
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
                  exportPdf(form.productName, form.region);
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
        <div className={`workspace${searchStarted ? "" : " entry-only"}`}>
          <section className="panel input-panel">
            <div className="panel-header">
              <h2 className="panel-title">Product Details</h2>
            </div>
            <div className="panel-body">
              <form className="form-grid" onSubmit={runSearch}>
                <div className="field">
                  <label htmlFor="productName">Product name <span className="required-mark" aria-hidden="true">*</span><span className="sr-only"> required</span></label>
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
                <fieldset className="field dimension-field">
                  <legend>Product dimensions</legend>
                  <div className="dimension-grid">
                    <label>
                      <input type="number" min="0" step="any" inputMode="decimal" value={form.dimensionLength}
                        onChange={(event) => setForm({ ...form, dimensionLength: event.target.value })} placeholder="30" />
                      <span>Length</span>
                    </label>
                    <label>
                      <input type="number" min="0" step="any" inputMode="decimal" value={form.dimensionWidth}
                        onChange={(event) => setForm({ ...form, dimensionWidth: event.target.value })} placeholder="20" />
                      <span>Width</span>
                    </label>
                    <label>
                      <input type="number" min="0" step="any" inputMode="decimal" value={form.dimensionHeight}
                        onChange={(event) => setForm({ ...form, dimensionHeight: event.target.value })} placeholder="10" />
                      <span>Height</span>
                    </label>
                    <label>
                      <select value={form.dimensionUnit} onChange={(event) => setForm({ ...form, dimensionUnit: event.target.value })}>
                        <option value="cm">cm</option>
                        <option value="in">in</option>
                      </select>
                      <span>Unit</span>
                    </label>
                  </div>
                </fieldset>
                <div className="field">
                  <label htmlFor="productImages">Upload image <span className="required-mark" aria-hidden="true">*</span><span className="sr-only"> required</span></label>
                  <input id="productImages" type="file" accept="image/jpeg,image/png,image/webp" required onChange={(event) => handleImageChange(event.target.files)} />
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
                    <option value="AU">Australia - AUD</option>
                    <option value="EU">Europe - EUR</option>
                    <option value="US">United States - USD</option>
                    <option value="UK">United Kingdom - GBP</option>
                  </select>
                </div>
                {error ? (
                  <p className="source-meta error" role="alert">
                    {error}
                  </p>
                ) : null}
                <button className="btn" disabled={loading || !form.productName.trim() || !uploadedImage} type="submit">
                  {loading ? (
                    <><span className="loading-spinner button-spinner" aria-hidden="true" />Searching products...</>
                  ) : "Find Similar Items"}
                </button>
                {loading ? <p className="source-meta" role="status">{searchProgress}</p> : null}
              </form>
            </div>
          </section>

          {searchStarted ? <section className="panel">
            <div className="panel-header">
              <h2 className="panel-title">Search Results</h2>
            </div>
            <div className="panel-body">
              {loading ? (
                <div className="search-loading" role="status" aria-live="polite">
                  <div>
                    <span className="loading-spinner results-spinner" aria-hidden="true" />
                    <p className="loading-title">Searching products...</p>
                    <p className="source-meta">{searchProgress}</p>
                  </div>
                </div>
              ) : response ? (
                <>
                  <div className="estimate-grid one">
                    <div className="metric">
                      <p className="metric-label">Price range</p>
                      <p className="metric-value">
                        {formatMoney(estimate.min, estimate.currency)} - {formatMoney(estimate.max, estimate.currency)}
                      </p>
                      <p className="metric-note">From {response.displayProducts.length} valid product pages</p>
                    </div>
                  </div>

                  <SearchDiagnostics diagnostics={lastDiagnostics} />

                  <div className="results-header">
                    <div>
                      <h2 className="panel-title">Candidate Sources</h2>
                      <p className="source-meta">Showing {response.displayProducts.length} valid product pages.</p>
                    </div>
                  </div>

                  <div className="table-wrap">
                    <table className="results-table">
                      <colgroup>
                        <col className="image-column" />
                        <col className="source-column" />
                        <col className="price-column" />
                        <col className="marketplace-column" />
                        <col className="seller-column" />
                      </colgroup>
                      <thead>
                        <tr>
                          <th>Image</th>
                          <th>Source item</th>
                          <th>PDP price</th>
                          <th>Marketplace</th>
                          <th>Seller</th>
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
                                    <p className="source-title">
                                      <a href={product.productUrl} target="_blank" rel="noreferrer">{product.title}</a>
                                    </p>
                                    <p className="source-meta">
                                      {product.marketplace}. {product.notes}
                                    </p>
                                  </div>
                                </div>
                              </td>
                              <td className="price-cell">{formatProductPrice(product)}</td>
                              <td>{product.marketplace}</td>
                              <td>{product.seller}</td>
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
                  </div>
                </div>
              )}
            </div>
          </section> : null}
        </div>
      </div>
    </main>
  );
}

function SearchDiagnostics({ diagnostics }: { diagnostics: Pick<SearchResponse, "searched"> | null }) {
  if (!diagnostics) return null;
  const { searched } = diagnostics;
  return (
    <section className="diagnostics" aria-labelledby="diagnostics-title">
      <h2 id="diagnostics-title" className="panel-title">Search diagnostics</h2>
      <div className="diagnostic-grid">
        <div><strong>{searched.visualMatchesReturned}</strong><span>Visual matches returned</span></div>
        <div><strong>{searched.pagesAccessed}</strong><span>Pages accessed</span></div>
        <div><strong>{searched.validPagesFound}</strong><span>Valid product pages found</span></div>
      </div>
    </section>
  );
}

function formatProductPrice(product: ProductResult) {
  const min = product.minPrice ?? product.price;
  const max = product.maxPrice ?? product.price;
  return min === max ? formatMoney(min, product.currency) : `${formatMoney(min, product.currency)} - ${formatMoney(max, product.currency)}`;
}

function downloadFileName(productName: string, region: Region) {
  const safeProductName = productName.trim().replace(/[\\/:*?"<>|]+/g, "-") || "price-estimate";
  return `${safeProductName} - ${region}`;
}

function exportPdf(productName: string, region: Region) {
  const originalTitle = document.title;
  document.title = downloadFileName(productName, region);
  window.addEventListener("afterprint", () => { document.title = originalTitle; }, { once: true });
  window.print();
}
