// 迷你模板執行時 — 取代 Claude Design 原型的 support.js(React/unpkg 執行時)。
// 實作本 App 模板實際用到的 .dc 方言子集:
//   <sc-if value="{{expr}}">…</sc-if>
//   <sc-for list="{{expr}}" as="name">…</sc-for>
//   {{path}} 綁定(文字與屬性;整值綁定可傳函式/任意值)
//   onClick/onChange/onMouseDown/onDrag*/onScroll 事件、value/checked/draggable 受控屬性、
//   ref="{{fn}}"、style-hover="css"
// 渲染採「重建輕量節點樹 → 原地 morph」:輸入焦點、捲動位置與 CSS transition 不會被打斷。
// 無任何外部依賴(不載 React/CDN),與本 repo 其他 app 一樣完全自足。

// ── 運算式解析:屬性路徑(a.b.c / a[expr])、字面值、!、==/===/!=/!== 與括號 ──
const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*/;
const NUMBER_RE = /^-?\d+(\.\d+)?$/;

function resolve(vals, src) {
  const expr = String(src).trim();
  if (!expr) return undefined;
  if (expr[0] === '(' && expr[expr.length - 1] === ')' && parensWrapWhole(expr)) return resolve(vals, expr.slice(1, -1));
  const eq = findTopLevelEquality(expr);
  if (eq) {
    const lv = resolve(vals, expr.slice(0, eq.index));
    const rv = resolve(vals, expr.slice(eq.index + eq.op.length));
    switch (eq.op) {
      case '===': return lv === rv;
      case '!==': return lv !== rv;
      case '==': return lv == rv; // eslint-disable-line eqeqeq
      default: return lv != rv;   // eslint-disable-line eqeqeq
    }
  }
  if (expr[0] === '!') return !resolve(vals, expr.slice(1));
  if (expr === 'true') return true;
  if (expr === 'false') return false;
  if (expr === 'null') return null;
  if (expr === 'undefined') return undefined;
  if (NUMBER_RE.test(expr)) return Number(expr);
  if (expr.length >= 2 && (expr[0] === '"' || expr[0] === "'") && expr[expr.length - 1] === expr[0]) return expr.slice(1, -1);
  return resolvePath(vals, expr);
}

function parensWrapWhole(expr) {
  let depth = 0;
  for (let i = 0; i < expr.length - 1; i++) {
    if (expr[i] === '(') depth++;
    else if (expr[i] === ')') { depth--; if (depth === 0) return false; }
  }
  return true;
}

function findTopLevelEquality(expr) {
  let depth = 0;
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (c === '[' || c === '(') depth++;
    else if (c === ']' || c === ')') depth--;
    else if (depth === 0 && (c === '=' || c === '!') && expr[i + 1] === '=') {
      if (i > 0 && (expr[i - 1] === '=' || expr[i - 1] === '!')) continue;
      if (!expr.slice(0, i).trim()) continue;
      return { index: i, op: expr[i + 2] === '=' ? c + '==' : c + '=' };
    }
  }
  return null;
}

function resolvePath(vals, expr) {
  const head = expr.match(IDENT_RE);
  if (!head) return undefined;
  let cur = vals == null ? undefined : vals[head[0]];
  let i = head[0].length;
  while (i < expr.length) {
    if (expr[i] === '.') {
      const m = expr.slice(i + 1).match(IDENT_RE) || expr.slice(i + 1).match(/^\d+/);
      if (!m) return undefined;
      cur = cur == null ? undefined : cur[m[0]];
      i += 1 + m[0].length;
    } else if (expr[i] === '[') {
      let depth = 1, j = i + 1;
      while (j < expr.length && depth > 0) {
        if (expr[j] === '[') depth++;
        else if (expr[j] === ']') { depth--; if (depth === 0) break; }
        j++;
      }
      if (depth !== 0) return undefined;
      const key = resolve(vals, expr.slice(i + 1, j));
      cur = cur == null ? undefined : cur[key];
      i = j + 1;
    } else return undefined;
  }
  return cur;
}

// 屬性值編譯:整值 {{x}} 回傳原始值(函式/布林都行);混合字串則逐段插值
function compileAttr(raw) {
  const whole = raw.match(/^\s*\{\{([\s\S]+?)\}\}\s*$/);
  if (whole) { const p = whole[1]; return vals => resolve(vals, p); }
  if (raw.includes('{{')) {
    const parts = raw.split(/\{\{([\s\S]+?)\}\}/g);
    return vals => parts.map((s, i) => {
      if (!(i & 1)) return s;
      const v = resolve(vals, s);
      return v === undefined || v === null ? '' : String(v);
    }).join('');
  }
  return () => raw;
}

