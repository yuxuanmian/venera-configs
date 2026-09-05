const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const path = require('node:path');
const sourceCode = fs.readFileSync(path.join(__dirname, '..', 'manwa.js'), 'utf8');

function createHarness({
  count,
  booksByOffset,
  rawJsonByOffset = {},
  bookshelfBody = '<span class="favorite-count"></span>',
  bookshelfCountText = `${count}/800`,
}) {
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
      return bookshelfCountText == null ? null : {text: bookshelfCountText};
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
        return {status: 200, body: bookshelfBody};
      }
      const offset = Number(new URL(url).searchParams.get('page'));
      const body = Object.prototype.hasOwnProperty.call(rawJsonByOffset, offset)
        ? rawJsonByOffset[offset]
        : JSON.stringify({err: 0, books: booksByOffset[offset] || []});
      return {status: 200, body};
    },
  };
  const context = {ComicSource, Comic, HtmlDocument, Network, console, URL};
  vm.runInNewContext(`${sourceCode}\nthis.Manwa = Manwa;`, context);
  return {source: new context.Manwa(), calls};
}

function book(
  id,
  {
    chapterId = `chapter-${id}`,
    fullChapterId = null,
    isNew = id % 2 === 0,
    fullIsNew = id % 3 === 0,
  } = {},
) {
  return {
    id,
    book_name: `Book ${id}`,
    cover_url: `/static/book-${id}.webp`,
    is_new: isNew,
    full_is_new: fullIsNew,
    last_chapter: {
      id: chapterId,
      chapter_name: `Chapter ${id}`,
    },
    full_last_chapter: fullChapterId == null
      ? null
      : {id: fullChapterId, chapter_name: `Full chapter ${id}`},
    // This is a reading record and must never become update evidence.
    read_last_chapter: {
      id: `read-${id}`,
      chapter_name: `Read chapter ${id}`,
      update_time: '2099-01-01 00:00:00',
    },
  };
}

function makeBooks(count) {
  const books = [];
  for (let id = 1; id <= count; id += 1) {
    books.push(book(id, {fullChapterId: id % 2 === 1 ? `full-${id}` : null}));
  }
  return books;
}

