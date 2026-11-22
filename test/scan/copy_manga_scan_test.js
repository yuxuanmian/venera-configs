const assert = require('node:assert/strict');
const test = require('node:test');
const {loadSource, toPlain} = require('./source_harness');

const origin = 'https://www.mangacopy.com';
const favorite = (id, chapterId = `chapter-${id}`) => ({
  last_browse: {last_browse_id: `read-${id}`},
  comic: {path_word: `work-${id}`, last_chapter_id: chapterId, datetime_updated: '2026-11-17'},
});
const favoritesPage = (list, total, offset = 0) => ({
  status: 200,
  body: JSON.stringify({code: 200, results: {list, total, offset, limit: 12}}),
});
// flutter_qjs converts Dart null map values to JavaScript undefined.
const bridgedCursor = cursor => Object.fromEntries(
  Object.entries(toPlain(cursor)).map(([key, value]) => [key, value === null ? undefined : value]),
);

function harness(request) {
  const {source, calls, request: hostRequest} = loadSource('copy_manga.js', 'CopyManga', {
    data: {web_session: {origin, token: 'fixture-token'}, settings: {favorites_ordering: '-datetime_browse'}},
    request,
    globals: {SCAN_COLLECTION_ITEM_FAILURES_V1: true},
  });
  return {source, calls, load: cursor => source.scan.collection.load('default', cursor, hostRequest)};
}

test('Copy Manga keeps its regular favorites on hosts without per-item scan failures', () => {
  const {source} = loadSource('copy_manga.js', 'CopyManga');
  assert.equal(source.scan, null);
  assert.equal(typeof source.favorites.loadComics, 'function');
  assert.equal(typeof source.favorites.loadCachePage, 'function');
});

test('Copy Manga scans by favorite time and verifies the first page after pagination', async () => {
  const shelf = Array.from({length: 13}, (_, index) => favorite(index));
  const {source, calls, load} = harness(({url}) => {
    const offset = Number(new URL(url).searchParams.get('offset'));
    return favoritesPage(shelf.slice(offset, offset + 12), shelf.length, offset);
  });
  assert.equal(source.scan.primary, 'collection');
  assert.equal(source.scan.collection.itemFailures, true);
  assert.deepEqual(toPlain(source.scan.collection.fieldSource), {latestChapterId: 'comic.last_chapter_id'});

  const first = await load(null);
  assert.equal(first.items.length, 12);
  assert.deepEqual(toPlain(first.items[0]), {
    comicId: 'work-0', observation: {update: {latestChapterId: 'chapter-0'}},
  });
  assert.equal(first.next.offset, 12);
  const last = await load(bridgedCursor(first.next));
  assert.deepEqual(toPlain(last.items), [
    {comicId: 'work-12', observation: {update: {latestChapterId: 'chapter-12'}}},
  ]);
  assert.deepEqual(toPlain(await load(bridgedCursor(last.next))), {items: [], next: null});
  assert.equal(last.next.offset, 0);

  assert.deepEqual(calls.map(call => new URL(call.url).searchParams.get('offset')), ['0', '12', '0']);
  for (const call of calls) {
    const url = new URL(call.url);
    assert.equal(call.method, 'GET');
    assert.equal(url.origin, origin);
    assert.equal(url.pathname, '/api/v3/member/collect/comics');
    assert.equal(url.searchParams.get('limit'), '12');
    assert.equal(url.searchParams.get('free_type'), '1');
    assert.equal(url.searchParams.get('ordering'), '-datetime_modifier');
    assert.equal(call.headers.Authorization, 'Token fixture-token');
    assert.equal(call.headers.Referer, origin + '/web/person/shujia');
  }
  assert.equal(source.favoriteEvidence, null);
});

test('Copy Manga reports a missing chapter ID on the affected work only', async () => {
  const list = [favorite(0, null), favorite(1), favorite(2, '  '), favorite(3, 'bad\0id')];
  const {load} = harness(() => favoritesPage(list, list.length));
  const first = await load(null);
  assert.equal(first.items.length, list.length);
  for (const index of [0, 2, 3]) {
    const item = first.items[index];
    assert.equal(item.comicId, `work-${index}`);
    assert.match(item.failure.message, /chapter ID/);
    assert.equal(item.observation, undefined);
  }
  assert.deepEqual(toPlain(first.items[1].observation), {update: {latestChapterId: 'chapter-1'}});
  assert.deepEqual(toPlain(await load(toPlain(first.next))), {items: [], next: null});
});

test('Copy Manga rejects a truncated page or a changing bookshelf total', async () => {
  const firstPage = Array.from({length: 12}, (_, index) => favorite(index));
  const {load} = harness(({url}) => {
    const offset = Number(new URL(url).searchParams.get('offset'));
    return offset === 0 ? favoritesPage(firstPage, 13) : favoritesPage([favorite(12), favorite(13)], 14, 12);
  });
  assert.match((await load((await load(null)).next)).failure.message, /inconsistent pagination/);

  const truncated = harness(() => favoritesPage([favorite(0)], 2));
  assert.match((await truncated.load(null)).failure.message, /inconsistent pagination/);
});

test('Copy Manga rechecks first-page identities and handles an empty shelf', async () => {
  let list = [favorite(0), favorite(1)];
  const {load, calls} = harness(() => favoritesPage(list, list.length));
  const cursor = (await load(null)).next;
  assert.deepEqual(toPlain(await load(bridgedCursor(cursor))), {items: [], next: null});
  assert.equal(calls.length, 2);
  list.reverse();
  assert.match((await load(bridgedCursor(cursor))).failure.message, /first page changed/);

  list = [];
  const first = await load(null);
  assert.deepEqual(toPlain(first.items), []);
  assert.deepEqual(toPlain(await load(bridgedCursor(first.next))), {items: [], next: null});
});

test('Copy Manga stops on an expired or replaced session without emitting items', async () => {
  const expired = harness(() => ({status: 200, body: JSON.stringify({code: 401})}));
  assert.deepEqual(toPlain(await expired.load(null)), {failure: {message: 'Login expired', sourceCode: '401'}});
  const unauthorized = harness(() => ({status: 401, body: ''}));
  assert.deepEqual(toPlain(await unauthorized.load(null)), {failure: {message: 'Login expired', httpStatus: 401}});

  const active = harness(() => {
    active.source.saveSession(origin, 'replacement-fixture-token');
    return favoritesPage([favorite(0)], 1);
  });
  assert.match((await active.load(null)).failure.message, /session changed/);
});
