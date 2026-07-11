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
  transfer_line:      ['tl_id', 'to_id', 'ingredient_id', 'qty'],
  ingredient_request: ['req_id', 'location_id', 'name', 'spec', 'weekly_qty', 'urgent', 'status', 'ingredient_id', 'request_date', 'done_date'],
  stock_ledger:       ['ledger_id', 'item_type', 'item_id', 'direction', 'qty', 'source_type', 'source_id', 'unit_cost', 'txn_date', 'location_id'],

  // ── 帳號 / 權限(super_admin 專用;不在主同步,前端以 loadAccounts 另外讀取)──
  user_account:       ['user_id', 'name', 'email', 'role', 'location_ids', 'active', 'created_at', 'last_login'],
  role_permission:    ['role_id', 'perm_key', 'allow']
};

// 前端主同步(pullAll)拉取的表 = 全部表扣掉帳號/權限這兩張後端專用表.
export const AUTH_TABLES = ['user_account', 'role_permission'];
export const SYNC_TABLES = Object.keys(TABLE_COLUMNS).filter(t => AUTH_TABLES.indexOf(t) < 0);
