const fs = require('node:fs');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const { load } = require('cheerio');

function route(fetch, key = 'test-key') {
  const source = fs.readFileSync('app/api/search-products/route.ts', 'utf8');
  const compiled = stripTypeScriptTypes(source).replace(/^import .*;$/gm, '').replace(/^export /gm, '') + '\nexports.POST = POST; exports.GET = GET;';
  const exports = {};
  vm.runInNewContext(compiled, {
    exports, fetch, Request, Response, URL, URLSearchParams, AbortSignal, console, load,
    NextResponse: Response, existsSync: fs.existsSync, readFileSync: fs.readFileSync,
    join: require('node:path').join, process: { env: { TINYFISH_API_KEY: key } },
  });
  return exports;
}
module.exports = { route };
