const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const path = require('node:path');
const sourceCode = fs.readFileSync(path.join(__dirname, '..', 'manwa.js'), 'utf8');

function createHarness(count, booksByOffset, rawJsonByOffset = {}) {
  const calls = [];
  class ComicSource {}
  class Comic {
    constructor(fields) {
      Object.assign(this, fields);
    }
  }
  class HtmlDocument {
    constructor() {}

    querySelector(selector) {
      assert.equal(selector, '.favorite-count');
      return {text: `${count}/800`};
    }

    querySelectorAll() {
      return [];
    }

    dispose() {}
  }
  const Network = {
    get: async (url) => {
      calls.push(url);
      if (url.endsWith('/bookshelf')) {
        return {status: 200, body: '<span class="favorite-count"></span>'};
      }
      const offset = Number(new URL(url).searchParams.get('page'));
      return {
        status: 200,
        body: rawJsonByOffset[offset]
          || JSON.stringify({err: 0, books: booksByOffset[offset] || []}),
      };
    },
  };
  const context = {ComicSource, Comic, HtmlDocument, Network, console, URL};
  vm.runInNewContext(`${sourceCode}\nthis.Manwa = Manwa;`, context);
  return {source: new context.Manwa(), calls};
}

function book(
  id,
  updateTime = `2026-08-${String(id).padStart(2, '0')} 12:34:56`,
) {
  return {
    id,
    book_name: `Book ${id}`,
    cover_url: `/static/book-${id}.webp`,
    updateTime,
    is_new: id % 2 === 0,
    full_is_new: id % 3 === 0,
  };
}

function makeBooks(count) {
  const books = [];
  for (let id = 1; id <= count; id += 1) books.push(book(id));
  return books;
}

(async () => {
  const books = makeBooks(31);
  const {source, calls} = createHarness(31, {
    0: books.slice(0, 15),
    15: books.slice(15, 30),
    30: books.slice(30),
  });
  const snapshot = await source.favorites.updateCheck.load(null);
  assert.equal(source.favorites.updateCheck.markerScheme, 'manwa-list-time-v1');
  assert.equal(source.favorites.updateCheck.scanInterval, 43200);
  assert.equal(snapshot.pageSize, 15);
  assert.equal(snapshot.total, 31);
  assert.equal(snapshot.comics.length, 31);
  const favoriteCalls = calls.filter((url) => url.includes('/getfavors?'));
  assert.deepEqual(
    favoriteCalls.map((url) => new URL(url).searchParams.get('page')),
    ['0', '15', '30'],
  );
  assert(favoriteCalls.every((url) => url.includes('showOnlyUpdated=-1')));
  assert(favoriteCalls.every((url) => url.includes('folder_id=0')));
  assert.equal(
    snapshot.comics[0].favoriteUpdate.marker,
    '2026-08-01 12:34:56',
  );
  assert.equal(
    snapshot.comics[0].favoriteUpdate.updateTime,
    '2026-08-01 12:34:56',
  );
  assert.equal(snapshot.comics[0].favoriteUpdate.isNew, false);
  assert.equal(snapshot.comics[0].favoriteUpdate.metadata.fullIsNew, false);
  assert.equal(snapshot.comics[1].favoriteUpdate.isNew, true);
  assert.equal(snapshot.comics[1].favoriteUpdate.metadata.fullIsNew, false);
  assert.equal(snapshot.comics[2].favoriteUpdate.isNew, false);
  assert.equal(snapshot.comics[2].favoriteUpdate.metadata.fullIsNew, true);
  assert(calls.every((url) => !url.includes('/book/')));

  const page = await source.favorites.loadComics(2, null);
  assert.equal(page.maxPage, 3);

  const empty = createHarness(0, {});
  const emptySnapshot = await empty.source.favorites.updateCheck.load(null);
  assert.equal(emptySnapshot.comics.length, 0);
  assert.equal(empty.calls.length, 1);

  const invalid = createHarness(1, {0: [book(1, '')]});
  await assert.rejects(
    invalid.source.favorites.updateCheck.load(null),
    /更新时间证据/,
  );

  const shortMiddle = createHarness(31, {
    0: books.slice(0, 14),
    15: books.slice(15, 30),
    30: books.slice(30),
  });
  await assert.rejects(
    shortMiddle.source.favorites.updateCheck.load(null),
    /分页数据不一致/,
  );

  const invalidMiddle = createHarness(
    31,
    {
      0: books.slice(0, 15),
      15: books.slice(15, 30),
      30: books.slice(30),
    },
    {15: '{invalid-middle-json'},
  );
  let partialSnapshot;
  await assert.rejects(
    (async () => {
      partialSnapshot = await invalidMiddle.source.favorites.updateCheck.load(null);
    })(),
    /invalid JSON/,
  );
  assert.equal(partialSnapshot, undefined);
  assert.deepEqual(
    invalidMiddle.calls
      .filter((url) => url.includes('/getfavors?'))
      .map((url) => new URL(url).searchParams.get('page')),
    ['0', '15'],
  );

  const duplicate = createHarness(2, {0: [book(1), book(1)]});
  await assert.rejects(
    duplicate.source.favorites.updateCheck.load(null),
    /重复/,
  );

  const invalidJson = createHarness(1, {}, {0: '{not-json'});
  await assert.rejects(
    invalidJson.source.favorites.updateCheck.load(null),
    /invalid JSON/,
  );

  const configFiles = fs.readdirSync(path.join(__dirname, '..'))
    .filter((file) => file.endsWith('.js'))
    .filter((file) => file !== '_venera_.js' && file !== 'manwa.js');
  assert.deepEqual(
    configFiles.filter((file) =>
      fs.readFileSync(path.join(__dirname, '..', file), 'utf8')
        .includes('updateCheck:')),
    [],
  );
  assert.match(sourceCode, /version\s*=\s*["']1\.0\.4["']/);
  const index = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'index.json'), 'utf8'));
  assert.equal(index.find((item) => item.key === 'manwa').version, '1.0.4');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
