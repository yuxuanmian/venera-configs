// VM harness for the semantic tag-search contracts (Contract P / Contract S).
//
// It deliberately mirrors `test/scan/source_harness.js` (same `node:vm` loading
// style, same `ComicSource` stand-in) without touching the scan harness.
// Unlike the scan harness here the whole `Network` surface is intercepted, so
// the source talks to an injected responder and never performs real I/O.
//
// What is recorded per request (`calls` entries):
//   - `url`, `path`, `method`, `page` (query parameter, null when absent)
//   - `kind`: 'candidate' (advanced-search), 'login' (auth/sign-in), 'other'
//   - `body` / `json`: the sent body and its parsed form, so `keyword` and
//     `sort` can be asserted.  Bodies of login requests are credential
//     bearing and are NEVER retained; neither are headers or responses.
//   - `startedAt` / `finishedAt`: start order and completion order.
//
// Aggregate counters: `inFlight`, `peakInFlight` (peak concurrent requests)
// and `loginPostCount` (requests to the login endpoint).

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ADVANCED_SEARCH_PATH = '/comics/advanced-search';
const LOGIN_PATH = '/auth/sign-in';

// The shared source library is the canonical declaration of the source-side
// semantic defaults, and the host injects it into every source runtime.  The
// harness therefore reads the value out of that same file instead of
// re-declaring it, so a change to the shared default reaches these tests
// without a second copy to keep in sync.
//
// Only the constant is lifted out (rather than evaluating the whole library):
// the library declares `Network`, `createUuid` and the other host-backed
// globals itself, and the harness must keep supplying those.
const SHARED_LIBRARY = fs.readFileSync(
  path.join(__dirname, '..', '..', '_venera_.js'),
  'utf8',
);

const sharedSemanticDefaults = () => {
  const defaults = {};
  const pattern = /^\s*const\s+(SEMANTIC_SEARCH_[A-Z_]+)\s*=\s*(\d+)\s*;?\s*$/gm;
  for (const match of SHARED_LIBRARY.matchAll(pattern)) {
    defaults[match[1]] = Number(match[2]);
  }
  if (Object.keys(defaults).length === 0) {
    throw new Error('the shared source library must declare its semantic search default');
  }
  return defaults;
};

// Minimal stand-in for the Host `Comic` value object.
class Comic {
  constructor(value) {
    Object.assign(this, value);
  }
}

const parseJsonOrNull = (value) => {
  if (typeof value !== 'string') return undefined;
  try {
    return JSON.parse(value);
  } catch (_) {
    return undefined;
  }
};

const ok = (body) => ({status: 200, headers: {}, body});

const failureResponse = (status) => ({status, headers: {}, body: ''});

// Synthetic token only.  Nothing here is a real credential.
const authResponse = (token = 'synthetic-token') =>
  ok(JSON.stringify({data: {token}}));

// Paginated advanced-search response body: `{data: {comics: {docs, pages}}}`.
const searchPageBody = (docs, pages) =>
  JSON.stringify({data: {comics: {docs, pages}}});

const rawComic = (id, overrides = {}) => ({
  _id: id,
  title: `Comic ${id}`,
  author: 'Synthetic Author',
  tags: [],
  categories: [],
  thumb: {fileServer: 'https://img.example.invalid', path: `${id}.jpg`},
  totalLikes: 1,
  pagesCount: 10,
  ...overrides,
});

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return {promise, resolve, reject};
};

const flush = () => new Promise((resolve) => setImmediate(resolve));

const toPlain = (value) => JSON.parse(JSON.stringify(value));

const loadFixture = (fileName) => JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures', fileName),
  'utf8',
));

const loadSource = (fileName, className, {data = {}, responder} = {}) => {
  const sourceCode = fs.readFileSync(path.join(__dirname, '..', '..', fileName), 'utf8');
  class ComicSource {
    constructor() {
      this.data = {...data};
    }

    loadData(key) {
      return this.data[key];
    }

    loadSetting(key) {
      return this.data.settings && this.data.settings[key];
    }

    saveData(key, value) {
      this.data[key] = value;
      return 'ok';
    }

    deleteData(key) {
      delete this.data[key];
    }

    get isLogged() {
      return this.data.account != null;
    }
  }

  const calls = [];
  let inFlight = 0;
  let peakInFlight = 0;
  let loginPostCount = 0;
  let completionOrder = 0;
  const answer = responder || (async () => failureResponse(500));

  const dispatch = async (method, url, body) => {
    const parsed = new URL(url);
    const isLogin = parsed.pathname === LOGIN_PATH;
    const rawPage = parsed.searchParams.get('page');
    const call = {
      index: calls.length,
      method,
      url,
      path: parsed.pathname,
      page: rawPage === null ? null : Number(rawPage),
      kind: isLogin
        ? 'login'
        : (parsed.pathname === ADVANCED_SEARCH_PATH ? 'candidate' : 'other'),
      // Credential-bearing login bodies, headers and responses are dropped.
      body: isLogin ? undefined : (typeof body === 'string' ? body : undefined),
      json: isLogin ? undefined : parseJsonOrNull(body),
      startedAt: calls.length,
      finishedAt: null,
      inflightAtStart: inFlight + 1,
    };
    calls.push(call);
    if (isLogin) loginPostCount += 1;
    inFlight += 1;
    if (inFlight > peakInFlight) peakInFlight = inFlight;
    try {
      const response = await answer(call, {calls, inFlight});
      if (!response || typeof response.status !== 'number') {
        throw new Error(`semantic responder produced no response for ${method} ${parsed.pathname}`);
      }
      return response;
    } finally {
      inFlight -= 1;
      call.finishedAt = completionOrder;
      completionOrder += 1;
    }
  };

  const context = {
    ComicSource,
    Comic,
    Convert: {
      encodeUtf8: (value) => value,
      hmacString: () => 'synthetic-signature',
    },
    createUuid: () => '00000000-0000-4000-8000-000000000000',
    Network: {
      get: (url) => dispatch('GET', url),
      post: (url, headers, body) => dispatch('POST', url, body),
      sendRequest: (request) => dispatch(
        (request && request.method) || 'GET',
        request && request.url,
        request && request.body,
      ),
      fetchBytes: (method, url) => dispatch(method, url),
    },
    console,
    URL,
    Date,
    setTimeout,
    clearTimeout,
    setImmediate,
    // Shared source-side defaults, taken verbatim from the canonical library
    // file the host injects ahead of every source.
    ...sharedSemanticDefaults(),
  };
  vm.runInNewContext(`${sourceCode}\nthis.__Source = ${className};`, context);
  const source = new context.__Source();
  source.data = {...data};

  // Clears the observation window (calls and the peak/login counters) so a
  // test can assert per-invocation maxima.  Call it only between awaited
  // invocations.
  const reset = () => {
    calls.length = 0;
    peakInFlight = 0;
    loginPostCount = 0;
    completionOrder = 0;
  };

  return {
    source,
    calls,
    reset,
    get inFlight() {
      return inFlight;
    },
    get peakInFlight() {
      return peakInFlight;
    },
    get loginPostCount() {
      return loginPostCount;
    },
    candidateCalls: () => calls.filter((call) => call.kind === 'candidate'),
    loginCalls: () => calls.filter((call) => call.kind === 'login'),
  };
};

module.exports = {
  loadSource,
  loadFixture,
  rawComic,
  searchPageBody,
  ok,
  failureResponse,
  authResponse,
  deferred,
  flush,
  toPlain,
  sharedSemanticDefaults,
};
