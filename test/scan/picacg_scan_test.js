const assert = require('node:assert/strict');
const test = require('node:test');
const {loadSource, picacgBody, toPlain} = require('./source_harness');

const make = ({responses, data = {account: ['user@example.test', 'password'], token: 'old-token'}} = {}) => {
  const queue = [...responses];
  data = {
    ...data,
    settings: {
      base_url: 'https://pica.example.invalid',
      ...(data.settings || {}),
    },
  };
  return loadSource('picacg.js', 'Picacg', {
    data,
    request: async (request) => {
      const response = queue.shift();
      if (!response) throw new Error(`unexpected request ${request.method} ${request.url}`);
      if (typeof response === 'function') return response(request);
      return response;
    },
  });
};

test('Picacg scan makes one minimal GET and preserves source timestamp', async () => {
  const harness = make({responses: [{status: 200, headers: {}, body: picacgBody()}]});
  const result = await harness.source.scan.comic.load('comic-1', harness.request);
  assert.deepEqual(toPlain(result), {
    observation: {update: {updatedAt: '2026-09-10T12:30:45.123Z'}},
  });
  assert.equal(harness.calls.length, 1);
  assert.equal(harness.calls[0].method, 'GET');
  assert.match(harness.calls[0].url, /\/comics\/comic-1$/);
});

test('Picacg scan does not use detail chapters or recommendations', async () => {
  const harness = make({responses: [{status: 200, headers: {}, body: picacgBody({updatedAt: '2026-09-10'})}]});
  const original = harness.source.comic.loadInfo;
  harness.source.comic.loadInfo = async () => { throw new Error('detail loader called'); };
  const result = await harness.source.scan.comic.load('comic-1', harness.request);
  assert.equal(result.observation.update.updatedAt, '2026-09-10');
  assert.equal(typeof original, 'function');
  assert.equal(harness.calls.length, 1);
});

test('Picacg scan turns missing/invalid data into a failure envelope', async (t) => {
  for (const body of ['', '{bad-json', JSON.stringify({data: {comic: {}}}), JSON.stringify({data: {comic: {_id: 'other', updated_at: '2026-09-10'}}})]) {
    await t.test(body || 'empty', async () => {
      const harness = make({responses: [{status: 200, headers: {}, body}]});
      const result = await harness.source.scan.comic.load('comic-1', harness.request);
      assert(result.failure);
      assert.equal(harness.calls.length, 1);
    });
  }
});

test('Picacg non-401 statuses are facts and are not retried', async () => {
  for (const status of [403, 404, 503]) {
    const harness = make({responses: [{status, headers: {}, body: '<secret body>'}]});
    const result = await harness.source.scan.comic.load('comic-1', harness.request);
    assert.deepEqual(toPlain(result), {failure: {httpStatus: status, message: 'Picacg comic request failed'}});
    assert.equal(harness.calls.length, 1);
  }
});

test('Picacg performs one bounded 401 recovery and retries the GET once', async () => {
  const harness = make({responses: [
    {status: 401, headers: {}, body: ''},
    {status: 200, headers: {}, body: JSON.stringify({data: {token: 'new-token'}})},
    {status: 200, headers: {}, body: picacgBody()},
  ]});
  const result = await harness.source.scan.comic.load('comic-1', harness.request);
  assert.equal(result.observation.update.updatedAt, '2026-09-10T12:30:45.123Z');
  assert.deepEqual(harness.calls.map((call) => [call.method, new URL(call.url).pathname]), [
    ['GET', '/comics/comic-1'],
    ['POST', '/auth/sign-in'],
    ['GET', '/comics/comic-1'],
  ]);
  assert.equal(harness.source.data.token, 'new-token');
});

