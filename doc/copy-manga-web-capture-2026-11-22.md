# 拷贝漫画网页抓包记录（2026-11-22）

从 `https://www.mangacopy.com` 的浏览器会话取样。中国标准时间 15:22 和 15:27–15:29 为免登录操作，15:35–15:37 为登录和账号内操作，15:56–15:58 补抓分类、作者、搜索、取消收藏和退出登录，16:03–16:07 验证搜索翻页、作者页、书架排序和评论入口，16:09–16:11 验证题材列表翻页。用 Whistle 核对请求和响应，再用普通版 [`copy_manga.js`](../copy_manga.js) 1.4.2（配置仓库 `c26e0b9`）离线重放目录和阅读页。本记录只保留接口格式及验证结果。

## 已观察到的接口

以下主站请求均为 `GET`，抓包的 HTTP 状态均为 `200`。

| 操作 | 请求路径 | 响应与样本 |
| --- | --- | --- |
| 首页 | `/` | 页面导航。保留了成功会话的摘要。 |
| 打开默认日榜 | `/rank` | `text/html; charset=utf-8`，含 50 条不同的漫画详情链接。 |
| 切到女频日榜 | `/rank?type=female&table=day` | `text/html; charset=utf-8`，含 50 条不同的漫画详情链接。 |
| 打开漫画详情 | `/comic/{comicId}` | `text/html; charset=utf-8`，含详情信息、目录解析用的 `ccz` 与 `#dnt`，以及少量可从 HTML 直接取得的章节链接。 |
| 加载章节目录 | `/comicdetail/{comicId}/chapters` | `application/json`，三个样本的 `code` 都为 `200`，`results` 为加密字符串。 |
| 打开章节阅读页 | `/comic/{comicId}/chapter/{chapterId}` | `text/html; charset=utf-8`，图片列表密文和解密材料内嵌在页面脚本中。 |
| 发现和题材列表 | `/comics`、`/comics?theme={theme}` | HTML。已观察到题材参数以及 `ordering=-datetime_updated`。 |
| 查看全部题材 | `/filter?point=0` | HTML，含指向 `/comics?theme={theme}` 的题材链接。 |
| 查看作者作品 | `/author/{authorId}/comics` | HTML。通过详情页作者链接进入。 |
| 关键词搜索 | `/search?q={keyword}&q_type=`、`/api/kb/web/searchcl/comics` | 搜索页 HTML 声明 `countApi`，浏览器随后获取搜索结果 JSON。 |

阅读器随后向 `*.mangafunb.fun` 请求图片。离线重放《月刊少女野崎君》第 03 卷，原脚本读出 149 个图片地址。其中 7 项可与本次抓包里的成功 CDN 请求对应，匹配时忽略了图片尺寸后缀差异。

## 发现、作者和搜索的列表格式

