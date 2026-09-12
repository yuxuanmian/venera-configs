const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {loadSource} = require('./source_harness');

/** The closed set of standard observation field names (Contract C2). */
const STANDARD_FIELDS = [
  'updatedAt',
  'latestChapterId',
  'chapterCount',
  'recentChapterIds',
  'sourceUnread',
];

/** Granularity suffixes allowed only on `updatedAt` (Contract C4). */
const GRANULARITIES = ['day', 'instant'];

/**
 * Validates one branch declaration against the parent's Contract C6.
 * Returns an error string, or null when the declaration is valid.
 */
const declarationError = (declaration) => {
  if (declaration === undefined) return 'declaration is required';
  if (declaration === null || typeof declaration !== 'object' ||
      Array.isArray(declaration)) {
    return 'declaration must be an object';
  }
  const keys = Object.keys(declaration);
  if (keys.length === 0) return 'declaration must declare at least one field';
  for (const key of keys) {
    if (!STANDARD_FIELDS.includes(key)) return `unknown field: ${key}`;
    const value = declaration[key];
    if (typeof value !== 'string') return `field ${key} must be a string`;
    const trimmed = value.trim();
    if (!trimmed) return `field ${key} is empty`;
    const at = trimmed.indexOf('@');
    if (at < 0) continue;
    const granularity = trimmed.slice(at + 1).trim().toLowerCase();
    if (!trimmed.slice(0, at).trim()) {
      return `field ${key} has no source description`;
    }
    if (key !== 'updatedAt') {
      return 'only updatedAt may carry a granularity';
    }
    if (!GRANULARITIES.includes(granularity)) {
      return `unknown granularity: ${granularity}`;
    }
  }
  return null;
};

/** The observation fields a branch actually produced, collected recursively. */
const producedFields = (value, into = new Set()) => {
  if (Array.isArray(value)) {
    value.forEach((item) => producedFields(item, into));
    return into;
  }
  if (value === null || typeof value !== 'object') return into;
  if (Object.prototype.hasOwnProperty.call(value, 'update')) {
    const update = value.update;
    if (update !== null && typeof update === 'object' && !Array.isArray(update)) {
      Object.keys(update).forEach((key) => into.add(key));
    }
  }
  if (Object.prototype.hasOwnProperty.call(value, 'sourceUnread')) {
    if (typeof value.sourceUnread === 'boolean') into.add('sourceUnread');
  }
  Object.values(value).forEach((item) => producedFields(item, into));
  return into;
};

test('both shipped sources declare exactly one primary scan capability', () => {
  const picacg = loadSource('picacg.js', 'Picacg').source;
  const manwa = loadSource('manwa.js', 'Manwa').source;
  assert.equal(picacg.scan.primary, 'comic');
  assert.equal(typeof picacg.scan.comic.load, 'function');
  assert.equal(picacg.scan.collection, undefined);
  assert.equal(manwa.scan.primary, 'collection');
  assert.equal(typeof manwa.scan.collection.load, 'function');
  assert.equal(manwa.scan.comic, undefined);
});

test('every declared branch carries a valid fieldSource mapping', () => {
  for (const [file, className, branch] of [
    ['picacg.js', 'Picacg', 'comic'],
    ['manwa.js', 'Manwa', 'collection'],
  ]) {
    const source = loadSource(file, className).source;
    const declaration = source.scan[branch].fieldSource;
    const error = declarationError(declaration);
    assert.equal(error, null, `${file} ${branch}: ${error}`);
    assert(Object.keys(declaration).length > 0, `${file} ${branch} is empty`);
  }
});

test('the declaration and the produced fields agree', async () => {
  // Manwa: a collection page whose books carry both a chapter id and the two
  // unread flags.
  const manwa = loadSource('manwa.js', 'Manwa', {
    request: async () => ({
      status: 200,
      headers: {},
      body: JSON.stringify({
        err: 0,
        books: [{
          id: 'comic-1',
          book_name: 'Fixture',
          last_chapter: {id: 'chapter-1'},
          is_new: true,
          full_is_new: false,
        }],
      }),
    }),
  });
  const manwaPage = await manwa.source.scan.collection.load(
    'default',
    null,
    manwa.request,
  );
  assert(manwaPage.items, 'the fixture must produce a page');
  const manwaProduced = producedFields(manwaPage);
  const manwaDeclared = new Set(Object.keys(manwa.source.scan.collection.fieldSource));
  assert.deepEqual(
    [...manwaProduced].sort(),
    [...manwaDeclared].sort(),
    'manwa declared/produced field sets must match',
  );
  // Granularity: manwa declares none, and produces an opaque chapter id plus a
  // boolean, so nothing may carry one.
  for (const value of Object.values(manwa.source.scan.collection.fieldSource)) {
    assert(!value.includes('@'), `manwa must not declare a granularity: ${value}`);
  }

  // Picacg: a comic response carrying a timestamp.
  const picacg = loadSource('picacg.js', 'Picacg', {
    data: {account: ['user@example.test', 'password'], token: 'token'},
    request: async () => ({
      status: 200,
      headers: {},
      body: JSON.stringify({data: {comic: {_id: 'comic-1', updated_at: '2026-09-10'}}}),
    }),
  });
  const picacgResult = await picacg.source.scan.comic.load('comic-1', picacg.request);
  assert(picacgResult.observation, 'the fixture must produce an observation');
  const picacgProduced = producedFields(picacgResult);
  const picacgDeclared = new Set(Object.keys(picacg.source.scan.comic.fieldSource));
  assert.deepEqual(
    [...picacgProduced].sort(),
    [...picacgDeclared].sort(),
    'picacg declared/produced field sets must match',
  );
  // Granularity: the fixture returns a date-only value, so @day is the
  // weakest representation the declaration may claim.
  const declaredUpdatedAt = picacg.source.scan.comic.fieldSource.updatedAt;
  assert.match(declaredUpdatedAt, /@(day|instant)$/);
  if (declaredUpdatedAt.endsWith('@day')) {
    assert.match(
      picacgResult.observation.update.updatedAt,
      /^\d{4}-\d{2}-\d{2}$/,
      'an @day declaration must match a date-only value',
    );
  }
});

