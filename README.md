# Sift · 一个搜索壳子

一个**纯静态**的百度式搜索页。没有后端、没有数据库、没有服务端 API Key：搜索由浏览器带着
**你自己的** DeepSeek API Key 直连 `POST https://api.deepseek.com/v1/tools/search`。

```
浏览器 ──(你自己的 key)──▶ api.deepseek.com/v1/tools/search
   └─ 缓存 / 同 query 合并 / 5QPS 令牌桶 / 本地分页 / 多站对比 —— 全在客户端
```

![深色主题](docs/screenshot-desktop.png)

## 快速开始

```bash
npm install

npm run dev        # 开发服务器 http://127.0.0.1:5173
npm run build      # 类型检查 + 产物到 dist/（gzip 约 17 kB）
npm run serve      # 用 dist/ 起零依赖静态服务 http://127.0.0.1:8765
npm test           # 单元测试 100 个
npm run e2e        # 端到端 24 项检查（离线，window.fetch 打桩，不花钱）
npm run e2e:live   # 真的调线上接口（需要 DEEPSEEK_API_KEY，约 ¥0.03）
```

首次打开会让你粘贴 Key（在 <https://platform.deepseek.com/api_keys> 创建），
它只写入本浏览器的 `localStorage`，右上角 ⚙ 可随时删除。

## 功能

| 能力 | 说明 |
| --- | --- |
| 搜索 | 一次取满 50 条，前端本地分页（5 页），翻页不产生任何请求 |
| **多站对比** | 一次查询拆成「知乎 / GitHub / 微博 / B 站」四栏并排，每栏独立缓存、独立计费 |
| 搜索语法 | `site:` `-site:` `-词` `"短语"` `lang:` `after:` `before:` 原样透传 |
| 筛选条 | 站点 / 排除站点 / 语言 / 时间（一天、一周、一月、一年），自动拼成操作符 |
| **重排与去重** | 合并同页多语言克隆、同标题重复；按相关度+权威+时效重排；同域第 3 条起降权（不删） |
| 结果卡 | 标题、域名、摘要（三行截断，点击展开）、站点名、日期、权威度徽标 |
| 阅读正文 | 单条调 `/v1/tools/fetch`，展开 Markdown 正文并缓存，可「只搜本站」 |
| 历史 / 联想 | 最近 10 条搜索，输入时按子串联想，↑↓ 选择、Enter 确认 |
| 设置 | 每页条数、摘要长度、主题（深/浅/跟随系统）、端点覆盖、导出设置、清理数据 |
| 计费可见 | 状态栏显示耗时与本次费用；缓存命中标「未计费」；对比模式按请求次数计费 |
| 处理透明 | 状态栏写明「合并重复 N / 同域降权 N」，设置里可一键关掉看到原始排序 |
| **可安装 / 离线壳** | PWA：manifest + service worker，只缓存同源静态资源，绝不缓存搜索结果 |
| 键盘 | `/` 聚焦、`Esc` 关闭、`←/→` 翻页 |
| 容错 | 401/402/403/429/超时/网络/5xx 分别给出可操作提示；429/5xx 自动退避重试 |

![多站对比](docs/screenshot-compare.png)

## 结果质量：本地重排做了什么

接口返回的是「给模型读」的排序，不是「给人看的列表」：同一篇文章按语言出现三次、
一个内容农场能占掉前十里的四条、政府公告压过真正的答案。这些都在客户端补：

| 动作 | 规则 | 效果（10 查询实测） |
| --- | --- | --- |
| 合并同页克隆 | 去掉 `zh-cn/` `ko/` 这类语言前缀后 URL 相同即视为同一页 | 平均每查询去掉 0.7 条 |
| 合并同标题 | 标题归一化（大小写/标点/空格）后相同则丢弃 | — |
| 重新打分 | `0.6×相关度 + 0.25×权威 + 0.15×时效` | 权威与时效开始起作用 |
| 同域降权 | 同一域名第 3 条起移到列表尾部（**不删除**） | 同域最多条数 2.4 → 2.0；「外贸开发信」那类查询唯一域 5 → 8 |

```
$ node scripts/bench.mjs          # 固定 10 个查询，10 次请求 ≈ ¥0.05

类别        查询                      唯一域     同域最多    中位分        去重
口语长句     怎么用 Python 把 Ex…       8→9       3→2        1.77→1.65    2
口语长句     外贸客户开发信怎么写…        5→8       4→2        1.65→1.62    0
事实        欧盟 电池护照 要求           6→8       3→2        2.35→2.32    0
对比        searxng 和 whoogle 区别   9→9       2→2        1.47→1.47    1
平均：唯一域 8.2 → 8.4 · 同域最多 2.4 → 2.0 · 中位分 1.86 → 1.84
```

