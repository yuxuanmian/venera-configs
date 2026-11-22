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

test("search discovery is scoped to the selected node", async () => {
    const settings = {base_url: "www.copy20.com"};
    const {source, calls} = harness(call => {
        if (call.url.pathname === "/search") {
            return html('const countApi = "https://other.example/api/kb/web/searchx/comics";');
        }
        return api({list: [], total: 0, limit: 12, offset: 0});
    }, {settings});
    await source.search.load("work", [], 1);
    assert.deepEqual(calls.map(call => call.url.origin), [
        "https://www.copy20.com", "https://www.copy20.com",
    ]);
    assert.equal(calls[1].url.pathname, "/api/kb/web/searchcl/comics");
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
