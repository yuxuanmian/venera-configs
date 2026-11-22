class CopyManga extends ComicSource {

    name = "拷贝漫画"

    key = "copy_manga"

    version = "1.4.6"

    minAppVersion = "1.6.0"

    url = "https://cdn.jsdelivr.net/gh/venera-app/venera-configs@main/copy_manga.js"

    static defaultCopyRegion = "0"
    static defaultImageQuality = "1500"
    static defaultApiUrl = "www.mangacopy.com"
    static defaultSearchPath = "/api/kb/web/searchcl/comics"
    static listPageSize = 50
    static apiPageSize = 12
    static formContentType = "application/x-www-form-urlencoded;charset=UTF-8"

    author_path_word_dict = Object.create(null)
    searchPaths = new Map()
    pendingLogout = null
    favoriteEvidence = null

    get webHeaders() {
        return {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        }
    }

    get apiUrl() {
        const selected = this.loadSetting("base_url");
        const host = this.settings.base_url.options.some(option => option.value === selected)
            ? selected
            : CopyManga.defaultApiUrl;
        return "https://" + host;
    }

    get imageQuality() {
        return this.loadSetting("image_quality") || CopyManga.defaultImageQuality;
    }

    cookieToken(origin) {
        return Network.getCookies(origin).find(cookie => cookie.name === "token")?.value;
    }

    sessionToken(origin) {
        const session = this.loadData("web_session");
        if (session) {
            return session.origin === origin ? session.token : undefined;
        }
        // Older versions stored an unscoped token. Its matching cookie establishes the origin.
        const legacyToken = this.loadData("token");
        return legacyToken && this.cookieToken(origin) === legacyToken ? legacyToken : undefined;
    }

    saveSession(origin, token) {
        this.favoriteEvidence = null;
        this.saveData("web_session", {origin, token});
        this.deleteData("token");
    }

    favoriteObservations(origin, token) {
        if (!token || this.apiUrl !== origin || this.sessionToken(origin) !== token) return null;
        const now = Date.now();
        const evidence = this.favoriteEvidence;
        if (!evidence || evidence.origin !== origin || evidence.token !== token || evidence.expiresAt <= now) {
            // The host can show a remote page before it publishes the full collection.
            this.favoriteEvidence = {origin, token, expiresAt: now + 120000, items: new Map()};
        }
        return this.favoriteEvidence.items;
    }

    webApiHeaders(token) {
        return {
            ...this.webHeaders,
            "Accept": "application/json",
            "platform": "2",
            ...(token ? {"Authorization": "Token " + token} : {}),
        };
    }

    formHeaders(referer) {
        return {
            ...this.webHeaders,
            "Accept": "*/*",
            "Content-Type": CopyManga.formContentType,
            "Referer": referer,
        };
    }

    checkWebResponse(response, operation) {
        if (response.status === 401) {
            throw "Login expired";
        }
        if (response.status !== 200) {
            throw operation + ": HTTP " + response.status;
        }
        let data;
        try {
            data = JSON.parse(response.body);
        } catch {
            throw operation + ": invalid JSON response";
        }
        if (data?.code === 401) {
            throw "Login expired";
        }
        if (data?.code !== 200) {
            const code = Number.isInteger(data?.code) ? data.code : "unknown";
            throw operation + ": API " + code;
        }
        if (!Object.prototype.hasOwnProperty.call(data, "results")) {
            throw operation + ": missing results";
        }
        return data.results;
    }

    readApiPage(response, operation, offset) {
        const result = this.checkWebResponse(response, operation);
        const limit = CopyManga.apiPageSize;
        if (!Array.isArray(result?.list) || result.limit !== limit || result.offset !== offset ||
            !Number.isSafeInteger(result.total) || result.total < 0 || result.list.length > limit) {
            throw operation + ": invalid pagination";
        }
        return result;
    }

    parseApiPage(response, operation, offset) {
        const result = this.readApiPage(response, operation, offset);
        return {
            comics: result.list.map(item => this.parseComicSummary(item.comic ?? item)),
            maxPage: Math.max(1, Math.ceil(result.total / CopyManga.apiPageSize)),
            total: result.total,
        };
    }

    parseComicSummary(comic) {
        const author = comic.author?.[0];
        if (author?.name && author.path_word) {
            this.author_path_word_dict[author.name] = author.path_word;
        }
        return {
            id: comic.path_word,
            title: comic.name,
            subTitle: author?.name ?? null,
            cover: comic.cover,
            tags: (comic.theme ?? []).map(tag => tag.name),
            description: comic.datetime_updated,
        };
    }

    detailUrl(origin, comicId) {
        return origin + "/comic/" + encodeURIComponent(comicId);
    }

    comicUuid(doc) {
        const button = doc.querySelector(".comicParticulars-botton.collect");
        const handler = button?.attributes?.onclick ?? "";
        return handler.match(/\bcollect\s*\(\s*['"]([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})['"]/i)?.[1];
    }

    async getSearchPath(origin, referer) {
        const cached = this.searchPaths.get(origin);
        if (cached || origin === "https://" + CopyManga.defaultApiUrl) {
            return cached || CopyManga.defaultSearchPath;
        }
        const page = await Network.get(referer, this.webHeaders).catch(() => null);
        const path = page?.status === 200
            ? page.body.match(/\bconst\s+countApi\s*=\s*['"](\/api\/kb\/web\/[a-z0-9_-]+\/comics)['"]/i)?.[1]
            : undefined;
        if (path) {
            this.searchPaths.set(origin, path);
        }
        return path || CopyManga.defaultSearchPath;
    }

    parseEmbeddedList(raw) {
        // The page supplies single-quoted string literals inside an otherwise JSON-shaped array.
        const json = raw.replace(/"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'/g, value => {
            if (value[0] === '"') return value;
            const content = value.slice(1, -1).replace(/\\(?:x[0-9a-f]{2}|[\s\S])|"/gi, character => {
                if (character === "\\'") return "'";
                if (character === '"') return '\\"';
                if (/^\\x[0-9a-f]{2}$/i.test(character)) return "\\u00" + character.slice(2);
                return character;
            });
            return '"' + content + '"';
        });
        return JSON.parse(json);
    }

    authorPageUrl(pathWord, page) {
        const limit = CopyManga.listPageSize;
        return this.apiUrl + "/author/" + encodeURIComponent(pathWord) +
            "/comics?offset=" + (page - 1) * limit + "&limit=" + limit;
    }

    async loadAuthorComics(pathWord, page) {
        const url = this.authorPageUrl(pathWord, page);
        const response = await Network.get(url, this.webHeaders);
        if (response.status !== 200) throw "Invalid status code: " + response.status;
        const doc = new HtmlDocument(response.body);
        const list = doc.querySelector(".exemptComicList .exemptComic-box");
        const comics = new Map();
        if (list?.attributes?.list) {
            try {
                const items = this.parseEmbeddedList(list.attributes.list);
                if (Array.isArray(items)) {
                    for (const item of items) {
                        if (!item?.path_word || !item.name) continue;
                        comics.set(item.path_word, {
                            id: item.path_word,
                            title: item.name,
                            cover: item.cover || "",
                            tags: [],
                            subTitle: (item.author ?? []).map(author => author.name).filter(Boolean).join(", "),
                            description: item.datetime_updated || item.update_time || item.last_update_time || "",
                        });
                    }
                }
            } catch {
                // Older author pages can expose the list as rendered links.
            }
        }

        const hasEmbeddedList = comics.size > 0;
        let links = doc.querySelectorAll('.exemptComic-box a[href*="/comic/"]');
        if (!links.length) links = doc.querySelectorAll('.correlationList a[href*="/comic/"]');
        for (const link of links) {
            const id = link.attributes?.href?.match(/^(?:(?:https?:)?\/\/[^/]+)?\/comic\/([^/?#]+)\/?(?:[?#]|$)/)?.[1];
            if (!id || (hasEmbeddedList && !comics.has(id))) continue;
            const comic = comics.get(id) ?? {id, title: "", cover: "", tags: [], subTitle: "", description: ""};
            const title = link.attributes?.title || link.querySelector("[title]")?.attributes?.title ||
                link.querySelector(".edit-txt")?.text || link.querySelector(".twoLines")?.text || link.text;
            const image = link.querySelector("img")?.attributes;
            comic.title ||= title?.trim() || "";
            comic.cover ||= image?.["data-src"] || image?.src || "";
            comic.subTitle ||= (link.querySelector(".exemptComicItem-txt-span")?.text ||
                link.querySelector(".oneLines")?.text)?.trim() || "";
            comic.description ||= link.querySelector(".update span")?.text?.trim() || "";
            comics.set(id, comic);
        }

        return {
            comics: [...comics.values()].filter(comic => comic.title),
            maxPage: this.listPageCount(doc, parseInt(list?.attributes?.total) || 0, url),
        };
    }

    listPageCount(doc, total, pageUrl = this.apiUrl + "/comics") {
        const limit = CopyManga.listPageSize;
        if (total > 0) return Math.ceil(total / limit);
        const totalLabels = doc.querySelectorAll(".page-all .page-total");
        const pageCount = totalLabels[totalLabels.length - 1]?.text;
        let maxPage = parseInt(pageCount) || 1;
        const fullPath = pageUrl.split("?")[0];
        const path = fullPath.slice(this.apiUrl.length);
        for (const link of doc.querySelectorAll('a[href*="offset="][href*="limit="]')) {
            const href = link.attributes.href;
            if (!href.startsWith(path + "?") && !href.startsWith(fullPath + "?")) continue;
            const offset = href.match(/[?&]offset=(\d+)(?:&|$)/)?.[1];
            if (offset && Number.isSafeInteger(Number(offset)) &&
                href.match(/[?&]limit=(\d+)(?:&|$)/)?.[1] === String(limit)) {
                maxPage = Math.max(maxPage, Math.floor(Number(offset) / limit) + 1);
            }
        }
        return maxPage;
    }

    decryptWebPayload(value, key) {
        if (typeof value !== "string") throw "Invalid encrypted response";
        value = value.trim();
        if (value.length <= 16) throw "Invalid encrypted response";
        const iv = Convert.encodeUtf8(value.slice(0, 16));
        const keyBytes = Convert.encodeUtf8(key);
        const encoded = value.slice(16);
        let cipher;
        if (/^(?:[0-9a-f]{2})+$/i.test(encoded)) {
            cipher = Uint8Array.from(encoded.match(/../g), byte => parseInt(byte, 16)).buffer;
        } else {
            cipher = Convert.decodeBase64(encoded);
        }
        if (iv.byteLength !== 16 || ![16, 24, 32].includes(keyBytes.byteLength) ||
            !cipher.byteLength || cipher.byteLength % 16 !== 0) {
            throw "Invalid encrypted response";
        }
        const plaintext = new Uint8Array(Convert.decryptAesCbc(cipher, keyBytes, iv));
        const pad = plaintext[plaintext.length - 1];
        // The host decrypts whole blocks. Keep compatibility with payloads containing bare JSON.
        const bytes = pad >= 1 && pad <= 16 && plaintext.slice(-pad).every(byte => byte === pad)
            ? plaintext.slice(0, -pad)
            : plaintext;
        return Convert.decodeUtf8(bytes.buffer);
    }

    init() {
        this.account.loginWithWebview.url = this.apiUrl + "/web/login/";
    }

    account = {
        login: async (account, password) => {
            await this.pendingLogout;
            const origin = this.apiUrl;
            const loginPage = await Network.get(origin + "/web/login/", this.webHeaders);
            if (loginPage.status !== 200) throw "Login page: HTTP " + loginPage.status;

            const salt = 100000 + randomInt(0, 900000);
            const encoded = Convert.encodeBase64(Convert.encodeUtf8(password + "-" + salt));
            const body = [
                "username=" + encodeURIComponent(account),
                "password=" + encodeURIComponent(encoded),
                "salt=" + salt,
                "platform=2",
                "version=2025.12.10",
                "source=freeSite",
            ].join("&");
            const response = await Network.post(origin + "/api/kb/web/login", {
                ...this.webHeaders,
                "Accept": "application/json, text/plain, */*",
                "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                "Origin": origin,
                "Referer": origin + "/web/login/loginByAccount",
                "platform": "2",
            }, body);
            const result = this.checkWebResponse(response, "Login");
            if (typeof result?.token !== "string" || !/^[\x21-\x7e]+$/.test(result.token)) {
                throw "Login: missing session token";
            }
            // Use cookies set by the response. Older nodes can return the token only in JSON.
            if (!this.cookieToken(origin)) {
                Network.setCookies(origin, [{
                    name: "token", value: result.token, domain: origin.slice("https://".length),
                }]);
            }
            this.saveSession(origin, result.token);
            return "ok";
        },
        loginWithWebview: {
            url: "https://www.mangacopy.com/web/login/",
            checkStatus: url => {
                const origin = this.apiUrl;
                if (this.pendingLogout || !(url === origin || url.startsWith(origin + "/"))) return false;
                const token = this.cookieToken(origin);
                if (!token) return false;
                this.saveSession(origin, token);
                return true;
            },
        },
        logout: () => {
            if (this.pendingLogout) return this.pendingLogout;
            this.favoriteEvidence = null;
            const origin = this.loadData("web_session")?.origin || this.apiUrl;
            const allowed = this.settings.base_url.options.some(option => "https://" + option.value === origin);
            const token = allowed ? this.sessionToken(origin) : undefined;
            this.deleteData("web_session");
            this.deleteData("token");
            if (!token) {
                Network.deleteCookies(this.apiUrl);
                return;
            }
            const request = Network.post(origin + "/api/v1/logout", {
                ...this.formHeaders(origin + "/web/person/"),
                "Origin": origin,
                "Authorization": "Token " + token,
            }, "");
            this.pendingLogout = request
                .then(response => this.checkWebResponse(response, "Logout"))
                .catch(() => {})
                .finally(() => {
                    Network.deleteCookies(origin);
                    this.pendingLogout = null;
                });
            return this.pendingLogout;
        },
        registerWebsite: null
    }

    /// explore pages
    explore = [
        {
            title: "拷贝漫画",
            type: "singlePageWithMultiPart",
            load: async () => {
                let res = await Network.get(`${this.apiUrl}/`, this.webHeaders);
                if (res.status !== 200) {
                    throw `Invalid status code: ${res.status}`;
                }

                let html = res.body;
                let doc = new HtmlDocument(html);
                let result = {};

                function parseComicFromElement(item) {
                    let href = item.attributes['href'] || '';
                    if (!href.includes('/comic/')) return null;

                    let pathWord = href.replace('/comic/', '').replace('/', '');

                    let comicTitle = '';
                    let titleAttr = item.querySelector('[title]');
                    if (titleAttr && titleAttr.attributes) {
                        comicTitle = titleAttr.attributes['title'] || '';
                    }
                    if (!comicTitle) {
                        let titleEl2 = item.querySelector('.edit-txt');
                        comicTitle = titleEl2 && titleEl2.text ? titleEl2.text.trim() : '';
                    }
                    if (!comicTitle) {
                        let titleEl2 = item.querySelector('.twoLines');
                        comicTitle = titleEl2 && titleEl2.text ? titleEl2.text.trim() : '';
                    }
                    if (!comicTitle) {
                        comicTitle = item.text ? item.text.trim() : '';
                    }

                    let cover = '';
                    let img = item.querySelector('img');
                    if (img && img.attributes) {
                        cover = img.attributes['src'] || img.attributes['data-src'] || '';
                    }

                    let author = '';
                    let authorEl = item.querySelector('.exemptComicItem-txt-span');
                    if (!authorEl) authorEl = item.querySelector('.oneLines');
                    if (authorEl && authorEl.text) {
                        author = authorEl.text.trim();
                    }

                    let updateTime = '';
                    let updateEl = item.querySelector('.update span');
                    if (updateEl && updateEl.text) {
                        updateTime = updateEl.text.trim();
                    }

                    if (comicTitle && pathWord) {
                        return {
                            id: pathWord,
                            title: comicTitle,
                            subTitle: author,
                            cover: cover,
                            tags: [],
                            description: updateTime
                        };
                    }
                    return null;
                }

                function extractComics(selector, limit) {
                    let items = doc.querySelectorAll(selector);
                    let comics = [];
                    let seen = new Set();
                    for (let i = 0; i < items.length && comics.length < limit; i++) {
                        let comic = parseComicFromElement(items[i]);
                        if (comic && !seen.has(comic.id)) {
                            seen.add(comic.id);
                            comics.push(comic);
                        }
                    }
                    return comics;
                }

                let recommend = extractComics('.comicRank-box a[href*="/comic/"]', 20);
                if (recommend.length > 0) {
                    result["推荐"] = recommend;
                }

                let rows = doc.querySelectorAll('.content-box .row');
                if (rows.length > 0) {
                    let hotUpdate = [];
                    let seenHot = new Set();
                    let links = rows[0].querySelectorAll('a[href*="/comic/"]');
                    for (let i = 0; i < links.length && hotUpdate.length < 20; i++) {
                        let comic = parseComicFromElement(links[i]);
                        if (comic && !seenHot.has(comic.id)) {
                            seenHot.add(comic.id);
                            hotUpdate.push(comic);
                        }
                    }
                    if (hotUpdate.length > 0) {
                        result["热门更新"] = hotUpdate;
                    }
                }

                if (rows.length > 1) {
                    let newComics = [];
                    let seenNew = new Set();
                    let links = rows[1].querySelectorAll('a[href*="/comic/"]');
                    for (let i = 0; i < links.length && newComics.length < 20; i++) {
                        let comic = parseComicFromElement(links[i]);
                        if (comic && !seenNew.has(comic.id)) {
                            seenNew.add(comic.id);
                            newComics.push(comic);
                        }
                    }
                    if (newComics.length > 0) {
                        result["全新上架"] = newComics;
                    }
                }

                let allLinks = doc.querySelectorAll('a[href*="/comic/"]');
                let allComics = [];
                let seenAll = new Set();
                for (let i = 0; i < allLinks.length; i++) {
                    let comic = parseComicFromElement(allLinks[i]);
                    if (comic && !seenAll.has(comic.id)) {
                        seenAll.add(comic.id);
                        allComics.push(comic);
                    }
                }

                if (allComics.length > 0) {
                    let first20 = allComics.slice(0, 20);
                    let hasRecommend = result["推荐"] && result["推荐"].length > 0;
                    let hasHot = result["热门更新"] && result["热门更新"].length > 0;

                    if (!hasRecommend && !hasHot) {
                        result["首页推荐"] = first20;
                    } else {
                        let existingIds = new Set();
                        if (hasRecommend) result["推荐"].forEach(c => existingIds.add(c.id));
                        if (hasHot) result["热门更新"].forEach(c => existingIds.add(c.id));

                        let newComics = allComics.filter(c => !existingIds.has(c.id)).slice(0, 20);
                        if (newComics.length > 0) {
                            result["更多推荐"] = newComics;
                        }
                    }
                }

                return result;
            }
        }
    ]

    static category_param_dict = {
        "全部": "",
        "愛情": "aiqing",
        "歡樂向": "huanlexiang",
        "冒險": "maoxian",
        "奇幻": "qihuan",
        "百合": "baihe",
        "校园": "xiaoyuan",
        "科幻": "kehuan",
        "東方": "dongfang",
        "耽美": "danmei",
        "生活": "shenghuo",
        "格鬥": "gedou",
        "轻小说": "qingxiaoshuo",
        "悬疑": "xuanyi",
        "其他": "qita",
        "神鬼": "shengui",
        "职场": "zhichang",
        "TL": "teenslove",
        "萌系": "mengxi",
        "治愈": "zhiyu",
        "長條": "changtiao",
        "四格": "sige",
        "节操": "jiecao",
        "舰娘": "jianniang",
        "竞技": "jingji",
        "搞笑": "gaoxiao",
        "伪娘": "weiniang",
        "热血": "rexue",
        "励志": "lizhi",
        "性转换": "xingzhuanhuan",
        "彩色": "COLOR",
        "後宮": "hougong",
        "美食": "meishi",
        "侦探": "zhentan",
        "AA": "aa",
        "音乐舞蹈": "yinyuewudao",
        "魔幻": "mohuan",
        "战争": "zhanzheng",
        "历史": "lishi",
        "异世界": "yishijie",
        "惊悚": "jingsong",
        "机战": "jizhan",
        "都市": "dushi",
        "穿越": "chuanyue",
        "恐怖": "kongbu",
        "C100": "comiket100",
        "重生": "chongsheng",
        "C99": "comiket99",
        "C101": "comiket101",
        "C97": "comiket97",
        "C96": "comiket96",
        "生存": "shengcun",
        "宅系": "zhaixi",
        "武侠": "wuxia",
        "C98": "C98",
        "C95": "comiket95",
        "FATE": "fate",
        "转生": "zhuansheng",
        "無修正": "Uncensored",
        "仙侠": "xianxia",
        "LoveLive": "loveLive"
    }

    category = {
        title: "拷贝漫画",
        parts: [
            {
                name: "拷贝漫画",
                type: "fixed",
                categories: ["排行"],
                categoryParams: ["ranking"],
                itemType: "category"
            },
            {
                name: "主题",
                type: "fixed",
                categories: Object.keys(CopyManga.category_param_dict),
                categoryParams: Object.values(CopyManga.category_param_dict),
                itemType: "category"
            }
        ]
    }

    categoryComics = {
        load: async (category, param, options, page) => {
            if (category?.startsWith("author:")) {
                let authorName = category.substring("author:".length);
                let pathWord = this.author_path_word_dict[authorName] || null;

                if (!pathWord) {
                    try {
                        let searchHtmlRes = await Network.get(
                            `${this.apiUrl}/search?q=${encodeURIComponent(authorName)}`,
                            this.webHeaders
                        );
                        if (searchHtmlRes.status === 200) {
                            let searchDoc = new HtmlDocument(searchHtmlRes.body);
                            let authorLinks = searchDoc.querySelectorAll('a[href*="/author/"]');
                            for (let i = 0; i < authorLinks.length; i++) {
                                let link = authorLinks[i];
                                let href = link.attributes['href'] || '';
                                let match = href.match(/\/author\/([^\/]+)/);
                                if (match && match[1]) {
                                    let name = link.text ? link.text.trim() : '';
                                    if (name) {
                                        this.author_path_word_dict[name] = match[1];
                                    }
                                    if (!pathWord && name === authorName) {
                                        pathWord = match[1];
                                    }
                                    if (!pathWord) {
                                        pathWord = match[1];
                                    }
                                }
                            }
                        }
                    } catch (e) {
                    }
                }

                if (!pathWord) {
                    throw `无法找到作者: ${authorName}`;
                }

                return this.loadAuthorComics(pathWord, page);
            }

            let category_url;
            let isRanking = category === "排行" || param === "ranking";

            if (isRanking) {
                let typeParam = options[0] || "male";
                let tableParam = options[1] || "week";
                category_url = `${this.apiUrl}/rank?type=${typeParam}&table=${tableParam}`;
            } else {
                if (category !== undefined && category !== null) {
                    param = CopyManga.category_param_dict[category] || "";
                }
                let filterParam = options[0] || "";
                let orderingRaw = options[1] || "*datetime_updated";
                let orderingParam = orderingRaw.replace("*", "-");

                let baseUrl = `${this.apiUrl}/comics?theme=${param}`;
                if (filterParam && filterParam !== "*all") {
                    let value = filterParam.replace("*", "");
                    if (value === "finish") {
                        baseUrl += `&status=1`;
                    } else {
                        baseUrl += `&region=${value}`;
                    }
                }
                baseUrl += `&ordering=${orderingParam}&limit=${CopyManga.listPageSize}&offset=${(page - 1) * CopyManga.listPageSize}`;
                category_url = baseUrl;
            }

            let res = await Network.get(category_url, this.webHeaders);
            if (res.status !== 200) {
                throw `Invalid status code: ${res.status}`;
            }

            let html = res.body;
            let doc = new HtmlDocument(html);
            let comics = [];
            let totalFromList = 0;

            if (isRanking) {
                let items = doc.querySelectorAll('.ranking-all-box');
                for (let i = 0; i < items.length; i++) {
                    let item = items[i];
                    let anchor = item.querySelector('a[href*="/comic/"]');
                    if (!anchor) continue;

                    let href = anchor.attributes['href'] || '';
                    let pathWord = href.replace('/comic/', '').replace('/', '');

                    let titleEl = item.querySelector('.threeLines');
                    let title = '';
                    if (titleEl) {
                        title = titleEl.attributes['title'] || '';
                        if (!title && titleEl.text) title = titleEl.text.trim();
                    }

                    let img = item.querySelector('img');
                    let cover = '';
                    if (img && img.attributes) {
                        cover = img.attributes['src'] || img.attributes['data-src'] || '';
                    }

                    let authorEl = item.querySelector('.oneLines');
                    let author = authorEl && authorEl.text ? authorEl.text.replace(/\s+/g, ' ').trim() : '';

                    let rankEl = item.querySelector('.ranking-all-icon');
                    let rank = rankEl && rankEl.text ? rankEl.text.trim() : '';

                    let heatEl = item.querySelector('.update span');
                    let heat = heatEl && heatEl.text ? heatEl.text.trim() : '';

                    let trend = '';
                    let trendEl = item.querySelector('.update-icon.up');
                    if (trendEl) trend = '▲';
                    else {
                        trendEl = item.querySelector('.update-icon.end');
                        if (trendEl) trend = '▽';
                    }

                    if (title && pathWord) {
                        comics.push({
                            id: pathWord,
                            title: title,
                            subTitle: author,
                            cover: cover,
                            tags: [],
                            description: `${rank} ${trend}\n${author}\n🔥${heat}`
                        });
                    }
                }
            } else {
                let listBox = doc.querySelector('.exemptComicList .exemptComic-box');
                if (listBox && listBox.attributes) {
                    if (listBox.attributes['total']) {
                        totalFromList = parseInt(listBox.attributes['total']) || 0;
                    }
                    if (listBox.attributes['list']) {
                        try {
                            let rawList = listBox.attributes['list'];
                            const decoded = this.parseEmbeddedList(rawList);
                            if (Array.isArray(decoded)) {
                                for (let item of decoded) {
                                    let pathWord = item.path_word || '';
                                    let title = item.name || '';
                                    if (pathWord && title) {
                                        let authors = item.author || [];
                                        let authorNames = authors.map(a => a.name).filter(n => n);
                                        let author = authorNames.length > 0 ? authorNames.join(', ') : '';
                                        let cover = item.cover || '';
                                        let updateDate = item.datetime_updated || item.update_time || item.last_update_time || '';
                                        comics.push({
                                            id: pathWord,
                                            title: title,
                                            subTitle: author,
                                            cover: cover,
                                            tags: [],
                                            description: updateDate
                                        });
                                    }
                                }
                            }
                        } catch (e) {
                        }
                    }
                }

                if (comics.length === 0) {
                    let items = doc.querySelectorAll('.exemptComic-box a[href*="/comic/"]');
                    if (items.length === 0) {
                        items = doc.querySelectorAll('.correlationList a[href*="/comic/"]');
                    }
                    for (let i = 0; i < items.length; i++) {
                        let item = items[i];
                        let href = item.attributes['href'] || '';
                        let pathWord = href.replace('/comic/', '').replace('/', '');

                        let title = '';
                        let titleEl = item.querySelector('[title]');
                        if (titleEl && titleEl.attributes) {
                            title = titleEl.attributes['title'] || '';
                        }
                        if (!title) {
                            titleEl = item.querySelector('.edit-txt');
                            title = titleEl && titleEl.text ? titleEl.text.trim() : '';
                        }
                        if (!title) {
                            titleEl = item.querySelector('.twoLines');
                            title = titleEl && titleEl.text ? titleEl.text.trim() : '';
                        }
                        if (!title) {
                            title = item.text ? item.text.trim() : '';
                        }

                        let img = item.querySelector('img');
                        let cover = '';
                        if (img && img.attributes) {
                            cover = img.attributes['src'] || img.attributes['data-src'] || '';
                        }

                        let authorEl = item.querySelector('.exemptComicItem-txt-span');
                        if (!authorEl) authorEl = item.querySelector('.oneLines');
                        let author = authorEl && authorEl.text ? authorEl.text.trim() : '';

                        let updateEl = item.querySelector('.update span');
                        let updateTime = updateEl && updateEl.text ? updateEl.text.trim() : '';

                        if (title && pathWord) {
                            comics.push({
                                id: pathWord,
                                title: title,
                                subTitle: author,
                                cover: cover,
                                tags: [],
                                description: updateTime
                            });
                        }
                    }
                }
            }

            let maxPage = this.listPageCount(doc, totalFromList);
            return {
                comics: comics,
                maxPage: maxPage
            };
        },
        optionList: [
            {
                options: [
                    "*all-全部",
                    "0-日漫",
                    "1-韩漫",
                    "2-美漫",
                    "finish-已完结"
                ],
                notShowWhen: null,
                showWhen: Object.keys(CopyManga.category_param_dict)
            },
            {
                options: [
                    "*datetime_updated-时间倒序",
                    "datetime_updated-时间正序",
                    "*popular-热度倒序",
                    "popular-热度正序",
                ],
                notShowWhen: null,
                showWhen: Object.keys(CopyManga.category_param_dict)
            },
            {
                options: [
                    "male-男频",
                    "female-女频"
                ],
                notShowWhen: null,
                showWhen: ["排行"]
            },
            {
                options: [
                    "day-上升最快",
                    "week-最近7天",
                    "month-最近30天",
                    "total-總榜單"
                ],
                notShowWhen: null,
                showWhen: ["排行"]
            }
        ]
    }

    search = {
        load: async (keyword, options, page) => {
            let tagTheme = CopyManga.category_param_dict[keyword] || "";
            if (!tagTheme && keyword.startsWith("tag:")) {
                let tagName = keyword.substring("tag:".length).trim();
                tagTheme = CopyManga.category_param_dict[tagName] || "";
            }
            if (tagTheme) {
                let filterParam = options && options[0] ? options[0] : "";
                let orderingRaw = options && options[1] ? options[1] : "*datetime_updated";
                let orderingParam = orderingRaw.replace("*", "-");

                let baseUrl = `${this.apiUrl}/comics?theme=${tagTheme}`;
                if (filterParam && filterParam !== "*all") {
                    let value = filterParam.replace("*", "");
                    if (value === "finish") {
                        baseUrl += `&status=1`;
                    } else {
                        baseUrl += `&region=${value}`;
                    }
                }
                baseUrl += `&ordering=${orderingParam}&limit=${CopyManga.listPageSize}&offset=${(page - 1) * CopyManga.listPageSize}`;

                let res = await Network.get(baseUrl, this.webHeaders);
                if (res.status !== 200) {
                    throw `Invalid status code: ${res.status}`;
                }

                let html = res.body;
                let doc = new HtmlDocument(html);
                let comics = [];
                let totalFromList = 0;

                let listBox = doc.querySelector('.exemptComicList .exemptComic-box');
                if (listBox && listBox.attributes) {
                    if (listBox.attributes['total']) {
                        totalFromList = parseInt(listBox.attributes['total']) || 0;
                    }
                    if (listBox.attributes['list']) {
                        try {
                            let rawList = listBox.attributes['list'];
                            const decoded = this.parseEmbeddedList(rawList);
                            if (Array.isArray(decoded)) {
                                for (let item of decoded) {
                                    let pw = item.path_word || '';
                                    let title = item.name || '';
                                    if (pw && title) {
                                        let authors = item.author || [];
                                        let authorNames = authors.map(a => a.name).filter(n => n);
                                        comics.push({
                                            id: pw,
                                            title: title,
                                            subTitle: authorNames.length > 0 ? authorNames.join(', ') : '',
                                            cover: item.cover || '',
                                            tags: [],
                                            description: item.datetime_updated || item.update_time || item.last_update_time || ''
                                        });
                                    }
                                }
                            }
                        } catch (e) {
                        }
                    }
                }

                if (comics.length === 0) {
                    let items = doc.querySelectorAll('.exemptComic-box a[href*="/comic/"]');
                    if (items.length === 0) {
                        items = doc.querySelectorAll('.correlationList a[href*="/comic/"]');
                    }
                    for (let i = 0; i < items.length; i++) {
                        let item = items[i];
                        let href = item.attributes['href'] || '';
                        let pw = href.replace('/comic/', '').replace('/', '');

                        let title = '';
                        let titleEl = item.querySelector('[title]');
                        if (titleEl && titleEl.attributes) {
                            title = titleEl.attributes['title'] || '';
                        }
                        if (!title) {
                            titleEl = item.querySelector('.edit-txt');
                            title = titleEl && titleEl.text ? titleEl.text.trim() : '';
                        }
                        if (!title) {
                            titleEl = item.querySelector('.twoLines');
                            title = titleEl && titleEl.text ? titleEl.text.trim() : '';
                        }
                        if (!title) {
                            title = item.text ? item.text.trim() : '';
                        }

                        let img = item.querySelector('img');
                        let cover = '';
                        if (img && img.attributes) {
                            cover = img.attributes['src'] || img.attributes['data-src'] || '';
                        }

                        let authorEl = item.querySelector('.exemptComicItem-txt-span');
                        if (!authorEl) authorEl = item.querySelector('.oneLines');
                        let an = authorEl && authorEl.text ? authorEl.text.trim() : '';

                        let updateEl = item.querySelector('.update span');
                        let updateTime = updateEl && updateEl.text ? updateEl.text.trim() : '';

                        if (title && pw) {
                            comics.push({
                                id: pw,
                                title: title,
                                subTitle: an,
                                cover: cover,
                                tags: [],
                                description: updateTime
                            });
                        }
                    }
                }

                let maxPage = this.listPageCount(doc, totalFromList);
                return {
                    comics: comics,
                    maxPage: maxPage
                };
            }

            if (keyword.startsWith("tag:")) {
                let tagName = keyword.substring("tag:".length).trim();
                let themeParam = CopyManga.category_param_dict[tagName] || "";

                if (!themeParam) {
                    try {
                        let searchHtmlRes = await Network.get(
                            `${this.apiUrl}/search?q=${encodeURIComponent(tagName)}`,
                            this.webHeaders
                        );
                        if (searchHtmlRes.status === 200) {
                            let searchDoc = new HtmlDocument(searchHtmlRes.body);
                            let tagLinks = searchDoc.querySelectorAll('.comicParticulars-tag a, a[href*="/comics?theme="]');
                            for (let i = 0; i < tagLinks.length; i++) {
                                let link = tagLinks[i];
                                let href = link.attributes['href'] || '';
                                let themeMatch = href.match(/theme=([^&]+)/);
                                if (themeMatch && themeMatch[1]) {
                                    let name = link.text ? link.text.trim().replace(/^#/, '') : '';
                                    if (name) {
                                        CopyManga.category_param_dict[name] = themeMatch[1];
                                    }
                                    if (!themeParam && name === tagName) {
                                        themeParam = themeMatch[1];
                                    }
                                    if (!themeParam) {
                                        themeParam = themeMatch[1];
                                    }
                                }
                            }
                        }
                    } catch (e) {
                    }
                }

                if (themeParam) {
                    CopyManga.category_param_dict[tagName] = themeParam;
                    let filterParam = options && options[0] ? options[0] : "";
                    let orderingRaw = options && options[1] ? options[1] : "*datetime_updated";
                    let orderingParam = orderingRaw.replace("*", "-");

                    let baseUrl = `${this.apiUrl}/comics?theme=${themeParam}`;
                    if (filterParam && filterParam !== "*all") {
                        let value = filterParam.replace("*", "");
                        if (value === "finish") {
                            baseUrl += `&status=1`;
                        } else {
                            baseUrl += `&region=${value}`;
                        }
                    }
                    baseUrl += `&ordering=${orderingParam}&limit=${CopyManga.listPageSize}&offset=${(page - 1) * CopyManga.listPageSize}`;

                    let res = await Network.get(baseUrl, this.webHeaders);
                    if (res.status !== 200) {
                        throw `Invalid status code: ${res.status}`;
                    }

                    let html = res.body;
                    let doc = new HtmlDocument(html);
                    let comics = [];
                    let totalFromList = 0;

                    let listBox = doc.querySelector('.exemptComicList .exemptComic-box');
                    if (listBox && listBox.attributes) {
                        if (listBox.attributes['total']) {
                            totalFromList = parseInt(listBox.attributes['total']) || 0;
                        }
                        if (listBox.attributes['list']) {
                            try {
                                let rawList = listBox.attributes['list'];
                                const decoded = this.parseEmbeddedList(rawList);
                                if (Array.isArray(decoded)) {
                                    for (let item of decoded) {
                                        let pw = item.path_word || '';
                                        let title = item.name || '';
                                        if (pw && title) {
                                            let authors = item.author || [];
                                            let authorNames = authors.map(a => a.name).filter(n => n);
                                            comics.push({
                                                id: pw,
                                                title: title,
                                                subTitle: authorNames.length > 0 ? authorNames.join(', ') : '',
                                                cover: item.cover || '',
                                                tags: [],
                                                description: item.datetime_updated || item.update_time || item.last_update_time || ''
                                            });
                                        }
                                    }
                                }
                            } catch (e) {
                            }
                        }
                    }

                    if (comics.length === 0) {
                        let items = doc.querySelectorAll('.exemptComic-box a[href*="/comic/"]');
                        if (items.length === 0) {
                            items = doc.querySelectorAll('.correlationList a[href*="/comic/"]');
                        }
                        for (let i = 0; i < items.length; i++) {
                            let item = items[i];
                            let href = item.attributes['href'] || '';
                            let pw = href.replace('/comic/', '').replace('/', '');

                            let title = '';
                            let titleEl = item.querySelector('[title]');
                            if (titleEl && titleEl.attributes) {
                                title = titleEl.attributes['title'] || '';
                            }
                            if (!title) {
                                titleEl = item.querySelector('.edit-txt');
                                title = titleEl && titleEl.text ? titleEl.text.trim() : '';
                            }
                            if (!title) {
                                titleEl = item.querySelector('.twoLines');
                                title = titleEl && titleEl.text ? titleEl.text.trim() : '';
                            }
                            if (!title) {
                                title = item.text ? item.text.trim() : '';
                            }

                            let img = item.querySelector('img');
                            let cover = '';
                            if (img && img.attributes) {
                                cover = img.attributes['src'] || img.attributes['data-src'] || '';
                            }

                            let authorEl = item.querySelector('.exemptComicItem-txt-span');
                            if (!authorEl) authorEl = item.querySelector('.oneLines');
                            let an = authorEl && authorEl.text ? authorEl.text.trim() : '';

                            let updateEl = item.querySelector('.update span');
                            let updateTime = updateEl && updateEl.text ? updateEl.text.trim() : '';

                            if (title && pw) {
                                comics.push({
                                    id: pw,
                                    title: title,
                                    subTitle: an,
                                    cover: cover,
                                    tags: [],
                                    description: updateTime
                                });
                            }
                        }
                    }

                    let maxPage = this.listPageCount(doc, totalFromList);
                    return {
                        comics: comics,
                        maxPage: maxPage
                    };
                }
            }

            const explicitAuthor = /^(?:author|\u4f5c\u8005):(.+)$/i.exec(keyword)?.[1].trim();
            const pathWord = explicitAuthor ? this.author_path_word_dict[explicitAuthor] : undefined;
            if (pathWord) {
                return this.loadAuthorComics(pathWord, page);
            }

            const origin = this.apiUrl;
            const type = explicitAuthor ? "author" : options?.[0] || "";
            const query = "q=" + encodeURIComponent(explicitAuthor || keyword) + "&q_type=" + encodeURIComponent(type);
            const referer = origin + "/search?" + query;
            const path = await this.getSearchPath(origin, referer);
            const limit = CopyManga.apiPageSize;
            const offset = (page - 1) * limit;
            const response = await Network.get(
                origin + path + "?offset=" + offset + "&platform=2&limit=" + limit + "&" + query,
                this.formHeaders(referer),
            );
            return this.parseApiPage(response, "Search", offset);
        },
        optionList: [
            {
                type: "select",
                options: [
                    "-全部",
                    "name-名称",
                    "author-作者",
                    "local-汉化组"
                ],
                label: "搜索选项"
            }
        ]
    }

    favoritePageRequest(origin, token, offset, ordering) {
        return {
            method: "GET",
            url: origin + "/api/v3/member/collect/comics?limit=" + CopyManga.apiPageSize + "&offset=" + offset +
                "&free_type=1&ordering=" + encodeURIComponent(ordering),
            headers: {...this.webApiHeaders(token), "Referer": origin + "/web/person/shujia"},
        };
    }

    favorites = {
        multiFolder: false,
        cacheSettings: ["favorites_ordering", "base_url"],
        cacheAccountSetting: "base_url",
        addOrDelFavorite: async (comicId, folderId, isAdding) => {
            const origin = this.apiUrl;
            const token = this.sessionToken(origin);
            if (!token) throw "Login expired";
            const referer = this.detailUrl(origin, comicId);
            const page = await Network.get(referer, this.webHeaders);
            if (page.status !== 200) throw "Comic detail: HTTP " + page.status;
            const uuid = this.comicUuid(new HtmlDocument(page.body));
            if (!uuid) throw "Comic detail: missing comic UUID";
            const response = await Network.post(origin + "/api/v2/web/collect", {
                ...this.formHeaders(referer),
                "Origin": origin,
                "Authorization": "Token " + token,
            }, "comic_id=" + encodeURIComponent(uuid) + "&is_collect=" + (isAdding ? 1 : 0));
            this.checkWebResponse(response, "Favorites");
            this.favoriteObservations(origin, token)?.set(comicId, isAdding);
            return "ok";
        },
        loadComics: async (page, folder) => {
            const origin = this.apiUrl;
            const token = this.sessionToken(origin);
            if (!token) throw "Login expired";
            const ordering = this.loadSetting("favorites_ordering") || "-datetime_updated";
            const offset = (page - 1) * CopyManga.apiPageSize;
            const {url, headers} = this.favoritePageRequest(origin, token, offset, ordering);
            const response = await Network.get(url, headers);
            const result = this.parseApiPage(response, "Favorites", offset);
            const observations = this.favoriteObservations(origin, token);
            if (observations) {
                for (const comic of result.comics) {
                    if (observations.get(comic.id) !== false) observations.set(comic.id, true);
                }
            }
            return result;
        },
        loadCachePage: async (page, folder, expectedTotal) => {
            const {comics, total} = await this.favorites.loadComics(page, folder);
            const limit = CopyManga.apiPageSize;
            const offset = (page - 1) * limit;
            const expectedCount = Math.min(limit, Math.max(0, total - offset));
            if ((expectedTotal != null && total !== expectedTotal) || comics.length !== expectedCount) {
                throw "Favorites: inconsistent cache page";
            }
            return {comics, total, maxPage: Math.ceil(total / limit)};
        },
    }

    isValidScanId(value) {
        return typeof value === "string" && value.length > 0 && value === value.trim() &&
            !value.includes("\0") && [...value].length <= 1024;
    }

    scan = typeof SCAN_COLLECTION_ITEM_FAILURES_V1 !== "undefined" && SCAN_COLLECTION_ITEM_FAILURES_V1 === true ? {
        primary: "collection",
        collection: {
            itemFailures: true,
            fieldSource: {latestChapterId: "comic.last_chapter_id"},
            load: async (collectionKey, cursor, request) => {
                if (collectionKey !== "default" || typeof request !== "function") {
                    return {failure: {message: "Favorites scan: invalid collection"}};
                }
                const limit = CopyManga.apiPageSize;
                // A cursor with a null offset rechecks the first page without emitting its items again.
                if (cursor !== null && (!cursor || !Number.isSafeInteger(cursor.total) || cursor.total < 0 ||
                    !Array.isArray(cursor.headIds) || cursor.headIds.length !== Math.min(limit, cursor.total) ||
                    !cursor.headIds.every(id => this.isValidScanId(id)) ||
                    (cursor.offset !== null && (!Number.isSafeInteger(cursor.offset) ||
                        cursor.offset <= 0 || cursor.offset >= cursor.total || cursor.offset % limit !== 0)))) {
                    return {failure: {message: "Favorites scan: invalid cursor"}};
                }
                const origin = this.apiUrl;
                const token = this.sessionToken(origin);
                if (!token) return {failure: {message: "Login expired"}};

                const offset = cursor?.offset ?? 0;
                let response;
                try {
                    response = await request(this.favoritePageRequest(origin, token, offset, "-datetime_modifier"));
                } catch (error) {
                    return {failure: error?.scanFailure ?? {message: "Favorites scan request failed"}};
                }
                if (this.apiUrl !== origin || this.sessionToken(origin) !== token) {
                    return {failure: {message: "Favorites scan: session changed"}};
                }

                let page;
                try {
                    page = this.readApiPage(response, "Favorites scan", offset);
                } catch (error) {
                    const failure = {message: typeof error === "string" ? error : "Favorites scan: invalid response"};
                    if (Number.isInteger(response?.status) && response.status !== 200) failure.httpStatus = response.status;
                    if (response?.status === 200 && error === "Login expired") failure.sourceCode = "401";
                    return {failure};
                }
                const {list, total} = page;
                if ((cursor !== null && total !== cursor.total) || list.length !== Math.min(limit, total - offset)) {
                    return {failure: {message: "Favorites scan: inconsistent pagination"}};
                }
                const ids = list.map(item => item?.comic?.path_word);
                if (!ids.every(id => this.isValidScanId(id)) || new Set(ids).size !== ids.length) {
                    return {failure: {message: "Favorites scan: invalid or duplicate comic ID"}};
                }
                if (cursor?.offset === null) {
                    if (!ids.every((id, index) => id === cursor.headIds[index])) {
                        return {failure: {message: "Favorites scan: first page changed"}};
                    }
                    return {items: [], next: null};
                }

                const items = list.map(({comic}, index) => {
                    const comicId = ids[index];
                    const latestChapterId = comic.last_chapter_id;
                    return this.isValidScanId(latestChapterId)
                        ? {comicId, observation: {update: {latestChapterId}}}
                        : {comicId, failure: {message: "Favorites scan: invalid or missing latest chapter ID"}};
                });
                const nextOffset = offset + list.length;
                const next = {offset: nextOffset < total ? nextOffset : null, total, headIds: cursor?.headIds ?? ids};
                return {items, next};
            },
        },
    } : null

    comic = {
        loadInfo: async (id) => {
            const origin = this.apiUrl;
            const detailUrl = this.detailUrl(origin, id);
            let res = await Network.get(detailUrl, this.webHeaders);
            if (res.status !== 200) {
                throw `Invalid status code: ${res.status}`;
            }

            let html = res.body;
            let doc = new HtmlDocument(html);

            let title = '';
            let titleEl = doc.querySelector('h6[title]');
            if (titleEl && titleEl.attributes) {
                title = titleEl.attributes['title'] || '';
            }
            if (!title) {
                let pageTitle = doc.querySelector('title');
                title = pageTitle && pageTitle.text ? pageTitle.text.trim().split('-')[0].trim() : '';
            }

            let cover = '';
            let coverImg = doc.querySelector('.comicParticulars-left-img img');
            if (coverImg && coverImg.attributes) {
                cover = coverImg.attributes['src'] || coverImg.attributes['data-src'] || '';
            }

            const authors = new Set();
            const authorLinks = doc.querySelectorAll('.comicParticulars-title-right a[href*="/author/"]');
            for (const link of authorLinks) {
                const name = link.text?.trim();
                const authorId = link.attributes?.href?.match(/^(?:(?:https?:)?\/\/[^/]+)?\/author\/([^/?#]+)/)?.[1];
                if (!name || !authorId) continue;
                authors.add(name);
                this.author_path_word_dict[name] = authorId;
            }

            const tags = new Set();
            const tagLinks = doc.querySelectorAll('.comicParticulars-tag a[href*="/comics?"]');
            for (const link of tagLinks) {
                if (!/[?&]theme=[^&#]+/.test(link.attributes?.href ?? "")) continue;
                const name = link.text?.trim().replace(/^#\s*/, "");
                if (name) tags.add(name);
            }

            let description = '';
            let introEl = doc.querySelector('.intro');
            if (introEl) {
                description = introEl.text ? introEl.text.trim() : '';
            }

            let updateTime = '';
            let status = '';
            let infoItems = doc.querySelectorAll('.comicParticulars-title-right li');
            for (let i = 0; i < infoItems.length; i++) {
                let item = infoItems[i];
                let text = item.text ? item.text.replace(/\s+/g, ' ').trim() : '';
                if (text.includes('最後更新') || text.includes('最后更新')) {
                    updateTime = text.replace(/最後更新|最后更新/g, '').replace(/^\s*[:：]\s*/, '').trim();
                }
                if (text.includes('狀態') || text.includes('状态')) {
                    status = text.replace(/狀態|状态/g, '').replace(/^\s*[:：]\s*/, '').trim();
                }
            }

            let chapters = Object.create(null);

            let ccz = '';
            let cczPatterns = [
                /(?:var|let|const)\s+ccz\s*=\s*['"]([^'"]+)['"]/,
                /window\.ccz\s*=\s*['"]([^'"]+)['"]/,
                /ccz\s*=\s*['"]([^'"]+)['"]/
            ];
            for (let pattern of cczPatterns) {
                let match = html.match(pattern);
                if (match && match[1]) {
                    ccz = match[1];
                    break;
                }
            }

            let dntEl = doc.querySelector('#dnt');
            let dnt = dntEl && dntEl.attributes ? dntEl.attributes['value'] || '' : '';

            if (ccz && dnt) {
                try {
                    const response = await Network.get(
                        origin + "/comicdetail/" + encodeURIComponent(id) + "/chapters",
                        {...this.formHeaders(detailUrl), "dnts": dnt},
                    );
                    const payload = this.checkWebResponse(response, "Chapters");
                    const parsed = JSON.parse(this.decryptWebPayload(payload, ccz));
                    for (const [key, group] of Object.entries(parsed.groups ?? {})) {
                        if (!Array.isArray(group?.chapters)) continue;
                        const entries = group.chapters.filter(chapter => (chapter?.id || chapter?.uuid) && chapter.name);
                        if (entries.length) {
                            chapters[group.name || key] = Object.fromEntries(entries.map(chapter => [
                                chapter.id || chapter.uuid, chapter.name,
                            ]));
                        }
                    }
                } catch {
                    console.log("Could not load the web chapter directory.");
                }
            }

            if (Object.keys(chapters).length === 0) {
                let chapterLinks = doc.querySelectorAll('a[href*="/chapter/"]');

                let seenChapters = new Set();
                for (let i = chapterLinks.length - 1; i >= 0; i--) {
                    let link = chapterLinks[i];
                    let href = link.attributes['href'] || '';
                    let chapterTitle = link.text ? link.text.trim() : '';

                    if (href && chapterTitle && !seenChapters.has(href)) {
                        seenChapters.add(href);
                        let parts = href.split('/');
                        let chapterId = '';
                        for (let j = parts.length - 1; j >= 0; j--) {
                            if (parts[j] && parts[j] !== 'chapter') {
                                chapterId = parts[j];
                                break;
                            }
                        }
                        if (chapterId) {
                            chapters[chapterId] = chapterTitle;
                        }
                    }
                }
            }

            const comicId = this.comicUuid(doc) || '';
            const collectBtn = doc.querySelector('.comicParticulars-botton.collect');

            // The default "add to bookshelf" label does not establish remote membership.
            const observations = this.favoriteObservations(origin, this.sessionToken(origin));
            const isFavorite = observations?.get(id) ?? (collectBtn?.text?.includes('已收藏') ? true : null);

            return {
                title: title,
                cover: cover,
                description: description,
                tags: {
                    "作者": [...authors],
                    "更新": [updateTime],
                    "标签": [...tags],
                    "状态": [status],
                },
                chapters: chapters,
                isFavorite: isFavorite,
                subId: comicId
            }
        },
        loadEp: async (comicId, epId) => {
            const detailUrl = this.detailUrl(this.apiUrl, comicId);
            let res = await Network.get(
                detailUrl + "/chapter/" + encodeURIComponent(epId),
                {...this.webHeaders, "Referer": detailUrl},
            );

            if (res.status !== 200) {
                throw `Invalid status code: ${res.status}`;
            }

            let html = res.body;
            let doc = new HtmlDocument(html);

            let images = [];

            let contentKey = '';
            let contentKeyPatterns = [
                /(?:var|let|const)\s+contentKey\s*=\s*['"]([^'"]+)['"]/,
                /window\.contentKey\s*=\s*['"]([^'"]+)['"]/,
                /contentKey\s*=\s*['"]([^'"]+)['"]/
            ];
            for (let pattern of contentKeyPatterns) {
                let match = html.match(pattern);
                if (match && match[1]) {
                    contentKey = match[1];
                    break;
                }
            }

            let cct = '';
            let cctPatterns = [
                /(?:var|let|const)\s+cct\s*=\s*['"]([^'"]+)['"]/,
                /window\.cct\s*=\s*['"]([^'"]+)['"]/,
                /cct\s*=\s*['"]([^'"]+)['"]/
            ];
            for (let pattern of cctPatterns) {
                let match = html.match(pattern);
                if (match && match[1]) {
                    cct = match[1];
                    break;
                }
            }

            if (contentKey && cct) {
                try {
                    const json = this.decryptWebPayload(contentKey, cct);
                    const parsed = JSON.parse(json.match(/\[.*\]/s)?.[0] ?? json);
                    if (Array.isArray(parsed)) {
                        for (const item of parsed) {
                            let url = typeof item === 'string' ? item : item?.url;
                            if (typeof url === "string" && url) {
                                if (url.startsWith("//")) {
                                    url = "https:" + url;
                                }
                                url = url.replace(/([./])c\d+x\.[a-zA-Z]+$/, `$1c${this.imageQuality}x.webp`);
                                images.push(url);
                            }
                        }
                    }
                } catch {
                    console.log("Could not load the web reader image list.");
                }
            }

            if (images.length === 0) {
                let selectors = [
                    '.comicContent-list img',
                    '.comic-content img',
                    '#comic-content img',
                    '.chapter-content img',
                    '.reader-content img',
                    '[class*="content"] img',
                    'img[data-src]',
                    'img[data-original]'
                ];
                for (let selector of selectors) {
                    let imgEls = doc.querySelectorAll(selector);
                    for (let i = 0; i < imgEls.length; i++) {
                        let img = imgEls[i];
                        let src = '';
                        if (img.attributes) {
                            src = img.attributes['src'] || img.attributes['data-src'] || img.attributes['data-original'] || '';
                        }
                        if (src && !src.includes('placeholder') && !src.includes('loading')) {
                            if (src.startsWith('//')) {
                                src = 'https:' + src;
                            }
                            src = src.replace(/([./])c\d+x\.[a-zA-Z]+$/, `$1c${this.imageQuality}x.webp`);
                            images.push(src);
                        }
                    }
                    if (images.length > 0) break;
                }
            }

            if (images.length === 0) {
                throw 'No images found in chapter';
            }

            return {
                images: images,
            };
        },
        loadComments: async (comicId, subId, page, replyTo) => {
            let url = `https://api.mangacopy.com/api/v3/comments?comic_id=${subId}&limit=20&offset=${(page - 1) * 20}`;
            if (replyTo) {
                url = url + `&reply_id=${replyTo}&_update=true`;
            }
            let res = await Network.get(
                url,
                {
                    ...this.webHeaders,
                    'Accept': 'application/json',
                }
            );

            if (res.status !== 200) {
                if (res.status === 210) {
                    throw "210：注冊用戶一天可以發5條評論"
                }
                throw `Invalid status code: ${res.status}`;
            }

            let data = JSON.parse(res.body);

            let total = data.results.total;

            return {
                comments: data.results.list.map(e => {
                    return {
                        userName: replyTo ? `${e.user_name}  👉  ${e.parent_user_name}` : e.user_name,
                        avatar: e.user_avatar,
                        content: e.comment,
                        time: e.create_at,
                        replyCount: e.count,
                        id: e.id,
                    }
                }),
                maxPage: (total - (total % 20)) / 20 + 1,
            }
        },
        sendComment: async (comicId, subId, content, replyTo) => {
            const token = this.sessionToken(this.apiUrl);
            if (!token) {
                throw "未登录"
            }
            if (!replyTo) {
                replyTo = '';
            }
            let res = await Network.post(
                `https://api.mangacopy.com/api/v3/member/comment`,
                {
                    ...this.webHeaders,
                    "Content-Type": "application/x-www-form-urlencoded;charset=utf-8",
                    "Accept": "application/json",
                    "Authorization": `Token ${token}`,
                },
                `comic_id=${subId}&comment=${encodeURIComponent(content)}&reply_id=${replyTo}`,
            );

            if (res.status === 401) {
                error(`Login expired`);
                return;
            }

            if (res.status !== 200) {
                throw `Invalid status code: ${res.status}`;
            } else {
                return "ok"
            }
        },
        loadChapterComments: async (comicId, epId, page, replyTo) => {
            let url = `https://api.mangacopy.com/api/v3/roasts?chapter_id=${epId}&limit=20&offset=${(page - 1) * 20}&_update=true`;
            let res = await Network.get(
                url,
                {
                    ...this.webHeaders,
                    'Accept': 'application/json',
                }
            );

            if (res.status !== 200) {
                throw `Invalid status code: ${res.status}`;
            }

            let data = JSON.parse(res.body);

            let total = data.results.total;

            return {
                comments: data.results.list.map(e => {
                    return {
                        userName: e.user_name,
                        avatar: e.user_avatar,
                        content: e.comment,
                        time: e.create_at,
                        replyCount: null,
                        id: null,
                    }
                }),
                maxPage: (total - (total % 20)) / 20 + 1,
            }
        },
        sendChapterComment: async (comicId, epId, content, replyTo) => {
            const token = this.sessionToken(this.apiUrl);
            if (!token) {
                throw "未登录"
            }
            let res = await Network.post(
                `${this.apiUrl}/api/v3/member/roast`,
                {
                    ...this.webApiHeaders(token),
                    "Content-Type": "application/x-www-form-urlencoded;charset=utf-8",
                },
                `chapter_id=${epId}&roast=${encodeURIComponent(content)}`,
            );

            if (res.status === 401) {
                throw `Login expired`;
            }

            if (res.status !== 200) {
                if (res.status === 210) {
                    throw `210:评论过于频繁或评论内容过短过长`;
                }
                throw `Invalid status code: ${res.status}`;
            } else {
                return "ok"
            }
        },
        onClickTag: (namespace, tag) => {
            if (namespace === "标签") {
                return {
                    action: 'search',
                    keyword: `tag:${tag}`,
                    param: null,
                }
            }
            if (namespace === "作者") {
                return {
                    action: 'search',
                    keyword: `author:${tag}`,
                    param: null,
                }
            }
            throw "未支持此类Tag检索"
        }
    }

    settings = {
        favorites_ordering: {
            title: "收藏排序方式",
            type: "select",
            options: [
                {
                    value: '-datetime_updated',
                    text: '更新时间'
                },
                {
                    value: '-datetime_modifier',
                    text: '收藏时间'
                },
                {
                    value: '-datetime_browse',
                    text: '阅读时间'
                }
            ],
            default: '-datetime_updated',
        },
        region: {
            title: "CDN线路",
            type: "select",
            options: [
                {
                    value: "0",
                    text: '海外线路'
                },
            ],
            default: CopyManga.defaultCopyRegion,
        },
        image_quality: {
            title: "图片质量",
            type: "select",
            options: [
                {
                    value: '800',
                    text: '低 (800)'
                },
                {
                    value: '1200',
                    text: '中 (1200)'
                },
                {
                    value: '1500',
                    text: '高 (1500)'
                }
            ],
            default: CopyManga.defaultImageQuality,
        },
        base_url: {
            title: "节点选择",
            type: "select",
            options: [
                {value: CopyManga.defaultApiUrl, text: 'mangacopy.com'},
                // {value: 'www.2026copy.com', text: '2026copy.com'},
                // {value: 'www.2025copy.com', text: '2025copy.com'},
                // {value: 'www.copy20.com', text: 'copy20.com'},
                // {value: 'www.copy-manga.com', text: 'copy-manga.com'},
            ],
            default: CopyManga.defaultApiUrl,
        },


        // version: {
        //     title: "拷贝版本（重启APP生效）",
        //     type: "input",
        //     default: CopyManga.defaultCopyVersion,
        // },
        // platform: {
        //     title: "平台代号（重启APP生效）",
        //     type: "input",
        //     validator: '^\\d+(?:\\.\\d+)*$',
        //     default: CopyManga.defaultCopyPlatform,
        // },
    }

    /**
     * Check if the current app version is after the target version
     * @param target {string} target version
     * @returns {boolean} true if the current app version is after the target version
     */
    isAppVersionAfter(target) {
        let current = APP.version
        let targetArr = target.split('.')
        let currentArr = current.split('.')
        for (let i = 0; i < 3; i++) {
            if (parseInt(currentArr[i]) < parseInt(targetArr[i])) {
                return false
            }
        }
        return true
    }

    async runSpeedTest() {
        const hosts = [
            ...this.settings.base_url.options.map(option => option.value),
            // 'www.2027copy.com',
            // 'www.copymanga.tv',
            // 'www.copy2000.site',
            // 'www.copy2000.online',
        ];

        const results = {};

        for (const host of hosts) {
            const startTime = Date.now();
            try {
                const res = await Network.get(`https://${host}/`, {
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
                });
                const endTime = Date.now();
                const latency = endTime - startTime;

                if (res.status === 200) {
                    const body = res.body.toLowerCase();
                    const isValid = body.includes('content-box') || body.includes('swiperlist') || body.includes('comicrank');
                    results[host] = {
                        success: isValid,
                        latency: latency,
                        status: res.status
                    };
                } else {
                    results[host] = {
                        success: false,
                        latency: latency,
                        status: res.status
                    };
                }
            } catch (e) {
                results[host] = {
                    success: false,
                    latency: 999999,
                    status: 0
                };
            }
        }

        this.saveData("_speed_test_results", JSON.stringify(results));
        this.saveData("_speed_test_time", new Date().toISOString());

        let bestHost = null;
        let bestLatency = 999999;
        for (const [host, result] of Object.entries(results)) {
            if (result.success && result.latency < bestLatency) {
                bestLatency = result.latency;
                bestHost = host;
            }
        }

        if (bestHost) {
            this.saveData("_best_host", bestHost);
        }
    }

    getSpeedTestResults() {
        const results = this.loadData("_speed_test_results");
        const time = this.loadData("_speed_test_time");
        if (results) {
            return {
                results: JSON.parse(results),
                time: time
            };
        }
        return null;
    }
}
