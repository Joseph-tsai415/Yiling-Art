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

var TABLES = {
  location:         ['location_id','name','type'],
  location_stock:   ['location_id','ingredient_id','safety_stock'],
  ingredient:       ['ingredient_id','name','category','base_unit','purchase_unit','conversion_rate','safety_stock','latest_unit_cost','quote_price','quote_price_pre','tax_rate','shelf_life_days','default_supplier_id','batch_yield'],
  product:          ['product_id','name','type','sale_price','lead_days','default_yield','is_active','location_id'],
  supplier:         ['supplier_id','name','contact_person','phone','email','address','payment_terms'],
  bom:              ['bom_id','product_id','ingredient_id','qty_per_yield'],
  routing:          ['routing_id','product_id','step_no','step_name','duration_min','equipment_id','cross_day'],
  equipment:        ['equipment_id','name','type','count','capacity_per_batch','batch_minutes'],
  category:         ['category_id','name','display_order'],
  staff:            ['staff_id','name','role','active'],
  line:             ['line_id','name'],
  station:          ['station_id','line_id','seq','name','match','staff_id'],
  assignment:       ['assign_id','prod_id','step_no','staff_id','ts'],
  purchase_line:    ['po_id','po_name','ingredient_id','qty','purchase_unit','unit_price','subtotal','supplier_id','order_date','arrival_date','status','location_id','received_qty','tax_rate'],
  production_order: ['prod_id','product_id','plan_qty','start_date','finish_date','status','location_id'],
  plan_draft:       ['line_id','product_id','qty','finish_date','finish_time','staff_id','location_id'],
  po_draft:         ['line_id','ingredient_id','units','unit_price','tax_rate','doc_name','eta','name_ov','eta_ov','location_id'],
  sales_line:       ['so_id','product_id','qty','sale_price','sale_date','idempotency_key','location_id'],
  waste:            ['waste_id','target_type','target_id','qty','reason','date','location_id'],
  stocktake:        ['stocktake_id','target_type','target_id','counted_qty','date','location_id'],
  transfer_order:   ['to_id','from_loc','to_loc','status','request_date','ship_date','receive_date','need_date','urgent'],
  transfer_line:    ['tl_id','to_id','ingredient_id','qty'],
  ingredient_request: ['req_id','location_id','name','spec','weekly_qty','urgent','status','ingredient_id','request_date','done_date'],
  stock_ledger:     ['ledger_id','item_type','item_id','direction','qty','source_type','source_id','unit_cost','txn_date','location_id'],
  user_account:     ['user_id','name','email','role','location_ids','active','created_at','last_login'] // 使用者名單:role=super_admin/…;location_ids=ALL 或 LOC-A|LOC-B(角色權限於後續版本啟用)
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
    ['TL-001','TO-1001','ING-001',25000],
    ['TL-002','TO-1001','ING-021',6000],
    ['TL-003','TO-1002','ING-001',25000],
    ['TL-004','TO-1002','ING-006',5000],
    ['TL-005','TO-1002','ING-003',5000]
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

// ─── 登入驗證 ───
function authEnabled_() { return !!AUTH.CLIENT_ID; }
// token → 工作階段(CacheService,6 小時);無效回 null
function session_(token) {
  if (!token) return null;
  var raw = CacheService.getScriptCache().get('tok:' + token);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (err) { return null; }
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
  CacheService.getScriptCache().put('tok:' + token, JSON.stringify({ email: email, role: String(acc.role || ''), name: String(acc.name || ''), user_id: String(acc.user_id || '') }), 21600);
  try { accountsSheet_().getRange(acc._row, TABLES.user_account.indexOf('last_login') + 1).setValue(Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm')); } catch (err) { }
  return { ok: true, token: token, name: String(acc.name || info.name || ''), email: email, role: String(acc.role || ''), location_ids: String(acc.location_ids || ''), expires_in: 21600 };
}

// ─── 讀取:GET ?action=list&sheet=ingredient&token=… ───
function doGet(e) {
  var action = (e && e.parameter && e.parameter.action) || 'tables';
  var sess = null;
  if (authEnabled_()) {
    sess = session_(e && e.parameter && e.parameter.token);
    if (!sess) return json_({ ok: false, error: 'unauthorized' });
  }
  if (action === 'whoami') return json_(sess ? { ok: true, email: sess.email, name: sess.name, role: sess.role } : { ok: true, role: '', msg: '後端未啟用登入' });
  if (action === 'setup') {
    if (authEnabled_() && sess.role !== 'super_admin') return json_({ ok: false, error: 'forbidden' });
    setup(); return json_({ ok: true, msg: 'setup 完成,已建立 ' + Object.keys(TABLES).length + ' 個分頁' });
  }
  if (action === 'migrate') {
    if (authEnabled_() && sess.role !== 'super_admin') return json_({ ok: false, error: 'forbidden' });
    var rep = migrate(); return json_({ ok: true, msg: rep.length ? rep.join(';') : '全部已是最新結構' });
  }
  if (action === 'list') {
    if (e.parameter.sheet === 'user_account' && authEnabled_() && sess.role !== 'super_admin') return json_({ ok: false, error: 'forbidden' });
    var sh = ss_().getSheetByName(e.parameter.sheet);
    if (!sh) return json_({ ok: false, error: '找不到分頁:' + e.parameter.sheet + '(請先執行 setup)' });
    var tz = Session.getScriptTimeZone();
    var rows = sh.getDataRange().getValues().map(function (r) {
      return r.map(function (v) { return (v instanceof Date) ? Utilities.formatDate(v, tz, 'yyyy-MM-dd') : v; });
    });
    return json_({ ok: true, rows: rows });
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

    if (authEnabled_()) {
      var sess = session_(body.token);
      if (!sess) return json_({ ok: false, error: 'unauthorized' });
      // 使用者名單只有 super_admin 能改(防止一般帳號把自己升權)
      if (body.sheet === 'user_account' && sess.role !== 'super_admin') return json_({ ok: false, error: 'forbidden' });
    }

    // 主資料整表覆寫:{"action":"replace","sheet":"ingredient","headers":[...],"rows":[[...]]}
    if (body.action === 'replace') {
      var shR = ss_().getSheetByName(body.sheet) || ss_().insertSheet(body.sheet);
      shR.clearContents();
      var data = [body.headers].concat(body.rows || []);
      shR.getRange(1, 1, data.length, body.headers.length).setValues(data);
      shR.setFrozenRows(1);
      return json_({ ok: true, replaced: data.length - 1 });
    }

    var sh = ss_().getSheetByName(body.sheet);
    if (!sh) return json_({ ok: false, error: '找不到分頁:' + body.sheet + '(請先執行 setup)' });
    var headers = TABLES[body.sheet] || sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];

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
    return json_({ ok: true, appended: row });
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
  Logger.log(report.join('\n') || '全部已是最新結構');
  return report;
}

function ss_() { return SpreadsheetApp.getActiveSpreadsheet(); }
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
