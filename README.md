# venera-configs

Configuration file repository for venera

## Create a new configuration

1. Download `_template_.js`, `_venera_.js`, put them in the same directory
2. Rename `_template_.js` to `your_config_name.js`
3. Edit `your_config_name.js` to your needs. 
   - The `_template_.js` file contains comments to help you with that. 
   - The `_venera_.js` is used for code completion in your IDE.

## Cloud Tracking contribution boundary

`index.json` 的 `cloudTracking` 只声明单个精确 artifact 的 scanner，例如：

```json
{
  "key": "manwa",
  "fileName": "manwa.js",
  "cloudTracking": {"scanner": "extensions/server/manwa/scanning.js"}
}
```

能力不会按 `key` 继承到同源的其他文件。scanner 必须导出匹配的
`extensionId`、`artifactId`、`sourceKey`、`fileName`、`apiVersion`，并提供 v1
`probeAccount` 与 `scanFavoriteSnapshotSlice`；它只返回 account identity 和标准
`favoriteUpdate` 事实，不比较内容、不返回 Cookie/token/原始页面。

扫描快照必须有界、可断点恢复，并使用脱敏 fixture 测试认证、限流、登录页、分页和快照漂移。
执行 `node scripts/validate-cloud-tracking.js` 可检查精确 artifact、路径/符号链接边界、
scanner 入口、旧 marker 字段和 fixture 敏感信息。维护工作直接修改 catalog、公共模板和
scanner；不要引入 overlay 或 patch workflow。
