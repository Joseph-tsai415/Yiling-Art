// Bakery ERP — 單一資料表結構來源(Single source of truth for every sheet's columns).
//
// 前端(db.js 的 SCHEMA、app.js 的 ACC_HEAD/PERM_HEAD)直接 import 本檔;
// 後端 apps-script.js 的 TABLES 由 `npm run gen:schema` 依本檔重新產生(標記區塊之間),
// 所以「改這裡一處」即可,不會再前後端各改一份而漂移(過去 user_account 沒同步的根因)。
//
// 規則(見 CLAUDE.md):任何會持久化資料的新功能都必須在這裡登錄它的表與欄位。

// 每一張表的欄位(順序即 Sheet 欄位順序;第一欄通常為主鍵)。
export const TABLE_COLUMNS = {
  // ── 主資料 / 交易表(前端主同步 pullAll 會拉這些)──
  location:           ['location_id', 'name', 'type'], // type: central | store
  location_stock:     ['location_id', 'ingredient_id', 'safety_stock'],
  ingredient:         ['ingredient_id', 'name', 'category', 'base_unit', 'purchase_unit', 'conversion_rate', 'safety_stock', 'latest_unit_cost', 'quote_price', 'quote_price_pre', 'tax_rate', 'shelf_life_days', 'default_supplier_id', 'batch_yield'],
  product:            ['product_id', 'name', 'type', 'sale_price', 'lead_days', 'default_yield', 'is_active', 'location_id'],
  supplier:           ['supplier_id', 'name', 'contact_person', 'phone', 'email', 'address', 'payment_terms'],
  bom:                ['bom_id', 'product_id', 'ingredient_id', 'qty_per_yield'],
  routing:            ['routing_id', 'product_id', 'step_no', 'step_name', 'duration_min', 'equipment_id', 'cross_day'],
  equipment:          ['equipment_id', 'name', 'type', 'count', 'capacity_per_batch', 'batch_minutes'],
  category:           ['category_id', 'name', 'display_order'],
  staff:              ['staff_id', 'name', 'role', 'active'],
  line:               ['line_id', 'name'],
  station:            ['station_id', 'line_id', 'seq', 'name', 'match', 'staff_id'],
  assignment:         ['assign_id', 'prod_id', 'step_no', 'staff_id', 'ts'],
  purchase_line:      ['po_id', 'po_name', 'ingredient_id', 'qty', 'purchase_unit', 'unit_price', 'subtotal', 'supplier_id', 'order_date', 'arrival_date', 'status', 'location_id', 'received_qty', 'tax_rate'],
  production_order:   ['prod_id', 'product_id', 'plan_qty', 'start_date', 'finish_date', 'status', 'location_id'],
  plan_draft:         ['line_id', 'product_id', 'qty', 'finish_date', 'finish_time', 'staff_id', 'location_id'],
  po_draft:           ['line_id', 'ingredient_id', 'units', 'unit_price', 'tax_rate', 'doc_name', 'eta', 'name_ov', 'eta_ov', 'location_id'],
  sales_line:         ['so_id', 'product_id', 'qty', 'sale_price', 'sale_date', 'idempotency_key', 'location_id'],
  waste:              ['waste_id', 'target_type', 'target_id', 'qty', 'reason', 'date', 'location_id'],
  stocktake:          ['stocktake_id', 'target_type', 'target_id', 'counted_qty', 'date', 'location_id'],
  transfer_order:     ['to_id', 'from_loc', 'to_loc', 'status', 'request_date', 'ship_date', 'receive_date', 'need_date', 'urgent'],
  transfer_line:      ['tl_id', 'to_id', 'item_type', 'item_id', 'qty'],
  ingredient_request: ['req_id', 'location_id', 'name', 'spec', 'weekly_qty', 'urgent', 'status', 'ingredient_id', 'request_date', 'done_date', 'reject_note'],
  stock_ledger:       ['ledger_id', 'item_type', 'item_id', 'direction', 'qty', 'source_type', 'source_id', 'unit_cost', 'txn_date', 'location_id'],

  // ── 帳號 / 權限(super_admin 專用;不在主同步,前端以 loadAccounts 另外讀取)──
  user_account:       ['user_id', 'name', 'email', 'role', 'location_ids', 'active', 'created_at', 'last_login'],
  role_permission:    ['role_id', 'perm_key', 'allow'],

  // ── 稽核日誌(後端專用:登入/登出;不在主同步、前端不讀不顯示;append-only)──
  audit_log:          ['log_id', 'ts', 'user_id', 'email', 'action', 'session_id', 'duration_min'],

  // ── 工作階段(後端專用:每個 session 一列 upsert;不在主同步、前端不讀不顯示)──
  //   線上時間 = (logout_ts || last_seen) − login_ts。last_seen 由 revs 輪詢節流更新(見 apps-script.js),
  //   故即使沒有顯式登出(關分頁/斷線),仍能算出到「最後一次輪詢」為止的線上時間。
  session:            ['session_id', 'user_id', 'email', 'login_ts', 'last_seen', 'logout_ts', 'duration_min', 'active']
};

