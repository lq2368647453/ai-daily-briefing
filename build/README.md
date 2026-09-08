# AI 日报晨报 —— 每日构建流程

站点：GitHub Pages（仓库公开，内容为 AI HOT 公开资讯）
产物：`index.html`（单文件，无外部依赖）

线上地址：https://lq2368647453.github.io/ai-daily-briefing/
仓库：`lq2368647453/ai-daily-briefing`

> 发布走 REST API（`publish.js`），**不要**用 `git push` 或 `gh auth login`——
> 本机代理对 github.com 主站返回 502，只有 api.github.com 可达。
> `publish.sh` 是给网络正常的环境留的，这台机器上跑不通。

## 目录

```
index.html            发布产物，由 render.js 生成，不要手改
server.js             本地预览用：node server.js -> http://localhost:3000
build/
  fetch.js            拉 AI HOT 候选池 -> build/candidates.json
  data.json           ★ 每天要改的就是这个（条目数据）
  template.html       HTML 模板（含 __DATA_JSON__ 占位符），一般不改
  render.js           data.json + template.html -> index.html（带数据自检）
  publish.sh          git commit & push，触发 Pages 更新
  split-template.js   一次性脚本，别再跑
  candidates.json     临时候选池，已 gitignore
```

## 每天三步

```bash
# 1. 拉候选池
node build/fetch.js

# 2. 人工/模型环节：读 candidates.json，优中选优 + 写大白话摘要，更新 build/data.json
#    - 五个版块都要有内容（models / products / industry / papers / tips）
#    - plain 字段：大白话，≤60 字，不用术语
#    - 日报条目太少时，用候选池补足，并在 report.scope 里注明口径

# 3. 渲染 + 发布（走 REST API，不用 git push）
node build/render.js
node build/publish.js          # 只推 index.html
node build/publish.js --all    # 连 build/ 源文件一起推（备份）
```

## data.json 结构

```jsonc
{
  "report": { "date": "2026-09-08", "weekday": "星期二", "scope": "数据口径说明", "sourceName": "AI HOT", "sourceUrl": "..." },
  "sections": [ { "id": "models", "label": "模型发布/更新", "short": "模型", "color": "#2563eb", "bg": "#eff6ff" } ],
  "items": [ { "sec": "models", "title": "...", "plain": "大白话摘要", "source": "来源", "time": "ISO8601", "aihot": "主链接", "original": "原出处" } ],
  "weekly": []   // 每周专题，填了才显示
}
```

`items` 数组顺序即全局编号顺序（按版块分组排列，跨版块连续编号，不在版块内重新计数）。

## 自检规则（render.js 会拦）

- `plain` 超过 60 字 → 报错中止
- 版块 id 不在 sections 里 → 报错中止
- `time` 不是合法 ISO 时间、链接不是 http(s) → 报错中止

## 每周专题

往 `data.json` 的 `weekly` 数组加对象即可，空数组则版块自动隐藏：

```jsonc
{ "period": "2026-09-01 ~ 2026-09-07", "title": "...", "recap": "...", "points": ["..."], "outlook": "..." }
```
