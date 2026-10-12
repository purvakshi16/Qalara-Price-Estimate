const test = require('node:test');
const assert = require('node:assert/strict');
const { route } = require('./route-loader.cjs');
const url = 'https://shop.example/products/cotton-tote';
const request = (region = 'US', extra = {}) => new Request('https://app.example/api/search-products', { method: 'POST', body: JSON.stringify({ productName: 'Cotton tote', region, ...extra }) });

function provider(html, options = {}) {
  const calls = [];
  const fetch = async (endpoint, init) => {
    const host = new URL(endpoint).hostname;
    calls.push(host);
    assert.ok(['api.search.tinyfish.ai', 'api.fetch.tinyfish.ai'].includes(host), 'No paid provider endpoint may be called');
    if (host === 'api.search.tinyfish.ai') {
      assert.equal(new URL(endpoint).searchParams.get('location'), options.location ?? 'US');
      const marketplaceSearch = new URL(endpoint).searchParams.get('query').includes('site:amazon');
      return Response.json({ results: marketplaceSearch ? (options.marketplaceResults ?? []) : (options.results ?? [{ url, title: 'Cotton tote' }]) });
    }
    const body = JSON.parse(init.body);
    assert.ok(body.urls.length <= 7);
    assert.equal(body.format, 'html');
    return Response.json(options.fetchResult ?? { results: [{ url, title: 'Cotton tote', text: html }], errors: [] });
  };
  return { api: route(fetch), calls };
}

test('rejects visible price text without structured product evidence', async () => {
  const { api, calls } = provider('<h1>Cotton tote</h1><p>$19.99</p>');
  const response = await api.POST(request());
  assert.equal(response.status, 422);
  assert.deepEqual(calls, ['api.search.tinyfish.ai', 'api.search.tinyfish.ai', 'api.fetch.tinyfish.ai']);
});

test('uses explicit seller and product image from structured offer', async () => {
  const product = { '@type': 'Product', name: 'Cotton tote', image: '/tote.jpg', offers: { price: '25.50', priceCurrency: 'USD', seller: { name: 'Tote Studio' } } };
  const { api } = provider(`<script type="application/ld+json">${JSON.stringify(product)}</script><h1>Cotton tote</h1>`);
  const data = await (await api.POST(request())).json();
  assert.equal(data.displayProducts[0].price, 25.5);
  assert.equal(data.displayProducts[0].seller, 'Tote Studio');
  assert.equal(data.displayProducts[0].imageUrl, 'https://shop.example/tote.jpg');
});

test('merges duplicate product schemas when identity and price agree', async () => {
  const product = { '@type': 'Product', '@id': `${url}#this`, name: 'Cotton tote', image: '/tote.jpg', offers: { price: '25.50', priceCurrency: 'USD', seller: { name: 'Tote Studio' } } };
  const duplicate = { ...product, url, image: '/larger-tote.jpg' };
  const { api } = provider(`<script type="application/ld+json">${JSON.stringify(product)}</script><script type="application/ld+json">${JSON.stringify(duplicate)}</script><h1>Cotton tote</h1>`);
  const response = await api.POST(request());
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.displayProducts[0].price, 25.5);
  assert.equal(data.displayProducts[0].seller, 'Tote Studio');
});

test('prefers sale price over struck out regular price and ignores related products', async () => {
  const product = { '@type': 'Product', name: 'Cotton tote', offers: { price: '20.00', priceCurrency: 'USD' } };
  const { api } = provider(`<script type="application/ld+json">${JSON.stringify(product)}</script><h1>Cotton tote</h1><p>Regular price <del>$30.00</del></p><p>Sale price $20.00</p>`);
  const data = await (await api.POST(request())).json();
  assert.equal(data.displayProducts[0].price, 20);
});

test('parses German decimal comma and localizes search', async () => {
  const { api } = provider('<meta property="product:price:currency" content="EUR"><meta property="product:price:amount" content="19,95"><h1>Cotton tote</h1>', { location: 'DE' });
  const data = await (await api.POST(request('EU'))).json();
  assert.equal(data.displayProducts[0].price, 19.95);
  assert.equal(data.currency, 'EUR');
});

test('extracts Shopify Open Graph price metadata', async () => {
  const html = '<meta property="og:price:currency" content="EUR"><meta property="og:price:amount" content="6,50"><meta property="og:image" content="/napkin.jpg"><h1>Cotton napkins</h1>';
  const { api } = provider(html, { location: 'DE' });
  const data = await (await api.POST(request('EU'))).json();
  assert.equal(data.displayProducts[0].price, 6.5);
  assert.equal(data.displayProducts[0].imageUrl, 'https://shop.example/napkin.jpg');
});

for (const [label, html] of [
  ['ambiguous variant prices', '<h1>Cotton tote</h1><p>$15.00</p><p>$20.00</p>'],
  ['shipping-only amount', '<h1>Cotton tote</h1><p>Shipping: $5.00</p>'],
  ['wrong currency', '<h1>Cotton tote</h1><p>CAD $20.00</p>'],
  ['bare number', '<h1>Cotton tote</h1><p>Price: 20</p>'],
  ['price range', '<h1>Cotton tote</h1><p>$15.00 - $20.00</p>'],
]) {
  test(`does not invent a product price from ${label}`, async () => {
    const { api } = provider(html);
    const response = await api.POST(request());
    assert.equal(response.status, 422);
    assert.equal((await response.json()).skipped.length, 1);
  });
}

