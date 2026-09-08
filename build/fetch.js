#!/usr/bin/env node
/**
 * 拉取 AI HOT 候选池
 * ---------------------------------------------------------------
 * 用法：node build/fetch.js [日期]
 *   不传日期 -> 取 /dailies/latest
 *   传日期   -> 取 /dailies/{YYYY-MM-DD}，若 404 再回退 latest
 *
 * 输出：build/candidates.json
 *   { fetchedAt, report: {date,...}, daily: [...], pool: { 分类: [条目...] } }
 *
 * 只负责拉数，不做筛选和改写 —— 选条目、写大白话摘要由人工/模型完成。
 */
const fs = require("fs");
const path = require("path");

const BASE = "https://aihot.virxact.com/api/v1";
const UA = "aihot-skill/1.2.1 (+https://aihot.virxact.com/aihot-skill/)";
const OUT = path.join(__dirname, "candidates.json");

const SECTIONS = [
  { id: "ai-models",   label: "模型发布/更新" },
  { id: "ai-products", label: "产品发布/更新" },
  { id: "industry",    label: "行业动态" },
  { id: "paper",       label: "论文研究" },
  { id: "tip",         label: "技巧与观点" }
];

async function get(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!res.ok) return { __status: res.status };
  return res.json();
}

/** 时间轴口径：历史回填（discovered - published > 72h）用 published，否则用 discovered */
function timelineTime(it) {
  const p = it.publishedAt ? Date.parse(it.publishedAt) : null;
  const d = it.discoveredAt ? Date.parse(it.discoveredAt) : null;
  if (p == null) return it.discoveredAt;
  if (d == null) return it.publishedAt;
  return d - p > 72 * 3600 * 1000 ? it.publishedAt : it.discoveredAt;
}

function slim(it) {
  return {
    title: it.title,
    summary: it.summary || "",
    source: (it.source && it.source.name) || "未标注来源",
    category: it.category,
    score: it.score ?? null,
    time: timelineTime(it),
    aihot: (it.links && it.links.aihot) || "",
    original: (it.links && it.links.original) || ""
  };
}

async function fetchAll(wanted) {
  let daily = null;

  if (wanted) {
    const r = await get(`${BASE}/dailies/${wanted}`);
    if (r && r.report) daily = r.report;
  }
  if (!daily) {
    const r = await get(`${BASE}/dailies/latest`);
    if (r && r.report) daily = r.report;
  }
  if (!daily) {
    // 只做一次有界索引查询，绝不猜日期
    const idx = await get(`${BASE}/dailies?limit=7`);
    const first = idx && idx.items && idx.items[0];
    if (first) {
      const r = await get(`${BASE}/dailies/${first.date}`);
      if (r && r.report) daily = r.report;
    }
  }
  if (!daily) throw new Error("日报接口不可用，无法获取任何一期日报");

  // 日报自带条目
  const dailyItems = [];
  (daily.sections || []).forEach(s => {
    (s.items || []).forEach(it => dailyItems.push({ ...slim(it), __fromDaily: true }));
  });
  (daily.flashes || []).forEach(it => dailyItems.push({ ...slim(it), __fromDaily: true }));

  // 并行拉滚动窗口与各分类
  const urls = [
    `${BASE}/items?mode=selected&window=24h&limit=50`,
    `${BASE}/items?mode=selected&window=7d&limit=50`,
    ...SECTIONS.map(s => `${BASE}/items?mode=selected&category=${s.id}&window=7d&limit=20`)
  ];
  const results = await Promise.all(urls.map(get));

  // 合并去重（优先按 id 无法拿到，用 aihot 链接或标题去重）
  const seen = new Set();
  const pool = [];
  results.forEach(r => {
    (r && r.items ? r.items : []).forEach(it => {
      const key = (it.links && it.links.aihot) || it.title;
      if (!key || seen.has(key)) return;
      seen.add(key);
      pool.push(slim(it));
    });
  });

  // 日报条目若已在池里，标记来源
  const byLink = new Map(pool.map(i => [i.aihot || i.title, i]));
  dailyItems.forEach(d => {
    const hit = byLink.get(d.aihot || d.title);
    if (hit) hit.__fromDaily = true;
    else pool.push(d);
  });

  const grouped = {};
  SECTIONS.forEach(s => {
    grouped[s.id] = pool
      .filter(i => i.category === s.id)
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  });

  const out = {
    fetchedAt: new Date().toISOString(),
    reportDate: daily.date,
    reportLink: (daily.links && daily.links.aihot) || `https://aihot.news/daily/${daily.date}`,
    dailyCount: dailyItems.length,
    sections: SECTIONS,
    pool: grouped,
    daily: dailyItems
  };

  fs.writeFileSync(OUT, JSON.stringify(out, null, 2), "utf8");

  console.log("日报日期:", out.reportDate, "| 日报自带条目:", out.dailyCount);
  console.log("候选池（按分类）:");
  SECTIONS.forEach(s => console.log("  " + s.label.padEnd(8, "　") + grouped[s.id].length + " 条"));
  console.log("总计:", pool.length, "-> build/candidates.json");
  if (out.dailyCount < 5) {
    console.log("\n注意：今日日报条目偏少（" + out.dailyCount + " 条），需要用候选池补足，并在页面注明数据口径。");
  }
  return out;
}

module.exports = { fetchAll };

if (require.main === module) {
  fetchAll(process.argv[2]).catch(e => {
    console.error("拉取失败:", e.message);
    process.exit(1);
  });
}
