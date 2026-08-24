# Manwa 接口与 Venera 适配说明

> 本文依据 2026-08-23 的本地抓包材料整理，描述的是当时观察到的行为，不代表站点的长期协议承诺。上线前应使用自己的测试账号重新验证。
>
> 原始抓包含有账号、会话 Cookie，以及评论中的个人信息。本文件已脱敏；不要把原始请求头、Cookie、账号密码、IP 或评论者的设备信息提交到仓库、日志或 Issue。

## 适配范围与结论

| 功能 | 已观察到的数据来源 | 最小适配状态 |
| --- | --- | --- |
| 登录与图片验证码 | 登录 HTML、验证码图片、登录 JSON | 可实现 |
| 收藏夹浏览 | 收藏页 HTML 和 JSON 列表 | 可实现；站点页码从 0 开始，Venera 页码需减 1 |
| 收藏/取消收藏 | 详情页内嵌脚本 | 可实现，参数方向属于前端行为推定，需测试账号确认 |
| 漫画详情与章节目录 | 服务端渲染 HTML | 可实现；全部章节均在 HTML 中 |
| 阅读 | 章节 HTML、图片地址与响应转换规则 | 可实现 |
| 漫画评论读取 | JSON 评论列表 | 可实现；站点页码从 0 开始，Venera 页码需减 1 |
| 评论发布、回复、点赞/点踩 | 未抓到对应请求 | 暂不实现相应 Venera 回调 |

本文只覆盖当前目标所需的登录、收藏夹、详情、阅读和评论读取；发现页与搜索不在范围内。

## 通用约定

### 域名与 Cookie

| 用途 | 地址 |
| --- | --- |
| 站点页面与 JSON 接口 | <code>https://manwa.me</code> |
| 静态资源与图片地址 | 抓包中为 <code>https://mwappimgs.cc</code>，以 HTML 中返回的绝对地址为准 |

在 Venera 源中通过 <code>Network</code> 发请求，让应用的 Cookie Jar 管理该站点 Cookie。不要手动拼接 Cookie 头，也不要持久化或打印登录响应中的认证 Cookie。

抓包中的 <code>sec-ch-ua</code>、<code>sec-fetch-*</code>、统计 Cookie 和广告 Cookie 都是浏览器噪音，不应照抄。已观察到的 XHR 接口会带 <code>X-Requested-With: XMLHttpRequest</code>、合适的 Referer 和 JSON 相关的 Accept；如果站点改为校验这些头，只补充实际需要的最小集合。

### Venera 回调对应关系

| 站点能力 | Venera 源字段/回调 |
| --- | --- |
| 登录 | <code>account.login</code> |
| 收藏夹 | <code>favorites.loadComics</code> 或 <code>favorites.loadNext</code> |
| 收藏夹完整更新检查 | <code>favorites.updateCheck.load</code>；固定 15 条一页，返回完整快照 |
| 收藏状态切换 | <code>favorites.addOrDelFavorite</code> |
| 详情 | <code>comic.loadInfo</code> |
| 章节图片列表 | <code>comic.loadEp</code> |
| 加密图片响应处理 | <code>comic.onImageLoad</code> 的 <code>onResponse</code> |
| 详情页评论 | <code>comic.loadComments</code> |

对于当前证据不足的能力，不声明回调比返回一个会失败的回调更好：例如未抓到发布评论接口时，不实现 <code>sendComment</code>。

## 登录与验证码

### <code>GET /login.html</code>

登录页的表单标识为 <code>#form-login</code>，字段名如下：

| 字段 | 含义 |
| --- | --- |
| <code>username</code> | 账号 |
| <code>password</code> | 密码 |
| <code>captcha</code> | 用户输入的图片验证码文本 |

页面中的验证码图片为：

~~~text
GET /captcha
~~~

页面在刷新验证码时会改为 <code>/captcha?rnd=&lt;随机值&gt;</code>，因此 Venera 源也应添加时间戳或随机数以避开图片缓存。验证码响应体是二进制图片，具体 MIME 类型未记录，不能假设它一定是 PNG 或 JPEG。

建议流程：

