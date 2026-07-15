# BOM 多階配方下鑽(Drill-Down)UX 規格

> 對應需求:「配方 BOM 裡的自製半成品原料應可點擊,跳進去看/改該半成品自己的配方,可以多階、可以退回。」
> 角色:`ux-researcher`(設計)。實作交給 `bakery-frontend`(dev-lead)+ `bakery-backend`(如需要)。本文件不改動任何產品程式碼。
> 範圍:`bakery-erp/index.html` 產品與配方畫面(~1077–1150)+ `bakery-erp/js/app.js` 編輯器渲染(~2300–2360、~3090–3200)。

---

## 0. 一句話結論

**採用「取代編輯主體(drill-down)+ 麵包屑(breadcrumb)」作為主要導覽模型。** 這幾乎是零成本擴充現有機制:編輯器主體 `S.selProd` 本來就能是 product 或 ingredient(`isIngSel` 旗標已存在),點一下自製半成品的 BOM 行只是把 `S.selProd` 換成該半成品的 `ingredient_id`——跟左側清單 `onSel` 選產品是同一個動作,只是觸發點換成表格內的一行。真正要新增的只有:一條麵包屑狀態(`S.bomTrail`,存 id 陣列)+ 該行的可點擊視覺 + 唯讀角色下「可瀏覽、不可編輯」的點擊穿透修正。

跑者上:**行內展開/收合樹狀(inline expand/collapse)**——體驗上更「一次看到全貌」,但現有 `sc-for` 樣板引擎只驗證過一層巢狀(如 `row.cells`),沒有遞迴元件的先例;要做任意深度的樹狀需要在 JS 端自行拉平(flatten)成帶縮排層級的清單並管理逐節點展開狀態,且每一階都要各自的批成本/毛利 footer——對 POC 而言複雜度與風險明顯更高。點狀 peek 面板(仿現有「批次追溯」`traceStyle` 面板,index.html:507)可作為未來「不換頁看一眼成本」的加值功能,但不適合當多階導覽的主機制(peek 疊 peek 很怪,且看完通常還要能編輯,等於要在面板裡再做一份配方編輯器)。

---

## 1. 導覽模型:抽換主體 + 麵包屑

### 1.1 狀態

新增一個畫面層級的暫存狀態(不落地、不進 schema):

```
S.bomTrail = []            // 祖先鏈,只存 id(product_id 或 ingredient_id),不存 name(name 永遠即時查,不怕改名後麵包屑顯示舊字)
```

- **鑽入**(點某自製半成品的 BOM 行):`bomTrail = bomTrail.concat([S.selProd])`,`selProd = 該行.ingredient_id`。
- **點麵包屑中段某節點**:`selProd = 該節點 id`,`bomTrail = bomTrail.slice(0, 該節點在陣列中的 index)`(該節點之後的路徑全部丟棄——不是「退一步」,是「直接跳過去」)。
- **點麵包屑最前面(根節點)**:等同上面,index=0,`bomTrail=[]`。
- **「‹ 返回」按鈕**(只退一階):`selProd = bomTrail[bomTrail.length-1]`,`bomTrail = bomTrail.slice(0,-1)`。
- **從左側清單直接點別的產品/半成品**:`bomTrail = []`(全新情境,舊路徑作廢——不合併、不保留)。
- **地點分頁切換(`prodLoc` tab)或既有的「選取不在範圍內 → 退回第一個」fallback(app.js:2323-2326)**:一併清空 `bomTrail`。
- **離開「產品與配方」畫面再回來**:`bomTrail` 重置為 `[]`(視為全新 mount;不做跨畫面持久化)。
- 任何導覽動作(鑽入/鑽出/點麵包屑/返回)都**重置加料選取器的暫存篩選**:`bomSupFilter`、`bomCatFilter`、`bomAddIng`、`bomAddQty` 回預設值——這些是「正在幫這個配方挑原料」的暫存 UI 狀態,換了配方主體之後沿用舊篩選只會誤導(例如上一個配方選了「廠商 A」篩選,鑽進另一個半成品時篩選還卡著 A,以為沒有可加的原料)。

### 1.2 為什麼不怕「不小心弄丟使用者的位置」

