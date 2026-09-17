// Contract N navigation matrix for `venera-configs/picacg.js`.
//
// Only the Pica detail namespace exactly equal to `Tags` may select the exact
// semantic tag search; Author, Categories, Chinese Team and every other
// namespace keep their 1.0.8 behavior, and the keyword is forwarded untouched.

const assert = require('node:assert/strict');
const test = require('node:test');
const {loadSource, toPlain} = require('./source_harness');

const make = () => loadSource('picacg.js', 'Picacg', {
  data: {settings: {base_url: 'https://pica.example.invalid'}},
});

test('Picacg onClickTag sends only the Tags namespace to tagSearch', () => {
  const {source} = make();
  const onClickTag = source.comic.onClickTag;
  assert.equal(typeof onClickTag, 'function');

  for (const value of ['Fate', '  Fate  ', 'fate', 'FATE', 'タグ Fate', 'a/b+c?d=e', '']) {
    assert.deepEqual(
      toPlain(onClickTag('Tags', value)),
      {action: 'tagSearch', keyword: value},
      `Tags ${JSON.stringify(value)}`,
    );
    // Exactly the tagSearch attributes: no param, no display label.
    assert.deepEqual(Object.keys(toPlain(onClickTag('Tags', value))), ['action', 'keyword']);
  }
});

test('Picacg onClickTag keeps the Author and Categories category jump', () => {
  const {source} = make();
  const onClickTag = source.comic.onClickTag;

  assert.deepEqual(toPlain(onClickTag('Author', '  Mixed Case Author  ')), {
    action: 'category',
    keyword: '  Mixed Case Author  ',
    param: 'a',
  });
  assert.deepEqual(toPlain(onClickTag('Categories', '  Mixed Case Category  ')), {
    action: 'category',
    keyword: '  Mixed Case Category  ',
    param: 'c',
  });
  assert.deepEqual(
    Object.keys(toPlain(onClickTag('Author', 'x'))),
    ['action', 'keyword', 'param'],
  );
  assert.deepEqual(
    Object.keys(toPlain(onClickTag('Categories', 'x'))),
    ['action', 'keyword', 'param'],
  );
});

test('Picacg onClickTag falls back to ordinary search for every other namespace', () => {
  const {source} = make();
  const onClickTag = source.comic.onClickTag;
  const value = '  Mixed CASE 标签  ';

  for (const namespace of [
    'Chinese Team',
    'Uploader',
    'Tags ',
    ' tags',
    'tags',
    'TAGS',
    'Tag',
    'Categories ',
    'author',
    '',
  ]) {
    assert.deepEqual(
      toPlain(onClickTag(namespace, value)),
      {action: 'search', keyword: value},
      `namespace ${JSON.stringify(namespace)}`,
    );
    assert.deepEqual(
      Object.keys(toPlain(onClickTag(namespace, value))),
      ['action', 'keyword'],
    );
  }
});

test('Picacg onClickTag never trims or re-cases the keyword', () => {
  const {source} = make();
  const onClickTag = source.comic.onClickTag;
  const value = '  Fate タグ MIXED  ';

  assert.equal(onClickTag('Tags', value).keyword, value);
  assert.equal(onClickTag('Author', value).keyword, value);
  assert.equal(onClickTag('Categories', value).keyword, value);
  assert.equal(onClickTag('Chinese Team', value).keyword, value);
});

test('Picacg config version and index.json entry stay in sync', () => {
  // The release gate (T058/T072) is satisfied, so the config now declares the
  // App version floor that carries the `tagSearch` action. These two places
  // must move together.
  const fs = require('node:fs');
  const path = require('node:path');
  const {source} = make();
  const index = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', '..', 'index.json'), 'utf8'),
  );
  const entry = Object.values(index).find(
    (candidate) => candidate && candidate.fileName === 'picacg.js',
  );
  assert.ok(entry, 'index.json must list picacg.js');

  assert.equal(entry.version, source.version);
  // 009 bumps the source version for the threshold-aware bounded exact Tag
  // scan; the file and the published catalog entry must move together.
  assert.equal(source.version, '1.0.10');
  assert.equal(
    source.minAppVersion,
    '2.0.0',
    'older Apps must be refused the unknown tagSearch action',
  );
});