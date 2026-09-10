const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {loadSource} = require('./source_harness');

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
