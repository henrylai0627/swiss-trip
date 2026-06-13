// Vercel serverless function — 由 Google Doc 智能同步去 Firestore
// 流程:讀 Doc → 同 baseline 比 → call Claude 只 merge 改咗嘅日子 → 寫 Firestore
// 需要 Vercel env vars: GEMINI_API_KEY (必須,免費 tier)、SYNC_TOKEN (建議)、FIREBASE_API_KEY (可選,有 default)
//
// 前提:個 Google Doc 要設成「任何有連結嘅人可檢視」,server 先讀到。

const PROJECT = "swiss-trip-9069a";
const ROOM = "bbhenry-swiss26-kq84z";
const DOC_ID = "1OJOUz8FJSG1v7O1dAdZn6_vPL6yTRbKqA1m4IYPd_kk";
const FB_KEY = process.env.FIREBASE_API_KEY || "AIzaSyBZrWb2ggq5FNDXmACRZu8AikY05KUxB90";
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const SYNC_TOKEN = process.env.SYNC_TOKEN || "";
const MODEL = process.env.SYNC_MODEL || "gemini-2.5-flash";

const FS = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;

// ---- Firestore value <-> JS ----
function enc(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === "string") return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(enc) } };
  const fields = {};
  for (const k of Object.keys(v)) fields[k] = enc(v[k]);
  return { mapValue: { fields } };
}
function dec(v) {
  if (!v || typeof v !== "object") return null;
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("nullValue" in v) return null;
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(dec);
  if ("mapValue" in v) {
    const o = {}; const f = v.mapValue.fields || {};
    for (const k of Object.keys(f)) o[k] = dec(f[k]);
    return o;
  }
  return null;
}

async function fsGet(path, params = "") {
  const r = await fetch(`${FS}/${path}?key=${FB_KEY}${params}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`Firestore GET ${path} ${r.status}`);
  return r.json();
}
async function fsPatch(path, fields, maskFields) {
  const mask = maskFields.map((f) => `updateMask.fieldPaths=${f}`).join("&");
  const r = await fetch(`${FS}/${path}?key=${FB_KEY}&${mask}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fields }),
  });
  if (!r.ok) throw new Error(`Firestore PATCH ${path} ${r.status}: ${(await r.text()).slice(0, 300)}`);
}

async function fetchDoc() {
  const r = await fetch(`https://docs.google.com/document/d/${DOC_ID}/export?format=txt`, { redirect: "follow" });
  if (!r.ok) throw new Error(`Doc 讀唔到 (${r.status}) — 係咪未設成「連結可檢視」?`);
  return (await r.text()).replace(/\r\n/g, "\n").trim();
}

// 精簡每日資料畀 Gemini —— 唔送 tl(交通細節 + HTML),避免 round-trip 整爆 JSON
function slimDays(days) {
  return days.map((d) => ({
    id: d.id,
    date: d.date,
    title: d.title,
    route: d.route,
    hotel: d.hotel ? { nm: d.hotel.nm, loc: d.hotel.loc } : null,
    costs: d.costs || [],
    meals: (d.meals || []).map((m) => ({ b: m.b, v: m.v })),
    tips: d.tips || [],
  }));
}

function mealEmoji(b) {
  const s = String(b || "").toLowerCase();
  if (s.includes("break") || s.includes("早")) return "🌅";
  if (s.includes("lunch") || s.includes("午")) return "☀️";
  if (s.includes("din") || s.includes("晚")) return "🌙";
  if (s.includes("買") || s.includes("記")) return "🛒";
  return "🍽️";
}

// 將 Gemini 嘅 patch 套落真正 day,只改有畀嘅欄位,tl/s/m/hl 原封不動
function applyPatch(cur, p) {
  const next = { ...cur };
  if (typeof p.title === "string" && p.title.trim()) next.title = p.title;
  if (typeof p.route === "string" && p.route.trim()) next.route = p.route;
  if (p.hotel && typeof p.hotel === "object") {
    next.hotel = { ...(cur.hotel || {}) };
    if (typeof p.hotel.nm === "string") next.hotel.nm = p.hotel.nm;
    if (typeof p.hotel.loc === "string") next.hotel.loc = p.hotel.loc;
  }
  if (Array.isArray(p.costs)) next.costs = p.costs.map(String);
  if (Array.isArray(p.tips)) next.tips = p.tips.map(String);
  if (Array.isArray(p.meals)) {
    const old = cur.meals || [];
    next.meals = p.meals
      .filter((m) => m && m.b)
      .map((m) => {
        const prev = old.find((o) => o.b === m.b);
        return { k: (prev && prev.k) || mealEmoji(m.b), b: String(m.b), v: String(m.v || "") };
      });
  }
  return next;
}

