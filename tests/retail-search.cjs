const test = require('node:test');
const assert = require('node:assert/strict');
const { route } = require('./route-loader.cjs');
const url = 'https://shop.example/products/cotton-tote';
const request = (region = 'US', extra = {}) => new Request('https://app.example/api/search-products', { method: 'POST', body: JSON.stringify({ productName: 'Cotton tote', region, imageDataUrl: 'data:image/jpeg;base64,YQ==', ...extra }) });

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
    assert.ok(body.urls.length <= 6);
    assert.equal(body.format, 'html');
    return Response.json(options.fetchResult ?? { results: [{ url, title: 'Cotton tote', text: html }], errors: [] });
  };
  return { api: route(fetch), calls };
}

test('requires a product image', async () => {
  const { api, calls } = provider('<h1>Cotton tote</h1><p>$19.99</p>');
  const response = await api.POST(new Request('https://app.example/api/search-products', {
    method: 'POST', body: JSON.stringify({ productName: 'Cotton tote', region: 'US' }),
  }));
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /image is required/i);
  assert.equal(calls.length, 0);
});

test('extracts a single requested-currency price from primary PDP text', async () => {
  const { api, calls } = provider('<h1>Cotton tote</h1><p>$19.99</p>');
  const response = await api.POST(request());
  assert.equal(response.status, 200);
  assert.equal((await response.json()).displayProducts[0].price, 19.99);
  assert.deepEqual(calls, ['api.search.tinyfish.ai', 'api.search.tinyfish.ai', 'api.fetch.tinyfish.ai']);
});

test('extracts TinyFish simplified Shopify PDP text', async () => {
  const html = '<html><body><h1>Napkin - Soft Cotton Club</h1><p>Regular price €6,50 EUR</p><p>Quantity</p><p>20 Soft Luxury napkins, 40 x 40 cm.</p></body></html>';
  const { api } = provider(html, { location: 'DE' });
  const data = await (await api.POST(request('EU'))).json();
  assert.equal(data.displayProducts[0].price, 6.5);
  assert.match(data.displayProducts[0].notes, /primary PDP text/);
});

test('searches Australia and extracts an AUD price from an Australian PDP', async () => {
  const australianUrl = 'https://shop.example.com.au/products/cotton-tote';
  const html = '<meta property="product:price:currency" content="AUD"><meta property="product:price:amount" content="39.95"><h1>Cotton tote</h1>';
  const { api } = provider('', {
    location: 'AU',
    results: [{ url: australianUrl, title: 'Cotton tote AUD 39.95' }],
    fetchResult: { results: [{ url: australianUrl, text: html }], errors: [] },
  });
  const data = await (await api.POST(request('AU'))).json();
  assert.equal(data.currency, 'AUD');
  assert.equal(data.displayProducts[0].price, 39.95);
});

test('does not visit a UK-domain candidate for an Australian search', async () => {
  const { api } = provider('', {
    location: 'AU',
    results: [{ url: 'https://shop.example.co.uk/products/cotton-tote', title: 'Cotton tote GBP 20.00' }],
    marketplaceResults: [],
  });
  const response = await api.POST(request('AU'));
  assert.equal(response.status, 422);
  assert.match((await response.json()).error, /No direct retail product links/);
});

test('uses explicit seller and product image from structured offer', async () => {
  const product = { '@type': 'Product', name: 'Cotton tote', image: '/tote.jpg', offers: { price: '25.50', priceCurrency: 'USD', seller: { name: 'Tote Studio' } } };
  const { api } = provider(`<script type="application/ld+json">${JSON.stringify(product)}</script><h1>Cotton tote</h1>`);
  const data = await (await api.POST(request())).json();
  assert.equal(data.displayProducts[0].price, 25.5);
  assert.equal(data.displayProducts[0].seller, 'Tote Studio');
  assert.equal(data.displayProducts[0].imageUrl, 'https://shop.example/tote.jpg');
});