1. 先请求登录页，建立当前域名的初始会话。
2. 通过 <code>Network.fetchBytes('GET', captchaUrl, ...)</code> 获取验证码的 ArrayBuffer。
3. 使用 <code>UI.showInputDialog</code> 展示该字节数组，由用户手工输入验证码。
4. 以表单编码提交账号、密码和验证码。
5. 根据 JSON 中的 <code>err</code> 判断结果；失败时展示 <code>msg</code>、重新获取验证码，不要复用旧图。

### <code>POST /login</code>

~~~text
Content-Type: application/x-www-form-urlencoded; charset=UTF-8
X-Requested-With: XMLHttpRequest
Origin: https://manwa.me
Referer: https://manwa.me/login.html

username=<账号>&password=<密码>&captcha=<验证码>
~~~

已观察到的响应结构：

~~~json
{ "err": 0, "msg": "登录成功" }
~~~

失败样例的 <code>err</code> 为非零，<code>msg</code> 为可展示的错误信息。成功与失败均可能更新当前站点的会话 Cookie，由 Cookie Jar 接收即可。

网页端在失败后会清掉当前站点的会话 Cookie。源实现不应因此清空全局 Cookie；如果反复遇到失效验证码，可只重置该站点会话后重新走登录页和验证码流程。

## 收藏夹

### <code>GET /bookshelf</code>

收藏夹页面是 HTML。元素 <code>.favorite-count</code> 的文本形如：

~~~text
<已收藏数>/<收藏上限>
~~~

它可用于计算收藏夹总页数。例如 <code>146/800</code> 中左侧 <code>146</code> 是已收藏总数，右侧 <code>800</code> 是收藏上限。需要先去除空白，再按 <code>/</code> 拆分。

### <code>GET /getfavors</code>

初始抓包：

~~~text
GET /getfavors?page=0&showOnlyUpdated=-1&isEnd=-1&isFullVersion=-1&order=1&order_type=0&folder_id=0
~~~

参数的已观察含义：

| 参数 | 已观察值 | 说明 |
| --- | --- | --- |
| <code>page</code> | <code>0</code>、<code>15</code>、<code>30</code>… | **记录偏移量，不是页号**。每次偏移 15 个收藏项。 |
| <code>showOnlyUpdated</code> | <code>-1</code> | 抓包中的“不限”值；其他语义未验证。 |
| <code>isEnd</code> | <code>-1</code>、<code>1</code>、<code>2</code> | 页面操作对应不限、已完结、连载中。 |
| <code>isFullVersion</code> | <code>-1</code>、<code>1</code>、<code>2</code> | 页面操作对应不限、高清清水版、未删减完整版。 |
| <code>order</code> | <code>1</code>、<code>0</code> | 页面操作对应按更新时间、按收藏时间。 |
| <code>order_type</code> | <code>0</code>、<code>1</code> | 页面操作对应从新到旧、从旧到新。 |
| <code>folder_id</code> | <code>0</code> | 默认收藏夹。其他文件夹的枚举接口尚未抓到。 |

响应顶层字段：

~~~json
{
  "err": 0,
  "books": [
    {
      "id": 123,
      "cover_url": "/static/upload.../cover.webp",
      "book_name": "漫画标题",
      "updateTime": "2026-08-23 12:34:56",
      "param": 123,
      "is_new": false,
      "full_is_new": false,
      "last_chapter": {
        "id": 456,
        "chapter_name": "第 N 话",
        "book_id": 123,
        "chapter_order": "0.00",
        "status": 1
      },
      "full_last_chapter": null,
      "read_last_chapter": null,
      "full_version_id": 0,
      "level": 0,
      "cate": 0
    }
  ]
}
~~~

Venera <code>Comic</code> 的最小映射：

