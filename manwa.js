/** @type {import('./_venera_.js')} */
class Manwa extends ComicSource {
    name = "漫蛙"

    key = "manwa"

    version = "1.0.12"

    minAppVersion = "1.6.0"

    url = "https://cdn.jsdelivr.net/gh/yuxuanmian/venera-configs@yxm/manwa.js"

    baseUrl = "https://manwa.me"

    staticBaseUrl = "https://mwappimgs.cc"

    favoritePageSize = 15

    htmlHeaders = (referer = null) => {
        const headers = {
            "Accept": "text/html,application/xhtml+xml",
        };
        if (referer) {
            headers["Referer"] = referer;
        }
        return headers;
    }

    jsonHeaders = (referer) => ({
        "Accept": "application/json, text/plain, */*",
        "X-Requested-With": "XMLHttpRequest",
        "Referer": referer,
    })

    loginHeaders = () => ({
        "Accept": "application/json, text/plain, */*",
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest",
        "Origin": this.baseUrl,
        "Referer": `${this.baseUrl}/login.html`,
    })

    toStaticUrl = (value) => {
        if (value == null) {
            return undefined;
        }
        const url = String(value).trim();
        if (!url) {
            return undefined;
        }
        const legacyStaticUrl = url.match(
            /^https?:\/\/manwa\.me(\/static\/.*)$/i,
        );
        if (legacyStaticUrl) {
            return `${this.staticBaseUrl}${legacyStaticUrl[1]}`;
        }
        if (/^https?:\/\//i.test(url)) {
            return url;
        }
        if (url.startsWith("//")) {
            return `https:${url}`;
        }
        if (url.startsWith("/")) {
            return `${this.staticBaseUrl}${url}`;
        }
        return `${this.staticBaseUrl}/${url}`;
    }