test('Picacg second 401 ends the work without another login', async () => {
  const harness = make({responses: [
    {status: 401, headers: {}, body: ''},
    {status: 200, headers: {}, body: JSON.stringify({data: {token: 'new-token'}})},
    {status: 401, headers: {}, body: ''},
  ]});
  const result = await harness.source.scan.comic.load('comic-1', harness.request);
  assert.deepEqual(toPlain(result), {failure: {httpStatus: 401, message: 'Picacg comic request failed'}});
  assert.equal(harness.calls.filter((call) => call.method === 'POST').length, 1);
  assert.equal(harness.calls.filter((call) => call.method === 'GET').length, 2);
});

test('Picacg save_data failures become safe scan failures', async (t) => {
  for (const mode of ['sync', 'async']) {
    await t.test(mode, async () => {
      const harness = make({responses: [
        {status: 401, headers: {}, body: ''},
        {status: 200, headers: {}, body: JSON.stringify({data: {token: 'new-token'}})},
      ]});
      harness.source.saveData = mode === 'sync'
        ? () => {
            harness.source.data.token = 'new-token';
            throw new Error('save_data token=secret-token');
          }
        : async () => {
            harness.source.data.token = 'new-token';
            throw new Error('save_data token=secret-token');
          };
      const result = await harness.source.scan.comic.load('comic-1', harness.request);
      assert(result.failure);
      assert.equal(result.failure.message, 'Picacg scan request failed');
      assert.equal(harness.calls.filter((call) => call.method === 'POST').length, 1);
      assert.equal(harness.calls.filter((call) => call.method === 'GET').length, 1);
      assert.equal(harness.source.data.token, 'old-token');
    });
  }
});

test('Picacg concurrent 401s share one authentication POST', async () => {
  let releaseLogin;
  const loginGate = new Promise((resolve) => { releaseLogin = resolve; });
  let getCount = 0;
  const harness = loadSource('picacg.js', 'Picacg', {
    data: {account: ['user@example.test', 'password'], token: 'old-token'},
    request: async (request) => {
      if (request.method === 'POST') {
        await loginGate;
        return {status: 200, headers: {}, body: JSON.stringify({data: {token: 'shared-token'}})};
      }
      getCount += 1;
      return getCount <= 2
        ? {status: 401, headers: {}, body: ''}
        : {status: 200, headers: {}, body: picacgBody({id: request.url.endsWith('comic-1') ? 'comic-1' : 'comic-2'})};
    },
  });
  const first = harness.source.scan.comic.load('comic-1', harness.request);
  const second = harness.source.scan.comic.load('comic-2', harness.request);
  await new Promise((resolve) => setImmediate(resolve));
  releaseLogin();
  const results = await Promise.all([first, second]);
  assert(results.every((value) => value.observation));
  assert.equal(harness.calls.filter((call) => call.method === 'POST').length, 1);
  assert.equal(harness.calls.filter((call) => call.method === 'GET').length, 4);
});

test('Picacg keeps the shared refresh while async saveData is pending', async () => {
  let getCount = 0;
  let releaseSave;
  let signalSaveStarted;
  const saveStarted = new Promise((resolve) => { signalSaveStarted = resolve; });
  const saveGate = new Promise((resolve) => { releaseSave = resolve; });
  const harness = loadSource('picacg.js', 'Picacg', {
    data: {account: ['user@example.test', 'password'], token: 'old-token'},
    request: async (request) => {
      if (request.method === 'POST') {
        return {status: 200, headers: {}, body: JSON.stringify({data: {token: 'new-token'}})};
      }
      getCount += 1;
      if (getCount <= 2) return {status: 401, headers: {}, body: ''};
      const id = request.url.split('/').pop();
      return {status: 200, headers: {}, body: picacgBody({id})};
    },
  });
  harness.source.saveData = (key, value) => {
    harness.source.data[key] = value;
    signalSaveStarted();
    return saveGate;
  };

  const first = harness.source.scan.comic.load('comic-1', harness.request);
  await saveStarted;
  const second = harness.source.scan.comic.load('comic-2', harness.request);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.calls.filter((call) => call.method === 'POST').length, 1);

  releaseSave();
  const results = await Promise.all([first, second]);
  assert(results.every((value) => value.observation));
  assert.equal(harness.calls.filter((call) => call.method === 'POST').length, 1);
  assert.equal(harness.calls.filter((call) => call.method === 'GET').length, 4);
});