| Venera 字段 | 站点字段/处理 |
| --- | --- |
| <code>id</code> | <code>String(book.id)</code> |
| <code>title</code> | <code>book.book_name</code> |
| <code>cover</code> | 将相对的 <code>cover_url</code> 按站点基地址解析为绝对地址 |
| <code>subtitle</code> | <code>last_chapter.chapter_name</code>，没有时可用 <code>read_last_chapter.chapter_name</code> 或省略 |
| <code>tags</code> | MVP 可为空数组；不要把内部数值 <code>cate</code> 直接展示为文本标签 |
| <code>favoriteUpdate.marker</code> / <code>updateTime</code> | 使用 <code>book.updateTime</code> 的非空字符串；它是列表快照的更新时间证据 |
| <code>favoriteUpdate.isNew</code> | 仅保留布尔型 <code>is_new</code> 作为诊断信号，不单独判定更新 |
| <code>favoriteUpdate.metadata.fullIsNew</code> | 保留布尔型 <code>full_is_new</code> 供 Debug 对照；不是更新判定依据 |

<code>/getfavors</code> 本身没有总页数字段。已确认它每次最多返回固定的 <code>15</code> 本漫画；最后一批可以不足 15 本，但这不改变页大小。先从 <code>/bookshelf</code> 的 <code>.favorite-count</code> 取得已收藏总数，再按固定页大小计算：

~~~javascript
const favoritePageSize = 15;
const maxPage = Math.ceil(favoriteCount / favoritePageSize);
~~~

Venera 的 <code>favorites.loadComics(page, folder)</code> 首页参数是 <code>1</code>，而站点首个请求是 <code>page=0</code>。这里的站点参数是 offset，因此必须使用：

~~~javascript
const favoritePageSize = 15;
const pageIndex = Math.max(0, page - 1);
const siteOffset = pageIndex * favoritePageSize;
~~~

映射固定为：Venera 第 1、2、3 页分别请求站点 <code>page=0</code>、<code>page=15</code>、<code>page=30</code>。不要发送 <code>page=1</code> 或 <code>page=2</code>，也不要再根据 <code>books.length</code> 推断或缓存页大小。

### 收藏列表更新检查边界

Manwa 源声明 <code>favorites.updateCheck</code>，其 <code>markerScheme</code> 为
<code>manwa-list-time-v1</code>，扫描间隔为 12 小时。<code>load(folderId)</code> 会先读取
<code>.favorite-count</code>，再以固定页大小 15 请求全部 offset；返回值必须包含完整的
<code>comics</code>、<code>pageSize: 15</code> 和与数组长度相等的 <code>total</code>。

每一本漫画都必须带非空 <code>book.updateTime</code>，同时作为
<code>favoriteUpdate.marker</code> 和 <code>favoriteUpdate.updateTime</code>。更新判定由
Venera 比较同一 marker scheme 下的 marker 与严格可解析的更新时间完成；重复的
<code>is_new</code> 不会重新产生更新，<code>is_new</code> 与 <code>full_is_new</code> 只作为
Debug 诊断信息。列表快照请求不读取漫画详情，也不使用旧的详情扫描队列。

### <code>POST /addfavor</code>

详情页内嵌脚本使用表单提交：

~~~text
POST /addfavor

book_id=<漫画 ID>&val=<当前收藏状态>&folder_id=0
~~~

已观察到的响应字段为 <code>err</code>、<code>msg</code> 和 <code>isfavor</code>。<code>isfavor === 1</code> 表示操作后已收藏，<code>0</code> 表示操作后未收藏。

网页会把详情页 <code>#addfavor</code> 的 <code>data-val</code> 原样传为 <code>val</code>：当前值为 <code>0</code> 时操作后变为收藏，当前值为 <code>1</code> 时操作后变为取消收藏。因此对 Venera 的 <code>isAdding</code> 而言，前端代码推定为：

| Venera <code>isAdding</code> | 发送的 <code>val</code> |
| --- | --- |
| <code>true</code> | <code>0</code> |
| <code>false</code> | <code>1</code> |

这是从网页事件逻辑得出的推定，首次实现必须使用自己的测试账号验证，失败时以 <code>err</code>/<code>msg</code> 处理。

页面存在文件夹选择控件，但没有抓到文件夹列表、新建或删除的请求。MVP 应使用：

~~~javascript
favorites = {
  multiFolder: false
}
~~~

只有在补齐文件夹接口后，才启用 <code>multiFolder: true</code> 和 <code>loadFolders</code>。

## 漫画详情

### <code>GET /book/{bookId}</code>

