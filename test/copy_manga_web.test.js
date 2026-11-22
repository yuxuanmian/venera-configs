const assert = require("node:assert/strict");
const {createCipheriv, createDecipheriv} = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const script = fs.readFileSync(path.join(__dirname, "../copy_manga.js"), "utf8");
const origin = "https://www.mangacopy.com";
const comicUuid = "00000000-0000-4000-8000-000000000001";
const webForm = "application/x-www-form-urlencoded;charset=UTF-8";
const api = (results, code = 200) => ({status: 200, body: JSON.stringify({code, results})});
const html = body => ({status: 200, body});
const plain = value => JSON.parse(JSON.stringify(value));
const bytes = value => Uint8Array.from(value).buffer;

function harness(respond, {settings = {}, state = new Map(), documents = {}} = {}) {
    const calls = [];
    const cookies = new Map();
    const logs = [];
    function request(method, href, headers, body) {
        const call = {method, url: new URL(href), headers, body};
        calls.push(call);
        return respond(call, cookies);
    }
    const sandbox = {
        ComicSource: class {
            loadSetting(key) { return settings[key]; }
            loadData(key) { return state.get(key); }
            saveData(key, value) { state.set(key, value); }
            deleteData(key) { state.delete(key); }
        },
        HtmlDocument: class {
            constructor(body) { this.nodes = documents[body] ?? {}; }
            querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
            querySelectorAll(selector) { return this.nodes[selector] ?? []; }
        },
        Network: {
            get: async (url, headers) => request("GET", url, headers),
            post: async (url, headers, body) => request("POST", url, headers, body),
            getCookies: url => cookies.get(url) ?? [],
            setCookies: (url, value) => cookies.set(url, value),
            deleteCookies: url => cookies.delete(url),
        },
        Convert: {
            encodeUtf8: value => bytes(Buffer.from(value, "utf8")),
            decodeUtf8: value => Buffer.from(value).toString("utf8"),
            encodeBase64: value => Buffer.from(value).toString("base64"),
            decodeBase64: value => bytes(Buffer.from(value, "base64")),
            decryptAesCbc(value, key, iv) {
                const cipher = createDecipheriv("aes-128-cbc", Buffer.from(key), Buffer.from(iv));
                cipher.setAutoPadding(false);
                return bytes(Buffer.concat([cipher.update(Buffer.from(value)), cipher.final()]));
            },
        },
        randomInt: () => 1234,
        console: {log: message => logs.push(message)},
    };
    const source = vm.runInNewContext(script + "\nnew CopyManga();", sandbox);
    source.init();
    return {source, calls, cookies, state, logs};
}

test("login uses the captured form and preserves the server cookie through logout", async () => {
    const {source, calls, state, cookies} = harness((call, jar) => {
        if (call.url.pathname === "/web/login/") return html("login");
        if (call.url.pathname === "/api/kb/web/login") {
            jar.set(origin, [{name: "token", value: "server-cookie"}]);
            return api({token: "fixture-token"});
        }
        return api(null);
    });
    assert.equal(await source.account.login("a+b", "\u6d4b\u8bd5"), "ok");
    assert.equal(source.account.loginWithWebview.url, origin + "/web/login/");
    const [landing, login] = calls;
    assert.equal(landing.url.pathname, "/web/login/");
    assert.equal(login.method, "POST");
    assert.equal(login.headers.Origin, origin);
    assert.equal(login.headers.Referer, origin + "/web/login/loginByAccount");
    assert.equal(login.headers.platform, "2");
    assert.equal(login.headers["Content-Type"], "application/x-www-form-urlencoded; charset=UTF-8");
    assert.equal(login.headers.Authorization, undefined);
    const fields = new URLSearchParams(login.body);
    assert.equal(fields.get("username"), "a+b");
    assert.equal(Buffer.from(fields.get("password"), "base64").toString(), "\u6d4b\u8bd5-101234");
    assert.equal(fields.get("platform"), "2");
    assert.equal(fields.get("version"), "2025.12.10");
    assert.equal(fields.get("source"), "freeSite");
    assert.deepEqual(plain(state.get("web_session")), {origin, token: "fixture-token"});
    assert.equal(cookies.get(origin)[0].value, "server-cookie");

    await source.account.logout();
    const logout = calls.at(-1);
    assert.equal(logout.url.pathname, "/api/v1/logout");
    assert.equal(logout.headers.Authorization, "Token fixture-token");
    assert.equal(logout.headers["Content-Type"], webForm);
    assert.equal(logout.body, "");
    assert.equal(state.has("web_session"), false);
    assert.equal(cookies.has(origin), false);
});

