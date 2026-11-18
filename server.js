import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import pkg from '@croo-network/sdk';
import { analyze } from './debugger.js';

const { AgentClient, EventType, DeliverableType } = pkg;

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb', strict: false }));
app.use(express.text({ type: '*/*', limit: '1mb' }));

const config = {
  baseURL: process.env.CROO_API_URL,
  wsURL:   process.env.CROO_WS_URL,
  rpcURL:  process.env.CROO_RPC_URL || 'https://mainnet.base.org',
  logger:  { debug: () => {}, info: console.log, warn: console.warn, error: console.error },
};

const SDK_KEY = process.env.CROO_API_KEY;
const SELF_URL = process.env.RENDER_EXTERNAL_URL || null;

// ════════════════════════════════════════════════════════════════════
// INPUT EXTRACTION
// CROO wraps order requirements in layers such as {"text":"<payload>"}.
// Unwrap only that wrapper — never touch the user's own JSON.
// ════════════════════════════════════════════════════════════════════

const OBJECT_WRAPPER_FIELDS = ['input', 'payload', 'requirements', 'requirement', 'text'];

function extractInput(raw) {
  let v = raw;
  for (let depth = 0; depth < 4; depth++) {
    if (typeof v === 'string') {
      const t = v.trim();
      if (t.startsWith('{')) {
        try {
          const o = JSON.parse(t);
          const keys = o && typeof o === 'object' && !Array.isArray(o) ? Object.keys(o) : [];
          if (keys.length === 1 && keys[0] === 'text' && typeof o.text === 'string') { v = o.text; continue; }
          if (keys.length === 1 && OBJECT_WRAPPER_FIELDS.includes(keys[0]) && o[keys[0]] && typeof o[keys[0]] === 'object') { v = o[keys[0]]; continue; }
        } catch { /* not JSON — treat as plain text */ }
      }
      return v;
    }
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const keys = Object.keys(v);
      const wrapper = OBJECT_WRAPPER_FIELDS.find((k) => k in v && keys.length === 1);
      if (wrapper) { v = v[wrapper]; continue; }
      const named = ['input', 'payload', 'json', 'error', 'body'].find((k) => typeof v[k] === 'string' && keys.length <= 2);
      if (named) { v = v[named]; continue; }
    }
    return typeof v === 'string' ? v : JSON.stringify(v);
  }
  return typeof v === 'string' ? v : JSON.stringify(v);
}

// ════════════════════════════════════════════════════════════════════
// HTTP ROUTES (health + a simple tester you can use from a phone)
// ════════════════════════════════════════════════════════════════════

app.get('/', (_req, res) => {
  res.json({
    status: 'API Error & JSON Debugger online',
    version: '1.0.0',
    endpoints: ['GET /try (browser tester)', 'POST /debug (body = text or JSON)', 'GET /debug?input=...'],
    croo: SDK_KEY ? 'provider key configured' : 'CROO_API_KEY not set',
  });
});

app.get('/try', (_req, res) => {
  res.type('html').send(`<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>API Error &amp; JSON Debugger</title>
<style>
body{font-family:system-ui,sans-serif;margin:0;padding:16px;background:#0f1115;color:#e8eaf0}
h1{font-size:18px;margin:0 0 12px}
textarea{width:100%;min-height:180px;box-sizing:border-box;padding:10px;border-radius:8px;border:1px solid #333;background:#171a21;color:#e8eaf0;font-family:ui-monospace,monospace;font-size:14px}
button{margin:10px 0;padding:12px 18px;border:0;border-radius:8px;background:#6ee754;color:#0f1115;font-weight:700;font-size:15px}
pre{white-space:pre-wrap;word-break:break-word;background:#171a21;padding:12px;border-radius:8px;border:1px solid #333;font-size:13px}
</style></head><body>
<h1>API Error &amp; JSON Debugger</h1>
<textarea id="i" placeholder='Paste JSON, an API error response, or an error message...'>{"name": "test", "items": [1, 2, 3,], 'ok': True}</textarea>
<button id="b">Debug it</button>
<pre id="o">Report will appear here.</pre>
<script>
document.getElementById('b').onclick = async () => {
  const o = document.getElementById('o'); o.textContent = 'Working...';
  try {
    const r = await fetch('/debug', {method:'POST', headers:{'Content-Type':'text/plain'}, body: document.getElementById('i').value});
    const j = await r.json(); o.textContent = j.report || JSON.stringify(j, null, 2);
  } catch (e) { o.textContent = 'Request failed: ' + e.message; }
};
</script></body></html>`);
});