详情页是服务端渲染的 HTML。广告、统计脚本、样式与底部导航都应忽略，只解析下面的稳定内容节点：

| 数据 | 选择器/属性 | 处理方式 |
| --- | --- | --- |
| 标题 | <code>h1.detail-main-info-title</code> | 取并清理文本。 |
| 封面 | <code>.detail-main-cover img</code> 的 <code>data-original</code> | 优先使用该属性；<code>src</code> 是懒加载占位图，只作为无 <code>data-original</code> 时的后备。 |
| 元数据 | <code>p.detail-main-info-author</code> | 键取 <code>.detail-main-info-author-field</code>，值取 <code>.detail-main-info-value</code> 的可见文本；作者可优先收集内部 <code>&lt;a&gt;</code> 的文本。 |
| 内容标签 | <code>#detail .info-tag-span</code> | 收集为普通标签数组。 |
| 简介 | <code>p.detail-desc</code> | 保留换行或转换 <code>&lt;br&gt;</code> 为换行。 |
| 更新时间 | <code>.detail-list-title-3</code> | 去掉结尾的“更新”文本后作为可选 <code>updateTime</code>。 |
| 评论数 | <code>.commentcount</code> | 只有能准确转换为数字时才填 <code>commentCount</code>；<code>999+</code> 这类截断值应省略。 |
| 当前收藏状态 | <code>#addfavor[data-val]</code> | <code>data-val === '1'</code> 为已收藏；未登录或无节点时填 <code>null</code>/省略。 |

常见元数据键包括“作者”“更新状态”“最新章节”“订阅数”“地区”“类别”。推荐转成 Venera <code>ComicDetails.tags</code>：

~~~javascript
{
  "作者": ["作者名"],
  "状态": ["已完结"],
  "地区": ["地区名"],
  "类别": ["类别名"],
  "标签": ["标签 A", "标签 B"]
}
~~~

章节位于所有 <code>a.chapteritem[href^="/chapter/"]</code> 节点中。以链接末段作为章节 ID、以 <code>title</code> 属性或清理后的链接文本作为章节名，去重后构造：

~~~javascript
{
  "章节 ID 1": "章节标题 1",
  "章节 ID 2": "章节标题 2"
}
~~~

详情页虽会显示“展开全部章节”控件，但当前结论是全部章节已经包含在 HTML 中。实现时忽略该控件的显示状态，直接遍历页面中全部 <code>a.chapteritem</code> 节点即可，不需要额外请求。

<code>comic.loadInfo</code> 的 MVP 返回值至少应包含 <code>title</code>、<code>cover</code>、<code>tags</code> 和 <code>chapters</code>，并为无数据情况返回 <code>{}</code>，而不是 <code>null</code>。

## 阅读页与图片处理

### <code>GET /chapter/{chapterId}</code>

章节页也是 HTML。实际漫画页节点是：

~~~html
<img
  class="content-img lazy_img"
  src=".../imagecover3.jpg"
  data-r-src="https://.../chapter-image.webp?..."
  data-original=""
  data-sort="1">
~~~

解析规则：

1. 选择 <code>.img-content img.content-img[data-r-src]</code>。
2. 读取 <code>data-r-src</code>，不要使用 <code>src</code>（占位图）或空的 <code>data-original</code>。
3. 按数值 <code>data-sort</code> 升序排列。
4. 将 URL 数组作为 <code>comic.loadEp</code> 的 <code>images</code> 返回值。

页面中的 <code>.img-hosts[data-img-hosts]</code> 是 Base64 编码、逗号分隔的图片源列表；页面还提供 <code>?img_host=0</code>（随机）和 <code>?img_host=1..3</code> 的链接。MVP 可先请求默认章节地址；图片加载失败的图源切换功能，需要验证各 <code>img_host</code> 参数是否会让 HTML 返回可用的替代地址后再实现。

### 加密图片响应

抓包随附的解码说明指出：章节图片 URL 返回的是需转换的字节流，使用 AES-128-CBC 和 PKCS#7 填充，16 字节站点常量同时作为 key 与 IV。