test('Picacg same-token refresh advances generation and deduplicates a late 401', async () => {
  let releaseSave;
  const saveGate = new Promise((resolve) => { releaseSave = resolve; });
  let saveStarted;
  const saveStartedPromise = new Promise((resolve) => { saveStarted = resolve; });
  let releaseLate401;
  const late401Gate = new Promise((resolve) => { releaseLate401 = resolve; });
  let late401Started;
  const late401StartedPromise = new Promise((resolve) => { late401Started = resolve; });
  const seen = new Map();
  const harness = loadSource('picacg.js', 'Picacg', {
    data: {account: ['user@example.test', 'password'], token: 'old-token'},
    request: async (request) => {
      const id = request.url.split('/').pop();
      const count = (seen.get(id) || 0) + 1;
      seen.set(id, count);
      if (request.method === 'POST') {
        return {status: 200, headers: {}, body: JSON.stringify({data: {token: 'old-token'}})};
      }
      if (id === 'comic-b' && count === 1) {
        late401Started();
        await late401Gate;
        return {status: 401, headers: {}, body: ''};
      }
      if (count === 1) return {status: 401, headers: {}, body: ''};
      return {status: 200, headers: {}, body: picacgBody({id})};
    },
  });
  harness.source.saveData = (key, value) => {
    harness.source.data[key] = value;
    saveStarted();
    return saveGate;
  };

  const creator = harness.source.scan.comic.load('comic-a', harness.request);
  await saveStartedPromise;
  const late = harness.source.scan.comic.load('comic-b', harness.request);
  await late401StartedPromise;

  releaseSave();
  const creatorResult = await creator;
  assert(creatorResult.observation);
  assert.equal(harness.source._scanAuthState.generation, 1);
  assert.equal(harness.source._scanAuthState.refresh, null);
  assert.equal(harness.calls.filter((call) => call.method === 'POST').length, 1);

  releaseLate401();
  const lateResult = await late;
  assert(lateResult.observation);
  assert.equal(harness.source._scanAuthState.generation, 1);
  assert.equal(harness.calls.filter((call) => call.method === 'POST').length, 1);
  assert.equal(harness.calls.filter((call) => call.method === 'GET').length, 4);
  assert.equal(seen.get('comic-a'), 2);
  assert.equal(seen.get('comic-b'), 2);
});

test('Picacg source failure projection rejects credential-shaped codes and bodies', () => {
  const harness = make({responses: []});
  for (const unsafe of [
    'token:synthetic-secret',
    'PASSWORD=synthetic-secret',
    'sEcReT:synthetic-secret',
    'body:synthetic-secret',
  ]) {
    const failure = harness.source._scanFailure({
      httpStatus: 429,
      sourceCode: unsafe,
      exceptionType: unsafe,
      message: 'permission denied',
    }).failure;
    assert.equal(failure.httpStatus, 429);
    assert.equal(failure.sourceCode, undefined);
    assert.equal(failure.exceptionType, undefined);
  }
  for (const message of [
    'diagnostic prefix: {"opaque":"json-body-secret"}',
    'diagnostic prefix <svg><title>markup-body-secret</title></svg>',
  ]) {
    const failure = harness.source._scanFailure({httpStatus: 502, message}).failure;
    assert.equal(failure.httpStatus, 502);
    assert.equal(failure.message, undefined);
    assert(!JSON.stringify(failure).includes('secret'));
  }
  const safe = harness.source._scanFailure({
    httpStatus: 403,
    sourceCode: 'ERR_REMOTE',
    exceptionType: 'ScanRequestError',
    message: 'permission denied',
  }).failure;
  assert.equal(safe.sourceCode, 'ERR_REMOTE');
  assert.equal(safe.exceptionType, 'ScanRequestError');
  assert.equal(safe.message, 'permission denied');
});