test("login validates the business response before persisting a session", async () => {
    const {source, state, calls} = harness(call => call.method === "GET"
        ? html("login")
        : api({token: "fixture-token"}, 403));
    await assert.rejects(() => source.account.login("test", "test"), /Login: API 403/);
    assert.equal(state.has("web_session"), false);
    assert.equal(calls.length, 2);
});

test("search uses public headers and 12-item pages with an old saved preference", async () => {
    const state = new Map([["web_session", {origin, token: "fixture-token"}]]);
    const {source, calls} = harness(() => api({
        list: [{path_word: "work", name: "Work"}], total: 24, limit: 12, offset: 12,
    }), {state, settings: {search_api: "baseAPI"}});
    const page = await source.search.load("a + b", [""], 2);
    assert.equal(page.maxPage, 2);
    assert.equal(page.comics[0].id, "work");
    const [request] = calls;
    assert.equal(request.url.pathname, "/api/kb/web/searchcl/comics");
    assert.deepEqual(Object.fromEntries(request.url.searchParams), {
        offset: "12", platform: "2", limit: "12", q: "a + b", q_type: "",
    });
    assert.equal(request.headers.Referer, origin + "/search?q=a%20%2B%20b&q_type=");
    assert.equal(request.headers.Accept, "*/*");
    assert.equal(request.headers["Content-Type"], webForm);
    assert.equal(request.headers.Authorization, undefined);
    assert.equal(request.headers.platform, undefined);
    await assert.rejects(() => source.search.load("a + b", [""], 3), /invalid pagination/);
});

test("disabled nodes fall back to the verified host and only the overseas line is offered", async () => {
    const settings = {base_url: "www.copy20.com"};
    const {source, calls} = harness(call => {
        if (call.url.pathname === "/") return html("content-box");
        return api({list: [], total: 0, limit: 12, offset: 0});
    }, {settings});
    await source.search.load("work", [], 1);
    await source.runSpeedTest();
    assert.deepEqual(calls.map(call => call.url.origin), [origin, origin]);
    assert.equal(calls[0].url.pathname, "/api/kb/web/searchcl/comics");
    assert.deepEqual(plain(source.settings.base_url.options.map(option => option.value)), ["www.mangacopy.com"]);
    assert.deepEqual(plain(source.settings.region.options.map(option => option.value)), ["0"]);
});

test("favorites use the detail UUID and validate mutations and pagination", async () => {
    const settings = {favorites_ordering: "-datetime_browse"};
    const state = new Map([["web_session", {origin, token: "fixture-token"}]]);
    const documents = {detail: {
        ".comicParticulars-botton.collect": [{attributes: {onclick: "collect('" + comicUuid + "')"}}],
    }};
    const {source, calls} = harness(call => {
        if (call.url.pathname === "/comic/work") return html("detail");
        if (call.method === "POST") return api(null, call.body.endsWith("=0") ? 403 : 200);
        return api({list: [{comic: {path_word: "work", name: "Work"}}], total: 13, limit: 12, offset: 12});
    }, {settings, state, documents});
    assert.equal(await source.favorites.addOrDelFavorite("work", null, true), "ok");
    await assert.rejects(() => source.favorites.addOrDelFavorite("work", null, false), /Favorites: API 403/);
    for (const [i, call] of [calls[1], calls[3]].entries()) {
        assert.equal(call.url.pathname, "/api/v2/web/collect");
        assert.equal(call.headers.Origin, origin);
        assert.equal(call.headers.Referer, origin + "/comic/work");
        assert.equal(call.headers.Authorization, "Token fixture-token");
        assert.equal(call.headers["Content-Type"], webForm);
        assert.equal(call.headers.platform, undefined);
        assert.equal(call.body, "comic_id=" + comicUuid + "&is_collect=" + (1 - i));
    }
    const result = await source.favorites.loadComics(2, null);
    const shelf = calls.at(-1);
    assert.equal(shelf.url.pathname, "/api/v3/member/collect/comics");
    assert.equal(shelf.url.searchParams.get("ordering"), "-datetime_browse");
    assert.equal(shelf.headers.platform, "2");
    assert.equal(shelf.headers.Referer, origin + "/web/person/shujia");
    assert.equal(result.comics[0].id, "work");
    assert.equal(result.maxPage, 2);
    settings.base_url = "www.copy20.com";
    state.set("web_session", {origin: "https://www.copy20.com", token: "legacy-test-session"});
    await assert.rejects(() => source.favorites.loadComics(1, null), /Login expired/);
    assert.equal(calls.length, 5);
});

