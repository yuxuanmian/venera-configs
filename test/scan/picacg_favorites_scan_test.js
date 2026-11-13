const assert = require('node:assert/strict');
const test = require('node:test');
const {loadSource, toPlain} = require('./source_harness');

const CAPABILITY = 'SCAN_COLLECTION_ITEM_FAILURES_V1';

const favoriteBody = (docs, {
  page,
  pages,
  limit,
} = {}) => JSON.stringify({
  data: {
    comics: {
      docs,
      page,
      pages,
      limit,
    },
  },
});

const comic = (_id, epsCount) => ({
  _id,
  epsCount,
  title: `Comic ${_id}`,
});

const make = ({
  handler,
  data = {
    account: ['user@example.test', 'password'],
    token: 'token',
    settings: {
      base_url: 'https://pica.example.invalid',
      favoriteSort: 'da',
    },
  },
  supported = true,
} = {}) => loadSource('picacg.js', 'Picacg', {
  data,
  globals: supported ? {[CAPABILITY]: true} : {},
  request: async (request) => handler(request),
});

const collect = async (harness) => {
  let cursor = null;
  const items = [];
  while (true) {
    const page = await harness.source.scan.collection.load(
      'default',
      cursor,
      harness.request,
    );
    if (page.failure) return {failure: page.failure, items};
    items.push(...page.items);
    if (page.next === null) return {items};
    cursor = page.next;
  }
};

test('Picacg keeps its legacy scan branch when the host flag is absent', () => {
  const harness = make({supported: false, handler: async () => {
    throw new Error('construction must not request');
  }});

  assert.equal(harness.source.scan.primary, 'comic');
  assert.equal(typeof harness.source.scan.comic.load, 'function');
  assert.equal(harness.source.scan.collection, undefined);
});

test('Picacg favorites reuse the existing default API origin', async () => {
  const harness = make({
    data: {
      account: ['user@example.test', 'password'],
      token: 'token',
      settings: {favoriteSort: 'da'},
    },
    handler: async (request) => {
      assert.equal(new URL(request.url).origin, 'https://picaapi.picacomic.com');
      return {
        status: 200,
        headers: {},
        body: favoriteBody([], {page: 1, pages: 0}),
      };
    },
  });

  assert.deepEqual(toPlain(await collect(harness)), {items: []});
});

test('Picacg scans fixed-order favorite pages and separates item failures', async () => {
  const pages = {
    1: [comic('a', 85), comic('b', 0), comic('bad-count'), comic('bad-type', '7')],
    2: [comic('c', 12)],
  };
  const harness = make({
    handler: async (request) => {
      const url = new URL(request.url);
      const page = Number(url.searchParams.get('page'));
      return {
        status: 200,
        headers: {},
        body: favoriteBody(pages[page], {page, pages: 2}),
      };
    },
  });

  const result = await collect(harness);

  assert.deepEqual(harness.calls.map((call) => {
    const url = new URL(call.url);
    return [url.pathname, url.searchParams.get('page'), url.searchParams.get('s'), url.searchParams.has('limit')];
  }), [
    ['/users/favourite', '1', 'dd', false],
    ['/users/favourite', '2', 'dd', false],
    ['/users/favourite', '1', 'dd', false],
  ]);
  assert.equal(result.items.length, 5);
  assert.deepEqual(toPlain(result.items[0].observation), {
    update: {chapterCount: 85},
  });
  assert.deepEqual(toPlain(result.items[1].observation), {
    update: {chapterCount: 0},
  });
  assert.equal(result.items[2].failure.sourceCode, 'ERR_EPS_COUNT');
  assert.equal(result.items[3].failure.sourceCode, 'ERR_EPS_COUNT');
  assert.deepEqual(toPlain(result.items[4].observation), {
    update: {chapterCount: 12},
  });
  assert.equal(harness.source.scan.collection.itemFailures, true);
});

test('Picacg treats a legal empty collection explicitly', async () => {
  const harness = make({
    handler: async (request) => {
      return {
        status: 200,
        headers: {},
        body: favoriteBody([], {pages: 1}),
      };
    },
  });

  const result = await collect(harness);

  assert.deepEqual(toPlain(result), {items: []});
  assert.deepEqual(harness.calls.map((call) =>
    Number(new URL(call.url).searchParams.get('page'))), [1, 1]);
});

test('Picacg accepts optional page and limit metadata, including numeric strings', async (t) => {
  for (const [name, metadata] of [
    ['missing', {pages: 1}],
    ['numeric strings', {page: '1', pages: 1, limit: '1'}],
  ]) {
    await t.test(name, async () => {
      const harness = make({
        handler: async () => ({
          status: 200,
          headers: {},
          body: favoriteBody([comic('a', 2)], metadata),
        }),
      });
      assert.deepEqual(toPlain(await collect(harness)), {
        items: [{
          comicId: 'a',
          observation: {update: {chapterCount: 2}},
        }],
      });
    });
  }
});

