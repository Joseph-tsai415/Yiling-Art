/**
 * Bakery ERP v3 — Google Apps Script 極薄後端(中央倉+多門市 + 登入驗證)
 *
 * v3 變更(登入與名單控管):
 *  - 新增 user_account 分頁(使用者名單):email 在名單上且 active=TRUE 才能使用系統
 *  - 前端「使用 Google 登入」→ 本後端驗證 Google ID token(比對 AUTH.CLIENT_ID)→
 *    名單比對通過核發 6 小時工作階段 token;之後所有讀寫都必須帶 token
 *  - setup / migrate / user_account 的讀寫僅限 super_admin
 *  - AUTH.CLIENT_ID 留空 = 不啟用驗證(行為同 v2,僅供本機測試;正式環境務必填寫)
 *
 * v2 變更:
 *  - 所有交易表新增 location_id 欄(LOC-A 信義店/LOC-B 大安店/LOC-C 中央倉)
 *  - 新增 location(地點主檔)、transfer_order/transfer_line(叫貨調撥)
 *
 * 既有 Sheet 升級步驟(URL 不變):
 *  1. 開啟 ERP-DB Sheet → 擴充功能 → Apps Script
 *  2. 全選刪除舊程式碼,貼上本檔全部內容,填好下方 AUTH 兩個值,儲存
 *  3. 上方函式下拉選:
 *     ・setup — 重建所有分頁為表頭+示範資料(舊資料會被重設!)
 *     ・migrate — 只升級表頭與欄位,保留現有資料(推薦):新增缺少的分頁(含 user_account)、
 *       補 location_id、supplier.contact 拆欄、purchase_line 補 received_qty
 *  4. 部署 → 管理部署 → 鉛筆編輯 → 版本選「新版本」→ 部署(/exec 網址不變)
 *  5. 用 AUTH.BOOTSTRAP_ADMIN 的 Google 帳號登入前端 → 自動建立第一個 super_admin 帳號
 */

// ─── 登入驗證設定(貼上你的值再部署)───
var AUTH = {
  CLIENT_ID: '51586710707-uc7fumj0ahggfdtgqbhevsk6h0ho9pjc.apps.googleusercontent.com',        // OAuth Client ID(和前端同一個,xxxx.apps.googleusercontent.com);留空 = 不驗證
  BOOTSTRAP_ADMIN: 'bingjun.cai@gmail.com'   // 第一位管理員的 Google Email;首次登入自動建立 super_admin 帳號
};

// <<gen:tables>> — 由 `npm run gen:schema` 依 js/schema.js 自動產生;勿手改此區塊(改結構請改 js/schema.js)
var TABLES = {
  location: ['location_id', 'name', 'type'],
  location_stock: ['location_id', 'ingredient_id', 'safety_stock'],
  ingredient: ['ingredient_id', 'name', 'category', 'base_unit', 'purchase_unit', 'conversion_rate', 'safety_stock', 'latest_unit_cost', 'quote_price', 'quote_price_pre', 'tax_rate', 'shelf_life_days', 'default_supplier_id', 'batch_yield'],
  product: ['product_id', 'name', 'type', 'sale_price', 'lead_days', 'default_yield', 'is_active', 'location_id'],
  supplier: ['supplier_id', 'name', 'contact_person', 'phone', 'email', 'address', 'payment_terms'],
  bom: ['bom_id', 'product_id', 'ingredient_id', 'qty_per_yield'],
  routing: ['routing_id', 'product_id', 'step_no', 'step_name', 'duration_min', 'equipment_id', 'cross_day'],
  equipment: ['equipment_id', 'name', 'type', 'count', 'capacity_per_batch', 'batch_minutes'],
  category: ['category_id', 'name', 'display_order'],
  staff: ['staff_id', 'name', 'role', 'active'],
  line: ['line_id', 'name'],
  station: ['station_id', 'line_id', 'seq', 'name', 'match', 'staff_id'],
  assignment: ['assign_id', 'prod_id', 'step_no', 'staff_id', 'ts'],
  purchase_line: ['po_id', 'po_name', 'ingredient_id', 'qty', 'purchase_unit', 'unit_price', 'subtotal', 'supplier_id', 'order_date', 'arrival_date', 'status', 'location_id', 'received_qty', 'tax_rate'],
  production_order: ['prod_id', 'product_id', 'plan_qty', 'start_date', 'finish_date', 'status', 'location_id'],
  plan_draft: ['line_id', 'product_id', 'qty', 'finish_date', 'finish_time', 'staff_id', 'location_id'],
  po_draft: ['line_id', 'ingredient_id', 'units', 'unit_price', 'tax_rate', 'doc_name', 'eta', 'name_ov', 'eta_ov', 'location_id'],
  sales_line: ['so_id', 'product_id', 'qty', 'sale_price', 'sale_date', 'idempotency_key', 'location_id'],
  waste: ['waste_id', 'target_type', 'target_id', 'qty', 'reason', 'date', 'location_id'],
  stocktake: ['stocktake_id', 'target_type', 'target_id', 'counted_qty', 'date', 'location_id'],
  transfer_order: ['to_id', 'from_loc', 'to_loc', 'status', 'request_date', 'ship_date', 'receive_date', 'need_date', 'urgent'],
  transfer_line: ['tl_id', 'to_id', 'item_type', 'item_id', 'qty'],
  ingredient_request: ['req_id', 'location_id', 'name', 'spec', 'weekly_qty', 'urgent', 'status', 'ingredient_id', 'request_date', 'done_date'],
  stock_ledger: ['ledger_id', 'item_type', 'item_id', 'direction', 'qty', 'source_type', 'source_id', 'unit_cost', 'txn_date', 'location_id'],
  user_account: ['user_id', 'name', 'email', 'role', 'location_ids', 'active', 'created_at', 'last_login'],
  role_permission: ['role_id', 'perm_key', 'allow']
};
// <</gen:tables>>

