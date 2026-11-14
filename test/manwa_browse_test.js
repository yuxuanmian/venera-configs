const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const library = fs.readFileSync(path.join(root, '_venera_.js'), 'utf8');
const config = fs.readFileSync(path.join(root, 'manwa.js'), 'utf8');

function setup(respond) {
  const calls = [];
  const sandbox = {};
  vm.runInNewContext(`${library}\n${config}\nthis.source = new Manwa();\nthis.net = Network;\nthis.ui = UI;`, sandbox);
  sandbox.net.get = async (href, headers) => {
    const url = new URL(href);
    calls.push({url, headers});
    return respond(url);
  };
  return {source: sandbox.source, calls, network: sandbox.net, ui: sandbox.ui};
}

const json = (value, status = 200) => ({status, body: JSON.stringify(value)});

test('captcha login works without a JS validator and only posts nonblank input', async () => {
  const {source, network, ui} = setup(() => ({status: 200, body: ''}));
  const image = new ArrayBuffer(2);
  const submitted = [];
  let answer = null;
  network.fetchBytes = async () => ({status: 200, body: image});
  ui.showInputDialog = async (_title, validator, actualImage) => {
    assert.equal(validator, null);
    assert.equal(actualImage, image);
    return answer;
  };
  network.post = async (url, _headers, body) => {
    assert.equal(new URL(url).pathname, '/login');
    submitted.push(new URLSearchParams(body).get('captcha'));
    return json({err: 0});
  };

  await assert.rejects(source.account.login('test-user', 'test-password'), /已取消验证码输入/);
  answer = '  ';
  await assert.rejects(source.account.login('test-user', 'test-password'), /请输入验证码/);
  assert.deepEqual(submitted, []);
  answer = '  A1B2  ';
  assert.equal(await source.account.login('test-user', 'test-password'), 'ok');
  assert.deepEqual(submitted, ['A1B2']);
});

test('category uses one-based pages and preserves empty and negative defaults', async () => {
  const {source, calls} = setup(({pathname, searchParams}) => {
    assert.equal(pathname, '/getBooks');
    const books = searchParams.get('page') === '1' ? [
      {id: 81, book_name: '示例漫画', cover_url: '/static/cover.webp', last_chapter: '第 3 话', tags: '科幻，冒险,科幻'},
      {id: 82, book_name: '屏蔽作品', blocked: true},
      {id: 81, book_name: '重复的作品'},
    ] : [];
    return json({err: 0, books});
  });
  const first = await source.categoryComics.load('全部漫画', null, [], 1);
  assert.equal(first.maxPage, undefined);
  assert.equal(first.comics.length, 1);
  assert.equal(first.comics[0].id, '81');
  assert.equal(first.comics[0].cover, 'https://mwappimgs.cc/static/cover.webp');
  assert.deepEqual(Array.from(first.comics[0].tags), ['科幻', '冒险']);
  assert.deepEqual(Object.fromEntries(calls[0].url.searchParams), {
    page: '1', tag: '', end: '', gender: '-1', has_full: '', area: '', sort: '-1', level: '',
  });
  const end = await source.categoryComics.load('全部漫画', null, ['tag:%E5%86%92%E9%99%A9%2DA', 'sort:%2D1'], 2);
  assert.equal(end.maxPage, 2);
  assert.equal(end.comics.length, 0);
  assert.equal(calls[1].url.searchParams.get('tag'), '冒险-A');
  assert.equal(calls[1].url.searchParams.get('sort'), '-1');
  assert.equal(calls[1].headers['X-Requested-With'], 'XMLHttpRequest');
});

test('a malformed or failed category response is not treated as an empty page', async () => {
  const malformed = setup(() => json({err: 0, books: null}));
  await assert.rejects(malformed.source.categoryComics.load('全部漫画', null, [], 1), /分类漫画列表无效/);
  const failed = setup(() => json({}, 503));
  await assert.rejects(failed.source.categoryComics.load('全部漫画', null, [], 2), /HTTP 503/);
});

test('chapter and work comments use separate scopes and zero-based site pages', async () => {
  const work = {chapter_id: 0, content: '作品评论'};
  const chapter = {chapter_id: 701, content: '章节评论', nick_name: '示例读者', vote_like: 3, vote_dislike: 1};
  const {source, calls} = setup(() => json({err: 0, list: [work, chapter, {chapter_id: 702, content: '其他章节'}]}));
  const details = await source.comic.loadComments('81', null, 1, null);
  assert.equal(details.comments[0].content, work.content);
  assert.equal(calls[0].url.searchParams.get('chapter_id'), '');
  assert.equal(calls[0].url.searchParams.get('page'), '0');
  assert.equal(calls[0].headers.Referer, 'https://manwa.me/book/81');

  const result = await source.comic.loadChapterComments('81', '701', 2, null);
  assert.equal(result.comments.length, 1);
  assert.equal(result.comments[0].content, chapter.content);
  assert.equal(result.comments[0].score, 2);
  assert.equal(result.comments[0].replyCount, undefined);
  assert.equal(calls[1].url.pathname, '/commentmore');
  assert.deepEqual(Object.fromEntries(calls[1].url.searchParams), {
    chapter_id: '701', book_id: '81', comment_id: '0', sort: '1', page: '1',
  });
  assert.equal(calls[1].headers.Referer, 'https://manwa.me/chapter/701');

  await assert.rejects(source.comic.loadChapterComments('81', '', 1, null), /无效章节 ID/);
  assert.equal((await source.comic.loadChapterComments('81', '701', 1, '1')).comments.length, 0);
  assert.equal(calls.length, 2);
});