test('the produced value types match the standard fields', async () => {
  const manwa = loadSource('manwa.js', 'Manwa', {
    request: async () => ({
      status: 200,
      headers: {},
      body: JSON.stringify({
        err: 0,
        books: [{
          id: 'comic-1',
          book_name: 'Fixture',
          last_chapter: {id: 'chapter-1'},
          is_new: true,
          full_is_new: true,
        }],
      }),
    }),
  });
  const page = await manwa.source.scan.collection.load('default', null, manwa.request);
  const observation = page.items[0].observation;
  assert.equal(typeof observation.update.latestChapterId, 'string');
  assert.equal(typeof observation.sourceUnread, 'boolean');

  const picacg = loadSource('picacg.js', 'Picacg', {
    data: {account: ['user@example.test', 'password'], token: 'token'},
    request: async () => ({
      status: 200,
      headers: {},
      body: JSON.stringify({data: {comic: {_id: 'comic-1', updated_at: '2026-09-10T12:30:45.123Z'}}}),
    }),
  });
  const result = await picacg.source.scan.comic.load('comic-1', picacg.request);
  assert.equal(typeof result.observation.update.updatedAt, 'string');
});

test('a missing, unknown or misplaced declaration is rejected', () => {
  assert.equal(declarationError(undefined), 'declaration is required');
  assert.match(declarationError({latestChapterID: 'x'}), /unknown field/);
  assert.match(declarationError({latestChapterId: 3}), /must be a string/);
  assert.match(declarationError({}), /at least one field/);
  assert.match(declarationError({latestChapterId: 'id@day'}), /only updatedAt/);
  assert.match(declarationError({updatedAt: 'updated_at@week'}), /unknown granularity/);
  assert.match(declarationError({updatedAt: '@day'}), /no source description/);
  assert.equal(declarationError({updatedAt: 'updated_at@instant'}), null);
  assert.equal(declarationError({sourceUnread: 'is_new|full_is_new'}), null);
});

test('scan observations carry only standard fields and no scheduling input', async () => {
  const manwa = loadSource('manwa.js', 'Manwa', {
    request: async () => ({
      status: 200,
      headers: {},
      body: JSON.stringify({
        err: 0,
        books: [{
          id: 'comic-1',
          book_name: 'Fixture',
          last_chapter: {id: 'chapter-1'},
          is_new: true,
          full_is_new: false,
          activityAt: '2026-09-10',
          next_check_at_ms: 1,
        }],
      }),
    }),
  });
  const page = await manwa.source.scan.collection.load('default', null, manwa.request);
  const observation = page.items[0].observation;
  assert.deepEqual(Object.keys(observation).sort(), ['sourceUnread', 'update']);
  for (const key of Object.keys(observation.update)) {
    assert(STANDARD_FIELDS.includes(key), `unexpected observation field: ${key}`);
  }
  // The comparable label never enters the observation payload (Contract C5).
  assert.equal(observation.evidenceSchema, undefined);
  assert.equal(observation.fieldSource, undefined);
});

test('scan declaration does not issue network during construction', () => {
  const calls = [];
  const harness = loadSource('picacg.js', 'Picacg', {
    request: async (request) => { calls.push(request); return {status: 200, body: '{}'}; },
  });
  assert.equal(calls.length, 0);
  assert.equal(harness.calls.length, 0);
});

test('scan additions preserve the ordinary source API', () => {
  const picacg = loadSource('picacg.js', 'Picacg').source;
  const manwa = loadSource('manwa.js', 'Manwa').source;

  assert.equal(typeof picacg.comic.loadInfo, 'function');
  assert.equal(typeof picacg.account.login, 'function');
  assert.equal(typeof picacg.favorites.loadComics, 'function');
  assert.equal(typeof manwa.favorites.loadComics, 'function');
  // Retained for compatibility with older App versions (FR-044/FR-045).
  assert.equal(typeof manwa.favorites.updateCheck.load, 'function');
  assert.equal(typeof manwa.comic.loadInfo, 'function');
});

test('versions and catalog entries are synchronized', () => {
  const index = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'index.json'), 'utf8'));
  for (const key of ['picacg', 'manwa']) {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', `${key}.js`), 'utf8');
    const version = source.match(/version\s*=\s*"([^"]+)"/)[1];
    assert.equal(index.find((entry) => entry.key === key).version, version);
  }
});