// 前端主同步(pullAll)與 listAll 批次讀取的分頁清單 — 由 gen:schema 依 js/schema.js 產生
// <<gen:synctables>> — 由 `npm run gen:schema` 依 js/schema.js 自動產生;勿手改此區塊(改結構請改 js/schema.js)
var SYNC_TABLES = ['location', 'location_stock', 'ingredient', 'product', 'supplier', 'bom', 'routing', 'equipment', 'category', 'staff', 'line', 'station', 'assignment', 'purchase_line', 'production_order', 'plan_draft', 'po_draft', 'sales_line', 'waste', 'stocktake', 'transfer_order', 'transfer_line', 'ingredient_request', 'stock_ledger'];
// <</gen:synctables>>

// listAll 批次「排除」的無界成長帳本(append-only,單批全讀會撐爆回應大小 → 整批 throw);改由前端逐表 list 拉取
// <<gen:batchexclude>> — 由 `npm run gen:schema` 依 js/schema.js 自動產生;勿手改此區塊(改結構請改 js/schema.js)
var BATCH_EXCLUDE = ['stock_ledger', 'sales_line'];
// <</gen:batchexclude>>

// role_permission 預設值(setup 種入;migrate 只在分頁不存在或空白時種入 — 不覆蓋你的調整)
// 依 doc/PERMISSION_ROLE_MAP.md:central_ops 可見成本;門市角色(含店長)全部隱藏成本
// <<gen:perms>> — 由 `npm run gen:schema` 依 js/schema.js 自動產生;勿手改此區塊(改預設權限請改 js/schema.js)
var DEFAULT_PERMS = {
  central_ops: ['screen.setup', 'screen.inventory', 'screen.purchase', 'screen.ingredients', 'screen.locations', 'screen.products', 'screen.suppliers', 'feature.cost'],
  store_admin: ['screen.overview', 'screen.schedule', 'screen.production', 'screen.sales', 'screen.inventory', 'screen.purchase', 'screen.ingredients', 'screen.products', 'screen.staff', 'screen.reports', 'screen.closing'],
  store_kitchen: ['screen.production', 'screen.products'],
  store_front: ['screen.sales']
};
// <</gen:perms>>
function defaultPermRows_() {
  var out = [];
  Object.keys(DEFAULT_PERMS).forEach(function (role) {
    DEFAULT_PERMS[role].forEach(function (k) { out.push([role, k, 'TRUE']); });
  });
  return out;
}

// 寫入 ACL(deny-by-default,防提權/防洗表)—— 每張表 → 允許「新增(append)」或「整表覆寫(replace)」的角色名單。
// 規則(見 canWrite_):!sess(未啟用登入/demo)→ 放行;super_admin → 全部放行(故不列於名單);
//   其餘角色必須「該表有登記且名單含此角色」才放行;未登記的表 → 只有 super_admin 能寫(空陣列 [] 同義)。
// 名單依 js/app.js 每個 db.append/db.replace 的呼叫畫面→角色反推(改動前務必重跑該對照,避免誤殺合法流程)。
// 角色:central_ops=中央 / store_admin=店長 / store_kitchen=廚房 / store_front=前台收銀。
var APPEND_ACL = {
  location: ['central_ops'],
  location_stock: ['central_ops', 'store_admin'],
  ingredient: ['central_ops', 'store_admin', 'store_kitchen'], // INTERIM:見下方 REPLACE_ACL.ingredient 註解
  category: ['central_ops', 'store_admin'],
  product: ['central_ops'],
  supplier: ['central_ops'],
  bom: ['central_ops'],
  routing: ['central_ops'],
  equipment: ['central_ops'],
  staff: ['store_admin'],
  line: ['store_admin', 'store_kitchen'],
  station: ['store_admin', 'store_kitchen'],
  assignment: ['store_admin', 'store_kitchen'],
  purchase_line: ['central_ops'],
  // central_ops 也可 append:中央「自製 — 排入生產」草稿(doRestock→schedulePrep@CENTRAL)是刻意支援的流程
  //   (中央自製為 owner 需求);只有生產「完成/出貨」是未來工作,規劃草稿本身允許。
  production_order: ['central_ops', 'store_admin', 'store_kitchen'],
  plan_draft: ['store_admin'],
  po_draft: ['central_ops'],
  sales_line: ['store_admin', 'store_front'],
  waste: ['store_admin', 'store_kitchen'],
  stocktake: ['central_ops', 'store_admin'],
  transfer_order: ['central_ops', 'store_admin'],
  transfer_line: ['central_ops', 'store_admin'],
  ingredient_request: ['central_ops', 'store_admin'],
  stock_ledger: ['central_ops', 'store_admin', 'store_kitchen', 'store_front'], // 所有角色皆會寫帳本(出入庫/銷售/盤點)
  user_account: [],     // super_admin only(帳號管理)
  role_permission: []   // super_admin only(權限管理)— 擋自助提權
};
// 整表覆寫 ACL:仍受 scoped replace 保護(範圍外的既有列會保留),但角色 gate 一律 deny-by-default。
// 空陣列 [] 的 append-only 稽核表(stock_ledger/sales_line/waste/stocktake/assignment)= 任何人(除 super_admin)都不能整表覆寫 → 擋洗稽核軌跡。
var REPLACE_ACL = {
  location: ['central_ops'],
  location_stock: ['central_ops', 'store_admin'],
  // INTERIM:目標為中央專屬(central_ops),但門市生產完成會以 db.replace('ingredient',…) 回寫自製半成品成本
  //   (js/app.js finish(),store_admin+store_kitchen 於生產畫面可達),addSelfIng 也會 append ingredient。
  //   鎖成 central_ops-only 會打斷這些「現行」門市流程,故暫留 store_admin/store_kitchen —
  //   仍擋住不受信任的 store_front(文件記載的洗表 exploit)。待門市自製成本回寫改版後再收斂為中央專屬。
  ingredient: ['central_ops', 'store_admin', 'store_kitchen'],
  category: ['central_ops', 'store_admin'],
  product: ['central_ops'],
  supplier: ['central_ops'],
  bom: ['central_ops'],
  routing: ['central_ops'],
  equipment: ['central_ops'],
  staff: ['store_admin'],
  line: ['store_admin', 'store_kitchen'],
  station: ['store_admin', 'store_kitchen'],
  assignment: [],       // super_admin only(append-only 指派紀錄,不整表覆寫)
  purchase_line: ['central_ops'],
  production_order: ['store_admin', 'store_kitchen'],
  plan_draft: ['store_admin'],
  po_draft: ['central_ops'],
  sales_line: [],       // super_admin only(append-only 銷售帳)
  waste: [],            // super_admin only(append-only 報廢帳)
  stocktake: [],        // super_admin only(append-only 盤點帳)
  transfer_order: ['central_ops', 'store_admin'],
  transfer_line: ['central_ops'], // 部分出貨改寫明細=中央操作;門市只 append
  ingredient_request: ['central_ops'],
  stock_ledger: [],     // super_admin only(append-only 庫存帳本)
  user_account: [],     // super_admin only
  role_permission: []   // super_admin only
};