不要在 <code>loadEp</code> 中提前下载全部图片，也不要将图片写到本地；应交给阅读器下载，并通过 <code>comic.onImageLoad</code> 的 <code>onResponse</code> 转换响应字节。Venera 提供 <code>Convert.decryptAesCbc</code>，形态如下：

~~~javascript
const imageKey = Convert.encodeUtf8(/* 私有抓包中记录的 16 字节站点常量 */);

comic.onImageLoad = (url) => ({
  url,
  onResponse: (encryptedBytes) =>
    Convert.decryptAesCbc(encryptedBytes, imageKey, imageKey)
});
~~~

把转换限制在章节页返回的加密图片 URL 上。详情封面、头像或其他静态资源是否加密尚未验证，不应全站无差别解密。首次验证时检查转换后的字节是否为预期图片格式；若网络返回 403/429，再根据实际请求补充最小必要的 Referer 或其他头。

## 评论

### <code>GET /commentmore</code>

已抓到的漫画详情评论请求：

~~~text
GET /commentmore?comment_id=0&chapter_id=&book_id=<漫画 ID>&sort=1&page=0
X-Requested-With: XMLHttpRequest
Referer: https://manwa.me/book/<漫画 ID>
~~~

参数说明：

| 参数 | 已观察行为 |
| --- | --- |
| <code>comment_id</code> | <code>0</code> 获取顶层评论；非零时是否获取回复尚未验证。 |
| <code>chapter_id</code> | 空字符串获取详情页评论；指定章节 ID 的语义尚未验证。 |
| <code>book_id</code> | 漫画 ID。 |
| <code>sort</code> | 抓包值为 <code>1</code>，排序方向未验证。 |
| <code>page</code> | <strong>0 是第一页</strong>，后续页依次传 <code>1</code>、<code>2</code>… |

响应为：

~~~json
{
  "msg": "ok",
  "err": 0,
  "list": [
    {
      "id": 1,
      "parent_id": 0,
      "book_id": 123,
      "chapter_id": 0,
      "content": "评论内容",
      "vote_like": 0,
      "vote_dislike": 0,
      "create_time": "YYYY-MM-DD HH:mm:ss",
      "reply_count": 0,
      "username": "用户名",
      "nick_name": "昵称",
      "cover": "https://.../avatar.jpg",
      "liked": 0,
      "disliked": 0
    }
  ]
}
~~~

响应还包含 IP、设备 UA、来源域名、国家、用户 ID、等级等字段。它们与 Venera 展示无关，必须忽略。

读取评论时可映射：

| Venera <code>Comment</code> 字段 | 站点字段/处理 |
| --- | --- |
| <code>userName</code> | <code>nick_name || username</code> |
| <code>avatar</code> | <code>cover || null</code> |
| <code>content</code> | <code>content</code> |
| <code>time</code> | <code>create_time</code> |
| <code>score</code> | <code>vote_like - vote_dislike</code> |
| <code>voteStatus</code> | <code>liked ? 1 : (disliked ? -1 : 0)</code>，仅在后续补齐投票接口时启用 |

Venera 的 <code>comic.loadComments</code> 首次调用传入 <code>page=1</code>，站点首次请求为 <code>page=0</code>，因此请求参数应使用 <code>sitePage = page - 1</code>。评论接口未返回总页数时可省略 <code>maxPage</code>；Venera 会在收到空列表后停止继续加载。

回复详情、评论发出、评论点赞和投票请求均不属于 MVP。应把 <code>id</code> 与 <code>replyCount</code> 留空，不实现 <code>sendComment</code>、<code>likeComment</code>、<code>voteComment</code>，避免界面展示不可用的操作入口。

## 上线前待补抓清单

1. 验证 <code>/addfavor</code> 的 <code>val</code> 映射与未登录错误，确认默认收藏夹是否足够。
2. 若要支持多文件夹，补抓文件夹列表、新建、删除和移动收藏的请求。
3. 验证验证码错误、过期和成功后的 Cookie 行为；绝不在文档中记录凭据。
4. 验证章节图片的默认源、<code>img_host</code> 切换、必要请求头和解密后的图片格式。
5. 只有需要扩展功能时，再补抓评论回复、章节评论、发布和投票请求。
