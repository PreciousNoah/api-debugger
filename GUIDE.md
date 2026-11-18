# API Error & JSON Debugger — Setup and CROO Connection Guide

A CROO provider agent that takes broken JSON, API error responses or error
messages and returns a diagnosis, the exact line and column of each problem,
and a corrected version. It is deterministic: no LLM, no paid API, no database.

Tested: the engine passes its test suite, the HTTP routes respond, and the
CROO SDK exports used by the server load correctly (SDK v0.2.1).

---

## 1. Files

| File | Purpose |
|---|---|
| `package.json` | Dependencies (SDK pinned to 0.2.1) and the `npm start` command |
| `debugger.js` | The analysis engine (lenient parser, error knowledge base, report builder) |
| `server.js` | Web server + CROO provider listener |
| `test.js` | Quick self-test (`npm test`) |
| `GUIDE.md` | This guide |

---

## 2. Deploy from a phone (no laptop)

### A. Put the files on GitHub
1. In your phone browser open github.com, tap **+ → New repository**.
2. Name it `api-debugger`. Public or private both work. Tap **Create repository**.
3. Tap **uploading an existing file** (or **Add file → Upload files**).
4. Pick the 5 files from your downloads (`package.json`, `debugger.js`,
   `server.js`, `test.js`, `GUIDE.md`) and tap **Commit changes**.
5. Do NOT upload any `.env` file or anything containing an API key.

### B. Create the CROO agent and get its key
1. Open agent.croo.network → **My Agents → Register Agent**.
2. Enter the name, e.g. `API Debugger`. Tap **Register Agent**.
3. Copy the API key (looks like `croo_sk_...`). It is shown ONCE. Save it in a
   password manager or private note. Never paste it into chat or commit it.
4. On the next screen add:
   - Description (below), tags (Development & Code, Data & Analytics), and ONE service.
   - Service example: name `Debug JSON / API Error`, price `$0.05`, delivery `30 min`.

Description to paste:
> Paste broken JSON, an API error response or an error message and get a clear
> diagnosis: the exact line and column of every problem, plain-English
> explanation, likely causes, and a corrected version. Instant, no data stored.

### C. Deploy on Render
1. render.com → **New + → Web Service** → connect the `api-debugger` repo.
2. Settings: Runtime `Node`, Build Command `npm install`, Start Command `npm start`.
3. Add environment variables (see section 3).
4. Tap **Create Web Service** and wait for **Live**.

### D. Verify (all from the phone browser)
1. `https://YOUR-SERVICE.onrender.com/` → should show `API Error & JSON Debugger online`
   and `provider key configured`.
2. `https://YOUR-SERVICE.onrender.com/try` → paste broken JSON, tap **Debug it**.
3. Render → **Logs** → look for `CROO WebSocket connected`.
4. agent.croo.network → My Agents → the agent should show **ONLINE**.

---

## 3. Environment variables

| Name | Value | Required |
|---|---|---|
| `CROO_API_KEY` | The `croo_sk_...` key of THIS agent | Yes |
| `CROO_API_URL` | Same value your existing `veris-agent` Render service uses (the CROO API base, normally `https://api.croo.network`) | Yes |
| `CROO_WS_URL` | Same as your existing service (normally `wss://api.croo.network/ws`) | Yes |
| `RENDER_EXTERNAL_URL` | Your own Render URL, e.g. `https://api-debugger.onrender.com` (enables the keep-alive ping so the free instance stays awake) | Recommended |
| `CROO_RPC_URL` | Optional. Defaults to `https://mainnet.base.org` | No |

Tip: open the existing `veris-agent` service on Render → Environment and copy
`CROO_API_URL` and `CROO_WS_URL` exactly. Use a NEW `CROO_API_KEY` for this agent.

---

## 4. How the CROO connection works (agent-agnostic spec)

Give this section to any AI coding agent or developer.

**Concept.** A CROO "agent" is an account on agent.croo.network with one or more
priced "services". It earns money when buyers place orders. To fulfil orders it
needs a long-running provider process that holds a WebSocket to CROO using the
agent's SDK key. Listing the agent (dashboard) and running the provider
(your server) are separate steps. Creating agents, services and SDK keys is done
in the CROO dashboard, not through the SDK.

**SDK.** npm package `@croo-network/sdk` (tested with 0.2.1). It exports
`AgentClient`, `EventType`, `DeliverableType`. It is a CommonJS-style default
export, so in ESM use:

```js
import pkg from '@croo-network/sdk';
const { AgentClient, EventType, DeliverableType } = pkg;
```

**Client config.**

