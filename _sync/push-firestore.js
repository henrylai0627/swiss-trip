#!/usr/bin/env node
/*
 * push-firestore.js — 將 index.html 嘅 BUILTIN_DAYS 推上 Firestore。
 * 等同喺 app console 打 `DAYS = BUILTIN_DAYS; pushDays();`,但唔使開 browser。
 * 用 REST + apiKey,只 PATCH days / dayOrder(updateMask),其他欄位(tasks/inf/exps/rates)原封不動。
 *
 * 用法:  node _sync/push-firestore.js          (真正寫入)
 *        node _sync/push-firestore.js --dry     (只印出會寫乜,唔寫)
 * 需要 Node 18+ (global fetch)。
 */
const fs = require("fs");
const path = require("path");

const PROJECT = "swiss-trip-9069a";
const API_KEY = "AIzaSyBZrWb2ggq5FNDXmACRZu8AikY05KUxB90";
const ROOM = "bbhenry-swiss26-kq84z";
const HTML = path.join(__dirname, "..", "index.html");
const DRY = process.argv.includes("--dry");

// ---- 由 index.html 抽出 BUILTIN_DAYS(連 gm/pin 一齊 eval,因為 meals 用到 pin())----
function extractDays() {
  const h = fs.readFileSync(HTML, "utf8");
  const start = h.indexOf("const gm = q =>");
  const end = h.indexOf("// ---- 台北快閃");
  if (start < 0 || end < 0) throw new Error("搵唔到 BUILTIN_DAYS 區段");
  const code = h.slice(start, end) + "\n; return BUILTIN_DAYS;";
  return Function(code)();
}

// ---- JS value -> Firestore REST typed Value ----
function enc(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number")
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === "string") return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(enc) } };
  if (typeof v === "object") {
    const fields = {};
    for (const k of Object.keys(v)) fields[k] = enc(v[k]);
    return { mapValue: { fields } };
  }
  throw new Error("encode 唔到: " + typeof v);
}

async function main() {
  const days = extractDays();
  const daysMap = {};
  days.forEach((d) => (daysMap[d.id] = d));
  const dayOrder = days.map((d) => d.id);

  const body = {
    fields: {
      days: enc(daysMap),
      dayOrder: enc(dayOrder),
    },
  };

  console.log(`抽到 ${days.length} 日:`, dayOrder.join(", "));
  if (DRY) {
    console.log(`[dry-run] payload bytes ≈ ${JSON.stringify(body).length}`);
    return;
  }

  const url =
    `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/trips/${ROOM}` +
    `?key=${API_KEY}&updateMask.fieldPaths=days&updateMask.fieldPaths=dayOrder`;

  const res = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const txt = await res.text();
  if (!res.ok) {
    console.error(`❌ 寫入失敗 HTTP ${res.status}\n${txt.slice(0, 800)}`);
    process.exit(1);
  }
  console.log(`✅ 已推上 Firestore (room ${ROOM})。已 sync 嘅裝置會即時更新。`);
}

main().catch((e) => {
  console.error("❌", e.message);
  process.exit(1);
});
