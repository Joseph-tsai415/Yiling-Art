# 調撥(叫貨/出貨)結構彈性化 — 為未來的半成品/成品配送預留基礎

> 對應 owner 追加需求:中央目前只配送「原料」,但要求把「調撥(叫貨/出貨/收貨)」的**資料結構**設計成
> 未來能配送「自製半成品」或「成品」都不用重寫。**這一版 UI 只需要做原料配送**,結構/地基要先打好。
> 角色:`ux-researcher`(設計 + 資料模型需求陳述)。schema 變更由 `bakery-backend` 執行、走
> `js/schema.js` + `npm run gen:schema` 流程。本文件不改動任何產品程式碼。
> 範圍:`bakery-erp/js/schema.js`(`transfer_line`)、`bakery-erp/js/app.js` `submitTO`/`shipTO`/`recvTO`/
> `partialShipTO`(~837–911)、`bakery-erp/apps-script.js` `filterRows_`/`rowInScope_`(~317–380)、
> `bakery-erp/index.html` 叫貨與採購畫面(~644–800)。

---

## 0. 一句話結論

**這是一個真正需要 schema 變更的案例**——跟 BOM 下鑽不同,`transfer_line` 今天完全沒有「品項可能是成品」這個概念(只有 `ingredient_id`)。核心洞察:**`stock_ledger` 早就用 `item_type`('ingredient'/'product') + `item_id` 這組「多型品項」模式**在跑了(app.js 到處都是 `item_type:'ingredient'`/`item_type:'product'` 的 `stock_ledger` 寫入)。把 `transfer_line` 泛化成同一套 `item_type`/`item_id`,**不是發明新概念,是把調撥表接上這個 app 早就存在、且已經證明夠用的既有模式**——而且「自製半成品」本來就是 `ingredient` 表的一列(`purchase_unit==='自製'`),所以泛化之後只多一種真正新的 `item_type` 值:`'product'`。UI 這一版**維持原料限定、外觀零改變**,只在底層資料流接上 `item_type`/`item_id`,並用一個預設關閉的「模式旗標」把品項類型分頁**藏起來**,之後要開啟半成品/成品配送時不用重接資料流,只需要把分頁打開。

---

## 1. 現況(已驗證)

- `transfer_line` schema(`js/schema.js:33`):`['tl_id', 'to_id', 'ingredient_id', 'qty']`——只認 `ingredient_id`。
- `stock_ledger`(`js/schema.js:35`)已經是多型:`['ledger_id', 'item_type', 'item_id', ...]`,`item_type` 目前用 `'ingredient'` / `'product'` 兩個值,遍布 app.js(生產入庫、銷售出庫、報廢、盤點……)。
- `submitTO`/`shipTO`/`recvTO`/`partialShipTO`(app.js:837-911)目前**寫死** `item_type: 'ingredient'`(見 862、872、897 行)寫入 `stock_ledger`,且全程只操作 `l.ingredient_id`。
- 叫貨畫面的加料選取器(index.html:684 `tsIngBtn`)資料源是 `this.t('ingredient')`,跟 BOM 編輯器的加料選取器(`bomIngBtn`)是同一種 dropdown 元件(`ddBtn`),但沒有「原料 vs 半成品 vs 成品」的分類篩選——反觀 BOM 編輯器的供應商篩選(`bomSupBtn`,app.js:3169)**已經**有一個 `{id:'__self', name:'自製半成品'}` 的特例選項,把「自製半成品」從一般原料裡篩出來。這正是本設計要在調撥畫面複用的既有慣例。
- 後端 scope 判斷(`apps-script.js` `filterRows_`/`rowInScope_`,~334-380):`transfer_line` 的可見性完全跟著父單 `transfer_order.to_id` 走(門市在 `to_loc`/`from_loc` 範圍內就看得到整張單所有明細),**跟 `ingredient_id` 這個欄位本身無關**——這代表把 `ingredient_id` 換成 `item_type`+`item_id` **不需要改動 scope 邏輯**,风险比想像中小,只是欄位改名/新增。
- `isPackaged`/`pkgCeil`/`pkgTxt`(app.js:820-823)假設拿到的 `g` 是 `ingredient` 列(讀 `g.purchase_unit`、`g.conversion_rate`)——如果 `item_type==='product'`,不能直接把 `product_id` 丟給 `ing()` 查(會拿到 `undefined`),這幾個函式需要先依 `item_type` 分流。

