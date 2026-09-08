#!/usr/bin/env node
/**
 * 渲染：build/template.html + build/data.json -> index.html
 * ---------------------------------------------------------------
 * 用法：node build/render.js
 * 会先做一轮数据自检（字段、摘要长度、版块归属、链接安全），失败则不产出。
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const template = fs.readFileSync(path.join(__dirname, "template.html"), "utf8");
const data = JSON.parse(fs.readFileSync(path.join(__dirname, "data.json"), "utf8"));

/* ---------------- 自检 ---------------- */
const errs = [];
const warns = [];

if (!data.report || !data.report.date) errs.push("report.date 缺失");
if (!Array.isArray(data.sections) || data.sections.length !== 5)
  errs.push("sections 必须是 5 个固定版块");
if (!Array.isArray(data.items) || !data.items.length) errs.push("items 为空");

const ids = (data.sections || []).map(s => s.id);
(data.items || []).forEach((it, i) => {
  const tag = "#" + (i + 1);
  if (!ids.includes(it.sec)) errs.push(tag + " 版块 id 无效: " + it.sec);
  ["title", "plain", "source", "time", "aihot"].forEach(k => {
    if (!it[k]) errs.push(tag + " 缺字段 " + k);
  });
  const len = [...(it.plain || "")].length;
  if (len > 60) errs.push(tag + " 摘要 " + len + " 字，超过 60 字上限");
  if (Number.isNaN(Date.parse(it.time))) errs.push(tag + " 时间非法: " + it.time);
  if (!/^https?:\/\//.test(it.aihot || "")) errs.push(tag + " 主链接非法");
  if (it.original && !/^https?:\/\//.test(it.original)) warns.push(tag + " 原出处链接非法，将被忽略");
});

if (errs.length) {
  console.error("数据自检未通过，已中止：");
  errs.forEach(e => console.error("  x " + e));
  process.exit(1);
}
warns.forEach(w => console.log("  ! " + w));

/* ---------------- 渲染 ---------------- */
// 转义 </ 防止破坏 <script>
const json = JSON.stringify(data).replace(/<\//g, "<\\/");

if (!template.includes("__DATA_JSON__")) {
  console.error("模板缺少 __DATA_JSON__ 占位符");
  process.exit(1);
}

const out = template.replace("__DATA_JSON__", json);
fs.writeFileSync(path.join(root, "index.html"), out, "utf8");

/* ---------------- 汇总 ---------------- */
const counts = ids.map(id => {
  const s = data.sections.find(x => x.id === id);
  return s.label + " " + data.items.filter(i => i.sec === id).length;
});
console.log("已生成 index.html");
console.log("  日期:", data.report.date, "| 总条数:", data.items.length);
console.log("  " + counts.join(" / "));
if (data.weekly && data.weekly.length) console.log("  每周专题:", data.weekly.length, "篇");