(async () => {
  const books = makeBooks(31);
  const {source, calls} = createHarness({
    count: 31,
    booksByOffset: {
      0: books.slice(0, 15),
      15: books.slice(15, 30),
      30: books.slice(30),
    },
  });
  const snapshot = await source.favorites.updateCheck.load(null);
  assert.equal(source.favorites.updateCheck.markerScheme, undefined);
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
    '["manwa-full-v1","chapter-1","full-1"]',
  );
  assert.equal(snapshot.comics[0].favoriteUpdate.state, undefined);
  assert.equal(snapshot.comics[0].favoriteUpdate.updateTime, undefined);
  assert.equal(
    JSON.stringify(snapshot.comics[1].favoriteUpdate.state),
    JSON.stringify({latestChapterId: 'chapter-2'}),
  );
  assert.equal(snapshot.comics[0].favoriteUpdate.sourceUnread, false);
  assert.equal(snapshot.comics[1].favoriteUpdate.sourceUnread, true);
  assert.equal(snapshot.comics[0].favoriteUpdate.isNew, undefined);
  assert.equal(snapshot.comics[0].favoriteUpdate.metadata.fullIsNew, false);
  assert.equal(snapshot.comics[0].favoriteUpdate.metadata.normalIsNew, false);
  assert.equal(
    snapshot.comics[0].favoriteUpdate.metadata.fullLatestChapterId,
    'full-1',
  );
  assert.equal(snapshot.comics[2].favoriteUpdate.metadata.fullIsNew, true);
  assert(calls.every((url) => !url.includes('/book/')));

  const page = await source.favorites.loadComics(2, null);
  assert.equal(page.maxPage, 3);
  assert.equal(page.comics[0].favoriteUpdate.updateTime, undefined);

  const businessPhraseBook = book(1);
  businessPhraseBook.book_name = '请等待的漫画';
  businessPhraseBook.last_chapter.chapter_name = '系统繁忙章节';
  const businessPhrase = createHarness({
    count: 1,
    booksByOffset: {0: [businessPhraseBook]},
  });
  const businessPhraseSnapshot =
    await businessPhrase.source.favorites.updateCheck.load(null);
  assert.equal(businessPhraseSnapshot.comics[0].title, '请等待的漫画');
  assert.equal(businessPhraseSnapshot.comics[0].subtitle, '系统繁忙章节');

  const empty = createHarness({count: 0, booksByOffset: {}});
  const emptySnapshot = await empty.source.favorites.updateCheck.load(null);
  assert.equal(emptySnapshot.comics.length, 0);
  assert.equal(empty.calls.length, 1);

  const invalidChapter = createHarness({
    count: 1,
    booksByOffset: {0: [book(1, {chapterId: null})]},
  });
  await assert.rejects(
    invalidChapter.source.favorites.updateCheck.load(null),
    /缺少最新章节 ID/,
  );
  assert(invalidChapter.calls.every((url) => !url.includes('/book/')));

  const shortMiddle = createHarness({
    count: 31,
    booksByOffset: {
      0: books.slice(0, 14),
      15: books.slice(15, 30),
      30: books.slice(30),
    },
  });
  await assert.rejects(
    shortMiddle.source.favorites.updateCheck.load(null),
    /分页数据不一致/,
  );

  const invalidMiddle = createHarness({
    count: 31,
    booksByOffset: {
      0: books.slice(0, 15),
      15: books.slice(15, 30),
      30: books.slice(30),
    },
    rawJsonByOffset: {15: '{invalid-middle-json'},
  });
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

  const duplicate = createHarness({count: 2, booksByOffset: {0: [book(1), book(1)]}});
  await assert.rejects(
    duplicate.source.favorites.updateCheck.load(null),
    /重复/,
  );

  const emptyIdBook = book(1);
  emptyIdBook.id = '';
  const emptyIdHarness = createHarness({count: 1, booksByOffset: {0: [emptyIdBook]}});
  await assert.rejects(emptyIdHarness.source.favorites.updateCheck.load(null), /空漫画 ID/);

  const invalidJson = createHarness({
    count: 1,
    booksByOffset: {0: [book(1)]},
    rawJsonByOffset: {0: '{not-json'},
  });
  await assert.rejects(
    invalidJson.source.favorites.updateCheck.load(null),
    /invalid JSON/,
  );

  const nonArrayBooks = createHarness({
    count: 1,
    booksByOffset: {},
    rawJsonByOffset: {0: JSON.stringify({err: 0, books: {}})},
  });
  await assert.rejects(
    nonArrayBooks.source.favorites.updateCheck.load(null),
    /收藏列表无效/,
  );

  const invalidErr = createHarness({
    count: 1,
    booksByOffset: {},
    rawJsonByOffset: {0: JSON.stringify({err: 1, msg: '服务失败'})},
  });
  await assert.rejects(invalidErr.source.favorites.updateCheck.load(null), /服务失败/);

  const waitMessage = createHarness({
    count: 1,
    booksByOffset: {},
    rawJsonByOffset: {0: JSON.stringify({err: 1, msg: '请等待'})},
  });
  await assert.rejects(
    waitMessage.source.favorites.updateCheck.load(null),
    /收藏接口暂时不可用，请稍后重试/,
  );

  const driftedBoolean = book(1);
  driftedBoolean.is_new = 1;
  const drifted = createHarness({count: 1, booksByOffset: {0: [driftedBoolean]}});
  await assert.rejects(
    drifted.source.favorites.updateCheck.load(null),
    /字段类型无效/,
  );

  const waitCount = createHarness({
    count: 1,
    booksByOffset: {},
    bookshelfBody: '<!DOCTYPE html><html><body>请等待</body></html>',
    bookshelfCountText: null,
  });
  await assert.rejects(
    waitCount.source.favorites.updateCheck.load(null),
    /收藏接口暂时不可用，请稍后重试/,
  );
  await assert.rejects(
    waitCount.source.favorites.updateCheck.load(null),
    (error) => error !== 'Login expired',
  );

  const waitJson = createHarness({
    count: 1,
    booksByOffset: {},
    rawJsonByOffset: {0: '<html><body>访问过于频繁，请稍后再试</body></html>'},
  });
  await assert.rejects(
    waitJson.source.favorites.updateCheck.load(null),
    /收藏接口暂时不可用，请稍后重试/,
  );
  await assert.rejects(
    waitJson.source.favorites.updateCheck.load(null),
    (error) => error !== 'Login expired',
  );

  const waitJsonWithoutMarkup = createHarness({
    count: 1,
    booksByOffset: {},
    rawJsonByOffset: {0: 'DOCTYPE html 请等待'},
  });
  await assert.rejects(
    waitJsonWithoutMarkup.source.favorites.updateCheck.load(null),
    /收藏接口暂时不可用，请稍后重试/,
  );

  const waitPlainText = createHarness({
    count: 1,
    booksByOffset: {},
    rawJsonByOffset: {0: '系统繁忙，请稍后再试'},
  });
  await assert.rejects(
    waitPlainText.source.favorites.updateCheck.load(null),
    /收藏接口暂时不可用，请稍后重试/,
  );

  const waitJsonString = createHarness({
    count: 1,
    booksByOffset: {},
    rawJsonByOffset: {0: JSON.stringify('请等待')},
  });
  await assert.rejects(
    waitJsonString.source.favorites.updateCheck.load(null),
    /收藏接口暂时不可用，请稍后重试/,
  );

  const countMismatch = createHarness({
    count: 1,
    booksByOffset: {0: []},
  });
  await assert.rejects(
    countMismatch.source.favorites.loadComics(1, null),
    /分页数据不一致/,
  );

  const pageShapeError = createHarness({
    count: 1,
    booksByOffset: {0: [null]},
  });
  await assert.rejects(
    pageShapeError.source.favorites.loadComics(1, null),
    /无效漫画结构/,
  );

  const configFiles = fs.readdirSync(path.join(__dirname, '..'))
    .filter((file) => file.endsWith('.js'))
    .filter((file) => file !== '_venera_.js' && file !== 'manwa.js' && file !== '_template_.js');
  assert.deepEqual(
    configFiles.filter((file) =>
      fs.readFileSync(path.join(__dirname, '..', file), 'utf8')
        .includes('updateCheck:')),
    [],
  );
  assert.match(sourceCode, /version\s*=\s*["']1\.0\.6["']/);
  const index = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'index.json'), 'utf8'));
  assert.equal(index.find((item) => item.key === 'manwa').version, '1.0.6');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
