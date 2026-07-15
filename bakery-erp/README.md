# Bakery ERP — 中央倉 + 多門市

> A zero-dependency, single-page bakery ERP for a **central warehouse + multiple retail stores** operation. 純前端(vanilla JS,自帶迷你模板執行時)+ 選用的 Google Apps Script 後端。開頁即用、零建置。

麵包店 ERP。核心營運模型:**一個中央倉(採購 / 庫存 / 出貨)+ 多間門市(烘焙 / 銷售 / 叫貨)**。
中央對供應商統一採購;門市不直接向供應商採購,缺料時向中央「叫貨」,中央彙總後出貨。
原料目錄與**配方(BOM)由中央維護**,但採「由下而上」:門市從目錄挑自己要備的料、目錄沒有的送申請,中央歸戶後代購。

由 Claude Design 高保真原型忠實移植:模板與業務邏輯逐字保留為 spec,原型的 React/CDN 執行時換成本 app 自帶的迷你渲染器(`js/runtime.js`),與本 repo 其他 app 一樣零依賴、零建置。

---

## 目錄
- [營運模型](#營運模型)
- [功能總覽(依畫面)](#功能總覽依畫面)
- [角色與權限](#角色與權限)
- [資料模型(26 表)](#資料模型26-表)
- [設計不變式](#設計不變式)
- [近期新增](#近期新增)
- [架構與檔案](#架構與檔案)
- [資料與連線](#資料與連線)
- [後端設定與部署](#後端設定與部署)
- [本機開發](#本機開發)

---

## 營運模型

```
        供應商 ──採購──▶ ┌─────────┐ ──出貨(調撥)──▶ ┌────────┐  烘焙 → 銷售
                         │  中央倉  │ ◀───叫貨─────────│  門市   │
                         │ (LOC-C) │                  │ A / B… │
                         └─────────┘ ◀──新料申請──────└────────┘
        原料目錄 / 配方(BOM)由中央維護,門市唯讀
```

- **中央倉(LOC-C)**:向供應商採購、持有原料庫存、彙總各門市叫貨後出貨、維護原料目錄與產品配方。
- **門市(LOC-A 信義店 / LOC-B 大安店 / …)**:每日排程 → 開生產單 → 投料 → 製程 → 入庫 → 前台銷售;缺料向中央叫貨。
- 中央現行可配送**外購原料(整包)與自製半成品(以 g)**;**成品配送已完整實作**(`transfer_line` 多型欄位、出貨 / 收貨 / 部分出貨、成品整件計數與 UI 分頁),暫休眠於旗標 `FLAGS.transferItemTypes`(預設關,`js/app.js`,見[近期新增](#近期新增))。

---

## 功能總覽(依畫面)

畫面依角色與視角(中央倉 / 門市)動態顯示;導覽分三組。

### 營運
| 畫面 | 說明 |
|---|---|
| **開始設定** | 11 步建置嚮導,完成狀態由資料自動偵測 |
| **營運總覽** | 當日生產 / 銷售 / 缺料 / 待辦儀表板 |
| **每日排程** | 排入品項與數量 → 一鍵轉生產單;BOM 展開、逆推甘特、負載檢查、自製半成品自動補製單 |
| **生產管理** | 工位任務板(投料 → 製程 → 入庫)、流水線、人員時間軸、批次追溯;投料自動扣原料、入庫自動記成品、差額自動記報廢 |
| **前台銷售** | 磁磚結帳(冪等鍵防重複)、日結剩餘處置(報廢 / 留存 / 員工價) |
| **庫存** | 分類篩選、**包裝換算**(27,500 g → 1 袋未開封 + 1 袋開封中)、補貨、盤點寫差異流水、中文來源流水 |
| **出貨與採購 / 叫貨與採購** | 中央視角:② 彙總各店叫貨出貨(可**部分出貨**、缺量轉補貨單)、③ 向供應商採購入庫;門市視角:① 向中央叫貨、確認收貨 |

### 主資料
| 畫面 | 說明 |
|---|---|
| **原料目錄 / 本店備料** | 中央維護原料主檔(含成本);門市從目錄挑本店要備的料、目錄沒有的送**申請歸戶** |
| **產品與配方** | 中央維護產品 + BOM + 工序;**多階配方下鑽**(點自製半成品原料 → 跳進它自己的配方,可多階、麵包屑退回);即時成本 / 毛利試算;產品歸屬門市(`location_id`:空 / `ALL` = 共用,多店以 `|` 分隔)。門市唯讀 |
| **門市地點** | 中央新增 / 管理門市(中央視角限定) |
| **供應商・設備** | 供應商付款條件、設備產能 / 批次時間 |
| **人員** | 員工名冊與角色 |

### 分析 / 系統
| 畫面 | 說明 |
|---|---|
| **報表** | 毛利排行、損耗原因、呆滯料 → 回饋調整計畫量 |
| **日結** | 剩餘品處置、當日結算 |
| **資料連線** | 本地 / 雲端(方案 A Sheets API、方案 B Apps Script)切換、重置示範資料 |
| **帳號與角色** | super_admin 管理使用者名冊與角色權限矩陣(即時生效) |

---

## 角色與權限

5 個角色 × 畫面矩陣;預設矩陣定義於 [`js/schema.js`](js/schema.js) 的 `DEFAULT_PERMS`(單一來源),可在 App 內「帳號與角色」或直接於 `role_permission` 分頁調整,即時生效。

| 角色 | 地點範圍 | 主要畫面 | 看成本 |
|---|---|---|:--:|
| `super_admin` | 全部 | 全部 + 帳號 / 連線 | ✅ |
| `central_ops` 中央 | 全部 | 設定、庫存、出貨採購、原料目錄、門市地點、產品配方、供應商 | ✅ |
| `store_admin` 店長 | 本店 | 總覽、排程、生產、銷售、庫存、叫貨、備料、產品(唯讀)、人員、報表、日結 | ❌ |
| `store_kitchen` 內場 | 本店 | 生產、產品(唯讀) | ❌ |
| `store_front` 外場 | 本店 | 前台銷售 | ❌ |

**強制點在後端,不是前端**(前端閘門只是 UX):
- **地點範圍**(`user_account.location_ids`)由後端 `filterRows_` / `rowInScope_` 強制 — 範圍外的交易資料讀不到、寫不進(scoped list / append / replace)。
- **寫入 ACL**:`APPEND_ACL` / `REPLACE_ACL` 採**預設拒絕**;`role_permission` 只有 super_admin 能寫(防提權)、append-only 流水表(`stock_ledger` / `sales_line` / `waste` / `stocktake` / `assignment`)非 super_admin 不可整表覆寫(防竄改稽核軌跡)。
- **成本可見性**:`feature.cost` 僅 super / central;門市所有角色(含店長)隱藏成本(目前為 UI 隱藏,詳見權限文件的威脅模型註記)。

完整矩陣與資料層規則見 [`doc/PERMISSION_ROLE_MAP.md`](doc/PERMISSION_ROLE_MAP.md)。

---

## 資料模型(26 表)

單一結構來源:[`js/schema.js`](js/schema.js) 的 `TABLE_COLUMNS`。**任何持久化資料的新功能都必須在這裡登錄它的表與欄位**(見 CLAUDE.md 反漂移規則)。前端 `SCHEMA`(db.js)直接 import;後端 `apps-script.js` 的 `TABLES` 由 `npm run gen:schema` 產生。

**24 張主同步表**(前端 `pullAll` 拉取):

- 主資料:`location`、`location_stock`、`ingredient`、`product`、`supplier`、`bom`、`routing`、`equipment`、`category`、`staff`、`line`、`station`
- 生產 / 採購 / 銷售 / 調撥:`assignment`、`plan_draft`、`production_order`、`po_draft`、`purchase_line`、`sales_line`、`waste`、`stocktake`、`transfer_order`、`transfer_line`、`ingredient_request`
- 核心流水:`stock_ledger`

**2 張帳號 / 權限表**(後端專用,不進主同步):`user_account`、`role_permission`

**多型品項欄位**:`stock_ledger` 與 `transfer_line` 都用 `item_type`(`ingredient` | `product`)+ `item_id` 這組欄位描述「品項」— 自製半成品是 `ingredient` 列(以 `purchase_unit==='自製'` 區分),不需第三種型別。

---

## 設計不變式

1. **`stock_ledger` append-only** — 任何庫存變動(採購 / 退貨 / 調撥 / 投料 / 入庫 / 銷售 / 報廢 / 盤點)都是寫一筆流水;結存永遠是「按 `location_id` 加總」算出來的,**不可直接改**。差異一律走「盤點」。
2. **單據狀態機** — `transfer_order`(叫貨 → 已出貨 → 已收貨 / 取消)、`purchase_line`(已下單 / 廠商已確認 / 配送中 / 補送中 / 暫緩 / 退貨 → 部分到貨 / 已到貨)。
3. **多型品項** — `item_type` + `item_id` 一套心智模型貫穿配方(BOM)、庫存帳(stock_ledger)、調撥(transfer_line)。
4. **多階 BOM** — 產品與自製半成品共用 `bom` 表(以 `product_id` 為鍵);MRP 逐階展開(最多 4 階、防循環);配方編輯器可下鑽進半成品的配方。
5. **Schema 單一來源 + 反漂移** — 結構只改 `js/schema.js`,`npm run gen:schema` 產生後端區塊,`npm run check:schema` 綠燈才代表前後端一致;不得手改 `apps-script.js` 的 gen 區塊。

---

## 近期新增

- **配方多階下鑽** — 配方編輯器裡點自製半成品原料 → 跳進它自己的 BOM,麵包屑可多階 / 退回;半成品標頭顯示「用於 X、Y…」反查;門市唯讀可瀏覽。設計見 [`doc/bom-drilldown-ux.md`](doc/bom-drilldown-ux.md)。
- **調撥結構彈性化** — `transfer_line` 由 `ingredient_id` 泛化為 `item_type` / `item_id`,為未來「配送成品 / 半成品」預留;UI 目前維持原料限定,休眠於旗標 `FLAGS.transferItemTypes`(預設關,`js/app.js`)。設計見 [`doc/flexible-delivery-ux.md`](doc/flexible-delivery-ux.md)。
- **後端寫入 ACL** — 預設拒絕的 `APPEND_ACL` / `REPLACE_ACL`;鎖定 `role_permission` 寫入(防提權)、稽核表不可整表覆寫、`transfer_line` append 綁父單範圍(防跨店注入)。
- **登入落地地點** — 登入時依帳號設定 `state.loc`(中央角色 → 中央倉),登出清除,避免共用瀏覽器帶入前一位使用者的門市。
- **批次同步** — `pullAll` 以單一 `listAll` 往返取代逐表 24 個請求(舊後端 / 失敗自動回退);`stock_ledger` / `sales_line` 這類無界帳本刻意排除於批次(`BATCH_EXCLUDE`)以免撐爆回應。

---

## 架構與檔案

零依賴、零建置:一個 `index.html` + 幾支 ES module。畫面是 `<script type="text/x-template">`,由自製迷你執行時 morph 進 DOM(`sc-if` / `sc-for` / `{{binding}}`)。

```
bakery-erp/
├── index.html        ← 樣式 + 全部畫面模板
├── js/
│   ├── runtime.js    ← 迷你模板執行時(sc-if / sc-for / {{binding}} → DOM morph)
│   ├── app.js        ← 業務邏輯(Component 類:狀態機、MRP、排程、渲染值、FLAGS)
│   ├── schema.js     ← 單一結構來源(TABLE_COLUMNS / DEFAULT_PERMS / AUTH_TABLES …)
│   ├── db.js         ← SCHEMA + 種子 + localStorage / Sheets 資料層 + 同步
│   └── seed-data.js  ← 門市真實資料快照(示範重置用)
├── apps-script.js    ← Google Apps Script 後端(選用;由 schema 產生 TABLES)
├── tools/gen-schema.mjs ← 由 schema.js 產生 apps-script.js 的 gen 區塊
├── doc/              ← 權限矩陣、UX 設計規格
└── semi-import.json  ← 半成品配方匯入資料
```

---

## 資料與連線

- **預設空表**:全新裝置從空資料開始(只保證中央倉地點存在),落在「開始設定」嚮導 — 連上 Sheet 前不載入示範資料。示範資料是 opt-in(頂欄「重置示範資料」或資料連線頁「還原示範資料」)。
- **自動連線**:裝置第一次開啟時,只要有 GAS `/exec` 網址(部署注入或本機設定)就自動以方案 B 連線並以 Sheet 覆蓋本地;完全沒有連線設定才停在本地(localStorage)模式。
- **本地示範模式**:無 `CLIENT_ID` / 連線設定時不需登入,示範資料照玩(開發驗證用)。
- 可選 **Google Sheets 同步**(「資料連線」頁):
  - 方案 A — Sheets API 直連(API key 讀、OAuth 寫)
  - 方案 B — Apps Script 極薄後端(`apps-script.js`)
- 連線預設值:部署時由 GitHub Actions secrets(`GOOGLE_CLIENT_ID` / `GOOGLE_API_KEY` / `BAKERY_SHEET_ID` / `BAKERY_GAS_URL`)注入 `index.html` 佔位符;本機開發放一個 gitignored 的 `google-config.local.js`:

  ```js
  window.BAKERY_CFG = { sheetId: '…', apiKey: '…', clientId: '…', gasUrl: '…/exec' };
  ```

---

## 後端設定與部署

雲端模式(方案 B)強制 **Google 登入 + email 名單**;名單驗證在 Apps Script 後端,沒有有效 token 一律拒絕(登入前零資料流量)。

**一次性設定**:
1. `apps-script.js` 開頭填 `AUTH.CLIENT_ID`(同前端 OAuth Client ID)與 `AUTH.BOOTSTRAP_ADMIN`(第一位管理員 Gmail)。
2. 在 Apps Script 執行 `migrate`(建 `user_account` 分頁、補欄位,保留現有資料)或 `setup`(重建所有分頁 + 示範資料,**會清資料**)。
3. 部署 → 管理部署 → 新版本(`/exec` 網址不變)。
4. 管理員首次登入自動建立 `super_admin`;之後在 `user_account` 分頁加列開通其他人(name / email / role / location_ids / active=TRUE)。

**改結構後**:改 `js/schema.js` → `npm run gen:schema` → `npm run check:schema` 綠燈 → 把 `apps-script.js` **貼回 Apps Script 編輯器並部署新版本**(部署是人工步驟)。`AUTH.CLIENT_ID` 留空 = 不驗證(僅本機測試)。

---

## 本機開發

與整個 repo 相同:根目錄 `npm start`(http-server,port 8000),開 `http://localhost:8000/bakery-erp/`(ES modules 不能用 `file://` 直開)。

```bash
npm start                       # 靜態伺服器(repo 根)
npm run gen:schema              # 由 schema.js 產生 apps-script.js 的 gen 區塊
npm run check:schema            # 驗證前後端 schema 一致(CI 也跑這個)
```

開發流程、分支策略、PR 規範見根目錄 [CONTRIBUTING.md](../CONTRIBUTING.md) 與 [CLAUDE.md](../CLAUDE.md)。