這個編輯器**沒有草稿/未存檔狀態**——BOM 行的用量、名稱、售價等每個欄位的 `onChange` 都是直接 `db.replace(...)` 立即寫入(見 app.js:2335、3195 等),不像「原料主檔」有 `S.draft` 暫存。所以在任何深度導覽離開,都不會遺失未儲存的編輯;不需要「你有未儲存的變更,確定離開？」這類攔截。

### 1.3 深度與防循環——導覽 ≠ MRP 展開,兩者要分開看

- MRP 展開(`mrpNeed()`, app.js:1012-1030)為了算原物料淨需求,**限制最多 4 階、用 `done{}` 防循環**——這是「數量計算」的工程限制,不代表 UI 導覽也要卡在 4 階。導覽本身**不設硬性深度上限**:配方鏈有多深,使用者就能點多深(每一步都是使用者主動點擊,不是程式自動遞迴,沒有真正的無限迴圈風險)。
- 但要對「循環配方」(A 的配方用到 A 自己,或 A→B→A)做**視覺提醒**,見第 6.2 節。

---

## 2. 視覺區分:BOM 行怎麼讀出「這是半成品、可以點進去」

BOM 表格(index.html:1102-1112,`bomRows`)目前每行只有 原料名 / 供應商 / 分類 / 用量 / 單價 / 成本 / 移除(✕)。新增判斷:對每一行 `b`,取 `g = ing(b.ingredient_id)`,`isSemi = g.purchase_unit === '自製'`。

| 狀態 | 名稱欄呈現 | 游標 / 互動 |
|---|---|---|
| **一般外購原料**(`isSemi=false`) | 純文字名稱,不變 | 預設游標,不可點,無新增視覺 |
| **自製半成品、已有配方**(`isSemi=true` 且 `bomOf(g.ingredient_id).length>0`) | `名稱  [自製半成品 tag]  ›`(tag 沿用既有 `pIngTagStyle`/生產單列表同款 `this.tag(C.amb)` 琥珀色 tag3;`›` 為 `msi` icon `chevron_right`,小號、灰色,純視覺提示可再往下) | `cursor:pointer`;hover 背景用既有下拉列的 hover 色 `#eef6f8`;**整個名稱欄(td)都是點擊熱區**,不是只有 tag 本身——觸控裝置(門市平板)命中率優先 |
| **自製半成品、尚未建配方**(`isSemi=true` 且 `bomOf(...).length===0`) | `名稱  [自製半成品 tag]  · 尚無配方  ›`(灰色小字後綴,提醒這個依賴還是空的) | 同樣可點——點進去就是第 6.1 節的空狀態,central 角色可直接開始建配方 |
| **循環配方**(`isSemi=true` 且該 `ingredient_id` 已出現在目前路徑,見 6.2) | 在自製半成品 tag 旁再加一個 `[⚠ 循環]` 紅色 tag3(`this.tag(C.red)`) | 仍可點(讓 central 角色點進去修正錯誔配方),但點擊時額外跳一個 `this.notify(...)` 提示(見 6.2) |

移除(✕)欄位完全不變——放在原本最後一欄,跟新的「點名稱鑽入」互不干擾(不同欄位、不同點擊區)。

供應商欄目前對自製半成品顯示文字「自製」(app.js:2333);現在名稱欄已有更明確的琥珀色 tag,建議供應商欄對自製半成品改顯示「—」以免語意重複——**這是小整理,非必要**,不做也不影響本功能。

---

## 3. 半成品標頭(Header)——鑽進去之後要看到什麼

好消息:編輯器 header(index.html:1092-1100)大部分已經是「依 `isIngSel` 切換」——`pIngTagStyle`(琥珀 tag)、`pIngYieldStyle`(批次產出輸入)已存在,`pHeadStyle`(售價/製作時程/標準產出)、`pLocStyle`(門市 chip)在 `isIngSel=true` 時已經 `display:none`。**這部分不用改。**

本功能唯一需要新增的是 header **上方**的麵包屑列(見第 5 節),以及一個建議加項:

