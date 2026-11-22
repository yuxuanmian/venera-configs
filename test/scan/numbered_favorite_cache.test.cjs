const assert = require('node:assert/strict');
const test = require('node:test');
const {loadSource, toPlain} = require('./source_harness');

class Comic { constructor(fields) { Object.assign(this, fields); } }

test('JM favorites cache the requested folder and sort with an exact total', async () => {
  const {source} = loadSource('jm.js', 'JM', {
    data: {settings: {apiDomain: '1', favoriteOrder: 'mp'}},
    globals: {Comic},
  });
  source.overwriteApiDomains(['jm.example.invalid']);
  let listing = {total: '21', list: [{id: 21, name: 'Fixture', category: {}, category_sub: {}}]};
  const requests = [];
  source.get = async (url) => {
    requests.push(new URL(url).search);
    return JSON.stringify(listing);
  };

  assert.equal(source.favorites.cacheAllFolder, '0');
  assert.deepEqual(toPlain(source.favorites.cacheSettings), ['favoriteOrder']);
  const last = await source.favorites.loadCachePage(2, '7', 21);
  assert.deepEqual(requests, ['?folder_id=7&page=2&o=mp']);
  assert.equal(last.comics[0].id, '21');
  assert.equal(last.maxPage, 2);
  assert.equal(last.total, 21);
  assert.equal((await source.favorites.loadComics(2, '7')).comics[0].id, '21');
  await assert.rejects(source.favorites.loadCachePage(2, '7', 22), /Invalid favorite cache page/);
  listing.list = [];
  await assert.rejects(source.favorites.loadCachePage(2, '7', 21), /Invalid favorite cache page/);

  listing = {total: 0, list: []};
  assert.deepEqual(toPlain(await source.favorites.loadCachePage(1, '0', null)), {
    comics: [], total: 0, maxPage: 0,
  });
  assert.equal(requests.at(-1), '?folder_id=0&page=1&o=mp');
  listing = {list: []};
  await assert.rejects(source.favorites.loadCachePage(1, '0', null), /Invalid favorite pagination/);
});

test('nhentai favorites use authenticated pages and reject missing pagination or gallery IDs', async () => {
  const {source} = loadSource('nhentai.js', 'Nhentai', {globals: {Comic}});
  let status = 200;
  let listing = {num_pages: '2', result: [{id: 21, english_title: 'Fixture'}]};
  const requests = [];
  source.sendAuthRequest = async (method, url) => {
    const target = new URL(url);
    requests.push([method, target.pathname + target.search]);
    return {status, body: JSON.stringify(listing)};
  };

  assert.deepEqual(toPlain(source.favorites.cacheSettings), ['apiKey']);
  assert.equal(source.favorites.cacheAccountSetting, 'apiKey');
  const page = await source.favorites.loadCachePage(2, '', null);
  assert.deepEqual(requests, [['GET', '/api/v2/favorites?page=2']]);
  assert.equal(page.comics[0].id, '21');
  assert.equal(page.maxPage, 2);
  assert.equal(page.total, null);
  assert.equal((await source.favorites.loadComics(2)).comics[0].id, '21');

  listing.total = 21;
  assert.equal((await source.favorites.loadCachePage(2, '', 21)).total, 21);
  await assert.rejects(source.favorites.loadCachePage(2, '', 22), /Invalid favorite pagination/);
  listing = {num_pages: 1, total: '0', result: []};
  assert.deepEqual(toPlain(await source.favorites.loadCachePage(1, '', null)), {
    comics: [], maxPage: 0, total: 0,
  });
  assert.equal((await source.favorites.loadComics(1)).maxPage, 1);
  for (const invalid of [{result: []}, {num_pages: 0}, {num_pages: 1, result: [{id: [21]}]}]) {
    listing = invalid;
    await assert.rejects(source.favorites.loadCachePage(1, '', null), /Invalid favorite pagination/);
  }
  status = 429;
  await assert.rejects(source.favorites.loadCachePage(1, '', null), /Rate limited/);
});
