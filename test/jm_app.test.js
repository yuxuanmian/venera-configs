const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const test = require('node:test');
const {loadSource, toPlain} = require('./scan/source_harness');

const origin = 'https://jm.example.invalid';
const chapterId = '987654';
const photo = name => `https://images.example.invalid/media/photos/${chapterId}/${name}`;

class Comic { constructor(fields) { Object.assign(this, fields); } }

function fixture(respond) {
    const calls = [];
    const request = async (method, url, headers, body) => {
        const call = {method, url: new URL(url), headers, body};
        calls.push(call);
        const result = await respond(call);
        if (result?.httpStatus) return {status: result.httpStatus, body: '{}'};
        return {status: 200, body: JSON.stringify({code: 200, data: JSON.stringify(result)})};
    };
    const {source} = loadSource('jm.js', 'JM', {
        data: {settings: {apiDomain: '1'}},
        globals: {
            Comic,
            Convert: {
                encodeUtf8: value => Buffer.from(value, 'utf8'),
                md5: value => createHash('md5').update(value).digest(),
                hexEncode: value => value.toString('hex'),
            },
            Network: {
                get: (url, headers) => request('GET', url, headers),
                post: (url, headers, body) => request('POST', url, headers, body),
            },
        },
    });
    source.overwriteApiDomains(['jm.example.invalid']);
    source.convertData = value => value;
    source.translate = value => value;
    return {source, calls};
}

function readForm(call) {
    const [, boundary] = call.headers['Content-Type'].match(/^multipart\/form-data; boundary=(.+)$/);
    return Object.fromEntries(call.body.split(`--${boundary}`).slice(1, -1).map(part => {
        const [, name, value] = part.match(/^\r\nContent-Disposition: form-data; name="(\w+)"\r\n\r\n([\s\S]*)\r\n$/);
        return [name, value];
    }));
}

test('JM posts multipart credentials and requires a successful login', async () => {
    let response = {uid: '1'};
    const {source, calls} = fixture(() => response);
    assert.equal(await source.account.login('test & 帳號', '+test%pass'), 'ok');
    assert.equal(source.loadData('uid'), '1');
    const [call] = calls;
    assert.equal(call.url.href, origin + '/login');
    assert.equal(call.headers.Origin, 'http://localhost');
    assert.match(call.headers.tokenparam, /^\d+,2\.1\.14$/);
    assert.deepEqual(readForm(call), {username: 'test & 帳號', password: '+test%pass'});
    response = {};
    await assert.rejects(source.account.login('test', 'invalid'), /Login failed/);
});

test('JM uses newest-first favorites and preserves remote listing order', async () => {
    let folderList = [{FID: '7', name: 'Custom'}];
    const {source, calls} = fixture(() => ({
        folder_list: folderList,
        total: 2,
        list: [{id: '100', name: 'Newest'}, {id: '200', name: 'Older'}].map(item => ({
            ...item, category: {}, category_sub: {},
        })),
    }));
    assert.deepEqual(toPlain(await source.favorites.loadFolders('100')), {
        folders: {'0': 'All', '7': 'Custom'},
    });
    const result = await source.favorites.loadCachePage(1, '0', null);
    assert.deepEqual(toPlain(result.comics.map(comic => comic.id)), ['100', '200']);
    await source.favorites.loadComics(1, '7');
    assert.deepEqual(calls.map(call => call.url.search), [
        '?page=1&o=mr&lang=TW', '?page=1&o=mr&lang=TW', '?page=1&folder_id=7&o=mr&lang=TW',
    ]);
    assert.ok(calls.every(call => call.headers['cache-time'] === 'no'));
    folderList = [];
    assert.deepEqual(toPlain(await source.favorites.loadFolders()), {folders: {'0': 'All'}});
    folderList = [{FID: {}, name: 'Invalid'}];
    await assert.rejects(source.favorites.loadFolders(), /Invalid favorite folder/);
});

