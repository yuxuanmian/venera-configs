const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const library = fs.readFileSync(path.join(root, '_venera_.js'), 'utf8');
const config = fs.readFileSync(path.join(root, 'manwa.js'), 'utf8');

function setup(respond, parseHtml, sendMessage) {
  const calls = [];
  const sandbox = {parseHtml, sendMessage};
  vm.runInNewContext(`${library}\n${config}\nthis.source = new Manwa();\nthis.net = Network;\nthis.ui = UI;`, sandbox);
  if (parseHtml) {
    vm.runInContext('HtmlDocument = class { constructor(body) { return parseHtml(body); } };', sandbox);
  }
  sandbox.net.get = async (href, headers) => {
    const url = new URL(href);
    calls.push({url, headers});
    return respond(url);
  };
  return {source: sandbox.source, calls, network: sandbox.net, ui: sandbox.ui};
}

const json = (value, status = 200) => ({status, body: JSON.stringify(value)});

function checkinHarness({state = new Map(), enabled = true, loggedIn = true, respond, classNames = ['star', 'signedin']} = {}) {
  const messages = [];
  const dates = [];
  const harness = setup(respond ?? (() => ({status: 200, body: 'welfare'})), (body) => ({
    querySelector: (selector) => {
      if (selector === '#form-login') return body === 'login' ? {} : null;
      dates.push(selector);
      return body === 'welfare' && classNames ? {classNames} : null;
    },
    dispose() {},
  }));
  Object.defineProperty(harness.source, 'isLogged', {get: () => loggedIn});
  harness.source.loadSetting = (key) => {
    assert.equal(key, 'autoCheckin');
    return enabled;
  };
  harness.source.loadData = (key) => state.get(key);
  harness.source.saveData = async (key, value) => state.set(key, value);
  harness.source.deleteData = (key) => state.delete(key);
  harness.network.deleteCookies = () => {};
  harness.ui.showMessage = (message) => messages.push(message);
  return {...harness, state, messages, dates};
}

test('automatic welfare checks are opt-in and run once per Beijing date across source reloads', async () => {
  const disabled = checkinHarness({enabled: false});
  const anonymous = checkinHarness({loggedIn: false});
  await disabled.source.init();
  await anonymous.source.init();
  assert.equal(disabled.calls.length, 0);
  assert.equal(anonymous.calls.length, 0);
  await anonymous.source.settings.checkinNow.callback();
  assert.deepEqual(anonymous.messages, ['请先登录漫蛙']);
  assert.equal(anonymous.calls.length, 0);

  const first = checkinHarness();
  const restarted = checkinHarness({state: first.state});
  const clock = mockClock(first.source, restarted.source);
  clock.value = Date.parse('2026-11-14T15:59:59Z');
  await first.source.init();
  await restarted.source.init();
  assert.equal(first.calls.length, 1);
  assert.equal(restarted.calls.length, 0);
  assert.equal(first.state.get('dailyWelfareVisitDate'), '2026-11-14');

  clock.value = Date.parse('2026-11-14T16:00:00Z');
  await restarted.source.init();
  assert.equal(restarted.calls.length, 1);
  assert.equal(restarted.state.get('dailyWelfareVisitDate'), '2026-11-15');
  assert.deepEqual(restarted.dates, ['.sign_row .star[data-test="2026-11-15"]']);
  restarted.source.account.logout();
  assert.equal(restarted.state.has('dailyWelfareVisitDate'), false);
});

function mockClock(...sources) {
  const clock = {value: 0};
  for (const source of sources) {
    const day = source.checkinDay;
    source.checkinDay = () => day(clock.value);
  }
  return clock;
}

test('manual welfare checks share an in-flight automatic request and can retry a failure', async () => {
  let settle;
  let requestCount = 0;
  const request = new Promise((resolve) => { settle = resolve; });
  const {source, calls, messages} = checkinHarness({respond: () => {
    requestCount += 1;
    return requestCount === 1 ? request : {status: 200, body: 'welfare'};
  }});
  assert.equal(source.settings.autoCheckin.default, false);
  const automatic = source.init();
  const manual = source.settings.checkinNow.callback();
  settle({status: 503, body: ''});
  await Promise.all([automatic, manual]);
  await source.init();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.pathname, '/users/welfare');
  assert.equal(calls[0].headers['Cache-Control'], 'no-cache');
  assert.deepEqual(messages, ['签到检查失败，请稍后手动重试']);
  await source.settings.checkinNow.callback();
  assert.equal(calls.length, 2);
  assert.equal(messages.at(-1), '今日已签到');
});