test("category and author routes paginate with offsets and parse quoted strings as data", async () => {
    const list = String.raw`[{'path_word':'work','name':'Reader\'s "choice"','author':[{'name':'Author'}]}]`;
    const documents = {listing: {
        ".exemptComicList .exemptComic-box": [{attributes: {list, total: "101"}}],
    }};
    const {source, calls} = harness(() => html("listing"), {documents});
    const category = await source.categoryComics.load(undefined, "maoxian", ["*all", "*datetime_updated"], 2);
    assert.equal(category.comics[0].title, 'Reader\'s "choice"');
    assert.equal(category.maxPage, 3);
    assert.equal(calls[0].url.searchParams.get("theme"), "maoxian");
    assert.equal(calls[0].url.searchParams.get("offset"), "50");
    assert.equal(calls[0].url.searchParams.get("limit"), "50");
    source.author_path_word_dict.Author = "author-id";
    const author = await source.search.load("\u4f5c\u8005:Author", [], 2);
    assert.equal(author.maxPage, 3);
    assert.equal(calls[1].url.pathname, "/author/author-id/comics");
    assert.equal(calls[1].url.search, "?offset=50&limit=50");
    assert.throws(() => source.parseEmbeddedList("[{'name': untrusted()}]"), /JSON/);
});

test("both author entry points join separate cover and title links by comic ID", async () => {
    function link(id, text, image) {
        return {
            attributes: {href: "/comic/" + id},
            text,
            querySelector: selector => selector === "img" && image ? {attributes: image} : null,
        };
    }
    const firstCover = "https://cover.example/first.jpg";
    const secondCover = "https://cover.example/second.jpg";
    const documents = {author: {
        '.correlationList a[href*="/comic/"]': [
            link("first", "", {"data-src": firstCover, src: "/static/loading.png"}),
            link("first", "First"),
            link("second", "Second"),
            link("second", "", {"data-src": secondCover}),
        ],
    }};
    const {source, calls} = harness(() => html("author"), {documents});
    source.author_path_word_dict.Author = "author-id";
    const bySearch = await source.search.load("author:Author", [], 1);
    const byCategory = await source.categoryComics.load("author:Author", "", [], 1);
    const expected = [
        {id: "first", title: "First", cover: firstCover},
        {id: "second", title: "Second", cover: secondCover},
    ];
    for (const page of [bySearch, byCategory]) {
        assert.deepEqual(plain(page.comics.map(({id, title, cover}) => ({id, title, cover}))), expected);
    }
    assert.deepEqual(calls.map(({url}) => url.pathname), ["/author/author-id/comics", "/author/author-id/comics"]);
});

test("detail separates authors from themes and uses shelf observations instead of default button text", async () => {
    const link = (href, text) => ({attributes: {href}, text});
    const author = link("/author/cq/comics", "Author");
    const genre = link("/comics?theme=sige", "# Four-panel");
    const start = link("/comic/work/chapter/first", "\u958b\u59cb\u95b1\u8b80");
    const shelfButton = {
        attributes: {onclick: "collect('" + comicUuid + "')"},
        text: "\u52a0\u5165\u66f8\u67b6",
    };
    const detail = {
        ".comicParticulars-title-right": [{querySelectorAll: () => [author, genre, start, shelfButton]}],
        '.comicParticulars-title-right a[href*="/author/"]': [author, author],
        ".comicParticulars-tag a": [genre, link("/comics?ordering=popular", "Sort")],
        '.comicParticulars-tag a[href*="/comics?"]': [genre, link("/comics?ordering=popular", "Sort")],
        ".comicParticulars-botton.collect": [shelfButton],
    };
    const state = new Map([["web_session", {origin, token: "fixture-token"}]]);
    const {source} = harness(call => {
        if (call.url.pathname.endsWith("/collect/comics")) {
            return api({list: [{comic: {path_word: "work", name: "Work"}}], total: 1, limit: 12, offset: 0});
        }
        if (call.method === "POST") return api(null);
        return html(call.url.pathname.endsWith("/marked") ? "marked-detail" : "detail");
    }, {state, documents: {
        detail,
        "marked-detail": {...detail, ".comicParticulars-botton.collect": [{...shelfButton, text: "\u5df2\u6536\u85cf"}]},
    }});

    const favorites = await source.favorites.loadComics(1, null);
    const work = await source.comic.loadInfo(favorites.comics[0].id);
    assert.equal(work.isFavorite, true);
    assert.deepEqual(plain(work.tags["\u4f5c\u8005"]), ["Author"]);
    assert.deepEqual(plain(work.tags["\u6807\u7b7e"]), ["Four-panel"]);
    assert.equal(source.author_path_word_dict.Author, "cq");
    assert.equal((await source.comic.loadInfo("unseen")).isFavorite, null);
    assert.equal((await source.comic.loadInfo("marked")).isFavorite, true);

    await source.favorites.addOrDelFavorite("work", null, false);
    await source.favorites.loadComics(1, null);
    assert.equal((await source.comic.loadInfo("work")).isFavorite, false);
    await source.favorites.addOrDelFavorite("work", null, true);
    assert.equal((await source.comic.loadInfo("work")).isFavorite, true);

    state.set("web_session", {origin, token: "another-fixture-session"});
    assert.equal((await source.comic.loadInfo("work")).isFavorite, null);
});