test('JM verifies favorite toggles and repeated requests preserve the desired state', async () => {
    let isFavorite = false;
    let result;
    const {source, calls} = fixture(call => {
        if (call.url.pathname === '/album') return {is_favorite: isFavorite};
        isFavorite = !isFavorite;
        return result ?? {status: 'ok', type: isFavorite ? 'add' : 'remove'};
    });
    await source.favorites.addOrDelFavorite('jm100', '0', true);
    await source.favorites.addOrDelFavorite('100', '0', true);
    await source.favorites.addOrDelFavorite('100', '0', false);
    await source.favorites.addOrDelFavorite('100', '0', false);
    const posts = calls.filter(call => call.method === 'POST');
    assert.deepEqual(posts.map(readForm), [{aid: '100'}, {aid: '100'}]);
    assert.ok(posts.every(call => call.url.pathname === '/favorite'));
    assert.equal(calls[0].url.search, '?id=100&lang=TW');
    assert.equal(calls[0].headers['cache-time'], 'no');
    result = {status: 'ok', type: 'remove'};
    await assert.rejects(source.favorites.addOrDelFavorite('100', '0', true), /requested state/);
});

test('JM keeps placement for a new favorite and reports partial failure', async () => {
    let isFavorite = false;
    const {source, calls} = fixture(call => {
        if (call.url.pathname === '/album') return {is_favorite: isFavorite};
        if (call.url.pathname === '/favorite') {
            isFavorite = true;
            return {status: 'ok', type: 'add'};
        }
        return {status: 'error'};
    });
    await assert.rejects(source.favorites.addOrDelFavorite('100', '7', true), /added to All/);
    assert.equal(calls.at(-1).body, 'type=move&folder_id=7&aid=100');
    await assert.rejects(source.favorites.addOrDelFavorite('100', '7', true), /already favorited/);
    assert.equal(calls.filter(call => call.method === 'POST').length, 2);
});

test('JM does not run overlapping toggles for the same comic', async () => {
    let resolveState;
    const pending = new Promise(resolve => { resolveState = resolve; });
    const {source, calls} = fixture(call => call.method === 'GET'
        ? pending : {status: 'ok', type: 'add'});
    const first = source.favorites.addOrDelFavorite('100', '0', true);
    await assert.rejects(source.favorites.addOrDelFavorite('jm100', '0', true), /in progress/);
    resolveState({is_favorite: false});
    await first;
    assert.deepEqual(calls.map(call => call.method), ['GET', 'POST']);
});

test('JM reads full image URLs in page order and falls back when the route is unsupported', async () => {
    let current = {images: [{page: 2, image: photo('00002.webp?t=1700000000')},
        {page: 1, image: photo('00001.webp?t=1700000000')}]};
    const {source, calls} = fixture(call => call.url.pathname === '/chapter'
        ? {images: ['00003.jpg']} : current);
    assert.deepEqual(toPlain(await source.comic.loadEp('123', chapterId)), {
        images: [photo('00001.webp?t=1700000000'), photo('00002.webp?t=1700000000')],
    });
    assert.equal(calls[0].url.href, `${origin}/comic_read?id=${chapterId}&lang=TW`);
    current = {httpStatus: 404};
    const legacy = await source.comic.loadEp('123', chapterId);
    assert.equal(calls.at(-1).url.href, `${origin}/chapter?id=${chapterId}`);
    assert.ok(legacy.images[0].endsWith(`/media/photos/${chapterId}/00003.jpg`));
    current = {httpStatus: 403};
    await assert.rejects(source.comic.loadEp('123', chapterId), /403/);
    assert.equal(calls.at(-1).url.pathname, '/comic_read');
    current = {images: [{page: 1, image: {file: '00001.webp'}}]};
    await assert.rejects(source.comic.loadEp('123', chapterId), /Invalid chapter image list/);
});

test('JM uses the basename for scrambling and recognizes GIFs with query parameters', () => {
    const {source} = fixture(() => ({}));
    const load = name => source.comic.onImageLoad(photo(name), '123', chapterId);
    const expected = load('00001.webp').modifyImage;
    assert.match(expected, /const num = \d+/);
    assert.equal(load('00001.webp?t=1700000000#page').modifyImage, expected);
    assert.equal(load('00001.jpg?t=1700000000').modifyImage, expected);
    assert.equal(load('00001.GIF?t=1700000000').modifyImage, null);
});
