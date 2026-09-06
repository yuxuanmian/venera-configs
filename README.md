# venera-configs

Configuration file repository for venera

## Create a new configuration

1. Download `_template_.js`, `_venera_.js`, put them in the same directory
2. Rename `_template_.js` to `your_config_name.js`
3. Edit `your_config_name.js` to your needs. 
   - The `_template_.js` file contains comments to help you with that. 
   - The `_venera_.js` is used for code completion in your IDE.

## Catalog 发布边界

漫画源全集由 `index.json` 声明，并由维护者通过 Venera Server 的 Check/Activate
流程发布。配置脚本只提供客户端源代码、登录辅助和本地追更能力；不要在配置仓库中加入
远端扫描器、账号观测或任意脚本管理入口。
