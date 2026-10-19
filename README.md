# Sift · 一个搜索壳子

一个**纯静态**的百度式搜索页。没有后端、没有数据库、没有服务端 API Key：搜索由浏览器带着
**用户自己的** DeepSeek API Key 直连 `POST https://api.deepseek.com/v1/tools/search`。

```
浏览器 ──(你自己的 key)──▶ api.deepseek.com/v1/tools/search
   └─ 缓存 / 同 query 合并 / 5QPS 令牌桶 / 本地分页 —— 全在客户端
```

![深色主题](docs/screenshot-desktop.png)

## 快速开始

```bash
npm install

npm run dev        # 开发服务器 http://127.0.0.1:5173
npm run build      # 类型检查 + 产物到 dist/（约 16 kB gzip）
npm run serve      # 用 dist/ 起一个零依赖静态服务 http://127.0.0.1:8765
npm test           # 单元测试 85 个
npm run e2e        # 端到端 18 项检查（离线，window.fetch 打桩，不花钱）
npm run e2e:live   # 真的调一次线上接口（需要 DEEPSEEK_API_KEY，约 ¥0.01）
```

首次打开会让你粘贴 Key（在 <https://platform.deepseek.com/api_keys> 创建），
它只写入本浏览器的 `localStorage`，右上角 ⚙ 可随时删除。

## 功能

| 能力 | 说明 |
| --- | --- |
| 搜索 | 一次取满 50 条，前端本地分页（5 页），翻页不产生任何请求 |
| 搜索语法 | `site:` `-site:` `-词` `"短语"` `lang:` `after:` `before:` 原样透传 |
| 筛选条 | 站点 / 排除站点 / 语言 / 时间（一天、一周、一月、一年），自动拼成操作符 |
| 结果卡 | 标题、域名、摘要（三行截断，点击展开）、站点名、日期、权威度徽标 |
| 阅读正文 | 单条调 `/v1/tools/fetch`，展开 Markdown 正文并缓存，可「只搜本站」 |
| 历史 / 联想 | 最近 10 条搜索，输入时按子串联想，↑↓ 选择、Enter 确认 |
| 设置 | 每页条数、摘要长度、主题（深/浅/跟随系统）、端点覆盖、导出设置、清理数据 |
| 计费可见 | 状态栏显示耗时与本次费用；缓存命中标「未计费」；页脚累计本次会话花费 |
| 键盘 | `/` 聚焦、`Esc` 关闭、`←/→` 翻页 |
| 容错 | 401/402/403/429/超时/网络/5xx 分别给出可操作提示；429/5xx 自动退避重试 |

![浅色主题](docs/screenshot-light.png)

## 为什么没有后端

这不是偷懒，是三个事实叠加的结果：

1. **DeepSeek 的 Search API 开了 CORS**（实测回显任意 `Origin`，连 `Origin: null` 都接受），
   所以浏览器可以直连，`file://` 打开也能用；
2. **协议禁止把 key 放进客户端代码**（开放平台服务协议 2.4），而 BYOK 模式下 key 是
   *用户自己*放进*自己*的浏览器，不上传、不落库，页面也明确告知了这一点；
3. **成本与限速都跟着用户走**：5 QPS 是账号级限额，谁的 key 谁的额度，站点本身只承担静态流量。

代价是：用户必须自己有 key。如果你要的是「用户不用填 key」，那必须加后端代理，
并把 5 QPS 和账单接过来 —— 这也是 `设置 → 搜索端点` 预留的扩展点。

## 并发与钱（硬约束，不是 bug）

| 约束 | 数字 | 站点怎么应对 |
| --- | --- | --- |
| 限速 | **5 请求/秒，按账号**，多 key 不叠加 | 令牌桶排队（不丢弃）；同 query 合并；缓存 |
| 结果上限 | **单次最多 50 条** | 一次取满，前端分页，翻页 0 请求 |
| 计费 | **¥5 / 1000 次成功请求**，失败/无结果/超时不计费 | 只缓存非空结果；重复查询直接命中缓存 |
| 延迟 | 实测 0.4–0.9s | — |

多标签页、多人同时用同一份部署都互不影响：每个人用自己的 key，各自吃自己的 5 QPS。

## 配置