var SEED = {
  location: [
    ['LOC-C','中央倉','central'],
    ['LOC-A','信義店','store'],
    ['LOC-B','大安店','store']
  ],
  location_stock: [
    ['LOC-C','ING-001',30000],['LOC-C','ING-003',8000],['LOC-C','ING-006',8000],['LOC-C','ING-009',2000],['LOC-C','ING-021',6000],
    ['LOC-A','ING-001',10000],['LOC-A','ING-003',3000],['LOC-A','ING-006',5000],['LOC-A','ING-009',500],['LOC-A','ING-014',2000],['LOC-A','ING-021',4000],
    ['LOC-B','ING-001',8000],['LOC-B','ING-003',2000],['LOC-B','ING-009',400],['LOC-B','ING-014',1500]
  ],
  ingredient: [
    ['ING-001','高筋麵粉 T65','麵粉','g','袋',25000,10000,0.035,833,1.05,180,'SUP-01'],
    ['ING-003','細砂糖','糖','g','包',10000,3000,0.028,267,1.05,365,'SUP-01'],
    ['ING-006','無鹽發酵奶油','油脂','g','箱',10000,5000,0.31,2952,1.05,60,'SUP-02'],
    ['ING-009','法國海鹽','鹽','g','包',1000,500,0.09,86,1.05,730,'SUP-01'],
    ['ING-014','魯邦種(老麵)','發酵種','g','自製',1,2000,0.015,0,1.0,3,''],
    ['ING-021','全脂鮮奶','乳品','ml','瓶',1000,4000,0.068,65,1.05,10,'SUP-02']
  ],
  product: [
    ['PRD-01','魯邦鄉村','bread',45,2,8,'TRUE','LOC-A'],
    ['PRD-02','可頌','bread',55,2,12,'TRUE','LOC-A'],
    ['PRD-03','法國長棍','bread',60,0,10,'TRUE','ALL'],
    ['PRD-04','肉桂捲','dessert',65,0,10,'TRUE','LOC-A'],
    ['PRD-05','佛卡夏','bread',50,0,8,'TRUE','LOC-B']
  ],
  supplier: [
    ['SUP-01','統益麵粉行','陳先生','02-2755-3311','order@tongyi.com.tw','台北市萬華區環河南路二段 88 號','月結 30 天'],
    ['SUP-02','禾豐乳品','林小姐','0912-345-678','','新北市三重區重新路五段 12 號','週結']
  ],
  bom: [
    ['B-01','PRD-01','ING-001',2800],
    ['B-02','PRD-01','ING-014',560],
    ['B-03','PRD-01','ING-009',56],
    ['B-04','PRD-02','ING-001',1800],
    ['B-05','PRD-02','ING-006',1600],
    ['B-06','PRD-02','ING-003',300]
  ],
  routing: [
    ['R-01','PRD-01',1,'攪拌',30,'EQ-01','FALSE'],
    ['R-02','PRD-01',2,'一次發酵',90,'EQ-02','FALSE'],
    ['R-03','PRD-01',3,'分割整形',40,'','FALSE'],
    ['R-04','PRD-01',4,'冷藏發酵',900,'EQ-02','TRUE'],
    ['R-05','PRD-01',5,'烘烤',45,'EQ-03','FALSE']
  ],
  equipment: [
    ['EQ-01','螺旋攪拌機','mixer',1,'15 kg 麵團',30],
    ['EQ-02','發酵箱','proofer',2,'16 盤',''],
    ['EQ-03','層爐烤箱','oven',2,'4 盤',45]
  ],
  category: [
    ['CAT-01','麵粉',1],['CAT-02','糖',2],['CAT-03','油脂',3],['CAT-04','乳品',4],['CAT-05','蛋',5],
    ['CAT-06','鹽',6],['CAT-07','發酵種',7],['CAT-08','堅果果乾',8],['CAT-09','包材',9],['CAT-10','其他',10]
  ],
  staff: [
    ['EMP-01','林店長','店長/排程','TRUE'],
    ['EMP-02','阿凱','主廚/攪拌','TRUE'],
    ['EMP-03','小雯','整形/烘烤','TRUE'],
    ['EMP-04','阿娟','前台/包裝','TRUE']
  ],
  line: [
    ['LINE-01','麵包流水線'],
    ['LINE-02','餐食流水線']
  ],
  station: [
    ['ST-01','LINE-01',1,'攪拌','攪拌|拌合|餵養',''],
    ['ST-02','LINE-01',2,'開酥','開酥|鬆弛',''],
    ['ST-03','LINE-01',3,'發酵','發酵|熟成|冷藏定型',''],
    ['ST-04','LINE-01',4,'整形','整形|分割|捲製',''],
    ['ST-05','LINE-01',5,'烘烤','烘烤|烤',''],
    ['ST-06','LINE-02',1,'備料','備料|洗切|處理',''],
    ['ST-07','LINE-02',2,'烹調','煮|炒|烹|燉|煒',''],
    ['ST-08','LINE-02',3,'組裝','組裝|擺盤|包裝',''],
    ['ST-09','LINE-02',4,'出餐','出餐|保溫','']
  ],
  production_order: [
    ['P-0330','PRD-02',60,'2026-06-30','2026-07-02','完成','LOC-A'],
    ['P-0331','PRD-01',24,'2026-07-01','2026-07-03','投料','LOC-A'],
    ['P-0333','PRD-01',32,'2026-07-02','2026-07-04','投料','LOC-A']
  ],
  transfer_order: [
    ['TO-1001','LOC-C','LOC-A','已出貨','2026-07-02','2026-07-03','','2026-07-04',''],
    ['TO-1002','LOC-C','LOC-B','叫貨','2026-07-04','','','2026-07-05','TRUE']
  ],
  ingredient_request: [
    ['REQ-001','LOC-B','T55 麵粉','法棍用、25kg 袋',40000,'TRUE','待處理','','2026-07-04','']
  ],
  transfer_line: [
    ['TL-001','TO-1001','ingredient','ING-001',25000],
    ['TL-002','TO-1001','ingredient','ING-021',6000],
    ['TL-003','TO-1002','ingredient','ING-001',25000],
    ['TL-004','TO-1002','ingredient','ING-006',5000],
    ['TL-005','TO-1002','ingredient','ING-003',5000]
  ],
  stock_ledger: [
    // 門市(LOC-A)
    ['L-0001','ingredient','ING-001','in',25000,'purchase','PO-0127',0.035,'2026-07-01','LOC-A'],
    ['L-0002','ingredient','ING-001','out',11200,'production_out','P-0333',0.035,'2026-07-02','LOC-A'],
    ['L-0003','product','PRD-02','in',60,'production_in','P-0330',14.1,'2026-07-02','LOC-A'],
    ['L-0004','product','PRD-02','out',2,'sales','SO-1001',14.1,'2026-07-02','LOC-A'],
    // 中央倉(LOC-C)期初 + TO-1001 出貨扣帳
    ['L-9001','ingredient','ING-001','in',80000,'stocktake','期初',0.035,'2026-07-01','LOC-C'],
    ['L-9002','ingredient','ING-003','in',8000,'stocktake','期初',0.028,'2026-07-01','LOC-C'],
    ['L-9003','ingredient','ING-006','in',12000,'stocktake','期初',0.31,'2026-07-01','LOC-C'],
    ['L-9004','ingredient','ING-009','in',3000,'stocktake','期初',0.09,'2026-07-01','LOC-C'],
    ['L-9005','ingredient','ING-021','in',10000,'stocktake','期初',0.068,'2026-07-01','LOC-C'],
    ['L-9006','ingredient','ING-001','out',25000,'transfer_out','TO-1001',0.035,'2026-07-03','LOC-C'],
    ['L-9007','ingredient','ING-021','out',6000,'transfer_out','TO-1001',0.068,'2026-07-03','LOC-C']
  ],
  sales_line: [
    ['SO-1001','PRD-02',2,55,'2026-07-02','pos-1846','LOC-A']
  ]
};
SEED.role_permission = defaultPermRows_();