**建議新增(should-have,非必要):「用於」反查。** 因為 `bom` 表對半成品是**共用主檔**(不像 product 可綁門市),編輯一個半成品的配方會影響**所有引用它的上層產品/半成品**——這個影響面對 central 編輯者應該可見。做法:在半成品 header 附近加一行小字,反查 `this.t('bom').filter(x => x.ingredient_id === S.selProd)` 對應到的上層 `product_id`/`ingredient_id` 名稱,顯示「用於:蔥花麵包、菠蘿包 +1 項」。純文字、不用可點(避免範圍擴大成另一套導覽),central-only 顯示即可(store 角色本來就唯讀瀏覽,看不看到都不影響操作)。

---

## 4. 成本透明度

### 4.1 現有機制(不用改,直接沿用)

- 每一階(不論 product 或半成品)底部 footer(index.html:1125-1131)已經是「批成本 / 單位成本(或每 g 成本)/ 毛利 / 毛利率」——這段邏輯已經是吃 `S.selProd` 泛用計算(`bCost`/`uCost`,app.js:2343-2344),鑽到哪一階就顯示那一階自己的批成本/單位成本,**不用新增程式碼**,只要鑽入後這塊 footer 自然重新渲染即可。
- 父層 BOM 行裡半成品那一行的「單價/成本」欄,吃的是該半成品的 `latest_unit_cost`(app.js:2336-2337)——這是「已入帳」的成本,由每次半成品**生產完成入庫時**自動用 `批成本 ÷ 批次產出` 回寫(costNote 文案已經講清楚,app.js:3147)。這條路徑本來就有,不用改。

### 4.2 一個真實的認知落差,建議在 UI 上補一句提示(should-have)

**重要細節**:`latest_unit_cost` 只在半成品**完成一次生產入庫**時才更新——不是「編輯配方當下」就更新。也就是說:如果 central 使用者鑽進「老麵」改了配方(例如麵粉用量),回到上層「蔥花麵包」時,那一行老麵的「單價/成本」欄**不會立刻變**,要等下一次老麵完成一批生產入庫才會反映新配方的成本。這在沒有提示的情況下,對編輯者來說很容易誤以為「改了配方但成本沒變、是不是沒存到」。

建議(should-have,可列為第二輪):當某半成品 BOM 行的「依目前配方試算的單位成本」(用跟 footer 一樣的 `bomOf()+latest_unit_cost` 公式現算)與帳面 `latest_unit_cost` 不同時,在該行成本欄旁加一個小 `msi` icon(如 `info`)+ tooltip:「帳面單價 NT$0.85/g;依目前配方試算 NT$0.92/g(下次生產完成入庫後更新)」。這是唯一真正解釋「半成品成本怎麼餵給上層」的訊息,建議優先做,但不是本功能能不能上線的必要條件。

> 實作提醒(給 `bakery-frontend`,非 schema 議題):現有 `unitCost(pid)` 這個 helper(app.js:301-305)**只支援 product**——開頭就是 `if (!this.prod(pid)) return 0`,對半成品 id 一律回 0。要算半成品自己的「依配方試算單位成本」,要沿用編輯器渲染裡已經在用的泛用寫法(`this.bomOf(id).reduce(...) / yield`,app.js:2343-2344 那段,對 product/ingredient 都通),不要誤用 `unitCost()`。

---

## 5. 唯讀故事(店端瀏覽 vs 中央編輯)

依 `doc/PERMISSION_ROLE_MAP.md`:「產品與配方」畫面 central_ops 可編輯、store_admin/store_kitchen 唯讀、store_front 完全看不到這個畫面(無 `screen.products`)。既有 `atCentral` 判斷驅動:

- `prodEditPE = atCentral ? '' : 'pointer-events:none'`——包住整個「唯讀 banner + BOM 面板 + 工序面板」的最外層 flex 容器(index.html:1089)。
- `prodRoStyle`/`prodRoTxt` 已經有現成的唯讀提示 banner,文案已依「有沒有中央倉權限」分流,**不用改**。