// 結構指紋:TABLE_COLUMNS 任一表/欄新增或改動即改變。前後端比對此值偵測版本偏移(見前端 staleness guard)。
function _schemaSig(o){ const s = JSON.stringify(Object.keys(o).sort().map(k => [k, o[k]])); let h = 5381; for (let i=0;i<s.length;i++){ h = (h*33 + s.charCodeAt(i)) | 0; } return (h>>>0).toString(36); }
export const SCHEMA_SIG = _schemaSig(TABLE_COLUMNS);

// 每張表的主鍵欄(cell-level updateCell / deleteRow 用來定位列;複合鍵列多欄)。
// 不變式(schema-guard 稽核):每個鍵欄都必須存在於該表的 TABLE_COLUMNS,且能唯一定位一列。
// 前端(db.js 依此組 key)與後端(apps-script.js 的 <<gen:keys>> 由 gen:schema 產生)共用同一份 → 零漂移。
// 注意:cell-level 是「選用」的 —— 只有前端選擇逐格編輯的表才會用到 updateCell;
//   會被整表重寫的草稿表(plan_draft/po_draft)與 append-only 帳本(stock_ledger/sales_line/waste/…)
//   仍走 append / replace,主鍵在此僅供 deleteRow 或未來使用。
export const PRIMARY_KEY = {
  location:           ['location_id'],
  location_stock:     ['location_id', 'ingredient_id'],
  ingredient:         ['ingredient_id'],
  product:            ['product_id'],
  supplier:           ['supplier_id'],
  bom:                ['bom_id'],
  routing:            ['routing_id'],
  equipment:          ['equipment_id'],
  category:           ['category_id'],
  staff:              ['staff_id'],
  line:               ['line_id'],
  station:            ['station_id'],
  assignment:         ['assign_id'],
  purchase_line:      ['po_id', 'ingredient_id'], // 業務鍵(一張採購單一原料一列);若同單同料多列,前端該表改走 replace
  production_order:   ['prod_id'],
  plan_draft:         ['line_id'],
  po_draft:           ['line_id'],
  sales_line:         ['idempotency_key'], // so_id 非唯一;唯一鍵為冪等鍵(append-only,通常不逐格編輯)
  waste:              ['waste_id'],
  stocktake:          ['stocktake_id'],
  transfer_order:     ['to_id'],
  transfer_line:      ['tl_id'],
  ingredient_request: ['req_id'],
  stock_ledger:       ['ledger_id'],
  user_account:       ['user_id'],
  role_permission:    ['role_id', 'perm_key'],
  audit_log:          ['log_id'],
  session:            ['session_id']
};

// 前端主同步(pullAll)拉取的表 = 全部表扣掉帳號/權限這兩張後端專用表.
export const AUTH_TABLES = ['user_account', 'role_permission', 'audit_log', 'session'];
export const SYNC_TABLES = Object.keys(TABLE_COLUMNS).filter(t => AUTH_TABLES.indexOf(t) < 0);

// 無界帳本:刻意不併入 listAll 批次回應(避免撐爆),前端改逐表補拉(見 db.js)。
export const BATCH_EXCLUDE = ['stock_ledger', 'sales_line'];

// 角色權限預設矩陣(單一來源;完整說明見 doc/PERMISSION_ROLE_MAP.md)。
// role_permission 分頁空白時,前端矩陣 UI 與後端 permsOf_ 都依此運作;super_admin 恆為全部,不需列。
// 前端 app.js 直接 import;後端 apps-script.js 的 DEFAULT_PERMS 由 `npm run gen:schema` 產生 <<gen:perms>> 區塊。
export const DEFAULT_PERMS = {
  central_ops: ['screen.setup', 'screen.inventory', 'screen.purchase', 'screen.ingredients', 'screen.locations', 'screen.products', 'screen.suppliers', 'feature.cost'],
  store_admin: ['screen.overview', 'screen.schedule', 'screen.production', 'screen.sales', 'screen.inventory', 'screen.purchase', 'screen.ingredients', 'screen.products', 'screen.staff', 'screen.reports', 'screen.closing'],
  store_kitchen: ['screen.production', 'screen.products'],
  store_front: ['screen.sales']
};

// COST_FIELDS = 成本敏感欄位的「正規清單」(欄名層級)。目前無任何程式消費者 —— 刻意保留為未來
//   IAM 階段「欄位級定價授權」(edit.pricing 允許清單,見 #8 與權限模型筆記)的單一來源。
// 澄清目前實情(勿誤解):
//   • 今天「沒有」任何 feature.cost 寫入閘 —— 寫入一律由 sheet 級 ACL(canWrite_/REPLACE_ACL)+ 地點範圍治理。
//   • 成本「顯示」隱藏走的是較粗的 canCost/feature.cost 閘(app.js),不是逐一比對這份欄名清單。
//   • 切勿重加 feature.cost 寫入 DENY —— 會打斷 store_kitchen 的 finish() 與 store_admin 的原料設定
//     (那些合法角色本就沒有 feature.cost;曾短暫加過後移除)。
// 涵蓋:ingredient 的 latest_unit_cost/quote_price/quote_price_pre/tax_rate,以及任何 unit_cost 欄(帳本/明細)。
export const COST_FIELDS = ['latest_unit_cost', 'quote_price', 'quote_price_pre', 'tax_rate', 'unit_cost'];
