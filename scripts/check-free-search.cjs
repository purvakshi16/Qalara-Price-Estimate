const fs = require('node:fs');
const { route } = require('../tests/route-loader.cjs');

async function main() {
  const env = fs.readFileSync('.env.local', 'utf8');
  const key = process.env.TINYFISH_API_KEY || /TINYFISH_API_KEY\s*=\s*([^\s]+)/.exec(env)?.[1];
  if (!key) throw new Error('No local TinyFish API key configured.');
  const api = route(async (endpoint, options) => {
    const host = new URL(endpoint).hostname;
    if (!['api.search.tinyfish.ai', 'api.fetch.tinyfish.ai'].includes(host)) throw new Error('Paid provider endpoint blocked.');
    console.log('Calling:', host);
    return fetch(endpoint, options);
  }, key);
  const response = await api.POST(new Request('http://localhost/api/search-products', { method: 'POST', body: JSON.stringify({ productName: process.argv[2] || 'wooden bowl', region: 'US' }) }));
  const data = await response.json();
  console.log(JSON.stringify({ status: response.status, error: data.error, skipped: data.skipped, products: data.displayProducts?.map((product) => ({ title: product.title, price: product.price, currency: product.currency, url: product.productUrl, notes: product.notes })) }, null, 2));
  if (!response.ok) process.exitCode = 1;
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
