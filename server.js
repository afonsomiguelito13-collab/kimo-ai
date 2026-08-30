#!/usr/bin/env node
'use strict';

/**
 * Kimo — zero-dependency Node server.
 *
 *  - Serves the static UI from ./public
 *  - Proxies the xKiro model catalog        GET  /api/models
 *  - Proxies streaming chat completions     POST /api/chat
 *  - Keeps your API key on the server       (see .env / XKIRO_API_KEY)
 *
 * Run:  node server.js
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------- config ---

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');

loadDotEnv(path.join(ROOT, '.env'));

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const UPSTREAM = (process.env.XKIRO_BASE_URL || 'https://api.xkiro.com/v1').replace(/\/+$/, '');
const SERVER_KEY = (process.env.XKIRO_API_KEY || '').trim();

/** Blocking upstream calls die at 95s; streams do not. We still cap our own. */
const STREAM_TIMEOUT_MS = 10 * 60 * 1000;
const CATALOG_TTL_MS = 5 * 60 * 1000;

let catalogCache = { at: 0, body: null };

// ------------------------------------------------------------ dotenv-lite ---

function loadDotEnv(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

// ---------------------------------------------------------------- helpers ---

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function sendJSON(res, status, obj, extraHeaders) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...(extraHeaders || {}),
  });
  res.end(body);
}

function readBody(req, limitBytes = 40 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(Object.assign(new Error('Payload too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function resolveKey(req) {
  const headerKey = String(req.headers['x-xkiro-key'] || '').trim();
  return headerKey || SERVER_KEY;
}

// --------------------------------------------------------------- statics ---

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (urlPath === '/') urlPath = '/index.html';

  const target = path.join(PUBLIC_DIR, path.normalize(urlPath).replace(/^(\.\.[/\\])+/, ''));
  if (!target.startsWith(PUBLIC_DIR)) {
    return sendJSON(res, 403, { error: { message: 'Forbidden' } });
  }

  fs.stat(target, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found');
    }
    const ext = path.extname(target).toLowerCase();
    const etag = `W/"${stat.size}-${Number(stat.mtimeMs).toString(36)}"`;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304);
      return res.end();
    }
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      ETag: etag,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
    });
    fs.createReadStream(target).pipe(res);
  });
}

// ------------------------------------------------------------- /api/models --

async function handleModels(req, res) {
  const now = Date.now();
  if (catalogCache.body && now - catalogCache.at < CATALOG_TTL_MS) {
    return sendJSON(res, 200, catalogCache.body);
  }

  const key = resolveKey(req);
  const headers = { Accept: 'application/json' };
  if (key) headers.Authorization = `Bearer ${key}`;

  try {
    const upstream = await fetch(`${UPSTREAM}/models`, {
      headers,
      signal: AbortSignal.timeout(20000),
    });
    const text = await upstream.text();
    if (!upstream.ok) {
      return sendJSON(res, upstream.status, {
        error: { message: `Catalog fetch failed (HTTP ${upstream.status})`, detail: text.slice(0, 500) },
      });
    }
    const json = JSON.parse(text);
    catalogCache = { at: now, body: json };
    return sendJSON(res, 200, json);
  } catch (err) {
    if (catalogCache.body) return sendJSON(res, 200, catalogCache.body);
    return sendJSON(res, 502, {
      error: { message: `Could not reach ${UPSTREAM}/models: ${err.message}` },
    });
  }
}

// ------------------------------------------------------------- /api/health --

function handleHealth(req, res) {
  sendJSON(res, 200, {
    ok: true,
    upstream: UPSTREAM,
    serverKeyConfigured: Boolean(SERVER_KEY),
    serverKeyShape: SERVER_KEY ? keyShapeComplaint(SERVER_KEY) : null,
    node: process.version,
  });
}

// --------------------------------------------------------------- /api/verify --

/**
 * Actually prove a key works.
 *
 * GET /v1/models is PUBLIC on xKiro — it returns 200 for a garbage key, or no
 * key at all. So a populated model list says nothing about authentication.
 * The only honest test is a real (tiny) completion.
 */
