// Bakery ERP — 資料層(中央倉+多門市;移植自交接包 db2.js,邏輯逐字保留)
// 22 張表 SCHEMA + 示範種子資料 + localStorage 快取;可選 Google Sheets 同步
//(方案 A:Sheets API 直連;方案 B:Apps Script 極薄後端,見 ../apps-script.js)
// 與 v1 差異:
//  1) 所有交易表新增 location_id 欄(LOC-A 本店/LOC-B 大安店/LOC-C 中央倉)— 每筆異動可辨識發生地點
//  2) 新增 location(地點主檔)、transfer_order/transfer_line(叫貨調撥,3 狀態:叫貨→已出貨→已收貨)
//  3) 舊資料(真實快照/本地快取)載入時自動補 location_id=LOC-A(歷史異動皆屬本店)
//  4) 獨立 localStorage 鍵與連線設定;預設「本地模式」,避免把 v2 新結構誤寫進 v1 的 Sheet
import { SEED_OVERRIDE } from './seed-data.js'; // 真實資料庫快照(門市A 歷史資料)
import { TABLE_COLUMNS, SYNC_TABLES, BATCH_EXCLUDE, PRIMARY_KEY, SCHEMA_SIG } from './schema.js'; // 單一資料表結構來源(前後端共用,見 ./schema.js);BATCH_EXCLUDE=不併入 listAll 的無界帳本;PRIMARY_KEY=各表主鍵欄(單格寫入定位列);SCHEMA_SIG=此前端內建的結構指紋(版本偏移守衛)

// SCHEMA = 主同步表(結構單一來源見 ./schema.js);帳號/權限表為後端專用,不在主同步.
export const SCHEMA = Object.fromEntries(SYNC_TABLES.map(t => [t, TABLE_COLUMNS[t]]));

// 中央倉期初庫存 + TO-1001 已出貨的調撥出庫流水(門市快照之外的 LOC-C 資料)
const CENTRAL_LEDGER = `L-9001,ingredient,ING-001,in,80000,stocktake,期初,0.036,2026-07-01,LOC-C
L-9002,ingredient,ING-004,in,6000,stocktake,期初,0.03,2026-07-01,LOC-C
L-9003,ingredient,ING-008,in,4000,stocktake,期初,0.32,2026-07-01,LOC-C
L-9004,ingredient,ING-009,in,12000,stocktake,期初,0.38,2026-07-01,LOC-C
L-9005,ingredient,ING-010,in,10000,stocktake,期初,0.07,2026-07-01,LOC-C
L-9006,ingredient,ING-012,in,8000,stocktake,期初,0.11,2026-07-01,LOC-C
L-9007,ingredient,ING-001,out,25000,transfer_out,TO-1001,0.036,2026-07-03,LOC-C
L-9008,ingredient,ING-010,out,6000,transfer_out,TO-1001,0.07,2026-07-03,LOC-C`;

