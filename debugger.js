// ═══════════════════════════════════════════════════════════════════
// API ERROR & JSON DEBUGGER — core engine
// Deterministic: no LLM, no external APIs. Fast, free, and repeatable.
// ═══════════════════════════════════════════════════════════════════

const MAX_INPUT_CHARS = 200_000;
const MAX_FIXES_SHOWN = 25;
const MAX_OUTPUT_JSON_CHARS = 20_000;

// ─── Helpers ───────────────────────────────────────────────────────

function lineCol(src, pos) {
  let line = 1, col = 1;
  const end = Math.min(pos, src.length);
  for (let k = 0; k < end; k++) {
    if (src[k] === '\n') { line++; col = 1; } else { col++; }
  }
  return { line, col };
}

// ─── Lenient JSON parser ───────────────────────────────────────────
// Parses "almost JSON" and records every repair it had to make.

function lenientParse(src) {
  const fixes = [];
  const warnings = [];
  const n = src.length;
  let i = 0;

  const note = (msg, pos = i) => fixes.push({ msg, ...lineCol(src, pos) });
  const warn = (msg, pos = i) => warnings.push({ msg, ...lineCol(src, pos) });

  function skipWs() {
    while (i < n) {
      const c = src[i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\uFEFF' || c === '\u00A0') { i++; continue; }
      if (c === '/' && src[i + 1] === '/') {
        note('Removed a // comment (comments are not allowed in JSON)');
        while (i < n && src[i] !== '\n') i++;
        continue;
      }
      if (c === '/' && src[i + 1] === '*') {
        note('Removed a /* */ comment (comments are not allowed in JSON)');
        const end = src.indexOf('*/', i + 2);
        i = end === -1 ? n : end + 2;
        continue;
      }
      if (c === '#') {
        note('Removed a # comment (comments are not allowed in JSON)');
        while (i < n && src[i] !== '\n') i++;
        continue;
      }
      break;
    }
  }

  const OPENERS = '"\'\u201C\u201D\u2018\u2019';

  function parseString() {
    const start = i;
    const q = src[i];
    const dbl = q === '"';
    if (!dbl) {
      note(q === "'" ? "Single-quoted string — JSON requires double quotes" : 'Smart/curly quotes used — JSON requires straight double quotes', start);
    }
    const isCloser = (c) => {
      if (q === '"') return c === '"';
      if (q === "'") return c === "'";
      if (q === '\u201C' || q === '\u201D') return c === '\u201C' || c === '\u201D' || c === '"';
      return c === '\u2018' || c === '\u2019' || c === "'";
    };
    i++;
    let buf = '';
    let rawControlNoted = false;
    while (i < n) {
      const c = src[i];
      if (isCloser(c)) { i++; return buf; }
      if (c === '\\') {
        const e = src[i + 1];
        const map = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '/': '/', '\\': '\\', '"': '"', "'": "'" };
        if (e === 'u' && /^[0-9a-fA-F]{4}$/.test(src.slice(i + 2, i + 6))) {
          buf += String.fromCharCode(parseInt(src.slice(i + 2, i + 6), 16));
          i += 6;
        } else if (e in map) {
          if (e === "'") note("Unnecessary escape \\' — not valid in JSON", i);
          buf += map[e];
          i += 2;
        } else {
          note(`Invalid escape sequence \\${e ?? ''} — backslash removed`, i);
          buf += e ?? '';
          i += 2;
        }
        continue;
      }
      if (c === '\n' || c === '\r') {
        // Heuristic: a newline followed by the next property/closer means the closing quote is missing.
        let j = i;
        while (j < n && /\s/.test(src[j])) j++;
        const nx = src[j];
        if (nx === '"' || nx === "'" || nx === '}' || nx === ']' || nx === ',' || nx === undefined) {
          note('Missing closing quote — string closed at the end of the line', i);
          return buf.replace(/[\s,]+$/, (m) => (m.includes(',') ? '' : m));
        }
        if (!rawControlNoted) { note('Raw line break inside a string — must be written as \\n', i); rawControlNoted = true; }
        buf += '\n';
        i++;
        continue;
      }
      if (c.charCodeAt(0) < 0x20) {
        if (!rawControlNoted) { note('Raw control character (e.g. tab) inside a string — must be escaped', i); rawControlNoted = true; }
        buf += c;
        i++;
        continue;
      }
      buf += c;
      i++;
    }
    note('String was never closed — closed at the end of the input', start);
    return buf;
  }

  function parseNumber() {
    const rest = src.slice(i, i + 64);
    if (/^-Infinity/.test(rest)) { note('Infinity is not valid JSON — replaced with null'); i += 9; return null; }
    const hex = rest.match(/^0[xX][0-9a-fA-F]+/);
    if (hex) { note(`Hex number ${hex[0]} is not valid JSON — converted to decimal`); i += hex[0].length; return Number(hex[0]); }
    const m = rest.match(/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/);
    if (!m) return parseWord();
    const t = m[0];
    if (t[0] === '+') note(`Leading + on number ${t} is not valid JSON — removed`);
    if (/^[+-]?0\d/.test(t)) note(`Leading zero in number ${t} is not valid JSON — zero removed`);
    if (/^[+-]?\./.test(t)) note(`Number ${t} needs a digit before the decimal point`);
    if (/\.($|[eE])/.test(t)) note(`Number ${t} needs a digit after the decimal point`);
    i += t.length;
    return Number(t);
  }

  function parseWord() {
    const m = src.slice(i, i + 80).match(/^[A-Za-z_$][\w$.\-]*/);
    if (!m) {
      note(`Unexpected character "${src[i]}" — skipped`);
      i++;
      return null;
    }
    const w = m[0];
    i += w.length;
    if (w === 'true') return true;
    if (w === 'false') return false;
    if (w === 'null') return null;
    if (/^true$/i.test(w)) { note(`${w} should be lowercase true`); return true; }
    if (/^false$/i.test(w)) { note(`${w} should be lowercase false`); return false; }
    if (w === 'None') { note('Python None is not valid JSON — replaced with null'); return null; }
    if (w === 'undefined' || w === 'NaN' || w === 'Infinity') { note(`${w} is not valid JSON — replaced with null`); return null; }
    note(`Unquoted value ${w} — treated as a string`);
    return w;
  }

  function parseKey() {
    if (OPENERS.includes(src[i])) return parseString();
    const m = src.slice(i, i + 200).match(/^[^\s:=,}\]\[{"']+/);
    if (!m) { note(`Unexpected character "${src[i]}" — skipped`); i++; return null; }
    i += m[0].length;
    note(`Unquoted key ${m[0]} — keys must be in double quotes`, i - m[0].length);
    return m[0];
  }

  function parseValue(depth) {
    if (depth > 200) throw new Error('Nesting is deeper than 200 levels');
    skipWs();
    if (i >= n) { note('Value expected but input ended — used null'); return null; }
    const c = src[i];
    if (c === '{') return parseObject(depth);
    if (c === '[') return parseArray(depth);
    if (OPENERS.includes(c)) return parseString();
    if (c === '-' || c === '+' || c === '.' || (c >= '0' && c <= '9')) return parseNumber();
    return parseWord();
  }

  function parseObject(depth) {
    const open = i;
    i++;
    const obj = {};
    const seen = new Set();
    for (;;) {
      skipWs();
      if (i >= n) { note('Object was never closed — added a missing }', open); return obj; }
      const c = src[i];
      if (c === '}') { i++; return obj; }
      if (c === ']') { note('Found ] where } was expected — treated as }'); i++; return obj; }
      if (c === ',') { note('Removed a stray comma'); i++; continue; }
      const keyPos = i;
      const key = parseKey();
      if (key === null) continue;
      skipWs();
      if (src[i] === ':') i++;
      else if (src[i] === '=') { note('Replaced = with :'); i++; }
      else note(`Missing ":" after key "${key}"`);
      skipWs();
      let val;
      if (i >= n || src[i] === '}' || src[i] === ',') { note(`Missing value for key "${key}" — set to null`); val = null; }
      else val = parseValue(depth + 1);
      if (seen.has(key)) warn(`Duplicate key "${key}" — standard parsers keep only the last value`, keyPos);
      seen.add(key);
      obj[key] = val;
      skipWs();
      if (src[i] === ',') {
        i++;
        skipWs();
        if (src[i] === '}') note('Removed a trailing comma before }');
        continue;
      }
      if (src[i] === '}') { i++; return obj; }
      if (i >= n) continue;
      if (src[i] !== ']') note('Missing comma between properties');
    }
  }

  function parseArray(depth) {
    const open = i;
    i++;
    const arr = [];
    for (;;) {
      skipWs();
      if (i >= n) { note('Array was never closed — added a missing ]', open); return arr; }
      const c = src[i];
      if (c === ']') { i++; return arr; }
      if (c === '}') { note('Found } where ] was expected — treated as ]'); i++; return arr; }
      if (c === ',') { note('Removed a stray comma'); i++; continue; }
      arr.push(parseValue(depth + 1));
      skipWs();
      if (src[i] === ',') {
        i++;
        skipWs();
        if (src[i] === ']') note('Removed a trailing comma before ]');
        continue;
      }
      if (src[i] === ']') { i++; return arr; }
      if (i >= n) continue;
      if (src[i] !== '}') note('Missing comma between array items');
    }
  }

  const value = parseValue(0);
  skipWs();
  if (i < n) note(`Extra content after the JSON value (${n - i} characters) — ignored`);
  return { value, fixes, warnings };
}

// ─── Knowledge base: HTTP status codes ─────────────────────────────

const HTTP_KB = {
  301: ['Moved Permanently', 'The resource has a new permanent URL.', ['Old or redirected endpoint URL', 'http:// used where https:// is required'], ['Call the URL from the Location header', 'Enable redirect-following in your HTTP client']],
  302: ['Found (temporary redirect)', 'The server is sending you to another URL.', ['Login redirect', 'Endpoint moved temporarily'], ['Follow the Location header', 'If you expected JSON, check you are not being redirected to a login page']],
  400: ['Bad Request', 'The server could not understand the request.', ['Malformed JSON body', 'Missing or wrongly typed required field', 'Invalid query parameter'], ['Validate the body as JSON before sending', 'Compare field names and types with the API docs', 'Check the Content-Type header is application/json']],
  401: ['Unauthorized', 'The request has no valid credentials.', ['Missing or expired API key / token', 'Wrong Authorization header format', 'Key belongs to a different environment'], ['Send "Authorization: Bearer <token>" (or the scheme the API requires)', 'Regenerate the key and check for stray spaces or newlines', 'Confirm the key matches the environment (test vs live)']],
  403: ['Forbidden', 'Credentials are valid but not allowed to do this.', ['Missing permission or scope', 'IP allow-list or region block', 'Account suspended or plan limit'], ['Check the key\'s scopes/roles', 'Verify IP allow-lists and plan limits', 'Check the API docs for required permissions']],
  404: ['Not Found', 'The URL or the resource does not exist.', ['Typo in the path', 'Wrong base URL or API version', 'Resource ID does not exist or was deleted'], ['Re-check the full URL and version prefix (e.g. /v1)', 'Confirm the ID exists', 'Check trailing slashes and case sensitivity']],
  405: ['Method Not Allowed', 'The endpoint does not accept this HTTP method.', ['POST sent to a GET-only route (or the reverse)'], ['Check which methods the endpoint supports', 'Read the Allow header in the response']],
  408: ['Request Timeout', 'The server gave up waiting for the request.', ['Slow connection or very large upload'], ['Retry with backoff', 'Reduce the payload size']],
  409: ['Conflict', 'The request conflicts with the current state.', ['Duplicate resource', 'Version or ETag mismatch'], ['Fetch the latest state and retry', 'Use a unique idempotency key']],
  410: ['Gone', 'The resource was permanently removed.', ['Deprecated endpoint'], ['Move to the replacement endpoint in the docs']],
  413: ['Payload Too Large', 'The request body is bigger than the server allows.', ['Large JSON or file upload'], ['Compress or split the payload', 'Check the API size limit']],
  415: ['Unsupported Media Type', 'The server does not accept this Content-Type.', ['Missing or wrong Content-Type header'], ['Send "Content-Type: application/json" for JSON bodies']],
  422: ['Unprocessable Entity', 'The JSON is valid but fails validation.', ['Field value fails a rule', 'Missing required field', 'Wrong data type'], ['Read the error body — it usually lists the failing fields', 'Compare against the schema in the docs']],
  429: ['Too Many Requests', 'You have hit a rate limit.', ['Too many requests per second/minute', 'Daily quota used up'], ['Wait for the Retry-After header, then retry', 'Add exponential backoff', 'Cache responses; batch requests']],
  500: ['Internal Server Error', 'The server failed while handling a valid-looking request.', ['Bug or crash on the server', 'Unexpected input the server cannot handle'], ['Retry once; if it persists, report it with the request ID', 'Try a minimal request to isolate the field that triggers it']],
  501: ['Not Implemented', 'The server does not support this feature.', ['Endpoint or method not built yet'], ['Use a supported endpoint']],
  502: ['Bad Gateway', 'A proxy got an invalid response from the upstream server.', ['Upstream service crashed or restarting', 'Deploy in progress'], ['Retry after a short wait', 'Check the service status page']],
  503: ['Service Unavailable', 'The server is overloaded or down for maintenance.', ['Traffic spike', 'Maintenance', 'Service cold-starting (common on free hosting)'], ['Retry with backoff', 'If on free hosting, wait ~30-60 seconds for the service to wake up']],
  504: ['Gateway Timeout', 'A proxy timed out waiting for the upstream server.', ['Slow upstream', 'Long-running request'], ['Retry', 'Make the request smaller or async']],
};

// ─── Knowledge base: common error messages ─────────────────────────

const MSG_KB = [
  { re: /<!doctype html|<html[\s>]|unexpected token\s*'?<'?/i, title: 'The server returned HTML, not JSON', explain: 'Your code expected JSON but received a web page (often an error page, login page or a wrong URL).', fixes: ['Open the URL in a browser and look at what actually comes back', 'Check the URL, API version and path', 'Log response.status and the first 200 characters of the body before parsing', 'Send an "Accept: application/json" header'] },
  { re: /unexpected end of json input|unexpected end of data|json input ended/i, title: 'JSON ended too early (empty or cut-off body)', explain: 'The text you tried to parse is empty or incomplete.', fixes: ['Check the response is not empty (204 No Content has no body)', 'Look for a timeout or dropped connection that cut the response', 'Check the payload was not truncated by a size limit'] },
  { re: /unexpected token .* in json|json\.parse|expected .* in json|is not valid json|syntaxerror.*json/i, title: 'Malformed JSON', explain: 'The text is not valid JSON, so the parser rejected it.', fixes: ['Paste the JSON itself into this debugger to find the exact line', 'Check quotes, commas and brackets', 'Make sure you are not parsing something that is already an object'] },
  { re: /\[object object\]/i, title: '"[object Object]" appeared where text was expected', explain: 'An object was converted to a string, which loses its content.', fixes: ['Use JSON.stringify(obj) when you need text', 'Check you are reading a field (obj.message), not the whole object'] },
  { re: /econnrefused/i, title: 'Connection refused', explain: 'Nothing is listening at that address and port.', fixes: ['Confirm the server is running', 'Check host and port', 'Inside Docker/Codespaces, "localhost" may not be the machine you expect'] },
  { re: /enotfound|getaddrinfo|eai_again/i, title: 'Hostname could not be resolved', explain: 'DNS could not find that domain.', fixes: ['Check the domain for typos', 'Check your internet/DNS connection', 'Confirm the URL includes the protocol and has no extra spaces'] },
  { re: /etimedout|esockettimedout|timed? ?out|timeout/i, title: 'Request timed out', explain: 'The server did not answer in time.', fixes: ['Retry with exponential backoff', 'Increase the client timeout for slow endpoints', 'If the host is on free hosting, it may be asleep — retry after 30-60s'] },
  { re: /econnreset|socket hang up|connection reset/i, title: 'Connection was reset', explain: 'The server closed the connection unexpectedly.', fixes: ['Retry the request', 'Check for payload-size limits or a server crash', 'Check keep-alive and proxy settings'] },
  { re: /cert_|certificate|ssl|tls|self.signed/i, title: 'TLS / certificate problem', explain: 'The secure connection could not be verified.', fixes: ['Check the system date/time', 'Use the correct https:// URL', 'Install the proper CA certificate rather than disabling verification'] },
  { re: /cors|access-control-allow-origin/i, title: 'CORS blocked the browser request', explain: 'The browser blocked a cross-origin call because the server did not allow your origin.', fixes: ['Add the right CORS headers on the server (Access-Control-Allow-Origin)', 'Call the API from your backend instead of the browser', 'Handle the OPTIONS preflight request'] },
  { re: /invalid[_ ]?api[_ ]?key|incorrect api key|invalid token|jwt|token (?:has )?expired|signature (?:verification )?failed|unauthori[sz]ed/i, title: 'Authentication problem', explain: 'The API did not accept your credentials.', fixes: ['Regenerate the key/token', 'Check the Authorization header format and for extra spaces', 'Check expiry time and clock drift for JWTs'] },
  { re: /rate.?limit|too many requests|quota/i, title: 'Rate limit or quota reached', explain: 'You are sending requests faster than allowed, or you used up your quota.', fixes: ['Wait for the Retry-After period', 'Add backoff and caching', 'Upgrade the plan or request a higher limit'] },
  { re: /invalid_grant|invalid_client|invalid_request|unsupported_grant_type|invalid_scope|access_denied/i, title: 'OAuth error', explain: 'The OAuth server rejected the request.', fixes: ['invalid_grant: the code/refresh token is expired, used, or for a different client', 'invalid_client: client ID/secret wrong or sent in the wrong place', 'invalid_request: a required parameter is missing', 'Check redirect_uri matches exactly'] },
  { re: /cannot read propert(?:y|ies) of (?:undefined|null)|undefined is not an object|null is not an object/i, title: 'Reading a field of undefined/null', explain: 'Your code accessed a property on something that does not exist (often a missing field in the response).', fixes: ['Print the full response first and confirm the field path', 'Use optional chaining: data?.user?.name', 'Handle the error/empty case before reading fields'] },
  { re: /is not a function/i, title: 'Calling something that is not a function', explain: 'A value was called like a function but has another type.', fixes: ['Check the import/export and spelling', 'Log typeof the value', 'Check the library version for renamed methods'] },
  { re: /is not defined/i, title: 'Variable not defined', explain: 'The name is used before it exists or was never imported.', fixes: ['Check spelling and the import', 'Check the variable scope'] },
  { re: /cannot find module|err_module_not_found|module not found/i, title: 'Module not found', explain: 'Node could not locate a package or file.', fixes: ['Run npm install', 'Check the package name and import path (case-sensitive on Linux)', 'Check "type": "module" and file extensions for ESM imports'] },
  { re: /eaddrinuse/i, title: 'Port already in use', explain: 'Another process is already using that port.', fixes: ['Stop the other process or choose a different PORT', 'On hosts like Render, listen on process.env.PORT'] },
  { re: /payload too large|request entity too large/i, title: 'Request body too large', explain: 'The body is above the server limit.', fixes: ['Reduce or split the payload', 'Raise the server body-size limit if you control it'] },
  { re: /unsupported media type|content-type/i, title: 'Content-Type problem', explain: 'The server expects a different Content-Type.', fixes: ['Send "Content-Type: application/json" with JSON bodies', 'Do not set Content-Type manually for multipart uploads'] },
  { re: /enoent|no such file/i, title: 'File or folder not found', explain: 'The path does not exist.', fixes: ['Check the path and working directory', 'Check capitalisation (Linux is case-sensitive)'] },
  { re: /heap out of memory|out of memory/i, title: 'Out of memory', explain: 'The process used more memory than available.', fixes: ['Process data in chunks/streams', 'Raise memory limits or upgrade the plan'] },
];

// ─── Analysis helpers ──────────────────────────────────────────────

function extractJsonCandidate(text) {
  let t = text.trim();
  const fence = t.match(/^```[a-zA-Z]*\s*\n?([\s\S]*?)\n?```\s*$/);
  let notes = [];
  if (fence) { t = fence[1].trim(); notes.push('Removed the surrounding ``` code fence'); }
  const looks = (s) => /^[{[]\s*(["'\u201C\u2018}\]]|[A-Za-z_$][\w$-]*\s*[:=]|-?\d|\{|\[|\/\/|\/\*)/.test(s);
  if (t.startsWith('{') || t.startsWith('[')) return { block: t, prefix: '', notes };
  const idx = t.indexOf('{');
  if (idx !== -1) {
    const block = t.slice(idx);
    if (looks(block)) return { block, prefix: t.slice(0, idx).trim(), notes };
  }
  return { block: null, prefix: t, notes };
}

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function inspectValue(root) {
  const out = { nulls: [], empties: [], numStr: [], boolStr: [], mixedArrays: [], inconsistent: [], maxDepth: 0, nodes: 0, keyCount: 0, keyStyles: { snake: 0, camel: 0 } };
  function walk(v, path, depth) {
    out.nodes++;
    out.maxDepth = Math.max(out.maxDepth, depth);
    if (out.nodes > 50_000 || depth > 60) return;
    if (v === null) { out.nulls.push(path); return; }
    if (typeof v === 'string') {
      if (v === '') out.empties.push(path);
      else if (/^-?\d+(\.\d+)?$/.test(v) && v.length < 16) out.numStr.push(path);
      else if (v === 'true' || v === 'false') out.boolStr.push(path);
      return;
    }
    if (Array.isArray(v)) {
      if (v.length === 0) out.empties.push(path);
      const types = new Set(v.map(typeOf));
      if (types.size > 1) out.mixedArrays.push(`${path} mixes ${[...types].join(', ')}`);
      const objs = v.filter((x) => x && typeof x === 'object' && !Array.isArray(x));
      if (objs.length > 1) {
        const all = new Set();
        objs.forEach((o) => Object.keys(o).forEach((k) => all.add(k)));
        const missing = [...all].filter((k) => objs.some((o) => !(k in o)));
        if (missing.length) out.inconsistent.push(`${path}: not every item has ${missing.slice(0, 5).map((k) => `"${k}"`).join(', ')}`);
      }
      v.slice(0, 200).forEach((x, idx) => walk(x, `${path}[${idx}]`, depth + 1));
      return;
    }
    if (typeof v === 'object') {
      const keys = Object.keys(v);
      if (keys.length === 0) out.empties.push(path);
      for (const k of keys) {
        out.keyCount++;
        if (/_/.test(k) && /^[a-z0-9_]+$/.test(k)) out.keyStyles.snake++;
        else if (/^[a-z]+[A-Z]/.test(k)) out.keyStyles.camel++;
        walk(v[k], /^[A-Za-z_$][\w$]*$/.test(k) ? `${path}.${k}` : `${path}["${k}"]`, depth + 1);
      }
    }
  }
  walk(root, '$', 1);
  return out;
}

function findStatusCodes(text, parsed) {
  const found = new Set();
  const ctx = /\b(http|status|error|code|response|request|failed|failure)\b/i.test(text) || text.trim().length < 80;
  if (ctx) for (const m of text.matchAll(/\b([1-5]\d{2})\b/g)) found.add(Number(m[1]));
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    for (const k of ['status', 'statusCode', 'status_code', 'code', 'httpStatus']) {
      const v = parsed[k];
      if (typeof v === 'number' && v >= 100 && v < 600) found.add(v);
      if (typeof v === 'string' && /^[1-5]\d{2}$/.test(v)) found.add(Number(v));
    }
  }
  return [...found].filter((c) => HTTP_KB[c]).slice(0, 3);
}

function describeErrorShape(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const keys = Object.keys(obj);
  const errKeys = ['error', 'errors', 'message', 'msg', 'detail', 'details', 'error_description', 'error_message', 'code', 'status', 'statusCode', 'reason'];
  const hit = errKeys.filter((k) => keys.includes(k));
  if (!hit.length || !(hit.includes('error') || hit.includes('errors') || hit.includes('message') || hit.includes('detail') || hit.includes('error_description') || hit.includes('error_message'))) return null;
  const lines = hit.slice(0, 6).map((k) => {
    let v = obj[k];
    v = typeof v === 'string' ? v : JSON.stringify(v);
    if (v && v.length > 140) v = v.slice(0, 140) + '...';
    return `  ${k}: ${v}`;
  });
  return lines.join('\n');
}

// ─── Main entry ────────────────────────────────────────────────────

export function analyze(rawInput) {
  let text = String(rawInput ?? '');
  let truncated = false;
  if (text.length > MAX_INPUT_CHARS) { text = text.slice(0, MAX_INPUT_CHARS); truncated = true; }
  text = text.replace(/^\uFEFF/, '');

  const SEP = '==============================================';
  const sub = '----------------------------------------------';
  const out = [];
  out.push('API ERROR & JSON DEBUGGER REPORT');
  out.push(SEP);

  if (!text.trim()) {
    out.push('No input received.');
    out.push('');
    out.push('Send one of these and I will diagnose it:');
    out.push('  - a JSON payload that fails to parse');
    out.push('  - an API error response (with or without the HTTP status)');
    out.push('  - an error message or stack trace line');
    out.push(SEP);
    return { report: out.join('\n'), summary: { verdict: 'empty' } };
  }

  const { block, prefix, notes: extractNotes } = extractJsonCandidate(text);
  const errorText = prefix || (block ? '' : text);

  let value = null, hasValue = false, fixes = [], warnings = [], valid = false, nativeErr = null, parseCrash = null;

  if (block) {
    try { JSON.parse(block); valid = true; } catch (e) { nativeErr = e.message; }
    try {
      const r = lenientParse(block);
      value = r.value; fixes = r.fixes; warnings = r.warnings; hasValue = true;
      if (valid) fixes = [];
    } catch (e) {
      parseCrash = e.message;
    }
  }

  const inputKind = block
    ? (valid ? 'JSON (valid)' : hasValue ? 'JSON (invalid, repairable)' : 'JSON (invalid, could not repair)')
    : 'Error message / plain text';
  out.push(`Input type : ${inputKind}`);
  out.push(`Size       : ${text.length.toLocaleString()} characters${truncated ? ' (truncated to the first 200,000)' : ''}`);

  // Verdict
  let verdict;
  if (block && valid) verdict = 'This JSON is valid.';
  else if (block && hasValue) verdict = `This JSON is NOT valid. ${fixes.length} problem${fixes.length === 1 ? '' : 's'} found and a corrected version is below.`;
  else if (block) verdict = 'This JSON is NOT valid and could not be repaired automatically.';
  else verdict = 'This looks like an error message rather than JSON. Diagnosis below.';
  out.push('');
  out.push('VERDICT');
  out.push(`  ${verdict}`);

  // Problems with positions
  if (block && !valid) {
    out.push('');
    out.push(sub);
    out.push('PROBLEMS FOUND (line:column)');
    if (nativeErr) out.push(`  Parser said: ${nativeErr}`);
    if (parseCrash) out.push(`  Repair stopped: ${parseCrash}`);
    const all = [...extractNotes.map((m) => ({ msg: m, line: 1, col: 1 })), ...fixes];
    all.slice(0, MAX_FIXES_SHOWN).forEach((f, idx) => out.push(`  ${idx + 1}. [${f.line}:${f.col}] ${f.msg}`));
    if (all.length > MAX_FIXES_SHOWN) out.push(`  ... and ${all.length - MAX_FIXES_SHOWN} more of the same kinds`);
    if (prefix) out.push(`  Note: text before the JSON was treated as a separate error message (see below).`);
  }

  if (warnings.length) {
    out.push('');
    out.push(sub);
    out.push('WARNINGS');
    warnings.slice(0, 10).forEach((w) => out.push(`  - [${w.line}:${w.col}] ${w.msg}`));
  }

  // Corrected JSON
  if (block && hasValue && !valid) {
    let pretty = JSON.stringify(value, null, 2);
    let cut = false;
    if (pretty.length > MAX_OUTPUT_JSON_CHARS) { pretty = pretty.slice(0, MAX_OUTPUT_JSON_CHARS); cut = true; }
    out.push('');
    out.push(sub);
    out.push('CORRECTED JSON');
    out.push(pretty);
    if (cut) out.push(`... (output shortened to ${MAX_OUTPUT_JSON_CHARS.toLocaleString()} characters)`);
    out.push('');
    out.push('Check the corrected version before relying on it: repairs such as');
    out.push('"missing value -> null" or "unquoted -> string" are best guesses.');
  }

  // Structure review
  if (block && hasValue) {
    const info = inspectValue(value);
    const rootType = typeOf(value);
    out.push('');
    out.push(sub);
    out.push('STRUCTURE');
    const size = rootType === 'array' ? `${value.length} items` : rootType === 'object' ? `${Object.keys(value).length} top-level keys` : rootType;
    out.push(`  Root: ${rootType} (${size}), depth ${info.maxDepth}, ${info.nodes.toLocaleString()} values`);

    const obs = [];
    if (info.nulls.length) obs.push(`null values at: ${info.nulls.slice(0, 6).join(', ')}${info.nulls.length > 6 ? ` (+${info.nulls.length - 6} more)` : ''}`);
    if (info.empties.length) obs.push(`empty values at: ${info.empties.slice(0, 6).join(', ')}${info.empties.length > 6 ? ` (+${info.empties.length - 6} more)` : ''}`);
    if (info.numStr.length) obs.push(`numbers stored as text at: ${info.numStr.slice(0, 5).join(', ')} — check if these should be numeric`);
    if (info.boolStr.length) obs.push(`"true"/"false" stored as text at: ${info.boolStr.slice(0, 5).join(', ')} — check if these should be booleans`);
    info.mixedArrays.slice(0, 3).forEach((m) => obs.push(`mixed types: ${m}`));
    info.inconsistent.slice(0, 3).forEach((m) => obs.push(`inconsistent items: ${m}`));
    if (info.keyStyles.snake > 0 && info.keyStyles.camel > 0) obs.push(`mixed key styles (${info.keyStyles.snake} snake_case, ${info.keyStyles.camel} camelCase) — pick one`);
    if (info.maxDepth > 8) obs.push(`very deep nesting (${info.maxDepth} levels) — consider flattening`);
    if (!obs.length) obs.push('no structural issues detected');
    obs.forEach((o) => out.push(`  - ${o}`));
  }

  // API error response shape
  if (block && hasValue) {
    const shape = describeErrorShape(value);
    if (shape) {
      out.push('');
      out.push(sub);
      out.push('THIS LOOKS LIKE AN API ERROR RESPONSE');
      out.push('  Key fields:');
      out.push(shape);
    }
  }

  // Error-text and status-code diagnosis
  const diag = [];
  const codes = findStatusCodes(prefix || text, hasValue ? value : null);
  for (const c of codes) {
    const [name, meaning, causes, fixesList] = HTTP_KB[c];
    diag.push({ title: `HTTP ${c} — ${name}`, explain: meaning, causes, fixes: fixesList });
  }
  const msgSource = block && !prefix ? JSON.stringify(value ?? '') + ' ' + text.slice(0, 2000) : (prefix || text);
  for (const k of MSG_KB) {
    if (k.re.test(msgSource) && !(block && valid && k.title === 'Malformed JSON')) {
      diag.push({ title: k.title, explain: k.explain, causes: [], fixes: k.fixes });
    }
    if (diag.length >= 5) break;
  }

  if (diag.length) {
    out.push('');
    out.push(sub);
    out.push('DIAGNOSIS');
    diag.forEach((d, idx) => {
      out.push(`  ${idx + 1}. ${d.title}`);
      out.push(`     ${d.explain}`);
      if (d.causes.length) out.push(`     Common causes: ${d.causes.join('; ')}`);
      out.push('     What to try:');
      d.fixes.forEach((f) => out.push(`       - ${f}`));
    });
  } else if (!block) {
    out.push('');
    out.push(sub);
    out.push('DIAGNOSIS');
    out.push('  No known error pattern matched.');
    out.push('  To get a sharper diagnosis, send: the full error text, the HTTP status');
    out.push('  code, and the request body that triggered it.');
  }

  // Next steps
  out.push('');
  out.push(sub);
  out.push('NEXT STEPS');
  if (block && !valid && hasValue) {
    out.push('  1. Replace your payload with the corrected JSON above.');
    out.push('  2. Fix the source that generates the payload so the problem does not return.');
    out.push('  3. Validate before sending: JSON.parse(text) inside try/catch.');
  } else if (block && valid) {
    out.push('  1. The syntax is fine — if the API still rejects it, compare field names and types with its docs.');
    out.push('  2. Send the API\'s error response too and I can diagnose the rejection.');
  } else {
    out.push('  1. Apply the suggestions above, starting with the first.');
    out.push('  2. If it persists, send the full error text plus the request that caused it.');
  }

  out.push('');
  out.push(SEP);
  out.push('Checked by API Error & JSON Debugger — deterministic analysis, no data stored.');

  return {
    report: out.join('\n'),
    summary: { verdict: block ? (valid ? 'valid' : hasValue ? 'repaired' : 'unrepairable') : 'error-text', problems: fixes.length, statusCodes: codes },
  };
}