```js
const config = {
  baseURL: process.env.CROO_API_URL,   // CROO REST API base
  wsURL:   process.env.CROO_WS_URL,    // CROO WebSocket URL
  rpcURL:  'https://mainnet.base.org', // chain RPC
  logger:  { debug(){}, info: console.log, warn: console.warn, error: console.error },
};
const provider = new AgentClient(config, process.env.CROO_API_KEY);
const stream = await provider.connectWebSocket();
```

**Order lifecycle events** (`EventType`): `NegotiationCreated`, `NegotiationRejected`,
`NegotiationExpired`, `OrderCreated`, `OrderPaid`, `OrderCompleted`,
`OrderRejected`, `OrderExpired`.

**Provider flow.**

1. `NegotiationCreated` → `provider.acceptNegotiation(e.negotiation_id)`
   (returns `result.order.orderId`). Not accepting = the buyer's order never starts.
2. `OrderPaid` → payment is locked in escrow. NOW do the work:
   `const order = await provider.getOrder(e.order_id)`.
3. Read the buyer's input from the first non-empty of
   `order.requirement`, `order.requirements`, `order.requirementText`,
   `order.input`, `order.data`.
4. Deliver: `provider.deliverOrder(orderId, { deliverableType: DeliverableType.Text, deliverableText: '...' })`.
5. `OrderCompleted` → the order settled and the provider is paid.

**Gotchas learned in production.**

- Requirement payloads can arrive wrapped, e.g. `{"text":"<payload>"}`, sometimes
  nested several layers. Unwrap only the wrapper; never alter the buyer's own JSON.
- Always deliver something. If processing fails, deliver an error report rather
  than letting the order hang.
- Emoji and circled digits can be stripped on delivery. Use plain ASCII for
  anything that must survive (`[1] [2] [3]`, `-----`).
- Reconnect on `close` with backoff, and guard against duplicate connections.
- WebSocket `401` means the SDK key is wrong, rotated, or has trailing whitespace.
  Re-copy it; confirm the env var name is `CROO_API_KEY`; redeploy after changing it.
- Render free instances sleep after ~15 minutes idle. The server pings its own
  `RENDER_EXTERNAL_URL` every 14 minutes. Use a paid instance for anything serious.
- Keep SDK keys out of git and out of logs. Rotate any key that was ever printed.
- Each agent needs its OWN key and its own running process (or a separate
  provider connection). Do not reuse one key for two agents.

**Order input contract of this agent.** Free text. Anything pasted is analysed:
broken JSON, an API error response with or without an HTTP status, or an error
message. Output is a plain-text report.

---

## 5. Campaign checklist (CROO Skill Campaign, Nov 16-30, 2026)

Developer track: 10 USDT per valid new agent, FCFS, up to 3 agents per account.

- [ ] Agent is NEW (not VERIS, ZERU or SENTINEL) and is published during the campaign
- [ ] Agent stays listed and ONLINE through Nov 30, 16:00 UTC
- [ ] Order starts AFTER listing, is really delivered, and settles through CAP
- [ ] Buyer is a genuinely separate person with their own wallet
- [ ] Claim form submitted after the order settles

Orders between the same or related wallets can be reviewed and disqualified, and
the freed spot goes to the next agent. Do not buy from your own wallets. Ask a
friend, or post a real offer in the CROO Discord ("free first debug if you place
a small paid order").

Time plan: roughly 40% building (done), 60% listing, testing and finding the
first real customer. The buyer is the uncertain part, not the code.

---

## 6. Troubleshooting

| Symptom | Fix |
|---|---|
| Render build fails | Confirm all files are in the repo ROOT (not a subfolder) |
| `/` works but no "WebSocket connected" | `CROO_API_KEY` missing; check the variable name |
| Logs show `401` | Wrong or rotated key; re-copy it, redeploy |
| Agent not ONLINE in dashboard | Provider not connected; read Render logs |
| Order paid but nothing delivered | Check logs for `Analysis error` / `Delivery error` |
| First request very slow | Free instance was asleep; first request wakes it |

---

## 7. Copy-paste prompt for another AI agent

> I have a Node.js (ESM) project: `package.json`, `server.js`, `debugger.js`,
> `test.js`. It is a CROO provider agent ("API Error & JSON Debugger") that
> uses `@croo-network/sdk` 0.2.1. Read GUIDE.md section 4 for the exact CROO
> connection spec. Help me (1) deploy it on Render as a Web Service
> (Build `npm install`, Start `npm start`), (2) set the env vars from section 3,
> (3) confirm Render logs show "CROO WebSocket connected", and
> (4) debug any 401 or delivery errors. Do not change the scoring/analysis
> logic in `debugger.js`. Never print or commit the API key.
