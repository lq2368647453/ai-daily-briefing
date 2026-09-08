#!/usr/bin/env node
/**
 * 通过 GitHub REST API 发布（不依赖 git push / github.com 主站）
 * ---------------------------------------------------------------
 * 为什么不用 git push：本机代理对 github.com 返回 502，只有 api.github.com 可达。
 * 所以这里全走 REST API：建仓库、开 Pages、更新文件。
 *
 * 用法：
 *   node build/publish.js                 # 更新 index.html
 *   node build/publish.js --init          # 首次：建仓库 + 开 Pages + 推文件
 *   node build/publish.js --all           # 连 build/ 下的源文件一起推（备份）
 *
 * 需要的凭证（任一方式）：
 *   环境变量 GITHUB_TOKEN  或  .gh-config/token 文件
 *   环境变量 GITHUB_REPO   或  .gh-config/repo  文件（格式 owner/repo）
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const cfgDir = path.join(root, "..", ".gh-config");

function readSecret(name, envName) {
  if (process.env[envName]) return process.env[envName].trim();
  const f = path.join(cfgDir, name);
  if (fs.existsSync(f)) return fs.readFileSync(f, "utf8").trim();
  return "";
}

const TOKEN = readSecret("token", "GITHUB_TOKEN");
const REPO = readSecret("repo", "GITHUB_REPO");

if (!TOKEN) {
  console.error("缺少 GitHub Token。请设置环境变量 GITHUB_TOKEN，或写入 .gh-config/token");
  process.exit(1);
}
if (!REPO || !REPO.includes("/")) {
  console.error("缺少仓库名。请设置 GITHUB_REPO=owner/repo，或写入 .gh-config/repo");
  process.exit(1);
}

const API = "https://api.github.com";
const H = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: "application/vnd.github+json",
  "User-Agent": "ai-daily-briefing-publisher",
  "X-GitHub-Api-Version": "2022-11-28"
};

async function call(method, url, body) {
  const res = await fetch(API + url, {
    method,
    headers: { ...H, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
  if (!res.ok) {
    const msg = (json && json.message) || text.slice(0, 200);
    const err = new Error(`${method} ${url} -> ${res.status} ${msg}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

/** 创建或更新单个文件（路径按段编码，保留 / 分隔符） */
async function upsertFile(filePath, localPath, message) {
  const content = fs.readFileSync(localPath);
  const b64 = content.toString("base64");
  const apiPath = filePath.split("/").map(encodeURIComponent).join("/");
  let sha = null;
  try {
    const cur = await call("GET", `/repos/${REPO}/contents/${apiPath}`);
    sha = cur && cur.sha;
  } catch (e) {
    if (e.status !== 404) throw e;
  }
  const res = await call("PUT", `/repos/${REPO}/contents/${apiPath}`, {
    message,
    content: b64,
    ...(sha ? { sha } : {})
  });
  return { created: !sha, commit: res.commit && res.commit.sha };
}

(async () => {
  const args = process.argv.slice(2);
  const doInit = args.includes("--init");
  const doAll = args.includes("--all");
  const stamp = new Date().toISOString().slice(0, 10);

  if (doInit) {
    let me;
    try {
      me = await call("GET", "/user");
    } catch (e) {
      console.error("Token 无效或权限不足：", e.message);
      process.exit(1);
    }
    console.log("已认证用户:", me.login);

    // 建仓库（已存在则忽略）
    const [owner, name] = REPO.split("/");
    try {
      await call("POST", "/user/repos", {
        name,
        description: "AI 日报晨报 · 每日自动更新",
        private: false,
        auto_init: false
      });
      console.log("仓库已创建:", REPO);
    } catch (e) {
      if (e.status === 422) console.log("仓库已存在，跳过创建");
      else throw e;
    }

    // 开 Pages（legacy 分支模式，从 main 根发布）
    try {
      await call("POST", `/repos/${REPO}/pages`, {
        build_type: "legacy",
        source: { branch: "main", path: "/" }
      });
      console.log("Pages 已开启: main 分支 / 根目录");
    } catch (e) {
      const m = e.message || "";
      if (m.includes("409") || e.status === 409) console.log("Pages 已开启，跳过");
      else {
        console.log("Pages 自动开启失败，请手动到 Settings -> Pages 选择 main 分支 / root。");
        console.log("   原因:", m.slice(0, 160));
      }
    }
    // 仓库还没有任何提交时 Pages 建不出来，先把文件推上去
    await upsertFile("index.html", path.join(root, "index.html"), `chore: 初始化 AI 日报 ${stamp}`);
    try {
      await call("POST", `/repos/${REPO}/pages`, {
        build_type: "legacy",
        source: { branch: "main", path: "/" }
      });
      console.log("Pages 已开启: main 分支 / 根目录");
    } catch (e) { /* 上面已提示过 */ }
  }

  const r = await upsertFile("index.html", path.join(root, "index.html"), `chore: 更新 AI 日报 ${stamp}`);
  console.log((r.created ? "已创建" : "已更新") + " index.html -> " + (r.commit || "").slice(0, 7));

  // data.json 必须同步：GitHub Actions 靠它的 report.date 判断本机是否已发过精修版
  await upsertFile("build/data.json", path.join(root, "build", "data.json"), `chore: 同步数据 ${stamp}`);
  console.log("  已同步 build/data.json");

  if (doAll) {
    for (const f of [
      "build/data.json", "build/template.html", "build/render.js", "build/fetch.js",
      "build/actions-build.js", "build/publish.js", "build/README.md",
      ".github/workflows/daily.yml", ".gitignore"
    ]) {
      const p = path.join(root, f);
      if (fs.existsSync(p)) {
        await upsertFile(f, p, `chore: 同步构建脚本 ${stamp}`);
        console.log("  已同步 " + f);
      }
    }
  }

  const [owner, name] = REPO.split("/");
  let url = "";
  try {
    const pg = await call("GET", `/repos/${REPO}/pages`);
    url = (pg && pg.html_url) || "";
  } catch { /* 未开启 */ }
  if (url) console.log("\n站点地址: " + url);
  else {
    const repoInfo = await call("GET", `/repos/${REPO}`);
    console.log("\n仓库: " + repoInfo.html_url);
    console.log("Pages 地址（开启后）: https://" + owner + ".github.io/" + name + "/");
  }
  console.log("提示：Pages 首次发布需等 1-3 分钟。");
})().catch(e => {
  console.error("发布失败:", e.message);
  process.exit(1);
});
