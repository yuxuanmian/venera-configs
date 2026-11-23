# 禁漫 App 抓包记录（2026-11-23）

样本来自 MuMu 上的官方 Android App `2.1.14`，API 分流为 `www.cdnbtd.cc`，语言参数为 `TW`。时间按中国标准时间记录。用 Whistle 核对请求，并用 [`jm.js`](../jm.js) `1.4.1` 离线重放收藏、详情和章节响应。本文保留接口形状、数量和验证结果。

## 已覆盖

| 场景 | 观察到的请求 | 验证结果 |
| --- | --- | --- |
| 登录后打开收藏（22:16:05–08） | `OPTIONS /login` → `POST /login` → `GET /favorite?page=1&o=mr&lang=TW` | 登录 HTTP `200`，外层业务 `code: 200`，`data` 为加密字符串，响应带 `Set-Cookie`。后续收藏请求获得账号内的数据。 |
| 浏览「全部」和切换自建夹（22:16:08–53） | `GET /favorite?page=1&o=mr&lang=TW` 和 `GET /favorite?page=1&folder_id=<FID>&o=mr&lang=TW` | 「全部」返回 4 本漫画和 1 个自建夹，自建夹返回 1 本漫画。所选夹 ID 对得上目录的 `FID`。5 份响应均可被现有收藏解析读取。 |
| 打开详情（22:19:28） | `GET /album?id=<漫画 ID>&lang=TW` | 现有详情解析可读。本次样本的 `series` 为空，脚本按单章处理。详情同一时段还请求了 `GET /album_sertracking?id=<漫画 ID>&lang=TW`，返回布尔值。 |
| 打开单章（22:19:33） | `GET /comic_read?id=<章节 ID>&lang=TW` | `total_page: 44`，`images` 有 44 项，每项是 `{"page": 1, "image": "<完整图片 URL>"}`，`page` 从 1 递增。响应另含 `scramble_id`。 |
| 加载正文与封面 | 正文 `/media/photos/<章节 ID>/<文件名>.webp?t=…`，封面 `/media/albums/<漫画 ID>_3x4.jpg?v=…` | 抽查的 12 条正文请求都与章节响应中的完整 URL 对应，图片为 `image/webp`。抽查的封面为 `image/jpeg`。 |
| 多话漫画目录与选章（22:43:04–24） | `GET /album?id=<漫画 ID>&lang=TW` → `GET /comic_read?id=<章节 ID>&lang=TW` | `series` 含 36 个不同的章节 ID，抓到的章节 ID 能在 `series` 中找到。该章返回 10 条 `{page, image}`。 |
| 连续章节请求（22:52:25–22:53:28） | API 分流 `www.cdnutc.cc`，一次 `/album` 和四次 `GET /comic_read?id=<章节 ID>&lang=TW` | 四个请求 ID 都能在同一份 36 条章节目录中找到，其中目录排序值 `1`、`2`、`3` 的三话依次发出独立请求。每话返回 10 条 `{page, image}`，`scramble_id` 都是 `220980`。抓到的 36 条正文请求全部 HTTP `200`，分布在四个图片 host，每条都与各自章节返回的完整 URL 一致。 |

### 登录和会话观察

- 官方 App 的 `POST /login` 使用 `multipart/form-data`，请求字段是 `username` 和 `password`。脚本使用同名字段，编码为 `application/x-www-form-urlencoded`。
- 实抓请求的 `tokenparam` 声明 `2.1.14`，`Origin` 是 `http://localhost`。脚本声明 `2.0.16`，`Origin` 是 `https://localhost`。App 的 `X-Requested-With` 与这次安装的包名一致，脚本使用 `com.example.app`。
- 已确认登录响应包含 `Set-Cookie`，且随后可读到该账号的收藏。会话凭据是如何被后续请求携带的，尚未验证。

### 与 `jm.js` 1.4.1 的对照

- 收藏响应仍含 `list`、`folder_list`、`total` 和 `count`。自建夹条目仍含 `FID` 和 `name`。脚本的 `loadFolders()` 使用裸 `GET /favorite`，官方 App 的「全部」请求传 `page=1&o=mr&lang=TW` 并省略 `folder_id`。前一次裸请求样本返回 3 本漫画和空 `folder_list`，当时的分流、版本和会话与本次不同。还需同会话对照才能判断参数是否造成差异。
- 现有 `loadEp()` 请求 `/chapter`，并把图片列表项直接当作文件名。用 `/comic_read` 的实抓响应离线重放，44 个结果均以 `[object Object]` 结尾。适配新接口应按目录 ID 加载章节并读取 `images[].image`。保留响应给出的图片 host 和 `t` 参数，解混淆从 URL 路径取文件名。本次尚未验证旧 `/chapter` 是否还能返回可用数据。
- 脚本的收藏写入会解开响应正文，但 `addOrDelFavorite()`、`addFolder()` 和 `deleteFolder()` 未读取内层 `status` 或 `type`。`POST /favorite` 的实抓响应通过 `type: "add"` 和 `type: "remove"` 区分实际切换结果。后续判断写入是否成功，应核对业务状态和返回的切换方向。

