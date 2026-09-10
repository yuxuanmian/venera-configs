const assert = require('node:assert/strict');
const test = require('node:test');
const {loadSource, manwaBook, toPlain} = require('./source_harness');

const make = ({pages, data = {}}) => loadSource('manwa.js', 'Manwa', {
  data,
  request: async (request) => {
    const offset = Number(new URL(request.url).searchParams.get('page'));
    const value = pages[offset];
    if (value instanceof Error) throw value;
    if (value && value.status) return value;
    return {status: 200, headers: {}, body: JSON.stringify({err: 0, books: value || []})};
  },
});

const collect = async (harness) => {
  let cursor = null;
  const items = [];
  while (true) {
    const page = await harness.source.scan.collection.load('default', cursor, harness.request);
    if (page.failure) return {failure: page.failure, items};
    items.push(...page.items);
    if (page.next === null) return {items};
    cursor = page.next;
  }
};

test('Manwa uses fixed order and verifies a 15-item collection', async () => {
  const first = Array.from({length: 15}, (_, index) => manwaBook(`book-${index + 1}`));
  const harness = make({pages: {0: first, 15: [],}});
  const result = await collect(harness);
  assert.equal(result.items.length, 15);
  assert.deepEqual(harness.calls.map((call) => Number(new URL(call.url).searchParams.get('page'))), [0, 15, 0]);
  assert(harness.calls.every((call) => call.url.includes('order=0&order_type=0')));
  assert.equal(result.items[0].observation.update.latestChapterId, 'chapter-book-1');
});

test('Manwa short pages transition to verify and do not read a total', async () => {
  const books = Array.from({length: 16}, (_, index) => manwaBook(`book-${index + 1}`));
  const harness = make({pages: {0: books.slice(0, 15), 15: books.slice(15)}});
  const result = await collect(harness);
  assert.equal(result.items.length, 16);
  assert.equal(harness.calls.length, 3);
  assert.equal(harness.calls[1].url.includes('bookshelf'), false);
});

test('Manwa empty collection still verifies an empty head', async () => {
  const harness = make({pages: {0: []}});
  const result = await collect(harness);
  assert.deepEqual(result.items, []);
  assert.deepEqual(harness.calls.map((call) => Number(new URL(call.url).searchParams.get('page'))), [0, 0]);
});

test('Manwa verify accepts stable IDs without requiring observation fields', async () => {
  const initial = [manwaBook('book-a'), manwaBook('book-b')];
  let requestCount = 0;
  const harness = loadSource('manwa.js', 'Manwa', {
    request: async () => {
      const books = requestCount++ === 0
        ? initial
        : [{id: 'book-a'}, {id: 'book-b'}];
      return {status: 200, headers: {}, body: JSON.stringify({err: 0, books})};
    },
  });

  const first = await harness.source.scan.collection.load('default', null, harness.request);
  assert.equal(first.items.length, 2);
  const verified = await harness.source.scan.collection.load('default', first.next, harness.request);

  assert.deepEqual(toPlain(verified), {items: [], next: null});
  assert.equal(harness.calls.length, 2);
});

test('Manwa maps only last chapter and strict unread facts', async () => {
  const books = [
    manwaBook('a', {chapterId: 'last-a', isNew: false, fullIsNew: false}),
    manwaBook('b', {chapterId: 'last-b', isNew: true, fullIsNew: null}),
    manwaBook('c', {chapterId: null, isNew: false, fullIsNew: false}),
  ];
  const harness = make({pages: {0: books}});
  const first = await harness.source.scan.collection.load('default', null, harness.request);
  assert.deepEqual(toPlain(first.items.map((item) => item.observation)), [
    {update: {latestChapterId: 'last-a'}, sourceUnread: false},
    {update: {latestChapterId: 'last-b'}, sourceUnread: true},
    {sourceUnread: false},
  ]);
  assert.equal(first.items[0].observation.update.fullLatestChapterId, undefined);
});

test('Manwa validates cursor before HTTP and rejects aliases/extras', async (t) => {
  const harness = make({pages: {0: []}});
  const invalid = [
    {phase: 'verify'},
    {phase: 'verify', headIds: [], offset: 0},
    {phase: 'done', headIds: []},
    {phase: 'page', offset: 0, headIds: Array.from({length: 15}, (_, i) => `b-${i}`)},
    {phase: 'verify', head: []},
  ];
  for (const cursor of invalid) {
    await t.test(JSON.stringify(cursor), async () => {
      const result = await harness.source.scan.collection.load('default', cursor, harness.request);
      assert(result.failure);
      assert.equal(harness.calls.length, 0);
    });
  }
});

test('Manwa changed head fails without emitting verify items', async () => {
  const initial = Array.from({length: 2}, (_, index) => manwaBook(`book-${index + 1}`));
  const changed = [manwaBook('book-other'), manwaBook('book-2')];
  let verify = false;
  const harness = loadSource('manwa.js', 'Manwa', {
    request: async (request) => {
      const offset = Number(new URL(request.url).searchParams.get('page'));
      if (offset !== 0) return {status: 200, headers: {}, body: JSON.stringify({err: 0, books: []})};
      verify = verify || harness?.calls?.length >= 2;
      return {status: 200, headers: {}, body: JSON.stringify({err: 0, books: verify ? changed : initial})};
    },
  });
  const first = await harness.source.scan.collection.load('default', null, harness.request);
  assert.equal(first.items.length, 2);
  const result = await harness.source.scan.collection.load('default', first.next, harness.request);
  assert(result.failure);
  assert.equal(result.items, undefined);
});

test('Manwa source failure projection rejects credential-shaped codes and bodies', () => {
  const harness = make({pages: {}});
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
    'diagnostic prefix <table><tr><td>table-body-secret</td></tr></table>',
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
