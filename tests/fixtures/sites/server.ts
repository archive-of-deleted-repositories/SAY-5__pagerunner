/* eslint-disable no-console */
import { createServer } from 'node:http';

/**
 * Minimal deterministic mock target site for browser-driven integration
 * tests. Routes intentionally serve static HTML; nothing here mutates state
 * across requests so two runs against the same path produce byte-identical
 * responses, which is the baseline for replay determinism assertions.
 */
const PORT = Number(process.env.MOCK_PORT ?? 4080);

const ROUTES: Record<string, string> = {
  '/login': `<!doctype html><html><body>
    <form id="f"><input id="user"/><input id="pw"/><button id="submit">go</button></form>
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
};

const server = createServer((req, res) => {
  const path = (req.url ?? '/').split('?')[0] ?? '/';
  const body = ROUTES[path] ?? `<!doctype html><html><body>${path}</body></html>`;
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(body);
});

server.listen(PORT, () => {
  console.info(`mock site listening on ${PORT}`);
});
