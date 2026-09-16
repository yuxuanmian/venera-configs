// Contract P exact Tag search evidence for `venera-configs/picacg.js`.
//
// Every case runs against the VM harness in `./source_harness.js`; no real
// network I/O happens and no credential (login body/header/response) is ever
// retained or printed.

const assert = require('node:assert/strict');
const test = require('node:test');
const {
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
} = require('./source_harness');

const BASE_URL = 'https://pica.example.invalid';
const VALUE = 'Fate';
const DEFAULT_OPTIONS = ['dd-New to old'];
const fixture = loadFixture('picacg_search_responses.json');

const data = () => ({
  account: ['user@example.test', 'synthetic-password'],
  token: 'old-token',
  settings: {base_url: BASE_URL},
});

const make = (responder) => loadSource('picacg.js', 'Picacg', {data: data(), responder});

// Serves the deterministic mixed candidate fixture page by page.
const fixtureResponder = (call) => {
  if (call.kind === 'login') return authResponse();
  const entry = fixture.pages[String(call.page)];
  if (!entry) return failureResponse(404);
  return ok(searchPageBody(entry.docs, entry.pages));
};

const loadNext = (harness, {value = VALUE, options = DEFAULT_OPTIONS, next = null} = {}) =>
  harness.source.search.tagSearch.loadNext(value, options, next);

const cursor = (nextPage, maxPage) => JSON.stringify({v: 1, nextPage, maxPage});

test('Picacg tagSearch keeps only raw tags exact matches', async () => {
  const harness = make(fixtureResponder);
  const result = await loadNext(harness);
  // `toPlain` moves the VM-realm comics into this realm for comparison.
  const comics = toPlain(result.comics);

  assert.deepEqual(comics.map((comic) => comic.id), [
    'raw-exact-1',
    'raw-exact-2',
    'raw-exact-3',
    'raw-exact-4',
  ]);
  assert.equal(result.next, null);

  // The duplicated raw `_id` keeps its first occurrence.
  const duplicate = comics.find((comic) => comic.id === 'raw-exact-2');
  assert.equal(duplicate.title, 'Kept first occurrence');

  // `parseComic` merges raw tags with categories for presentation, so the
  // merged tags below prove the exact predicate ran on the raw document
  // before parsing.
  assert.deepEqual(comics[0].tags, ['Fate', 'Doujin']);

  for (const id of [
    'title-only-1',
    'categories-only-1',
    'case-differing-1',
    'padded-1',
    'padded-2',
    'non-array-1',
    'missing-tags-1',
  ]) {
    assert.equal(comics.some((comic) => comic.id === id), false, `${id} must not match`);
  }

  // The mixed fixture only has two pages, so page 1 was requested alone to
  // learn `maxPage` and page 2 completed the scan: two requests in total, and
  // never more than one of them in flight at a time.
  assert.deepEqual(harness.candidateCalls().map((call) => call.page), [1, 2]);
  assert.equal(harness.calls[0].inflightAtStart, 1);
  assert.equal(harness.peakInFlight, 1);
});

test('Picacg tagSearch learns maxPage from page 1 alone then batches at most 3', async () => {
  const pages = [];
  const harness = make((call) => {
    if (call.kind === 'login') return authResponse();
    pages.push(call.page);
    return ok(searchPageBody([], 20));
  });

  const promise = loadNext(harness);
  // The first page is the only request in flight while maxPage is unknown.
  assert.equal(harness.calls.length, 1);
  assert.equal(harness.inFlight, 1);
  assert.equal(harness.calls[0].page, 1);

  const result = await promise;
  assert.deepEqual(pages, [1, 2, 3, 4, 5, 6]);
  assert.equal(harness.candidateCalls().length, 6);
  assert.equal(harness.peakInFlight, 3);
  // Page 1 learned maxPage = 20, so the scan stops on budget, not on matches.
  assert.deepEqual(toPlain(result.comics), []);
  assert.deepEqual(JSON.parse(result.next), {v: 1, nextPage: 7, maxPage: 20});
  for (const call of harness.candidateCalls()) {
    assert.equal(call.json.keyword, VALUE);
    assert.equal(call.json.sort, DEFAULT_OPTIONS[0]);
  }
});

