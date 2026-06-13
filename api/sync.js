// Vercel serverless function — 由 Google Doc 智能同步去 Firestore
// 流程:讀 Doc → 同 baseline 比 → call Claude 只 merge 改咗嘅日子 → 寫 Firestore
// 需要 Vercel env vars: ANTHROPIC_API_KEY (必須)、SYNC_TOKEN (建議)、FIREBASE_API_KEY (可選,有 default)
//
// 前提:個 Google Doc 要設成「任何有連結嘅人可檢視」,server 先讀到。

const PROJECT = "swiss-trip-9069a";
const ROOM = "bbhenry-swiss26-kq84z";
const DOC_ID = "1OJOUz8FJSG1v7O1dAdZn6_vPL6yTRbKqA1m4IYPd_kk";
const FB_KEY = process.env.FIREBASE_API_KEY || "AIzaSyBZrWb2ggq5FNDXmACRZu8AikY05KUxB90";
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const SYNC_TOKEN = process.env.SYNC_TOKEN || "";
const MODEL = process.env.SYNC_MODEL || "claude-sonnet-4-6";

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

async function claudeMerge(baselineDoc, newDoc, days) {
  const sys =
    "你係旅遊行程同步助手。會收到:BB 改前(baseline)同改後(new)嘅 Google Doc 純文字、同埋現有詳細 days 資料(JSON array)。\n" +
    "任務:搵出 new Doc 相對 baseline 改咗邊日邊樣嘢,將改動套落現有 days。\n" +
    "Doc 欄位對照:Date→date/title、Venue→route、Hotel→hotel、Travel Fee→costs、Time→tl(逐個 {t,x})、Meal→meals、Entertainment/Remark→links/tips。\n" +
    "鐵則:絕對保留每個 timeline item 已有嘅 s(交通細節)、m(地圖 pin)、hl,除非嗰個活動本身被刪/換。唔好為咗格式去重寫冇改過嘅嘢。\n" +
    "只回傳有改動嘅 day(完整 day object,schema 同輸入一樣)。\n" +
    '淨係輸出 JSON,格式:{"summary":"<中文一句講改咗乜,或「冇改動」>","changedDays":[<day object>...]}。冇改動時 changedDays 係空 array。';
  const user =
    `=== BASELINE DOC ===\n${baselineDoc}\n\n=== NEW DOC ===\n${newDoc}\n\n=== CURRENT DAYS (JSON) ===\n${JSON.stringify(days)}`;
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 8000,
      system: sys,
      messages: [{ role: "user", content: user }],
    }),
  });
  if (!r.ok) throw new Error(`Claude API ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const j = await r.json();
  let txt = (j.content || []).map((b) => b.text || "").join("").trim();
  txt = txt.replace(/^```json\s*/i, "").replace(/^```\s*/, "").replace(/```$/, "").trim();
  const s = txt.indexOf("{"), e = txt.lastIndexOf("}");
  if (s < 0 || e < 0) throw new Error("Claude 冇回傳 JSON");
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
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: "未設 ANTHROPIC_API_KEY" });

  try {
    const newDoc = await fetchDoc();

    // baseline
    const baseDocPath = `trips/_docsync_swiss`;
    const baseSnap = await fsGet(baseDocPath);
    const baseline = baseSnap && baseSnap.fields && baseSnap.fields.baseline ? dec(baseSnap.fields.baseline) : null;

    if (baseline === null) {
      await fsPatch(baseDocPath, { baseline: enc(newDoc) }, ["baseline"]);
      return res.status(200).json({ status: "init", message: "已初始化 baseline,下次改 Doc 先有得 merge。" });
    }
    if (newDoc === baseline) return res.status(200).json({ status: "nochange", message: "Doc 冇改動 ✅" });

    // current days (source of truth)
    const snap = await fsGet(`trips/${ROOM}`, "&mask.fieldPaths=days&mask.fieldPaths=dayOrder");
    const daysMap = snap && snap.fields && snap.fields.days ? dec(snap.fields.days) : {};
    const order = snap && snap.fields && snap.fields.dayOrder ? dec(snap.fields.dayOrder) : Object.keys(daysMap);
    const days = order.map((id) => daysMap[id]).filter(Boolean);

    const merged = await claudeMerge(baseline, newDoc, days);
    const changed = Array.isArray(merged.changedDays) ? merged.changedDays : [];

    if (!changed.length) {
      await fsPatch(baseDocPath, { baseline: enc(newDoc) }, ["baseline"]);
      return res.status(200).json({ status: "nochange", message: merged.summary || "冇實質改動 ✅" });
    }

    // 用 id 替換,其餘日子原封不動
    changed.forEach((d) => { if (d && d.id && daysMap[d.id]) daysMap[d.id] = d; });

    await fsPatch(`trips/${ROOM}`, { days: enc(daysMap), dayOrder: enc(order) }, ["days", "dayOrder"]);
    await fsPatch(baseDocPath, { baseline: enc(newDoc) }, ["baseline"]);

    return res.status(200).json({
      status: "updated",
      message: merged.summary || "已更新",
      changedDays: changed.map((d) => d.id),
    });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
};