---

## 2. 資料結構需求(給 `bakery-backend` / `flow-expert` 定案)

### 2.1 目標形狀

```
transfer_line: ['tl_id', 'to_id', 'item_type', 'item_id', 'qty']
```

- `item_type` 列舉值:`'ingredient'` | `'product'`(**只有兩種,不是三種**——自製半成品不需要第三個值,它本來就是 `ingredient` 表的一列,靠 `purchase_unit==='自製'` 這個既有慣例區分「原料」還是「半成品」,跟 BOM 下鑽文件〔`doc/bom-drilldown-ux.md` §9〕的結論完全一致)。
- `item_id`:依 `item_type` 對應 `ingredient_id` 或 `product_id`。
- 這組欄位命名與語意**刻意對齊** `stock_ledger` 現有的 `item_type`/`item_id`,讓「品項」在 BOM(配方)、`stock_ledger`(庫存帳)、`transfer_line`(調撥)三處用同一套心智模型——這是本追加需求裡「polymorphic item」概念可以跟 BOM 下鑽相互呼應的地方:兩份文件其實在講同一個底層概念在不同畫面的呈現。

### 2.2 這一定要走 `js/schema.js` + `gen:schema`(依 CLAUDE.md 反漂移規則)

`TABLE_COLUMNS.transfer_line` 改了之後:
1. 前端 `db.js` 的 `SCHEMA` 自動跟著變(直接 import)。
2. 執行 `npm run gen:schema`,重新產生 `apps-script.js` 裡 `<<gen:tables>>` 區塊,貼回 Apps Script 部署。
3. `npm run check:schema` 必須綠燈,否則代表後端貼上的版本跟前端定義的形狀不一致。

**不要**在 `apps-script.js` 手改 `TABLES.transfer_line` 這一行了事——那正是 CLAUDE.md 明文警告過的「前後端各改一份、漂移」根因模式。

### 2.3 遷移風險(這是真正需要 `bakery-backend` 拍板的地方,我不越權替他們決定)

跟 BOM 下鑽那份文件不同,這裡**不是純新增欄位**——是把既有欄位 `ingredient_id` 改名/泛化成 `item_id` + 補一個新欄位 `item_type`。既有 Google Sheet 上已經有 `transfer_line` 資料列(demo 或正式站),这些舊列只有 `ingredient_id`、沒有 `item_type`。兩個可行方向,列出來讓 `bakery-backend` 選:

- **(A)乾淨改名**:直接把欄位改成 `item_type`/`item_id`,對現有舊列做一次性遷移(補 `item_type='ingredient'`,把 `ingredient_id` 的值搬進 `item_id`)。優點:之後程式碼只有一套欄位名,不用到處相容判斷。缺點:對正式站有資料的情況需要一次性遷移腳本,`migrate`/`setup` action 目前只管「建立缺的分頁」,不管「改既有分頁的欄位」,可能要額外寫遷移邏輯。
- **(B)新增相容欄位**:保留 `ingredient_id` 不動,另外新增 `item_type`(可空,空值當 `'ingredient'` 向後相容)+ `item_id`(新資料才填),讀取端「`item_id` 有值就用它,否則退回 `ingredient_id`」。優點:零遷移風險,舊資料不用動。缺點:兩個欄位長期並存,程式碼要多一層相容判斷,是另一種形式的「兩套真相」。