test('Picacg tagSearch cursor advances and terminates exactly at maxPage', async () => {
  const seen = [];
  const harness = make((call) => {
    if (call.kind === 'login') return authResponse();
    seen.push(call.page);
    return ok(searchPageBody([], 20));
  });

  const advanced = await loadNext(harness, {next: cursor(7, 20)});
  assert.deepEqual(seen, [7, 8, 9, 10, 11, 12]);
  assert.equal(harness.peakInFlight, 3);
  assert.deepEqual(JSON.parse(advanced.next), {v: 1, nextPage: 13, maxPage: 20});

  seen.length = 0;
  harness.reset();
  const terminal = await loadNext(harness, {next: cursor(19, 20)});
  assert.deepEqual(seen, [19, 20]);
  assert(seen.every((page) => page <= 20));
  assert.equal(terminal.next, null);
});

test('Picacg tagSearch zero-match invocation still returns an advanced cursor', async () => {
  const harness = make((call) => call.kind === 'login'
    ? authResponse()
    : ok(searchPageBody([rawComic('unrelated-1', {tags: ['Other']})], 9)));

  const result = await loadNext(harness, {value: 'Absent'});
  assert.deepEqual(toPlain(result.comics), []);
  assert.deepEqual(JSON.parse(result.next), {v: 1, nextPage: 7, maxPage: 9});
  assert.equal(harness.candidateCalls().length, 6);
});

test('Picacg tagSearch forwards the value and options snapshot of each invocation', async () => {
  const seen = [];
  const harness = make((call) => {
    if (call.kind === 'login') return authResponse();
    seen.push({page: call.page, keyword: call.json.keyword, sort: call.json.sort});
    return ok(searchPageBody([], 3));
  });

  // A whitespace-padded value must reach the endpoint verbatim.
  const first = await loadNext(harness, {value: ' Fate ', options: ['dd-New to old']});
  assert.deepEqual(seen.map((entry) => entry.page), [1, 2, 3]);
  assert(seen.every((entry) => entry.keyword === ' Fate '));
  assert(seen.every((entry) => entry.sort === 'dd-New to old'));
  assert.equal(first.next, null);

  // A new invocation restarts from the initial cursor and only uses the new
  // options snapshot.
  seen.length = 0;
  harness.reset();
  const second = await loadNext(harness, {value: ' Fate ', options: ['ld-Most likes']});
  assert.deepEqual(seen.map((entry) => entry.page), [1, 2, 3]);
  assert(seen.every((entry) => entry.keyword === ' Fate '));
  assert(seen.every((entry) => entry.sort === 'ld-Most likes'));
  assert.equal(second.next, null);
});

test('Picacg tagSearch rejects malformed cursors without any request', async () => {
  const harness = make(fixtureResponder);
  const malformed = [
    'not-json',
    '{"v":2,"nextPage":2,"maxPage":2}',
    '{"nextPage":2,"maxPage":2}',
    '{"v":"1","nextPage":2,"maxPage":2}',
    '{"v":1,"maxPage":2}',
    '{"v":1,"nextPage":"2","maxPage":2}',
    '{"v":1,"nextPage":0,"maxPage":2}',
    '{"v":1,"nextPage":2,"maxPage":"2"}',
    '{"v":1,"nextPage":2}',
    '[]',
    '1',
    'null',
    '',
  ];

  for (const next of malformed) {
    await assert.rejects(
      loadNext(harness, {next}),
      /Invalid tag search cursor/,
      `cursor ${next} must fail explicitly`,
    );
    // Never silently reset to page 1: nothing was requested at all.
    assert.equal(harness.calls.length, 0, `cursor ${next} must not issue a request`);
  }
});

test('Picacg tagSearch merges ascending page order despite scrambled completion', async () => {
  const gates = {7: deferred(), 8: deferred(), 9: deferred()};
  const harness = make(async (call) => {
    if (call.kind === 'login') return authResponse();
    await gates[call.page].promise;
    return ok(searchPageBody([rawComic(`page-${call.page}`, {tags: [VALUE]})], 9));
  });

  const promise = loadNext(harness, {next: cursor(7, 9)});
  assert.deepEqual(harness.calls.map((call) => call.page), [7, 8, 9]);

  gates[9].resolve();
  await flush();
  gates[7].resolve();
  await flush();
  gates[8].resolve();

  const result = await promise;
  const finished = (page) => harness.calls.find((call) => call.page === page).finishedAt;
  // Completion order was 9, 7, 8 ...
  assert(finished(9) < finished(7));
  assert(finished(7) < finished(8));
  // ... and the merge is still page 7, 8, 9.
  assert.deepEqual(toPlain(result.comics).map((comic) => comic.id), ['page-7', 'page-8', 'page-9']);
  assert.equal(result.next, null);
});