test('uses the independent website name when no separate seller is listed', async () => {
  const storeUrl = 'https://uniquehomefurniture.co.uk/products/cotton-tote';
  const { api } = provider('', {
    location: 'GB',
    results: [{ url: storeUrl, title: 'Cotton tote' }],
    fetchResult: { results: [{ url: storeUrl, text: '<meta property="og:site_name" content="Unique Home Furniture"><h1>Cotton tote</h1><p>£19.99</p>' }], errors: [] },
  });
  const data = await (await api.POST(request('UK'))).json();
  assert.equal(data.displayProducts[0].marketplace, 'Seller website');
  assert.equal(data.displayProducts[0].seller, 'Unique Home Furniture');
});

test('uses an Etsy shop name and rejects seller policy instructions', async () => {
  const etsyUrl = 'https://www.etsy.com/uk/listing/123/cotton-tote';
  const html = '<h1>Cotton tote</h1><a href="/uk/shop/ToteStudio">ToteStudio</a><p>£24.00</p><p>Seller does not accept returns</p>';
  const { api } = provider('', {
    location: 'GB',
    marketplaceResults: [{ url: etsyUrl, title: 'Cotton tote' }],
    results: [],
    fetchResult: { results: [{ url: etsyUrl, text: html }], errors: [] },
  });
  const data = await (await api.POST(request('UK'))).json();
  assert.equal(data.displayProducts[0].marketplace, 'Etsy');
  assert.equal(data.displayProducts[0].seller, 'ToteStudio');
});

