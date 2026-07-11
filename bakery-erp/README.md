# Bakery ERP — 中央倉 + 多門市

麵包店 ERP。核心架構:**一個中央倉(採購/庫存/出貨)+ 多個門市(烘焙/銷售/叫貨)**。
中央對供應商統一採購;門市不直接採購,缺料向中央「叫貨」,中央彙總出貨。原料目錄由中央維護,
但採「由下而上」模式:門市從目錄挑自己要備的料、目錄沒有的送申請,中央歸戶後代購。

由 Claude Design 高保真原型(`Bakery ERP Prototype v2.dc.html`)忠實移植:模板與業務邏輯
逐字保留為 spec,原型的 React/CDN 執行時換成本 app 自帶的迷你渲染器(`js/runtime.js`),
與本 repo 其他 app 一樣零依賴、零建置、開頁即用。

## 模組

- **地點與視角** — 頂欄切換器;門市視角(排程/生產/銷售/庫存/叫貨/備料/日結/報表)與
  中央倉視角(庫存/出貨與採購/原料目錄/門市地點/供應商)選單各自不同
- **叫貨調撥** — `叫貨 → 已出貨 → 已收貨`(+取消);need_date + 急件排序;
  短缺可**部分出貨**,缺量自動轉補貨單,採購到貨後補出
- **中央採購** — 依供應商自動拆單、含稅/稅前/稅率三欄連動、**分批對貨入庫**
  (received_qty 累計)、退貨補送/退貨減單、結案歸檔
- **原料目錄 + 申請歸戶** — 門市申請 → 中央「轉入目錄/併入現有/婉拒」,急件優先
- **產品與配方(中央維護)** — 產品歸屬門市(`product.location_id`:空/`ALL`=共用、
  多店用 `|` 分隔);中央可篩選門市、以 chips 改歸屬;門市唯讀,排程/前台只見本店產品;
  進貨單改價自動回寫原料主檔報價(稅前/含稅/稅率)
- **庫存** — 分類篩選、**包裝換算**(27,500 g → 1 袋未開封 + 1 袋開封中)、補貨面板、
  盤點寫差異流水、來源中文流水
- **生產** — 每日排程(BOM 展開、逆推甘特、負載檢查)、工位任務板/流水線/人員時間軸、批次追溯
- **前台銷售 / 日結 / 報表** — 磁磚結帳(冪等鍵)、剩餘處置(報廢/留存/員工價)、毛利排行
- **開始設定** — 11 步建置嚮導,完成狀態由資料自動偵測

## 設計不變式

1. `stock_ledger` **append-only** — 任何庫存變動(採購/退貨/調撥/投料/入庫/銷售/報廢/盤點)
   都是寫流水;結存永遠是「按 location_id 加總」算出來的,不可直接改。
2. 單據**狀態機** — transfer_order(叫貨→已出貨→已收貨/取消)、purchase_line
   (已下單/廠商已確認/配送中/補送中/暫緩/退貨 → 部分到貨/已到貨)。

## 登入與名單控管(Phase 1)

雲端模式(方案 B)強制 **Google 登入 + email 名單**;名單驗證在 Apps Script 後端,
前端閘門只是 UX — 沒有有效 token,後端一律拒絕(登入前零資料流量):

- 登入頁「使用 Google 帳戶登入」→ 後端驗證 Google ID token(比對 `AUTH.CLIENT_ID`)→
  email 在 `user_account` 分頁且 `active=TRUE` → 核發 6 小時工作階段 token
- 不在名單 → 「此帳號尚未開通」畫面,看不到任何內容
- `user_account` 分頁只有 `super_admin` 能讀寫;`setup`/`migrate` 也僅限 `super_admin`
- 本地示範模式(無連線設定)不需登入 — 示範資料照舊試玩

**後端一次性設定**:`apps-script.js` 開頭填 `AUTH.CLIENT_ID`(同前端 OAuth Client ID)與
`AUTH.BOOTSTRAP_ADMIN`(第一位管理員 Gmail)→ 執行 `migrate`(建 `user_account` 分頁)→
部署新版本。管理員首次登入自動建立 `super_admin` 帳號;之後在 `user_account` 分頁加列開通
其他人(name / email / role / location_ids / active=TRUE)。
`AUTH.CLIENT_ID` 留空 = 不驗證(行為同 v2,僅供本機測試)。

角色權限(super_admin / store_admin 依 `location_ids` 限縮視角與畫面)為下一階段。

## 資料與連線

- **預設空表**:全新裝置一律從空資料開始(只保證中央倉地點存在),落在「開始設定」嚮導 —
  連上 Google Sheet 前不載入任何示範資料;示範資料是 opt-in(頂欄「重置示範資料」或
  資料連線頁「還原示範資料」才會載入種子快照)。
- **自動連線**:裝置第一次開啟時,只要有 GAS `/exec` 網址(部署注入或本機設定)就自動以
  方案 B 連線並以 Sheet 內容覆蓋本地;完全沒有連線設定才停留在本地(localStorage)模式。
  在「資料連線」按「切回本地示範」後,該裝置不再自動連線。
- 可選 **Google Sheets 同步**(「資料連線」頁):
  - 方案 A — Sheets API 直連(API key 讀、OAuth 寫)
  - 方案 B — Apps Script 極薄後端(`apps-script.js`;`setup()` 重建、`migrate()` 保留資料升級)
- 連線預設值:部署時由 GitHub Actions secrets(`GOOGLE_CLIENT_ID` / `GOOGLE_API_KEY` /
  `BAKERY_SHEET_ID` / `BAKERY_GAS_URL`)注入 `index.html` 佔位符;本機開發放一個
  gitignored 的 `google-config.local.js`:

  ```js
  window.BAKERY_CFG = { sheetId: '…', apiKey: '…', clientId: '…', gasUrl: '…/exec' };
  ```

## 檔案

```
bakery-erp/
├── index.html        ← 樣式 + 全部畫面模板(<script type="text/x-template">)
├── js/
│   ├── runtime.js    ← 迷你模板執行時(sc-if / sc-for / {{binding}} → DOM morph)
│   ├── app.js        ← 業務邏輯(Component 類:狀態機、MRP、排程、渲染值)
│   ├── db.js         ← 22 表 SCHEMA + 種子 + localStorage/Sheets 資料層
│   └── seed-data.js  ← 門市真實資料快照(示範重置用)
├── apps-script.js    ← Google Apps Script 後端(選用)
└── semi-import.json  ← 半成品配方匯入資料(原料目錄「匯入半成品」用)
```

本機開發:與整個 repo 相同 — 根目錄 `npm start`(http-server,port 8000),開
`http://localhost:8000/bakery-erp/`(ES modules 不能用 `file://` 直開)。
