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
      return Response.json({ results: options.results ?? [{ url, title: 'Cotton tote' }] });
    }
    const body = JSON.parse(init.body);
    assert.ok(body.urls.length <= 7);
    assert.equal(body.format, 'html');
    return Response.json(options.fetchResult ?? { results: [{ url, title: 'Cotton tote', text: html }], errors: [] });
  };
  return { api: route(fetch), calls };
}

test('Search then Fetch yields visible retail price without an image or seller', async () => {
  const { api, calls } = provider('<h1>Cotton tote</h1><p>$19.99</p>');
  const response = await api.POST(request());
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.displayProducts[0].price, 19.99);
  assert.equal(data.displayProducts[0].seller, 'Not listed');
  assert.equal(data.displayProducts[0].imageUrl, '');
  assert.equal(data.providerMode, 'search-fetch');
  assert.deepEqual(calls, ['api.search.tinyfish.ai', 'api.fetch.tinyfish.ai']);
});

test('uses explicit seller and product image from structured offer', async () => {
  const product = { '@type': 'Product', name: 'Cotton tote', image: '/tote.jpg', offers: { price: '25.50', priceCurrency: 'USD', seller: { name: 'Tote Studio' } } };
  const { api } = provider(`<script type="application/ld+json">${JSON.stringify(product)}</script><h1>Cotton tote</h1>`);
  const data = await (await api.POST(request())).json();
  assert.equal(data.displayProducts[0].price, 25.5);
  assert.equal(data.displayProducts[0].seller, 'Tote Studio');
  assert.equal(data.displayProducts[0].imageUrl, 'https://shop.example/tote.jpg');
});

test('prefers sale price over struck out regular price and ignores related products', async () => {
  const { api } = provider('<h1>Cotton tote</h1><p>Regular price <del>$30.00</del></p><p>Sale price $20.00</p><h2>Related products</h2><p>$5.00</p>');
  const data = await (await api.POST(request())).json();
  assert.equal(data.displayProducts[0].price, 20);
});

test('parses German decimal comma and localizes search', async () => {
  const { api } = provider('<h1>Cotton tote</h1><p>Preis: 19,95 €</p>', { location: 'DE' });
  const data = await (await api.POST(request('EU'))).json();
  assert.equal(data.displayProducts[0].price, 19.95);
  assert.equal(data.currency, 'EUR');
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
    fetchResult: { results: [{ url, text: '<h1>Cotton tote</h1><p>$19.99</p>' }], errors: [{ url: other, error: 'bot_blocked' }] },
  });
  const data = await (await api.POST(request())).json();
  assert.equal(data.displayProducts.length, 1);
  assert.equal(data.skipped[0].reason, 'bot_blocked');
});

test('filters search-engine links without fetching them', async () => {
  const { api, calls } = provider('', { results: [{ url: 'https://google.com/search?q=totes' }] });
  assert.equal((await api.POST(request())).status, 422);
  assert.equal(calls.length, 1);
});

test('uses the lowest and highest structured product prices from a listing page', async () => {
  const listingUrl = 'https://shop.example/collections/totes';
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
  const data = await (await api.POST(request())).json();
  assert.equal(data.displayProducts[0].pageType, 'PLP');
  assert.equal(data.displayProducts[0].minPrice, 12);
  assert.equal(data.displayProducts[0].maxPrice, 34);
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
  assert.equal(calls, 1);
});

test('wholesale and old run requests cannot reach a paid endpoint', async () => {
  const api = route(async () => { throw new Error('Unexpected provider call'); });
  assert.equal((await api.POST(request('US', { stage: 'wholesale' }))).status, 400);
  assert.equal((await api.GET()).status, 410);
});