app.post('/debug', (req, res) => {
  try {
    const raw = typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? '');
    // If the client sent {"input": "..."} use that; otherwise analyse the body as-is.
    let input = raw;
    if (req.body && typeof req.body === 'object' && typeof req.body.input === 'string' && Object.keys(req.body).length === 1) input = req.body.input;
    const { report, summary } = analyze(input);
    res.json({ report, summary });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/debug', (req, res) => {
  const { report, summary } = analyze(String(req.query.input ?? ''));
  res.json({ report, summary });
});

// ════════════════════════════════════════════════════════════════════
// CROO ORDER HANDLER
// ════════════════════════════════════════════════════════════════════

async function handleOrder(provider, orderId) {
  let report;
  try {
    const order = await provider.getOrder(orderId);
    console.log('Order received:', orderId);
    const raw = order.requirement || order.requirements || order.requirementText || order.input || order.data || '';
    const input = extractInput(raw);
    report = analyze(input).report;
  } catch (err) {
    console.error('Analysis error:', err.message);
    report = [
      'API ERROR & JSON DEBUGGER REPORT',
      '==============================================',
      'The debugger could not process this order automatically.',
      `Reason: ${err.message}`,
      '',
      'Please place a new order with the JSON or error text pasted as plain text.',
    ].join('\n');
  }
  try {
    const delivery = await provider.deliverOrder(orderId, {
      deliverableType: DeliverableType.Text,
      deliverableText: report,
    });
    console.log('Delivered:', delivery?.txHash);
  } catch (err) {
    console.error('Delivery error:', err.message);
  }
}

// ════════════════════════════════════════════════════════════════════
// PROVIDER LISTENER (WebSocket to CROO)
// ════════════════════════════════════════════════════════════════════

let connected = false;
let reconnectAttempts = 0;

async function startProvider() {
  if (!SDK_KEY) { console.warn('CROO_API_KEY is not set — HTTP routes only, no CROO listener'); return; }
  if (connected) return;
  connected = true;
  try {
    console.log('Starting CROO provider...');
    const provider = new AgentClient(config, SDK_KEY);
    const stream = await provider.connectWebSocket();
    reconnectAttempts = 0;
    console.log('CROO WebSocket connected');

    stream.on(EventType.NegotiationCreated, async (e) => {
      console.log('Negotiation:', e.negotiation_id);
      try {
        const result = await provider.acceptNegotiation(e.negotiation_id);
        console.log('Accepted, order:', result.order.orderId);
      } catch (err) { console.error('Accept error:', err.message); }
    });

    stream.on(EventType.OrderPaid, async (e) => {
      console.log('Payment received:', e.order_id);
      await handleOrder(provider, e.order_id);
    });

    stream.on(EventType.OrderCompleted, (e) => console.log('Order settled:', e.order_id));

    stream.on('close', () => {
      connected = false;
      reconnectAttempts++;
      const delay = Math.min(5000 * reconnectAttempts, 30000);
      console.log(`CROO connection closed — reconnecting in ${delay / 1000}s`);
      setTimeout(startProvider, delay);
    });
    stream.on('error', (err) => console.error('CROO WS error:', err.message));
  } catch (err) {
    connected = false;
    reconnectAttempts++;
    const delay = Math.min(5000 * reconnectAttempts, 30000);
    console.error(`CROO connect failed: ${err.message} — retrying in ${delay / 1000}s`);
    setTimeout(startProvider, delay);
  }
}

// Keep free hosting awake
if (SELF_URL) {
  setInterval(async () => {
    try { await fetch(SELF_URL); console.log('Keep-alive ping'); }
    catch (e) { console.log('Keep-alive failed:', e.message); }
  }, 14 * 60 * 1000);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`API Error & JSON Debugger running on port ${PORT}`);
  startProvider();
});
