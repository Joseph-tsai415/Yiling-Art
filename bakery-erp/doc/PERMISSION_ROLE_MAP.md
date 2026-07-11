# Bakery ERP — 權限角色地圖(Permission Role Map)

> 對應 GitHub issue [#70](https://github.com/Joseph-tsai415/Yiling-Art/issues/70)(Phase 2)。
> 權限資料存在 Google Sheet 兩個分頁:`user_account`(帳號名單)與 `role_permission`(角色×權限矩陣);
> super_admin 可在 App 內「帳號與角色」畫面即時調整,**不需重新部署**。
> 名單與權限的強制執行在 Apps Script 後端 — 前端只是 UX,沒有有效 token/權限,後端一律拒絕。

## 角色總覽

| 角色 role | 中文 | 地點範圍 location_ids | 定位 |
|---|---|---|---|
| `super_admin` | 系統管理員 | `ALL` | 全部畫面 + 帳號與角色管理 + 資料連線/清空;權限檢查一律放行 |
| `central_ops` | 中央倉 | `ALL`(可切換查看所有門市) | 中央營運:出貨/採購/原料目錄/產品配方維護 |
| `store_admin` | 店長 | 本店(如 `LOC-A`;多店 `LOC-A\|LOC-B`) | 門市全流程管理(不含成本) |
| `store_kitchen` | 內場(後廚) | 本店 | 生產操作 + 查配方(唯讀) |
| `store_front` | 外場(前台) | 本店 | 前台銷售 |

## 畫面權限矩陣(role_permission 預設值)

perm_key 格式:`screen.<畫面id>`;`allow=TRUE` 才可見。super_admin 不需列(恆為全部)。

| 畫面 | perm_key | super_admin | central_ops | store_admin | store_kitchen | store_front |
|---|---|:-:|:-:|:-:|:-:|:-:|
| 開始設定 | `screen.setup` | ✓ | ✓ | — | — | — |
| 營運總覽 | `screen.overview` | ✓ | — | ✓ | — | — |
| 每日排程 | `screen.schedule` | ✓ | — | ✓ | — | — |
| 生產管理 | `screen.production` | ✓ | — | ✓ | ✓ | — |
| 前台銷售 | `screen.sales` | ✓ | — | ✓ | — | ✓ |
| 庫存 | `screen.inventory` | ✓ | ✓(中央倉) | ✓(本店) | — | — |
| 叫貨與採購 | `screen.purchase` | ✓ | ✓(出貨+採購) | ✓(叫貨) | — | — |
| 原料(目錄/本店備料) | `screen.ingredients` | ✓ | ✓(目錄+歸戶) | ✓(本店備料) | — | — |
| 門市地點 | `screen.locations` | ✓ | ✓ | — | — | — |
| 產品與配方 | `screen.products` | ✓ | ✓ 可編輯 | ✓ 唯讀 | ✓ 唯讀 | — |
| 供應商・設備 | `screen.suppliers` | ✓ | ✓ | — | — | — |
| 人員 | `screen.staff` | ✓ | — | ✓(本店) | — | — |
| 報表 | `screen.reports` | ✓ | — | ✓(無成本) | — | — |
| 日結 | `screen.closing` | ✓ | — | ✓(無成本) | — | — |
| 資料連線 | `screen.connect` | ✓ | — | — | — | — |
| 帳號與角色 | `screen.accounts` | ✓ | — | — | — | — |

## 功能權限(畫面內差異)

| 功能 | perm_key | 誰有 | 效果 |
|---|---|---|---|
| 成本可見 | `feature.cost` | super_admin、central_ops | **門市所有角色(含店長)隱藏成本**:產品與配方的 單價/成本欄 與 批成本/單位成本/毛利/毛利率;報表的 原料成本/毛利/毛利率 與損耗金額;日結的 銷貨成本/毛利/日淨毛利/報廢金額。售價(零售價)不受影響。庫存/生產/叫貨畫面本來就不顯示成本。 |

## 地點範圍(資料層,後端強制)

- 頂欄地點切換器只顯示帳號 `location_ids` 內的地點;門市角色看不到中央倉與其他門市的分頁。
- **讀取(list)**:範圍外的列直接不回傳 —
  - 帶 `location_id` 的交易表(sales_line / stock_ledger / production_order / waste / stocktake / plan_draft / purchase_line / po_draft / ingredient_request)→ 過濾到範圍內
  - `product` → 共用(空值/`ALL`)或歸屬本店的才回傳
  - `transfer_order` → `to_loc` 或 `from_loc` 在範圍內;`transfer_line` → 跟隨可見的 transfer_order
  - 主資料(ingredient / supplier / category / bom / routing / equipment / location / location_stock / staff / line / station)→ 不過濾(共用)
  - `user_account` / `role_permission` → 僅 super_admin 可讀
- **寫入(append)**:新列的 `location_id`(transfer_order 為 `to_loc`)必須在範圍內,否則 `forbidden_location`。
- **整表覆寫(replace)= scoped replace**:後端保留範圍外的既有列、驗證送入列都在範圍內 —
  防止「過濾後的資料 + 整表覆寫」誤刪其他店的資料。
- **整表覆寫 ACL**(無地點欄的主資料表):
  - 僅 super_admin:`user_account`、`role_permission`
  - super_admin + central_ops:`product`、`bom`、`routing`、`supplier`、`equipment`、`location`、`transfer_line`
  - 其他表:所有已登入角色(受 scoped replace 保護)

## 帳號與工作階段

- `user_account` 欄位:`user_id, name, email, role, location_ids, active, created_at, last_login`
- 登入:Google Sign-In → 後端驗證 ID token(`AUTH.CLIENT_ID`)→ email 在名單且 `active=TRUE` → 核發 6 小時工作階段 token
- token 存 **sessionStorage**:同分頁重新整理免重登(仍會重新驗證),關閉分頁需重新登入
- **每個請求都重新讀取帳號**:停用帳號 / 改角色 / 改地點範圍即時生效,不用等 token 過期
- 第一個管理員:`AUTH.BOOTSTRAP_ADMIN` 的 Google 帳號首次登入自動建立 `super_admin`
- 本地示範模式(無雲端連線設定)不需登入,全部畫面可用(示範資料)

## 如何調整

1. **開帳號**:帳號與角色 畫面(super_admin)→ + 新增帳號,填 name / email / role / 門市;或直接在 Sheet `user_account` 加列
2. **調權限**:帳號與角色 畫面的角色×畫面矩陣點格子切換;或直接改 Sheet `role_permission`
3. 變更即時生效(資料層當下、畫面層下次重新整理/登入)

## Phase 狀態

- ✅ Phase 1(#69,已上線):Google 登入 + email 名單、封鎖畫面、6h 工作階段、登出
- 🚧 Phase 2(#70,本文件):角色×畫面矩陣、地點範圍資料過濾、成本隱藏、帳號與角色管理畫面
- 📋 Phase 3(#71):人員(staff)綁定門市、共用平板 PIN 換人、audit log、登出清本地快取