test('keeps successful page when another page is blocked', async () => {
  const other = 'https://shop.example/products/other-tote';
  const { api } = provider('', {
    results: [{ url, title: 'Cotton tote' }, { url: other, title: 'Other tote' }],
    fetchResult: { results: [{ url, text: '<meta property="product:price:currency" content="USD"><meta property="product:price:amount" content="19.99"><h1>Cotton tote</h1>' }], errors: [{ url: other, error: 'bot_blocked' }] },
  });
  const data = await (await api.POST(request())).json();
  assert.equal(data.displayProducts.length, 1);
  assert.equal(data.skipped[0].reason, 'bot_blocked');
});

test('filters search-engine links without fetching them', async () => {
  const { api, calls } = provider('', { results: [{ url: 'https://google.com/search?q=totes' }] });
  assert.equal((await api.POST(request())).status, 422);
  assert.equal(calls.length, 2);
});

test('reserves marketplace candidates alongside general seller pages', async () => {
  const sellerUrls = Array.from({ length: 5 }, (_, index) => ({ url: `https://seller${index}.example/products/tote`, title: `Seller tote ${index}` }));
  const marketplaceUrls = [
    { url: 'https://www.amazon.com/dp/ABC123', title: 'Amazon tote' },
    { url: 'https://www.etsy.com/listing/123/tote', title: 'Etsy tote' },
    { url: 'https://www.ebay.com/itm/456', title: 'eBay tote' },
  ];
  let fetchedUrls = [];
  const api = route(async (endpoint, init) => {
    const parsed = new URL(endpoint);
    if (parsed.hostname === 'api.search.tinyfish.ai') {
      return Response.json({ results: parsed.searchParams.get('query').includes('site:amazon') ? marketplaceUrls : sellerUrls });
    }
    fetchedUrls = JSON.parse(init.body).urls;
    return Response.json({ results: fetchedUrls.map((pageUrl) => ({ url: pageUrl, text: '<h1>Tote</h1><p>$20.00</p>' })), errors: [] });
  });
  const data = await (await api.POST(request())).json();
  assert.equal(fetchedUrls.length, 7);
  assert.equal(fetchedUrls.filter((pageUrl) => /amazon|etsy|ebay/.test(pageUrl)).length, 3);
  assert.equal(data.searched.marketplaceCandidatesSelected, 3);
});

test('uses direct marketplace product links and rejects marketplace filter pages', async () => {
  const marketplaceResults = [
    { url: 'https://www.amazon.com/s?k=cotton+tote&rh=p_36%3A1000-3000', title: 'Amazon tote search' },
    { url: 'https://www.amazon.com/dp/B0DIRECT123', title: 'Direct Amazon tote' },
  ];
  let fetchedUrls = [];
  const api = route(async (endpoint, init) => {
    const parsed = new URL(endpoint);
    if (parsed.hostname === 'api.search.tinyfish.ai') {
      return Response.json({ results: parsed.searchParams.get('query').includes('site:amazon') ? marketplaceResults : [] });
    }
    fetchedUrls = JSON.parse(init.body).urls;
    return Response.json({ results: [{ url: fetchedUrls[0], text: '<meta property="product:price:currency" content="USD"><meta property="product:price:amount" content="24.00"><h1>Direct Amazon tote</h1>' }], errors: [] });
  });
  const data = await (await api.POST(request())).json();
  assert.deepEqual(fetchedUrls, ['https://www.amazon.com/dp/B0DIRECT123']);
  assert.equal(data.displayProducts[0].productUrl, 'https://www.amazon.com/dp/B0DIRECT123');
  assert.equal(data.searched.marketplaceCandidatesSelected, 1);
});

test('rejects a listing page containing multiple structured products', async () => {
  const listingUrl = 'https://shop.example/products/tote-collection';
  const listing = {
    '@graph': [
      { '@type': 'Product', name: 'Small tote', offers: { price: '12.00', priceCurrency: 'USD' } },
      { '@type': 'Product', name: 'Large tote', offers: { price: '34.00', priceCurrency: 'USD' } },
    ],
  };
  const { api } = provider(`<h1>Tote bags</h1><script type="application/ld+json">${JSON.stringify(listing)}</script>`, {
    results: [{ url: listingUrl, title: 'Tote bags' }],
    fetchResult: { results: [{ url: listingUrl, title: 'Tote bags', text: `<h1>Tote bags</h1><script type="application/ld+json">${JSON.stringify(listing)}</script>` }], errors: [] },
  });
  const response = await api.POST(request());
  assert.equal(response.status, 422);
  assert.equal((await response.json()).skipped.length, 1);
});

test('stops at allowance error with no retries or paid fallback', async () => {
  let calls = 0;
  const api = route(async (endpoint) => {
    calls++;
    assert.equal(new URL(endpoint).hostname, 'api.search.tinyfish.ai');
    return Response.json({}, { status: 402 });
  });
  const response = await api.POST(request());
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /allowance/);
  assert.equal(calls, 2);
});

test('wholesale and old run requests cannot reach a paid endpoint', async () => {
  const api = route(async () => { throw new Error('Unexpected provider call'); });
  assert.equal((await api.POST(request('US', { stage: 'wholesale' }))).status, 400);
  assert.equal((await api.GET()).status, 410);
});