const SEED = {
location: `location_id,name,type
LOC-C,中央倉,central
LOC-A,信義店,store
LOC-B,大安店,store`,
location_stock: `location_id,ingredient_id,safety_stock
LOC-C,ING-001,30000
LOC-C,ING-003,8000
LOC-C,ING-006,8000
LOC-C,ING-009,2000
LOC-C,ING-021,6000
LOC-A,ING-001,10000
LOC-A,ING-003,3000
LOC-A,ING-006,5000
LOC-A,ING-009,500
LOC-A,ING-014,2000
LOC-A,ING-021,4000
LOC-B,ING-001,8000
LOC-B,ING-003,2000
LOC-B,ING-009,400
LOC-B,ING-014,1500`,
transfer_order: `to_id,from_loc,to_loc,status,request_date,ship_date,receive_date,need_date,urgent
TO-1001,LOC-C,LOC-A,已出貨,2026-07-02,2026-07-03,,2026-07-04,
TO-1002,LOC-C,LOC-B,叫貨,2026-07-04,,,2026-07-05,TRUE`,
ingredient_request: `req_id,location_id,name,spec,weekly_qty,urgent,status,ingredient_id,request_date,done_date
REQ-001,LOC-B,T55 麵粉,法棍用、25kg 袋,40000,TRUE,待處理,,2026-07-04,
REQ-002,LOC-A,抹茶粉,想做抹茶捲,1000,,婉拒,,2026-06-30,2026-07-01`,
transfer_line: `tl_id,to_id,item_type,item_id,qty
TL-001,TO-1001,ingredient,ING-001,25000
TL-002,TO-1001,ingredient,ING-010,6000
TL-003,TO-1002,ingredient,ING-001,25000
TL-004,TO-1002,ingredient,ING-008,5000
TL-005,TO-1002,ingredient,ING-004,5000`,
ingredient: `ingredient_id,name,category,base_unit,purchase_unit,conversion_rate,safety_stock,latest_unit_cost,quote_price,tax_rate,shelf_life_days,default_supplier_id
ING-001,高筋麵粉 T65,麵粉,g,袋,25000,10000,0.035,833,1.05,180,SUP-01
ING-003,細砂糖,糖,g,包,10000,3000,0.028,267,1.05,365,SUP-01
ING-006,無鹽發酵奶油,油脂,g,箱,10000,5000,0.31,2952,1.05,60,SUP-02
ING-009,法國海鹽,鹽,g,包,1000,500,0.09,86,1.05,730,SUP-01
ING-014,魯邦種(老麵),發酵種,g,自製,1,2000,0.015,0,1.0,3,
ING-021,全脂鮮奶,乳品,ml,瓶,1000,4000,0.068,65,1.05,10,SUP-02`,
product: `product_id,name,type,sale_price,lead_days,default_yield,is_active,location_id
PRD-01,魯邦鄉村,bread,45,2,8,TRUE,LOC-A
PRD-02,可頌,bread,55,2,12,TRUE,LOC-A
PRD-03,法國長棍,bread,60,0,10,TRUE,ALL
PRD-04,肉桂捲,dessert,65,0,10,TRUE,LOC-A
PRD-05,佛卡夏,bread,50,0,8,TRUE,LOC-B`,
supplier: `supplier_id,name,contact_person,phone,email,address,payment_terms
SUP-01,統益麵粉行,陳先生,02-2755-3311,order@tongyi.com.tw,台北市萬華區環河南路二段 88 號,月結 30 天
SUP-02,禾豐乳品,林小姐,0912-345-678,,新北市三重區重新路五段 12 號,週結`,
bom: `bom_id,product_id,ingredient_id,qty_per_yield
B-01,PRD-01,ING-001,2800
B-02,PRD-01,ING-014,560
B-03,PRD-01,ING-009,56
B-04,PRD-02,ING-001,1800
B-05,PRD-02,ING-006,1600
B-06,PRD-02,ING-003,300
B-07,PRD-02,ING-021,600
B-08,PRD-03,ING-001,2200
B-09,PRD-03,ING-009,44
B-10,PRD-04,ING-001,1500
B-11,PRD-04,ING-003,450
B-12,PRD-04,ING-006,500
B-13,PRD-05,ING-001,1600
B-14,PRD-05,ING-009,32`,
routing: `routing_id,product_id,step_no,step_name,duration_min,equipment_id,cross_day
R-01,PRD-01,1,攪拌,30,EQ-01,FALSE
R-02,PRD-01,2,一次發酵,90,EQ-02,FALSE
R-03,PRD-01,3,分割整形,40,,FALSE
R-04,PRD-01,4,冷藏發酵,900,EQ-02,TRUE
R-05,PRD-01,5,烘烤,45,EQ-03,FALSE
R-06,PRD-02,1,攪拌,30,EQ-01,FALSE
R-07,PRD-02,2,折疊冷藏,720,,TRUE
R-08,PRD-02,3,整形,40,,FALSE
R-09,PRD-02,4,二次發酵,120,EQ-02,FALSE
R-10,PRD-02,5,烘烤,25,EQ-03,FALSE
R-11,PRD-03,1,攪拌,30,EQ-01,FALSE
R-12,PRD-03,2,一次發酵,90,EQ-02,FALSE
R-13,PRD-03,3,整形,30,,FALSE
R-14,PRD-03,4,二次發酵,60,EQ-02,FALSE
R-15,PRD-03,5,烘烤,25,EQ-03,FALSE
R-16,PRD-04,1,攪拌,20,EQ-01,FALSE
R-17,PRD-04,2,一次發酵,60,EQ-02,FALSE
R-18,PRD-04,3,整形捲製,30,,FALSE
R-19,PRD-04,4,二次發酵,40,EQ-02,FALSE
R-20,PRD-04,5,烘烤,20,EQ-03,FALSE
R-21,PRD-05,1,攪拌,20,EQ-01,FALSE
R-22,PRD-05,2,一次發酵,90,EQ-02,FALSE
R-23,PRD-05,3,整形,20,,FALSE
R-24,PRD-05,4,烘烤,20,EQ-03,FALSE`,
equipment: `equipment_id,name,type,count,capacity_per_batch,batch_minutes
EQ-01,螺旋攪拌機,mixer,1,15 kg 麵團,30
EQ-02,發酵箱,proofer,2,16 盤,
EQ-03,層爐烤箱,oven,2,4 盤,45`,
category: `category_id,name,display_order
CAT-01,麵粉,1
CAT-02,糖,2
CAT-03,油脂,3
CAT-04,乳品,4
CAT-05,蛋,5
CAT-06,鹽,6
CAT-07,發酵種,7
CAT-08,堅果果乾,8
CAT-09,包材,9
CAT-10,其他,10`,
line: `line_id,name
LINE-01,麵包流水線
LINE-02,餐食流水線`,
station: `station_id,line_id,seq,name,match,staff_id
ST-01,LINE-01,1,攪拌,攪拌|拌合|餵養,
ST-02,LINE-01,2,開酥,開酥|鬆弛,
ST-03,LINE-01,3,發酵,發酵|熟成|冷藏定型,
ST-04,LINE-01,4,整形,整形|分割|捲製,
ST-05,LINE-01,5,烘烤,烘烤|烤,
ST-06,LINE-02,1,備料,備料|洗切|處理,
ST-07,LINE-02,2,烹調,煮|炒|烹|燉|煒,
ST-08,LINE-02,3,組裝,組裝|擺盤|包裝,
ST-09,LINE-02,4,出餐,出餐|保溫,`,
staff: `staff_id,name,role,active
EMP-01,林店長,店長/排程,TRUE
EMP-02,陳阿明,攪拌備料,TRUE
EMP-03,王小華,整形發酵,TRUE
EMP-04,張師傅,烤爐,TRUE`,
assignment: `assign_id,prod_id,step_no,staff_id,ts`,
purchase_line: `po_id,po_name,ingredient_id,qty,purchase_unit,unit_price,subtotal,supplier_id,order_date,arrival_date,status,location_id,received_qty
PO-0127,週初麵粉鮮奶,ING-001,1,袋,875,875,SUP-01,2026-06-30,2026-07-01,已到貨,LOC-A,1
PO-0127,週初麵粉鮮奶,ING-021,6,瓶,68,408,SUP-02,2026-06-30,2026-07-01,已到貨,LOC-A,6
PO-0201,糖補貨,ING-003,2,包,275,550,SUP-01,2026-07-04,2026-07-05,已下單,LOC-C,0`,
production_order: `prod_id,product_id,plan_qty,start_date,finish_date,status,location_id
P-0328,PRD-01,24,2026-06-29,2026-07-01,完成,LOC-A
P-0329,PRD-03,42,2026-07-01,2026-07-01,完成,LOC-A
P-0330,PRD-02,60,2026-06-30,2026-07-02,完成,LOC-A
P-0331,PRD-01,24,2026-07-01,2026-07-03,投料,LOC-A
P-0332,PRD-03,40,2026-07-02,2026-07-02,投料,LOC-A
P-0333,PRD-01,32,2026-07-02,2026-07-04,投料,LOC-A
P-0334,PRD-04,30,2026-07-02,2026-07-02,草稿,LOC-A`,
sales_line: `so_id,product_id,qty,sale_price,sale_date,idempotency_key,location_id
SO-0995,PRD-02,40,55,2026-07-01,seed-7,LOC-A
SO-0996,PRD-03,25,60,2026-07-01,seed-8,LOC-A
SO-1001,PRD-02,46,55,2026-07-02,seed-10,LOC-A
SO-1002,PRD-01,21,45,2026-07-02,seed-11,LOC-A`,
waste: `waste_id,target_type,target_id,qty,reason,date,location_id
W-001,product,PRD-02,4,賣剩,2026-06-29,LOC-A
W-002,product,PRD-03,2,生產失敗,2026-07-01,LOC-A
W-003,product,PRD-02,2,賣剩,2026-07-02,LOC-A`,
stocktake: `stocktake_id,target_type,target_id,counted_qty,date,location_id`,
stock_ledger: `ledger_id,item_type,item_id,direction,qty,source_type,source_id,unit_cost,txn_date,location_id
L-0001,ingredient,ING-006,in,12500,stocktake,期初,0.31,2026-06-28,LOC-A
L-0002,ingredient,ING-009,in,1000,stocktake,期初,0.09,2026-06-28,LOC-A
L-0003,ingredient,ING-003,in,8000,stocktake,期初,0.028,2026-06-28,LOC-A
L-0004,ingredient,ING-014,in,4000,stocktake,期初,0.015,2026-06-29,LOC-A
L-0006,ingredient,ING-001,in,25000,purchase,PO-0127,0.035,2026-07-01,LOC-A
L-0007,ingredient,ING-021,in,6000,purchase,PO-0127,0.068,2026-07-01,LOC-A
L-0008,product,PRD-01,in,24,production_in,P-0328,13.9,2026-07-01,LOC-A`
};

const KEY = 'bakery_proto_csv_v2';
const CFG_KEY = 'bakery_remote_cfg_v2';
const MODE_KEY = 'bakery_api_mode_v2';
const AUTH_KEY = 'bakery_auth_v1'; // {token, name, email, role} — GAS 後端核發的工作階段;存 sessionStorage:同分頁重新整理免重登(仍會 whoami 重驗),關閉分頁即需重新登入
const GBASE = 'https://sheets.googleapis.com/v4/spreadsheets';
// 整表覆寫(replace)遠端寫入的防抖窗:連打時多次 keystroke 併成一次寫入(本地 this.t 仍每鍵即時更新,輸入不受影響)。
// 與 app.js 既有的 plan/po/帳號防抖(800ms)同節奏;真正杜絕「自我 conflict」的是串行化(每表最多一個 in-flight),防抖只是減少寫入次數。
const REPLACE_DEBOUNCE = 600;
// 單格寫入(cell-level CAS)參數:每格連打防抖 500ms;全域併發上限(不同格可並行,防洪泛)。
const CELL_DEBOUNCE = 500;
const CELL_MAX_INFLIGHT = 5;
// Sheet 會把日期時間字串轉成 1899 基準序號 → 寫入前對「日期+時間」與「純時間(15:30)」加前置單引號存成文字(日期單獨值不受影響)。
// replace 與 updateCell 兩條寫入路徑共用此規則(勿各自複寫,避免漂移)。
const quoteDT = v => typeof v === 'string' && (/^\d{4}-\d{2}-\d{2}[T ]\d{1,2}:\d{2}/.test(v) || /^\d{1,2}:\d{2}$/.test(v)) ? "'" + v : v;
// 背景版號輪詢間隔(30–60s 取中);tab 隱藏 / 離線 / 非雲端 / 未登入 / 後端無 'revs' 能力時暫停。
const REV_POLL_MS = 45000;
// Sheet 讀回值正規化:日期序列 / ISO 時戳 → 'YYYY-MM-DD'(或 'YYYY-MM-DD HH:MM');其餘原樣。
// pullAll 與背景合併(_listObjects)共用同一份 → 兩條讀取路徑正規化一致,單格 CAS 的 old 比對不會漂移。
const normCell = c => {
  const s = String(c);
  let m = /^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/.exec(s);
  if (m) return m[1] + '-' + String(m[2]).padStart(2, '0') + '-' + String(m[3]).padStart(2, '0');
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) {
    if (/Z$/.test(s) || /\.\d{3}/.test(s)) {
      const d = new Date(s);
      if (!isNaN(d)) {
        const p = n => String(n).padStart(2, '0');
        const ds = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
        const t = p(d.getHours()) + ':' + p(d.getMinutes());
        return t === '00:00' ? ds : ds + ' ' + t;
      }
    }
    return s.slice(0, 10) + ' ' + s.slice(11, 16);
  }
  return c;
};
// v2 結構需搭配 v2 版 apps-script.js(TABLES 含 location_id 與調撥表);
// 既有 Sheet 升級:貼新腳本 → 執行 setup → 部署新版本(/exec 網址不變)。
// 預設 /exec 網址由部署注入(window.BAKERY_CFG)或 google-config.local.js 提供;佔位符視為未設定。
const DEFAULT_GAS_URL = (() => {
  const u = (typeof window !== 'undefined' && window.BAKERY_CFG && window.BAKERY_CFG.gasUrl) || '';
  return /^__[A-Z_]+__$/.test(u) ? '' : u;
})();

