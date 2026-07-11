// 由 js/schema.js(單一結構來源)重新產生 apps-script.js 內 <<gen:tables>> 區塊的 TABLES。
// 用法:
//   node bakery-erp/tools/gen-schema.mjs          → 寫回 apps-script.js
//   node bakery-erp/tools/gen-schema.mjs --check  → 只檢查是否過期(CI 用,過期則 exit 1)
// 後端仍是手動貼到 Google Apps Script 部署;本工具只保證貼過去的內容和前端同一份結構.
import { readFileSync, writeFileSync } from 'node:fs';

const SCHEMA_URL = new URL('../js/schema.js', import.meta.url);
const APP_URL = new URL('../apps-script.js', import.meta.url);
const START = '// <<gen:tables>>';
const END = '// <</gen:tables>>';

// schema.js 是瀏覽器 ESM;node 預設把 .js 當 CJS,所以用文字擷取 + 安全 eval 物件字面值(不動模組語意).
const schemaSrc = readFileSync(SCHEMA_URL, 'utf8');
const m = schemaSrc.match(/export const TABLE_COLUMNS\s*=\s*(\{[\s\S]*?\n\});/);
if (!m) { fail('js/schema.js 找不到 TABLE_COLUMNS 物件'); }
const TABLE_COLUMNS = new Function('return (' + m[1] + ')')();

const src = readFileSync(APP_URL, 'utf8');
const eol = src.includes('\r\n') ? '\r\n' : '\n'; // 依檔案現有行尾(Windows 常是 CRLF)產生,避免混行尾讓 --check 誤判過期
const lines = Object.entries(TABLE_COLUMNS)
  .map(([t, cols]) => `  ${t}: [${cols.map(c => `'${c}'`).join(', ')}]`);
const block = [
  `${START} — 由 \`npm run gen:schema\` 依 js/schema.js 自動產生;勿手改此區塊(改結構請改 js/schema.js)`,
  'var TABLES = {',
  lines.join(',' + eol),
  '};',
  END
].join(eol);
const re = new RegExp(esc(START) + '[\\s\\S]*?' + esc(END));
if (!re.test(src)) { fail('apps-script.js 找不到 <<gen:tables>> 標記'); }
const next = src.replace(re, block);

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