test('a successful welfare response does not imply that the account signed in', async () => {
  const unchecked = checkinHarness({classNames: ['star', 'signednot']});
  const missing = checkinHarness({classNames: null});
  const expired = checkinHarness({respond: () => ({status: 200, body: 'login'})});
  await unchecked.source.settings.checkinNow.callback();
  await missing.source.settings.checkinNow.callback();
  await expired.source.settings.checkinNow.callback();
  await unchecked.source.init();
  assert.equal(unchecked.calls.length, 1);
  assert.deepEqual(unchecked.messages, ['今日未确认签到']);
  assert.deepEqual(missing.messages, ['福利页未找到今日签到状态']);
  assert.deepEqual(expired.messages, ['漫蛙登录已失效，请重新登录']);
});

test('the first browse of a new day triggers the welfare request without delaying search', async () => {
  let finishWelfare;
  const welfare = new Promise((resolve) => { finishWelfare = resolve; });
  const {source, calls} = setup((url) => url.pathname === '/users/welfare'
    ? welfare : {status: 200, body: 'search'},
  (body) => body === 'search' ? searchDocument({ids: [101]}) : {
    querySelector: () => null,
    dispose() {},
  });
  Object.defineProperty(source, 'isLogged', {value: true});
  source.loadSetting = () => true;
  let lastDate;
  source.loadData = () => lastDate;
  source.saveData = async (_key, value) => { lastDate = value; };
  const result = await source.search.load('sample', [], 1);
  assert.equal(result.comics[0].id, '101');
  assert.deepEqual(calls.map(({url}) => url.pathname), ['/search', '/users/welfare']);
  finishWelfare({status: 200, body: 'welfare'});
  await source.checkinRequest;
  await source.search.load('sample', [], 1);
  assert.equal(calls.filter(({url}) => url.pathname === '/users/welfare').length, 1);
});

test('detail returns active chapter IDs from authenticated HTML and logs the counts', async () => {
  const chapterLinks = [
    {attributes: {href: '/chapter/701', class: 'chapteritem active', title: 'First'}},
    {attributes: {href: '/chapter/702', class: 'chapteritem inactive', title: 'Second'}},
    {attributes: {href: '/chapter/703', class: 'chapteritem', title: 'Third'}},
    {attributes: {href: '/chapter/703?copy=1', class: 'chapteritem active', title: 'Duplicate'}},
  ];
  const logged = [];
  const {source, calls} = setup(
    (url) => ({status: 200, body: `var my_user_id = '${url.pathname.endsWith('/81') ? '123' : ''}';`}),
    () => ({
      querySelector: (selector) => ({
        'h1.detail-main-info-title': {text: 'Sample'},
        '.detail-main-cover img': {attributes: {'data-original': '/static/cover.webp'}},
      })[selector] ?? null,
      querySelectorAll: (selector) => selector === 'a.chapteritem[href^="/chapter/"]' ? chapterLinks : [],
      dispose() {},
    }),
    (message) => logged.push(message),
  );
  source.maybeAutoCheckin = async () => {};

  const authenticated = await source.comic.loadInfo('81');
  const anonymous = await source.comic.loadInfo('82');
  assert.deepEqual(Object.fromEntries(authenticated.chapters), {'701': 'First', '702': 'Second', '703': 'Third'});
  assert.deepEqual([...authenticated.readChapterIds], ['701', '703']);
  assert.equal(anonymous.readChapterIds, undefined);
  assert.deepEqual(calls.map(({url}) => url.pathname), ['/book/81', '/book/82']);
  assert.deepEqual(logged.filter(({title}) => title === 'Manwa chapter read').map(({content}) => content), [
    'chapters=3 read=2 authenticated=true marker=chapteritem.active',
    'chapters=3 read=0 authenticated=false marker=chapteritem.active',
  ]);
});