**這裡有一個會直接讓功能失效的實作陷阱,務必寫清楚給 `bakery-frontend`**:目前 `pointer-events:none` 是整塊蓋下去的——如果直接把「點名稱鑽入」的 `onClick` 加在既有 BOM 行的 `<td>` 上,店端角色(store_admin/store_kitchen)點下去會被 `pointer-events:none` **整個吃掉**,鑽不進去,違反「可瀏覽、不可編輯」的需求(瀏覽也要能用)。

**修正方式**:鑽入用的名稱 `<td>`(或其內層 wrapper)要**明確加 `pointer-events:auto` 覆寫**父層的 `none`(標準 CSS 技巧:父層 none、子層再開回 auto),使其在唯讀模式下依然可點;同一行裡的用量 `<input>`、移除 ✕、加料區、售價/批次產出等其餘欄位仍維持被 `pointer-events:none` 蓋住(不變)。麵包屑列本身則直接放在 `prodEditPE` 容器**之外**(見第 5.1 節),整條在任何角色下都可互動,不需要特別覆寫。

同理,麵包屑的「‹ 返回」按鈕、可點的祖先節點,一律不受 `atCentral` 影響——導覽本來就該對唯讀角色開放。

### 5.1 麵包屑放哪裡(避免 pointer-events 糾纏)

麵包屑列建議放在最外層 `<div style="...{{prodEditPE}}">` **之前**、作為右欄新的最上方元素(見第 7 節 wireframe),而不是塞進 `pah` 面板標題列內部——這樣它天生不受 `prodEditPE` 影響,不用逐一覆寫。

### 5.2 成本可見性(既有邏輯,鑽到任何深度都要繼續成立)

`feature.cost` 只有 `super_admin`/`central_ops` 有;store_admin/store_kitchen 沒有(見 `DEFAULT_PERMS`)。既有 `costColStyle`/`mgHideStyle`/`canCost()` 判斷跟 `S.selProd` 是不是半成品**無關**,是純角色判斷——鑽到第幾層都一樣隱藏。**這不用改,但要當成回歸測試項目**(見第 8 節 QA 備忘):店端角色鑽進任意深度的半成品,單價/成本/批成本/單位成本/毛利率欄位都必須繼續隱藏。

---

## 6. 空狀態 / 邊界情況

### 6.1 自製半成品尚未建配方

`bomOf(半成品id).length === 0` 時,BOM 表格目前只會渲染表頭、tbody 空白——沒有任何「這是正常的、不是沒載入」的提示。新增一個空狀態列(比照既有 `closeEmpty`/`tsSugEmpty`/`tcPendEmpty` 的作法:表格後面加一個 `<div style="{{bomEmptyStyle}}">`,有資料時 `display:none`):

- **central(可編輯)看到**:「尚無配方 — 從下方「加入」原料開始建立」
- **store(唯讀瀏覽)看到**:「尚無配方(尚未建立)」

這個空狀態在「直接從左側清單選到這個半成品」與「透過鑽入路徑進來」兩種進入方式下都要出現(同一份渲染邏輯,自然成立,不用特別分案例)。

### 6.2 自我參照 / 循環配方

半成品 A 的配方原料裡有 A 自己,或 A→B→A。判斷方式:`isSemi && (b.ingredient_id === S.selProd || S.bomTrail.indexOf(b.ingredient_id) >= 0)`。

- 視覺:第 2 節表格的「⚠ 循環」紅色 tag。
- 互動:**不封鎖點擊**(循環配方本身是資料錯誤,central 角色要能點進去刪掉那行修正它;硬性擋住點擊反而讓人修不了)。點擊時額外用既有 `this.notify(...)` 跳一則提示:「⚠ 此配方在目前路徑中已出現過 — 可能是循環配方,請確認」。
- 不需要新的後端驗證或寫入攔截——MRP 展開本來就有 4 階 + `done{}` 防循環,不會因為 UI 允許鑽入循環配方而造成計算面出問題;這裡純粹是「顯示與提醒」層級的處理。

### 6.3 深鏈(4 階以上)

導覽不設上限(見 1.3),但麵包屑要處理「太長擠不下」的呈現問題——見第 7.3 節。

---

## 7. 互動細節與元件規格(給 `bakery-frontend`)

### 7.1 BOM 行(`bomRows` 新增欄位)