export function parseCSV(text) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (ch !== '\r') cur += ch;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows.filter(r => r.some(c => c !== ''));
}

function esc(v) {
  const s = v === undefined || v === null ? '' : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export function toObjects(rows) {
  if (!rows.length) return [];
  const h = rows[0];
  return rows.slice(1).map(r => { const o = {}; h.forEach((k, i) => o[k] = r[i] === undefined ? '' : r[i]); return o; });
}

// 舊結構 CSV → 依 SCHEMA 補欄(缺 location_id 一律視為本店 LOC-A;其他缺欄補空字串)
function migrateCSV(name, csv) {
  const want = SCHEMA[name];
  if (!csv) return want.join(',');
  const rows = parseCSV(csv);
  if (!rows.length) return want.join(',');
  const header = rows[0];
  if (header.join(',') === want.join(',')) return csv;
  const idx = {}; header.forEach((h, i) => { idx[h] = i; });
  const out = [want.join(',')];
  for (let i = 1; i < rows.length; i++) {
    out.push(want.map(h => {
      if (idx[h] !== undefined) return esc(rows[i][idx[h]]);
      if (h === 'location_id') return 'LOC-A';
      // ingredient 舊欄 category 若改名 category_id → 直接沿用(值為 CAT-xx,前端自動解析)
      if (h === 'category' && idx['category_id'] !== undefined) return esc(rows[i][idx['category_id']]);
      // 舊 supplier.contact(「02-xxx 陳先生」混合欄)→ 拆進新欄:電話歸 phone,其餘歸聯絡人
      if ((h === 'contact_person' || h === 'phone') && idx['contact'] !== undefined) {
        const c = String(rows[i][idx['contact']] || '');
        const m = c.match(/[\d][\d\-() ]{5,}/);
        if (h === 'phone') return esc(m ? m[0].trim() : '');
        return esc(m ? c.replace(m[0], '').trim() : c.trim());
      }
      return '';
    }).join(','));
  }
  return out.join('\n');
}

// 組合示範資料:基礎 SEED ← 真實快照覆蓋 → 逐表補 location_id → 附加中央倉流水
function buildSeed() {
  const all = Object.assign({}, SEED, typeof SEED_OVERRIDE === 'object' && SEED_OVERRIDE ? SEED_OVERRIDE : {});
  for (const k of Object.keys(SCHEMA)) all[k] = migrateCSV(k, all[k]);
  // 舊快照沒有報價欄 → 從最新單價推算(視為含稅價),稅率預設 1.05(自製 1.0、報價 0)
  const ingR = toObjects(parseCSV(all.ingredient));
  if (ingR.length && ingR.some(r => r.quote_price === '' || r.quote_price === undefined)) {
    const hdr = SCHEMA.ingredient;
    const out = [hdr.join(',')];
    for (const r of ingR) {
      if (r.quote_price === '' || r.quote_price === undefined) {
        const selfMade = r.purchase_unit === '自製' || !r.default_supplier_id;
        const conv = parseFloat(r.conversion_rate) || 1, luc = parseFloat(r.latest_unit_cost) || 0;
        r.tax_rate = r.tax_rate || (selfMade ? '1.0' : '1.05');
        r.quote_price = selfMade ? '0' : String(Math.round(luc * conv / (parseFloat(r.tax_rate) || 1)));
      }
      out.push(hdr.map(h => esc(r[h] === undefined ? '' : r[h])).join(','));
    }
    all.ingredient = out.join('\n');
  }
  all.stock_ledger = all.stock_ledger.replace(/\n+$/, '') + '\n' + CENTRAL_LEDGER;
  return all;
}

export class DB {
  constructor() {
    this.mode = 'local';
    this.cfg = { kind: 'gas', url: DEFAULT_GAS_URL, sid: '', apiKey: '', clientId: '' };
    try {
      const c = JSON.parse(localStorage.getItem(CFG_KEY) || 'null');
      if (c) this.cfg = Object.assign(this.cfg, c);
      const storedMode = localStorage.getItem(MODE_KEY);
      // 這個裝置做過選擇 → 尊重;沒選過 → 有 GAS 網址(部署注入/本機設定)就自動連線 方案 B,
      // 沒有任何連線設定才落到本地示範模式。「切回本地示範」會存 'local',之後不再自動連。
      this.mode = storedMode
        ? (storedMode === 'cloud' ? 'cloud' : 'local')
        : (this.cfg.kind === 'gas' && this.cfg.url ? 'cloud' : 'local');
    } catch (e) { }
    this.token = null; this.tokenExp = 0; this._tc = null; this._tcb = null; this._teb = null;
    this.pending = 0;
    this.onRemote = null; // (ok, msg) => void
    this.rev = {};        // 每張表的樂觀鎖版本號(list 讀入 / 寫入回應更新);replace 帶 baseRev 給後端比對
    this._repQ = {};      // 每張表整表覆寫的串行化佇列:{payload, pending, inflight, timer} — 見 _enqueueReplace/_drainReplace
    this.onConflict = null; // (sheet) => void:整表覆寫因他人先改而被拒(conflict)時通知上層重載
    this._cellQ = {};      // 單格寫入佇列:cellId -> {sheet,key,field,base,latest,sent,inflight,dirty,timer} — 見 _enqueueCell/_drainCell
    this._cellInflight = 0; // 目前進行中的 updateCell 數(併發上限用)
    this.caps = new Set(); // 後端能力集(pullAll 的 listAll 回傳 caps);含 'updateCell' 才走單格路徑,否則退回整表 replace
    this.onCellConflict = null; // (info) => void:單格衝突/列不存在/無權 — 只刷新該列/欄並提示,取代整表重載
    this.onRefresh = null; // (changedSheets[]) => void:背景版號輪詢合併後通知上層重繪(合併已保留正在編輯的欄位)
    this._revTimer = null; this._revStarted = false; // 背景輪詢:計時器 + 是否已啟動(見 startRevPoll/_pollRevs)
    this._revWake = () => this._scheduleRevPoll(true); // visibilitychange(回前景)/online/offline → 重新評估;喚醒時立即補一輪
    this.lastPullError = null; // pullAll 失敗型態:'auth'(工作階段過期)/ 'network'(整趟都沒連上可運作後端)/ null(後端有回應);呼叫端據此決定是否 migrate
    this._batchUnsupported = false; // 能力快取:此後端已確認不支援 action=listAll → 之後直接逐表,不再探測
    // 版本偏移守衛:後端回應的 ver(=SCHEMA_SIG 指紋)與此前端內建 SCHEMA_SIG 不符 → 前端是舊快取,擋掉所有整表/單格寫入(避免舊結構 replace 砍掉新欄),交由上層 banner + cache-bust 重載
    this.stale = false; this.staleVer = ''; this._verOk = false;
    this.onStale = null; // (ver) => void:首次偵測到版本偏移 → 上層顯示 banner 並排程重載
    this.onFresh = null; // () => void:版本一致(重載成功後)→ 上層清除重載迴圈守衛
    // 頁面卸載/切到背景前,把還在防抖窗、尚未送出的整表覆寫立刻補送(否則重載後 pullAll 會用 Sheet 覆蓋本地 → 防抖窗內的最後編輯遺失)。
    // 用 pagehide + visibilitychange(hidden)—— 較 beforeunload 可靠且不破壞 bfcache;keepalive 讓請求能存活到卸載後。
    if (typeof window !== 'undefined') {
      const flush = () => this.flushWrites();
      window.addEventListener('pagehide', flush);
      if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
    }
    this.load();
  }

  // ── 連線設定 ──
  saveCfg(patch) { this.cfg = Object.assign({}, this.cfg, patch); try { localStorage.setItem(CFG_KEY, JSON.stringify(this.cfg)); } catch (e) { } }
  setCloud() { this.mode = 'cloud'; try { localStorage.setItem(MODE_KEY, 'cloud'); } catch (e) { } }
  setLocal() { this.mode = 'local'; try { localStorage.setItem(MODE_KEY, 'local'); } catch (e) { } }

  // ── 登入工作階段(Google Sign-In → GAS 後端核發 token;後端逐請求驗證)──
  getAuth() { try { return JSON.parse(sessionStorage.getItem(AUTH_KEY) || 'null'); } catch (e) { return null; } }
  setAuth(a) { try { sessionStorage.setItem(AUTH_KEY, JSON.stringify(a)); } catch (e) { } }
  clearAuth() { try { sessionStorage.removeItem(AUTH_KEY); localStorage.removeItem(AUTH_KEY); } catch (e) { } } // 也清舊版存在 localStorage 的 token
  authToken() { const a = this.getAuth(); return (a && a.token) || ''; }
  // 登出稽核(後端記錄登出時間 + 計算在線時長)。全程 best-effort:不阻塞 UI、離線/失敗即忽略。
  logout() { // 明確登出:fire-and-forget POST(keepalive),沿用既有 action POST 路徑
    if (this.mode !== 'cloud') return; const tok = this.authToken(); if (!tok) return;
    try { fetch(this.cfg.url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ action: 'logout', token: tok }), keepalive: true }).catch(() => { }); } catch (e) { }
  }
  logoutBeacon() { // 分頁關閉時盡力送出:sendBeacon + text/plain blob(後端由 e.postData.contents 讀取)
    if (this.mode !== 'cloud') return; const tok = this.authToken(); if (!tok) return;
    try { const b = new Blob([JSON.stringify({ action: 'logout', token: tok })], { type: 'text/plain;charset=utf-8' }); if (navigator.sendBeacon) navigator.sendBeacon(this.cfg.url, b); } catch (e) { }
  }
  // 版本偏移守衛:比對後端回應的 ver 與此前端內建 SCHEMA_SIG。ver 缺席(舊後端)= 視為不偏移(向後相容)。
  checkVer(resp) {
    if (!resp || !resp.ver) return;
    if (resp.ver === SCHEMA_SIG) { // 版本一致(常見/重載成功後)→ 清 stale;首次一致時通知上層清重載守衛
      this.stale = false; this.staleVer = '';
      if (!this._verOk) { this._verOk = true; if (this.onFresh) this.onFresh(); }
      return;
    }
    const first = !this.stale || this.staleVer !== resp.ver; // 每個新版本只通知一次(避免每輪輪詢重複 banner/重載)
    this.stale = true; this.staleVer = resp.ver;
    if (first && this.onStale) this.onStale(resp.ver);
  }
  // 寫入閘門:偏移時擋掉遠端寫入(讀取/輪詢照舊),並提示重新整理。回 true = 已擋。
  _blockWrite() {
    if (!this.stale) return false;
    if (this.onRemote) this.onRemote(false, '系統已更新,請重新整理');
    return true;
  }
  // Google ID token → 後端驗證+比對 user_account 名單 → 核發工作階段 token
  async login(credential) {
    const r = await fetch(this.cfg.url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ action: 'login', credential }) });
    return await r.json();
  }
  async whoami() { const j = await this.api('action=whoami'); if (j && Array.isArray(j.caps)) this.caps = new Set(j.caps); this.checkVer(j); return j; } // caps 也可能來自 whoami(與 listAll 一致);ver 偏移守衛

  // ── 方案 B:Apps Script ──
  async api(params) {
    const t = this.authToken();
    const r = await fetch(this.cfg.url + (this.cfg.url.indexOf('?') >= 0 ? '&' : '?') + params + (t ? '&token=' + encodeURIComponent(t) : ''));
    const j = await r.json();
    if (j && j.ok === false && j.error === 'unauthorized' && this.onAuthFail) this.onAuthFail();
    return j;
  }

  // ── 方案 A:Google Sheets API 直連(讀=API Key、寫=OAuth)──
  async ensureToken(prompt) {
    if (this.token && Date.now() < this.tokenExp - 60000) return this.token;
    if (!(window.google && window.google.accounts && window.google.accounts.oauth2)) throw 'Google 登入元件未載入(檢查網路後重整頁面)';
    if (!this.cfg.clientId) throw '缺 Client ID';
    return await new Promise((res, rej) => {
      try {
        if (!this._tc) this._tc = window.google.accounts.oauth2.initTokenClient({
          client_id: this.cfg.clientId,
          scope: 'https://www.googleapis.com/auth/spreadsheets',
          callback: r => { if (this._tcb) this._tcb(r); },
          error_callback: e => { if (this._teb) this._teb(e); }
        });
        this._tcb = r => {
          if (r && r.access_token) { this.token = r.access_token; this.tokenExp = Date.now() + (Number(r.expires_in) || 3600) * 1000; res(this.token); }
          else rej((r && (r.error_description || r.error)) || '授權被拒');
        };
        this._teb = e => rej((e && (e.message || e.type)) || '授權視窗開啟失敗');
        this._tc.requestAccessToken({ prompt: prompt || '' });
      } catch (err) { rej(String(err)); }
    });
  }
  gh() { return { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + this.token }; }
  async gapiList(name) {
    const h = this.token ? { Authorization: 'Bearer ' + this.token } : {};
    const j = await (await fetch(GBASE + '/' + this.cfg.sid + '/values/' + encodeURIComponent(name) + '?key=' + encodeURIComponent(this.cfg.apiKey), { headers: h })).json();
    if (j.error) return null;
    return j.values || null;
  }
  async gapiEnsureTabs() {
    await this.ensureToken();
    const meta = await (await fetch(GBASE + '/' + this.cfg.sid + '?fields=sheets.properties.title', { headers: { Authorization: 'Bearer ' + this.token } })).json();
    if (meta.error) throw meta.error.message;
    const have = (meta.sheets || []).map(s => s.properties.title);
    const toAdd = Object.keys(SCHEMA).filter(n => have.indexOf(n) < 0);
    if (toAdd.length) {
      const j = await (await fetch(GBASE + '/' + this.cfg.sid + ':batchUpdate', { method: 'POST', headers: this.gh(), body: JSON.stringify({ requests: toAdd.map(t => ({ addSheet: { properties: { title: t } } })) }) })).json();
      if (j.error) throw j.error.message;
    }
    return toAdd;
  }
  async gapiWriteTable(name) {
    await this.ensureToken();
    const rows = [SCHEMA[name]].concat(this.t[name].map(r => SCHEMA[name].map(h => r[h] === undefined ? '' : r[h])));
    let j = await (await fetch(GBASE + '/' + this.cfg.sid + '/values/' + encodeURIComponent(name) + '!A1:ZZ:clear', { method: 'POST', headers: this.gh(), body: '{}' })).json();
    if (j.error) throw name + ' 清空失敗:' + j.error.message;
    j = await (await fetch(GBASE + '/' + this.cfg.sid + '/values/' + encodeURIComponent(name) + '!A1?valueInputOption=RAW', { method: 'PUT', headers: this.gh(), body: JSON.stringify({ values: rows }) })).json();
    if (j.error) throw name + ' 寫入失敗:' + j.error.message;
  }
  async gapiPushAll() {
    await this.gapiEnsureTabs();
    for (const n of Object.keys(SCHEMA)) await this.gapiWriteTable(n);
  }
  async pullAll() {
    const names = Object.keys(SCHEMA);
    this.lastPullError = null; // 每次重置;呼叫端讀取以區分 auth / network(沒連上後端)/ 結構缺分頁(null)
    const norm = normCell; // 讀回值正規化(模組層單一定義,與背景合併共用)
    let results;
    if (this.cfg.kind === 'gapi') {
      results = await Promise.all(names.map(n => this.gapiList(n).catch(() => null)));
    } else {
      // 方案 B:先試一次 listAll(單一往返,取代逐表 24 個 list 請求);後端太舊/失敗才回退逐表.
      // reached = 這趟是否真的碰到「可運作的後端」(收到可解析、含布林 ok 的 JSON);用來把
      // 「沒連上」(network,不該 migrate)和「後端有回應但分頁真的不存在」(結構缺,該 migrate)分開.
      let reached = false;
      // 逐表 list(可指定子集,預設全部);回傳與 list 對齊的 rows(失敗→null)並更新 rev.
      // 只要拿到可解析的 j(即使是 {ok:false,'找不到分頁'})就算碰到後端 → reached=true.
      const listSome = list => Promise.all(list.map(n => this.api('action=list&sheet=' + n)
        .then(j => { if (j) reached = true; if (j && j.ok && j.rev != null) this.rev[n] = j.rev; return (j && j.ok) ? j.rows : null; })
        .catch(() => null)));
      // 能力快取:先前已確認此後端不支援 listAll(正向舊後端回應)→ 不再探測,直接逐表.
      const batch = this._batchUnsupported ? null : await this.api('action=listAll').catch(() => null);
      this.checkVer(batch); // ver 偏移守衛(listAll 回應帶 ver)
      if (batch && batch.ok && batch.sheets && !Array.isArray(batch.sheets)) {
        // 新後端:一次拿到所有分頁 {sheet:{rows,rev}};缺的分頁(後端略過)→ null → 列為 missing
        reached = true;
        if (Array.isArray(batch.caps)) this.caps = new Set(batch.caps); // 後端能力:含 updateCell/deleteRow 才走單格路徑(否則 setField 退回整表 replace)
        results = names.map(n => {
          const t = batch.sheets[n];
          if (!t) return null;
          // 有 rows 但缺 rev:清掉舊版號,避免套用新 rows 卻留著過期 rev → 下次存檔誤判 conflict
          if (t.rev != null) this.rev[n] = t.rev; else delete this.rev[n];
          return t.rows;
        });
        // 無界帳本(BATCH_EXCLUDE)後端刻意排除於 listAll(防回應撐爆)→ 一律逐表補拉,依名稱併回 results
        const excluded = names.filter(n => BATCH_EXCLUDE.indexOf(n) >= 0);
        if (excluded.length) {
          const exRows = await listSome(excluded);
          excluded.forEach((n, i) => { results[names.indexOf(n)] = exRows[i]; });
        }
      } else if (batch && batch.ok === false) {
        // 後端有回應但拒絕(unauthorized 等)— api() 已觸發 onAuthFail;記下 auth 訊號讓呼叫端別再 migrate/重拉
        reached = true;
        this.lastPullError = 'auth';
        results = names.map(() => null);
      } else {
        // 舊後端(未知 action 回 {ok:true, tables:[...]},無 sheets)或連線失敗(batch===null)→ 回退逐表 list.
        // 只有「正向舊後端回應」才算碰到後端並快取不支援旗標;batch===null 可能只是暫時斷線,不可快取.
        if (batch && batch.ok && !batch.sheets) { reached = true; this._batchUnsupported = true; }
        console.warn('[bakery] listAll batch unavailable, falling back to per-sheet', this._batchUnsupported ? '(old backend: no listAll)' : '(no/invalid batch response)');
        results = await listSome(names); // listSome 內若任一 j 可解析 → reached=true
      }
      // 整趟都沒碰到可運作後端(且非 auth)→ 連線/傳輸問題,呼叫端據此略過必失敗的 migrate
      if (this.lastPullError !== 'auth' && !reached) this.lastPullError = 'network';
    }
    const missing = [];
    names.forEach((n, i) => {
      const rows = results[i];
      // location 僅表頭視為缺(舊/未初始化的 Sheet)— 保留本地,否則多地點模型整個失效
      const min = n === 'location' ? 1 : 0;
      if (rows && rows.length > min) {
        this.raw[n] = migrateCSV(n, rows.map(r => r.map(c => esc(norm(c === null || c === undefined ? '' : String(c)))).join(',')).join('\n'));
      } else missing.push(n);
    });
    this.parseAll(); this.ensureCentral(); this.persist();
    return missing;
  }
  // 遠端寫入入口:整表覆寫(replace)走串行化 + 合併佇列(見 _enqueueReplace),杜絕連打時多個 replace 帶同一
  // baseRev 併發送出 → 後端只收第一個、其餘全 conflict → 前端重載把使用者正在編輯的值打回 Sheet 版本(本 bug 根因)。
  // append 逐列即時送(順序重要,不併);非雲端一律略過(_send 亦再自保一次)。
  sendRemote(payload) {
    if (this.mode !== 'cloud') return;
    if (this._blockWrite()) return; // 版本偏移 → 擋 replace/append,避免舊結構整表覆寫砍欄
    if (payload.action === 'replace' && payload.sheet) { this._enqueueReplace(payload); return; }
    this._send(payload);
  }
  // 每張表同時最多一個 in-flight 的整表覆寫;進行中就只記「還要再送」+ 保留最新 payload,回應返回後才送下一個
  // (帶當下最新的 this.rev[sheet])→ 使用者自己的快速編輯不再互撞成假 conflict。連打在防抖窗(REPLACE_DEBOUNCE)內併成最後狀態。
  _enqueueReplace(payload) {
    const s = payload.sheet;
    const st = this._repQ[s] || (this._repQ[s] = { payload: null, pending: false, inflight: false, timer: null });
    st.payload = payload; st.pending = true; // 只留最新 payload(帳號/權限等非 SCHEMA 表用它帶來的 rows)
    if (st.inflight) return;                 // 進行中 → 回應後自動 drain 最新,不另起計時
    clearTimeout(st.timer);
    st.timer = setTimeout(() => this._drainReplace(s), REPLACE_DEBOUNCE);
  }
  _drainReplace(s, keepalive) {
    const st = this._repQ[s];
    if (!st || st.inflight || !st.pending) return;
    if (this._blockWrite()) return; // 版本偏移:已排隊的整表覆寫也不得送(防抖到期/flushWrites 卸載補送)— 保留待送,重載後由 pullAll 丟棄
    st.inflight = true; st.pending = false;
    const payload = st.payload; st.payload = null;
    // SCHEMA 表在「送出當下」用最新本地狀態重建 rows:併掉這段期間的 append/連續編輯,
    // 避免被防抖延後的覆寫用過期 rows 蓋掉剛 append 進去的列(append 會即時送並讓 this.rev 追上)。
    if (SCHEMA[s]) payload.rows = this.t[s].map(r => SCHEMA[s].map(h => r[h] === undefined ? '' : r[h]));
    this._send(payload, (ok, msg, conflict) => {
      st.inflight = false; // 送出完成(成功/失敗/衝突皆算)
      // 真.他人衝突 → 交給 onConflict 重載最新版,清掉待送佇列,別用舊本地狀態回沖蓋掉別人的變更。
      // 一般網路失敗則保留待送:this.t 仍是最新,還在打字就再排一次,否則下次編輯自然帶出補送。
      if (conflict) { st.pending = false; st.payload = null; return; }
      if (st.pending) { clearTimeout(st.timer); st.timer = setTimeout(() => this._drainReplace(s), REPLACE_DEBOUNCE); }
    }, keepalive);
  }
  // 卸載/切背景前的補送:把每張表「已排隊但尚未送出(pending 且非 in-flight)」的整表覆寫立刻以 keepalive 送出。
  // in-flight 的請求位元多半已送達後端,不需補;pending 才是只存在本地、重載會被 pullAll 覆蓋掉的風險點。
  flushWrites() {
    if (this.mode !== 'cloud') return;
    Object.keys(this._repQ).forEach(s => {
      const st = this._repQ[s];
      if (st && st.pending && !st.inflight) { clearTimeout(st.timer); this._drainReplace(s, true); }
    });
    // 單格佇列:把還沒送出(非 in-flight、仍有淨變化)的也以 keepalive 補送
    Object.keys(this._cellQ).forEach(id => {
      const e = this._cellQ[id];
      if (e && !e.inflight && e.base !== e.latest) { clearTimeout(e.timer); this._drainCell(id, true); }
    });
  }
  // 實際送出一次遠端寫入;after(ok,msg) 於回應返回(或提早失敗)後呼叫,供覆寫佇列釋放 in-flight。
  // keepalive=true(卸載補送)讓請求能存活到頁面卸載後(URL 模式;body 上限 64KB,主資料表足夠)。
  _send(payload, after, keepalive) {
    if (this.mode !== 'cloud') { if (after) after(false, ''); return; }
    const q = quoteDT; // 日期時間加引號規則(模組層單一定義,與 updateCell 路徑共用)
    if (payload.row) { const r = {}; Object.keys(payload.row).forEach(k => r[k] = q(payload.row[k])); payload = Object.assign({}, payload, { row: r }); }
    if (payload.rows) payload = Object.assign({}, payload, { rows: payload.rows.map(row => Array.isArray(row) ? row.map(q) : row) });
    this.pending++;
    const done = (ok, msg, conflict) => { this.pending--; if (this.onRemote) this.onRemote(ok, msg || ''); if (after) after(ok, msg, !!conflict); };
    if (this.cfg.kind === 'gapi') {
      (async () => {
        await this.ensureToken();
        if (payload.action === 'append') {
          const row = SCHEMA[payload.sheet].map(h => payload.row[h] === undefined ? '' : payload.row[h]);
          const j = await (await fetch(GBASE + '/' + this.cfg.sid + '/values/' + encodeURIComponent(payload.sheet) + '!A1:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS', { method: 'POST', headers: this.gh(), body: JSON.stringify({ values: [row] }) })).json();
          if (j.error) throw j.error.message;
        } else if (payload.action === 'replace') {
          await this.gapiWriteTable(payload.sheet);
        }
      })().then(() => done(true)).catch(err => done(false, 'Sheet 寫入失敗(' + payload.sheet + '):' + err));
      return;
    }
    if (!this.cfg.url) { this.pending--; if (after) after(false, ''); return; }
    const tok = this.authToken();
    const sheet = payload.sheet;
    // 樂觀鎖:整表覆寫帶上本地版號給後端比對(舊後端沒這功能會忽略,行為不變)
    if (payload.action === 'replace' && this.rev[sheet] != null) payload = Object.assign({}, payload, { baseRev: this.rev[sheet] });
    if (tok) payload = Object.assign({}, payload, { token: tok });
    fetch(this.cfg.url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payload), keepalive: !!keepalive })
      .then(r => r.json())
      .then(j => {
        if (j && j.error === 'unauthorized' && this.onAuthFail) this.onAuthFail();
        if (j && j.rev != null && sheet) this.rev[sheet] = j.rev; // 追上最新版號(成功寫入或 conflict 都會回傳目前版號)
        if (j && j.error === 'conflict') { done(false, '⚠ 資料已被他人更新,正在載入最新版 — 請重做剛才的變更', true); if (this.onConflict) this.onConflict(sheet); return; }
        done(!!j.ok, j.ok ? '' : 'Sheet 寫入失敗:' + (j.error || '未知錯誤'));
      })
      .catch(err => done(false, 'Sheet 連線失敗,本次異動僅存本地:' + err));
  }
  load(withSeed) {
    let raw = null;
    try { raw = JSON.parse(localStorage.getItem(KEY)); } catch (e) { }
    const SEED_ALL = buildSeed();
    // 全新裝置預設「空表」(只保證中央倉存在):連上 Google Sheet 前不需要示範資料;
    // 雲端模式登入後 pullAll 以 Sheet 內容覆蓋。示範資料改為 opt-in —
    // 「重置示範資料 / 還原示範資料」按鈕(reset/restoreSeed)才載入。
    if (!raw || typeof raw !== 'object') raw = withSeed ? Object.assign({}, SEED_ALL) : {};
    for (const k of Object.keys(SCHEMA)) {
      if (!raw[k]) raw[k] = (withSeed && SEED_ALL[k]) || SCHEMA[k].join(',');
      else raw[k] = migrateCSV(k, raw[k]); // 本地舊快取自動升級欄位
    }
    // 舊快取(已有原料主檔)沒有地點配置資料 → 補示範配置(否則所有地點視為全部備料)
    if (parseCSV(raw.ingredient).length > 1 && parseCSV(raw.location_stock).length < 2) raw.location_stock = SEED_ALL.location_stock;
    this.raw = raw; this.persist(); this.parseAll(); this.ensureCentral();
  }
  // 任何載入路徑後都保證中央倉存在 — location 空或缺 central 列時補 LOC-C
  ensureCentral() {
    if (this.t.location && this.t.location.some(l => l.type === 'central')) return;
    if (!this.raw.location || !parseCSV(this.raw.location).length) this.raw.location = SCHEMA.location.join(',');
    this.raw.location = this.raw.location.replace(/\n+$/, '') + '\nLOC-C,中央倉,central';
    this.t.location = toObjects(parseCSV(this.raw.location));
    this.persist();
  }
  parseAll() {
    this.t = {};
    for (const k of Object.keys(SCHEMA)) this.t[k] = toObjects(parseCSV(this.raw[k]));
  }
  persist() { try { localStorage.setItem(KEY, JSON.stringify(this.raw)); } catch (e) { } }
  csv(name) { return this.raw[name]; }
  // append-only:交易表新增一列
  append(name, obj) {
    const line = SCHEMA[name].map(h => esc(obj[h])).join(',');
    this.raw[name] = this.raw[name].replace(/\n+$/, '') + '\n' + line;
    const o = {}; SCHEMA[name].forEach(h => o[h] = obj[h] === undefined ? '' : String(obj[h]));
    this.t[name].push(o);
    this.persist();
    this.sendRemote({ action: 'append', sheet: name, row: o });
  }
  // 主資料表整表覆寫(僅限 master data 與狀態更新表)
  replace(name, objs) {
    const lines = [SCHEMA[name].join(',')].concat(objs.map(o => SCHEMA[name].map(h => esc(o[h])).join(',')));
    this.raw[name] = lines.join('\n');
    this.t[name] = objs.map(o => { const x = {}; SCHEMA[name].forEach(h => x[h] = o[h] === undefined ? '' : String(o[h])); return x; });
    this.persist();
    this.sendRemote({ action: 'replace', sheet: name, headers: SCHEMA[name], rows: this.t[name].map(r => SCHEMA[name].map(h => r[h] === undefined ? '' : r[h])) });
  }
  // ── 單格寫入(cell-level compare-and-set)─────────────────────────────────────────
  // 後端支援(caps 含 updateCell)時,主資料「單欄編輯」改走只改一格的 CAS 寫入:不同格並行、同格連打合併,
  // 徹底避免整表覆寫互相打架;後端未部署(caps 缺)時 setField 自動退回 Task #1 的整表 replace,行為與現況一致。
  // 呼叫端一律用 setField / deleteRow;線路 payload 僅集中在 _sendCell / _sendDelete(改欄名只動這裡)。key 依 schema.js 的 PRIMARY_KEY 組。
  _pk(sheet) { return PRIMARY_KEY[sheet] || [SCHEMA[sheet][0]]; } // 各表主鍵欄(單一來源;無登錄則退回首欄慣例)
  // match = {主鍵欄:值,…}(依 schema.js PRIMARY_KEY)。接受:列物件(取主鍵欄)/ match 物件 / 純值(單鍵)/ 陣列(複合,依序)。
  _matchOf(sheet, keyish) {
    const pks = this._pk(sheet), m = {};
    if (keyish && typeof keyish === 'object' && !Array.isArray(keyish)) pks.forEach(h => m[h] = keyish[h] === undefined ? '' : String(keyish[h]));
    else { const kv = Array.isArray(keyish) ? keyish : [keyish]; pks.forEach((h, i) => m[h] = kv[i] === undefined ? '' : String(kv[i])); }
    return m;
  }
  _rowByMatch(sheet, match) { return (this.t[sheet] || []).find(r => Object.keys(match).every(h => String(r[h]) === String(match[h]))); }
  _csv(name) { return [SCHEMA[name].join(',')].concat((this.t[name] || []).map(o => SCHEMA[name].map(h => esc(o[h])).join(','))).join('\n'); }
  _cellId(sheet, match, field) { return JSON.stringify([sheet].concat(this._pk(sheet).map(h => match[h]), field)); } // 內部佇列鍵:JSON 化,值含分隔字元也不會碰撞

  // 主資料單欄編輯的統一入口(取代呼叫端的 db.replace(sheet, wholeTableMapped)):
  // keyish = 列物件 / match 物件 / 主鍵值(單鍵表)。本地即時更新 this.t 讓輸入即時反應,
  // 再依能力送單格 CAS(不同格並行、同格合併)或整表後備。
  setField(sheet, keyish, field, newVal) {
    const match = this._matchOf(sheet, keyish);
    const row = this._rowByMatch(sheet, match);
    if (!row) return;
    const before = row[field] === undefined ? '' : String(row[field]);
    const next = newVal === undefined ? '' : String(newVal);
    if (before === next) return;
    row[field] = next; // 本地同步更新(this.t),輸入即時反應
    if (this.mode === 'cloud' && this.caps.has('updateCell')) {
      this.raw[sheet] = this._csv(sheet); this.persist();
      this._enqueueCell(sheet, match, field, before, next);
    } else {
      this.replace(sheet, this.t[sheet]); // 後備:整表覆寫(Task #1 的串行化/防抖/flush 全數沿用);this.t 已改,replace 依它重建
    }
  }
  // 多欄一次編輯(如原料編輯表單存檔):逐欄各自 CAS(不同格互不阻塞、可並行)。patch = {欄位:值,…}
  setFields(sheet, keyish, patch) { Object.keys(patch || {}).forEach(f => this.setField(sheet, keyish, f, patch[f])); }
  _enqueueCell(sheet, match, field, before, next) {
    if (this._blockWrite()) return; // 版本偏移 → 擋 updateCell(本地樂觀值保留,重載後由 pullAll 對齊)
    const id = this._cellId(sheet, match, field);
    let e = this._cellQ[id];
    if (!e) e = this._cellQ[id] = { sheet, match, field, base: before, latest: next, sent: null, inflight: false, dirty: false, timer: null };
    else { e.latest = next; e.dirty = true; } // 連打:保留 burst 起點 base,只更新最新值(合併)
    if (e.inflight) return;                    // 進行中 → 回應後用剛確認的 base 再送
    clearTimeout(e.timer);
    e.timer = setTimeout(() => this._drainCell(id), CELL_DEBOUNCE);
  }
  _drainCell(id, keepalive) {
    const e = this._cellQ[id];
    if (!e || e.inflight) return;
    if (this._blockWrite()) return; // 版本偏移:已排隊的單格寫入也不得送(防抖到期/flushWrites 卸載補送)
    if (e.base === e.latest) { delete this._cellQ[id]; return; }                 // 淨變化為零(改回原值)→ 不送
    if (this._cellInflight >= CELL_MAX_INFLIGHT) { clearTimeout(e.timer); e.timer = setTimeout(() => this._drainCell(id), 80); return; } // 併發上限 → 稍後
    e.inflight = true; e.dirty = false; e.sent = e.latest;
    this._cellInflight++;
    this._sendCell(e, keepalive);
  }
  _sendCell(e, keepalive) {
    const id = this._cellId(e.sheet, e.match, e.field);
    const done = () => { this.pending--; this._cellInflight--; e.inflight = false; };
    const tok = this.authToken();
    const payload = { action: 'updateCell', sheet: e.sheet, match: e.match, field: e.field, old: e.base, new: quoteDT(e.sent) };
    if (tok) payload.token = tok;
    this.pending++;
    fetch(this.cfg.url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payload), keepalive: !!keepalive })
      .then(r => r.json())
      .then(j => {
        done();
        if (j && j.error === 'unauthorized' && this.onAuthFail) { if (this._cellQ[id] === e) delete this._cellQ[id]; this.onAuthFail(); return; }
        if (j && j.rev != null) this.rev[e.sheet] = j.rev;
        if (j && j.ok) {
          e.base = (j.value != null ? String(j.value) : e.sent);       // 以後端實際寫入(正規化)值做新基線 → 下一送的 old
          // 期間又有新編輯(dirty)才再送;否則收斂。用 dirty 而非 base!==latest,避免後端數字正規化(1.50→1.5)造成無限回送。
          if (e.dirty) { clearTimeout(e.timer); e.timer = setTimeout(() => this._drainCell(id), CELL_DEBOUNCE); }
          else if (this._cellQ[id] === e) delete this._cellQ[id];
          return;
        }
        if (this._cellQ[id] === e) delete this._cellQ[id];             // 失敗 → 移出佇列,交由上層只刷新該格
        const err = (j && j.error) || 'unknown';
        // 重送競態:值其實已寫入(後端 current === 我剛送的)→ 視為已套用,靜默對齊,不打擾使用者
        if (err === 'conflict' && j && j.current != null && String(j.current) === String(e.sent)) { this._setCellLocal(e.sheet, e.match, e.field, j.current); return; }
        if (err === 'conflict') {
          if (j.row) this._applyRow(e.sheet, e.match, j.row);          // 他人先改 → 套用後端最新整列(只動此列)
          else this._setCellLocal(e.sheet, e.match, e.field, j.current != null ? j.current : e.base);
        } else if (err === 'row_not_found' || err === 'not_found') {
          this._dropRow(e.sheet, e.match);                             // 列已被他人刪除 → 本地移除
        } else if (err === 'forbidden' || err === 'forbidden_location' || err === 'forbidden_field') {
          this._setCellLocal(e.sheet, e.match, e.field, e.base);       // 無權 → 回退本地樂觀變更
        } // ambiguous_match / incomplete_key / unknown_field:資料/設定 bug — 保留本地,交由通知呈現
        if (this.onCellConflict) this.onCellConflict({ sheet: e.sheet, match: e.match, field: e.field, error: err, current: j && j.current, row: j && j.row, msg: this._cellErrMsg(err) });
        else if (this.onRemote) this.onRemote(false, this._cellErrMsg(err));
      })
      .catch(err => {
        done();
        e.dirty = true; // 網路失敗:值仍在本地;保留佇列讓下次編輯/flush 補送,不自動重試以免風暴
        if (this.onRemote) this.onRemote(false, 'Sheet 連線失敗,本次異動僅存本地:' + err);
      });
  }
  _cellErrMsg(err) {
    return err === 'conflict' ? '⚠ 此欄已被他人更新 — 已載入最新值,請確認後重試'
      : (err === 'row_not_found' || err === 'not_found') ? '⚠ 此列已不存在(可能已被刪除)'
      : err === 'forbidden_field' ? '⚠ 無權編輯此欄位'
      : (err === 'forbidden' || err === 'forbidden_location') ? '⚠ 無權編輯此列'
      : err === 'ambiguous_match' ? '✕ 資料異常:主鍵對應到多列,請聯絡管理員'
      : 'Sheet 寫入失敗:' + err;
  }
  // 刪除一列(結構性):後端支援 deleteRow 就走它,否則整表覆寫後備。
  deleteRow(sheet, keyish) {
    const match = this._matchOf(sheet, keyish);
    this._dropRow(sheet, match); // 本地即時移除
    if (this.mode !== 'cloud') return;
    if (this._blockWrite()) return; // 版本偏移 → 擋 deleteRow(含整表覆寫後備)
    if (this.caps.has('deleteRow')) {
      const tok = this.authToken();
      const payload = { action: 'deleteRow', sheet, match };
      if (tok) payload.token = tok;
      this.pending++;
      fetch(this.cfg.url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payload) })
        .then(r => r.json())
        .then(j => { this.pending--; if (j && j.rev != null) this.rev[sheet] = j.rev; if (this.onRemote && j && !j.ok) this.onRemote(false, '刪除失敗:' + (j.error || '')); })
        .catch(err => { this.pending--; if (this.onRemote) this.onRemote(false, 'Sheet 連線失敗:' + err); });
    } else {
      this.replace(sheet, this.t[sheet] || []); // 後備:整表覆寫(已移除該列)
    }
  }
  _applyRow(sheet, match, rowObj) {
    const arr = this.t[sheet] || (this.t[sheet] = []);
    const i = arr.findIndex(r => Object.keys(match).every(h => String(r[h]) === String(match[h])));
    const cur = i >= 0 ? arr[i] : null;
    const norm = {};
    SCHEMA[sheet].forEach(h => {
      // 該格仍有未結算的單格編輯(in-flight / 待送)→ 保留本地樂觀值,別讓「相鄰欄的衝突」把它蓋回後端舊值
      //(那筆自己的 updateCell 會負責對齊;否則本地顯示舊值、Sheet 卻是新值,直到下次 pullAll)。
      const e = cur && this._cellQ[this._cellId(sheet, match, h)];
      norm[h] = (e && (e.inflight || e.base !== e.latest)) ? (cur[h] === undefined ? '' : String(cur[h]))
        : (rowObj[h] === undefined ? '' : String(rowObj[h]));
    });
    if (i >= 0) arr[i] = norm; else arr.push(norm);
    this.raw[sheet] = this._csv(sheet); this.persist();
  }
  _dropRow(sheet, match) {
    if (!this.t[sheet]) return;
    this.t[sheet] = this.t[sheet].filter(r => !Object.keys(match).every(h => String(r[h]) === String(match[h])));
    this.raw[sheet] = this._csv(sheet); this.persist();
  }
  _setCellLocal(sheet, match, field, val) {
    const row = this._rowByMatch(sheet, match);
    if (!row) return;
    row[field] = val === undefined ? '' : String(val);
    this.raw[sheet] = this._csv(sheet); this.persist();
  }
  // ── 背景版號輪詢 + 外科式合併(Task #11)──────────────────────────────────────────
  // 每 REV_POLL_MS 打 action=revs(只回各表版號),和本地 this.rev 逐表比對;落後的表逐表重拉並合併。
  // 合併絕不覆蓋尚未結算的本地編輯:逐列走 _applyRow(保留該列仍在 _cellQ 的欄位),他人刪的列(本地也沒待送編輯)才移除。
  // 暫停條件:tab 隱藏 / 離線 / 非雲端 / 未登入 / 後端無 'revs' 能力。由 app.js 於 startCloud 後呼叫 startRevPoll。
  startRevPoll() {
    if (this._revStarted) return;
    this._revStarted = true;
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this._revWake);
    if (typeof window !== 'undefined') { window.addEventListener('online', this._revWake); window.addEventListener('offline', this._revWake); }
    this._scheduleRevPoll();
  }
  stopRevPoll() { this._revStarted = false; clearTimeout(this._revTimer); this._revTimer = null; }
  _revEligible() {
    return this.mode === 'cloud' && !!this.authToken() && this.caps.has('revs')
      && (typeof document === 'undefined' || document.visibilityState !== 'hidden')
      && (typeof navigator === 'undefined' || navigator.onLine !== false);
  }
  _scheduleRevPoll(soon) {
    clearTimeout(this._revTimer); this._revTimer = null;
    if (!this._revStarted || !this._revEligible()) return;
    // soon=喚醒(切回前景/恢復連線)→ 短延遲立即補一輪(防抖連續事件);常態則間隔 + 抖動,避免多客戶端同步齊打後端。
    const delay = soon ? 1200 : REV_POLL_MS - 8000 + Math.floor(Math.random() * 16000);
    this._revTimer = setTimeout(() => this._pollRevs(), delay);
  }
  async _pollRevs() {
    this._revTimer = null;
    if (!this._revStarted || !this._revEligible()) return; // 條件消失(隱藏/離線/登出)→ 停;恢復時 _revWake 會重排
    try {
      const j = await this.api('action=revs');
      this.checkVer(j); // ver 偏移守衛(revs 輪詢回應帶 ver)— 背景輪詢即可觸發 banner+重載
      const rv = j && j.ok && j.revs ? j.revs : null;
      if (rv) {
        const changed = [];
        for (const n of Object.keys(SCHEMA)) {
          if (BATCH_EXCLUDE.indexOf(n) >= 0) continue;                         // 無界帳本(stock_ledger/sales_line):背景不整表重拉(回應太大),手動重新同步時才對齊
          if (rv[n] == null || Number(rv[n]) <= (this.rev[n] || 0)) continue;   // 後端版號未超前 → 略過
          const rq = this._repQ[n]; if (rq && (rq.pending || rq.inflight)) continue; // 有待送整表覆寫 → 下輪再併(避免和自己的寫入互踩)
          const lj = await this.api('action=list&sheet=' + n).catch(() => null);
          if (lj && lj.ok && Array.isArray(lj.rows)) {
            this._mergeSheet(n, this._listObjects(n, lj.rows));
            this.rev[n] = lj.rev != null ? lj.rev : Number(rv[n]);
            changed.push(n);
          }
        }
        if (changed.length && this.onRefresh) this.onRefresh(changed); // 上層重繪(合併已保留正在編輯的欄位)
      }
    } catch (e) { /* 靜默:下輪再試 */ }
    this._scheduleRevPoll();
  }
  // action=list 的原始 rows(陣列的陣列,第 0 列為表頭)→ 正規化後的列物件(與 this.t[name] 同型;與 pullAll 同一條正規化)。
  _listObjects(name, rawRows) {
    const csv = migrateCSV(name, rawRows.map(r => r.map(c => esc(normCell(c === null || c === undefined ? '' : String(c)))).join(',')).join('\n'));
    return toObjects(parseCSV(csv));
  }
  // 背景合併(保守 v1):只 upsert 後端最新列,背景絕不刪列 -- _applyRow 逐欄保留仍在 _cellQ 的本地編輯,
  // 未同步的本地新增列(append)也不會被誤刪。他人刪的列於手動「重新同步」或下次觸及該列(updateCell -> row_not_found)時對齊。
  _mergeSheet(name, freshObjs) {
    freshObjs.forEach(fr => this._applyRow(name, this._matchOf(name, fr), fr));
  }
  nextId(name, field, prefix, pad) {
    let mx = 0;
    for (const r of this.t[name]) { const m = String(r[field]).match(/(\d+)$/); if (m) mx = Math.max(mx, parseInt(m[1], 10)); }
    return prefix + String(mx + 1).padStart(pad || 4, '0');
  }
  reset() { try { localStorage.removeItem(KEY); } catch (e) { } this.load(true); } // 重置=載回示範資料(按鈕語意)
  // 清空資料(keepMaster=true 保留主資料表);雲端模式下同步覆寫 Sheet 為僅表頭
  wipe(keepMaster) {
    const MASTER = ['location', 'location_stock', 'ingredient', 'product', 'supplier', 'bom', 'routing', 'equipment', 'category', 'staff', 'line', 'station'];
    const wiped = [];
    for (const k of Object.keys(SCHEMA)) {
      if (keepMaster && MASTER.indexOf(k) >= 0) continue;
      this.raw[k] = SCHEMA[k].join(',');
      this.t[k] = [];
      wiped.push(k);
    }
    this.persist();
    if (!keepMaster) { // 全部清空後至少保留中央倉,空表建置從「建門市」開始
      this.raw.location = SCHEMA.location.join(',') + '\nLOC-C,中央倉,central';
      this.t.location = [{ location_id: 'LOC-C', name: '中央倉', type: 'central' }];
      this.persist();
    }
    wiped.forEach(k => this.sendRemote({ action: 'replace', sheet: k, headers: SCHEMA[k], rows: this.t[k].map(r => SCHEMA[k].map(h => r[h] === undefined ? '' : r[h])) }));
    return wiped;
  }
  restoreSeed() {
    const SEED_ALL = buildSeed();
    for (const k of Object.keys(SCHEMA)) this.raw[k] = SEED_ALL[k] || SCHEMA[k].join(',');
    this.persist(); this.parseAll();
    Object.keys(SCHEMA).forEach(k => this.sendRemote({ action: 'replace', sheet: k, headers: SCHEMA[k], rows: this.t[k].map(r => SCHEMA[k].map(h => r[h] === undefined ? '' : r[h])) }));
    return Object.keys(SCHEMA).length;
  }
}
