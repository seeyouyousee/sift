# Sift

English | [简体中文](./README.md)

**A pure-static search page**: bring your own DeepSeek API key, the browser talks to the API directly, and the first screen is an **AI answer with citations**, not ten blue links.

![Sift](docs/screenshot-desktop.png)

## Start in 30 seconds

Requires Node ≥ 22 and a [DeepSeek API key](https://platform.deepseek.com/api_keys) (the account needs a balance; about ¥0.005 per search).

```bash
git clone https://github.com/seeyouyousee/sift.git && cd sift
npm ci && npm run dev        # → http://127.0.0.1:5173
```

Open the page → paste the key → search. The key is written only to your own browser's `localStorage`; it never passes through any server.

## What it does

- **Search** fetches 50 results in one go and paginates client-side; paging makes no requests, and repeated queries hit the cache.
- **AI summary** streams one paragraph synthesized from the top 8 sources, with `[1][2]` citations linking back to the originals; the card is labelled “AI summary”.
- **Merge duplicates** automatically merges multilingual clones of the same page (`/zh-cn/`, `/ko/`) and same-title duplicates.
- **Multi-site compare** splits one query into four columns (Zhihu / GitHub / Weibo / Bilibili), each billed and cached independently.
- **Also**: reader view, filter bar (site / language / time), light and dark themes, a PWA offline shell, `/` to focus the search box, `←/→` to page.

## Deploy

```bash
npm run build      # pure static output in dist/, about 19 kB gzipped
npm run serve      # local preview → http://127.0.0.1:8765
```

Drop it on any static host. The repo ships a GitHub Actions workflow: push to `main` and it deploys to Pages.

## Three things to know

1. **Not an official DeepSeek product.** Change the site name and domain to your own; do not use the DeepSeek brand (forbidden by section 5.2 of the open-platform terms).
2. **Everyone uses their own key and pays their own bill.** The rate limit is 5 requests/second per account; the browser connects directly to `api.deepseek.com`.
3. When showing AI summaries publicly, **keep the “AI summary” label** — that is a generated-content disclosure requirement.

## Development

```bash
npm test         # 133 unit tests
npm run e2e      # 31 end-to-end checks (offline stubs, costs nothing)
npm run e2e:live # hits the real API, about ¥0.03
```

Read the [design trade-offs](docs/ARCHITECTURE.md) before changing code — it records what was tried and deleted, and why.
Install details, configuration, cost model and the FAQ live in [docs/FAQ.md](docs/FAQ.md).

## License

[MIT](LICENSE)