async function handleVerify(req, res) {
  const key = resolveKey(req);
  // The browser tests whatever is in the Settings box, which may be a key the
  // user just typed and has NOT saved yet. Saying "saved in this browser" in
  // that case is a lie that sends people looking in the wrong place.
  const origin = String(req.headers['x-xkiro-key-origin'] || '').trim();
  const source = String(req.headers['x-xkiro-key'] || '').trim()
    ? (origin === 'typed'
        ? 'the key you just typed (not saved yet)'
        : 'the key saved in this browser')
    : (SERVER_KEY ? 'the key in your .env file' : null);

  if (!key) {
    return sendJSON(res, 200, {
      ok: false,
      reason: 'missing',
      source: null,
      message: 'No key anywhere. Paste one in Settings, or put XKIRO_API_KEY in .env and restart.',
    });
  }

  const shape = keyShapeComplaint(key);

  try {
    const upstream = await fetch(`${UPSTREAM}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'z-ai/glm-5.3-flash',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1,
        stream: false,
      }),
      signal: AbortSignal.timeout(30000),
    });

    let j = null;
    try { j = JSON.parse(await upstream.text()); } catch {}

    if (upstream.ok) {
      return sendJSON(res, 200, { ok: true, source, shape, masked: maskKey(key) });
    }
    if (upstream.status === 401) {
      // A well-formed key that upstream still refuses is not a formatting
      // problem — it does not exist on xKiro's side. Say so, and say what to
      // do, instead of repeating their message and leaving the user stuck.
      return sendJSON(res, 200, {
        ok: false,
        reason: 'rejected',
        source,
        shape,
        masked: maskKey(key),
        verdict: shape
          ? null
          : 'This key is correctly formed, so nothing was mangled in the copy — xKiro simply does not recognise it. It was most likely revoked, deleted, or belongs to a different account. Issue a new one and paste it in.',
        keysUrl: 'https://xkiro.com/dashboard/api/keys',
        message: j?.error?.message || 'Invalid or disabled ClientApiKey.',
      });
    }
    if (upstream.status === 403) {
      // Auth succeeded; the account just cannot reach this particular model.
      return sendJSON(res, 200, {
        ok: true,
        limited: true,
        source,
        shape,
        masked: maskKey(key),
        message: j?.error?.message || 'Key works, but this model is not available on your plan.',
      });
    }
    return sendJSON(res, 200, {
      ok: false,
      reason: 'upstream',
      source,
      shape,
      masked: maskKey(key),
      message: j?.error?.message || `Upstream returned HTTP ${upstream.status}.`,
    });
  } catch (err) {
    return sendJSON(res, 200, {
      ok: false,
      reason: 'network',
      source,
      shape,
      masked: maskKey(key),
      message: `Could not reach ${UPSTREAM} — ${err.message}`,
    });
  }
}

/** Show enough of a key to identify it, never enough to use it. */
function maskKey(k) {
  if (k.length <= 14) return `${k.slice(0, 6)}…`;
  return `${k.slice(0, 9)}…${k.slice(-4)} (${k.length} chars)`;
}

/** Catch the copy-paste damage that produces a 401 with a "correct" key. */
function keyShapeComplaint(k) {
  if (/^Bearer\s/i.test(k)) return 'It starts with "Bearer " — paste only the key itself.';
  if (/^["']|["']$/.test(k)) return 'It is wrapped in quotes — remove them.';
  if (/\s/.test(k)) return 'It contains a space or newline — it was probably split across lines when copied.';
  if (/[\u200B-\u200D\uFEFF\u00A0]/.test(k)) return 'It contains an invisible character from the copy — retype or re-copy it.';
  if (!k.startsWith('sk-xt-')) return 'It does not start with "sk-xt-" — that may be a key for a different service.';
  if (k.length < 20) return 'It looks too short — the copy may have been truncated.';
  return null;
}

// -------------------------------------------------------------- /api/search --

/**
 * Web lookup, server-side so the browser never hits a CORS wall.
 *
 * Layered on purpose. DuckDuckGo's Instant Answer API is the documented,
 * key-free endpoint, but it only answers topic/definition style queries — ask
 * it "who won euro 2024" and every field comes back empty. Their HTML and Lite
 * endpoints would cover that, but both now serve an anti-bot challenge page
 * (HTTP 202 with "anomaly" markup), so scraping them is not an option.
 *
 * So: DuckDuckGo first, Wikipedia second. Wikipedia's API is key-free, stable,
 * and happily answers the factual queries DDG leaves blank.
 */
async function handleSearch(req, res) {
  const q = String(new URL(req.url, 'http://x').searchParams.get('q') || '').trim();
  if (!q) return sendJSON(res, 400, { error: { message: 'Missing ?q=' } });
  if (q.length > 400) return sendJSON(res, 400, { error: { message: 'Query too long.' } });

  const results = [];
  const sources = [];
  let abstract = null;

  // ---- 1. DuckDuckGo Instant Answer -------------------------------------
  try {
    const u = `https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1&skip_disambig=1&t=xkiro-chat`;
    const r = await fetch(u, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(9000) });
    if (r.ok) {
      const d = await r.json();
      const text = (d.AbstractText || '').trim();
      if (text) {
        abstract = { text, url: d.AbstractURL || '', source: d.AbstractSource || 'DuckDuckGo' };
        results.push({ title: d.Heading || q, snippet: text, url: d.AbstractURL || '' });
      }
      if (d.Answer) {
        results.unshift({ title: String(d.AnswerType || 'Answer'), snippet: String(d.Answer), url: '' });
      }
      const flat = (topics, depth = 0) => {
        for (const t of topics || []) {
          if (results.length >= 6) return;
          if (t.Topics && depth < 2) { flat(t.Topics, depth + 1); continue; }
          const s = (t.Text || '').trim();
          if (s) results.push({ title: s.split(' - ')[0].slice(0, 90), snippet: s, url: t.FirstURL || '' });
        }
      };
      flat(d.RelatedTopics);
      if (results.length) sources.push('DuckDuckGo');
    }
  } catch { /* fall through to Wikipedia */ }

  // ---- 2. Wikipedia fallback --------------------------------------------
  if (results.length < 3) {
    try {
      const u = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(q)}&format=json&srlimit=4&srprop=snippet`;
      const r = await fetch(u, {
        headers: { Accept: 'application/json', 'User-Agent': 'xkiro-chat/1.0 (local personal use)' },
        signal: AbortSignal.timeout(9000),
      });
      if (r.ok) {
        const d = await r.json();
        const hits = d?.query?.search || [];
        for (const h of hits) {
          if (results.length >= 6) break;
          const snippet = String(h.snippet || '').replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').trim();
          results.push({
            title: h.title,
            snippet,
            url: `https://en.wikipedia.org/wiki/${encodeURIComponent(h.title.replace(/ /g, '_'))}`,
          });
        }
        if (hits.length) sources.push('Wikipedia');
      }
    } catch { /* both failed */ }
  }

  if (!results.length) {
    return sendJSON(res, 200, {
      ok: false,
      query: q,
      results: [],
      sources: [],
      message: 'No results. Both DuckDuckGo and Wikipedia came back empty.',
    });
  }

  sendJSON(res, 200, { ok: true, query: q, abstract, results: results.slice(0, 6), sources });
}