test('Picacg rejects malformed pages, IDs, duplicates and unstable pagination', async (t) => {
  const cases = [
    {
      name: 'non-object item',
      docs: [null],
      pattern: /favorite item was invalid/,
    },
    {
      name: 'numeric ID',
      docs: [comic(42, 1)],
      pattern: /comic ID was invalid/,
    },
    {
      name: 'duplicate ID',
      docs: [comic('same', 1), comic('same', 2)],
      pattern: /duplicate IDs/,
    },
    {
      name: 'wrong response page',
      docs: [comic('a', 1)],
      page: 2,
      pattern: /pagination was inconsistent/,
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const harness = make({
        handler: async () => ({
          status: 200,
          headers: {},
          body: favoriteBody(entry.docs, {
            page: entry.page ?? 1,
            pages: 2,
          }),
        }),
      });
      const result = await collect(harness);
      assert.match(result.failure.message, entry.pattern);
      assert.deepEqual(result.items, []);
    });
  }
});

test('Picacg rejects page-count drift and a changed verification head', async (t) => {
  await t.test('page count drift', async () => {
    let requestCount = 0;
    const harness = make({
      handler: async (request) => {
        requestCount += 1;
        const page = Number(new URL(request.url).searchParams.get('page'));
        return {
          status: 200,
          headers: {},
          body: favoriteBody([comic(`page-${page}`, 1)], {
            page,
            pages: page === 2 ? 3 : 2,
          }),
        };
      },
    });
    const result = await collect(harness);
    assert.match(result.failure.message, /page count changed/);
    assert.equal(requestCount, 2);
  });

  await t.test('changed first-page IDs', async () => {
    let pageOneReads = 0;
    const harness = make({
      handler: async (request) => {
        const page = Number(new URL(request.url).searchParams.get('page'));
        if (page === 1) pageOneReads += 1;
        const docs = page === 2
          ? [comic('c', 3)]
          : pageOneReads === 1
            ? [comic('a', 1), comic('b', 2)]
            : [comic('changed', 1), comic('b', 2)];
        return {
          status: 200,
          headers: {},
          body: favoriteBody(docs, {page, pages: 2}),
        };
      },
    });
    const result = await collect(harness);
    assert.match(result.failure.message, /changed during scan/);
    assert.equal(result.items.length, 3);
  });
});

test('Picacg rejects an empty page inside a multi-page collection', async () => {
  const harness = make({
    handler: async (request) => {
      const page = Number(new URL(request.url).searchParams.get('page'));
      return {
        status: 200,
        headers: {},
        body: favoriteBody(
          page === 1 ? [comic('a', 1)] : [],
          {page, pages: 2},
        ),
      };
    },
  });
  const result = await collect(harness);

  assert.match(result.failure.message, /pagination was inconsistent/);
  assert.deepEqual(result.items.map((item) => item.comicId), ['a']);
  assert.deepEqual(harness.calls.map((call) =>
    Number(new URL(call.url).searchParams.get('page'))), [1, 2]);
});

test('Picacg validates cursors before issuing a favorites request', async () => {
  const harness = make({
    handler: async () => {
      throw new Error('invalid cursor must not request');
    },
  });
  for (const cursor of [
    {phase: 'page'},
    {phase: 'page', page: 1, pages: 2, headIds: []},
    {phase: 'verify', pages: 1, headIds: ['duplicate', 'duplicate']},
    {phase: 'verify', pages: 1, headIds: [], extra: true},
  ]) {
    const result = await harness.source.scan.collection.load(
      'default',
      cursor,
      harness.request,
    );
    assert(result.failure);
  }
  assert.equal(harness.calls.length, 0);
});

test('Picacg favorites share the existing one-step 401 recovery', async () => {
  let favoriteGets = 0;
  const harness = make({
    handler: async (request) => {
      if (request.method === 'POST') {
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({data: {token: 'new-token'}}),
        };
      }
      favoriteGets += 1;
      return favoriteGets === 1
        ? {status: 401, headers: {}, body: ''}
        : {
            status: 200,
            headers: {},
            body: favoriteBody([], {page: 1, pages: 0}),
          };
    },
  });

  const result = await collect(harness);

  assert.deepEqual(toPlain(result), {items: []});
  assert.equal(harness.calls.filter((call) => call.method === 'POST').length, 1);
  assert.equal(harness.calls.filter((call) => call.method === 'GET').length, 3);
  assert.equal(harness.source.data.token, 'new-token');
});