在既有 `bomRows` 的 `.map()`(app.js:2329-2340)裡,每個元素新增:

```
isSemi:      g.purchase_unit === '自製'
hasOwnBom:   isSemi && this.bomOf(b.ingredient_id).length > 0
isCycle:     isSemi && (b.ingredient_id === S.selProd || (S.bomTrail||[]).indexOf(b.ingredient_id) >= 0)
nameCellStyle: isSemi ? 'cursor:pointer;pointer-events:auto' : ''   // 見第 5 節,務必覆寫 pointer-events
onDrill:     isSemi ? () => this.setState({
               selProd: b.ingredient_id,
               bomTrail: (S.bomTrail || []).concat([S.selProd]),
               bomSupFilter: '', bomCatFilter: '', bomAddIng: '', bomAddQty: ''
             }) : null
```

`hasOwnBom=false` 時仍然 `isSemi=true`、仍然可點(見 6.1),只是名稱旁多顯示「· 尚無配方」灰字。

### 7.2 麵包屑列(新元件)

放在右欄最外層容器**之前**(第 5.1 節),只在 `S.bomTrail.length > 0` 時渲染(頂層直接選取、沒有鑽入路徑時完全不顯示這條列,維持畫面單純)。

```
┌──────────────────────────────────────────────────────────┐
│ ‹  蔥花麵包  ›  老麵  ›  液種                              │  ← 液種為目前主體,不可點、無底線、深色粗體
└──────────────────────────────────────────────────────────┘
```

- `‹` 返回圖示(msi `arrow_back` 或純文字):只在 `bomTrail.length>0` 顯示,點擊 = 退一階(見 1.1)。
- 祖先節點(蔥花麵包、老麵):`color:#0e7490`(既有 accent 色)、`cursor:pointer`、hover 加底線,onClick = 跳到該節點並截斷路徑。
- 目前節點(液種):`color:#1b2330;font-weight:600`,不可點、無 hover。
- 分隔符 `›`:`color:#9aa1ab`,純裝飾。
- 產生方式:`crumbs = S.bomTrail.map((id,i) => ({ id, name: this.nameOf(id), onPick: () => this.setState({selProd:id, bomTrail:S.bomTrail.slice(0,i), bomSupFilter:'', bomCatFilter:'', bomAddIng:'', bomAddQty:''}) }))`,最後再手動附加一個不可點的「目前」節點(`name:this.nameOf(S.selProd)`)。**name 永遠即時查、不快取**——半成品改名後麵包屑不會顯示舊字。

### 7.3 麵包屑過長

超過約 4 段時,整條改成單行、`overflow-x:auto;white-space:nowrap`(橫向捲動,不換行擠高整個編輯器),每段用既有下拉按鈕的截斷寫法(`overflow:hidden;text-overflow:ellipsis;white-space:nowrap` + `max-width`)避免單一名稱過長撐爆版面;過長名稱用原生 `title` 屬性顯示完整字串。**不做**「收合中段成 …」這種更複雜的裁切邏輯——POC 階段用捲動就夠。

### 7.4 左側清單同步反白 + 捲動入視

左側產品清單(index.html:1083-1087)本來就對 product 與自製半成品(selfIngs)都用 `S.selProd === id` 判斷反白(app.js:2315、2319),而且 `selfIngs` 串接時**不受搜尋框、門市分頁篩選影響**(一律全列出)——所以鑽到任何一個半成品,左側清單一定有一列會自動反白,不用改渲染邏輯。唯一要補的:鑽入/鑽出當下,把該反白列 `scrollIntoView({block:'nearest'})` 捲進可視範圍(半成品固定排在清單最後面,清單一長就可能捲出畫面外)。

### 7.5 鍵盤 / 手勢(nice-to-have,非必要)

`Esc` 鍵 = 等同「‹ 返回」退一階。app 目前沒有其他地方用到 Esc 快捷鍵,加了不衝突,但**非本功能上線的必要條件**,可留給下一輪。

### 7.6 窄螢幕 / 門市裝置