- `/comics` 与题材页样本都在 `.exemptComic-box` 的 `list` 属性放了数组字面量，元素使用单引号对象键，`total` 属性提供总条数。冒险题材 `theme=maoxian` 实抓了第一页、`offset=50&limit=50` 和 `offset=100&limit=50`。三页沿用 `ordering=-datetime_updated`，均返回 HTTP `200`、50 项和 `total=7027`，三页的 `path_word` 无交集。1.4.2 构造 `limit=30` 的列表请求。见 [分类请求和列表解析](../copy_manga.js#L674)。
- 作者作品页返回 HTML。后续实抓到 `/author/{authorId}/comics?offset=0&limit=50`，HTTP `200`，与同一作者无查询参数的页面包含相同数量的漫画详情链接。1.4.2 使用 `/author/{authorId}/comics?page={page}`。有多页的作者尚需翻页验证。见 [作者作品请求](../copy_manga.js#L196)。
- 搜索 JSON 请求为 `GET /api/kb/web/searchcl/comics?offset=0&platform=2&limit=12&q={keyword}&q_type=`，`Referer` 为同站搜索页。空体 GET 发送 `Accept: */*` 与 `Content-Type: application/x-www-form-urlencoded;charset=UTF-8`。`platform=2` 在查询参数里。退出登录前后分别提交了同一关键词，均携带浏览器 Cookie，均未出现 `Authorization`，两次都返回业务 `200` 与同一批 12 个结果。
- 搜索 JSON 外层含 `code`、`message`、`results`，其中 `results` 含 `list`、`total`、`limit`、`offset`。样本里的条目直接含 `path_word`、`name`、`cover`、`author`、`theme` 等漫画字段。此前搜索页内联配置 `queryTypeArray` 含 `q_type` 的空值、`name`、`author` 和 `local`，普通版脚本将 `local` 标为「汉化组」。用户操作的网页没有找到对应入口。实际请求样本为默认空值，`q_type=local` 的网页选项和 API 行为仍未验证。
- 同一关键词实抓了 `offset=0`、`12`、`24` 三页。三个响应均为 HTTP `200`、业务 `200`，各返回 12 条并回显对应 `offset` 和 `limit=12`，`total` 均为 221。三页的 `path_word` 无交集。
- 旧脚本默认走 `/api/v3/search/comic`。网页搜索分支初始路径是 `/api/kb/web/searchb/comics`，会去固定的 `www.copy20.com/search` 读取 `countApi`。本次在目标节点 `www.mangacopy.com` 直接观测到 `countApi` 和实际请求都指向 `/api/kb/web/searchcl/comics`。见 [搜索调用](../copy_manga.js#L1179) 和 [入口发现](../copy_manga.js#L160)。

## 目录请求格式

三个目录请求都没有查询参数，请求体均为 0 字节。浏览器实际发送的相关请求头如下，花括号表示从对应页面取值。

```http
GET /comicdetail/{comicId}/chapters
Host: www.mangacopy.com
Referer: https://www.mangacopy.com/comic/{comicId}
Accept: */*
Content-Type: application/x-www-form-urlencoded;charset=UTF-8
dnts: {对应详情页上 #dnt 元素的 value}
```

三个样本的 `dnts` 都与各自详情页的 `#dnt` 值一致。可查看请求头的排行、详情、目录和阅读样本都携带 `Cookie`，均未出现 `Authorization`。这些是正常浏览器流量的观测值，Cookie、`Referer`、`dnts` 和 `Content-Type` 的必需性仍需逐项对照验证。

1.4.2 的目录调用发送 `Accept: application/json, text/plain, */*`，并显式设置 `Referer` 和 `dnts`，调用处没有显式设置 `Content-Type`。1.4.3 按抓包设置这两个请求头。见 [`copy_manga.js` 的目录请求](../copy_manga.js#L1346)。

## 目录响应和重放

- 外层 JSON 含 `code`、`message`、`results`。三个样本的 `results` 都是 16 字符 IV 前缀加十六进制密文。对应详情页的 `ccz` 转 UTF-8 后为 16 字节，供 AES-CBC 解密使用。
- 解密后去除有效的 PKCS#7 填充，再按 UTF-8 解析 JSON。明文含 `build` 和 `groups`。每组可见 `path_word`、`count`、`name`、`chapters`、`last_chapter`。现有脚本使用章节的 `id` 或 `uuid` 以及 `name` 生成章节映射。
- 1.4.2 的目录路径直接对带填充的文本调用 `JSON.parse`。三个样本都触发了 HTML 章节链接回退。阅读页已经有 PKCS#7 校验和去填充，离线重放时将该逻辑用于目录即可读出下表结果。1.4.3 让目录和阅读页共用 [解密和去填充实现](../copy_manga.js#L268)。

| 漫画 | 原脚本返回数 | 去填充后返回数 | 抓包目录分组 |
| --- | ---: | ---: | --- |
| 拜田同學想看我的窩囊相 | 1 | 5 | 默认组 5 |
| 月刊少女野崎君 | 1 | 133 | 默认组 115，其它汉化版 18 |
| 生銹的四邊形 | 1 | 17 | 默认组 17 |

## 登录与会话

| 顺序 | 请求 | 观察结果 |
| --- | --- | --- |
| 1 | `GET /web/login?url={returnPath}` | HTTP `301`，跳到带末尾斜杠的 `/web/login/`，保留 `url` 查询参数。登录页返回 `200` 和 HTML。 |
| 2 | `POST /api/kb/web/login` | HTTP `200`，业务 `code: 200`。JSON 的 `results` 含字符串 `token` 和 `user_id`。响应带 `Set-Cookie`。 |
| 3 | `GET /` | 提交成功后浏览器另发页面导航请求，HTTP `200`。 |
| 4 | `GET /web/person`、`GET /web/person/` | 前者 `301`，带斜杠的个人中心页 `200`。随后加载账号资料。 |

登录提交的 `Content-Type` 为 `application/x-www-form-urlencoded; charset=UTF-8`，`Accept` 为 `application/json, text/plain, */*`。表单字段为 `username`、`password`、`salt`、`platform`、`version`、`source`。该样本中 `salt` 为六位十进制数字串，`platform=2`、`version=2025.12.10`、`source=freeSite`。仅验证了 `password` 的 Base64 解码结果尾部匹配 `-<salt>`，与现有脚本的编码格式一致。

登录请求的 `Origin` 为同站，`Referer` 为 `/web/login/loginByAccount`。同时带 `platform: 2` 请求头和 `Cookie`，该样本未见 `Authorization` 或 `X-CSRFToken`。附带观察到 `POST /api/kb/web/register` 返回 HTTP `200`、业务 `200`，其 `results.token` 为 `null`。

这批是 Windows 桌面 Chrome 流量，`Sec-CH-UA-Mobile` 为 `?0`。个人资料、书架、浏览历史的读取请求均带 `platform: 2`、`Accept: application/json`、`Authorization` 和 `Cookie`。收藏写请求也带 `Authorization` 和 `Cookie`，该样本没有 `platform` 请求头。MCP 遮盖了认证头和 Cookie 值，实际认证方案前缀、`Set-Cookie` 属性，以及服务端对各客户端标识的要求仍待验证。手机网页和官方 App 的请求格式需从对应客户端另取样。

退出登录走 `POST /api/v1/logout`。请求体为 0 字节，发送 `Authorization`、`Cookie`、`Accept: */*` 和 `Content-Type: application/x-www-form-urlencoded;charset=UTF-8`。响应为 HTTP `200`、业务 `200`、`results: null`，带 `Set-Cookie`。随后同一搜索仍返回正常结果。已观察到退出后再次登录成功。

## 个人资料、书架和浏览历史

下表请求都返回了 HTTP `200`、业务 `code: 200`。

| 操作 | 请求 | 观察结果 |
| --- | --- | --- |
| 读取当前账号 | `GET /api/v2/web/user/info` | `results.user_id` 是字符串，与本次登录返回的 `user_id` 一致。 |
| 读取编辑资料所需数据 | `GET /api/v2/web/user/update/info` | `results` 含 `info`、`bloods`、`genders`。 |
| 读取书架第一页 | `GET /api/v3/member/collect/comics?limit=12&offset=0&free_type=1&ordering=-datetime_modifier` | `results` 含 `list`、`total`、`limit`、`offset`。条目含 `uuid`、`name`、`b_folder`、`folder_id`、`last_browse` 和内层 `comic`。 |
| 添加收藏 | `POST /api/v2/web/collect` | 表单字段为 `comic_id` 和 `is_collect=1`。`comic_id` 是详情页 `collect(...)` 中的漫画 UUID。成功响应为 `results: null`。添加后书架的 `total` 增加 1，新条目的 `comic.uuid` 与提交的 UUID 一致。 |
| 取消收藏 | `POST /api/v2/web/collect` | 与添加使用同样的表单字段，提交 `is_collect=0`。本次对同一漫画先添加再取消，两次均返回 `results: null`。本轮取消后尚未读取书架。 |
| 读取浏览历史第一页 | `GET /api/kb/web/browses?limit=12&offset=0&free_type=1` | `results` 含 `list`、`total`、`limit`、`offset`。条目含 `id`、`last_chapter_id`、`last_chapter_name`、`comic`。阅读后新增记录的 `last_chapter_id` 与打开的章节一致。 |

添加收藏的 `Content-Type` 为 `application/x-www-form-urlencoded;charset=UTF-8`，`Accept` 为 `*/*`。`Origin` 为同站，`Referer` 为对应漫画详情页。书架内层 `comic` 可见 `uuid`、`path_word`、`datetime_updated`、`last_chapter_id`、`last_chapter_name` 等字段。唯一样本的 `datetime_updated` 是 `YYYY-MM-DD` 日期字符串，时区及其他返回格式待核对。

网页写接口使用 `/api/v2/web/collect`。1.4.2 调用 `/api/v3/member/collect/comic`，并先通过 `/api/v3/comic2/{comicId}` 查询 UUID。网页书架首批采用 `limit=12` 和 `-datetime_modifier`，1.4.2 采用 `limit=30` 并默认 `-datetime_updated`。见 [现有收藏实现](../copy_manga.js#L1202)。

书架已实抓收藏时间 `-datetime_modifier`、更新时间 `-datetime_updated` 和阅读时间 `-datetime_browse`。三种请求均为 `limit=12&offset=0&free_type=1`，都返回 HTTP `200`、业务 `200`，样本书架均只有一条记录。排序结果和第二页仍需多条记录验证。上一轮取消请求的原始会话已无法读取，这次书架回读未能按先前提交的 UUID 复核。

## 网页评论和章节吐槽

16:03–16:07 的四份详情页 HTML 和两份阅读页 HTML 中，未找到作品评论、回复或章节吐槽的按钮标记与内联接口地址。这段时间的 Whistle 会话也没有观测到相应请求。现有脚本另行访问 `api.mangacopy.com` 的 `/api/v3/comments` 和 `/api/v3/roasts`。网页是否在其他作品、设备或入口提供该功能仍待证实。见 [现有评论和吐槽代码](../copy_manga.js#L1516)。

## 普通版 1.4.3 对照实现

- 默认节点为 `www.mangacopy.com`，用户已明确选择的节点继续使用。网页版搜索、目录、登录、登出和收藏按各自请求设置 Content-Type、Referer、Origin 与 platform，并核对 HTTP 和业务状态。公开搜索不发送 Authorization。
- 登录会话按节点保存。Cookie 由 Venera 的 Cookie 管理器按请求地址带上，账户 API 沿用普通版的 `Token` Authorization 前缀。抓包中的实际前缀和 Cookie 属性被遮盖，端侧仍需验证。旧版保存的 Token 仅在当前节点存在匹配 Cookie 时使用。
- 搜索和书架按 12 项分页，分类和作者列表按 50 项分页。分类的单引号数组按数据解析。评论和章节吐槽继续使用 1.4.2 的接口。
- 用新版实现离线重放三份真实目录和一份阅读页，分别得到 5、133、17 项目录和 149 个图片地址。登录、登出和收藏使用合成会话测试。

## 普通版 1.4.4 详情和收藏刷新

- 详情页只从作者链接读取作者，从带 `theme` 的题材链接读取标签。用三份真实详情页 HTML 重放，作者与题材各自归类，阅读、加入书架和分享文案不进入字段。
- 默认「加入书架」按未知收藏状态处理。最近成功加载的书架和确认成功的增删操作可在当前节点及登录会话内提供短期状态，包括全量缓存尚未发布时从书架打开的详情。其余未知状态交给 Host 的收藏缓存判断。
- 编号分页复用网页书架请求。`favorites.loadCachePage` 返回源站总数和实际页数，核对条目数及本轮总数。`favorites_ordering` 和 `base_url` 参与收藏缓存隔离，旧 Host 仍可使用 `loadComics`。

## 普通版 1.4.5 作者封面和线路

- 作者列表的 `.correlationList` 将图片与标题放在指向同一漫画的两个链接中。图片地址在 `img[data-src]`。作者列表和作者搜索共用按漫画 ID 合并的解析逻辑，优先使用懒加载图片。用两个真实作者页重放，分别读出 2 和 17 部不同作品，均带 HTTPS 封面地址。
- 普通版节点选择和测速只启用 `www.mangacopy.com`，其余节点留作注释。旧节点的保存值会回退到已验证节点，CDN 选项只保留海外线路。
- 另以公开搜索请求验证 `q_type=author`。样本返回业务 `200` 和 12 条带封面的结果。名称和汉化组的非默认搜索类型仍待验证。

## 普通版 1.4.8 收藏默认排序

- 书架默认使用已实抓的 `-datetime_modifier`，由源站按收藏时间倒序返回。书架浏览和编号分页缓存共用这个默认值，已保存的排序选项继续生效。

## 待补抓

- 需要保留其他搜索类型选项时，再验证 `q_type=name` 和 `q_type=local`。作者页有多页结果时再验证非零 `offset`。分类的地区和完结状态筛选可按适配范围补抓。
- 书架有超过 12 条时再抓第二页。需要验证取消后的状态时，在同一次抓包内记录写入与书架读回。登录失效的 HTTP 与业务状态可随正常复现记录。
