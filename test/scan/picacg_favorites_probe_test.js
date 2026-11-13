const assert = require('node:assert/strict');
const {createHmac, randomUUID} = require('node:crypto');
const test = require('node:test');
const {loadSource} = require('./source_harness');

const legacyOrigin = 'https://picaapi.picacomic.com';

async function inspectFavorites(get, token) {
  const seenIds = new Set();
  const pages = [];
  const {source} = loadSource('picacg.js', 'Picacg', {
    data: {token, settings: {base_url: legacyOrigin, favoriteSort: 'dd'}},
    globals: {
      Comic: class {},
      Convert: {
        encodeUtf8: (value) => Buffer.from(value, 'utf8'),
        hmacString: (key, data, algorithm) => createHmac(algorithm, key).update(data).digest('hex'),
      },
      createUuid: randomUUID,
      Network: {
        get: async (url, headers) => {
          const parsed = new URL(url);
          const page = pages.length + 1;
          assert(parsed.origin === legacyOrigin && parsed.pathname === '/users/favourite',
            'only the legacy favorites endpoint may receive the token');
          assert.equal(parsed.searchParams.get('page'), String(page));
          assert.equal(parsed.searchParams.get('s'), 'dd');

          const response = await get(url, headers);
          assert.equal(response.status, 200, `favorites page ${page} must return HTTP 200`);
          let comics;
          try {
            comics = JSON.parse(response.body)?.data?.comics;
          } catch {
            assert.fail(`favorites page ${page} is not JSON`);
          }
          assert(Array.isArray(comics?.docs), `favorites page ${page} has no docs array`);
          assert(Number.isSafeInteger(comics.pages) && comics.pages >= 2 && comics.docs.length > 0,
            'use an account whose favorites span at least two nonempty pages');
          if (Object.hasOwn(comics, 'page')) {
            assert(Number(comics.page) === page, `favorites response did not advance to page ${page}`);
          }
          if (Object.hasOwn(comics, 'limit')) {
            assert(Number.isSafeInteger(comics.limit) && comics.limit >= comics.docs.length,
              `favorites page ${page} reports an inconsistent limit`);
          }
          let invalidCounts = 0;
          for (const comic of comics.docs) {
            const id = comic?._id;
            assert(typeof id === 'string' && id.trim() !== '', `favorites page ${page} has a missing ID`);
            assert(!seenIds.has(id), `favorites page ${page} contains a duplicate ID`);
            seenIds.add(id);
            if (!Number.isSafeInteger(comic.epsCount) || comic.epsCount < 0) invalidCounts++;
          }
          assert.equal(invalidCounts, 0, `favorites page ${page} has ${invalidCounts}/${comics.docs.length} invalid or missing epsCount values`);
          pages.push({page, items: comics.docs.length, totalPages: comics.pages});
          return response;
        },
      },
    },
  });
  for (const page of [1, 2]) {
    const result = await source.favorites.loadComics(page);
    assert.equal(result.comics.length, pages[page - 1].items);
    assert.equal(result.maxPage, pages[0].totalPages, 'the reported total page count changed');
  }
  return pages;
}

const fixtureComic = (_id, epsCount) => ({
  _id,
  epsCount,
  thumb: {fileServer: 'https://img.example.invalid', path: 'cover.jpg'},
});

const fixture = (secondPage) => async (url) => {
  const page = Number(new URL(url).searchParams.get('page'));
  const docs = page === 1 ? [fixtureComic('a', 85), fixtureComic('b', 0)] : secondPage;
  return {status: 200, body: JSON.stringify({data: {comics: {docs, page, pages: 2, limit: 2}}})};
};

test('Picacg favorites probe accepts chapter counts and distinct pages', async () => {
  assert.deepEqual(await inspectFavorites(fixture([fixtureComic('c', 12)])), [
    {page: 1, items: 2, totalPages: 2},
    {page: 2, items: 1, totalPages: 2},
  ]);
});

test('Picacg favorites probe rejects missing and invalid chapter counts', async () => {
  await assert.rejects(inspectFavorites(fixture([
    fixtureComic('c'),
    fixtureComic('d', '85'),
  ])), /2\/2 invalid or missing epsCount/);
});

test('Picacg favorites probe rejects a comic repeated across pages', async () => {
  await assert.rejects(inspectFavorites(fixture([fixtureComic('a', 85)])), /page 2 contains a duplicate ID/);
});

const token = process.env.PICACG_TEST_TOKEN?.trim();
test('live legacy Picacg favorites return chapter counts on two pages', {
  skip: token ? false : 'set PICACG_TEST_TOKEN locally to enable the read-only probe',
}, async (t) => {
  const pages = await inspectFavorites(async (url, headers) => {
    try {
      const response = await fetch(url, {headers, redirect: 'error', signal: AbortSignal.timeout(10_000)});
      return {status: response.status, body: response.status === 200 ? await response.text() : ''};
    } catch {
      assert.fail('could not read the legacy favorites endpoint (network, redirect, or timeout)');
    }
  }, token);
  for (const {page, totalPages, items} of pages) {
    console.log(pages);
    t.diagnostic(`page ${page}/${totalPages}: ${items}/${items} entries had valid epsCount`);
  }
});