    formEncode = (fields) => Object.keys(fields)
        .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(fields[key] ?? "")}`)
        .join("&")

    textOf = (element) => {
        if (!element) {
            return "";
        }
        const text = element.text;
        return text == null ? "" : String(text).trim();
    }

    requireSuccess = (response, operation, loginSensitive = false) => {
        const status = response && response.status;
        if (loginSensitive && (status === 401 || status === 403)) {
            throw "Login expired";
        }
        if (typeof status !== "number" || status < 200 || status >= 300) {
            throw `${operation} failed: HTTP ${status == null ? "unknown" : status}`;
        }
        return response;
    }

    transientError = "收藏接口暂时不可用，请稍后重试"

    isTransientWaitText = (value) => /请等待|稍后再试|访问过于频繁|系统繁忙|服务繁忙/i.test(
        String(value ?? "").trim(),
    )

    isTransientJsonBody = (value) => {
        const text = String(value ?? "").trim();
        return /^(?:<|doctype\b|html\b)/i.test(text);
    }

    parseJson = (body, operation) => {
        const text = String(body ?? "").trim();
        if (this.isTransientJsonBody(text)) {
            throw this.transientError;
        }
        try {
            return JSON.parse(text);
        } catch (error) {
            if (this.isTransientWaitText(text)) {
                throw this.transientError;
            }
            throw `${operation} returned invalid JSON`;
        }
    }

    requireJsonSuccess = (data, operation, loginSensitive = false) => {
        const message = data && typeof data.msg === "string" ? data.msg.trim() : "";
        if ((typeof data === "string" && this.isTransientWaitText(data))
            || this.isTransientWaitText(message)) {
            throw this.transientError;
        }
        if (data && data.err === 0) {
            return data;
        }
        if (loginSensitive && /未登录|登录|登陆|login|session|expired|unauthor/i.test(message)) {
            throw "Login expired";
        }
        throw message || `${operation} failed`;
    }

    isPlaceholderCover = (url) => /(?:^|\/)imagecover_s\.png(?:[?#]|$)/i.test(url)

    unique = (values) => {
        const result = [];
        for (const value of values) {
            if (value && !result.includes(value)) {
                result.push(value);
            }
        }
        return result;
    }

    normalizeId = (value) => {
        if (typeof value !== "string" && typeof value !== "number") {
            return undefined;
        }
        const text = String(value).trim();
        if (!text || text === "undefined" || text === "null" || text === "NaN") {
            return undefined;
        }
        return text;
    }

    validateFavoriteBook = (book, requireUpdateEvidence = false) => {
        if (book == null || typeof book !== "object" || Array.isArray(book)) {
            throw "收藏列表存在无效漫画结构";
        }
        const id = this.normalizeId(book.id);
        if (!id) {
            throw "收藏夹存在空漫画 ID";
        }
        if (typeof book.book_name !== "string" || !book.book_name.trim()) {
            throw "收藏列表存在无效漫画标题";
        }
        const lastChapter = book.last_chapter;
        if (lastChapter == null
            || typeof lastChapter !== "object"
            || Array.isArray(lastChapter)) {
            throw "收藏列表存在无效章节结构";
        }
        for (const chapter of [book.full_last_chapter, book.read_last_chapter]) {
            if (chapter != null
                && (typeof chapter !== "object" || Array.isArray(chapter))) {
                throw "收藏列表存在无效章节结构";
            }
        }
        for (const chapter of [lastChapter, book.full_last_chapter, book.read_last_chapter]) {
            if (chapter && chapter.id != null
                && typeof chapter.id !== "string"
                && typeof chapter.id !== "number") {
                throw "收藏列表存在无效章节 ID";
            }
            if (chapter && chapter.chapter_name != null
                && typeof chapter.chapter_name !== "string") {
                throw "收藏列表存在无效章节结构";
            }
        }
        if (requireUpdateEvidence) {
            if (!this.normalizeId(lastChapter.id)) {
                throw "收藏列表缺少最新章节 ID";
            }
            if (typeof book.is_new !== "boolean"
                || typeof book.full_is_new !== "boolean") {
                throw "收藏列表更新字段类型无效";
            }
        }
        return {id, lastChapter};
    }

    parseFavoriteComic = (book, requireUpdateEvidence = false) => {
        const validated = this.validateFavoriteBook(book, requireUpdateEvidence);
        const lastChapter = book && book.last_chapter;
        const readLastChapter = book && book.read_last_chapter;
        const subtitle = lastChapter && lastChapter.chapter_name
            || readLastChapter && readLastChapter.chapter_name;
        const normalChapterId = this.normalizeId(lastChapter && lastChapter.id);
        const fullChapterId = this.normalizeId(
            book.full_last_chapter && book.full_last_chapter.id,
        );
        let favoriteUpdate;
        if (normalChapterId) {
            const normalIsNew = typeof book.is_new === "boolean"
                ? book.is_new
                : null;
            const fullIsNew = typeof book.full_is_new === "boolean"
                ? book.full_is_new
                : null;
            favoriteUpdate = {
                sourceUnread: normalIsNew === null && fullIsNew === null
                    ? null
                    : Boolean(normalIsNew || fullIsNew),
                metadata: {
                    normalIsNew,
                    fullIsNew,
                    fullLatestChapterId: fullChapterId || null,
                },
            };
            if (fullChapterId) {
                favoriteUpdate.marker = JSON.stringify([
                    "manwa-full-v1",
                    normalChapterId,
                    fullChapterId,
                ]);
            } else {
                favoriteUpdate.state = {
                    latestChapterId: normalChapterId,
                };
            }
        }
        return new Comic({
            id: validated.id,
            title: book.book_name.trim(),
            cover: this.toStaticUrl(book.cover_url) || "",
            subtitle: subtitle ? String(subtitle) : undefined,
            tags: [],
            favoriteUpdate,
        });
    }

    _scanFailure = (fields = {}) => {
        const failure = {}
        if (Number.isInteger(fields.httpStatus) && fields.httpStatus >= 100 && fields.httpStatus <= 599) {
            failure.httpStatus = fields.httpStatus
        }
        const sourceCode = this._scanCode(fields.sourceCode)
        if (sourceCode) failure.sourceCode = sourceCode
        const exceptionType = this._scanCode(fields.exceptionType)
        if (exceptionType) failure.exceptionType = exceptionType
        const message = this._scanMessage(fields.message)
        if (message) failure.message = message
        return {failure}
    }

    _scanFailureFromError = (error) => {
        if (error && error.scanFailure && typeof error.scanFailure === 'object') {
            return this._scanFailure(error.scanFailure)
        }
        return this._scanFailure({
            exceptionType: 'ScanRequestError',
            message: 'Manwa scan request failed',
        })
    }

    _scanCode = (value) => {
        if (typeof value !== 'string') return undefined
        const text = value.trim()
        return /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(text)
            && !this._scanUntrustedDiagnostic(text) ? text : undefined
    }

    _scanUntrustedDiagnostic = (text) => /(?:^|\s|[{},();\[\]])["']?(?:authorization|cookie|set-cookie|token|password|passwd|secret|api[-_]?key|body)["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;}]+)/i.test(text)
        || /<\s*(?:\/?[A-Za-z][^>]*|![^>]*|--[^>]*)>/i.test(text)
        || /[\[{]/.test(text)

    _scanMessage = (value) => {
        if (typeof value !== 'string') return undefined
        const text = value.trim()
        if (!text || this._scanUntrustedDiagnostic(text)
            || /\b(?:basic|bearer)\s+[^\s,;}]+/i.test(text)
            || /https?:\/\//i.test(text)
        ) {
            return undefined
        }
        return [...text].length <= 256 ? text : [...text].slice(0, 256).join('')
    }

    _scanId = (value) => {
        if (typeof value === 'string') {
            const text = value.trim()
            return text && [...text].length <= 1024 ? text : undefined
        }
        if (typeof value === 'number' && Number.isSafeInteger(value)) {
            return String(value)
        }
        return undefined
    }

    _scanHeadIds = (value, exactLength = null) => {
        if (!Array.isArray(value)
            || (exactLength != null && value.length !== exactLength)
            || value.length > 15) {
            return undefined
        }
        const ids = []
        for (const item of value) {
            if (typeof item !== 'string' || !item.trim() || [...item].length > 1024 || ids.includes(item.trim())) {
                return undefined
            }
            ids.push(item.trim())
        }
        return ids
    }

    _scanCursor = (cursor) => {
        if (cursor === null) return {phase: 'first'}
        if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) return undefined
        const keys = Object.keys(cursor)
        if (cursor.phase === 'page'
            && keys.length === 3
            && keys.includes('phase')
            && keys.includes('offset')
            && keys.includes('headIds')
            && Number.isSafeInteger(cursor.offset)
            && cursor.offset > 0
            && cursor.offset % this.favoritePageSize === 0
            && cursor.offset <= Number.MAX_SAFE_INTEGER - this.favoritePageSize) {
            const headIds = this._scanHeadIds(cursor.headIds, 15)
            return headIds ? {phase: 'page', offset: cursor.offset, headIds} : undefined
        }
        if (cursor.phase === 'verify'
            && keys.length === 2
            && keys.includes('phase')
            && keys.includes('headIds')) {
            const headIds = this._scanHeadIds(cursor.headIds)
            return headIds ? {phase: 'verify', headIds} : undefined
        }
        return undefined
    }

    _scanBook = (book) => {
        if (!book || typeof book !== 'object' || Array.isArray(book)) {
            return this._scanFailure({message: 'Manwa favorite item was invalid'})
        }
        const comicId = this._scanId(book.id)
        if (!comicId) return this._scanFailure({message: 'Manwa comic ID was invalid'})
        const lastChapter = book.last_chapter && typeof book.last_chapter === 'object' && !Array.isArray(book.last_chapter)
            ? this._scanId(book.last_chapter.id)
            : undefined
        const normalUnread = typeof book.is_new === 'boolean' ? book.is_new : null
        const fullUnread = typeof book.full_is_new === 'boolean' ? book.full_is_new : null
        const sourceUnread = normalUnread === true || fullUnread === true
            ? true
            : normalUnread === false && fullUnread === false
                ? false
                : undefined
        const observation = {}
        if (lastChapter) observation.update = {latestChapterId: lastChapter}
        if (sourceUnread !== undefined) observation.sourceUnread = sourceUnread
        if (!Object.keys(observation).length) {
            return this._scanFailure({message: 'Manwa comic has no scan observation'})
        }
        return {item: {comicId, observation}}
    }

    _scanFetchPage = async (offset, request, includeObservations = true) => {
        const path = 'getfavors?page=' + encodeURIComponent(offset)
            + '&showOnlyUpdated=-1&isEnd=-1&isFullVersion=-1'
            + '&order=0&order_type=0&folder_id=0'
        let response
        try {
            response = await request({
                method: 'GET',
                url: `${this.baseUrl}/${path}`,
                headers: this.jsonHeaders(`${this.baseUrl}/bookshelf`),
            })
        } catch (error) {
            return this._scanFailureFromError(error)
        }
        if (!response || typeof response.status !== 'number' || response.status < 200 || response.status >= 300) {
            return this._scanFailure({
                httpStatus: response && response.status,
                message: 'Manwa favorites request failed',
            })
        }
        let data
        try {
            if (typeof response.body !== 'string' || !response.body.trim()) throw new Error('empty')
            data = JSON.parse(response.body)
        } catch (_) {
            return this._scanFailure({message: 'Manwa favorites response was invalid'})
        }
        if (!data || data.err !== 0) {
            return this._scanFailure({
                sourceCode: data && data.err != null ? String(data.err) : undefined,
                message: 'Manwa favorites response failed',
            })
        }
        if (!Array.isArray(data.books) || data.books.length > this.favoritePageSize) {
            return this._scanFailure({message: 'Manwa favorites page was invalid'})
        }
        const items = []
        const ids = new Set()
        for (const book of data.books) {
            if (!book || typeof book !== 'object' || Array.isArray(book)) {
                return this._scanFailure({message: 'Manwa favorite item was invalid'})
            }
            const comicId = this._scanId(book.id)
            if (!comicId) return this._scanFailure({message: 'Manwa comic ID was invalid'})
            if (ids.has(comicId)) {
                return this._scanFailure({message: 'Manwa favorites page contained duplicate IDs'})
            }
            ids.add(comicId)
            if (!includeObservations) {
                items.push({comicId})
                continue
            }
            const result = this._scanBook(book)
            if (result.failure) return result
            items.push(result.item)
        }
        return {ok: true, items}
    }

    _scanSameIds = (left, right) => Array.isArray(left)
        && Array.isArray(right)
        && left.length === right.length
        && left.every((value, index) => value === right[index])

    scan = {
        primary: 'collection',
        collection: {
            // Contract C1/C3: one declaration per branch, beside `load`.  The
            // keys are the standard observation fields; the values say where
            // each value comes from in the source payload.  The host never
            // parses these values — they only feed the comparable label, so a
            // maintainer who changes the mapping changes this table in the same
            // edit.  Mirrors doc/scan-contract-v1.md S1.3.
            fieldSource: {
                latestChapterId: 'last_chapter.id',
                sourceUnread: 'is_new|full_is_new',
            },
            load: async (collectionKey, cursor, request) => {
                if (collectionKey !== 'default' || typeof request !== 'function') {
                    return this._scanFailure({message: 'Manwa collection identity is invalid'})
                }
                const state = this._scanCursor(cursor)
                if (!state) return this._scanFailure({message: 'Manwa scan cursor was invalid'})
                const offset = state.phase === 'first'
                    ? 0
                    : state.phase === 'page'
                        ? state.offset
                        : 0
                const result = await this._scanFetchPage(offset, request, state.phase !== 'verify')
                if (!result.ok) return result
                if (state.phase === 'verify') {
                    const ids = result.items.map((item) => item.comicId)
                    if (!this._scanSameIds(ids, state.headIds)) {
                        return this._scanFailure({message: 'Manwa favorites changed during scan'})
                    }
                    return {items: [], next: null}
                }
                const headIds = state.phase === 'first'
                    ? result.items.map((item) => item.comicId)
                    : state.headIds
                const next = result.items.length === this.favoritePageSize
                    ? {
                        phase: 'page',
                        offset: offset + this.favoritePageSize,
                        headIds: [...headIds],
                    }
                    : {
                        phase: 'verify',
                        headIds: [...headIds],
                    }
                return {items: result.items, next}
            },
        },
    }

    parseFavoriteCount = (document) => {
        const text = this.textOf(document.querySelector(".favorite-count"));
        const match = text.replace(/\s+/g, "").match(/^(\d+)\/(\d+)$/);
        if (!match) {
            throw "未找到收藏总数";
        }
        const count = Number(match[1]);
        if (!Number.isFinite(count)) {
            throw "收藏总数无效";
        }
        return count;
    }

    loadFavoriteCount = async () => {
        const bookshelfUrl = `${this.baseUrl}/bookshelf`;
        const response = await Network.get(
            bookshelfUrl,
            this.htmlHeaders(),
        );
        this.requireSuccess(response, "favorites page", true);
        const document = new HtmlDocument(response.body);
        try {
            return this.parseFavoriteCount(document);
        } catch (error) {
            if (this.isTransientWaitText(response.body)) {
                throw this.transientError;
            }
            throw error;
        } finally {
            document.dispose();
        }
    }

    loadFavoriteBooks = async (siteOffset, bookshelfUrl) => {
        const response = await Network.get(
            `${this.baseUrl}/getfavors?page=${siteOffset}`
            + "&showOnlyUpdated=-1&isEnd=-1&isFullVersion=-1"
            + "&order=1&order_type=0&folder_id=0",
            this.jsonHeaders(bookshelfUrl),
        );
        this.requireSuccess(response, "favorites", true);
        const data = this.requireJsonSuccess(
            this.parseJson(response.body, "favorites"),
            "favorites",
            true,
        );
        if (!Array.isArray(data.books)) {
            throw "收藏列表无效";
        }
        return data.books;
    }

    account = {
        login: async (account, pwd) => {
            const loginPage = `${this.baseUrl}/login.html`;
            this.requireSuccess(
                await Network.get(loginPage, this.htmlHeaders()),
                "login page",
            );

            const captchaUrl = `${this.baseUrl}/captcha?rnd=${Date.now()}`;
            const captcha = await Network.fetchBytes(
                "GET",
                captchaUrl,
                this.htmlHeaders(loginPage),
            );
            this.requireSuccess(captcha, "captcha");

            const captchaText = await UI.showInputDialog(
                "请输入图片验证码",
                null,
                captcha.body,
            );
            if (captchaText == null) {
                throw "已取消验证码输入";
            }
            const captchaCode = String(captchaText).trim();
            if (!captchaCode) {
                throw "请输入验证码";
            }

            const response = await Network.post(
                `${this.baseUrl}/login`,
                this.loginHeaders(),
                this.formEncode({
                    username: account,
                    password: pwd,
                    captcha: captchaCode,
                }),
            );
            this.requireSuccess(response, "login");
            const data = this.parseJson(response.body, "login");
            if (!data || data.err !== 0) {
                Network.deleteCookies(this.baseUrl);
                throw data && data.msg ? String(data.msg) : "登录失败";
            }
            return "ok";
        },

        logout: () => {
            Network.deleteCookies(this.baseUrl);
            this.deleteData("dailyWelfareVisitDate");
        },
    }

    checkinRequest = null

    checkinDay = (now = Date.now()) => new Date(now + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)

    visitWelfare = async () => {
        if (!this.isLogged) return "请先登录漫蛙";
        if (this.checkinRequest) return this.checkinRequest;

        const visit = async () => {
            if (!this.isLogged) return "请先登录漫蛙";
            const day = this.checkinDay();
            // Record the attempt before the request so restarts and failures do not
            // cause more automatic requests. Manual checks can still retry.
            if (this.loadData("dailyWelfareVisitDate") !== day) {
                await this.saveData("dailyWelfareVisitDate", day);
            }
            if (!this.isLogged) return "请先登录漫蛙";
            const response = await Network.get(`${this.baseUrl}/users/welfare`, {
                ...this.htmlHeaders(`${this.baseUrl}/ucenter`),
                "Cache-Control": "no-cache",
            });
            if (response.status === 401) return "漫蛙登录已失效，请重新登录";
            this.requireSuccess(response, "welfare");

            const document = new HtmlDocument(response.body);
            try {
                if (document.querySelector("#form-login")) {
                    return "漫蛙登录已失效，请重新登录";
                }
                const today = document.querySelector(`.sign_row .star[data-test="${this.checkinDay()}"]`);
                if (!today) return "福利页未找到今日签到状态";
                return today.classNames.includes("signedin") ? "今日已签到" : "今日未确认签到";
            } finally {
                document.dispose();
            }
        };

        // Assign the shared task before starting it, even if all host calls are synchronous.
        const request = Promise.resolve().then(visit).catch(() => "签到检查失败，请稍后手动重试");
        this.checkinRequest = request;
        try {
            return await request;
        } finally {
            this.checkinRequest = null;
        }
    }

    maybeAutoCheckin = async () => {
        try {
            if (this.checkinRequest || !this.isLogged || this.loadSetting("autoCheckin") !== true
                || this.loadData("dailyWelfareVisitDate") === this.checkinDay()) {
                return;
            }
            await this.visitWelfare();
        } catch (_) {
            // Sign-in must not interrupt browsing or source initialization.
        }
    }

    init() {
        return this.maybeAutoCheckin();
    }

    settings = {
        autoCheckin: {
            title: "每日自动检查签到（启动或使用时）",
            type: "switch",
            default: false,
        },
        checkinNow: {
            title: "检查今日签到",
            type: "callback",
            buttonText: "立即检查",
            callback: async () => {
                UI.showMessage(await this.visitWelfare());
            },
        },
    }

    favorites = {
        multiFolder: false,
        singleFolderForSingleComic: false,

        loadComics: async (page, folder) => {
            void this.maybeAutoCheckin();
            const pageIndex = Math.max(0, page - 1);
            const siteOffset = pageIndex * this.favoritePageSize;
            const bookshelfUrl = `${this.baseUrl}/bookshelf`;
            const favoriteCount = await this.loadFavoriteCount();
            if (favoriteCount === 0) {
                return { comics: [], maxPage: 0 };
            }
            const books = await this.loadFavoriteBooks(siteOffset, bookshelfUrl);
            const expectedLength = Math.min(
                this.favoritePageSize,
                Math.max(0, favoriteCount - siteOffset),
            );
            if (books.length !== expectedLength) {
                throw "收藏夹分页数据不一致";
            }

            const ids = new Set();
            const comics = books.map((book) => {
                const comic = this.parseFavoriteComic(book);
                if (ids.has(comic.id)) {
                    throw "收藏夹存在重复或空漫画 ID";
                }
                ids.add(comic.id);
                return comic;
            });

            return {
                comics,
                maxPage: Math.ceil(favoriteCount / this.favoritePageSize),
            };
        },

        updateCheck: {
            scanInterval: 43200,

            load: async (folderId) => {
                const favoriteCount = await this.loadFavoriteCount();
                if (favoriteCount === 0) {
                    return {
                        comics: [],
                        pageSize: this.favoritePageSize,
                        total: 0,
                    };
                }

                const bookshelfUrl = `${this.baseUrl}/bookshelf`;
                const comics = [];
                for (let offset = 0; offset < favoriteCount; offset += this.favoritePageSize) {
                    const books = await this.loadFavoriteBooks(offset, bookshelfUrl);
                    const expectedLength = Math.min(
                        this.favoritePageSize,
                        favoriteCount - offset,
                    );
                    if (books.length !== expectedLength) {
                        throw "收藏夹分页数据不一致";
                    }
                    for (const book of books) {
                        comics.push(this.parseFavoriteComic(book, true));
                    }
                }

                const ids = new Set();
                for (let index = 0; index < comics.length; index += 1) {
                    const comic = comics[index];
                    if (!comic.id || comic.id === "undefined" || ids.has(comic.id)) {
                        throw "收藏夹存在重复或空漫画 ID";
                    }
                    ids.add(comic.id);
                }
                if (comics.length !== favoriteCount) {
                    throw "收藏夹总数与分页数据不一致";
                }
                return {
                    comics,
                    pageSize: this.favoritePageSize,
                    total: comics.length,
                };
            },
        },

        addOrDelFavorite: async (comicId, folderId, isAdding, favoriteId) => {
            const response = await Network.post(
                `${this.baseUrl}/addfavor`,
                this.jsonHeaders(`${this.baseUrl}/book/${comicId}`),
                this.formEncode({
                    book_id: comicId,
                    val: isAdding ? 0 : 1,
                    folder_id: 0,
                }),
            );
            this.requireSuccess(response, "favorite update", true);
            const data = this.requireJsonSuccess(
                this.parseJson(response.body, "favorite update"),
                "favorite update",
                true,
            );
            const expected = isAdding ? 1 : 0;
            if (Number(data.isfavor) !== expected) {
                throw "收藏状态校验失败";
            }
            return "ok";
        },
    }

    readListPage = async (path, operation, parse) => {
        void this.maybeAutoCheckin();
        const response = await Network.get(`${this.baseUrl}${path}`, this.htmlHeaders());
        this.requireSuccess(response, operation);
        const document = new HtmlDocument(response.body);
        try {
            return parse(document);
        } finally {
            document.dispose();
        }
    }

    listCover = (value) => {
        const cover = typeof value === "string" ? value.trim() : "";
        if (!cover || /^(?:#|(?!https?:\/\/)[a-z][a-z0-9+.-]*:)/i.test(cover)
            || this.isPlaceholderCover(cover)
            || /(?:^|\/)imagecover3\.jpg(?:[?#]|$)/i.test(cover)) {
            return undefined;
        }
        return this.toStaticUrl(cover);
    }

    parseListCard = (card, {titleSelector, imageSelector, subtitleSelector, descSelector, fallbackTitleSelector}) => {
        const bookId = (element) => String(element?.attributes.href ?? "").match(
            /^(?:(?:https?:)?\/\/manwa\.me)?\/book\/(\d+)\/?(?:[?#].*)?$/i,
        )?.[1];
        const titleElement = card.querySelector(titleSelector);
        const titleLink = titleElement?.querySelector("a[href]");
        const link = [titleLink, titleElement, card].find(bookId)
            || card.querySelectorAll("a[href]").find(bookId);
        const id = bookId(link);
        const image = card.querySelector(imageSelector);
        const attrs = image?.attributes ?? {};
        const title = this.textOf(titleLink) || this.textOf(titleElement)
            || String(link?.attributes.title ?? "").trim()
            || String(attrs.alt ?? "").trim()
            || (fallbackTitleSelector ? this.textOf(card.querySelector(fallbackTitleSelector)) : "");
        if (!id || !title) {
            return null;
        }
        const cover = ["data-home-src", "data-src", "data-original", "src"]
            .map((key) => this.listCover(attrs[key])).find(Boolean) || "";
        return new Comic({
            id, title, cover,
            subtitle: subtitleSelector ? this.textOf(card.querySelector(subtitleSelector)) : undefined,
            description: descSelector ? this.textOf(card.querySelector(descSelector)) : undefined,
        });
    }

    parseListCards = (cards, selectors) => {
        const comics = new Map();
        for (const card of cards) {
            const comic = this.parseListCard(card, selectors);
            if (comic && !comics.has(comic.id)) {
                comics.set(comic.id, comic);
            }
        }
        return [...comics.values()];
    }

    categoryTarget = (label, param = null) => ({
        page: "category",
        attributes: {category: label, param},
    })

    parseRanking = (document) => {
        const cards = [];
        for (const info of document.querySelectorAll(".rank-list .rank-list-info")) {
            // The link and cover may be outside the info element, in the same card.
            for (let card = info; card && !card.classNames.includes("rank-list"); card = card.parent) {
                if (card.querySelector(".rank-list-cover-img")) {
                    cards.push(card);
                    break;
                }
            }
        }
        return this.parseListCards(cards, {
            titleSelector: ".rank-list-info-title, .rank-list-info h2, .rank-list-info h3, .rank-list-info h4, .rank-list-info a[href]",
            imageSelector: ".rank-list-cover-img",
            fallbackTitleSelector: ".rank-list-info",
        });
    }

    explore = [{
        title: "漫蛙推荐",
        type: "multiPartPage",
        load: () => this.readListPage("/", "home", (document) => {
            const parts = [];
            for (const list of document.querySelectorAll(".manga-list-2")) {
                const comics = this.parseListCards(list.children, {
                    titleSelector: ".manga-list-2-title",
                    imageSelector: ".manga-list-2-cover-img",
                    subtitleSelector: ".manga-list-2-tip",
                });
                if (!comics.length) {
                    continue;
                }
                const sectionTitle = (element) => {
                    if (!element) return "";
                    return this.textOf(element.classNames.includes("manga-list-title")
                        ? element : element.querySelector(".manga-list-title"));
                };
                const title = sectionTitle(list.previousElementSibling)
                    || sectionTitle(list.parent?.previousElementSibling)
                    || `推荐 ${parts.length + 1}`;
                parts.push({title, comics, viewMore: this.categoryTarget("全部漫画")});
            }
            const comics = this.parseRanking(document);
            if (comics.length) {
                parts.push({title: "排行榜", comics, viewMore: this.categoryTarget("排行榜", "ranking")});
            }
            if (!parts.length) {
                throw "未找到首页漫画列表";
            }
            return parts;
        }),
    }]

    category = {
        title: "漫蛙分类",
        parts: [{
            name: "浏览",
            type: "fixed",
            categories: [
                {label: "全部漫画", target: this.categoryTarget("全部漫画")},
                {label: "排行榜", target: this.categoryTarget("排行榜", "ranking")},
            ],
        }],
    }

    categoryComics = {
        optionLoader: async (_category, param) => {
            if (param === "ranking") return [];
            return this.readListPage("/booklist", "categories", this.parseCategoryOptions);
        },

        load: async (_category, param, options, page) => {
            if (param === "ranking") {
                if (page > 1) return {comics: [], maxPage: 1};
                return this.readListPage("/", "ranking", (document) => {
                    const comics = this.parseRanking(document);
                    if (!comics.length) throw "未找到排行榜";
                    return {comics, maxPage: 1};
                });
            }
            return this.loadCategoryComics(options, page);
        },
    }

    parseCategoryOptions = (document) => {
        if (!document.querySelector(".tags, .manga-list-2, #loadMore")) {
            throw "未找到分类页面";
        }
        const groups = [];
        for (const [key, selector, label, defaultValue] of [
            ["tag", ".tags", "标签", ""],
            ["end", ".end", "进度", ""],
            ["gender", ".gender", "受众", "-1"],
            ["has_full", ".has_full", "完整版", ""],
            ["area", ".area", "地区", ""],
            ["sort", ".sort", "排序", "-1"],
            ["level", ".level", "等级", ""],
        ]) {
            const values = new Map();
            const param = new RegExp(`[?&]${key}=([^&#]*)`);
            for (const link of document.querySelectorAll(`${selector} a[href]`)) {
                const raw = String(link.attributes.href ?? "").match(param)?.[1];
                const text = this.textOf(link);
                if (raw == null || !text) continue;
                try {
                    const value = decodeURIComponent(raw.replace(/\+/g, " "));
                    if (!values.has(value)) values.set(value, text);
                } catch (_) {
                    continue;
                }
            }
            // The host separates the option key and label at the first hyphen.
            const toOption = (value, text) => `${key}:${encodeURIComponent(value).replace(/-/g, "%2D")}-${text}`;
            const options = [toOption(defaultValue, values.get(defaultValue) || "默认")];
            for (const [value, text] of values) {
                if (value === defaultValue) continue;
                options.push(toOption(value, text));
            }
            if (options.length > 1) groups.push({label, options});
        }
        return groups;
    }

    loadCategoryComics = async (options, page) => {
        void this.maybeAutoCheckin();
        const filters = {tag: "", end: "", gender: -1, has_full: "", area: "", sort: -1, level: ""};
        for (const option of options ?? []) {
            const index = option.indexOf(":");
            if (index < 0) continue;
            const key = option.slice(0, index);
            if (Object.prototype.hasOwnProperty.call(filters, key)) {
                filters[key] = decodeURIComponent(option.slice(index + 1));
            }
        }
        const referer = `${this.baseUrl}/booklist?${this.formEncode(filters)}`;
        const response = await Network.get(
            `${this.baseUrl}/getBooks?${this.formEncode({page, ...filters})}`,
            this.jsonHeaders(referer),
        );
        this.requireSuccess(response, "category comics");
        const data = this.requireJsonSuccess(
            this.parseJson(response.body, "category comics"), "category comics",
        );
        if (!Array.isArray(data.books)) {
            throw "分类漫画列表无效";
        }
        const comics = new Map();
        for (const book of data.books) {
            if (book?.blocked === true) continue;
            const id = this.normalizeId(book?.id);
            const title = typeof book?.book_name === "string" ? book.book_name.trim() : "";
            if (!id || !/^\d+$/.test(id) || !title) {
                throw "分类漫画条目无效";
            }
            if (!comics.has(id)) {
                comics.set(id, new Comic({
                    id, title, cover: this.listCover(book.cover_url) || "",
                    subtitle: typeof book.last_chapter === "string" ? book.last_chapter : undefined,
                    description: typeof book.summary === "string" ? book.summary : undefined,
                    tags: typeof book.tags === "string"
                        ? this.unique(book.tags.split(/[,，]/).map((value) => value.trim())) : [],
                }));
            }
        }
        // The endpoint doesn't give a total or a verified fixed page size.
        return {comics: [...comics.values()], maxPage: data.books.length ? undefined : page};
    }

    search = {
        load: async (keyword, _options, page) => {
            const query = String(keyword ?? "").trim();
            if (!query) {
                return {comics: [], maxPage: 1};
            }
            const path = `/search?${this.formEncode({keyword: query, page})}`;
            return this.readListPage(path, "search", (document) => {
                const pager = document.querySelector(".pagination2");
                const currentPage = this.textOf(pager?.querySelector("li.active > a"));
                if (currentPage && (!/^\d+$/.test(currentPage) || Number(currentPage) !== page)) {
                    throw "搜索结果页码与请求不符";
                }
                const nextLink = pager?.querySelectorAll("a[data-page]").find(
                    (link) => /^下一[页頁]$/.test(this.textOf(link).replace(/\s+/g, "")),
                );
                if (nextLink && Number(nextLink.attributes["data-page"]) !== page + 1) {
                    throw "搜索下一页页码无效";
                }

                const lists = document.querySelectorAll(".book-list");
                if (!lists.length && (pager || !document.querySelector(".search-label-item, .search-history-content"))) {
                    throw "未找到搜索结果区域";
                }
                const comics = this.parseListCards(lists.flatMap((list) => list.children), {
                    titleSelector: ".book-list-info-title",
                    imageSelector: ".book-list-cover-img",
                    descSelector: ".book-list-info-desc",
                });
                if (!comics.length && (nextLink || document.querySelector(".book-list .book-list-info-title"))) {
                    throw "搜索结果列表无效";
                }
                // The numbered links are a sliding window, not the total page count.
                return {comics, maxPage: nextLink ? undefined : page};
            });
        },
    }

    readComments = async (comicId, chapterId, page, replyTo) => {
        if (replyTo != null && String(replyTo).trim()) {
            return {comments: []};
        }
        const chapter = chapterId == null ? "" : String(chapterId).trim();
        const referer = chapter
            ? `${this.baseUrl}/chapter/${encodeURIComponent(chapter)}`
            : `${this.baseUrl}/book/${encodeURIComponent(String(comicId))}`;
        const params = this.formEncode({
            comment_id: 0, chapter_id: chapter, book_id: comicId,
            sort: 1, page: Math.max(0, page - 1),
        });
        const response = await Network.get(`${this.baseUrl}/commentmore?${params}`, this.jsonHeaders(referer));
        this.requireSuccess(response, "comments", true);
        const data = this.requireJsonSuccess(this.parseJson(response.body, "comments"), "comments", true);
        if (!Array.isArray(data.list)) {
            throw "评论列表无效";
        }
        const items = chapter
            ? data.list.filter((item) => String(item?.chapter_id) === chapter)
            : data.list;
        return {
            comments: items.map((item) => new Comment({
                userName: item.nick_name || item.username || "匿名用户",
                avatar: item.cover || undefined,
                content: item.content || "",
                time: item.create_time || undefined,
                score: Number(item.vote_like || 0) - Number(item.vote_dislike || 0),
            })),
        };
    }

    parseDetailMetadata = (document) => {
        const metadata = {
            authors: [],
            status: "",
            region: "",
            category: "",
        };
        for (const item of document.querySelectorAll("p.detail-main-info-author")) {
            const field = this.textOf(
                item.querySelector(".detail-main-info-author-field"),
            ).replace(/[：:]\s*$/, "");
            const valueElement = item.querySelector(".detail-main-info-value");
            if (!field || !valueElement) {
                continue;
            }
            const links = valueElement.querySelectorAll("a");
            const values = links.length > 0
                ? links.map((link) => this.textOf(link))
                : [this.textOf(valueElement)];
            const cleanValues = this.unique(values);
            if (/作者/.test(field)) {
                metadata.authors.push(...cleanValues);
            } else if (/状态/.test(field)) {
                metadata.status = cleanValues[0] || "";
            } else if (/地区/.test(field)) {
                metadata.region = cleanValues[0] || "";
            } else if (/类别|分类/.test(field)) {
                metadata.category = cleanValues[0] || "";
            }
        }
        metadata.authors = this.unique(metadata.authors);
        return metadata;
    }

    comic = {
        loadInfo: async (id) => {
            void this.maybeAutoCheckin();
            const comicId = String(id);
            const response = await Network.get(
                `${this.baseUrl}/book/${encodeURIComponent(comicId)}`,
                this.htmlHeaders(),
            );
            this.requireSuccess(response, "comic details");

            const document = new HtmlDocument(response.body);
            try {
                const title = this.textOf(
                    document.querySelector("h1.detail-main-info-title"),
                );
                if (!title) {
                    throw "未找到漫画标题";
                }

                const coverImage = document.querySelector(".detail-main-cover img");
                const coverAttributes = coverImage ? coverImage.attributes : {};
                let cover = String(coverAttributes["data-original"] || "").trim();
                if (!cover) {
                    const fallback = String(coverAttributes.src || "").trim();
                    if (fallback && !this.isPlaceholderCover(fallback)) {
                        cover = fallback;
                    }
                }
                cover = this.toStaticUrl(cover);
                if (!cover || this.isPlaceholderCover(cover)) {
                    throw "未找到漫画封面";
                }

                const metadata = this.parseDetailMetadata(document);
                const contentTags = this.unique(
                    document.querySelectorAll("#detail .info-tag-span")
                        .map((tag) => this.textOf(tag)),
                );
                const description = this.textOf(
                    document.querySelector("p.detail-desc"),
                ) || undefined;
                const rawUpdateTime = this.textOf(
                    document.querySelector(".detail-list-title-3"),
                );
                const updateTime = rawUpdateTime
                    .replace(/\s*更新\s*$/, "")
                    .trim() || undefined;
                const rawCommentCount = this.textOf(
                    document.querySelector(".commentcount"),
                );
                const commentCount = /^\d+$/.test(rawCommentCount)
                    ? Number(rawCommentCount)
                    : undefined;
                const favoriteElement = document.querySelector("#addfavor[data-val]");
                const favoriteValue = favoriteElement
                    ? favoriteElement.attributes["data-val"]
                    : undefined;
                const isFavorite = favoriteValue === "1"
                    ? true
                    : favoriteValue === "0"
                        ? false
                        : null;

                const chapters = new Map();
                for (const chapter of document.querySelectorAll(
                    'a.chapteritem[href^="/chapter/"]',
                )) {
                    const attributes = chapter.attributes || {};
                    let href = String(attributes.href || "").split(/[?#]/)[0];
                    href = href.replace(/\/+$/, "");
                    const chapterId = href.substring(href.lastIndexOf("/") + 1);
                    if (!chapterId || chapters.has(chapterId)) {
                        continue;
                    }
                    const chapterTitle = String(attributes.title || "").trim()
                        || this.textOf(chapter)
                        || chapterId;
                    chapters.set(chapterId, chapterTitle);
                }

                return new ComicDetails({
                    title,
                    subtitle: metadata.authors.join("、") || undefined,
                    cover,
                    description,
                    tags: {
                        "作者": metadata.authors,
                        "状态": metadata.status ? [metadata.status] : [],
                        "地区": metadata.region ? [metadata.region] : [],
                        "类别": metadata.category ? [metadata.category] : [],
                        "标签": contentTags,
                    },
                    chapters,
                    isFavorite,
                    commentCount,
                    updateTime,
                    url: `${this.baseUrl}/book/${comicId}`,
                });
            } finally {
                document.dispose();
            }
        },

        loadEp: async (comicId, epId) => {
            void this.maybeAutoCheckin();
            if (epId == null || !String(epId).trim()) {
                throw "无效章节 ID";
            }
            const chapterId = String(epId);
            const response = await Network.get(
                `${this.baseUrl}/chapter/${encodeURIComponent(chapterId)}`,
                this.htmlHeaders(),
            );
            this.requireSuccess(response, "chapter");

            const document = new HtmlDocument(response.body);
            let sortedImages;
            try {
                const images = [];
                let index = 0;
                for (const image of document.querySelectorAll(
                    ".img-content img.content-img[data-r-src]",
                )) {
                    const attributes = image.attributes || {};
                    const url = this.toStaticUrl(attributes["data-r-src"]);
                    if (!url) {
                        continue;
                    }
                    const sortText = String(attributes["data-sort"] || "").trim();
                    const sort = Number(sortText);
                    images.push({
                        url,
                        sort: sortText && Number.isFinite(sort) ? sort : Infinity,
                        index: index++,
                    });
                }
                images.sort((left, right) => left.sort - right.sort || left.index - right.index);
                sortedImages = images.map((image) => image.url);
            } finally {
                document.dispose();
            }
            if (sortedImages.length === 0) {
                throw "章节没有可用图片";
            }
            return { images: sortedImages };
        },

        onImageLoad: (url) => {
            const key = Convert.encodeUtf8("my2ecret782ecret");
            return {
                url,
                onResponse: (encryptedBytes) => Convert.decryptAesCbc(
                    encryptedBytes,
                    key,
                    key,
                ),
            };
        },

        onThumbnailLoad: (url) => ({
            url: this.toStaticUrl(url),
        }),

        loadComments: (comicId, _subId, page, replyTo) => this.readComments(comicId, null, page, replyTo),

        loadChapterComments: async (comicId, epId, page, replyTo) => {
            const chapterId = this.normalizeId(epId);
            if (!chapterId || !/^\d+$/.test(chapterId)) {
                throw "无效章节 ID";
            }
            return this.readComments(comicId, chapterId, page, replyTo);
        },
    }
}
