// 由 js/schema.js(單一結構來源)重新產生 apps-script.js 內 <<gen:tables>> 區塊的 TABLES。
// 用法:
//   node bakery-erp/tools/gen-schema.mjs          → 寫回 apps-script.js
//   node bakery-erp/tools/gen-schema.mjs --check  → 只檢查是否過期(CI 用,過期則 exit 1)
// 後端仍是手動貼到 Google Apps Script 部署;本工具只保證貼過去的內容和前端同一份結構.
import { readFileSync, writeFileSync } from 'node:fs';
// SCHEMA_SIG 直接由 schema.js import(單一雜湊實作,不在此重算)→ 前後端帶同一字面值,零漂移。
import { SCHEMA_SIG } from '../js/schema.js';

const SCHEMA_URL = new URL('../js/schema.js', import.meta.url);
const APP_URL = new URL('../apps-script.js', import.meta.url);

// schema.js 是瀏覽器 ESM;node 預設把 .js 當 CJS,所以用文字擷取 + 安全 eval 物件字面值(不動模組語意).
const schemaSrc = readFileSync(SCHEMA_URL, 'utf8');
const TABLE_COLUMNS = extract('TABLE_COLUMNS');
const PRIMARY_KEY = extract('PRIMARY_KEY');
const DEFAULT_PERMS = extract('DEFAULT_PERMS');
const AUTH_TABLES = extractArray('AUTH_TABLES');
const BATCH_EXCLUDE = extractArray('BATCH_EXCLUDE');
const COST_FIELDS = extractArray('COST_FIELDS');
// 主同步表 = 全部表扣掉帳號/權限表(與 js/schema.js 的 SYNC_TABLES 同一算式,零漂移)
const SYNC_TABLES = Object.keys(TABLE_COLUMNS).filter(t => !AUTH_TABLES.includes(t));

// 不變式(schema-guard 要求):每張表都要有「非空」PRIMARY_KEY,且其每個鍵欄都存在於該表 TABLE_COLUMNS。
// check:schema 原本只擋區塊過期,擋不到「主鍵漏設 / 打錯欄名 / 指到不存在的欄」;在此提前 fail,
// 避免產出一份 cell-level 定位不到列(或永遠 ambiguous)的後端。gen 與 --check 兩種模式都會跑到。
for (const t of Object.keys(TABLE_COLUMNS)) {
  const pk = PRIMARY_KEY[t];
  if (!Array.isArray(pk) || pk.length === 0) fail(`js/schema.js 的 PRIMARY_KEY 缺少 ${t}(或不是非空陣列)`);
  for (const c of pk) if (!TABLE_COLUMNS[t].includes(c)) fail(`js/schema.js 的 PRIMARY_KEY.${t} 含非該表欄位:'${c}'`);
}

const src = readFileSync(APP_URL, 'utf8');
const eol = src.includes('\r\n') ? '\r\n' : '\n'; // 依檔案現有行尾(Windows 常是 CRLF)產生,避免混行尾讓 --check 誤判過期

// <<gen:tables>>:資料表結構
let next = replaceBlock(src, 'gen:tables', [
  'var TABLES = {',
  Object.entries(TABLE_COLUMNS).map(([t, cols]) => `  ${t}: [${cols.map(c => `'${c}'`).join(', ')}]`).join(',' + eol),
  '};'
], '(改結構請改 js/schema.js)');

// <<gen:keys>>:每張表主鍵欄(cell-level updateCell / deleteRow 定位列用;與前端同一份)
next = replaceBlock(next, 'gen:keys', [
  'var PRIMARY_KEY = {',
  Object.entries(PRIMARY_KEY).map(([t, cols]) => `  ${t}: [${cols.map(c => `'${c}'`).join(', ')}]`).join(',' + eol),
  '};'
], '(改主鍵請改 js/schema.js)');

// <<gen:perms>>:角色權限預設矩陣(與前端同一份;見 doc/PERMISSION_ROLE_MAP.md)
next = replaceBlock(next, 'gen:perms', [
  'var DEFAULT_PERMS = {',
  Object.entries(DEFAULT_PERMS).map(([r, keys]) => `  ${r}: [${keys.map(k => `'${k}'`).join(', ')}]`).join(',' + eol),
  '};'
], '(改預設權限請改 js/schema.js)');