test('Picacg tagSearch fails the whole invocation when one page fails, and a retry reruns the group', async () => {
  let failPage8 = true;
  const harness = make((call) => {
    if (call.kind === 'login') return authResponse();
    if (call.page === 8 && failPage8) {
      failPage8 = false;
      return failureResponse(503);
    }
    return ok(searchPageBody([rawComic(`page-${call.page}`, {tags: [VALUE]})], 9));
  });

  const retryCursor = cursor(7, 9);
  let output;
  await assert.rejects(
    (async () => {
      output = await loadNext(harness, {next: retryCursor});
    })(),
    /Invalid status code: 503/,
  );
  // No partial comics and no output cursor.
  assert.equal(output, undefined);
  const failedGroup = harness.candidateCalls().map((call) => call.page);
  assert.deepEqual(failedGroup, [7, 8, 9]);

  await flush();
  assert.equal(harness.inFlight, 0);
  harness.reset();
  const retried = await loadNext(harness, {next: retryCursor});
  // Retry re-requests exactly the same page group.
  assert.deepEqual(harness.candidateCalls().map((call) => call.page), failedGroup);
  assert.deepEqual(
    toPlain(retried.comics).map((comic) => comic.id),
    ['page-7', 'page-8', 'page-9'],
  );
  assert.equal(retried.next, null);
});

test('Picacg tagSearch bounds every invocation to 6 pages and 3 concurrent requests', async () => {
  const harness = make((call) => call.kind === 'login'
    ? authResponse()
    : ok(searchPageBody([], 40)));

  const first = await loadNext(harness);
  assert.equal(harness.candidateCalls().length, 6);
  assert.equal(harness.peakInFlight, 3);
  assert.deepEqual(JSON.parse(first.next), {v: 1, nextPage: 7, maxPage: 40});

  harness.reset();
  const second = await loadNext(harness, {next: first.next});
  assert.equal(harness.candidateCalls().length, 6);
  assert.equal(harness.peakInFlight, 3);
  assert.deepEqual(JSON.parse(second.next), {v: 1, nextPage: 13, maxPage: 40});
  // The cursor always advances relative to its input.
  assert.notEqual(second.next, first.next);
});

test('Picacg three concurrent 401s share one search login POST', async () => {
  // The login response is held open until all three candidate 401s have been
  // observed, so the three recoveries really are concurrent.
  const loginGate = deferred();
  const attempts = new Map();
  const harness = make(async (call) => {
    if (call.kind === 'login') {
      await loginGate.promise;
      return authResponse('synthetic-rotated-token');
    }
    const count = (attempts.get(call.page) || 0) + 1;
    attempts.set(call.page, count);
    if (count === 1) return failureResponse(401);
    return ok(searchPageBody([rawComic(`page-${call.page}`, {tags: [VALUE]})], 3));
  });

  const promise = loadNext(harness, {next: cursor(1, 3)});
  await flush();
  assert.equal(attempts.size, 3);
  // This is what the suite asserts today. The "3 logins before the fix" figure
  // is a one-off development measurement on this same fixture (recorded in
  // picacg.js); it is NOT re-derived here, because the shared promise already
  // exists. Do not read this test as a before/after experiment.
  assert.equal(harness.loginPostCount, 1);
  // Login bodies (credentials) are never retained by the harness.
  assert(harness.loginCalls().every((call) => call.body === undefined && call.json === undefined));

  loginGate.resolve();
  const result = await promise;
  assert.deepEqual(toPlain(result.comics).map((comic) => comic.id), ['page-1', 'page-2', 'page-3']);
  assert.equal(result.next, null);
  assert.equal(harness.loginPostCount, 1);
  // 3 rejected candidates + 3 retries.
  assert.equal(harness.candidateCalls().length, 6);
});

