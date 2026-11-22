# venera-configs

Configuration file repository for venera

## Create a new configuration

1. Download `_template_.js`, `_venera_.js`, put them in the same directory
2. Rename `_template_.js` to `your_config_name.js`
3. Edit `your_config_name.js` to your needs. 
   - The `_template_.js` file contains comments to help you with that. 
   - The `_venera_.js` is used for code completion in your IDE.

## Catalog 发布边界

013 版客户端直接跟随配置仓库的分支，默认来源为
[`yuxuanmian/venera-configs` 的 `yxm` 分支](https://github.com/yuxuanmian/venera-configs/tree/yxm)。
分支的新 commit 就是新的更新目标。客户端固定该 commit 后，从同一个 SHA 读取根目录的
`catalog.json`。满足整套配置的 `minAppVersion` 才继续下载 `index.json` 和索引中的脚本。
完整快照通过验证后才会切换。无 `catalog.json` 的旧提交按原流程处理。

`minAppVersion` 按完整 SemVer 比较，beta 序号参与排序，构建号不参与比较。
配套基线从 `2.0.0-beta.8` 开始。提高最低版本前，先发布对应 App。已发布的旧 App
仍使用脚本自己的 `minAppVersion`，因此脚本依赖新的宿主能力时也需要核对脚本声明。

发布前将索引和对应脚本一起更新，在仓库根目录运行 `python tools/validate_catalog.py`，
并核对脚本声明的源 `key`、版本和最低 App 版本。索引和脚本的 `key` 必须精确一致
（区分大小写）；版本以脚本为准，索引版本滞后不阻断启动。保持源 `key` 和漫画 ID 的
含义稳定。未启用的源也属于完整快照，索引中任一脚本校验失败都会阻止该 commit 应用。

此仓库发布客户端脚本、登录辅助和本地追更能力。脚本内的 `url` 不用于发现更新，发布也
不需要部署或激活 Venera Server。