現有 `index.html` 沒有任何 `@media` 斷點(整個 app 是固定桌面/平板網格,`grid-template-columns:230px 1fr` 這類寫法沒有響應式版本)——本功能**不引入新的響應式框架**,維持現狀假設(平板橫向、非手機直式窄螢幕)。麵包屑本身用 7.3 的水平捲動策略即可應付現有最窄的支援寬度,不需要額外處理。

---

## 8. 給 `qa-pm` 的驗收要點

- [ ] 一般外購原料的 BOM 行:游標不變、不可點、無 tag、無 chevron。
- [ ] 自製半成品且已有配方的 BOM 行:整個名稱格可點(不是只有小 tag 才能點),hover 有視覺回饋,點擊後主體切換、麵包屑正確出現「原主體 › 新主體」。
- [ ] 從第二層再往下鑽一層:麵包屑正確累積成三段;點「第一段」直接跳回最初的頂層產品且麵包屑清空(不是逐步倒退)。
- [ ] 點「‹ 返回」只退一階,不是跳回頂層。
- [ ] 在任意深度直接從左側清單點別的產品/半成品:麵包屑清空,視為全新情境。
- [ ] store_admin / store_kitchen:能鑽入/鑽出/點麵包屑(純瀏覽全部可用),但在任何深度都不能改用量、名稱、售價、批次產出、工序,不能加料/移除料——**尤其要驗證鑽入的點擊本身沒有被唯讀模式的 `pointer-events:none` 一併擋掉**(這是本功能最容易埋雷的回歸點)。
- [ ] store_front:完全看不到「產品與配方」畫面,不受此功能影響。
- [ ] 成本相關欄位(單價/成本/批成本/單位成本/毛利/毛利率)對 store_admin/store_kitchen 在任何鑽入深度都必須繼續隱藏(`feature.cost` 既有邏輯的回歸測試)。
- [ ] 自製半成品尚無配方:表格顯示明確空狀態文字,而不是空白一片;central 與 store 文案依權限分流。
- [ ] 自我參照或循環配方:該行顯示「⚠ 循環」,仍可點擊進入(不死鎖、不報錯),重複點擊繞圈不會讓畫面卡住或無限迴圈。
- [ ] 改名一個半成品後,若之後重新鑽入含它的路徑,麵包屑顯示新名稱(不是進入當下快取的舊名)。
- [ ] 每次導覽(鑽入/鑽出/點麵包屑)後,加料區的廠商/分類篩選、加料選取、加料數量都重置為預設值,不殘留上一個配方的篩選狀態。
- [ ] 窄視窗下麵包屑維持單行、可橫向捲動,不把編輯器面板撐高。

---

## 9. Backend / Data Needs 結論

**不需要 schema 變更。** 沿用既有慣例:「自製半成品」= `ingredient` 表裡 `purchase_unit === '自製'` 的那一列,其配方就是 `bomOf(該 ingredient_id)`——這條 convention 已經是 MRP 展開(`mrpNeed()`)、生產單處理、成本展示等多處程式碼共用的判斷依據(`g.purchase_unit === '自製'`,不是靠 `isIngId()`——`isIngId(id)` 只是「這個 id 落在 ingredient 表而不是 product 表」的 id 空間判斷,跟「是否自製」是兩件事,別混用)。本功能的可點擊判斷,直接用同一個既有慣例即可,不需要新增 `type`/`is_semi` 欄位。

**已知的取捨(trade-off),不建議現在動,但誠實列出**:字串常數 `'自製'` 屬於「靠字串相等比對的慣例」,理論上比正式 enum/boolean 脆弱(打錯字、未來若要多語系化都可能悄悄壞掉)。但這個慣例**已經**在 MRP、成本展示、生產單完工、調撥打包判斷(`isPackaged`)等一堆地方以同一個字串比對存在——如果現在為了這一個新功能另外加一個 `is_semi` boolean,會製造「兩套判斷同一件事」的新漂移風險(哪個欄位才是真相?兩者不同步怎麼辦?),比繼續沿用現有慣例風險更高。若未來真要強化,建議是「一次性把所有 `purchase_unit === '自製'` 的比對點一起換成正式 enum」的單一 PR,而不是現在悄悄新增第二條路。**本功能維持現狀慣例即可上線。**
