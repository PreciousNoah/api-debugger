// ═══════════════════════════════════════════════════════════════════
// API ERROR & JSON DEBUGGER — core engine (v2)
// Deterministic: no LLM, no external APIs. Fast, free, and repeatable.
//
// v2 changes:
//  - Finds EVERY JSON block in the input (fenced or inline) and analyses each separately
//  - Tells request payloads from API response bodies using the surrounding text
//  - Reports exact line:column in the user's original input
//  - Cross-checks server complaints against the request payload (required values, lengths, types)
//  - Separates SAFE repairs from GUESSES; never presents a guess as a certain fix
//  - Every corrected document is re-validated with JSON.parse before being called valid
//  - Anything it cannot interpret is listed, never silently dropped
// ═══════════════════════════════════════════════════════════════════

const MAX_INPUT_CHARS = 200_000;
const MAX_FIXES_SHOWN = 25;
const MAX_OUTPUT_JSON_CHARS = 20_000;
const MAX_BLOCKS = 12;

const SEP = '==============================================';
const SUB = '----------------------------------------------';

// ─── Helpers ───────────────────────────────────────────────────────

function lineCol(src, pos) {
  let line = 1, col = 1;
  const end = Math.min(Math.max(pos, 0), src.length);
  for (let k = 0; k < end; k++) {
    if (src[k] === '\n') { line++; col = 1; } else { col++; }
  }
  return { line, col };
}

const preview = (s, n = 60) => {
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '...' : t;
};

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

function countKeys(v, depth = 0) {
  if (depth > 60 || v === null || typeof v !== 'object') return 0;
  if (Array.isArray(v)) return v.reduce((n, x) => n + countKeys(x, depth + 1), 0);
  return Object.keys(v).reduce((n, k) => n + 1 + countKeys(v[k], depth + 1), 0);
}

const isSensitive = (name) => /pass|secret|token|key|auth|private|\bpin\b|cvv|ssn/i.test(String(name || ''));
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

// ─── Lenient JSON parser ───────────────────────────────────────────
// Parses "almost JSON" and records every repair it had to make.
// kind: 'safe'  = mechanical fix with one obvious meaning
//       'guess' = the intent is ambiguous; a human must confirm

function lenientParse(src) {
  const fixes = [];
  const warnings = [];
  const missingKeys = [];
  let keyTokens = 0;
  const n = src.length;
  let i = 0;

  const note = (msg, pos = i, kind = 'safe') => fixes.push({ msg, pos, kind });
  const warn = (msg, pos = i) => warnings.push({ msg, pos });

  function skipWs() {
    while (i < n) {
      const c = src[i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\uFEFF' || c === '\u00A0') { i++; continue; }
      if (c === '/' && src[i + 1] === '/') {
        const start = i;
        while (i < n && src[i] !== '\n') i++;
        note(`Removed a // comment (comments are not allowed in JSON): ${preview(src.slice(start, i), 40)}`, start);
        continue;
      }
      if (c === '/' && src[i + 1] === '*') {
        const start = i;
        const end = src.indexOf('*/', i + 2);
        i = end === -1 ? n : end + 2;
        note(`Removed a /* */ comment (comments are not allowed in JSON): ${preview(src.slice(start, i), 40)}`, start);
        continue;
      }
      if (c === '#') {
        const start = i;
        while (i < n && src[i] !== '\n') i++;
        note(`Removed a # comment (comments are not allowed in JSON): ${preview(src.slice(start, i), 40)}`, start);
        continue;
      }
      break;
    }
  }

  const OPENERS = '"\'\u201C\u201D\u2018\u2019';

  function parseString() {
    const start = i;
    const q = src[i];
    if (q !== '"') {
      note(q === "'" ? 'Single-quoted string - JSON requires double quotes' : 'Smart/curly quotes used - JSON requires straight double quotes', start);
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
          if (e === "'") note("Unnecessary escape \\' - not valid in JSON", i);
          buf += map[e];
          i += 2;
        } else {
          note(`Invalid escape sequence \\${e ?? ''} - the backslash was removed (intent unclear)`, i, 'guess');
          buf += e ?? '';
          i += 2;
        }
        continue;
      }
      if (c === '\n' || c === '\r') {
        // A newline followed by the next property/closer usually means the closing quote is missing.
        let j = i;
        while (j < n && /\s/.test(src[j])) j++;
        const nx = src[j];
        if (nx === '"' || nx === "'" || nx === '}' || nx === ']' || nx === ',' || nx === undefined) {
          note('Missing closing quote - the string was closed at the end of the line (best guess)', i, 'guess');
          return buf;
        }
        if (!rawControlNoted) { note('Raw line break inside a string - must be written as \\n', i); rawControlNoted = true; }
        buf += '\n';
        i++;
        continue;
      }
      if (c.charCodeAt(0) < 0x20) {
        if (!rawControlNoted) { note('Raw control character (e.g. tab) inside a string - must be escaped', i); rawControlNoted = true; }
        buf += c;
        i++;
        continue;
      }
      buf += c;
      i++;
    }
    note('String was never closed - it was closed at the end of the input (best guess)', start, 'guess');
    return buf;
  }

  function parseNumber() {
    const rest = src.slice(i, i + 64);
    if (/^-Infinity/.test(rest)) { note('-Infinity is not valid JSON - replaced with null (intent unclear)', i, 'guess'); i += 9; return null; }
    const hex = rest.match(/^0[xX][0-9a-fA-F]+/);
    if (hex) { note(`Hex number ${hex[0]} is not valid JSON - converted to decimal`); i += hex[0].length; return Number(hex[0]); }
    const m = rest.match(/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/);
    if (!m) return parseWord();
    const t = m[0];
    if (t[0] === '+') note(`Leading + on number ${t} is not valid JSON - removed`);
    if (/^[+-]?0\d/.test(t)) note(`Leading zero in number ${t} is not valid JSON - zero removed (if this is an ID or zip code it should be a string)`, i, 'guess');
    if (/^[+-]?\./.test(t)) note(`Number ${t} needs a digit before the decimal point`);
    if (/\.($|[eE])/.test(t)) note(`Number ${t} needs a digit after the decimal point`);
    i += t.length;
    return Number(t);
  }

  function parseWord() {
    const m = src.slice(i, i + 80).match(/^[A-Za-z_$][\w$.\-]*/);
    if (!m) {
      note(`Unexpected character "${src[i]}" - skipped (it was not interpreted)`, i, 'guess');
      i++;
      return null;
    }
    const w = m[0];
    const pos = i;
    i += w.length;
    if (w === 'true') return true;
    if (w === 'false') return false;
    if (w === 'null') return null;
    if (/^true$/i.test(w)) { note(`${w} should be lowercase true`, pos); return true; }
    if (/^false$/i.test(w)) { note(`${w} should be lowercase false`, pos); return false; }
    if (w === 'None') { note('Python None is not valid JSON - replaced with null', pos); return null; }
    if (w === 'undefined' || w === 'NaN' || w === 'Infinity') { note(`${w} is not valid JSON - replaced with null (intent unclear)`, pos, 'guess'); return null; }
    note(`Unquoted value ${w} - treated as a string (it may have been a typo or a missing quote)`, pos, 'guess');
    return w;
  }

  function parseKey() {
    if (OPENERS.includes(src[i])) return parseString();
    const m = src.slice(i, i + 200).match(/^[^\s:=,}\]\[{"']+/);
    if (!m) { note(`Unexpected character "${src[i]}" - skipped (it was not interpreted)`, i, 'guess'); i++; return null; }
    const pos = i;
    i += m[0].length;
    note(`Unquoted key ${m[0]} - keys must be in double quotes`, pos);
    return m[0];
  }

  function parseValue(depth) {
    if (depth > 200) throw new Error('Nesting is deeper than 200 levels');
    skipWs();
    if (i >= n) { note('A value was expected but the input ended - null used as a placeholder', i, 'guess'); return null; }
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
      if (i >= n) { note('Object was never closed - a } was added at the end (the real closing position is unknown)', open, 'guess'); return obj; }
      const c = src[i];
      if (c === '}') { i++; return obj; }
      if (c === ']') { note('Found ] where } was expected - treated as }', i, 'guess'); i++; return obj; }
      if (c === ',') { note('Removed a stray comma', i); i++; continue; }
      const keyPos = i;
      const key = parseKey();
      if (key === null) continue;
      skipWs();
      if (src[i] === ':') i++;
      else if (src[i] === '=') { note('Replaced = with :', i); i++; }
      else note(`Missing ":" after key "${key}" - one was assumed`, i, 'guess');
      skipWs();
      let val;
      if (i >= n || src[i] === '}' || src[i] === ',') {
        note(`Missing value for key "${key}" - the key was kept with null as a placeholder (the intended value is unknown)`, i, 'guess');
        missingKeys.push(key);
        val = null;
      } else val = parseValue(depth + 1);
      keyTokens++;
      if (seen.has(key)) warn(`Duplicate key "${key}" - the earlier value was discarded (standard parsers keep only the last one)`, keyPos);
      seen.add(key);
      obj[key] = val;
      skipWs();
      if (src[i] === ',') {
        i++;
        skipWs();
        if (src[i] === '}') note('Removed a trailing comma before }', i);
        continue;
      }
      if (src[i] === '}') { i++; return obj; }
      if (i >= n) continue;
      if (src[i] !== ']') note('Missing comma - one is needed before this property', i);
    }
  }

  function parseArray(depth) {
    const open = i;
    i++;
    const arr = [];
    for (;;) {
      skipWs();
      if (i >= n) { note('Array was never closed - a ] was added at the end (the real closing position is unknown)', open, 'guess'); return arr; }
      const c = src[i];
      if (c === ']') { i++; return arr; }
      if (c === '}') { note('Found } where ] was expected - treated as ]', i, 'guess'); i++; return arr; }
      if (c === ',') { note('Removed a stray comma', i); i++; continue; }
      arr.push(parseValue(depth + 1));
      skipWs();
      if (src[i] === ',') {
        i++;
        skipWs();
        if (src[i] === ']') note('Removed a trailing comma before ]', i);
        continue;
      }
      if (src[i] === ']') { i++; return arr; }
      if (i >= n) continue;
      if (src[i] !== '}') note('Missing comma - one is needed before this item', i);
    }
  }

  const value = parseValue(0);
  skipWs();
  if (i < n) note(`Extra content after the JSON value was NOT interpreted: "${preview(src.slice(i), 60)}"`, i, 'guess');
  return { value, fixes, warnings, keyTokens, missingKeys };
}

