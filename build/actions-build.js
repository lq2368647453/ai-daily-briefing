#!/usr/bin/env node
/**
 * 云端兜底生成（GitHub Actions 用）
 * ---------------------------------------------------------------
 * 场景：本机 WorkBuddy 没开机时，Actions 自动跑这个脚本顶上，保证不断更。
 *
 * 自我保护：如果 build/data.json 里的 report.date 已经是今天（北京时间）
 * 且条目数 >= 15，说明本机精修版已经发过了，直接跳过，不覆盖精修版。
 *
 * 质量说明：这是纯机械版本 —— 按 score 排序 + 标题去重 + 截断原文摘要。
 * 摘要直接来自 AI HOT，可能含术语，不如人工精修版通俗。
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const { fetchAll } = require("./fetch.js");

const root = path.join(__dirname, "..");
const DATA = path.join(__dirname, "data.json");

const QUOTA = { "ai-models": 5, "ai-products": 5, industry: 6, paper: 4, tip: 6 };
const SEC_MAP = { "ai-models": "models", "ai-products": "products", industry: "industry", paper: "papers", tip: "tips" };

/** 北京时间今天 */
function todayBeijing() {
  const b = new Date(Date.now() + 8 * 3600 * 1000);
  return b.getUTCFullYear() + "-" + String(b.getUTCMonth() + 1).padStart(2, "0") + "-" + String(b.getUTCDate()).padStart(2, "0");
}

/** 标题 bigram 集合，用于判重 */
function sig(s) {
  const t = String(s || "").replace(/[^一-龥a-zA-Z0-9]/g, "");
  const set = new Set();
  for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2));
  if (t.length === 1) set.add(t[0]);
  return set;
}
function sim(a, b) {
  const A = sig(a), B = sig(b);
  let inter = 0;
  A.forEach(x => { if (B.has(x)) inter++; });
  const uni = A.size + B.size - inter;
  return uni ? inter / uni : 1;
}

/** 把原文摘要压到 60 字以内，尽量在标点处断开 */
function shorten(text, max = 58) {
  let s = String(text || "").replace(/\s+/g, " ").trim();
  if ([...s].length <= max) return s;
  let cut = s.slice(0, max);
  const marks = "。！？；，、,.!?;:：";
  let pos = -1;
  for (let i = cut.length - 1; i >= Math.floor(cut.length * 0.5); i--) {
    if (marks.includes(cut[i])) { pos = i; break; }
  }
  if (pos > 0) cut = cut.slice(0, pos);
  else cut = cut.slice(0, max - 1);
  return cut.replace(/[，,、；;：:。]$/, "") + "…";
}

/** 来源名精简：去掉冒号/括号后面的尾巴 */
function shortSource(name) {
  const s = String(name || "");
  const m = s.match(/^([^：（(]{2,18})/);
  return (m ? m[1] : s).trim() || "未标注";
}

(async () => {
  const today = todayBeijing();

  // ---- 自我保护：本机精修版已发则跳过 ----
  if (fs.existsSync(DATA)) {
    try {
      const cur = JSON.parse(fs.readFileSync(DATA, "utf8"));
      if (cur.report && cur.report.date === today && (cur.items || []).length >= 15) {
        console.log("SKIP: 本机精修版已发布（" + today + "，" + cur.items.length + " 条），跳过云端生成");
        process.exit(0);
      }
    } catch (e) {
      console.log("现有 data.json 解析失败，将重新生成");
    }
  }

  console.log("云端兜底生成，目标日期:", today);
  const data = await fetchAll();

  const picked = [];
  const order = ["ai-models", "ai-products", "industry", "paper", "tip"];

  for (const cat of order) {
    const list = (data.pool && data.pool[cat]) || [];
    // 日报自带条目优先
    const sorted = [...list].sort((a, b) => {
      if (!!b.__fromDaily !== !!a.__fromDaily) return b.__fromDaily ? 1 : -1;
      return (b.score ?? 0) - (a.score ?? 0);
    });

    const chosen = [];
    for (const it of sorted) {
      if (chosen.length >= (QUOTA[cat] || 4)) break;
      // 与已选条目重复则跳过
      if (chosen.some(c => sim(c.title, it.title) >= 0.42)) continue;
      // 与全局已选重复也跳过
      if (picked.some(c => sim(c.title, it.title) >= 0.42)) continue;
      chosen.push(it);
    }

    chosen.forEach(it => {
      picked.push({
        sec: SEC_MAP[cat],
        title: it.title,
        plain: shorten(it.summary || it.title),
        source: shortSource(it.source),
        time: it.time,
        aihot: it.aihot,
        original: it.original || ""
      });
    });
    console.log("  " + cat.padEnd(12) + chosen.length + " 条");
  }

  if (!picked.length) {
    console.error("没有拿到任何条目，中止");
    process.exit(1);
  }

  // 保留原有 weekly 专题与版块配置（读不到就用默认，保证 Actions 环境不炸）
  let weekly = [];
  let sections = null;
  try {
    const cur = JSON.parse(fs.readFileSync(DATA, "utf8"));
    weekly = cur.weekly || [];
    sections = cur.sections || null;
  } catch { /* 无 */ }
  if (!sections) {
    sections = [
      { id: "models", label: "模型发布/更新", short: "模型", color: "#2563eb", bg: "#eff6ff" },
      { id: "products", label: "产品发布/更新", short: "产品", color: "#0891b2", bg: "#ecfeff" },
      { id: "industry", label: "行业动态", short: "行业", color: "#d97706", bg: "#fffbeb" },
      { id: "papers", label: "论文研究", short: "论文", color: "#7c3aed", bg: "#f5f3ff" },
      { id: "tips", label: "技巧与观点", short: "技巧", color: "#059669", bg: "#ecfdf5" }
    ];
  }

  const weekday = "星期" + "日一二三四五六"[(new Date(Date.now() + 8 * 3600 * 1000)).getUTCDay()];

  const out = {
    report: {
      date: today,
      weekday,
      scope:
        "内容取自 AI HOT 日报（" + data.reportDate + "）及近期精选。" +
        (data.dailyCount < 5 ? "今日日报条目偏少，已用近期高优精选补足五个版块；" : "") +
        "本期由云端自动生成，摘要取自原文，可能保留少量专业术语。",
      sourceName: "AI HOT",
      sourceUrl: data.reportLink
    },
    sections: JSON.parse(fs.readFileSync(DATA, "utf8")).sections,
    items: picked,
    weekly
  };

  fs.writeFileSync(DATA, JSON.stringify(out, null, 2), "utf8");
  console.log("data.json 已更新:", picked.length, "条");

  // 渲染
  const r = spawnSync(process.execPath, [path.join(__dirname, "render.js")], { cwd: root, stdio: "inherit", encoding: "utf8" });
  if (r.status !== 0) {
    console.error("渲染失败");
    process.exit(1);
  }
  console.log("云端生成完成");
})().catch(e => {
  console.error("云端生成失败:", e.message);
  process.exit(1);
});
