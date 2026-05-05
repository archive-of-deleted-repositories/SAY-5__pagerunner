'use strict';
Object.defineProperty(exports, '__esModule', { value: true });
exports.stop = exports.start = exports.buildServer = void 0;
/* eslint-disable no-console */
const node_http_1 = require('node:http');
/**
 * Minimal deterministic mock target site for browser-driven integration
 * tests. Routes intentionally serve static HTML; nothing here mutates state
 * across requests so two runs against the same path produce byte-identical
 * responses, which is the baseline for replay determinism assertions.
 */
const ROUTES = {
  '/login': `<!doctype html><html><body>
    <form id="f"><input id="user"/><input id="pw"/><button id="submit">go</button></form>
    <script>console.log('login page loaded');</script>
  </body></html>`,
  '/profile': `<!doctype html><html><body><h1 id="profile-name">alice</h1></body></html>`,
  '/search': `<!doctype html><html><body>
    <input id="q"/><button id="go">search</button>
    <ul><li class="result"><a href="#">first</a></li></ul>
  </body></html>`,
  '/list': `<!doctype html><html><body>
    <ul><li class="item">one</li><li class="item">two</li></ul>
    <a rel="next" href="/list?p=2">next</a>
  </body></html>`,
  '/form': `<!doctype html><html><body>
    <input id="email"/><button id="next">next</button>
    <input id="zip"/><button id="submit">submit</button>
    <div class="success">ok</div>
  </body></html>`,
  '/slow': `<!doctype html><html><body><div id="ready">ready</div></body></html>`,
};
const buildServer = () =>
  (0, node_http_1.createServer)((req, res) => {
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    const body = ROUTES[path] ?? `<!doctype html><html><body>${path}</body></html>`;
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(body);
  });
exports.buildServer = buildServer;
const start = (port = 0) =>
  new Promise((resolve) => {
    const server = (0, exports.buildServer)();
    server.listen(port, () => {
      const addr = server.address();
      const actual = typeof addr === 'object' && addr ? addr.port : port;
      resolve({ server, port: actual, url: `http://127.0.0.1:${actual}` });
    });
  });
exports.start = start;
const stop = (server) => new Promise((resolve) => server.close(() => resolve()));
exports.stop = stop;
if (require.main === module) {
  const port = Number(process.env.MOCK_PORT ?? 4080);
  (0, exports.start)(port).then(({ url }) => console.info(`mock site listening on ${url}`));
}
//# sourceMappingURL=server.js.map