## 收藏写入与回读（22:39–43）

以下请求来自官方 App。收藏写入使用 `multipart/form-data`，样本的 HTTP 状态和外层业务 `code` 均为 `200`。`POST /favorite` 仅发送 `aid`。`POST /favorite_folder` 带 `type`、`folder_id`、`folder_name`、`aid`，各操作使用其中相关字段。以下用「原有夹」「临时夹」代替真实夹名。

| 时间 | 操作与请求 | 业务响应和回读 |
| --- | --- | --- |
| 22:40:02 | `POST /favorite`，发送测试漫画的 `aid` | `status: "ok"`、`type: "add"`。同一本漫画稍后在详情的 `is_favorite` 从 `false` 变为 `true`，也能从「全部」回读。 |
| 22:40:12、22:41:36 | `POST /favorite_folder`，`type=move`。第一次 `aid` 为单个 ID，第二次为 3 个以逗号分隔的 ID | 均返回 `status: "ok"`，请求里的目标 ID 都指向原有夹。回读确认 4 个目标条目均在原有夹，临时夹为 0 本。抓包能确认请求送达的目标夹，界面选中状态没有记录。 |
| 22:40:38 | `POST /favorite_folder`，`type=add`，传夹名 | `status: "ok"`。后续目录从 1 个自建夹变为 2 个，可以打开新增夹。夹名包含空格和中文的情况仍待验证。 |
| 22:42:05 | `POST /favorite_folder`，`type=del`，传临时夹的 `folder_id` | `status: "ok"`。约 7 秒后的目录回读只剩原有夹，临时夹已删除。 |
| 22:42:53 | `POST /favorite`，发送同一本测试漫画的 `aid` | `status: "ok"`、`type: "remove"`。同一秒的「全部」读取在写入响应之前结束，仍含该漫画。抓包里没有后续收藏回读，取消操作的最终列表状态尚未确认。 |

移夹仅作为抓包记录，后续功能范围排除移动收藏。

## 后续核对

- 收藏目录的同会话参数对照，以及 1.4.2 在 Venera 中的已登录读写与实际排序。
- 取消收藏写入完成后的列表回读，以及带空格、中文的夹名编码。
- 扩大浏览巡检范围时，可补搜索翻页、分类或榜单翻页和评论列表。

## 1.4.2 脚本适配

- 收藏目录和「全部」使用带 `page`、`o` 和 `lang` 的请求，自建夹额外传 `folder_id`。默认 `o=mr`，列表沿用服务端的收藏时间倒序。`folder_list` 只提供目录，脚本省略未知的漫画归属信息。
- 登录与收藏切换使用 `multipart/form-data`。收藏切换前查详情的 `is_favorite`，写入成功需核对内层 `status` 和 `type`。新增收藏沿用原有指定夹写入流程。独立移夹仍只记录抓包。
- `/comic_read` 直接提供含分流地址和查询参数的图片 URL，按 `page` 排序。解混淆使用文件名，不把查询参数计入。线路 2 的公开样本实测 `/chapter` 和 `/comic_read` 均可返回 10 页，保留 `/chapter` 作为新版路径返回 `404`、`405` 或 `501` 时的回退。

### Venera 桌面目录复现（23:18）

- 桌面端实际加载 `enhancements` 的 `jm.js` `1.4.2`。收藏目录走客户端共用的多文件夹页面。线路 2 `www.cdnutc.cc` 的参数化目录请求先返回 `401`，源自动重登后收到 HTTP 与业务 `200`。解密回包含 3 本漫画和空 `folder_list`，页面因此只显示汇总项「全部」。
- 已离线核对，桌面端保存的账号标识与官方 App 线路 1 样本里的收藏夹归属相同。用户随后在 Venera 切到线路 1，确认能看到自建收藏夹。
- `1.4.3` 暂停使用远端名单中的 `www.cdnutc.cc`。选中该线路时使用首条可用线路，其他线路保留原编号。自动刷新和手动刷新使用同样的处理。
