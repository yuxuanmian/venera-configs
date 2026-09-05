/** @type {import('./_venera_.js')} */
class Manwa extends ComicSource {
    name = "漫蛙"

    key = "manwa"

    version = "1.0.6"

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
                (value) => String(value || "").trim() ? null : "请输入验证码",
                captcha.body,
            );
            if (captchaText == null || !String(captchaText).trim()) {
                throw "已取消验证码输入";
            }

            const response = await Network.post(
                `${this.baseUrl}/login`,
                this.loginHeaders(),
                this.formEncode({
                    username: account,
                    password: pwd,
                    captcha: String(captchaText).trim(),
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
        },
    }

    favorites = {
        multiFolder: false,
        singleFolderForSingleComic: false,

        loadComics: async (page, folder) => {
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

        loadComments: async (comicId, subId, page, replyTo) => {
            if (replyTo != null && String(replyTo).trim()) {
                return { comments: [] };
            }
            const sitePage = Math.max(0, page - 1);
            const bookUrl = `${this.baseUrl}/book/${comicId}`;
            const response = await Network.get(
                `${this.baseUrl}/commentmore?comment_id=0&chapter_id=`
                + `&book_id=${encodeURIComponent(String(comicId))}&sort=1&page=${sitePage}`,
                this.jsonHeaders(bookUrl),
            );
            this.requireSuccess(response, "comments", true);
            const data = this.requireJsonSuccess(
                this.parseJson(response.body, "comments"),
                "comments",
                true,
            );
            if (!Array.isArray(data.list)) {
                throw "评论列表无效";
            }
            return {
                comments: data.list.map((item) => new Comment({
                    userName: item.nick_name || item.username || "匿名用户",
                    avatar: item.cover || undefined,
                    content: item.content || "",
                    time: item.create_time || undefined,
                    score: Number(item.vote_like || 0) - Number(item.vote_dislike || 0),
                })),
            };
        },
    }
}