// ── 模板解析:table 系標籤先替換成 sc-raw-*,避免 HTML parser 把 sc-if/sc-for 從表格裡搬走 ──
const RAW_WRAP = { select: 'sc-raw-select', table: 'sc-raw-table', tbody: 'sc-raw-tbody', thead: 'sc-raw-thead', tfoot: 'sc-raw-tfoot', tr: 'sc-raw-tr', td: 'sc-raw-td', th: 'sc-raw-th', caption: 'sc-raw-caption' };
const RAW_UNWRAP = Object.fromEntries(Object.entries(RAW_WRAP).map(([k, v]) => [v, k]));

function encodeCase(html) {
  for (const [real, alias] of Object.entries(RAW_WRAP)) {
    html = html.replace(new RegExp('(</?)' + real + '(?=[\\s>])', 'gi'), '$1' + alias);
  }
  return html;
}

// style-hover 產生一次性的 :hover 規則
let hoverStyleEl = null, hoverN = 0;
const hoverClasses = new Map();
function hoverClass(css) {
  if (!hoverClasses.has(css)) {
    if (!hoverStyleEl) { hoverStyleEl = document.createElement('style'); document.head.appendChild(hoverStyleEl); }
    const cls = 'sc-hov-' + (++hoverN);
    hoverStyleEl.textContent += '.' + cls + ':hover{' + css + '}\n';
    hoverClasses.set(css, cls);
  }
  return hoverClasses.get(css);
}

// onChange 在原型(React)裡是每次按鍵觸發 → 對應原生 input;checkbox/radio/select 用 change
function domEventName(name, tag, staticType) {
  if (name !== 'change') return name;
  if (tag === 'select') return 'change';
  if (tag === 'input' && (staticType === 'checkbox' || staticType === 'radio')) return 'change';
  return 'input';
}

export function compileTemplate(text) {
  const tpl = document.createElement('template');
  tpl.innerHTML = encodeCase(text);
  return compileChildren(tpl.content);
}

function compileChildren(node) {
  const out = [];
  for (const c of node.childNodes) {
    const b = compileNode(c);
    if (b) out.push(b);
  }
  return out;
}