**本文件的建議(非定案)**:目前看起來 demo 資料量小、還沒有大量正式站歷史調撥資料的跡象,傾向 (A) 乾淨改名——一次做對,不留相容債。但這屬於 `bakery-backend` 對正式資料風險的判斷範圍,請他們依實際部署狀況拍板。

### 2.4 連動程式碼(泛化後必須跟著改,否則會悄悄壞掉)

- `shipTO`/`recvTO`/`partialShipTO`(app.js:862、872、897)目前 **寫死** `item_type: 'ingredient'` 寫入 `stock_ledger`——泛化後必須改成**讀該筆 `transfer_line` 自己的 `item_type`**,否則未來一筆 `item_type==='product'` 的調撥出貨,會被誤標成 `'ingredient'` 寫進庫存帳,污染成品庫存的 stock_ledger。
- `isPackaged`/`pkgCeil`/`pkgTxt`:要先判斷 `item_type`,`'product'` 一律視為「整件計數、無包裝換算」(不呼叫 `g.purchase_unit`/`g.conversion_rate`),`'ingredient'` 才維持現有邏輯不變。
- 品項名稱顯示:目前多處用 `(this.ing(l.ingredient_id)||{}).name`;泛化後建議統一用 `this.nameOf(item_id)`(已經是 prod 優先、找不到再找 ingredient 的 fallback,app.js:268),兩種 `item_type` 都能正確顯示,不用額外 if/else。

---

## 3. UI 設計:「休眠模式」的品項類型篩選

### 3.1 原則

**這一版 UI 對「原料限定」的使用者完全零視覺變化**——這是 owner 明確要求的「дормant until enabled」。做法是一個布林旗標(暫定 `FLAGS.transferItemTypes`,預設 `false`,可先放前端常數,不需要現在就做成每店可調的設定項),控制一組品項類型分頁**要不要出現**;旗標關閉時,程式碼路徑跟今天完全一樣(挑選器只讀 `ingredient` 清單、`item_type` 隱含視為 `'ingredient'`)。

### 3.2 旗標關閉(今天,預設狀態)——零變化

```
┌ 叫貨單(草稿)— 向 中央倉 ──────────────────────────┐
│ 原料              數量        單位          │
│ 高筋麵粉          5000        g       ✕     │
│ 老麵(自製)        2000        g       ✕     │
├──────────────────────────────────────────────┤
│ [高筋麵粉 ▾]        [1000]    g/ml   [+ 加入]│  ← 跟現在完全一樣,tsIngBtn 挑選器不變
└──────────────────────────────────────────────┘
```

### 3.3 旗標開啟(未來,中央具備自產能力時)——新增分頁,複用 BOM 加料選取器已有的慣例

```
┌ 叫貨單(草稿)— 向 中央倉 ──────────────────────────┐
│ [原料] [半成品] [成品]              ← 新增 .seg 分頁,樣式比照畫面頂端既有的
│                                       ①門市叫貨/②中央倉出貨/③中央採購 分頁
│ 原料              數量        單位          │
│ 高筋麵粉          5000        g       ✕     │
├──────────────────────────────────────────────┤
│ (分頁="半成品" 時,挑選器只列 purchase_unit='自製' 的品項──
│  跟 bomSupBtn 的 {id:'__self', name:'自製半成品'} 用同一個篩選慣例,兩處定義一致、不會各自漂移)
│ (分頁="成品" 時,挑選器改列 this.t('product'),qty 改「件」計數、
│  不跑 isPackaged/pkgCeil 那套包裝進位邏輯)
│ [高筋麵粉 ▾]        [1000]    g/ml   [+ 加入]│
└──────────────────────────────────────────────┘
```

