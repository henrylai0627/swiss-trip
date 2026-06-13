# 🔄 一掣由 Google Doc 更新 — Vercel 部署步驟

個 button 喺 app 嘅 **ℹ️ 資料** 頁。撳一下 → Vercel function 喺 server 讀 Doc → call Claude 智能 merge(只改改咗嗰忽、保留交通 detail)→ 寫 Firestore → 你部 app 即時更新。

## 一次性設定

### 1. 攞 Anthropic API key
去 https://console.anthropic.com → API Keys → 開一個。增值少少錢(每次撳 sync 大約幾美仙)。

### 2. 將個 Google Doc 設成公開可讀
Doc 右上 **Share → General access → Anyone with the link → Viewer**。(Server 要咁先讀到。)

### 3. 部署上 Vercel
1. 去 https://vercel.com,用 GitHub 登入。
2. **Add New → Project → Import** `henrylai0627/swiss-trip`。
3. Framework Preset 揀 **Other**,其他唔使改,撳 **Deploy**。
   (Vercel 會自動將 `/api/sync.js` 變成 serverless function,`index.html` 照樣靜態 serve。)
4. 部署完,**Settings → Environment Variables** 加:
   - `ANTHROPIC_API_KEY` = 你嘅 key (必須)
   - `SYNC_TOKEN` = 隨便一串字 (建議,防人亂撳) — e.g. `bbq-swiss-2026`
   - (可選) `SYNC_MODEL` = `claude-sonnet-4-6` (預設) 或 `claude-opus-4-8`(更準但貴啲)
   加完 env var 要 **Redeploy** 一次先生效。
5. 你個 function URL = `https://<你個project名>.vercel.app/api/sync`

### 4. 將 URL 填返入 app
喺 `index.html` 搵 `const DOC_SYNC = { url: "", token: "" };`,填:
```js
const DOC_SYNC = { url: "https://你個project.vercel.app/api/sync", token: "bbq-swiss-2026" };
```
`git commit && git push` → GitHub Pages 更新後,ℹ️ 資料頁就會出現粒 🔄 制。
（token 喺前端係睇得到嘅,只係輕量防護,個人用足夠。）

## 用法
- 開 app → **ℹ️ 資料 → 🔄 立即由 Doc 更新**。
- **第一次撳**:只會初始化 baseline(記低而家個 Doc),唔 merge。
- BB 改完 Doc 之後再撳:就會 merge 改動入行程。Doc 冇改 → 即刻話你「冇改動」(慳 token)。

## 行得通嘅原理 / 安全
- Server 端 fetch Doc → 冇 CORS 問題。
- Claude 只回傳**有改動嘅日子**(完整 object),其餘日子由 server 原封 keep → 零風險覆蓋你嘅交通 detail。
- Function 加咗 CORS header,所以 GitHub Pages 個 app 叫得到。
- 想更穩陣可以將成個 app 都 host 喺 Vercel(同源,唔使靠 token)——但唔係必須。

## 同每日排程 routine 嘅關係
兩者做同一件事(智能 merge),可以並存:routine 每日自動跑;呢粒制畀你**即刻** sync。兩者共用同一個 Firestore baseline 概念(不過 routine 用 repo 檔、function 用 Firestore 檔做 baseline,獨立運作,唔會打架)。
