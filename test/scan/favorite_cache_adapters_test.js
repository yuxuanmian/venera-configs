const assert = require('node:assert/strict');
const test = require('node:test');
const {loadSource, toPlain} = require('./source_harness');

class Comic { constructor(fields) { Object.assign(this, fields); } }

test('numbered favorites preserve the configured sort and report totals only when available', async () => {
  let listing = {docs: [{_id: 'first', title: 'Fixture', thumb: {fileServer: 'https://images.example.invalid', path: 'a.jpg'}}], page: '1', pages: '2', total: '15'};
  const {source} = loadSource('picacg.js', 'Picacg', {
    data: {settings: {base_url: 'https://pica.example.invalid', favoriteSort: 'da'}},
    globals: {Comic, Network: {get: async (url) => {
      assert.equal(url, 'https://pica.example.invalid/users/favourite?page=1&s=da');
      return {status: 200, body: JSON.stringify({data: {comics: listing}})};
    }}},
  });
  let page = await source.favorites.loadCachePage(1, '', null);
  assert.equal(page.comics[0].id, 'first');
  assert.equal(page.maxPage, 2);
  assert.equal(page.total, 15);
  delete listing.total;
  page = await source.favorites.loadCachePage(1, '', 123);
  assert.equal(page.total, null);
  assert.equal((await source.favorites.loadComics(1, '')).comics.length, 1);
  listing = {docs: [], page: 1, pages: 1, total: 0};
  assert.deepEqual(toPlain(await source.favorites.loadCachePage(1, '', null)), {comics: [], maxPage: 0, total: 0});
  listing = {docs: [], page: 2, pages: 2};
  await assert.rejects(source.favorites.loadCachePage(1, '', null), /Invalid favorite pagination/);
});

test('cursor favorites keep the selected folder, validate the full page and preserve the legacy loader', async () => {
  const requests = [];
  let fixture;
  const home = 'https://e-hentai.org/favorites.php';
  const gallery = 'https://e-hentai.org/g/123/0123456789/';
  let disposed = 0;

  class HtmlDocument {
    querySelector(selector) {
      return selector === 'a#dnext' && fixture.next != null ? {attributes: {href: fixture.next}} : null;
    }
    querySelectorAll(selector) {
      if (selector === 'div.fp') return fixture.counts.map((value, index) => ({text: `Category ${index}`, children: [{text: value}]}));
      if (selector === 'div.gl1t' || selector.includes('div.gl1t')) {
        const row = {querySelector(name) {
          if (name === 'a' || name === 'a[href*="/g/"]') return {text: 'Fixture', attributes: {href: gallery}};
          return null;
        }, querySelectorAll: () => []};
        if (selector !== 'div.gl1t' && fixture.missingRow) return [row, row];
        return fixture.empty ? [] : [row];
      }
      return [];
    }
    dispose() { disposed++; }
  }

  const {source} = loadSource('ehentai.js', 'Ehentai', {
    data: {settings: {domain: 'e-hentai.org'}},
    globals: {Comic, HtmlDocument, Network: {get: async (url) => {
      requests.push(url);
      return {status: 200, body: '<fixture>'};
    }}},
  });
  source.checkEHEvent = () => {};
  fixture = {counts: ['0','12','0','0','0','0','0','0','0','0'], next: '?next=123'};
  const first = await source.favorites.loadCacheNext(null, '1');
  assert.equal(first.total, 12);
  assert.equal(first.comics[0].id, gallery);
  assert.equal(first.next, `${home}?next=123&favcat=1`);
  assert.deepEqual(requests, [`${home}?favcat=1`]);
  fixture.next = undefined;
  assert.equal((await source.favorites.loadCacheNext(first.next, '1')).next, null);
  assert.equal((await source.favorites.loadNext(null, '1')).comics.length, 1);
  fixture.counts[1] = '';
  assert.equal((await source.favorites.loadCacheNext(null, '-1')).total, null);
  fixture.missingRow = true;
  await assert.rejects(async () => source.favorites.loadCacheNext(null, '1'), /Incomplete favorite gallery list/);
  await assert.rejects(async () => source.favorites.loadCacheNext(`${home}?favcat=2&next=123`, '1'), /changed folders/);
  await assert.rejects(async () => source.favorites.loadCacheNext('https://else.example.invalid/favorites.php?next=1', '1'), /Invalid favorite cursor/);
  assert.equal(disposed, requests.length);
});