// Stub the host DOM bridge using the captured search page structure.
function searchDocument({active, links = [], ids = [], hasList = true, hasSearchControls = false, brokenCards = false}) {
  const pager = active == null ? null : {
    querySelector: (selector) => selector === 'li.active > a' ? {text: String(active)} : null,
    querySelectorAll: (selector) => selector === 'a[data-page]' ? links.map(([text, page]) => ({
      text, attributes: {'data-page': String(page)},
    })) : [],
  };
  const cards = ids.map((id) => {
    const title = {
      text: `Sample ${id}`,
      attributes: brokenCards ? {} : {href: `/book/${id}`},
      querySelector: () => null,
    };
    return {
      attributes: {},
      querySelector: (selector) => selector === '.book-list-info-title' ? title : null,
      querySelectorAll: () => [],
    };
  });
  return {
    querySelector: (selector) => ({
      '.pagination2': pager,
      '.search-label-item, .search-history-content': hasSearchControls ? {} : null,
      '.book-list .book-list-info-title': cards[0] ?? null,
    })[selector] ?? null,
    querySelectorAll: (selector) => hasList && selector === '.book-list' ? [{children: cards}] : [],
    dispose() {},
  };
}

test('search requests each HTML page and stops at the last page, not the end of the visible page window', async () => {
  const {source, calls} = setup((url) => ({status: 200, body: url.searchParams.get('page')}), (body) => {
    const page = Number(body);
    const links = page === 5
      ? [['上一页', 4], ['4', 4], ['下一页', 6]]
      : page === 6 ? [['上一页', 5], ['5', 5]] : [['5', 5], ['下一页', page + 1]];
    return searchDocument({active: page, ids: [100 + page], links});
  });
  const first = await source.search.load(' 星空 & 雨 ', [], 1);
  const second = await source.search.load(' 星空 & 雨 ', [], 2);
  const windowEdge = await source.search.load(' 星空 & 雨 ', [], 5);
  const last = await source.search.load(' 星空 & 雨 ', [], 6);
  assert.deepEqual(calls.map(({url}) => [url.pathname, url.searchParams.get('keyword'), url.searchParams.get('page')]), [
    ['/search', '星空 & 雨', '1'], ['/search', '星空 & 雨', '2'],
    ['/search', '星空 & 雨', '5'], ['/search', '星空 & 雨', '6'],
  ]);
  assert.deepEqual([first, second, windowEdge, last].map(({comics}) => comics[0].id), ['101', '102', '105', '106']);
  assert.deepEqual([first.maxPage, second.maxPage, windowEdge.maxPage, last.maxPage], [undefined, undefined, undefined, 6]);
});

test('search distinguishes empty results from a repeated page and broken markup', async () => {
  const load = (fixture, page = 1) => setup(
    () => ({status: 200, body: ''}),
    () => searchDocument(fixture),
  ).source.search.load('sample', [], page);
  const empty = await load({hasList: false, hasSearchControls: true});
  assert.equal(empty.comics.length, 0);
  assert.equal(empty.maxPage, 1);
  assert.equal((await load({ids: [101]})).maxPage, 1);
  await assert.rejects(load({active: 1, ids: [101]}, 2), /搜索结果页码与请求不符/);
  await assert.rejects(load({active: 2, links: [['下一页', 2]], ids: [102]}, 2), /搜索下一页页码无效/);
  await assert.rejects(load({hasList: false}), /未找到搜索结果区域/);
  await assert.rejects(load({ids: [101], brokenCards: true}), /搜索结果列表无效/);
});

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

function rankingDocument() {
  const lists = new Map();
  for (const [type, id] of [['hot', 101], ['newest', 201], ['end', 301]]) {
    // In the dedicated ranking HTML, the link wraps the entire card.
    const fields = new Map([
      ['.rank-list-info-right-title', {attributes: {}, text: `示例作品 ${id}`, querySelector: () => null}],
      ['.rank-list-cover-img', {attributes: {'data-original': `/static/${id}.webp`, src: '/static/imagecover3.jpg'}}],
      ['.rank-list-info-right-subtitle', {text: '连载中'}],
      ['.rank-list-info-right-detail', {text: '示例简介'}],
    ]);
    const card = {attributes: {href: `/book/${id}`}, querySelector: (selector) => fields.get(selector)};
    lists.set(`.rank-list[data-type="${type}"]`, {children: [card]});
  }
  return {querySelector: (selector) => lists.get(selector), dispose() {}};
}

