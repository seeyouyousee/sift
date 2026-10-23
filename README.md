# Sift

[English](./README.en.md) | 简体中文

**纯静态搜索页**：带你自己的 DeepSeek API Key，浏览器直连接口，首屏是**带引用的 AI 摘要**，不是十条蓝色链接。

![Sift](docs/screenshot-desktop.png)

## 30 秒开始

需要 Node ≥ 22 和一个 [DeepSeek API Key](https://platform.deepseek.com/api_keys)（账号需有余额，约 ¥0.005/次）。

```bash
git clone https://github.com/seeyouyousee/sift.git && cd sift
npm ci && npm run dev        # → http://127.0.0.1:5173
```

打开页面 → 粘贴 key → 搜索。key 只写进你自己浏览器的 `localStorage`，不经任何服务器。

## 它做了什么

- **搜索** 一次取 50 条，前端分页；翻页不产生请求，重复查询命中缓存
- **AI 摘要** 取前 8 条来源流式合成一段答案，`[1][2]` 可点回到原文，卡片标注「AI 摘要」
- **合并重复** 同页的多语言克隆（`/zh-cn/`、`/ko/`）和同标题重复自动合并
- **多站对比** 一次查询拆成知乎 / GitHub / 微博 / B 站四栏并排，各自计费与缓存
- **别的** 阅读正文、筛选条（站点/语言/时间）、深浅主题、PWA 离线壳、`/` 聚焦、`←/→` 翻页

## 部署

```bash
npm run build      # 纯静态产物在 dist/，gzip 约 19 kB
npm run serve      # 本地预览 → http://127.0.0.1:8765
```

扔到任何静态托管即可。仓库自带 GitHub Actions：推到 `main` 自动发布到 Pages。

## 三条须知

1. **不是 DeepSeek 官方产品**。站点名/域名请自己换，不要用 DeepSeek 品牌（开放平台协议 5.2 禁止）。
2. **每人用自己的 key、付自己的账单**。限速 5 次/秒/账号，浏览器直连 `api.deepseek.com`。
3. 公网展示 AI 摘要时**保留「AI 摘要」标识**，这是生成式内容标识要求。

## 开发

```bash
npm test        # 133 个单元测试
npm run e2e     # 31 项端到端检查（离线打桩，不花钱）
npm run e2e:live  # 真调接口，约 ¥0.03
```

改代码前先读 [设计取舍](docs/ARCHITECTURE.md)——里面记了哪些尝试被删掉、为什么。
安装细节、配置项、成本模型、常见问题都在 [docs/FAQ.md](docs/FAQ.md)。

## License

[MIT](LICENSE)