// ─── Knowledge base: HTTP status codes ─────────────────────────────

const HTTP_KB = {
  301: ['Moved Permanently', 'The resource has a new permanent URL.', ['Old or redirected endpoint URL', 'http:// used where https:// is required'], ['Call the URL from the Location header', 'Enable redirect-following in your HTTP client']],
  302: ['Found (temporary redirect)', 'The server is sending you to another URL.', ['Login redirect', 'Endpoint moved temporarily'], ['Follow the Location header', 'If you expected JSON, check you are not being redirected to a login page']],
  400: ['Bad Request', 'The server could not understand or accept the request.', ['Malformed JSON body', 'Missing or wrongly typed required field', 'Value fails a validation rule (length, format)', 'Invalid query parameter'], ['Validate the body as JSON before sending', 'Compare field names, types and limits with the API docs', 'Check the Content-Type header is application/json']],
  401: ['Unauthorized', 'The request has no valid credentials.', ['Missing or expired API key / token', 'Wrong Authorization header format', 'Key belongs to a different environment'], ['Send "Authorization: Bearer <token>" (or the scheme the API requires)', 'Regenerate the key and check for stray spaces or newlines', 'Confirm the key matches the environment (test vs live)']],
  403: ['Forbidden', 'Credentials are valid but not allowed to do this.', ['Missing permission or scope', 'IP allow-list or region block', 'Account suspended or plan limit'], ["Check the key's scopes/roles", 'Verify IP allow-lists and plan limits', 'Check the API docs for required permissions']],
  404: ['Not Found', 'The URL or the resource does not exist.', ['Typo in the path', 'Wrong base URL or API version', 'Resource ID does not exist or was deleted'], ['Re-check the full URL and version prefix (e.g. /v1)', 'Confirm the ID exists', 'Check trailing slashes and case sensitivity']],
  405: ['Method Not Allowed', 'The endpoint does not accept this HTTP method.', ['POST sent to a GET-only route (or the reverse)'], ['Check which methods the endpoint supports', 'Read the Allow header in the response']],
  408: ['Request Timeout', 'The server gave up waiting for the request.', ['Slow connection or very large upload'], ['Retry with backoff', 'Reduce the payload size']],
  409: ['Conflict', 'The request conflicts with the current state.', ['Duplicate resource (e.g. email already registered)', 'Version or ETag mismatch'], ['Fetch the latest state and retry', 'Use a unique idempotency key']],
  410: ['Gone', 'The resource was permanently removed.', ['Deprecated endpoint'], ['Move to the replacement endpoint in the docs']],
  413: ['Payload Too Large', 'The request body is bigger than the server allows.', ['Large JSON or file upload'], ['Compress or split the payload', 'Check the API size limit']],
  415: ['Unsupported Media Type', 'The server does not accept this Content-Type.', ['Missing or wrong Content-Type header'], ['Send "Content-Type: application/json" for JSON bodies']],
  422: ['Unprocessable Entity', 'The JSON is valid but fails validation.', ['Field value fails a rule', 'Missing required field', 'Wrong data type'], ['Read the error body - it usually lists the failing fields', 'Compare against the schema in the docs']],
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
  { re: /etimedout|esockettimedout|timed? ?out|timeout/i, title: 'Request timed out', explain: 'The server did not answer in time.', fixes: ['Retry with exponential backoff', 'Increase the client timeout for slow endpoints', 'If the host is on free hosting, it may be asleep - retry after 30-60s'] },
  { re: /econnreset|socket hang up|connection reset/i, title: 'Connection was reset', explain: 'The server closed the connection unexpectedly.', fixes: ['Retry the request', 'Check for payload-size limits or a server crash', 'Check keep-alive and proxy settings'] },
  { re: /cert_|certificate|\bssl\b|\btls\b|self.signed/i, title: 'TLS / certificate problem', explain: 'The secure connection could not be verified.', fixes: ['Check the system date/time', 'Use the correct https:// URL', 'Install the proper CA certificate rather than disabling verification'] },
  { re: /\bcors\b|access-control-allow-origin/i, title: 'CORS blocked the browser request', explain: 'The browser blocked a cross-origin call because the server did not allow your origin.', fixes: ['Add the right CORS headers on the server (Access-Control-Allow-Origin)', 'Call the API from your backend instead of the browser', 'Handle the OPTIONS preflight request'] },
  { re: /invalid[_ ]?api[_ ]?key|incorrect api key|invalid token|\bjwt\b|token (?:has )?expired|signature (?:verification )?failed|unauthori[sz]ed/i, title: 'Authentication problem', explain: 'The API did not accept your credentials.', fixes: ['Regenerate the key/token', 'Check the Authorization header format and for extra spaces', 'Check expiry time and clock drift for JWTs'] },
  { re: /rate.?limit|too many requests|quota/i, title: 'Rate limit or quota reached', explain: 'You are sending requests faster than allowed, or you used up your quota.', fixes: ['Wait for the Retry-After period', 'Add backoff and caching', 'Upgrade the plan or request a higher limit'] },
  { re: /invalid_grant|invalid_client|invalid_request|unsupported_grant_type|invalid_scope|access_denied/i, title: 'OAuth error', explain: 'The OAuth server rejected the request.', fixes: ['invalid_grant: the code/refresh token is expired, used, or for a different client', 'invalid_client: client ID/secret wrong or sent in the wrong place', 'invalid_request: a required parameter is missing', 'Check redirect_uri matches exactly'] },
  { re: /cannot read propert(?:y|ies) of (?:undefined|null)|undefined is not an object|null is not an object/i, title: 'Reading a field of undefined/null', explain: 'Your code accessed a property on something that does not exist (often a missing field in the response).', fixes: ['Print the full response first and confirm the field path', 'Use optional chaining: data?.user?.name', 'Handle the error/empty case before reading fields'] },
  { re: /is not a function/i, title: 'Calling something that is not a function', explain: 'A value was called like a function but has another type.', fixes: ['Check the import/export and spelling', 'Log typeof the value', 'Check the library version for renamed methods'] },
  { re: /is not defined/i, title: 'Variable not defined', explain: 'The name is used before it exists or was never imported.', fixes: ['Check spelling and the import', 'Check the variable scope'] },
  { re: /cannot find module|err_module_not_found|module not found/i, title: 'Module not found', explain: 'Node could not locate a package or file.', fixes: ['Run npm install', 'Check the package name and import path (case-sensitive on Linux)', 'Check "type": "module" and file extensions for ESM imports'] },
  { re: /eaddrinuse/i, title: 'Port already in use', explain: 'Another process is already using that port.', fixes: ['Stop the other process or choose a different PORT', 'On hosts like Render, listen on process.env.PORT'] },
  { re: /payload too large|request entity too large/i, title: 'Request body too large', explain: 'The body is above the server limit.', fixes: ['Reduce or split the payload', 'Raise the server body-size limit if you control it'] },
  { re: /unsupported media type|invalid content-?type|wrong content-?type|content-?type (?:must|should|is not)/i, title: 'Content-Type problem', explain: 'The server expects a different Content-Type.', fixes: ['Send "Content-Type: application/json" with JSON bodies', 'Do not set Content-Type manually for multipart uploads'] },
  { re: /enoent|no such file/i, title: 'File or folder not found', explain: 'The path does not exist.', fixes: ['Check the path and working directory', 'Check capitalisation (Linux is case-sensitive)'] },
  { re: /heap out of memory|out of memory/i, title: 'Out of memory', explain: 'The process used more memory than available.', fixes: ['Process data in chunks/streams', 'Raise memory limits or upgrade the plan'] },
];

