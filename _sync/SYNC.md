# Doc → Website 合併流程 (Sync workflow)

**方向**:Google Doc 係 BB 嘅高層規劃稿;**網站 (`index.html` 的 `BUILTIN_DAYS` → Firestore) 係詳細版嘅家**。
BB 改 Doc 後,由 Claude 做 **delta 合併**:只將 Doc 真正改咗嘅嘢併入網站,**唔掂**已有嘅交通細節 / 月台 / 地圖 pin / 後備班次 / Simplon 警告。

## 來源
- Google Doc: https://docs.google.com/document/d/1OJOUz8FJSG1v7O1dAdZn6_vPL6yTRbKqA1m4IYPd_kk/edit
- 基準快照: [`doc-baseline.md`](doc-baseline.md)(每次合併後更新)

## 點觸發
喺同 Claude 嘅 session 度講一句,例如:**「sync 個 doc」**。
(因為讀 Google Doc 要 Drive 連線,headless / 排程 cloud agent 未必連到,所以用 on-demand 最穩。)

## Claude 合併步驟
1. 讀最新 Google Doc(Drive MCP `read_file_content`,fileId `1OJOUz8FJSG1v7O1dAdZn6_vPL6yTRbKqA1m4IYPd_kk`)。
2. Diff:最新 Doc vs `doc-baseline.md` → 列出 BB 改咗嘅 cell(邊日、邊欄)。
3. 將 delta 併入 `index.html` 的 `BUILTIN_DAYS`,**只改受影響欄位**:
   - 時間/活動有實質改動 → 更新對應 `tl` item 的 `t`/`x`(若涉及交通,順手用 transport.opendata.ch 查實新班次再寫 `s`/`m`)。
   - 純粹高層改動(餐廳、費用、景點、連結)→ 更新 `meals`/`costs`/`links`/`tips`。
   - **絕不**清走已有 `s`/`m`/`hl`,除非該 item 本身被刪/換。
4. 向 Henry 報告改咗乜(一行一個 delta)。
5. 更新 `doc-baseline.md` = 最新 Doc 內容。
6. `git commit && push`。
7. 提醒 reseed:電腦 browser 開 app 入房號 → Console `DAYS = BUILTIN_DAYS; pushDays();`。

## Doc 欄位 → 網站欄位 對照
| Doc 欄 | 網站欄位 |
| --- | --- |
| Date | `date` / `title` / `chip` |
| Venue | `route` / `title` |
| Hotel | `hotel` |
| Travel Fee | `costs[]` |
| Time | `tl[]`(逐個 `t` + `x`;detail 喺 `s`,地圖喺 `m`) |
| Meal | `meals[]` |
| Entertainment / Remark | `links[]` / `tips[]` |