- 分頁樣式直接沿用 `.seg`(index.html:647 同畫面頂端「①門市叫貨/②中央倉出貨/③中央採購」已經是這個元件),不用新設計一套視覺。
- 切換分頁只換「加料挑選器的資料源 + qty 欄位語意」,不影響「叫貨單(草稿)」表格本身的欄位結構——因為 `transfer_line` 泛化後每一行本來就自帶 `item_type`,表格渲染時直接照該行的 `item_type` 決定要不要顯示包裝換算文字即可,不需要為「成品」開一張全新的表格。
- 出貨(②中央倉出貨)、收貨清單的顯示同理:沿用同一份 `t.lines` 渲染,只是 `l.name` 改用 `nameOf(l.item_id)`,`l.sub` 的供應商/分類文字對 `item_type==='product'` 的行直接留空或顯示「成品」即可(細節留給 `bakery-frontend` 依現有 `ingSub()` 寫法類推,不在此展開一套新 wireframe——這一段本來就是「旗標開啟後才會發生」的未來情境,POC 現在不需要把它做完整,只需要資料流不要卡死)。

### 3.4 為什麼不現在就把「半成品」分頁打開

半成品理論上**今天就能**走 `transfer_line`(它就是一個 `ingredient_id`,現有欄位裝得下)——但 owner 的需求是「原料限定」的這一版先求乾淨,不要在使用者只需要原料配送的當下就多塞一排分頁增加認知負擔。所以即使半成品分頁在資料面「免費」,也建議跟成品分頁一起放在同一個旗標後面、一起打開,維持一次性的「模式切換」而不是「原料 vs 半成品現在有、成品以後才有」這種不一致的半吊子狀態。

---

## 4. 與 BOM 下鑽文件的呼應

`doc/bom-drilldown-ux.md` 的結論是「半成品可點擊」靠的是 `purchase_unit==='自製'` 這條既有慣例；這裡的結論是「調撥要能配送半成品/成品」靠的是把 `transfer_line` 接上 `stock_ledger` 已經在用的 `item_type`/`item_id` 多型模式。兩者其實是同一個「品項可能是原料/半成品/成品」的概念,只是分別出現在「配方要吃什麼」跟「調撥要送什麼」兩個畫面。**不建議現在就抽一個共用 helper 把兩邊統一**(BOM 那邊靠 `ing()`/`isIngId()`/`purchase_unit` 解析,調撥這邊靠 `item_type` 判斷,兩套解析邏輯目前服務的場景不完全一樣)——這是可以留給未來一次重構的觀察,不是本次 POC 的必要工作,先如實記錄下來,供之後真的要做半成品/成品配送時參考。

---

## 5. 給 `qa-pm` 的驗收要點

- [ ] `npm run check:schema` 在 `transfer_line` schema 變更後維持綠燈。
- [ ] 旗標關閉(今天的預設狀態)下,叫貨/出貨/收貨全流程(`submitTO`→`shipTO`/`partialShipTO`→`recvTO`)行為與畫面**跟變更前逐位元一致**——這是純粹的資料結構泛化,不應該有任何原料配送的使用者可見變化(回歸測試,不是新功能測試)。
- [ ] `shipTO`/`recvTO`/`partialShipTO` 寫入 `stock_ledger` 的 `item_type` 改為讀取該筆 `transfer_line.item_type`,而不是寫死 `'ingredient'`——用現有的原料調撥流程驗證這個改動本身沒有把 `item_type` 寫錯(應該仍然是 `'ingredient'`)。
- [ ] 若遷移採方向 (A)(欄位改名):既有 demo/正式資料裡的舊 `transfer_line` 列,遷移後 `item_type` 正確補上 `'ingredient'`、`item_id` 正確帶到原本 `ingredient_id` 的值,沒有調撥單「憑空消失」明細。
- [ ] 若旗標開啟(未來階段驗收):「半成品」分頁挑選器列出的品項清單,跟 BOM 編輯器加料區的「自製半成品」篩選(`bomSupBtn` 的 `__self`)是同一份清單、沒有兩邊各自維護導致的落差。
- [ ] 若旗標開啟:「成品」分頁的品項在叫貨/出貨/收貨全程都不會誤觸包裝換算邏輯(`isPackaged`/`pkgCeil`/`pkgTxt`),qty 以整數件數處理。