// <<gen:synctables>>:pullAll / listAll 一次批次讀取的分頁清單(= 全部表扣掉帳號/權限表)
next = replaceBlock(next, 'gen:synctables', [
  'var SYNC_TABLES = [' + SYNC_TABLES.map(t => `'${t}'`).join(', ') + '];'
], '(改結構請改 js/schema.js)');

// <<gen:batchexclude>>:listAll 批次排除的無界成長帳本(改由前端逐表 list 拉取;與前端同一份常數)
next = replaceBlock(next, 'gen:batchexclude', [
  'var BATCH_EXCLUDE = [' + BATCH_EXCLUDE.map(t => `'${t}'`).join(', ') + '];'
], '(改結構請改 js/schema.js)');

// <<gen:costfields>>:成本敏感欄位(欄名層級);後端 updateCell 對缺 feature.cost 的工作階段回 forbidden_field(與前端 canCost 同一份)
next = replaceBlock(next, 'gen:costfields', [
  'var COST_FIELDS = [' + COST_FIELDS.map(t => `'${t}'`).join(', ') + '];'
], '(改成本欄請改 js/schema.js)');

// <<gen:sig>>:結構指紋(= schema.js 的 SCHEMA_SIG 字面值);前後端比對偵測版本偏移,勿手改此值
next = replaceBlock(next, 'gen:sig', [
  `var SCHEMA_SIG = '${SCHEMA_SIG}';`
], '(此值由 js/schema.js 的 SCHEMA_SIG 產生)');

function extract(name) {
  const m = schemaSrc.match(new RegExp('export const ' + name + '\\s*=\\s*(\\{[\\s\\S]*?\\n\\});'));
  if (!m) fail('js/schema.js 找不到 ' + name + ' 物件');
  return new Function('return (' + m[1] + ')')();
}
function extractArray(name) {
  // 從宣告後第一個 `[` 起做括號平衡掃描(略過字串內容),抓到配對的 `]` 為止 ——
  // 舊版 `\[[^\]]*\]` 會停在第一個 `]`,一旦陣列改成多行 / 帶行尾註解 / 內含巢狀括號就會被截斷後 eval 失敗。
  const m = schemaSrc.match(new RegExp('export const ' + name + '\\s*=\\s*'));
  if (!m) fail('js/schema.js 找不到 ' + name + ' 陣列');
  const start = schemaSrc.indexOf('[', m.index + m[0].length);
  if (start < 0) fail('js/schema.js 的 ' + name + ' 不是陣列字面值');
  let depth = 0, quote = '';
  for (let i = start; i < schemaSrc.length; i++) {
    const ch = schemaSrc[i];
    if (quote) { if (ch === quote && schemaSrc[i - 1] !== '\\') quote = ''; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    else if (ch === '[') depth++;
    else if (ch === ']' && --depth === 0) return new Function('return (' + schemaSrc.slice(start, i + 1) + ')')();
  }
  fail('js/schema.js 的 ' + name + ' 陣列括號不對稱');
}
function replaceBlock(text, tag, bodyLines, why) {
  const START = '// <<' + tag + '>>';
  const END = '// <</' + tag + '>>';
  const re = new RegExp(esc(START) + '[\\s\\S]*?' + esc(END));
  if (!re.test(text)) fail('apps-script.js 找不到 <<' + tag + '>> 標記');
  const block = [`${START} — 由 \`npm run gen:schema\` 依 js/schema.js 自動產生;勿手改此區塊${why}`, ...bodyLines, END].join(eol);
  return text.replace(re, block);
}

if (process.argv.includes('--check')) {
  if (next !== src) { fail('apps-script.js 的 TABLES 已過期 — 請執行 `npm run gen:schema` 後重新貼到 Apps Script'); }
  console.log('✓ apps-script.js TABLES 與 js/schema.js 一致');
} else if (next === src) {
  console.log('✓ apps-script.js TABLES 已是最新(無變更)');
} else {
  writeFileSync(APP_URL, next);
  console.log('✓ 已依 js/schema.js 重新產生 apps-script.js 的 TABLES — 記得重新貼到 Google Apps Script 並部署');
}

function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function fail(msg) { console.error('✗ ' + msg); process.exit(1); }