async function geminiMerge(baselineDoc, newDoc, days) {
  const sys =
    "你係旅遊行程同步助手。會收到 BB 改前(baseline)同改後(new)嘅 Google Doc 純文字、同現有行程嘅精簡資料(slim days JSON,每日有 id)。\n" +
    "任務:對比 new Doc 同 baseline,搵出改咗邊日邊樣嘢,只回傳要更新嘅欄位 patch。\n" +
    "Doc 欄位對照:Date→title、Venue→route、Hotel→hotel{nm,loc}、Travel Fee→costs(string array)、Meal→meals(array of {b,v},b=餐種如Breakfast/Lunch/Dinner、v=內容)、Entertainment+Remark→tips(string array)。\n" +
    "用 id 對應日子(根據 date / title 配對 Doc 嗰一行)。\n" +
    "鐵則:① 只輸出真係改咗嘅欄位,冇改嘅欄位完全唔好出現。② Time 欄唔好理(行程時間細節由網站獨立管理,唔受 Doc 影響)。③ 唔好亂作資料。\n" +
    '淨係輸出 JSON,格式:{"summary":"<中文一句講改咗乜,或「冇改動」>","patches":[{"id":"dXXXX","<只放改咗嘅欄位>":<值>} ...]}。冇改動時 patches 係空 array。';
  const user =
    `=== BASELINE DOC ===\n${baselineDoc}\n\n=== NEW DOC ===\n${newDoc}\n\n=== CURRENT DAYS (slim JSON) ===\n${JSON.stringify(slimDays(days))}`;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_KEY}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: sys }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig: { temperature: 0, maxOutputTokens: 4096, responseMimeType: "application/json" },
    }),
  });
  if (!r.ok) throw new Error(`Gemini API ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const j = await r.json();
  const parts = ((j.candidates || [])[0] || {}).content;
  let txt = parts && parts.parts ? parts.parts.map((p) => p.text || "").join("").trim() : "";
  txt = txt.replace(/^```json\s*/i, "").replace(/^```\s*/, "").replace(/```$/, "").trim();
  const s = txt.indexOf("{"), e = txt.lastIndexOf("}");
  if (s < 0 || e < 0) throw new Error("Gemini 冇回傳 JSON");
  return JSON.parse(txt.slice(s, e + 1));
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type, x-sync-token");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (SYNC_TOKEN && req.headers["x-sync-token"] !== SYNC_TOKEN)
    return res.status(401).json({ error: "unauthorized" });
  if (!GEMINI_KEY) return res.status(500).json({ error: "未設 GEMINI_API_KEY" });

  let step = "init";
  try {
    step = "fetchDoc";
    const newDoc = await fetchDoc();

    step = "getBaseline";
    const baseDocPath = `trips/_docsync_swiss`;
    const baseSnap = await fsGet(baseDocPath);
    const baseline = baseSnap && baseSnap.fields && baseSnap.fields.baseline ? dec(baseSnap.fields.baseline) : null;

    if (baseline === null) {
      step = "storeBaseline";
      await fsPatch(baseDocPath, { baseline: enc(newDoc) }, ["baseline"]);
      return res.status(200).json({ status: "init", message: "已初始化 baseline,下次改 Doc 先有得 merge。" });
    }
    if (newDoc === baseline) return res.status(200).json({ status: "nochange", message: "Doc 冇改動 ✅" });

    step = "getDays";
    const snap = await fsGet(`trips/${ROOM}`, "&mask.fieldPaths=days&mask.fieldPaths=dayOrder");
    const daysMap = snap && snap.fields && snap.fields.days ? dec(snap.fields.days) : {};
    const order = snap && snap.fields && snap.fields.dayOrder ? dec(snap.fields.dayOrder) : Object.keys(daysMap);
    const days = order.map((id) => daysMap[id]).filter(Boolean);

    step = "geminiMerge";
    const merged = await geminiMerge(baseline, newDoc, days);
    const patches = Array.isArray(merged.patches) ? merged.patches : [];

    if (!patches.length) {
      await fsPatch(baseDocPath, { baseline: enc(newDoc) }, ["baseline"]);
      return res.status(200).json({ status: "nochange", message: merged.summary || "冇實質改動 ✅" });
    }

    step = "patchFirestore";
    const changedIds = [];
    for (const p of patches) {
      if (!p || !p.id || !daysMap[p.id]) continue;
      daysMap[p.id] = applyPatch(daysMap[p.id], p);
      changedIds.push(p.id);
    }
    if (!changedIds.length) {
      await fsPatch(baseDocPath, { baseline: enc(newDoc) }, ["baseline"]);
      return res.status(200).json({ status: "nochange", message: merged.summary || "冇對應到日子 ✅" });
    }
    await fsPatch(`trips/${ROOM}`, { days: enc(daysMap), dayOrder: enc(order) }, ["days", "dayOrder"]);
    await fsPatch(baseDocPath, { baseline: enc(newDoc) }, ["baseline"]);

    return res.status(200).json({
      status: "updated",
      message: merged.summary || "已更新",
      changedDays: changedIds,
    });
  } catch (e) {
    return res.status(500).json({ step, error: String(e.message || e) });
  }
};