// ─── 登入驗證 ───
function authEnabled_() { return !!AUTH.CLIENT_ID; }
// token → 工作階段(CacheService,6 小時);無效回 null。快取只存 email,
// 角色/地點/停用狀態每個請求都重新讀 user_account → 改名單即時生效,不用等 token 過期。
function session_(token) {
  if (!token) return null;
  var raw = CacheService.getScriptCache().get('tok:' + token);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (err) { return null; }
}
function resolveSess_(token) {
  var s = session_(token);
  if (!s) return null;
  var acc = findAccount_(String(s.email || ''));
  if (!acc || String(acc.active).toUpperCase() !== 'TRUE') return null;
  return { email: s.email, name: String(acc.name || ''), role: String(acc.role || ''), user_id: String(acc.user_id || ''), locs: String(acc.location_ids || '').trim() };
}
// 角色的權限清單(role_permission 分頁,allow=TRUE);super_admin 恆為全部
function permsOf_(role) {
  if (role === 'super_admin') return ['*'];
  var sh = ss_().getSheetByName('role_permission');
  if (!sh || sh.getLastRow() < 2) return (DEFAULT_PERMS[role] || []).slice();
  var data = sh.getDataRange().getValues();
  var head = data[0].map(String);
  var iR = head.indexOf('role_id'), iK = head.indexOf('perm_key'), iA = head.indexOf('allow');
  var out = [];
  for (var r = 1; r < data.length; r++) {
    if (String(data[r][iR]).trim() === role && String(data[r][iA]).toUpperCase() === 'TRUE') out.push(String(data[r][iK]).trim());
  }
  return out;
}
// 地點範圍:null = 不限(ALL/super);否則 {LOC-A:1,...}
function scopeOf_(sess) {
  if (!sess || sess.role === 'super_admin') return null;
  var l = sess.locs;
  if (!l || l.toUpperCase() === 'ALL') return null;
  var m = {};
  l.split(/[|;,]/).forEach(function (x) { x = x.trim(); if (x) m[x] = 1; });
  return m;
}
// 讀取過濾:範圍外的列不回傳(rows[0] 為表頭)
function filterRows_(name, rows, scope) {
  if (!scope || !rows || rows.length < 2) return rows;
  var head = rows[0].map(String);
  var keep = function (fn) { return [rows[0]].concat(rows.slice(1).filter(fn)); };
  if (name === 'product') { // 共用(空/ALL)或歸屬範圍內門市
    var iL = head.indexOf('location_id');
    if (iL < 0) return rows;
    return keep(function (r) {
      var v = String(r[iL] || '').trim();
      if (!v || v.toUpperCase() === 'ALL') return true;
      return v.split(/[|;,]/).some(function (x) { return scope[x.trim()]; });
    });
  }
  if (name === 'transfer_order') {
    var iT = head.indexOf('to_loc'), iF = head.indexOf('from_loc');
    return keep(function (r) { return scope[String(r[iT]).trim()] || scope[String(r[iF]).trim()]; });
  }
  if (name === 'transfer_line') { // 跟隨可見的 transfer_order
    var ok = {};
    var toSh = ss_().getSheetByName('transfer_order');
    if (toSh && toSh.getLastRow() > 1) {
      var td = toSh.getDataRange().getValues();
      var th = td[0].map(String);
      var iId = th.indexOf('to_id'), iT2 = th.indexOf('to_loc'), iF2 = th.indexOf('from_loc');
      for (var r = 1; r < td.length; r++) if (scope[String(td[r][iT2]).trim()] || scope[String(td[r][iF2]).trim()]) ok[String(td[r][iId])] = 1;
    }
    var iTo = head.indexOf('to_id');
    return keep(function (r2) { return ok[String(r2[iTo])]; });
  }
  var iLoc = head.indexOf('location_id');
  if (iLoc < 0) return rows; // 無地點欄的主資料 → 共用不過濾
  return keep(function (r) { return !!scope[String(r[iLoc] || '').trim() || 'LOC-A']; }); // 空值視為 LOC-A(舊資料慣例)
}
// 列是否在範圍內(append/replace 驗證用)
function rowInScope_(name, headers, rowArr, scope) {
  if (!scope) return true;
  if (name === 'transfer_order') {
    var iT = headers.indexOf('to_loc'), iF = headers.indexOf('from_loc');
    return !!(scope[String(rowArr[iT] || '').trim()] || scope[String(rowArr[iF] || '').trim()]);
  }
  if (name === 'transfer_line') {
    // transfer_line 無 location_id;其歸屬由父單 transfer_order.to_id 決定。鏡像 filterRows_ 的可見性:
    // 找出這列 to_id 的父單,要求父單 to_loc/from_loc 與呼叫者範圍相交 —— 否則等於把明細塞進別家門市的
    // 調撥單(跨店注入)。舊碼因無 location_id 走 iL<0 → return true,任何店都能注入 → 本 case 修補。
    var iTo = headers.indexOf('to_id');
    if (iTo < 0) return true;
    var toId = String(rowArr[iTo] || '').trim();
    if (!toId) return true;
    var toSh = ss_().getSheetByName('transfer_order');
    if (toSh && toSh.getLastRow() > 1) {
      var td = toSh.getDataRange().getValues();
      var th = td[0].map(String);
      var iId = th.indexOf('to_id'), iT2 = th.indexOf('to_loc'), iF2 = th.indexOf('from_loc');
      for (var r = 1; r < td.length; r++) {
        if (String(td[r][iId]).trim() === toId) {
          return !!(scope[String(td[r][iT2] || '').trim()] || scope[String(td[r][iF2] || '').trim()]);
        }
      }
    }
    // 找不到父單 → 放行。理由:(1) 門市自建叫貨(submitTO)先 append transfer_order 再 append transfer_line,
    //   而前端寫入是非同步、後端僅以 LockService 排隊、不保證兩個 POST 的先後 → 明細可能先於父單抵達,
    //   若此時 deny 會誤殺合法叫貨;(2) 無主孤列在讀取端本就被 filterRows_ 濾掉、無資料外洩。
    //   跨店注入的攻擊面是「注入別家既存單」,該父單一定存在 → 已被上面的相交檢查擋下。
    return true;
  }
  var iL = headers.indexOf('location_id');
  if (iL < 0) return true;
  return !!scope[String(rowArr[iL] || '').trim() || 'LOC-A'];
}
// 寫入 ACL 檢查(append 與 replace 共用)。deny-by-default:未列的 sheet / 名單不含此角色 → 只有 super_admin 可寫。
//   !sess = 後端未啟用登入(demo/公開模式)→ 一律放行(維持原行為)。action 決定查 APPEND_ACL 或 REPLACE_ACL。
function canWrite_(sess, sheet, action) {
  if (!sess) return true; // 未啟用驗證
  if (sess.role === 'super_admin') return true;
  var acl = (action === 'append' ? APPEND_ACL : REPLACE_ACL)[sheet];
  return !!acl && acl.indexOf(sess.role) >= 0; // 未登記 sheet(acl undefined)或名單不含此角色 → 拒絕
}
function accountsSheet_() {
  var sh = ss_().getSheetByName('user_account');
  if (!sh) { sh = ss_().insertSheet('user_account'); sh.appendRow(TABLES.user_account); sh.setFrozenRows(1); }
  return sh;
}
function findAccount_(email) {
  var data = accountsSheet_().getDataRange().getValues();
  if (data.length < 2) return null;
  var head = data[0].map(String);
  var iE = head.indexOf('email');
  for (var r = 1; r < data.length; r++) {
    if (String(data[r][iE]).trim().toLowerCase() === email) {
      var o = {}; head.forEach(function (h, i) { o[h] = data[r][i]; });
      o._row = r + 1;
      return o;
    }
  }
  return null;
}
// 前端送來 Google ID token → 向 Google 驗證 → 名單比對 → 核發工作階段 token
function login_(credential) {
  if (!authEnabled_()) return { ok: false, error: '後端未啟用登入(AUTH.CLIENT_ID 未設定)' };
  if (!credential) return { ok: false, error: 'missing_credential' };
  var resp = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(credential), { muteHttpExceptions: true });
  if (resp.getResponseCode() !== 200) return { ok: false, error: 'invalid_token' };
  var info = JSON.parse(resp.getContentText());
  if (info.aud !== AUTH.CLIENT_ID) return { ok: false, error: 'wrong_audience' };
  if (String(info.email_verified) !== 'true') return { ok: false, error: 'email_not_verified' };
  var email = String(info.email || '').trim().toLowerCase();
  var acc = findAccount_(email);
  // 首位管理員自動開通(chicken-and-egg):AUTH.BOOTSTRAP_ADMIN 首次登入 → super_admin
  if (!acc && AUTH.BOOTSTRAP_ADMIN && email === AUTH.BOOTSTRAP_ADMIN.trim().toLowerCase()) {
    var now = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
    accountsSheet_().appendRow(['U-001', info.name || '管理員', email, 'super_admin', 'ALL', 'TRUE', now, now]);
    acc = findAccount_(email);
  }
  if (!acc || String(acc.active).toUpperCase() !== 'TRUE') return { ok: false, error: 'not_on_list', email: email };
  var token = Utilities.getUuid();
  // 快取只存 email — 角色/地點/停用每個請求重新解析(resolveSess_),名單變更即時生效
  CacheService.getScriptCache().put('tok:' + token, JSON.stringify({ email: email }), 21600);
  try { accountsSheet_().getRange(acc._row, TABLES.user_account.indexOf('last_login') + 1).setValue(Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm')); } catch (err) { }
  var role = String(acc.role || '');
  return { ok: true, token: token, name: String(acc.name || info.name || ''), email: email, role: role, location_ids: String(acc.location_ids || ''), perms: permsOf_(role), expires_in: 21600 };
}

// ─── 讀取:GET ?action=list&sheet=ingredient&token=… ───
// ── 樂觀鎖:每張表一個版本號(存 DocumentProperties)。list 回傳目前版號;replace 帶 baseRev 比對,
//    不合(代表有人先改過)就回 conflict,讓前端重新載入再改 — 避免整表覆寫把別人的變更蓋掉。──
function rev_(sheet) { return Number(PropertiesService.getDocumentProperties().getProperty('rev:' + sheet) || '0'); }
function bumpRev_(sheet) { var p = PropertiesService.getDocumentProperties(); var n = rev_(sheet) + 1; p.setProperty('rev:' + sheet, String(n)); return n; }

function doGet(e) {
  var action = (e && e.parameter && e.parameter.action) || 'tables';
  var sess = null;
  if (authEnabled_()) {
    sess = resolveSess_(e && e.parameter && e.parameter.token);
    if (!sess) return json_({ ok: false, error: 'unauthorized' });
  }
  if (action === 'whoami') return json_(sess ? { ok: true, email: sess.email, name: sess.name, role: sess.role, location_ids: sess.locs, perms: permsOf_(sess.role) } : { ok: true, role: '', msg: '後端未啟用登入' });
  if (action === 'setup') {
    if (authEnabled_() && sess.role !== 'super_admin') return json_({ ok: false, error: 'forbidden' });
    setup(); return json_({ ok: true, msg: 'setup 完成,已建立 ' + Object.keys(TABLES).length + ' 個分頁' });
  }
  if (action === 'migrate') {
    if (authEnabled_() && sess.role !== 'super_admin') return json_({ ok: false, error: 'forbidden' });
    var rep = migrate(); return json_({ ok: true, msg: rep.length ? rep.join(';') : '全部已是最新結構' });
  }
  // 批次讀取:一次回傳所有主同步分頁,取代前端逐表 24 個 list 請求(單一往返 → 少 23 次冷啟動)。
  // 只含 SYNC_TABLES(不含 user_account/role_permission,那兩張仍由前端 loadAccounts 另外讀),故無需 super_admin 檢查。
  if (action === 'listAll') {
    var tzA = Session.getScriptTimeZone();
    var scopeA = scopeOf_(sess);
    // 一次讀入全部版號(取代逐表 rev_ 的 24 次 property store 往返);key/coercion 與 rev_ 保持一致 → 回傳版號與單表 list 位元相同。
    var propsA = PropertiesService.getDocumentProperties().getProperties();
    // 批次集 = 主同步表扣掉無界成長帳本(stock_ledger / sales_line):那兩張一大就會撐爆單批回應而整批 throw,
    // 改由前端逐表 list 拉(仍讓 24 → 約 3 個請求)。注意:只縮這個批次迴圈,SYNC_TABLES 本身不動(它同時是前端 SCHEMA 全集)。
    var batchA = SYNC_TABLES.filter(function (t) { return BATCH_EXCLUDE.indexOf(t) < 0; });
    var sheets = {};
    for (var iA = 0; iA < batchA.length; iA++) {
      var nameA = batchA[iA];
      var shA = ss_().getSheetByName(nameA);
      // 契約(刻意有別於單表 list 的 {ok:false, error:'找不到分頁'}):缺分頁在此靜默略過、不放進回應 →
      // 前端據此把該表列為 missing → 自動 migrate → 重拉。批次端不因單一缺表而失敗。
      if (!shA) continue;
      var revA = Number(propsA['rev:' + nameA] || '0'); // 同 rev_():先讀版號再讀資料(寧可誤判 conflict 也不漏別人剛寫入的變更)
      var rowsA = shA.getDataRange().getValues().map(function (r) {
        return r.map(function (v) { return (v instanceof Date) ? Utilities.formatDate(v, tzA, 'yyyy-MM-dd') : v; });
      });
      sheets[nameA] = { rows: filterRows_(nameA, rowsA, scopeA), rev: revA };
    }
    return json_({ ok: true, sheets: sheets });
  }
  if (action === 'list') {
    if ((e.parameter.sheet === 'user_account' || e.parameter.sheet === 'role_permission') && authEnabled_() && sess.role !== 'super_admin') return json_({ ok: false, error: 'forbidden' });
    var sh = ss_().getSheetByName(e.parameter.sheet);
    if (!sh) return json_({ ok: false, error: '找不到分頁:' + e.parameter.sheet + '(請先執行 setup)' });
    var curRev = rev_(e.parameter.sheet); // 先讀版號再讀資料:寧可誤判 conflict 也不要漏掉別人剛寫入的變更
    var tz = Session.getScriptTimeZone();
    var rows = sh.getDataRange().getValues().map(function (r) {
      return r.map(function (v) { return (v instanceof Date) ? Utilities.formatDate(v, tz, 'yyyy-MM-dd') : v; });
    });
    rows = filterRows_(e.parameter.sheet, rows, scopeOf_(sess)); // 地點範圍外的列不回傳
    return json_({ ok: true, rows: rows, rev: curRev });
  }
  return json_({ ok: true, tables: Object.keys(TABLES) });
}

// ─── 寫入:POST body = {"action":"append","sheet":"stock_ledger","row":{...},"token":"…"} ───
function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000); // 寫入排隊,避免並發衝突
  try {
    var body = JSON.parse(e.postData.contents);

    // 登入不需 token(它就是來換 token 的)
    if (body.action === 'login') return json_(login_(body.credential));

    var sess = null, scope = null;
    if (authEnabled_()) {
      sess = resolveSess_(body.token);
      if (!sess) return json_({ ok: false, error: 'unauthorized' });
      scope = scopeOf_(sess);
    }

    // 主資料整表覆寫:{"action":"replace","sheet":"ingredient","headers":[...],"rows":[[...]]}
    // 有地點範圍的工作階段走 scoped replace:只覆寫範圍內的列、保留範圍外既有列 —
    // 讀取已過濾 + 整表覆寫,若不這樣做會把其他店的資料清掉。
    if (body.action === 'replace') {
      if (!canWrite_(sess, body.sheet, 'replace')) return json_({ ok: false, error: 'forbidden' });
      // 樂觀鎖:前端帶了 baseRev 且與目前版號不同 → 有人先改過,回 conflict 讓前端重載再改.
      // 舊前端沒帶 baseRev(undefined/null)則略過檢查,行為與之前完全相同(向後相容).
      if (body.baseRev != null && Number(body.baseRev) !== rev_(body.sheet)) return json_({ ok: false, error: 'conflict', rev: rev_(body.sheet) });
      var shR = ss_().getSheetByName(body.sheet) || ss_().insertSheet(body.sheet);
      var headersR = body.headers;
      var incoming = body.rows || [];
      if (scope) {
        for (var iR = 0; iR < incoming.length; iR++) {
          if (!rowInScope_(body.sheet, headersR, incoming[iR], scope)) return json_({ ok: false, error: 'forbidden_location' });
        }
        // 保留範圍外既有列(以現有表頭對映到新表頭,防欄位順序不同)
        if (shR.getLastRow() > 1) {
          var old = shR.getDataRange().getValues();
          var oldHead = old[0].map(String);
          var map = headersR.map(function (h) { return oldHead.indexOf(h); });
          for (var r0 = 1; r0 < old.length; r0++) {
            var mapped = map.map(function (idx) { return idx >= 0 ? old[r0][idx] : ''; });
            if (!rowInScope_(body.sheet, headersR, mapped, scope)) incoming.push(mapped);
          }
        }
      }
      shR.clearContents();
      var data = [headersR].concat(incoming);
      shR.getRange(1, 1, data.length, headersR.length).setValues(data);
      shR.setFrozenRows(1);
      return json_({ ok: true, replaced: data.length - 1, rev: bumpRev_(body.sheet) });
    }

    // append 角色 ACL — 與 replace 同為 deny-by-default(未列 sheet / 名單不含此角色 → 只有 super_admin)。
    //   放在地點範圍檢查之前:先擋掉角色無權寫的表(如 role_permission 自助提權),再談範圍。
    if (!canWrite_(sess, body.sheet, 'append')) return json_({ ok: false, error: 'forbidden' });

    var sh = ss_().getSheetByName(body.sheet);
    if (!sh) return json_({ ok: false, error: '找不到分頁:' + body.sheet + '(請先執行 setup)' });
    var headers = TABLES[body.sheet] || sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];

    // append 的新列必須在地點範圍內(transfer_order 檢查 to_loc/from_loc)
    if (scope && body.row) {
      var rowArr0 = headers.map(function (h) { return body.row[h] !== undefined ? body.row[h] : ''; });
      if (!rowInScope_(body.sheet, headers, rowArr0, scope)) return json_({ ok: false, error: 'forbidden_location' });
    }
    if (body.sheet === 'user_account' && authEnabled_() && sess.role !== 'super_admin') return json_({ ok: false, error: 'forbidden' });

    // 冪等:同一 idempotency_key 只入帳一次(防 POS 重複推播)
    if (body.row && body.row.idempotency_key) {
      var col = headers.indexOf('idempotency_key') + 1;
      if (col > 0 && sh.getLastRow() > 1) {
        var keys = sh.getRange(2, col, sh.getLastRow() - 1, 1).getValues();
        for (var i = 0; i < keys.length; i++) {
          if (String(keys[i][0]) === String(body.row.idempotency_key)) {
            return json_({ ok: true, skipped: true, msg: '重複交易,已略過' });
          }
        }
      }
    }

    var row = headers.map(function (h) { return body.row && body.row[h] !== undefined ? body.row[h] : ''; });
    sh.appendRow(row); // append-only:只新增、不改舊列
    return json_({ ok: true, appended: row, rev: bumpRev_(body.sheet) }); // 版號 +1:讓別人未送出的整表覆寫變成 stale
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

