# 安全说明

## 报告问题

请通过 GitHub 的 Private vulnerability reporting（仓库 Security 标签页）提交，不要开公开 issue。

## 这个项目里和密钥有关的三条规则

1. **永不提交 API Key**。本项目是 BYOK：key 只存在于用户浏览器的 `localStorage`，
   任何代码、文档、测试里都不应该有真实 key。
2. **不要在前端硬编码默认 key**。如果要做「用户不用填 key」的产品形态，请用
   `server/proxy.mjs` 那种服务端代理，把 key 放到环境变量里。
3. **提交前自查**：

   ```bash
   git diff --cached | grep -E "sk-[A-Za-z0-9]{16,}" && echo "疑似泄漏，别提交" || echo "clean"
   ```

## 已知边界

- 搜索结果与抓取的网页正文是**不可信输入**，渲染前一律 HTML 转义（`core/highlight.ts`）；
  e2e 里有一条断言专门检查渲染后不存在来自结果的 `<script>`。
- Service Worker 只缓存同源静态资源，`api.deepseek.com` 的响应永不进缓存。
- 本地存储带版本信封，版本不匹配时静默丢弃而不是崩溃。
