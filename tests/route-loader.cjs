const fs = require('node:fs');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const { load } = require('cheerio');

function route(fetch, key = 'test-key', services = {}) {
  const source = fs.readFileSync('app/api/search-products/route.ts', 'utf8');
  const compiled = stripTypeScriptTypes(source).replace(/^import .*;$/gm, '').replace(/^export /gm, '') + '\nexports.POST = POST; exports.GET = GET;';
  const exports = {};
  const wrappedFetch = async (endpoint, init) => {
    if (new URL(endpoint).hostname === 'serpapi.com' && !services.passthroughSerpApi) {
      return Response.json({ visual_matches: [] });
    }
    return fetch(endpoint, init);
  };
  vm.runInNewContext(compiled, {
    exports, fetch: wrappedFetch, Request, Response, URL, URLSearchParams, AbortSignal, console, load,
    NextResponse: Response, existsSync: fs.existsSync, readFileSync: fs.readFileSync,
    join: require('node:path').join, process: { cwd: () => require('node:os').tmpdir(), env: { TINYFISH_API_KEY: key, SERPAPI_API_KEY: 'serpapi-test-key', ...services.env } },
    uploadReference: services.uploadReference ?? (async () => ({ url: 'https://blob.example/reference.jpg', receipt: 'receipt' })),
    deleteReference: services.deleteReference ?? (async () => undefined),
  });
  return exports;
}
module.exports = { route };
