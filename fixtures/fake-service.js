// Minimal HTTP service for test/services.test.js: it stands in for something like codex-proxy,
// a plain long running HTTP server the hub supervises and proxies under /apps/<id>/.
import http from 'node:http';
import fs from 'node:fs';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};

const port = Number.parseInt(option('port', process.env.FAKE_SERVICE_PORT || '0'), 10);
// With FAKE_SERVICE_MARKER set the first start crashes on purpose, which lets a test watch the
// restart policy kick in without any timing games.
const marker = process.env.FAKE_SERVICE_MARKER;
if (marker && !fs.existsSync(marker)) {
  fs.writeFileSync(marker, 'crashed once');
  console.log('fake-service: crashing on purpose (first start)');
  process.exit(3);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  console.log(`fake-service: ${req.method} ${url.pathname}${url.search}`);

  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // Stands in for codex-proxy's /v1/usage: the hub only reads windows[].remaining_percent and
  // the window length, so the fixture keeps the same nested shape the real service serves.
  if (url.pathname === '/v1/usage') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      plan_type: 'fake',
      limit_reached: false,
      windows: {
        five_hour: {
          label: '5h',
          short_label: '5h',
          slot: 'primary',
          used_percent: 0,
          remaining_percent: 100,
          window_seconds: 18000,
          resets_at: '2026-09-16T05:30:59Z'
        },
        weekly: {
          label: 'weekly',
          short_label: '7d',
          slot: 'secondary',
          used_percent: 94,
          remaining_percent: 6,
          window_seconds: 604800,
          resets_at: '2026-09-19T17:07:57Z'
        }
      }
    }));
    return;
  }

  if (url.pathname === '/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.write('event: message\ndata: one\n\n');
    setTimeout(() => {
      res.write('event: message\ndata: two\n\n');
      res.end();
    }, 40);
    return;
  }

  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      method: req.method,
      path: url.pathname,
      search: url.search,
      body,
      host: req.headers.host || null,
      forwardedFor: req.headers['x-forwarded-for'] || null
    }));
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`fake-service: listening on ${server.address().port}`);
});

// The hub stops services with SIGTERM; exit with code 0 so the state machine sees a clean stop.
process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 300).unref();
});