**诚实说明**：中位分微降 0.02，这是同域降权的代价——用一点「原始相关度」换「列表多样性」。
想要压倒性提升，靠重排是不够的，得往上加答案层（见 Roadmap）。

## 三种部署形态

| 形态 | 谁付钱 | Key 在哪 | 适合 |
| --- | --- | --- | --- |
| **A. 纯静态**（默认） | 用户 | 用户浏览器 | 分享给同事朋友、内网工具、公开 demo |
| **B. 静态 + 代理（转发用户 key）** | 用户 | 用户浏览器，经你的域名转发 | 想统一域名 / 统一加日志与限流，又不想碰账单 |
| **C. 代理共享 key** | 你 | 服务端环境变量 | 真正的「用户不用填 key」产品；必须自己做防刷 |

```bash
# B：不设 key，转发客户端自带的 Authorization
node server/proxy.mjs --port 8787

# C：注入服务端 key，全站共用（5 QPS 由代理排队控制）
DEEPSEEK_API_KEY=sk-xxx node server/proxy.mjs --port 8787
```

然后在页面「设置 → 搜索端点」填 `http://127.0.0.1:8787/v1/tools/search` 即可。
代理零依赖、约 190 行，`createProxy()` 可被测试直接 import（见 `tests/proxy.test.ts`）。

## 为什么默认没有后端

三个事实叠加的结果：

1. **DeepSeek 的 Search API 开了 CORS**（实测回显任意 `Origin`，连 `Origin: null` 都接受），
   浏览器可以直连，`file://` 打开也能用；
2. **协议禁止把 key 放进客户端代码**（开放平台服务协议 2.4），而 BYOK 模式下 key 是
   *用户自己*放进*自己*的浏览器，不上传、不落库，页面明确告知；
3. **成本与限速跟着用户走**：5 QPS 是账号级限额，谁的 key 谁的额度，站点只承担静态流量。

代价是用户必须自己有 key。形态 C 就是为「不想让用户填 key」准备的后门。

## 并发与钱（硬约束，不是 bug）

| 约束 | 数字 | 站点怎么应对 |
| --- | --- | --- |
| 限速 | **5 请求/秒，按账号**，多 key 不叠加 | 令牌桶排队（不丢弃）；同 query 合并；缓存；代理侧再排一次队 |
| 结果上限 | **单次最多 50 条** | 一次取满，前端分页，翻页 0 请求 |
| 计费 | **¥5 / 1000 次成功请求**，失败/无结果/超时不计费 | 只缓存非空结果；对比模式只对真正发出的请求计费 |
| 延迟 | 实测 0.4–0.9s | — |

对比模式是**唯一**会把单次交互放大成多次请求的功能：4 栏 = 4 次请求 = ¥0.02，
所以它是显式开关，状态栏直接写「本次 ¥0.02（4 次请求）」。

## 配置

全部集中在 [`src/config.ts`](src/config.ts)：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `brand` | `Sift` | 站点名。**改成你自己的，不要用 DeepSeek 品牌** |
| `searchEndpoint` / `fetchEndpoint` | DeepSeek 官方 | 也可在「设置 → 搜索端点」临时覆盖（形态 B/C 用它） |
| `maxCount` | `50` | 单次取回条数，也是分页的物理上限 |
| `comparePresets` / `compareCount` | 知乎/GitHub/微博/B站 · 10 | 对比模式的栏目，改这里就换站点 |
| `rankMaxPerDomain` | `2` | 同域最多保留几条在前段；`0` 关闭降权 |
| `rankBlocklist` | `[]` | 直接丢弃的域名（默认不用：屏蔽是观点，要不要你自己定） |
| `qps` | `5` | 令牌桶速率 |
| `pricePerSuccessfulSearch` | `0.005` | 只用于界面上的费用提示 |
| `cacheTtlMs` / `cacheMaxEntries` | 10 分钟 / 60 条 | 客户端缓存 |
| `retryAttempts` / `retryBaseMs` | 2 / 600 | 429 与 5xx 的指数退避 |
| `storageNamespace` / `storageVersion` | `sift` / 1 | localStorage 命名空间与 schema 版本 |

## 项目结构