全部集中在 [`src/config.ts`](src/config.ts)：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `brand` | `Sift` | 站点名。**改成你自己的，不要用 DeepSeek 品牌** |
| `searchEndpoint` / `fetchEndpoint` | DeepSeek 官方 | 也可在「设置 → 搜索端点」临时覆盖 |
| `maxCount` | `50` | 单次取回条数，也是分页的物理上限 |
| `qps` | `5` | 令牌桶速率 |
| `pricePerSuccessfulSearch` | `0.005` | 仅用于界面上的费用提示 |
| `cacheTtlMs` / `cacheMaxEntries` | 10 分钟 / 60 条 | 客户端缓存 |
| `retryAttempts` / `retryBaseMs` | 2 / 600 | 429 与 5xx 的指数退避 |
| `storageNamespace` / `storageVersion` | `sift` / 1 | localStorage 命名空间与 schema 版本 |

## 项目结构

```
index.html               静态外壳（语义化结构 + 可访问性属性）
src/main.ts              入口
src/app.ts               控制器：唯一的状态与 DOM 写入点
src/config.ts            全部可调参数
src/core/                纯函数层，零 DOM、可单测
  api.ts                 HTTP 客户端：限速 → 超时 → 重试 → 错误分类
  limiter.ts             令牌桶（队列，不是丢弃）
  cache.ts               TTL + LRU
  singleflight.ts        同 query 并发合并
  retry.ts               指数退避 + 抖动
  query.ts               文本 + 筛选 → 上游 query；高亮词提取
  highlight.ts           先转义后加 <mark>
  format.ts              日期 / 耗时 / 金额 / 域名
  storage.ts             带版本信封的 localStorage 封装
  types.ts               API 返回类型 + 错误类型
src/ui/dom.ts            极简 DOM 助手（h / must / debounce / copy）
src/styles.css           主题 token + 组件样式（深/浅）
tests/                   85 个单元测试
e2e/run.mjs              CDP 驱动的端到端测试（无 Playwright）
scripts/serve.mjs        零依赖静态服务器
docs/ARCHITECTURE.md     设计决策与数据流
```

## 测试

```bash
npm test        # 8 个文件 85 个用例：限速/缓存/合并/重试/查询/高亮/存储/HTTP 错误映射
npm run e2e     # 18 项检查：Key 门 → 搜索 → 高亮 → 分页 → 缓存 → 正文 → 401 → 主题 → 无 console 错误
```

e2e 用 CDP 直连本机 Chrome（`CHROME_PATH` 可覆盖），离线模式把 `window.fetch` 打桩，
所以跑一百遍也不花一分钱；`--live` 才走真网络。实测结果：

```
离线：18/18 checks passed
真网：13/13 checks passed（50 条结果 / 5 页 / 732ms / 本次 ¥0.005）
```

## 部署

产物是纯静态文件，扔到任何静态托管（Nginx、OSS、Cloudflare Pages、GitHub Pages）即可。
`vite.config.ts` 里 `base: './'`，所以放到子路径也能跑。

```bash
npm run build
# dist/ 直接上传；本地预览：
npm run serve
```

想限制别人用你的域名刷，可以在网关层加 IP/来源限流——但 key 是用户自己的，滥用动机很低。

## 合规与品牌红线

上公网之前，这三条是硬要求，不是建议：

1. **品牌**：开放平台服务协议 5.2 禁止使用「DeepSeek」商标、名称、域名、LOGO 做站点品牌，
   也禁止暗示「官方合作」。站名自己起，`config.ts` 里改。
2. **生成内容标识**：结果里的 `summary` 是模型生成的摘要，公开展示需按
   《AI 生成合成内容标识办法》加标识；纯 `snippet`（原文摘录）不涉及。
3. **备案与内容安全**：境内公网运营需 ICP 备案；作为网络信息内容生产者还需承担审核义务。
   本机 / 内网 demo 不涉及这些。

## 已知限制

- 只有 5 页（50 条），做不了无限翻页——这是接口上限，不是前端问题。
- 没有搜索建议接口，联想只基于本地历史。
- 冷门长尾词无法靠缓存摊薄，5 QPS 会直接暴露给用户。
- 单一 provider，DeepSeek 侧故障时没有兜底引擎（可自行加）。

## Roadmap

- [ ] 多引擎并列：同一 query 用 `site:` 变体横向对比
- [ ] 结果页快照：`fetch` 正文后做本地全文高亮
- [ ] 可选后端代理：`server/` 目录，把 key 收进服务端，换取「用户不用填 key」
- [ ] PWA 离线壳

## 版本说明

0.1.0。从原型 [`search-shell/`](../search-shell/) 重写而来：原型验证了接口与交互，
本仓库把它拆成分层、可测试、可发布的形态。