// ─── Block extraction ──────────────────────────────────────────────
// Finds every JSON-looking region in free text, fenced (```json) or inline.

const LOOKS_JSON = /^[{[]\s*(["'\u201C\u2018}\]]|[A-Za-z_$][\w$-]*\s*[:=]|-?\d|\{|\[|\/\/|\/\*)/;

function matchClose(s, i) {
  const stack = [];
  let inStr = false;
  for (let k = i; k < s.length; k++) {
    const c = s[k];
    if (inStr) {
      if (c === '\\') { k++; continue; }
      if (c === '"') { inStr = false; continue; }
      if (c === '\n') inStr = false; // JSON strings cannot span lines - recover from a missing quote
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{' || c === '[') { stack.push(c); continue; }
    if (c === '}' || c === ']') {
      stack.pop();
      if (stack.length === 0) return { end: k + 1, closed: true };
    }
  }
  const rest = s.slice(i);
  const blank = rest.search(/\r?\n[ \t]*\r?\n/);
  return { end: blank === -1 ? s.length : i + blank, closed: false };
}

// An unclosed block should not swallow the prose that follows it.
function truncateUnterminated(s, start, hardEnd) {
  const CONT = /^(["'\u201C\u2018}\]{[,\-\d]|[A-Za-z_$][\w$-]*\s*[:=]|\/\/|\/\*|(?:true|false|null|None|True|False|undefined)\b)/;
  let pos = start;
  let first = true;
  let lastGood = start;
  while (pos < hardEnd) {
    let nl = s.indexOf('\n', pos);
    if (nl === -1 || nl > hardEnd) nl = hardEnd;
    const t = s.slice(pos, nl).trim();
    if (first) { first = false; lastGood = nl; }
    else if (t === '') { /* blank line inside the block */ }
    else if (CONT.test(t)) lastGood = nl;
    else break;
    pos = nl + 1;
  }
  return Math.min(Math.max(lastGood, start + 1), hardEnd);
}

function scanBalanced(s, offset, loose) {
  const blocks = [];
  const frags = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c !== '{' && c !== '[') { i++; continue; }
    const probe = s.slice(i, i + 200);
    if (!LOOKS_JSON.test(probe)) {
      const mc = matchClose(s, i);
      if (mc.closed && mc.end - i >= 3) { frags.push({ pos: offset + i, text: s.slice(i, mc.end) }); i = mc.end; }
      else i++;
      continue;
    }
    const mc = matchClose(s, i);
    const end = mc.closed ? mc.end : truncateUnterminated(s, i, mc.end);
    const text = s.slice(i, end);
    if (c === '[' && !loose && !/["'{]/.test(text) && !text.includes('\n')) {
      frags.push({ pos: offset + i, text });
      i = end;
      continue;
    }
    blocks.push({ start: offset + i, end: offset + end, closed: mc.closed });
    i = end;
  }
  return { blocks, frags };
}

function findBlocks(text) {
  const blocks = [];
  const skipped = [];
  const fenceRe = /```([A-Za-z0-9_+.-]*)[ \t]*\r?\n?([\s\S]*?)```/g;
  const ranges = [];

  for (const m of text.matchAll(fenceRe)) {
    ranges.push([m.index, m.index + m[0].length]);
    const lang = (m[1] || '').toLowerCase();
    const inner = m[2];
    const innerStart = m.index + m[0].length - 3 - inner.length;
    const trimmed = inner.trim();
    if (!trimmed) continue;
    const isJsonLang = /^(json|jsonc|json5|jsonl)$/.test(lang);
    if (isJsonLang || LOOKS_JSON.test(trimmed)) {
      const found = scanBalanced(inner, innerStart, true);
      if (found.blocks.length) blocks.push(...found.blocks.map((b) => ({ ...b, fenced: true })));
      else {
        const off = innerStart + inner.indexOf(trimmed);
        blocks.push({ start: off, end: off + trimmed.length, closed: true, fenced: true });
      }
      found.frags.forEach((f) => skipped.push({ kind: 'fragment', pos: f.pos, preview: preview(f.text) }));
    } else {
      skipped.push({ kind: 'code', lang: lang || 'text', pos: innerStart, preview: preview(trimmed) });
    }
  }

  let scan = text;
  if (ranges.length) {
    const arr = text.split('');
    for (const [a, b] of ranges) for (let k = a; k < b; k++) if (arr[k] !== '\n') arr[k] = ' ';
    scan = arr.join('');
  }
  const loose = scanBalanced(scan, 0, false);
  blocks.push(...loose.blocks);
  loose.frags.forEach((f) => skipped.push({ kind: 'fragment', pos: f.pos, preview: preview(f.text) }));

  blocks.sort((a, b) => a.start - b.start);
  return { blocks: blocks.slice(0, MAX_BLOCKS), truncatedBlocks: Math.max(0, blocks.length - MAX_BLOCKS), skipped };
}

// ─── Role detection: request payload vs API response ───────────────

const REQ_RE = /\b(request(?:\s+(?:payload|body|data|json))?|payload|body\s+sent|sent|sending|submitted|submitting|input|curl|posting)\b/gi;
const RESP_RE = /\b(response(?:\s+body)?|responded|returns?|returned|returning|result|received|reply|replied|output|server\s+(?:says|said|returned)|api\s+(?:says|said|returned))\b/gi;

function lastMatchIndex(re, s) {
  const g = new RegExp(re.source, 'gi');
  let idx = -1, m;
  while ((m = g.exec(s))) { idx = m.index; if (m[0].length === 0) g.lastIndex++; }
  return idx;
}

function classifyRole(ctx, value) {
  const label = ctx.slice(-140);
  let r = lastMatchIndex(REQ_RE, label);
  let p = lastMatchIndex(RESP_RE, label);
  if (r !== -1 || p !== -1) return r > p ? 'request' : 'response';
  const wide = ctx.slice(-400);
  r = lastMatchIndex(REQ_RE, wide);
  p = lastMatchIndex(RESP_RE, wide);
  if (r !== -1 || p !== -1) return r > p ? 'request' : 'response';
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const keys = Object.keys(value);
    if (['error', 'errors', 'success', 'statusCode', 'detail', 'status'].some((k) => keys.includes(k))) return 'response';
  }
  return 'unknown';
}

function inferRoles(blocks) {
  if (blocks.length < 2) return;
  const hasResp = blocks.some((b) => b.role === 'response');
  const hasReq = blocks.some((b) => b.role === 'request');
  const unknown = blocks.filter((b) => b.role === 'unknown');
  if (unknown.length !== 1) return;
  if (hasResp && !hasReq) { unknown[0].role = 'request'; unknown[0].roleInferred = true; }
  else if (hasReq && !hasResp) { unknown[0].role = 'response'; unknown[0].roleInferred = true; }
}

const ROLE_LABEL = { request: 'request payload', response: 'API response body', unknown: 'JSON block (role unclear)' };

// ─── Per-block analysis ────────────────────────────────────────────

function analyzeBlock(text, b) {
  const src = text.slice(b.start, b.end);
  const res = {
    src, start: b.start, end: b.end, closed: b.closed,
    valid: false, hasValue: false, value: undefined,
    fixes: [], warnings: [], missingKeys: [],
    nativeErr: null, nativeLC: null, crash: null,
    corrected: null, correctedOk: false, fieldsTotal: 0, fieldsKept: 0,
  };

  try { res.value = JSON.parse(src); res.valid = true; res.hasValue = true; }
  catch (e) {
    res.nativeErr = e.message;
    const pm = e.message.match(/position (\d+)/);
    if (pm) res.nativeLC = lineCol(text, b.start + Number(pm[1]));
  }

  try {
    const r = lenientParse(src);
    res.warnings = r.warnings.map((w) => ({ ...w, ...lineCol(text, b.start + w.pos) }));
    if (!res.valid) {
      res.value = r.value;
      res.hasValue = true;
      res.fixes = r.fixes
        .map((f) => ({ ...f, ...lineCol(text, b.start + f.pos) }))
        .sort((x, y) => x.pos - y.pos);
      res.missingKeys = r.missingKeys;
      res.fieldsTotal = r.keyTokens;
      res.fieldsKept = countKeys(r.value);
    }
  } catch (e) {
    if (!res.valid) res.crash = e.message;
  }

  if (!res.valid && res.hasValue) {
    const pretty = JSON.stringify(res.value, null, 2);
    try { res.correctedOk = JSON.stringify(JSON.parse(pretty)) === JSON.stringify(res.value); } catch { res.correctedOk = false; }
    res.corrected = pretty;
  }
  res.needsReview = res.fixes.filter((f) => f.kind === 'guess').length;
  return res;
}

// ─── Structure review ──────────────────────────────────────────────

function inspectValue(root) {
  const out = { nulls: [], empties: [], numStr: [], boolStr: [], mixedArrays: [], inconsistent: [], maxDepth: 0, nodes: 0, keyStyles: { snake: 0, camel: 0 } };
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
        if (/_/.test(k) && /^[a-z0-9_]+$/.test(k)) out.keyStyles.snake++;
        else if (/^[a-z]+[A-Z]/.test(k)) out.keyStyles.camel++;
        walk(v[k], /^[A-Za-z_$][\w$]*$/.test(k) ? `${path}.${k}` : `${path}["${k}"]`, depth + 1);
      }
    }
  }
  walk(root, '$', 1);
  return out;
}

// ─── Server complaints and semantic checks ─────────────────────────

const MSG_KEYS = ['message', 'msg', 'detail', 'error', 'reason', 'description', 'error_description', 'title'];
const FIELD_KEYS = ['field', 'param', 'parameter', 'property', 'attribute', 'path', 'loc', 'pointer', 'dataPath', 'instancePath'];
const CONTAINER_KEYS = ['errors', 'error', 'details', 'detail', 'validation', 'validation_errors', 'validationErrors', 'fieldErrors', 'fields', 'issues', 'violations', 'invalid_fields'];

const RULE_RE = {
  required: /\b(required|missing|must be (?:provided|supplied|present)|cannot be (?:blank|empty|null)|can't be (?:blank|empty)|may not be (?:null|empty|blank)|should not be (?:empty|null)|is (?:blank|empty)|not (?:be )?(?:blank|empty|null))\b/i,
  lengthWord: /char|length|long|letter|digit|symbol/i,
  min: /(?:at least|minimum(?: length)?(?: of)?|min(?:imum)?(?: length)?(?: of)?|no (?:fewer|less) than|longer than)\s*(\d+)|(\d+)\s*(?:or more|\+)/i,
  max: /(?:at most|maximum(?: length)?(?: of)?|max(?:imum)?(?: length)?(?: of)?|no (?:more|longer) than|shorter than|less than|exceeds?|up to|not exceed|under)\s*(\d+)/i,
  exact: /exactly\s*(\d+)|must be (\d+) char/i,
  email: /valid e-?mail|e-?mail (?:is )?(?:invalid|not valid)|invalid e-?mail/i,
  type: /(?:must|should) be (?:a |an )?(string|number|integer|boolean|array|object)|expected (string|number|integer|boolean|array|object)/i,
};

const matchesAnyRule = (m) => RULE_RE.required.test(m) || (RULE_RE.lengthWord.test(m) && (RULE_RE.min.test(m) || RULE_RE.max.test(m) || RULE_RE.exact.test(m) || /too (short|long)/i.test(m))) || RULE_RE.email.test(m) || RULE_RE.type.test(m);

function lastSegment(v) {
  if (Array.isArray(v)) {
    const s = v.filter((x) => typeof x === 'string' || typeof x === 'number');
    return s.length ? String(s[s.length - 1]) : null;
  }
  if (typeof v === 'string') {
    const p = v.split(/[./\[\]]+/).filter(Boolean);
    return p.length ? p[p.length - 1] : null;
  }
  return null;
}

function collectComplaints(root) {
  const out = [];
  const seen = new Set();
  const push = (field, message) => {
    if (typeof message !== 'string' || !message.trim()) return;
    const k = `${field || ''}|${message}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ field: field || null, message: message.trim() });
  };
  function walk(v, depth, inContainer) {
    if (depth > 6 || v == null) return;
    if (Array.isArray(v)) {
      v.slice(0, 50).forEach((x) => {
        if (typeof x === 'string') { if (inContainer) push(null, x); }
        else walk(x, depth + 1, inContainer);
      });
      return;
    }
    if (typeof v !== 'object') return;
    const mk = MSG_KEYS.find((k) => typeof v[k] === 'string');
    const fk = FIELD_KEYS.find((k) => k in v && (typeof v[k] === 'string' || Array.isArray(v[k])));
    if (mk && fk) push(lastSegment(v[fk]), v[mk]);
    else if (mk && inContainer) push(null, v[mk]);
    if (v.constraints && typeof v.constraints === 'object') {
      const f = lastSegment(v.property ?? v.field);
      Object.values(v.constraints).forEach((m) => push(f, m));
    }
    for (const k of Object.keys(v)) {
      const val = v[k];
      if (CONTAINER_KEYS.includes(k)) {
        if (typeof val === 'string') { if (k !== 'detail' || true) push(null, val); }
        else if (val && typeof val === 'object' && !Array.isArray(val)) {
          const hasMsg = MSG_KEYS.some((mkk) => typeof val[mkk] === 'string');
          if (hasMsg) walk(val, depth + 1, true);
          else {
            for (const [fname, fv] of Object.entries(val)) {
              if (typeof fv === 'string') push(fname, fv);
              else if (Array.isArray(fv) && fv.length && fv.every((x) => typeof x === 'string')) fv.forEach((m) => push(fname, m));
              else if (fv && typeof fv === 'object') walk(fv, depth + 1, true);
            }
          }
        } else walk(val, depth + 1, true);
      } else if (val && typeof val === 'object') walk(val, depth + 1, inContainer);
    }
  }
  walk(root, 0, false);
  return out.filter((c) => c.field || matchesAnyRule(c.message));
}

function findField(value, name, depth = 0) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 4) return { found: false };
  const target = norm(name);
  for (const k of Object.keys(value)) if (norm(k) === target) return { found: true, key: k, value: value[k] };
  for (const k of Object.keys(value)) {
    if (value[k] && typeof value[k] === 'object' && !Array.isArray(value[k])) {
      const r = findField(value[k], name, depth + 1);
      if (r.found) return r;
    }
  }
  return { found: false };
}

function inferField(message, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const lower = message.toLowerCase();
  const keys = [];
  (function collect(v, d) {
    if (!v || typeof v !== 'object' || Array.isArray(v) || d > 3) return;
    for (const k of Object.keys(v)) { keys.push(k); collect(v[k], d + 1); }
  })(value, 0);
  return keys.find((k) => k.length >= 3 && lower.includes(k.toLowerCase())) || null;
}

const showVal = (name, v) => {
  if (isSensitive(name)) return '<hidden>';
  if (typeof v === 'string') return `"${v.length > 40 ? v.slice(0, 40) + '...' : v}"`;
  return JSON.stringify(v);
};

function evaluateComplaint(c, requests) {
  const msg = c.message;
  let field = c.field;
  let hit = null;
  const tryFind = (name) => {
    for (const r of requests) {
      const f = findField(r.value, name);
      if (f.found) return { ...f, block: r };
    }
    return null;
  };
  if (!field) {
    for (const r of requests) { const inf = inferField(msg, r.value); if (inf) { field = inf; break; } }
  }
  if (field) hit = tryFind(field);

  const where = requests.length === 1 ? `Block ${requests[0].index}` : 'the request blocks';
  const res = { field, message: msg, state: 'info', text: '' };

  if (!field) {
    res.text = 'No field name could be matched to this message - check it manually against the request.';
    return res;
  }

  const lenCtx = RULE_RE.lengthWord.test(msg);
  const minM = lenCtx ? msg.match(RULE_RE.min) : null;
  const maxM = lenCtx && !minM ? msg.match(RULE_RE.max) : null;
  const exactM = lenCtx ? msg.match(RULE_RE.exact) : null;
  const typeM = msg.match(RULE_RE.type);

  // Required / missing / empty
  if (RULE_RE.required.test(msg) && !minM && !maxM) {
    if (!hit) {
      res.state = 'confirmed';
      res.text = `There is no field "${field}" in the request payload (${where}).`;
    } else if (hit.value === null || hit.value === '' || hit.value === undefined) {
      res.state = 'confirmed';
      const fromMissing = hit.block.missingKeys.includes(hit.key);
      res.text = fromMissing
        ? `"${hit.key}" has no value in your payload (the value after the colon is missing).`
        : `"${hit.key}" is present but empty (${hit.value === null ? 'null' : 'empty string'}).`;
    } else {
      res.state = 'unconfirmed';
      res.text = `"${hit.key}" is present with a value (${showVal(hit.key, hit.value)}). The server may expect a different name, nesting, type or Content-Type - compare with the API docs.`;
    }
    return res;
  }

  if (!hit) {
    res.state = 'info';
    res.text = `The server mentions "${field}" but no such field exists in the request payload (${where}).`;
    return res;
  }

  const v = hit.value;
  const isStr = typeof v === 'string';

  if (minM || maxM || exactM || /too (short|long)/i.test(msg)) {
    if (!isStr) {
      res.state = 'info';
      res.text = `"${hit.key}" is a ${typeOf(v)}, not text, so a length rule cannot be applied.`;
      return res;
    }
    const len = v.length;
    if (minM) {
      const N = Number(minM[1] ?? minM[2]);
      if (len < N) { res.state = 'confirmed'; res.text = `"${hit.key}" has ${len} character${len === 1 ? '' : 's'}; the server requires at least ${N}.`; }
      else { res.state = 'unconfirmed'; res.text = `"${hit.key}" has ${len} characters, which meets the minimum of ${N}. Another rule may be failing (e.g. needs an uppercase letter, digit or symbol).`; }
      return res;
    }
    if (maxM) {
      const N = Number(maxM[1]);
      if (len > N) { res.state = 'confirmed'; res.text = `"${hit.key}" has ${len} characters; the server allows at most ${N}.`; }
      else { res.state = 'unconfirmed'; res.text = `"${hit.key}" has ${len} characters, within the maximum of ${N}. Another rule may be failing.`; }
      return res;
    }
    if (exactM) {
      const N = Number(exactM[1] ?? exactM[2]);
      if (len !== N) { res.state = 'confirmed'; res.text = `"${hit.key}" has ${len} characters; the server requires exactly ${N}.`; }
      else { res.state = 'unconfirmed'; res.text = `"${hit.key}" has exactly ${N} characters - a different rule may be failing.`; }
      return res;
    }
    res.state = 'info';
    res.text = `"${hit.key}" has ${len} characters. The server did not state the limit - check the API docs.`;
    return res;
  }

  if (RULE_RE.email.test(msg)) {
    const ok = isStr && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
    if (!ok) { res.state = 'confirmed'; res.text = `"${hit.key}" (${showVal(hit.key, v)}) does not look like a valid email address.`; }
    else { res.state = 'unconfirmed'; res.text = `"${hit.key}" looks like a valid email format. The server may apply extra rules (blocked domain, already registered).`; }
    return res;
  }

  if (typeM) {
    const want = (typeM[1] || typeM[2]).toLowerCase();
    const actual = typeOf(v);
    const ok = want === 'integer' ? Number.isInteger(v) : want === actual;
    if (!ok) { res.state = 'confirmed'; res.text = `"${hit.key}" is a ${actual}; the server expects ${want === 'integer' ? 'an integer' : `a ${want}`}.`; }
    else { res.state = 'unconfirmed'; res.text = `"${hit.key}" is already a ${actual}. Check format or range rules in the docs.`; }
    return res;
  }

  res.text = `"${hit.key}" = ${showVal(hit.key, v)}. No automatic rule matched this message - check it against the API docs.`;
  return res;
}

// ─── Status codes, error shapes ────────────────────────────────────

function findStatusCodes(text, values) {
  const found = new Set();
  const ctx = /\b(http|status|error|code|response|request|failed|failure)\b/i.test(text) || text.trim().length < 80;
  if (ctx) for (const m of text.matchAll(/\b([1-5]\d{2})\b/g)) found.add(Number(m[1]));
  for (const parsed of values) {
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const k of ['status', 'statusCode', 'status_code', 'code', 'httpStatus']) {
        const v = parsed[k];
        if (typeof v === 'number' && v >= 100 && v < 600) found.add(v);
        if (typeof v === 'string' && /^[1-5]\d{2}$/.test(v)) found.add(Number(v));
      }
    }
  }
  return [...found].filter((c) => HTTP_KB[c]).slice(0, 3);
}

function describeErrorShape(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const keys = Object.keys(obj);
  const trigger = ['error', 'errors', 'message', 'detail', 'error_description', 'error_message'];
  if (!trigger.some((k) => keys.includes(k))) return null;
  const show = ['success', 'error', 'errors', 'message', 'msg', 'detail', 'details', 'error_description', 'error_message', 'code', 'status', 'statusCode', 'reason'];
  return show.filter((k) => keys.includes(k)).slice(0, 7).map((k) => {
    const v = obj[k];
    if (v && typeof v === 'object') return `  ${k}: ${Array.isArray(v) ? `${v.length} item(s)` : `${Object.keys(v).length} field(s)`} (details below)`;
    let s = typeof v === 'string' ? v : JSON.stringify(v);
    if (s && s.length > 140) s = s.slice(0, 140) + '...';
    return `  ${k}: ${isSensitive(k) ? '<hidden>' : s}`;
  }).join('\n');
}

// ─── Rendering ─────────────────────────────────────────────────────

function renderBlock(b, multi, total) {
  const L = [];
  const status = b.valid
    ? 'valid JSON'
    : b.hasValue
      ? `INVALID - ${b.fixes.length} problem${b.fixes.length === 1 ? '' : 's'}${b.needsReview ? ` (${b.needsReview} need${b.needsReview === 1 ? 's' : ''} your review)` : ''}`
      : 'INVALID - could not be repaired';

  if (multi) {
    L.push(SUB);
    L.push(`BLOCK ${b.index} OF ${total} - ${ROLE_LABEL[b.role]}${b.roleInferred ? ' (inferred from context)' : ''}`);
    L.push(`  Starts at line ${b.line} | ${status}`);
    if (!b.closed) L.push('  Note: this block was never closed - its end was estimated.');
  }

  if (!b.valid) {
    L.push('');
    if (!multi) L.push(SUB);
    L.push('PROBLEMS FOUND (line:column in your input)');
    if (b.nativeErr) {
      const where = b.nativeLC ? ` -> line ${b.nativeLC.line}, column ${b.nativeLC.col} of your input` : '';
      L.push(`  Parser said: ${b.nativeErr}${where}`);
    }
    if (b.crash) L.push(`  Repair stopped: ${b.crash}`);
    b.fixes.slice(0, MAX_FIXES_SHOWN).forEach((f, idx) => {
      L.push(`  ${idx + 1}. [${f.line}:${f.col}]${f.kind === 'guess' ? ' (needs review)' : ''} ${f.msg}`);
    });
    if (b.fixes.length > MAX_FIXES_SHOWN) L.push(`  ... and ${b.fixes.length - MAX_FIXES_SHOWN} more`);
  }

  if (b.warnings.length) {
    L.push('');
    if (!multi && b.valid) L.push(SUB);
    L.push('WARNINGS');
    b.warnings.slice(0, 10).forEach((w) => L.push(`  - [${w.line}:${w.col}] ${w.msg}`));
  }

  if (!b.valid && b.hasValue) {
    let pretty = b.corrected;
    let cut = false;
    if (pretty.length > MAX_OUTPUT_JSON_CHARS) { pretty = pretty.slice(0, MAX_OUTPUT_JSON_CHARS); cut = true; }
    L.push('');
    L.push(SUB);
    if (b.needsReview) L.push(`BEST-EFFORT CORRECTION (not final - ${b.needsReview} point${b.needsReview === 1 ? '' : 's'} need your decision)`);
    else L.push('CORRECTED JSON');
    L.push(pretty);
    if (cut) L.push(`... (shortened for display; the full corrected document is ${b.corrected.length.toLocaleString()} characters)`);
    L.push('');
    if (b.correctedOk) L.push('Validated: this corrected text parses successfully with JSON.parse (syntax only).');
    else L.push('WARNING: the corrected text could NOT be validated with JSON.parse. Do not use it.');
    const dropped = b.fieldsTotal - b.fieldsKept;
    L.push(dropped > 0
      ? `Fields: ${b.fieldsKept} kept; ${dropped} duplicate-key value(s) were discarded (see warnings).`
      : `Fields: all ${b.fieldsKept} original field${b.fieldsKept === 1 ? '' : 's'} preserved; only the problems listed above were changed.`);
    if (b.needsReview) {
      L.push('');
      L.push('NEEDS YOUR DECISION (these are guesses, not certain fixes):');
      b.fixes.filter((f) => f.kind === 'guess').slice(0, 10).forEach((f) => L.push(`  - [${f.line}:${f.col}] ${f.msg}`));
      L.push('Do not send placeholders (null, guessed values) to the API - supply the real values.');
    }
  } else if (!b.valid) {
    L.push('');
    L.push('No repair was attempted: the structure is too ambiguous to correct without inventing content.');
  }

  if (b.hasValue) {
    const info = inspectValue(b.value);
    const rootType = typeOf(b.value);
    L.push('');
    L.push(SUB);
    L.push('STRUCTURE');
    const size = rootType === 'array' ? `${b.value.length} items` : rootType === 'object' ? `${Object.keys(b.value).length} top-level keys` : rootType;
    L.push(`  Root: ${rootType} (${size}), depth ${info.maxDepth}, ${info.nodes.toLocaleString()} values`);
    const obs = [];
    if (info.nulls.length) obs.push(`null values at: ${info.nulls.slice(0, 6).join(', ')}${info.nulls.length > 6 ? ` (+${info.nulls.length - 6} more)` : ''}`);
    if (info.empties.length) obs.push(`empty values at: ${info.empties.slice(0, 6).join(', ')}${info.empties.length > 6 ? ` (+${info.empties.length - 6} more)` : ''}`);
    if (info.numStr.length) obs.push(`numbers stored as text at: ${info.numStr.slice(0, 5).join(', ')} - check if these should be numeric`);
    if (info.boolStr.length) obs.push(`"true"/"false" stored as text at: ${info.boolStr.slice(0, 5).join(', ')} - check if these should be booleans`);
    info.mixedArrays.slice(0, 3).forEach((m) => obs.push(`mixed types: ${m}`));
    info.inconsistent.slice(0, 3).forEach((m) => obs.push(`inconsistent items: ${m}`));
    if (info.keyStyles.snake > 0 && info.keyStyles.camel > 0) obs.push(`mixed key styles (${info.keyStyles.snake} snake_case, ${info.keyStyles.camel} camelCase) - pick one`);
    if (info.maxDepth > 8) obs.push(`very deep nesting (${info.maxDepth} levels) - consider flattening`);
    if (!obs.length) obs.push('no structural issues detected');
    obs.forEach((o) => L.push(`  - ${o}`));

    if (b.role !== 'request') {
      const shape = describeErrorShape(b.value);
      if (shape) {
        L.push('');
        L.push(SUB);
        L.push('THIS LOOKS LIKE AN API ERROR RESPONSE');
        L.push('  Key fields:');
        L.push(shape);
        const comps = collectComplaints(b.value);
        if (comps.length) {
          L.push('  Problems the server reported:');
          comps.slice(0, 10).forEach((c) => L.push(`    - ${c.field ? `${c.field}: ` : ''}${c.message}`));
        }
      }
    }
  }
  return L;
}

// ─── Main entry ────────────────────────────────────────────────────

export function analyze(rawInput) {
  let text = String(rawInput ?? '');
  let truncated = false;
  if (text.length > MAX_INPUT_CHARS) { text = text.slice(0, MAX_INPUT_CHARS); truncated = true; }
  text = text.replace(/^\uFEFF/, '');

  const out = [];
  out.push('API ERROR & JSON DEBUGGER REPORT');
  out.push(SEP);

  if (!text.trim()) {
    out.push('No input received.');
    out.push('');
    out.push('Send one of these and I will diagnose it:');
    out.push('  - a JSON payload that fails to parse');
    out.push('  - an API error response (with or without the HTTP status)');
    out.push('  - a request payload together with the error the API returned');
    out.push('  - an error message or stack trace line');
    out.push(SEP);
    return { report: out.join('\n'), summary: { verdict: 'empty', blocks: [] } };
  }

  // 1. Find and analyse every JSON block independently
  const found = findBlocks(text);
  let prevEnd = 0;
  const blocks = found.blocks.map((b, idx) => {
    const a = analyzeBlock(text, b);
    const ctx = text.slice(prevEnd, b.start).replace(/```[A-Za-z0-9_+.-]*/g, ' ');
    prevEnd = b.end;
    a.index = idx + 1;
    a.line = lineCol(text, b.start).line;
    a.role = classifyRole(ctx, a.value);
    return a;
  });
  inferRoles(blocks);
  const total = blocks.length;
  const multi = total > 1;

  // 2. Prose = everything outside the JSON blocks (used for context and diagnosis)
  let prose = '';
  let cursor = 0;
  for (const b of blocks) { prose += text.slice(cursor, b.start) + ' '; cursor = b.end; }
  prose += text.slice(cursor);
  prose = prose.replace(/```[A-Za-z0-9_+.-]*/g, ' ').replace(/\s+/g, ' ').trim();

  const invalid = blocks.filter((b) => !b.valid);
  const unrepairable = invalid.filter((b) => !b.hasValue);
  const repaired = invalid.filter((b) => b.hasValue);
  const verdictKey = !total ? 'error-text' : unrepairable.length ? 'unrepairable' : repaired.length ? 'repaired' : 'valid';
  const roleCount = (r) => blocks.filter((b) => b.role === r).length;

  // 3. Header
  let kind;
  if (!total) kind = 'Error message / plain text';
  else if (!multi) kind = blocks[0].valid ? 'JSON (valid)' : blocks[0].hasValue ? 'JSON (invalid, repairable)' : 'JSON (invalid, could not repair)';
  else {
    const parts = [];
    if (roleCount('response')) parts.push(`${roleCount('response')} response`);
    if (roleCount('request')) parts.push(`${roleCount('request')} request`);
    if (roleCount('unknown')) parts.push(`${roleCount('unknown')} unclear`);
    kind = `Text with ${total} JSON blocks (${parts.join(', ')})`;
  }
  out.push(`Input type : ${kind}`);
  out.push(`Size       : ${text.length.toLocaleString()} characters${truncated ? ' (truncated to the first 200,000)' : ''}`);
  const ep = prose.match(/\b(GET|POST|PUT|PATCH|DELETE)\s+(\/[^\s,;]*|https?:\/\/[^\s,;]*)/);
  if (ep) out.push(`Endpoint   : ${ep[1]} ${ep[2]}`);

  // 4. Verdict
  out.push('');
  out.push('VERDICT');
  if (!total) {
    out.push('  This looks like an error message rather than JSON. Diagnosis below.');
  } else if (!multi) {
    const b = blocks[0];
    if (b.valid) out.push('  This JSON is valid.');
    else if (b.hasValue) out.push(`  This JSON is NOT valid. ${b.fixes.length} problem${b.fixes.length === 1 ? '' : 's'} found; ${b.needsReview ? 'a best-effort correction is below - it needs your review.' : 'a corrected version is below.'}`);
    else out.push('  This JSON is NOT valid and could not be repaired automatically.');
  } else {
    out.push(`  ${total} JSON blocks found.`);
    if (!invalid.length) out.push('  All blocks are valid JSON.');
    else out.push(`  The syntax error${invalid.length === 1 ? ' is' : 's are'} in ${invalid.map((b) => `Block ${b.index} (${ROLE_LABEL[b.role]}, line ${b.line})`).join(' and ')}.`);
    blocks.forEach((b) => {
      const st = b.valid ? 'valid JSON' : b.hasValue ? `INVALID - ${b.fixes.length} problem${b.fixes.length === 1 ? '' : 's'}${b.needsReview ? ` (${b.needsReview} need review)` : ''}` : 'INVALID - could not be repaired';
      out.push(`  Block ${b.index} (${ROLE_LABEL[b.role]}, line ${b.line}): ${st}`);
    });
  }
  if (found.truncatedBlocks) out.push(`  Note: ${found.truncatedBlocks} further JSON block(s) beyond the first ${MAX_BLOCKS} were not analysed.`);

  // 5. Per-block detail
  blocks.forEach((b) => out.push(...renderBlock(b, multi, total)));

  // 6. Semantic cross-check: server complaints vs request payload
  const responses = blocks.filter((b) => b.role === 'response' && b.hasValue);
  const requests = blocks.filter((b) => b.role === 'request' && b.hasValue);
  const complaints = responses.flatMap((b) => collectComplaints(b.value));
  let checks = [];
  if (complaints.length && requests.length) {
    checks = complaints.map((c) => evaluateComplaint(c, requests));
    const confirmed = checks.filter((c) => c.state === 'confirmed').length;
    out.push('');
    out.push(SUB);
    out.push('SEMANTIC CHECK (server complaints vs your request payload)');
    checks.slice(0, 15).forEach((c, idx) => {
      out.push(`  ${idx + 1}. ${c.field ? `${c.field} - ` : ''}server says: "${c.message}"`);
      const tag = c.state === 'confirmed' ? '[CONFIRMED]' : c.state === 'unconfirmed' ? '[NOT CONFIRMED]' : '[INFO]';
      out.push(`     ${tag} ${c.text}`);
    });
    out.push(`  Result: ${confirmed} of ${checks.length} server complaint${checks.length === 1 ? '' : 's'} ${confirmed === 1 ? 'is' : 'are'} explained by what is in your request payload.`);
  } else if (complaints.length && !requests.length) {
    out.push('');
    out.push(SUB);
    out.push('SEMANTIC CHECK');
    out.push(`  The server reported ${complaints.length} field problem${complaints.length === 1 ? '' : 's'}, but no request payload was found to check them against.`);
    out.push('  Send the request payload together with the response for a field-by-field comparison.');
  }

  // 7. Diagnosis from surrounding text and response bodies
  const diag = [];
  const codes = findStatusCodes(prose, responses.map((b) => b.value));
  for (const c of codes) {
    const [name, meaning, causes, fixesList] = HTTP_KB[c];
    diag.push({ title: `HTTP ${c} - ${name}`, explain: meaning, causes, fixes: fixesList });
  }
  const msgSource = [prose, ...responses.map((b) => JSON.stringify(b.value ?? ''))].join(' ');
  const allValid = total > 0 && !invalid.length;
  for (const k of MSG_KB) {
    if (k.re.test(msgSource) && !(allValid && k.title === 'Malformed JSON')) {
      diag.push({ title: k.title, explain: k.explain, causes: [], fixes: k.fixes });
    }
    if (diag.length >= 5) break;
  }
  if (diag.length) {
    out.push('');
    out.push(SUB);
    out.push('DIAGNOSIS');
    diag.forEach((d, idx) => {
      out.push(`  ${idx + 1}. ${d.title}`);
      out.push(`     ${d.explain}`);
      if (d.causes.length) out.push(`     Common causes: ${d.causes.join('; ')}`);
      out.push('     What to try:');
      d.fixes.forEach((f) => out.push(`       - ${f}`));
    });
  } else if (!total) {
    out.push('');
    out.push(SUB);
    out.push('DIAGNOSIS');
    out.push('  No known error pattern matched.');
    out.push('  To get a sharper diagnosis, send: the full error text, the HTTP status');
    out.push('  code, and the request body that triggered it.');
  }

  // 8. Content that could not be interpreted
  const notes = [];
  found.skipped.slice(0, 6).forEach((s) => {
    const lc = lineCol(text, s.pos);
    notes.push(s.kind === 'code'
      ? `Code block (${s.lang}) at line ${lc.line} is not JSON, so it was not analysed: ${s.preview}`
      : `Text in braces at line ${lc.line} was not recognised as JSON and was not analysed: ${s.preview}`);
  });
  if (found.skipped.length > 6) notes.push(`... and ${found.skipped.length - 6} more fragment(s)`);
  if (notes.length) {
    out.push('');
    out.push(SUB);
    out.push('NOT ANALYSED (content that could not be interpreted)');
    notes.forEach((n) => out.push(`  - ${n}`));
  }
  if (multi || prose) {
    const hasContext = prose.length > 0 && total > 0;
    if (hasContext) { out.push(''); out.push('The text around the JSON was used for context only (roles, status codes, endpoint).'); }
  }

  // 9. Next steps
  out.push('');
  out.push(SUB);
  out.push('NEXT STEPS');
  let step = 1;
  const next = (s) => out.push(`  ${step++}. ${s}`);
  if (invalid.length) {
    invalid.forEach((b) => {
      if (b.hasValue) next(`Fix Block ${b.index} (${ROLE_LABEL[b.role]}, line ${b.line})${b.needsReview ? ': settle the points marked "needs review", then use the corrected version' : ': replace it with the corrected JSON above'}.`);
      else next(`Block ${b.index} (line ${b.line}) needs manual repair - re-check its brackets and quotes.`);
    });
  }
  const confirmedFields = checks.filter((c) => c.state === 'confirmed' && c.field).map((c) => c.field);
  if (confirmedFields.length) next(`Fix the confirmed field problems: ${[...new Set(confirmedFields)].join(', ')}.`);
  if (checks.length && !confirmedFields.length) next('The payload does not explain the server complaints on its own - compare field names, types and rules with the API docs.');
  if (invalid.length) next('Fix the source that generates the payload, and validate before sending: JSON.parse(text) inside try/catch.');
  if (!invalid.length && total && !checks.length) {
    next('The syntax is fine - if the API still rejects it, compare field names and types with its docs.');
    next("Send the API's error response (and the request payload) together and I can diagnose the rejection.");
  }
  if (!total) {
    next('Apply the suggestions above, starting with the first.');
    next('If it persists, send the full error text plus the request that caused it.');
  }

  out.push('');
  out.push(SEP);
  out.push('Checked by API Error & JSON Debugger - deterministic analysis, no data stored.');

  return {
    report: out.join('\n'),
    summary: {
      verdict: verdictKey,
      problems: blocks.reduce((n, b) => n + b.fixes.length, 0),
      statusCodes: codes,
      blocks: blocks.map((b) => ({
        index: b.index, role: b.role, line: b.line, valid: b.valid, repaired: !b.valid && b.hasValue,
        problems: b.fixes.length, needsReview: b.needsReview,
        fixes: b.fixes.map((f) => ({ line: f.line, col: f.col, kind: f.kind, msg: f.msg })),
        corrected: b.corrected, correctedValidated: b.correctedOk,
      })),
      semantic: { checked: checks.length, confirmed: checks.filter((c) => c.state === 'confirmed').length },
      skipped: found.skipped.length,
    },
  };
}

export { lenientParse, findBlocks };