test('the shared ranking page displays the selected HTML list and defaults to popularity', async () => {
  const {source, calls} = setup(() => ({status: 200, body: 'ranking'}), rankingDocument);
  const ranking = source.categoryComics.ranking;
  assert.equal(source.category.enableRankingPage, true);
  assert.deepEqual(Array.from(source.category.parts[0].categories, ({label}) => label), ['全部漫画']);
  assert.deepEqual(Array.from(ranking.options), ['hot-人气榜', 'newest-新番榜', 'end-完结榜']);
  assert.equal(calls.length, 0);

  for (const [type, id] of [[undefined, '101'], ['newest', '201'], ['end', '301']]) {
    const result = await ranking.load(type, 1);
    assert.equal(result.maxPage, undefined);
    assert.deepEqual(Array.from(result.comics, ({id}) => id), [id]);
    const [comic] = result.comics;
    assert.equal(comic.title, `示例作品 ${id}`);
    assert.equal(comic.cover, `https://mwappimgs.cc/static/${id}.webp`);
    assert.equal(comic.subtitle, '连载中');
    assert.equal(comic.description, '示例简介');
  }
  assert.deepEqual(calls.map(({url}) => url.pathname + url.search), ['/rank', '/rank', '/rank']);
});

test('the source omits recommendations and still accepts legacy ranking targets', async () => {
  const {source, calls} = setup(() => ({status: 200, body: 'ranking'}), rankingDocument);
  assert.equal(source.explore, undefined);
  const category = '排行榜';
  const param = 'ranking';
  const [group] = await source.categoryComics.optionLoader(category, param);
  assert.deepEqual(Array.from(group.options), Array.from(source.categoryComics.ranking.options));
  const result = await source.categoryComics.load(category, param, ['end'], 1);
  assert.equal(result.comics[0].id, '301');
  assert.deepEqual(calls.map(({url}) => url.pathname), ['/rank']);
});

test('ranking uses the site scroll page numbers and stops at an empty page or the site limit', async () => {
  const book = {
    link: '/book/401', img_url: 'https://mwappimgs.cc/static/401.webp?v=12',
    book_name: ' 示例作品 ', description: '简介第一行\r\n第二行',
  };
  const {source, calls} = setup(({searchParams}) => json({
    data: searchParams.get('page') === '7' ? [] : [book, {...book, book_name: '重复条目'}],
  }));
  const load = source.categoryComics.ranking.load;
  const second = await load('hot', 2);
  const empty = await load('newest', 3);
  const last = await load('end', 16);
  const beyond = await load('end', 17);

  assert.deepEqual(calls.map(({url}) => url.pathname + url.search), [
    '/rank?type=hot&page=6', '/rank?type=newest&page=7', '/rank?type=end&page=20',
  ]);
  for (const {headers} of calls) {
    assert.equal(headers['X-Requested-With'], 'XMLHttpRequest');
    assert.equal(headers.Referer, 'https://manwa.me/rank');
  }
  assert.deepEqual(Array.from(second.comics, ({id}) => id), ['401']);
  assert.equal(second.comics[0].title, '示例作品');
  assert.equal(second.comics[0].cover, book.img_url);
  assert.equal(second.comics[0].description, book.description);
  assert.equal(second.maxPage, undefined);
  assert.equal(empty.comics.length, 0);
  assert.equal(empty.maxPage, 3);
  assert.equal(last.comics[0].id, '401');
  assert.equal(last.maxPage, 16);
  assert.equal(beyond.comics.length, 0);
  assert.equal(beyond.maxPage, 16);
});

test('ranking reports invalid HTML, JSON, and HTTP responses as errors', async () => {
  const load = (response, page = 2, parseHtml) => setup(() => response, parseHtml)
    .source.categoryComics.ranking.load('hot', page);
  await assert.rejects(load({status: 200, body: ''}, 1, () => ({
    querySelector: () => null,
    dispose() {},
  })), /未找到排行榜/);
  await assert.rejects(load(json({data: null})), /排行榜列表无效/);
  await assert.rejects(load(json({data: [{link: 'https://example.com/book/401', book_name: '示例作品'}]})), /排行榜条目无效/);
  await assert.rejects(load(json({}, 503)), /HTTP 503/);
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
