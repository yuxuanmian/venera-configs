(() => {
    const BASE_URL = "https://manwa.me";
    const STATIC_BASE_URL = "https://mwappimgs.cc";
    const PAGE_SIZE = 15;
    const PARSER_VERSION = "manwa-scanning-v1";
    const IDENTITY_SCHEME = "manwa-username-v1";
    const WAIT_TEXT = /请等待|稍后再试|访问过于频繁|系统繁忙|服务繁忙/i;
    const LOGIN_TEXT = /请先登录|尚未登录|登录后才能|登陆后才能|登录页|登陆页/i;

    const structuredError = (code, safeMessage, retryAfterSeconds) => {
        const payload = {code, safeMessage};
        if (retryAfterSeconds != null) {
            payload.retryAfterSeconds = retryAfterSeconds;
        }
        if (typeof Scanning !== "undefined"
            && Scanning
            && typeof Scanning.error === "function") {
            const result = Scanning.error(payload);
            throw result;
        }
        const error = new Error(safeMessage);
        Object.assign(error, payload);
        throw error;
    };

    const isStructuredError = (error) => Boolean(
        error && typeof error.code === "string" && typeof error.safeMessage === "string",
    );

    const throwContractDrift = () => structuredError(
        "contract_drift",
        "页面结构不符合已批准合同",
    );

    const throwIncompleteSnapshot = () => structuredError(
        "incomplete_snapshot",
        "收藏快照完整性校验失败",
    );

    const throwSnapshotChanged = () => structuredError(
        "snapshot_changed",
        "收藏快照在扫描期间发生变化",
    );

    const textOf = (element) => {
        if (!element || element.text == null) {
            return "";
        }
        return String(element.text).trim();
    };

    const asArray = (value) => {
        if (value == null) {
            return [];
        }
        return Array.from(value);
    };

    const dispose = (document) => {
        if (document && typeof document.dispose === "function") {
            document.dispose();
        }
    };

    const bodyText = (response) => String(response && response.body || "");

    const isLoginPage = (response) => {
        const body = bodyText(response);
        const url = String(response && (response.url || response.finalUrl) || "");
        return /\/login(?:\.html)?(?:[/?#]|$)/i.test(url)
            || /id=["']form-login["']/i.test(body)
            || LOGIN_TEXT.test(body);
    };

    const isWaitPage = (response) => WAIT_TEXT.test(bodyText(response));

    const headerValue = (response, name) => {
        const headers = response && response.headers;
        if (!headers) {
            return null;
        }
        const expected = name.toLowerCase();
        if (typeof headers.get === "function") {
            return headers.get(name) || headers.get(expected) || null;
        }
        for (const key of Object.keys(headers)) {
            if (key.toLowerCase() === expected) {
                return headers[key];
            }
        }
        return null;
    };

    const retryAfter = (response) => {
        const value = headerValue(response, "retry-after");
        if (value == null || String(value).trim() === "") {
            return null;
        }
        const seconds = Number(String(value).trim());
        return Number.isInteger(seconds) && seconds >= 0 && seconds <= 604800
            ? seconds
            : null;
    };

    const checkResponse = (response, operation) => {
        const status = response && response.status;
        const retrySeconds = retryAfter(response);
        if (status === 401 || status === 403 || isLoginPage(response)) {
            structuredError("auth_required", "登录状态无效");
        }
        if (status === 429 || retrySeconds != null) {
            structuredError(
                "rate_limited",
                "源站请求受到限流",
                retrySeconds == null ? undefined : retrySeconds,
            );
        }
        if (isWaitPage(response)) {
            structuredError("transient", "源站暂时不可用");
        }
        if (typeof status !== "number" || status < 200 || status >= 300) {
            if (status >= 500 || status == null) {
                structuredError("transient", "源站暂时不可用");
            }
            structuredError("transient", `${operation} 暂时不可用`);
        }
        return response;
    };

    const request = async (method, url, headers) => {
        try {
            const response = method === "GET"
                ? await Network.get(url, headers)
                : await Network.request(method, url, headers);
            return checkResponse(response, "源站请求");
        } catch (error) {
            if (isStructuredError(error)) {
                throw error;
            }
            structuredError("transient", "源站暂时不可用");
        }
    };

    const htmlHeaders = (referer) => {
        const headers = {
            Accept: "text/html,application/xhtml+xml",
        };
        if (referer) {
            headers.Referer = referer;
        }
        return headers;
    };

    const jsonHeaders = (referer) => ({
        Accept: "application/json, text/plain, */*",
        "X-Requested-With": "XMLHttpRequest",
        Referer: referer,
    });

    const openDocument = (response) => {
        try {
            return new HtmlDocument(bodyText(response));
        } catch (error) {
            structuredError("contract_drift", "页面结构不符合已批准合同");
        }
    };

    const normalizeId = (value) => {
        if (typeof value !== "string" && typeof value !== "number") {
            return null;
        }
        const normalized = String(value).trim();
        if (!normalized || normalized === "undefined" || normalized === "null"
            || normalized === "NaN") {
            return null;
        }
        return normalized;
    };

    const normalizeCover = (value) => {
        if (value == null) {
            return null;
        }
        const url = String(value).trim();
        if (!url) {
            return null;
        }
        const legacy = url.match(/^https?:\/\/manwa\.me(\/static\/.*)$/i);
        if (legacy) {
            return `${STATIC_BASE_URL}${legacy[1]}`;
        }
        if (/^https?:\/\//i.test(url)) {
            return url;
        }
        if (url.startsWith("//")) {
            return `https:${url}`;
        }
        if (url.startsWith("/")) {
            return `${STATIC_BASE_URL}${url}`;
        }
        return `${STATIC_BASE_URL}/${url}`;
    };

    const parseJson = (response) => {
        const body = bodyText(response).trim();
        if (!body || /^<!doctype\b|^<html\b|^<\?xml/i.test(body) || isWaitPage(response)) {
            if (isWaitPage(response)) {
                structuredError("transient", "源站暂时不可用");
            }
            throwContractDrift();
        }
        try {
            return JSON.parse(body);
        } catch (error) {
            if (WAIT_TEXT.test(body)) {
                structuredError("transient", "源站暂时不可用");
            }
            throwContractDrift();
        }
    };

    const parseFavoriteCount = (response) => {
        const document = openDocument(response);
        try {
            const node = document.querySelector(".favorite-count");
            const text = textOf(node).replace(/\s+/g, "");
            const match = text.match(/^(\d+)\/(\d+)$/);
            if (!match) {
                if (WAIT_TEXT.test(bodyText(response))) {
                    structuredError("rate_limited", "源站请求受到限流");
                }
                throwContractDrift();
            }
            const count = Number(match[1]);
            if (!Number.isSafeInteger(count) || count < 0 || count > 20000) {
                throwContractDrift();
            }
            return count;
        } finally {
            dispose(document);
        }
    };

    const parseUcenter = (response) => {
        const document = openDocument(response);
        try {
            const root = document.querySelector(".center-main-info-right");
            if (!root) {
                throwContractDrift();
            }
            let username = null;
            let displayName = "";
            for (const node of asArray(root.querySelectorAll("p.center-main-info-title"))) {
                const text = textOf(node);
                const className = String(node.attributes && node.attributes.class || "");
                if (!text || /password|密码|邮箱|验证|cloudflare/i.test(className + text)) {
                    continue;
                }
                const match = text.match(/^用户名\s*[:：]\s*(.+)$/);
                if (match) {
                    username = String(match[1]).trim();
                    continue;
                }
                if (!displayName && !/^用户名\s*[:：]/.test(text)) {
                    displayName = text;
                }
            }
            if (!username || /[\u0000-\u001f\u007f]/.test(username) || username.length > 512) {
                throwContractDrift();
            }
            return {username, displayName};
        } finally {
            dispose(document);
        }
    };

    const parseLevel = (response) => {
        const document = openDocument(response);
        try {
            const root = document.querySelector(".center-main-info");
            const levelNode = root
                && root.querySelector(".detail-list-comment-lv span");
            const match = textOf(levelNode).match(/^Lv\s*(\d+)$/);
            if (!match) {
                throwContractDrift();
            }
            const accountLevel = Number(match[1]);
            if (!Number.isSafeInteger(accountLevel) || accountLevel < 0) {
                throwContractDrift();
            }
            return accountLevel;
        } finally {
            dispose(document);
        }
    };

    const probeAccount = async (input = {}) => {
        const ucenterResponse = await request(
            "GET",
            `${BASE_URL}/ucenter`,
            htmlHeaders(),
        );
        const account = parseUcenter(ucenterResponse);
        const welfareResponse = await request(
            "GET",
            `${BASE_URL}/users/welfare`,
            htmlHeaders(`${BASE_URL}/ucenter`),
        );
        const accountLevel = parseLevel(welfareResponse);
        return {
            identity: {
                scheme: IDENTITY_SCHEME,
                value: account.username,
            },
            display: {
                name: account.displayName || account.username,
                secondary: account.username,
            },
            attributes: {accountLevel},
            visibilityScope: `manwa:level:${accountLevel}`,
            sessionPatch: null,
        };
    };

    const validateCheckpoint = (checkpoint) => {
        if (checkpoint == null) {
            return null;
        }
        if (typeof checkpoint !== "object" || Array.isArray(checkpoint)) {
            throwContractDrift();
        }
        if (checkpoint.parserVersion !== PARSER_VERSION
            || checkpoint.pageSize !== PAGE_SIZE
            || !Number.isSafeInteger(checkpoint.total)
            || checkpoint.total < 0
            || !Number.isSafeInteger(checkpoint.nextOffset)
            || checkpoint.nextOffset < 0
            || checkpoint.nextOffset > checkpoint.total) {
            throwContractDrift();
        }
        if (checkpoint.boundary != null) {
            const boundary = checkpoint.boundary;
            if (typeof boundary !== "object" || Array.isArray(boundary)
                || !Array.isArray(boundary.firstIds)
                || !Array.isArray(boundary.lastIds)
                || boundary.firstIds.length > 3
                || boundary.lastIds.length > 3) {
                throwContractDrift();
            }
        }
        return checkpoint;
    };

    const makeBoundary = (books) => {
        const ids = books.map((book) => normalizeId(book && book.id));
        return {
            firstIds: ids.slice(0, 3),
            lastIds: ids.slice(-3),
        };
    };

    const equalBoundary = (left, right) => JSON.stringify(left) === JSON.stringify(right);

    const validateBook = (book) => {
        if (book == null || typeof book !== "object" || Array.isArray(book)) {
            throwIncompleteSnapshot();
        }
        const comicId = normalizeId(book.id);
        if (!comicId || typeof book.book_name !== "string" || !book.book_name.trim()) {
            throwIncompleteSnapshot();
        }
        const lastChapter = book.last_chapter;
        if (!lastChapter || typeof lastChapter !== "object" || Array.isArray(lastChapter)) {
            throwIncompleteSnapshot();
        }
        const normalChapterId = normalizeId(lastChapter.id);
        if (!normalChapterId || typeof book.is_new !== "boolean") {
            throwIncompleteSnapshot();
        }
        if (book.full_last_chapter != null
            && (typeof book.full_last_chapter !== "object"
                || Array.isArray(book.full_last_chapter))) {
            throwIncompleteSnapshot();
        }
        let fullChapterId = null;
        if (book.full_last_chapter != null) {
            fullChapterId = normalizeId(book.full_last_chapter.id);
            if (fullChapterId && typeof book.full_is_new !== "boolean") {
                throwIncompleteSnapshot();
            }
        }
        return {comicId, normalChapterId, fullChapterId};
    };

    const normalizeItem = (book) => {
        const validated = validateBook(book);
        const lastChapter = book.last_chapter;
        const normalIsNew = book.is_new;
        const fullIsNew = validated.fullChapterId ? book.full_is_new : null;
        const favoriteUpdate = {
            sourceUnread: Boolean(normalIsNew || fullIsNew),
            metadata: {
                normalIsNew,
                fullIsNew,
                fullLatestChapterId: validated.fullChapterId || null,
            },
        };
        // A normal-only snapshot has a standard comparable fact. Full
        // content is a different visibility variant, so it remains an
        // opaque fallback and is never exposed as a marker scheme.
        if (validated.fullChapterId) {
            favoriteUpdate.marker = JSON.stringify([
                "manwa-full-v1",
                validated.normalChapterId,
                validated.fullChapterId,
            ]);
        } else {
            favoriteUpdate.state = {
                latestChapterId: validated.normalChapterId,
            };
        }
        return {
            comicId: validated.comicId,
            favoriteUpdate,
        };
    };

    const parseFavoritePage = (response, expectedLength) => {
        const data = parseJson(response);
        if (!data || data.err !== 0 || !Array.isArray(data.books)) {
            if (data && typeof data.msg === "string"
                && /未登录|登录|登陆|session|expired/i.test(data.msg)) {
                structuredError("auth_required", "登录状态无效");
            }
            if (data && typeof data.msg === "string" && WAIT_TEXT.test(data.msg)) {
                structuredError("transient", "源站暂时不可用");
            }
            structuredError("transient", "收藏接口暂时不可用");
        }
        if (data.books.length !== expectedLength) {
            throwIncompleteSnapshot();
        }
        const ids = new Set();
        for (const book of data.books) {
            const validated = validateBook(book);
            if (ids.has(validated.comicId)) {
                throwIncompleteSnapshot();
            }
            ids.add(validated.comicId);
        }
        return data.books;
    };

    const getFavoriteCount = async (context) => {
        if (context.exhausted()) {
            return null;
        }
        context.consume();
        const response = await request(
            "GET",
            `${BASE_URL}/bookshelf`,
            htmlHeaders(),
        );
        return parseFavoriteCount(response);
    };

    const getFavoritePage = async (context, offset, total) => {
        if (context.exhausted()) {
            return null;
        }
        context.consume();
        const bookshelfUrl = `${BASE_URL}/bookshelf`;
        const response = await request(
            "GET",
            `${BASE_URL}/getfavors?page=${offset}`
                + "&showOnlyUpdated=-1&isEnd=-1&isFullVersion=-1"
                + "&order=1&order_type=0&folder_id=0",
            jsonHeaders(bookshelfUrl),
        );
        const expectedLength = Math.min(PAGE_SIZE, total - offset);
        return parseFavoritePage(response, expectedLength);
    };

    const makeContext = (budget) => {
        const maxRequests = Number.isSafeInteger(budget.maxRequests)
            ? budget.maxRequests
            : 4;
        const maxItems = Number.isSafeInteger(budget.maxItems)
            ? budget.maxItems
            : 200;
        if (maxRequests < 1 || maxItems < 1) {
            structuredError("extension_failure", "扫描预算无效");
        }
        const deadline = budget.deadlineAt == null ? null : Date.parse(budget.deadlineAt);
        if (budget.deadlineAt != null && !Number.isFinite(deadline)) {
            structuredError("extension_failure", "扫描截止时间无效");
        }
        let requests = 0;
        return {
            maxItems,
            consume: () => { requests += 1; },
            exhausted: () => requests >= maxRequests
                || (deadline != null && Date.now() >= deadline),
        };
    };

    const makeCheckpoint = (total, nextOffset, boundary) => ({
        total,
        pageSize: PAGE_SIZE,
        nextOffset,
        boundary,
        parserVersion: PARSER_VERSION,
    });

    const scanFavoriteSnapshotSlice = async (input = {}) => {
        const context = makeContext(input.budget || {});
        const checkpoint = validateCheckpoint(input.checkpoint);
        const account = input.account || {};
        const visibilityScope = String(account.visibilityScope || "");
        if (!/^manwa:level:\d+$/.test(visibilityScope)) {
            structuredError("extension_failure", "账号可见范围无效");
        }

        let total = checkpoint ? checkpoint.total : null;
        let nextOffset = checkpoint ? checkpoint.nextOffset : 0;
        let boundary = checkpoint ? checkpoint.boundary : null;
        const items = [];
        const itemIds = new Set();

        if (total == null) {
            total = await getFavoriteCount(context);
            if (total == null) {
                return {
                    expectedTotal: null,
                    items,
                    complete: false,
                    checkpoint: makeCheckpoint(0, 0, null),
                    sessionPatch: null,
                };
            }
        }

        if (total === 0 && boundary == null) {
            boundary = {firstIds: [], lastIds: []};
        }

        while (nextOffset < total && items.length < context.maxItems && !context.exhausted()) {
            const books = await getFavoritePage(context, nextOffset, total);
            if (books == null) {
                break;
            }
            if (nextOffset === 0 && boundary == null) {
                boundary = makeBoundary(books);
            }
            for (const book of books) {
                const item = normalizeItem(book);
                if (itemIds.has(item.comicId)) {
                    throwIncompleteSnapshot();
                }
                itemIds.add(item.comicId);
                items.push(item);
            }
            nextOffset = Math.min(total, nextOffset + PAGE_SIZE);
        }

        if (nextOffset < total || context.exhausted()) {
            return {
                expectedTotal: total,
                items,
                complete: false,
                checkpoint: makeCheckpoint(total, nextOffset, boundary),
                sessionPatch: null,
            };
        }

        // The final count and first-page boundary are deliberately separate requests.
        // They are the source contract's end-of-snapshot consistency check.
        const finalCount = await getFavoriteCount(context);
        if (finalCount == null) {
            return {
                expectedTotal: total,
                items,
                complete: false,
                checkpoint: makeCheckpoint(total, nextOffset, boundary),
                sessionPatch: null,
            };
        }
        if (finalCount !== total) {
            throwSnapshotChanged();
        }
        if (total > 0) {
            const firstPage = await getFavoritePage(context, 0, total);
            if (firstPage == null) {
                return {
                    expectedTotal: total,
                    items,
                    complete: false,
                    checkpoint: makeCheckpoint(total, nextOffset, boundary),
                    sessionPatch: null,
                };
            }
            if (!equalBoundary(boundary, makeBoundary(firstPage))) {
                throwSnapshotChanged();
            }
        }
        if (checkpoint == null && items.length !== total) {
            throwIncompleteSnapshot();
        }
        return {
            expectedTotal: total,
            items,
            complete: true,
            checkpoint: null,
            sessionPatch: null,
        };
    };

    const extension = {
        extensionId: "manwa.scanning",
        artifactId: "manwa",
        sourceKey: "manwa",
        fileName: "manwa.js",
        apiVersion: 1,
        capabilities: {
            scanning: {
                version: 1,
                probeAccount,
                scanFavoriteSnapshotSlice,
            },
        },
    };

    if (typeof SourceServerExtensions !== "undefined"
        && SourceServerExtensions
        && typeof SourceServerExtensions.register === "function") {
        SourceServerExtensions.register(extension);
    }

    if (typeof module !== "undefined" && module && module.exports) {
        module.exports = extension;
    }
})();