test("full favorite refresh reads exact totals with the configured sort and stops on pagination drift", async () => {
    const state = new Map([["web_session", {origin, token: "fixture-token"}]]);
    const {source, calls} = harness(call => {
        const offset = Number(call.url.searchParams.get("offset"));
        const total = 13;
        const length = Math.min(12, total - offset);
        const list = Array.from({length}, (_, index) => {
            const id = "work-" + (offset + index);
            return {comic: {path_word: id, name: id}};
        });
        return api({list, offset, total, limit: 12});
    }, {state, settings: {favorites_ordering: "-datetime_modifier"}});

    const first = await source.favorites.loadCachePage(1, "", null);
    const last = await source.favorites.loadCachePage(2, "", first.total);
    assert.equal(first.total, 13);
    assert.equal(first.maxPage, 2);
    assert.equal(first.comics.length, 12);
    assert.equal(last.total, 13);
    assert.equal(last.maxPage, 2);
    assert.deepEqual(plain(last.comics.map(comic => comic.id)), ["work-12"]);
    assert.deepEqual(calls.map(call => call.url.searchParams.get("offset")), ["0", "12"]);
    assert.deepEqual(calls.map(call => call.url.searchParams.get("ordering")), [
        "-datetime_modifier", "-datetime_modifier",
    ]);
    assert.deepEqual(plain(source.favorites.cacheSettings), ["favorites_ordering", "base_url"]);
    assert.equal(source.favorites.cacheAccountSetting, "base_url");
    await assert.rejects(() => source.favorites.loadCachePage(2, "", 14), /inconsistent cache page/);
});

test("full favorite refresh distinguishes an empty shelf from a truncated response", async () => {
    const state = new Map([["web_session", {origin, token: "fixture-token"}]]);
    let total = 0;
    const {source} = harness(() => api({list: [], offset: 0, limit: 12, total}), {state});
    assert.deepEqual(plain(await source.favorites.loadCachePage(1, "", null)), {
        comics: [], total: 0, maxPage: 0,
    });
    assert.equal((await source.favorites.loadComics(1, "")).maxPage, 1);
    total = 1;
    await assert.rejects(() => source.favorites.loadCachePage(1, "", null), /inconsistent cache page/);
});

function encrypted(value, format) {
    const iv = "0123456789abcdef";
    const cipher = createCipheriv("aes-128-cbc", Buffer.from("abcdefghijklmnop"), Buffer.from(iv));
    const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    return iv + data.toString(format);
}

test("padded directory and reader payloads decode through the host AES interface", async () => {
    const detail = "const ccz = 'abcdefghijklmnop';";
    const imageList = encrypted([{url: "//img.example/work/c800x.jpg"}], "base64");
    const reader = "const cct = 'abcdefghijklmnop'; const contentKey = '" + imageList + "';";
    const documents = {[detail]: {
        "#dnt": [{attributes: {value: "0"}}],
        ".comicParticulars-botton.collect": [{attributes: {onclick: "collect('" + comicUuid + "')"}}],
        'a[href*="/chapter/"]': [{attributes: {href: "/comic/work/chapter/html-fallback"}, text: "Fallback"}],
    }};
    const directory = {groups: {default: {name: "Main", chapters: [
        {id: "first", name: "First"}, {uuid: "second", name: "Second"},
    ]}}};
    const {source, calls, logs} = harness(call => {
        if (call.url.pathname === "/comic/work") return html(detail);
        if (call.url.pathname === "/comicdetail/work/chapters") return api(encrypted(directory, "hex"));
        return html(reader);
    }, {documents});
    const work = await source.comic.loadInfo("work");
    assert.equal(work.subId, comicUuid);
    assert.deepEqual(plain(work.chapters), {Main: {first: "First", second: "Second"}});
    assert.equal(calls[1].headers.Referer, origin + "/comic/work");
    assert.equal(calls[1].headers.dnts, "0");
    assert.equal(calls[1].headers.Accept, "*/*");
    assert.equal(calls[1].headers["Content-Type"], webForm);
    const episode = await source.comic.loadEp("work", "first");
    assert.deepEqual(plain(episode.images), ["https://img.example/work/c1500x.webp"]);
    assert.equal(calls[2].headers.Referer, origin + "/comic/work");
    assert.deepEqual(logs, []);
});