function compileNode(node) {
  if (node.nodeType === Node.TEXT_NODE) {
    const txt = node.nodeValue || '';
    if (!txt.includes('{{')) {
      if (!txt.trim()) return null; // 純空白(排版縮排)不進 DOM;元素間距由原 HTML 空白已含在有字的節點裡
      return { kind: 'text', get: () => txt };
    }
    return { kind: 'text', get: compileAttr(txt) };
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return null;
  const rawTag = node.tagName.toLowerCase();
  if (rawTag === 'sc-for') {
    return { kind: 'for', get: compileAttr(node.getAttribute('list') || ''), as: node.getAttribute('as') || 'item', children: compileChildren(node) };
  }
  if (rawTag === 'sc-if') {
    return { kind: 'if', get: compileAttr(node.getAttribute('value') || ''), children: compileChildren(node) };
  }
  const tag = RAW_UNWRAP[rawTag] || rawTag;
  // morph-skip:此元素的子樹交由外部程式管理(例 Google 登入按鈕 iframe),morph 不碰
  const skip = node.hasAttribute('morph-skip');
  const el = { kind: 'el', tag, skip, attrs: [], events: [], props: [], ref: null, hover: null, children: skip ? [] : compileChildren(node) };
  const staticType = node.getAttribute('type') || '';
  for (const { name, value } of [...node.attributes]) {
    if (name.startsWith('hint-') || name.startsWith('data-dc-') || name === 'morph-skip') continue;
    if (name === 'ref') { el.ref = compileAttr(value); continue; }
    if (name === 'style-hover') { el.hover = hoverClass(value); continue; }
    if (name.startsWith('on') && name.length > 2) {
      el.events.push({ type: domEventName(name.slice(2), tag, staticType), get: compileAttr(value) });
      continue;
    }
    if (name === 'value' || name === 'checked' || name === 'draggable') {
      el.props.push({ name, get: compileAttr(value) });
      continue;
    }
    el.attrs.push({ name, get: compileAttr(value) });
  }
  return el;
}

// ── 每次渲染:編譯樹 + vals → 輕量節點列表(sc-if/sc-for 展平)──
function buildVNodes(builders, vals, out) {
  out = out || [];
  for (const b of builders) {
    if (b.kind === 'text') {
      const v = b.get(vals);
      out.push({ k: 't', s: v === undefined || v === null ? '' : String(v) });
    } else if (b.kind === 'if') {
      if (b.get(vals)) buildVNodes(b.children, vals, out);
    } else if (b.kind === 'for') {
      let list = b.get(vals);
      if (!Array.isArray(list)) list = [];
      for (let i = 0; i < list.length; i++) {
        const sub = Object.create(vals);
        sub[b.as] = list[i];
        sub.$index = i;
        buildVNodes(b.children, sub, out);
      }
    } else {
      const vn = { k: 'e', tag: b.tag, skip: b.skip, attrs: {}, events: null, props: null, ref: null, hover: b.hover, children: null };
      for (const a of b.attrs) {
        const v = a.get(vals);
        if (v === undefined || v === null || v === false) continue;
        vn.attrs[a.name] = v === true ? '' : String(v);
      }
      if (b.events.length) {
        vn.events = {};
        for (const ev of b.events) vn.events[ev.type] = ev.get(vals);
      }
      if (b.props.length) {
        vn.props = {};
        for (const p of b.props) vn.props[p.name] = p.get(vals);
      }
      if (b.ref) vn.ref = b.ref(vals);
      vn.children = b.skip ? [] : buildVNodes(b.children, vals);
      out.push(vn);
    }
  }
  return out;
}

// ── morph:依序比對,同型別原地更新,異型別整節點替換 ──
function morphChildren(parent, vnodes) {
  const existing = parent.childNodes;
  for (let i = 0; i < vnodes.length; i++) {
    const vn = vnodes[i];
    const ex = existing[i];
    if (!ex) parent.appendChild(createNode(vn));
    else patchNode(parent, ex, vn);
  }
  while (parent.childNodes.length > vnodes.length) parent.removeChild(parent.lastChild);
}

function patchNode(parent, ex, vn) {
  if (vn.k === 't') {
    if (ex.nodeType !== Node.TEXT_NODE) parent.replaceChild(document.createTextNode(vn.s), ex);
    else if (ex.nodeValue !== vn.s) ex.nodeValue = vn.s;
    return;
  }
  if (ex.nodeType !== Node.ELEMENT_NODE || ex.__dcTag !== vn.tag) {
    parent.replaceChild(createNode(vn), ex);
    return;
  }
  patchEl(ex, vn);
}

function createNode(vn) {
  if (vn.k === 't') return document.createTextNode(vn.s);
  const el = document.createElement(vn.tag);
  el.__dcTag = vn.tag;
  patchEl(el, vn);
  return el;
}

function patchEl(el, vn) {
  // 屬性(style 走 cssText,並快取原字串避免重設打斷 transition)
  const prev = el.__dcA || {};
  const next = vn.attrs;
  for (const name in next) {
    if (prev[name] === next[name]) continue;
    if (name === 'style') el.style.cssText = next[name];
    else el.setAttribute(name, next[name]);
  }
  for (const name in prev) {
    if (name in next) continue;
    if (name === 'style') el.style.cssText = '';
    else el.removeAttribute(name);
  }
  el.__dcA = next;
  if (vn.hover) el.classList.add(vn.hover);
  // 受控屬性
  if (vn.props) {
    if ('value' in vn.props) {
      let v = vn.props.value;
      if (v === undefined || v === null) v = '';
      v = String(v);
      if (el.value !== v) el.value = v;
    }
    if ('checked' in vn.props) {
      const c = !!vn.props.checked;
      if (el.checked !== c) el.checked = c;
    }
    if ('draggable' in vn.props) {
      const d = vn.props.draggable === true || vn.props.draggable === 'true';
      if (el.draggable !== d) el.draggable = d;
    }
  }
  // 事件:每型別綁一次穩定 dispatcher,handler 每次渲染換新
  if (vn.events) {
    el.__dcH = vn.events;
    let bound = el.__dcB;
    for (const type in vn.events) {
      if (!bound) bound = el.__dcB = {};
      if (!bound[type]) {
        bound[type] = true;
        el.addEventListener(type, e => {
          const fn = el.__dcH && el.__dcH[e.type];
          if (typeof fn === 'function') fn(e);
        });
      }
    }
  } else if (el.__dcH) el.__dcH = null;
  if (typeof vn.ref === 'function') vn.ref(el);
  if (!vn.skip) morphChildren(el, vn.children);
}

// ── 元件基底:與原型的 DCLogic(React class component)介面相容 ──
export class DCLogic {
  setState(patch, cb) {
    if (!this.state) this.state = {};
    Object.assign(this.state, typeof patch === 'function' ? patch(this.state) : patch);
    this._schedule();
    if (cb) queueMicrotask(cb);
  }
  forceUpdate() { this._schedule(); }
  _schedule() {
    if (!this._mounted || this._dirty) return;
    this._dirty = true;
    queueMicrotask(() => { this._dirty = false; this._renderNow(); });
  }
}

export function mountApp(ComponentClass, container, templateText) {
  const compiled = compileTemplate(templateText);
  const inst = new ComponentClass();
  inst._renderNow = () => {
    let vals;
    try { vals = inst.renderVals() || {}; }
    catch (err) { console.error('renderVals failed', err); return; }
    morphChildren(container, buildVNodes(compiled, vals));
  };
  inst._mounted = true;
  inst._renderNow();
  if (typeof inst.componentDidMount === 'function') inst.componentDidMount();
  return inst;
}