test('Picacg search relogin promise is cleared once it settles', async () => {
  let logins = 0;
  let attempts = 0;
  const harness = make((call) => {
    if (call.kind === 'login') {
      logins += 1;
      return authResponse(`synthetic-token-${logins}`);
    }
    attempts += 1;
    // First attempt of every invocation is rejected, the retry succeeds.
    if (attempts % 2 === 1) return failureResponse(401);
    return ok(searchPageBody([rawComic(`page-${call.page}`, {tags: [VALUE]})], 1));
  });

  const first = await loadNext(harness, {next: cursor(1, 1)});
  assert.equal(first.next, null);
  assert.equal(harness.loginPostCount, 1);
  assert.equal(harness.source._searchReloginPending, null);

  harness.reset();
  const second = await loadNext(harness, {next: cursor(1, 1)});
  // A later 401 starts a fresh recovery instead of reusing a settled promise.
  assert.equal(harness.loginPostCount, 1);
  assert.equal(logins, 2);
  assert.equal(toPlain(second.comics).length, 1);
});

test('Picacg ordinary search.load keeps its 1.0.8 parsing, order and maxPage', async () => {
  const page = fixture.pages['1'];
  const harness = make(() => ok(searchPageBody(page.docs, 4)));

  const result = await harness.source.search.load('Fate', DEFAULT_OPTIONS, 2);
  assert.deepEqual(
    harness.calls.map((call) => [call.method, call.page, call.json.keyword, call.json.sort]),
    [['POST', 2, 'Fate', 'dd-New to old']],
  );
  assert.equal(result.maxPage, 4);
  const comics = toPlain(result.comics);
  assert.deepEqual(comics.map((comic) => comic.id), page.docs.map((doc) => doc._id));

  // Ordinary search performs no exact filtering: the categories-only document
  // is returned and parseComic merges its categories into the display tags,
  // which is exactly why the tag predicate must run before parseComic.
  assert.equal(comics.length, page.docs.length);
  const categoryOnly = comics.find((comic) => comic.id === 'categories-only-1');
  assert.deepEqual(categoryOnly.tags, ['Fate']);
});

test('Picacg a second 401 after a successful relogin rejects the whole invocation', async () => {
  let candidateAttempts = 0;
  const harness = make((call) => {
    if (call.kind === 'login') return authResponse('synthetic-rotated-token');
    candidateAttempts += 1;
    // Recovery succeeds, but the retried request is still unauthorized.
    return failureResponse(401);
  });

  // The whole invocation must fail: no partial comics and no output cursor.
  await assert.rejects(() => loadNext(harness, {next: cursor(1, 1)}));

  assert.equal(harness.loginPostCount, 1, 'exactly one recovery attempt');
  assert.equal(candidateAttempts, 2, 'the original 401 plus exactly one retry');
  assert.equal(
    harness.source._searchReloginPending,
    null,
    'a failed recovery must not leave a stale shared promise behind',
  );
});

test('Picacg tagSearch rejects an undefined cursor instead of restarting at page 1', async () => {
  // The Host always emits the literal `null` for the first call, so `undefined`
  // is a non-Host caller mistake. Contract P requires a malformed cursor to
  // fail explicitly and never silently reset to page 1.
  const harness = make(() => ok(searchPageBody([], 3)));
  await assert.rejects(
    () => harness.source.search.tagSearch.loadNext(VALUE, DEFAULT_OPTIONS, undefined),
    /Invalid tag search cursor/,
  );
  assert.equal(harness.candidateCalls().length, 0, 'no request may be issued');
});

test('Picacg tagSearch rejects missing or non-integer pagination metadata', async () => {
  for (const pages of [undefined, null, 0, -1, 2.5, '3']) {
    const harness = make(() => ok(searchPageBody([rawComic('x', {tags: [VALUE]})], pages)));
    await assert.rejects(
      () => loadNext(harness),
      /Invalid tag search pagination metadata/,
      `pages=${String(pages)} must not silently terminate the scan`,
    );
  }
});

test('Picacg tagSearch rejects an unparseable successful body', async () => {
  const harness = make(() => ({status: 200, headers: {}, body: 'not json'}));
  await assert.rejects(() => loadNext(harness));
  assert.equal(harness.loginPostCount, 0, 'an invalid body is not an auth problem');
});