// ─── 初始化:建立所有分頁 + v2 表頭 + 示範資料(可重跑,會重設內容) ───
function setup() {
  var ss = ss_();
  Object.keys(TABLES).forEach(function (name) {
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    sh.clear();
    sh.appendRow(TABLES[name]);
    (SEED[name] || []).forEach(function (r) { sh.appendRow(r); });
    sh.setFrozenRows(1);
  });
}

// ─── 升級表頭(不清資料):缺分頁補建、舊欄位依名稱對映、新欄位補預設值 ───
function migrate() {
  var ss = ss_(); var report = [];
  Object.keys(TABLES).forEach(function (name) {
    var want = TABLES[name];
    var sh = ss.getSheetByName(name);
    if (!sh) { sh = ss.insertSheet(name); sh.appendRow(want); (SEED[name] || []).forEach(function (r) { sh.appendRow(r); }); sh.setFrozenRows(1); report.push(name + ':新建'); return; }
    var data = sh.getDataRange().getValues();
    if (!data.length || !String(data[0].join(''))) { sh.clear(); sh.appendRow(want); sh.setFrozenRows(1); report.push(name + ':補表頭'); return; }
    var have = data[0].map(String);
    if (have.join(',') === want.join(',')) return;
    var idx = {}; have.forEach(function (h, i) { idx[h] = i; });
    var rows = [];
    for (var r = 1; r < data.length; r++) {
      var old = data[r];
      rows.push(want.map(function (h) {
        if (idx[h] !== undefined) return old[idx[h]];
        if (h === 'location_id') return 'LOC-A';
        if (name === 'supplier' && (h === 'contact_person' || h === 'phone') && idx['contact'] !== undefined) {
          var c = String(old[idx['contact']] || '');
          var m = c.match(/[\d][\d\-() ]{5,}/);
          if (h === 'phone') return m ? m[0].trim() : '';
          return m ? c.replace(m[0], '').trim() : c;
        }
        if (name === 'purchase_line' && h === 'received_qty') {
          return (idx['status'] !== undefined && String(old[idx['status']]) === '已過帳' && idx['qty'] !== undefined) ? old[idx['qty']] : 0;
        }
        return '';
      }));
    }
    sh.clearContents();
    var out = [want].concat(rows);
    sh.getRange(1, 1, out.length, want.length).setValues(out);
    sh.setFrozenRows(1);
    report.push(name + ':升級 ' + rows.length + ' 列');
  });
  // role_permission 存在但空白(只有表頭)→ 種入預設矩陣;已有資料則不動(保留你的調整)
  var rp = ss.getSheetByName('role_permission');
  if (rp && rp.getLastRow() < 2) {
    defaultPermRows_().forEach(function (r) { rp.appendRow(r); });
    report.push('role_permission:種入預設權限矩陣');
  }
  Logger.log(report.join('\n') || '全部已是最新結構');
  return report;
}

function ss_() { return SpreadsheetApp.getActiveSpreadsheet(); }
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