test('does not treat marketplace return instructions as a seller name', async () => {
  const etsyUrl = 'https://www.etsy.com/uk/listing/124/cotton-tote';
  const { api } = provider('', {
    location: 'GB',
    marketplaceResults: [{ url: etsyUrl, title: 'Cotton tote' }],
    results: [],
    fetchResult: { results: [{ url: etsyUrl, text: '<h1>Cotton tote</h1><p>£24.00</p><p>Seller does not accept returns</p>' }], errors: [] },
  });
  const data = await (await api.POST(request('UK'))).json();
  assert.equal(data.displayProducts[0].seller, 'Not listed');
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

test('adds structured dimensions to both text discovery queries', async () => {
  const queries = [];
  const api = route(async (endpoint, init) => {
    const parsed = new URL(endpoint);
    if (parsed.hostname === 'api.search.tinyfish.ai') {
      queries.push(parsed.searchParams.get('query'));
      return Response.json({ results: parsed.searchParams.get('query').includes('site:amazon') ? [] : [{ url, title: 'Cotton tote 30 x 20 x 10 cm' }] });
    }
    return Response.json({ results: [{ url, text: '<h1>Cotton tote 30 x 20 x 10 cm</h1><p>$19.99</p>' }], errors: [] });
  });
  const response = await api.POST(request('US', { dimensions: { length: '30', width: '20', height: '10', unit: 'cm' } }));
  assert.equal(response.status, 200);
  assert.equal(queries.length, 2);
  assert.ok(queries.every((query) => query.includes('30 x 20 x 10 cm')));
});

test('ranks stronger attribute matches before unrelated candidates', async () => {
  const bestUrl = 'https://best.example/products/cotton-tote-30x20';
  let fetchedUrls = [];
  const api = route(async (endpoint, init) => {
    const parsed = new URL(endpoint);
    if (parsed.hostname === 'api.search.tinyfish.ai') {
      return Response.json({ results: parsed.searchParams.get('query').includes('site:amazon') ? [] : [
        { url: 'https://other.example/products/leather-bag', title: 'Leather shoulder bag' },
        { url: bestUrl, title: 'Cotton tote bag 30 x 20 x 10 cm' },
      ] });
    }
    fetchedUrls = JSON.parse(init.body).urls;
    return Response.json({ results: fetchedUrls.map((pageUrl) => ({ url: pageUrl, text: `<h1>${pageUrl === bestUrl ? 'Cotton tote bag 30 x 20 x 10 cm' : 'Leather shoulder bag'}</h1><p>$20.00</p>` })), errors: [] });
  });
  const response = await api.POST(request('US', { material: 'cotton', dimensions: { length: '30', width: '20', height: '10', unit: 'cm' } }));
  assert.equal(response.status, 200);
  assert.equal(fetchedUrls[0], bestUrl);
  assert.equal((await response.json()).displayProducts[0].productUrl, bestUrl);
});

test('extracts Shopify Open Graph price metadata', async () => {
  const html = '<meta property="og:price:currency" content="EUR"><meta property="og:price:amount" content="6,50"><meta property="og:image" content="/napkin.jpg"><h1>Cotton napkins</h1>';
  const { api } = provider(html, { location: 'DE' });
  const data = await (await api.POST(request('EU'))).json();
  assert.equal(data.displayProducts[0].price, 6.5);
  assert.equal(data.displayProducts[0].imageUrl, 'https://shop.example/napkin.jpg');
});

test('extracts a requested-currency price from a primary PDP price element', async () => {
  const { api } = provider('<h1>Cotton tote</h1><div class="price__regular"><span class="price-item--regular">Regular price $19.99 USD</span></div>');
  const data = await (await api.POST(request())).json();
  assert.equal(data.displayProducts[0].price, 19.99);
  assert.match(data.displayProducts[0].notes, /primary price element/);
});

test('does not use a related-product card price as the PDP price', async () => {
  const { api } = provider('<h1>Cotton tote</h1><section class="related-products"><article class="product-card"><span class="price-item--regular">$19.99</span></article></section>');
  assert.equal((await api.POST(request())).status, 422);
});

test('rejects a free pattern page with accessory prices', async () => {
  const html = '<h1>Free Fresh Mesh Crochet Tote Bag Pattern</h1><p>Free Download</p><section><h2>Accessories</h2><p>$6.34</p></section>';
  const { api } = provider(html);
  assert.equal((await api.POST(request())).status, 422);
});

test('uses the current sale price from an Endource-style primary offer', async () => {
  const html = '<h1>HUSH Newport Woven Tote Bag</h1><p>£90.00 £45.00</p><p>buy from Hush</p><h2>Product Details</h2>';
  const { api } = provider(html, { location: 'GB' });
  const data = await (await api.POST(request('UK'))).json();
  assert.equal(data.displayProducts[0].price, 45);
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
    const data = await response.json();
    assert.equal(data.searched.pagesAccessed, 1);
    assert.equal(data.searched.validPagesFound, 0);
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
  assert.equal(data.searched.pagesAccessed, 1);
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
  assert.equal(fetchedUrls.length, 6);
  assert.equal(fetchedUrls.filter((pageUrl) => /amazon|etsy|ebay/.test(pageUrl)).length, 3);
  assert.equal(data.searched.validPagesFound, 6);
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
});

test('prioritizes visual matches and deletes the temporary image', async () => {
  const visualUrl = 'https://visual-shop.example/products/cotton-tote-42';
  let deletedReceipt = '';
  const api = route(async (endpoint, init) => {
    const parsed = new URL(endpoint);
    if (parsed.hostname === 'www.searchapi.io') {
      assert.equal(parsed.searchParams.get('search_type'), 'visual_matches');
      assert.match(parsed.searchParams.get('q'), /Cotton tote/);
      return Response.json({ visual_matches: [{ link: visualUrl, title: 'Visual cotton tote', image: { link: 'https://visual-shop.example/tote.jpg' } }] });
    }
    if (parsed.hostname === 'api.search.tinyfish.ai') return Response.json({ results: [] });
    return Response.json({ results: [{ url: visualUrl, text: '<h1>Visual cotton tote</h1><p>$24.00 USD</p>' }], errors: [] });
  }, 'test-key', {
    passthroughSearchApi: true,
    uploadReference: async () => ({ url: 'https://blob.example/reference.jpg', receipt: 'cleanup-receipt' }),
    deleteReference: async (receipt) => { deletedReceipt = receipt; },
  });
  const response = await api.POST(request('US', { imageDataUrl: 'data:image/jpeg;base64,YQ==' }));
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.displayProducts[0].productUrl, visualUrl);
  assert.equal(data.displayProducts[0].imageUrl, 'https://visual-shop.example/tote.jpg');
  assert.equal(data.searched.visualMatchesReturned, 1);
  assert.equal(deletedReceipt, 'cleanup-receipt');
});

test('does not fetch visual listing pages or pattern candidates', async () => {
  let fetchedUrls = [];
  const api = route(async (endpoint, init) => {
    const parsed = new URL(endpoint);
    if (parsed.hostname === 'www.searchapi.io') {
      return Response.json({ visual_matches: [
        { link: 'https://www.etsy.com/market/tote_bags', title: 'Tote bags' },
        { link: 'https://patterns.example/products/free-tote', title: 'Free crochet tote pattern' },
        { link: 'https://shop.example/products/real-tote', title: 'Handmade tote bag' },
      ] });
    }
    if (parsed.hostname === 'api.search.tinyfish.ai') return Response.json({ results: [] });
    fetchedUrls = JSON.parse(init.body).urls;
    return Response.json({ results: [{ url: fetchedUrls[0], text: '<h1>Handmade tote bag</h1><p>$38.00</p>' }], errors: [] });
  }, 'test-key', {
    passthroughSearchApi: true,
    uploadReference: async () => ({ url: 'https://blob.example/reference.jpg', receipt: 'receipt' }),
    deleteReference: async () => undefined,
  });
  const response = await api.POST(request('US', { imageDataUrl: 'data:image/jpeg;base64,YQ==' }));
  assert.equal(response.status, 200);
  assert.deepEqual(fetchedUrls, ['https://shop.example/products/real-tote']);
});

test('does not visit Indian candidates for an EU search', async () => {
  const indianUrl = 'https://indianbrand.in/products/cotton-tote';
  const euUrl = 'https://eushop.de/products/cotton-tote';
  let fetchedUrls = [];
  const api = route(async (endpoint, init) => {
    const parsed = new URL(endpoint);
    if (parsed.hostname === 'api.search.tinyfish.ai') {
      return Response.json({ results: parsed.searchParams.get('query').includes('site:amazon') ? [] : [
        { url: indianUrl, title: 'Cotton tote Rs. 1,999 India' },
        { url: euUrl, title: 'Cotton tote EUR 29.00' },
      ] });
    }
    fetchedUrls = JSON.parse(init.body).urls;
    return Response.json({ results: [{ url: euUrl, text: '<h1>Cotton tote</h1><p>€29.00</p>' }], errors: [] });
  });
  const response = await api.POST(request('EU'));
  assert.equal(response.status, 200);
  assert.deepEqual(fetchedUrls, [euUrl]);
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
  assert.equal((await response.json()).searched.validPagesFound, 0);
});

test('continues through every candidate batch until candidates are exhausted', async () => {
  const candidates = Array.from({ length: 14 }, (_, index) => ({
    url: `https://seller${index}.example/products/tote`, title: `Cotton tote ${index}`,
  }));
  const visited = [];
  const api = route(async (endpoint, init) => {
    const parsed = new URL(endpoint);
    if (parsed.hostname === 'api.search.tinyfish.ai') {
      return Response.json({ results: parsed.searchParams.get('query').includes('site:amazon') ? [] : candidates });
    }
    const urls = JSON.parse(init.body).urls;
    visited.push(...urls);
    return Response.json({ results: urls.map((pageUrl) => ({ url: pageUrl, text: '<h1>Cotton tote</h1><p>Price unavailable</p>' })), errors: [] });
  });
  const response = await api.POST(request());
  assert.equal(response.status, 422);
  assert.equal(visited.length, 14);
  const data = await response.json();
  assert.deepEqual(Object.keys(data.searched).sort(), ['pagesAccessed', 'validPagesFound', 'visualMatchesReturned']);
  assert.equal(data.searched.pagesAccessed, 14);
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