```
index.html               静态外壳（语义化结构 + 可访问性属性）
src/main.ts              入口 + service worker 注册
src/app.ts               控制器：唯一的状态与 DOM 写入点
src/config.ts            全部可调参数
src/core/                纯函数层，零 DOM，可单测
  api.ts                 HTTP 客户端：限速 → 超时 → 重试 → 错误分类
  rank.ts                重排与去重（语言克隆 / 同题 / 打分 / 同域降权）
  limiter.ts             令牌桶（队列，不是丢弃）
  cache.ts               TTL + LRU
  singleflight.ts        同 query 并发合并
  compare.ts             对比模式的 query 生成
  retry.ts               指数退避 + 抖动
  query.ts               文本 + 筛选 → 上游 query；高亮词提取
  highlight.ts           先转义后加 <mark>
  format.ts              日期 / 耗时 / 金额 / 域名
  storage.ts             带版本信封的 localStorage 封装
  types.ts               API 返回类型 + 错误类型
src/ui/dom.ts            极简 DOM 助手（h / must / debounce / copy）
src/styles.css           主题 token + 组件样式（深/浅 / 对比网格）
server/proxy.mjs         可选代理（零依赖，BYOK 转发或共享 key）
public/                  manifest / icon / service worker
tests/                   100 个单元测试
e2e/run.mjs              CDP 驱动的端到端测试（无 Playwright）
scripts/serve.mjs        零依赖静态服务器
scripts/bench.mjs        质量基准：固定 10 查询，对比重排前后
docs/ARCHITECTURE.md     设计决策与数据流
```

## 测试

```bash
npm test        # 11 文件 115 用例：限速/缓存/合并/重试/查询/对比/重排/高亮/存储/HTTP/代理
npm run e2e     # 26 项：Key 门 → 搜索 → 高亮 → 分页 → 缓存 → 去重 → 对比 → 正文 → 401 → 主题
```

e2e 用 CDP 直连本机 Chrome（`CHROME_PATH` 可覆盖），离线模式把 `window.fetch` 打桩，
跑一百遍也不花钱；`--live` 才走真网络。实测：

```
离线：26/26 checks passed
真网：17/17 checks passed（48 条 / 5 页 / 759ms / 合并重复 2 · 同域降权 3；对比 4 栏并排）
```

## 部署

产物是纯静态文件，扔到任何静态托管（Nginx、OSS、Cloudflare Pages、GitHub Pages）即可。
`vite.config.ts` 里 `base: './'`，放到子路径也能跑。

```bash
npm run build
# dist/ 直接上传；本地预览：
npm run serve
```

PWA 需要 HTTPS（`localhost` 例外）；service worker 只缓存同源静态资源，
`api.deepseek.com` 的响应永远不进缓存。

## 合规与品牌红线

上公网之前，这三条是硬要求，不是建议：

1. **品牌**：开放平台服务协议 5.2 禁止使用「DeepSeek」商标、名称、域名、LOGO 做站点品牌，
   也禁止暗示「官方合作」。站名自己起，`config.ts` 里改。
2. **生成内容标识**：结果里的 `summary` 是模型生成的摘要，公开展示需按
   《AI 生成合成内容标识办法》加标识；纯 `snippet`（原文摘录）不涉及。
3. **备案与内容安全**：境内公网运营需 ICP 备案；作为网络信息内容生产者还需承担审核义务。
   本机 / 内网 demo 不涉及这些。

## 已知限制

- 只有 5 页（50 条），做不了无限翻页——接口上限，不是前端问题。
- 对比模式一次 4 个请求，冷门词在 5 QPS 下会排队约 0.8s。
- 没有搜索建议接口，联想只基于本地历史。
- 单一 provider，DeepSeek 侧故障时没有兜底引擎（可自行加）。
- 形态 C（共享 key）没有任何身份体系，防刷只能靠网关层。

## Roadmap

- [x] 多引擎并列（对比模式）
- [x] 可选后端代理（`server/proxy.mjs`）
- [x] PWA 离线壳
- [x] 本地重排与去重（`core/rank.ts` + `scripts/bench.mjs`）
- [ ] 答案层：10 条 `summary` → 模型合成带引用的答案（预计 ¥0.015/次）
- [ ] 结果页快照：`fetch` 正文后做本地全文高亮
- [ ] 对比模式支持自定义栏目与顺序
- [ ] 代理侧接入简单的配额/身份体系

## 版本说明

0.3.0。0.1.0 是 880px 单栏版本，从原型 [`search-shell/`](../search-shell/) 重写而来；
0.2 增加对比模式、PWA 与可选代理；0.3 增加本地重排与质量基准。
