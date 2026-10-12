const fs = require('node:fs');

async function main() {
  const env = fs.existsSync('.env.local') ? fs.readFileSync('.env.local', 'utf8') : '';
  const keys = fs.existsSync('API keys.txt') ? fs.readFileSync('API keys.txt', 'utf8') : '';
  const key = process.env.TINYFISH_API_KEY || /TINYFISH_API_KEY\s*=\s*([^\s]+)/.exec(env)?.[1] || /sk-tinyfish-[A-Za-z0-9_-]+/.exec(keys)?.[0];
  if (!key) throw new Error('No local API key configured.');
  const response = await fetch('https://agent.tinyfish.ai/v1/runs?limit=3', { headers: { 'X-API-Key': key }, signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`Run history request returned HTTP ${response.status}.`);
  const payload = await response.json();
  const runs = Array.isArray(payload) ? payload : payload.runs ?? payload.data ?? [];
  if (!Array.isArray(runs)) { console.log('History response fields:', Object.keys(payload)); return; }
  for (const run of runs.slice(0, 3)) {
    let result = run.result;
    if (typeof result === 'string') { try { result = JSON.parse(result); } catch {} }
    console.log(JSON.stringify({ id: run.run_id ?? run.id, status: run.status, resultType: typeof run.result, resultFields: result && typeof result === 'object' ? Object.keys(result) : [], products: result?.products?.length, samples: result?.products?.slice(0, 2).map((product) => ({ fields: Object.keys(product), title: product.title ?? product.name, price: product.price, hasImage: Boolean(product.imageUrl ?? product.image_url ?? product.image), productUrl: product.productUrl ?? product.product_url ?? product.url })), error: run.error ?? result?.error ?? null }));
  }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