// --------------------------------------------------------------- /api/chat --

async function handleChat(req, res) {
  let payload;
  try {
    payload = JSON.parse((await readBody(req)).toString('utf8') || '{}');
  } catch (err) {
    return sendJSON(res, err.statusCode || 400, {
      error: { message: err.message || 'Invalid JSON body' },
    });
  }

  const key = resolveKey(req);
  if (!key) {
    return sendJSON(res, 401, {
      error: {
        code: 'no_api_key',
        message:
          'No xKiro API key. Put XKIRO_API_KEY in .env and restart, or paste a key in Settings.',
      },
    });
  }

  const model = String(payload.model || '').trim();
  if (!model || !model.includes('/')) {
    return sendJSON(res, 400, {
      error: {
        message: `Model IDs must include the vendor prefix, e.g. "z-ai/glm-5.3-flash" (got "${model}").`,
      },
    });
  }
  if (!Array.isArray(payload.messages) || payload.messages.length === 0) {
    return sendJSON(res, 400, { error: { message: '"messages" must be a non-empty array.' } });
  }

  // Build the upstream request. Streaming is always on: it dodges the 95s
  // blocking cap and lets the user stop generation mid-flight.
  const body = {
    model,
    messages: payload.messages,
    stream: true,
    stream_options: { include_usage: true },
  };

  if (Number.isFinite(payload.temperature)) body.temperature = clamp(payload.temperature, 0, 2);
  if (Number.isFinite(payload.top_p)) body.top_p = clamp(payload.top_p, 0, 1);
  if (Number.isFinite(payload.max_tokens) && payload.max_tokens > 0) {
    body.max_tokens = Math.floor(payload.max_tokens);
  }
  if (Number.isFinite(payload.frequency_penalty)) {
    body.frequency_penalty = clamp(payload.frequency_penalty, -2, 2);
  }
  if (Number.isFinite(payload.presence_penalty)) {
    body.presence_penalty = clamp(payload.presence_penalty, -2, 2);
  }
  if (Number.isFinite(payload.seed)) body.seed = Math.floor(payload.seed);
  if (payload.response_format) body.response_format = payload.response_format;

  // Omitting reasoning_effort != disabling it. Only send a value when the UI
  // actually chose one; "auto" means "let the model use its own default".
  const effort = payload.reasoning_effort;
  if (typeof effort === 'string' && effort && effort !== 'auto') {
    body.reasoning_effort = effort;
  }

  const controller = new AbortController();
  const onClientGone = () => controller.abort();
  req.on('aborted', onClientGone);
  res.on('close', onClientGone);
  const timeout = setTimeout(() => controller.abort(), STREAM_TIMEOUT_MS);

  let upstream;
  try {
    upstream = await fetch(`${UPSTREAM}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeout);
    if (controller.signal.aborted) return res.end();
    return sendJSON(res, 502, { error: { message: `Upstream unreachable: ${err.message}` } });
  }

  if (!upstream.ok || !upstream.body) {
    clearTimeout(timeout);
    const text = await upstream.text().catch(() => '');
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    const message =
      parsed?.error?.message ||
      parsed?.message ||
      text.slice(0, 600) ||
      `Upstream returned HTTP ${upstream.status}`;
    return sendJSON(res, upstream.status, {
      error: { message, code: parsed?.error?.code, status: upstream.status },
    });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  const reader = upstream.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.writableEnded) res.write(Buffer.from(value));
    }
  } catch (err) {
    if (!controller.signal.aborted && !res.writableEnded) {
      res.write(
        `data: ${JSON.stringify({
          error: { message: `Stream interrupted: ${err.message}`, code: 'stream_error' },
        })}\n\n`
      );
      res.write('data: [DONE]\n\n');
    }
  } finally {
    clearTimeout(timeout);
    if (!res.writableEnded) res.end();
  }
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, Number(n)));
}

// ---------------------------------------------------------------- routing ---

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://x');

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, X-Xkiro-Key',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    });
    return res.end();
  }

  try {
    if (pathname === '/api/health') return handleHealth(req, res);
    if (pathname === '/api/verify') return await handleVerify(req, res);
    if (pathname === '/api/search' && req.method === 'GET') return await handleSearch(req, res);
    if (pathname === '/api/models' && req.method === 'GET') return await handleModels(req, res);
    if (pathname === '/api/chat' && req.method === 'POST') return await handleChat(req, res);
    if (pathname.startsWith('/api/')) {
      return sendJSON(res, 404, { error: { message: `Unknown endpoint ${pathname}` } });
    }
    return serveStatic(req, res);
  } catch (err) {
    console.error('[xkiro-chat]', err);
    if (!res.headersSent) sendJSON(res, 500, { error: { message: err.message } });
    else res.end();
  }
});

server.requestTimeout = 0;
server.headersTimeout = 0;

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error('');
    console.error(`  Port ${PORT} is already in use.`);
    console.error('');
    console.error('  Either Kimo is already running — try opening');
    console.error(`  http://localhost:${PORT} first — or something else has the port.`);
    console.error('');
    console.error('  Stop the other copy:   pkill -f "node server.js"');
    console.error(`  ...or use another:     PORT=${Number(PORT) + 1} node server.js`);
    console.error('');
    process.exit(1);
  }
  if (err.code === 'EACCES') {
    console.error('');
    console.error(`  Not allowed to bind port ${PORT}. Ports below 1024 need root.`);
    console.error('  Pick a higher one:     PORT=3000 node server.js');
    console.error('');
    process.exit(1);
  }
  console.error(`  Server error: ${err.message}`);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  Kimo');
  console.log(`  ├─ local     http://localhost:${PORT}`);
  console.log(`  ├─ upstream  ${UPSTREAM}`);
  console.log(
    `  └─ api key   ${SERVER_KEY ? 'loaded from environment ✓' : 'NOT SET — add it in Settings or .env'}`
  );
  console.log('');
});
