// Bakery ERP — 應用邏輯(中央倉+多門市)
// 忠實移植自 Claude Design 交接包的「Bakery ERP Prototype v2.dc.html」:
// 模板與業務邏輯逐字保留(視為 spec),僅把原型的 React/CDN 執行時換成 ./runtime.js。
// 兩個設計不變式(見 design_handoff README):
//   1) stock_ledger 為 append-only,結存永遠按 location_id 加總流水算出,不可直接改
//   2) 單據狀態機:transfer_order(叫貨→已出貨→已收貨/取消)、purchase_line(已下單/…/補送中 →
//      部分到貨/已到貨,received_qty 分批累計)
import { DCLogic, mountApp } from './runtime.js';
import { TABLE_COLUMNS } from './schema.js'; // 帳號/權限欄位取自單一結構來源(見 ./schema.js)

class Component extends DCLogic {
  state = {
    splashOn: true, splashHide: false, // 開機 splash 疊層(蓋住載入/驗證),就緒後淡出露出底下畫面
    // 全新裝置(還沒選過地點)落在「開始設定」嚮導;用過的裝置回營運總覽
    screen: (() => { try { return localStorage.getItem('bakery_loc_v2') ? 'overview' : 'setup'; } catch (e) { return 'overview'; } })(),
    ready: false,
    loc: (() => { try { return localStorage.getItem('bakery_loc_v2') || 'LOC-A'; } catch (e) { return 'LOC-A'; } })(),
    plan: [ // 展示預設;連上資料庫後由 plan_draft 表覆蓋(loadPlan)
      { pid: 'PRD-03', qty: '40', date: this.TODAY, time: '15:30' },
      { pid: 'PRD-01', qty: '32', date: this.addDays(this.TODAY, 1), time: '08:00' },
      { pid: 'PRD-04', qty: '30', date: this.TODAY, time: '16:00' }
    ],
    planPid: 'PRD-02', planQty: '24', planDate: this.TODAY, planTime: '16:30', picker: null,
    cart: {},
    invTab: 'ingredient', selItem: 'ING-001', countQty: '', prodView: 'board', viewAs: 'all', traceId: '', tlZoom: 1, ganttZoom: 1, lineSel: 'LINE-01', stationSel: 'all', lineCfg: false,
    poLines: [], poSupplier: 'SUP-01', poEta: '', poName: '', rcvVals: {}, retOpen: '', retVals: {}, retMode: {},
    puView: 'store', toDraft: [], tsAddIng: 'ING-001', tsAddQty: '25000',
    tsNeed: '', tsUrgent: false, reqName: '', reqSpec: '', reqQty: '', reqUrgent: false, newStoreName: '', mergePick: {},
    selIng: 'ING-001', draft: null,
    selProd: 'PRD-01', bomAddIng: 'ING-003', bomAddQty: '100',
    finVals: {}, closing: {}, closed: false, toast: '',
    apiUrl: '', sid: '', gKey: '', gCid: '', connBusy: false, confirmWipe: null,
    catOpen: false, newCat: ''
  };

  // 連線預設值來自 window.BAKERY_CFG(部署時由 GitHub secrets 注入;本機以 google-config.local.js 覆蓋);
  // 佔位符(__XXX__)或空值視為未設定 — 純本地示範模式,「資料連線」頁仍可手動填。
  DEF = (() => {
    const c = window.BAKERY_CFG || {};
    const v = s => (typeof s === 'string' && s && !/^__[A-Z_]+__$/.test(s)) ? s : '';
    return { sid: v(c.sheetId), apiKey: v(c.apiKey), clientId: v(c.clientId), gasUrl: v(c.gasUrl) };
  })();

  componentDidMount() {
    window.__dc = this; // debug hook(自動化測試/主控台除錯用)
    this._bootT0 = Date.now(); // 開機時間戳 — 載入/驗證畫面自此至少顯示 1.5 秒
    this._clk = setInterval(() => this.forceUpdate(), 1000); // 秒級倒數計時 + 頂欄時鐘
    // 圖表拖拽平移(甘特/人員時間軸)
    this._pmv = e => { if (this._panSt) this._panSt.el.scrollLeft = this._panSt.sl - (e.clientX - this._panSt.x); };
    this._pup = () => { this._panSt = null; };
    window.addEventListener('mousemove', this._pmv);
    window.addEventListener('mouseup', this._pup);
    import('./db.js').then(m => {
      this.db = new m.DB();
      this.db.onRemote = (ok, msg) => { if (!ok && msg) this.notify('⚠ ' + msg); };
      this.db.onAuthFail = () => this.doLogout('⚠ 登入已過期,請重新登入');
      // 樂觀鎖 conflict:整表覆寫被拒(他人先改過)→ 重新載入最新版,使用者再重做剛才的變更
      this.db.onConflict = sheet => {
        if (sheet === 'user_account' || sheet === 'role_permission') this.loadAccounts(true);
        else this.startCloud();
      };
      const c = this.db.cfg || {};
      this.setState({
        ready: true,
        apiUrl: c.url || this.DEF.gasUrl,
        sid: c.sid || this.DEF.sid,
        gKey: c.apiKey || this.DEF.apiKey,
        gCid: c.clientId || this.DEF.clientId
      });
      this.prunePlan();
      this.initAuth();
    }).catch(e => console.error('db load failed', e));
  }

  // ── 登入閘門(Phase 1:Google 登入 + email 名單)──
  // 啟用條件:方案 B 雲端模式 + 有 OAuth Client ID;本地示範模式(無連線設定)不需登入。
  // 名單驗證在 Apps Script 後端(user_account 分頁),前端閘門只是 UX — 沒 token 後端一律拒絕。
  authRequired() { return !!(this.db && this.db.mode === 'cloud' && this.db.cfg.kind === 'gas' && this.db.cfg.url && this.DEF.clientId); }
  initAuth() {
    // splash 疊層蓋住載入/驗證;就緒後(自開機起至少 1.5 秒)先把目標畫面渲染在底下,再讓 splash 淡出露出它
    const reveal = setDest => setTimeout(() => {
      setDest();
      this.setState({ splashHide: true });            // 觸發 CSS opacity 過場淡出
      setTimeout(() => this.setState({ splashOn: false }), 900); // 淡出結束後移除疊層
    }, Math.max(0, 1500 - (Date.now() - (this._bootT0 || Date.now()))));
    if (!this.authRequired()) { reveal(() => { this.setState({ authState: 'off' }); this.startCloud(); }); return; }
    const a = this.db.getAuth();
    if (a && a.token) {
      this.db.whoami()
        .then(j => {
          if (j && j.ok) {
            // whoami 每次回最新角色/地點/權限 — 名單或矩陣調整,重新整理即生效
            reveal(() => {
              this.setState({ authState: 'ok', authName: a.name || j.name || '', authEmail: a.email || j.email || '', authRole: j.role || a.role || '', authLocs: j.location_ids !== undefined ? j.location_ids : (a.locs || ''), authPerms: j.perms !== undefined ? j.perms : (a.perms || null) });
              this.startCloud();
            });
          }
          else reveal(() => { this.db.clearAuth(); this.setState({ authState: 'login' }); });
        })
        .catch(() => reveal(() => { this.setState({ authState: 'login' }); this.notify('✕ 連不上登入伺服器 — 請檢查網路後重試'); }));
    } else reveal(() => this.setState({ authState: 'login' }));
  }
  // ── 權限(Phase 2):角色×畫面矩陣(role_permission 分頁)+ 地點範圍 ──
  // 後端才是強制點;這裡只決定 UI 顯示。未登入模式(本地示範)全部開放。
  hasPerm(k) {
    if (this.state.authState !== 'ok') return true;
    const p = this.state.authPerms;
    if (!p) return this.state.authRole === 'super_admin' ? true : k !== 'screen.accounts'; // 舊版後端沒回 perms → 相容:除帳號管理外開放
    return p.indexOf('*') >= 0 || p.indexOf(k) >= 0;
  }
  canCost() { return this.hasPerm('feature.cost'); } // 成本可見:門市角色(含店長)一律隱藏
  allowedLoc(id) {
    if (this.state.authState !== 'ok') return true;
    const l = String(this.state.authLocs || '').trim();
    if (!l || l.toUpperCase() === 'ALL') return true;
    return l.split(/[|;,]/).map(x => x.trim()).indexOf(id) >= 0;
  }
  startCloud() {
    if (!this.db || this.db.mode !== 'cloud') return;
    this.notify('☁ 雲端模式 — 正在從 Google Sheet 同步…');
    this.db.pullAll()
      .then(async missing => {
        // Sheet 還沒建表 → 自動補建再拉一次(migrate 保留資料;setup 會清空,絕不自動跑)
        if (missing.length && this.db.cfg.kind === 'gas') {
          this.notify('Sheet 缺分頁,自動補建中(保留現有資料)…');
          try { await this.db.api('action=migrate'); missing = await this.db.pullAll(); } catch (e2) { }
        }
        this.prunePlan();
        this.notify(missing.length ? '⚠ 已同步,但 Sheet 缺分頁:' + missing.join('、') + ' — 後端可能是舊版:重貼最新 apps-script → migrate → 部署新版本' : '✓ 已載入 Google Sheet 最新資料,每筆過帳將即時同步');
      })
      .catch(() => this.notify('✕ Sheet 同步失敗,先用本地快取(到「資料連線」檢查)'));
  }
  // Google Sign-In 按鈕:GIS 腳本非同步載入 → 輪詢到可用才 render;morph-skip 保住注入的 iframe
  mountGsi(el) {
    if (el) this._gsiEl = el;
    if (!this._gsiEl || this.state.authState !== 'login') return;
    const g = window.google && window.google.accounts && window.google.accounts.id;
    if (!g) { clearTimeout(this._gsiT); this._gsiT = setTimeout(() => this.mountGsi(), 300); return; }
    if (this._gsiEl.__gsiMounted) return;
    this._gsiEl.__gsiMounted = true;
    if (!this._gsiInit) { this._gsiInit = true; g.initialize({ client_id: this.DEF.clientId, callback: r => this.handleCredential(r) }); }
    g.renderButton(this._gsiEl, { theme: 'outline', size: 'large', width: 320, text: 'signin_with', locale: 'zh_TW' });
  }
  handleCredential(resp) {
    if (!resp || !resp.credential) return;
    this.setState({ authBusy: true });
    this.db.login(resp.credential)
      .then(j => {
        if (j && j.ok) {
          this.db.setAuth({ token: j.token, name: j.name, email: j.email, role: j.role, locs: j.location_ids || '', perms: j.perms || null });
          // 剛登入 → 依角色落在第一個允許的畫面(重新整理則維持原畫面,由 renderVals 守門)
          const perms = j.perms || null;
          const has = k => !perms ? true : (perms.indexOf('*') >= 0 || perms.indexOf('screen.' + k) >= 0);
          const land = ['overview', 'production', 'sales', 'purchase', 'inventory', 'products', 'setup'].find(has) || 'overview';
          this.setState({ authState: 'ok', authBusy: false, authName: j.name || '', authEmail: j.email || '', authRole: j.role || '', authLocs: j.location_ids || '', authPerms: j.perms || null, screen: land });
          this.notify('✓ 歡迎,' + (j.name || j.email));
          this.startCloud();
        } else if (j && j.error === 'not_on_list') {
          this.setState({ authState: 'blocked', authBusy: false, blockedEmail: j.email || '' });
        } else {
          this.setState({ authBusy: false });
          this.notify('✕ 登入失敗:' + ((j && j.error) || '未知錯誤'));
        }
      })
      .catch(err => { this.setState({ authBusy: false }); this.notify('✕ 登入失敗:' + err); });
  }
  doLogout(msg) {
    if (this.db) this.db.clearAuth();
    const g = window.google && window.google.accounts && window.google.accounts.id;
    if (g && g.disableAutoSelect) g.disableAutoSelect(); // 下次登入顯示帳號選擇器
    if (this._gsiEl) this._gsiEl.__gsiMounted = false;
    this.setState({ authState: this.authRequired() ? 'login' : 'off', authName: '', authEmail: '', authRole: '', authLocs: '', authPerms: null, authBusy: false, accUsers: null, accPerms: null });
    if (msg) this.notify(msg);
  }
  // ── 帳號與角色(super_admin):user_account / role_permission 直接讀寫 Sheet ──
  ACC_HEAD = TABLE_COLUMNS.user_account;
  PERM_HEAD = TABLE_COLUMNS.role_permission;
  ROLE_OPTS = [
    { id: 'super_admin', name: 'super_admin(系統管理員)' },
    { id: 'central_ops', name: 'central_ops(中央倉)' },
    { id: 'store_admin', name: 'store_admin(店長)' },
    { id: 'store_kitchen', name: 'store_kitchen(內場)' },
    { id: 'store_front', name: 'store_front(外場)' }
  ];
  loadAccounts(force) {
    if (this.state.accBusy) return;
    if (!force && this.state.accUsers) return;
    this.setState({ accBusy: true });
    const objs = j => {
      if (!j || !j.ok || !j.rows || !j.rows.length) return [];
      const h = j.rows[0].map(String);
      return j.rows.slice(1).map(r => { const o = {}; h.forEach((k, i) => o[k] = r[i] === undefined || r[i] === null ? '' : String(r[i])); return o; });
    };
    Promise.all([this.db.api('action=list&sheet=user_account'), this.db.api('action=list&sheet=role_permission')])
      .then(([a, b]) => {
        if (a && a.rev != null) this.db.rev['user_account'] = a.rev; // 記住版號:之後 saveAccounts 的整表覆寫帶 baseRev 給後端比對
        if (b && b.rev != null) this.db.rev['role_permission'] = b.rev;
        this.setState({ accUsers: objs(a), accPerms: objs(b), accBusy: false, accErr: (a && a.ok) ? '' : (a && a.error || '讀取失敗') });
      })
      .catch(err => this.setState({ accBusy: false, accErr: String(err) }));
  }
  // 防抖寫回(和 po_draft 同節奏):整表覆寫,後端限 super_admin
  saveAccounts() {
    clearTimeout(this._accT);
    this._accT = setTimeout(() => {
      const rows = (this.state.accUsers || []).map(u => this.ACC_HEAD.map(h => u[h] === undefined ? '' : u[h]));
      this.db.sendRemote({ action: 'replace', sheet: 'user_account', headers: this.ACC_HEAD, rows });
    }, 800);
  }
  savePerms() {
    clearTimeout(this._permT);
    this._permT = setTimeout(() => {
      const rows = (this.state.accPerms || []).map(p => this.PERM_HEAD.map(h => p[h] === undefined ? '' : p[h]));
      this.db.sendRemote({ action: 'replace', sheet: 'role_permission', headers: this.PERM_HEAD, rows });
    }, 800);
  }

  // 永遠使用「真實今天」(本地時區);跨日自動更新
  get TODAY() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  // 交易時間戳:日期 + 時:分。用 'T' 分隔寫入 — Sheet 會存成 datetime(或原文),
  // 兩種情況 pullAll 的 norm() 都能還原;用空格分隔會被 Sheet 截成純日期(時間遺失)
  get NOW() {
    const d = new Date();
    return this.TODAY + 'T' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }
  day(s) { return String(s || '').slice(0, 10); }
  C = { red: '#c11f28', amb: '#946800', grn: '#177a4c', acc: '#0e7490', mut: '#66707f', bd: '#e3e6eb' };

  n(v) { const x = parseFloat(v); return isNaN(x) ? 0 : x; }
  fmt(v, d) { return this.n(v).toLocaleString('en-US', { maximumFractionDigits: d === undefined ? 0 : d }); }
  t(name) { return this.db ? this.db.t[name] : []; }
  ing(id) { return this.t('ingredient').find(r => r.ingredient_id === id); }
  prod(id) { return this.t('product').find(r => r.product_id === id); }
  nameOf(id) { const p = this.prod(id); if (p) return p.name; const g = this.ing(id); return g ? g.name : id; }
  // 免備資源:明確名單(與匯入解析器的水規則一致)— 隨取即用,不開補製單、不列缺料
  // 注意:不能用 成本/批產/BOM 推斷 — 髒資料會誤判(水掛了殘留BOM)、真菌種(原始菌種 uc=0 無BOM)會被誤傷
  FREE_RES = ['水', '後加水', '酵母溶解水', '冰塊', '冰水', '熱水', '溫水'];
  isFreeRes(g) { return !!g && g.purchase_unit === '自製' && this.FREE_RES.indexOf(String(g.name || '').trim()) >= 0; }
  isIngId(id) { return !this.prod(id) && !!this.ing(id); }
  // 工序推進:status = '投料'(第 0 道)或 '投料@N'(進行到第 N 道,0-based)
  isIssued(st) { return String(st || '').indexOf('投料') === 0; }
  stepIdx(o) { const m = String(o.status).match(/^投料@(\d+)/); return m ? parseInt(m[1], 10) : 0; }
  advanceStep(o, opStaff) {
    const steps = this.routingOf(o.product_id);
    const cur = this.stepIdx(o);
    if (!steps.length || cur >= steps.length) return;
    const vA = opStaff || this.state.viewAs; if (vA && vA !== 'all' && this.holderOf(o.prod_id) !== vA) this.assign(o, vA, '接手工序');
    this.setOrderStatus(o.prod_id, '投料@' + (cur + 1));
    // 記錄「進入下一道工序 / 完成最後工序」的時刻(給倒數計時與追溯用);全部視角時記在目前負責人名下
    const op = (vA && vA !== 'all') ? vA : this.holderOf(o.prod_id);
    if (op) this.db.append('assignment', { assign_id: this.db.nextId('assignment', 'assign_id', 'A-', 4), prod_id: o.prod_id, step_no: cur + 1, staff_id: op, ts: this.NOW });
    const nxt = steps[cur + 1];
    this.notify(nxt
      ? '✓ ' + this.nameOf(o.product_id) + ':「' + steps[cur].step_name + '」完成 → 進入「' + nxt.step_name + '」' + (cur + 2 >= steps.length ? '(最後工序)' : '')
      : '✓ ' + this.nameOf(o.product_id) + ':「' + steps[cur].step_name + '」完成 — 全工序結束,請到入庫欄盤點實際數量');
  }
  // 流水線工位
  stationsOf(lid) { return this.t('station').filter(s => s.line_id === lid).sort((a, b) => this.n(a.seq) - this.n(b.seq)); }
  stationOfStep(stations, stepName) {
    for (const st of stations) if (String(st.match || '').split('|').some(k => k && String(stepName).indexOf(k) >= 0)) return st.station_id;
    return null;
  }
  // 依地點結存:未帶 loc 時 = 本店;歷史資料(無 location_id)一律視為本店
  stock(type, id, loc) { const L = loc || this.THIS_LOC; let s = 0; for (const l of this.t('stock_ledger')) if (l.item_type === type && l.item_id === id && (l.location_id || 'LOC-A') === L) s += (l.direction === 'in' ? 1 : -1) * this.n(l.qty); return s; }
  bomOf(pid) { return this.t('bom').filter(b => b.product_id === pid); }
  routingOf(pid) { return this.t('routing').filter(r => r.product_id === pid).sort((a, b) => this.n(a.step_no) - this.n(b.step_no)); }
  unitCost(pid) {
    const p = this.prod(pid); if (!p) return 0; let c = 0;
    for (const b of this.bomOf(pid)) { const g = this.ing(b.ingredient_id); c += this.n(b.qty_per_yield) * (g ? this.n(g.latest_unit_cost) : 0); }
    return c / (this.n(p.default_yield) || 1);
  }
  // 製作天數:由工序總工時自動推算(≤8 小時當日完成;之後每滿 24 小時 +1 天)
  totalMinOf(pid) { return this.routingOf(pid).reduce((a, r) => a + this.n(r.duration_min), 0); }
  leadOf(pid) { const t = this.totalMinOf(pid); return t ? Math.max(0, Math.ceil((t - 480) / 1440)) : 0; }
  addDays(ds, n) { const d = new Date(ds + 'T00:00:00'); d.setDate(d.getDate() + n); const p = x => String(x).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); } // 用本地日期組字串;toISOString 會因時區倒退一天
  notify(msg) { clearTimeout(this._tt); this.setState({ toast: msg }); this._tt = setTimeout(() => this.setState({ toast: '' }), 4000); }
  // ── 生產計畫草稿持久化:plan_draft 表(每地點一份)——離開/重整/切店都能載回 ──
  loadPlan(loc) {
    const L = loc || this.THIS_LOC;
    // Sheet 會把時間格('15:30')轉成 1899-12-30 起算的日期時間 → 讀回時清洗:日期取 YYYY-MM-DD(1899/1900 視為空)、時間取 HH:mm
    const dOf = v => { const m = /(\d{4})-(\d{2}-\d{2})/.exec(String(v || '')); return m && +m[1] >= 2000 ? m[1] + '-' + m[2] : ''; };
    const tOf = v => { const m = /(\d{1,2}:\d{2})/.exec(String(v || '')); return m ? m[1] : ''; };
    // 目標完成 = 日期 + 時間兩欄:各自讀不到就從另一欄撈(Sheet 可能把 '2026-07-08 15:30' 整串塞在其中一欄)
    return this.t('plan_draft').filter(r => (r.location_id || 'LOC-A') === L && this.prod(r.product_id))
      .map(r => ({ pid: r.product_id, qty: r.qty, date: dOf(r.finish_date) || dOf(r.finish_time), time: tOf(r.finish_time) || tOf(r.finish_date), who: r.staff_id || '' }));
  }
  persistPlan() {
    if (!this.db) return;
    const others = this.t('plan_draft').filter(r => (r.location_id || 'LOC-A') !== this.THIS_LOC);
    const mine = this.state.plan.map((l, i) => ({ line_id: 'PL-' + this.THIS_LOC.slice(-1) + '-' + (i + 1), product_id: l.pid, qty: l.qty, finish_date: l.date || '', finish_time: l.time || '', staff_id: l.who || '', location_id: this.THIS_LOC }));
    this.db.replace('plan_draft', others.concat(mine));
  }
  // 所有計畫列變更走這裡:更新 state + 防抖 800ms 寫回資料庫(雲端同步)
  setPlan(plan, extra) {
    this.setState(Object.assign({ plan }, extra || {}));
    clearTimeout(this._planT);
    this._planT = setTimeout(() => this.persistPlan(), 800);
  }
  // 移除指向已刪除產品的計畫列(資料載入/同步後呼叫);載入後以 plan_draft / po_draft 為準
  prunePlan() {
    this.setState(Object.assign({ plan: this.loadPlan() }, this.loadPoDraft()));
  }
  // ── 進貨單草稿持久化:po_draft 表 — 可累積一天/幾天再送出採購單 ──
  loadPoDraft() {
    const rows = this.t('po_draft').filter(r => this.ing(r.ingredient_id));
    const nameBySup = {}, etaBySup = {};
    let nm = '', eta = '';
    for (const r of rows) {
      if (r.doc_name) nm = r.doc_name;
      if (r.eta) eta = r.eta;
      const g = this.ing(r.ingredient_id);
      const sid = (g && g.default_supplier_id) || '';
      if (r.name_ov !== '' && r.name_ov !== undefined) nameBySup[sid] = r.name_ov;
      if (r.eta_ov) etaBySup[sid] = r.eta_ov;
    }
    return { poLines: rows.map(r => ({ iid: r.ingredient_id, units: r.units, price: r.unit_price, tax: r.tax_rate || '' })), poName: nm, poEta: eta, poNameBySup: nameBySup, poEtaBySup: etaBySup };
  }
  persistPoDraft() {
    if (!this.db) return;
    const S = this.state;
    this.db.replace('po_draft', (S.poLines || []).map((l, i) => {
      const g = this.ing(l.iid);
      const sid = (g && g.default_supplier_id) || '';
      const nov = (S.poNameBySup || {})[sid];
      return { line_id: 'PD-' + (i + 1), ingredient_id: l.iid, units: l.units, unit_price: l.price, tax_rate: l.tax === undefined ? '' : l.tax, doc_name: S.poName || '', eta: S.poEta || '', name_ov: nov === undefined ? '' : nov, eta_ov: (S.poEtaBySup || {})[sid] || '', location_id: this.CENTRAL };
    }));
  }
  // 進貨單草稿任何變更走這裡:更新 state + 防抖 800ms 寫回資料庫(雲端同步)
  setPoDraft(patch) {
    this.setState(patch);
    clearTimeout(this._poT);
    this._poT = setTimeout(() => this.persistPoDraft(), 800);
  }
  // 進貨單改價 → 回寫原料主檔報價(稅前/含稅/稅率),防抖 800ms 同步 Sheet;與「原料目錄」改價同一條路徑
  // 空白/0 不覆寫(避免清空輸入框時把報價歸零);多行連改會合併成一次 replace
  syncQuoteFromPO(iid, prePrice, rate) {
    if (!iid || !this.db) return;
    const pre = +this.n(prePrice).toFixed(4);
    if (!(pre > 0)) return;
    this._quoteQ = this._quoteQ || {};
    this._quoteQ[iid] = { pre, rate: this.n(rate) > 0 ? this.n(rate) : 1 };
    clearTimeout(this._quoteT);
    this._quoteT = setTimeout(() => {
      const q = this._quoteQ; this._quoteQ = {};
      if (!Object.keys(q).length) return;
      let hit = false;
      const next = this.t('ingredient').map(g => {
        const e = q[g.ingredient_id]; if (!e) return g;
        hit = true;
        return Object.assign({}, g, { quote_price_pre: String(e.pre), quote_price: String(+(e.pre * e.rate).toFixed(2)), tax_rate: String(e.rate) });
      });
      if (hit) this.db.replace('ingredient', next);
    }, 800);
  }
  // 人員/認領:目前負責人 = assignment 表該單最後一筆
  holderOf(pid) { const a = this.t('assignment').filter(r => r.prod_id === pid); return a.length ? a[a.length - 1].staff_id : ''; }
  staffName(id) { const s = this.t('staff').find(x => x.staff_id === id); return s ? s.name : id; }
  assign(o, sid, note) {
    if (!sid || !this.db) return;
    this.db.append('assignment', { assign_id: this.db.nextId('assignment', 'assign_id', 'A-', 4), prod_id: o.prod_id, step_no: this.stepIdx(o), staff_id: sid, ts: this.NOW });
    this.notify('✓ ' + (note || '已指派') + ':' + this.nameOf(o.product_id) + ' → ' + this.staffName(sid));
  }
  armWipe(which) {
    if (this.state.confirmWipe !== which) {
      this.setState({ confirmWipe: which });
      this.notify('⚠ 此操作會清空' + (which === 'tx' ? '所有交易與流水(保留原料/產品/配方)' : '全部資料(含主資料)') + (this.db && this.db.mode === 'cloud' ? ',並同步清空 Sheet' : '') + ' — 再點一次確認');
      clearTimeout(this._wt); this._wt = setTimeout(() => this.setState({ confirmWipe: null }), 6000);
      return;
    }
    clearTimeout(this._wt);
    const wiped = this.db.wipe(which === 'tx');
    this.setState({
      loc: (() => { try { return localStorage.getItem('bakery_loc_v2') || 'LOC-A'; } catch (e) { return 'LOC-A'; } })(),
      confirmWipe: null, plan: [], cart: {}, poLines: [], toDraft: [], closing: {}, closed: false, finVals: {}, draft: null,
      selItem: (this.t('ingredient')[0] || {}).ingredient_id || '',
      selIng: (this.t('ingredient')[0] || {}).ingredient_id || '',
      selProd: (this.t('product')[0] || {}).product_id || ''
    });
    this.notify('✓ 已清空 ' + wiped.length + ' 張表' + (this.db.mode === 'cloud' ? ',Sheet 對應分頁已同步清空(僅留表頭)' : '(僅本地)') + ' — 可開始建立真實主資料');
  }
  armSeed() {
    if (this.state.confirmWipe !== 'seed') {
      this.setState({ confirmWipe: 'seed' });
      this.notify('⚠ 此操作會用「示範快照」覆寫目前所有資料' + (this.db && this.db.mode === 'cloud' ? ',並同步覆寫 Google Sheet 全部分頁' : '(本地)') + ' — 再點一次確認');
      clearTimeout(this._wt); this._wt = setTimeout(() => this.setState({ confirmWipe: null }), 6000);
      return;
    }
    if (!this.db) return;
    const n = this.db.restoreSeed();
    this.setState({
      confirmWipe: null, plan: [], cart: {}, poLines: [], toDraft: [], closing: {}, closed: false, finVals: {}, draft: null, traceId: '',
      selItem: (this.t('ingredient')[0] || {}).ingredient_id || '',
      selIng: (this.t('ingredient')[0] || {}).ingredient_id || '',
      selProd: (this.t('product')[0] || {}).product_id || ''
    });
    this.notify('✓ 已還原示範快照(' + n + ' 張表)' + (this.db.mode === 'cloud' ? ',Sheet 已同步覆寫 — 可直接從示範資料開始設定' : '(僅本地)'));
  }
  chartPan(elKey) { return e => { const el = this[elKey]; if (!el) return; this._panSt = { el, x: e.clientX, sl: el.scrollLeft }; e.preventDefault(); }; }
  dayLabel(ds) {
    const diff = Math.round((new Date((ds || this.TODAY) + 'T00:00:00') - new Date(this.TODAY + 'T00:00:00')) / 86400000);
    return diff === 0 ? '今日' : diff === 1 ? '明日' : diff === 2 ? '後天' : diff > 2 ? '+' + diff + ' 天' : '過期';
  }
  tag(color) { return 'color:' + color + ';border-color:' + color; }

  // ── 中央倉/叫貨調撥 ──
  // 操作視角 = 頂部切換器選的地點(state.loc);中央倉 = LOC-C。
  // 所有交易表都帶 location_id 欄,同一原料在各地點有獨立結存;交易寫入一律蓋當前視角的戳記。
  get THIS_LOC() { return (this.state && this.state.loc) || 'LOC-A'; }
  CENTRAL = 'LOC-C';
  CENOK = { setup: 1, inventory: 1, purchase: 1, ingredients: 1, locations: 1, suppliers: 1, connect: 1, products: 1, accounts: 1 }; // 中央倉視角可用頁(不烘焙、不零售)
  lt(name) { const L = this.THIS_LOC; return this.t(name).filter(r => (r.location_id || 'LOC-A') === L); } // 依當前視角過濾交易列
  setLoc(id, silent) {
    if (id === this.THIS_LOC) return;
    try { localStorage.setItem('bakery_loc_v2', id); } catch (e) { }
    // 購物車/叫貨草稿是「這個地點」的暫存 → 切換即清空;排程計畫改由 plan_draft 表載回該地點自己的草稿
    const patch = Object.assign({ loc: id, cart: {}, toDraft: [], plan: this.loadPlan(id), closing: {}, closed: false, draft: null }, this.loadPoDraft()); // 進貨草稿存 po_draft 表(中央專用),切視角不遺失
    if (id === this.CENTRAL) { if (!this.CENOK[this.state.screen]) patch.screen = 'purchase'; if (this.state.puView === 'store') patch.puView = 'central'; }
    else if (this.state.screen === 'purchase' && this.state.puView === 'central') patch.puView = 'store';
    this.setState(patch);
    if (!silent) this.notify('已切換視角:' + this.locName(id) + (id === this.CENTRAL ? '(出貨/採購/庫存)' : ''));
  }
  locName(id) { const l = this.t('location').find(x => x.location_id === id); return l ? l.name : id; }
  // ── 產品地點歸屬(product.location_id)：中央看全部或篩一店；門市只見自己的；舊資料/空值歸第一門市 ──
  firstStoreLoc() { const s = this.t('location').find(l => l.type !== 'central'); return s ? s.location_id : 'LOC-A'; }
  prodLocOf(p) { return (p && p.location_id) || ''; }
  prodShared(p) { const l = this.prodLocOf(p); return !l || l === 'ALL'; } // 空值/ALL = 共用(全門市)
  prodLocList(p) { const l = this.prodLocOf(p); return this.prodShared(p) ? [] : l.split(/[|;,]/).map(x => x.trim()).filter(Boolean); } // 指定門市清單(空=共用),多店用 | 分隔
  prodAtStore(p, loc) { return this.prodShared(p) || this.prodLocList(p).indexOf(loc) >= 0; }
  prodScope() { return this.THIS_LOC === this.CENTRAL ? (this.state.prodLoc || 'all') : this.THIS_LOC; }
  // 分類參照:ingredient.category 可存 category_id(CAT-xx)或舊資料直接存名稱 — 讀取一律解析成名稱顯示
  catName(v) { if (!v) return ''; const c = this.t('category').find(x => x.category_id === v); return c ? c.name : v; }
  catIdOf(name) { const c = this.t('category').find(x => x.name === name); return c ? c.category_id : name; }
  gcat(g) { return this.catName((g || {}).category); }
  // ── 分類排序:pills 依 category.display_order;拖曳時即時重排(預覽),放開才回寫 1..N ──
  // ── 匯入 Excel 半成品(semi-import.json 由仁愛店成本表離線解析而來)──
  // 併入現有資料:同名跳過不覆蓋;半成品已有配方的不動;佔位名「配方#行號」可在目錄改名
  async importSemis() {
    let data;
    try { data = await (await fetch('semi-import.json?v=' + Date.now())).json(); } catch (e) { this.notify('✕ 讀不到 semi-import.json:' + e); return; }
    if (!data || !Array.isArray(data.raws) || !Array.isArray(data.semis)) { this.notify('✕ semi-import.json 格式不對'); return; }
    const db = this.db;
    const norm = s => String(s || '').trim().replace(/[\s　]+/g, ''); // 名稱比對:去頭尾與全形空白
    // 兩段式確認:先報告現況(接在現有最大編號後 append),再按一次才執行
    if (!this.state.importArm) {
      let mx0 = 0; for (const g of this.t('ingredient')) { const m = String(g.ingredient_id).match(/(\d+)$/); if (m) mx0 = Math.max(mx0, +m[1]); }
      this.setState({ importArm: true });
      setTimeout(() => this.setState({ importArm: false }), 8000);
      this.notify('目前原料 ' + this.t('ingredient').length + ' 筆、最大編號 ING-' + mx0 + ' → 匯入將從 ING-' + (mx0 + 1) + ' 往後 append;同名原料(去空白比對)沿用現有 id,BOM 一律接 id。8 秒內再按一次「匯入半成品(Excel)」執行');
      return;
    }
    this.setState({ importArm: false });
    try {
    // 廠商 find-or-create(含「總公司」= 由中央供貨、實際廠商待補)
    let sups = this.t('supplier').slice();
    let supMax = 0; for (const s of sups) { const m = String(s.supplier_id).match(/(\d+)$/); if (m) supMax = Math.max(supMax, +m[1]); }
    const supId = {}; for (const s of sups) supId[s.name] = s.supplier_id;
    let addedSup = 0;
    for (const nm of data.suppliers) if (!supId[nm]) { supMax++; const id = 'SUP-' + String(supMax).padStart(2, '0'); sups.push({ supplier_id: id, name: nm, contact_person: '', phone: '', email: '', address: '', payment_terms: '' }); supId[nm] = id; addedSup++; }
    if (addedSup) db.replace('supplier', sups);
    // 分類:麵團 / 半成品_麵包 / 半成品_西點
    let cats = this.t('category').slice();
    let catMax = 0; for (const c of cats) { const m = String(c.category_id).match(/(\d+)$/); if (m) catMax = Math.max(catMax, +m[1]); }
    const catIdMap = {}; for (const c of cats) catIdMap[c.name] = c.category_id;
    for (const nm of ['麵團', '半成品_麵包', '半成品_西點', '發酵種']) if (!catIdMap[nm]) { catMax++; const id = 'CAT-' + String(catMax).padStart(2, '0'); cats.push({ category_id: id, name: nm, display_order: '' }); catIdMap[nm] = id; }
    db.replace('category', cats);
    // 原料+半成品 find-or-create by 名稱
    let ings = this.t('ingredient').slice();
    let ingMax = 0; for (const g of ings) { const m = String(g.ingredient_id).match(/(\d+)$/); if (m) ingMax = Math.max(ingMax, +m[1]); }
    const byName = {}; for (const g of ings) byName[norm(g.name)] = g.ingredient_id;
    const mk = obj => { ingMax++; const id = 'ING-' + String(ingMax).padStart(3, '0'); ings.push(Object.assign({ ingredient_id: id }, obj)); byName[norm(obj.name)] = id; return id; };
    let addedRaw = 0, addedSemi = 0, matchedRaw = 0;
    for (const r of data.raws) {
      if (byName[norm(r.name)]) { matchedRaw++; continue; }
      const hasSup = !!r.sup; // 無廠商(水/雜項)→ 標自製,不進採購建議
      mk({ name: r.name, category: this.catIdOf('其他'), base_unit: 'g', purchase_unit: r.punit || (hasSup ? '包' : '自製'), conversion_rate: String(r.conv || 1000), safety_stock: '0', latest_unit_cost: String(r.uc || 0), quote_price: String(+((r.quote || 0) * (r.tax || 1)).toFixed(2)), quote_price_pre: String(r.quote || 0), tax_rate: String(r.tax || 1), shelf_life_days: '90', default_supplier_id: hasSup ? supId[r.sup] : '', batch_yield: '' });
      addedRaw++;
    }
    for (const s of data.semis) {
      if (byName[norm(s.name)]) continue;
      mk({ name: s.name, category: catIdMap[s.cat] || this.catIdOf('其他'), base_unit: 'g', purchase_unit: '自製', conversion_rate: '1', safety_stock: '0', latest_unit_cost: String(s.uc || 0), quote_price: '0', tax_rate: '1.0', shelf_life_days: '3', default_supplier_id: '', batch_yield: String(s.yield || '') });
      addedSemi++;
    }
    // 被引用但沒有配方 block 的半成品 → 佔位自製(之後補配方)
    for (const s of data.semis) for (const l of s.bom) if (l.isRef && !byName[norm(l.name)]) {
      mk({ name: l.name, category: catIdMap[s.cat] || this.catIdOf('其他'), base_unit: 'g', purchase_unit: '自製', conversion_rate: '1', safety_stock: '0', latest_unit_cost: '0', quote_price: '0', tax_rate: '1.0', shelf_life_days: '3', default_supplier_id: '', batch_yield: '' });
      addedSemi++;
    }
    db.replace('ingredient', ings);
    // BOM:只寫目前沒有配方的半成品;跳過自我引用
    let boms = this.t('bom').slice();
    let bMax = 0; for (const b of boms) { const m = String(b.bom_id).match(/(\d+)$/); if (m) bMax = Math.max(bMax, +m[1]); }
    const hasBom = {}; for (const b of boms) hasBom[b.product_id] = 1;
    let bomAdded = 0;
    for (const s of data.semis) {
      const sid = byName[norm(s.name)];
      if (!sid || hasBom[sid]) continue;
      for (const l of s.bom) {
        const iid = byName[norm(l.name)];
        if (!iid || iid === sid) continue;
        bMax++; boms.push({ bom_id: 'B-' + bMax, product_id: sid, ingredient_id: iid, qty_per_yield: String(l.qty) });
        bomAdded++;
      }
    }
    db.replace('bom', boms);
    // 製成品(產品):名稱比對沿用現有 PRD id;新品 append;BOM=每 1 個用量(default_yield=1);售價待補
    let prodsAdded = 0, prodBomAdded = 0, matchedProd = 0;
    if (Array.isArray(data.prods)) {
      const plist = this.t('product').slice();
      let pMax = 0; for (const p of plist) { const m = String(p.product_id).match(/(\d+)$/); if (m) pMax = Math.max(pMax, +m[1]); }
      const pByName = {}; for (const p of plist) pByName[norm(p.name)] = p.product_id;
      for (const pr of data.prods) {
        if (pByName[norm(pr.name)]) { matchedProd++; continue; }
        pMax++; const pid = 'PRD-' + String(pMax).padStart(2, '0');
        plist.push({ product_id: pid, name: pr.name, type: pr.type, sale_price: '0', lead_days: '0', default_yield: '1', is_active: pr.inactive ? 'FALSE' : 'TRUE' });
        pByName[norm(pr.name)] = pid; prodsAdded++;
      }
      db.replace('product', plist);
      const boms2 = this.t('bom').slice();
      let bMax2 = 0; for (const b of boms2) { const m = String(b.bom_id).match(/(\d+)$/); if (m) bMax2 = Math.max(bMax2, +m[1]); }
      const hasBom2 = {}; for (const b of boms2) hasBom2[b.product_id] = 1;
      for (const pr of data.prods) {
        const pid = pByName[norm(pr.name)];
        if (!pid || hasBom2[pid]) continue;
        for (const l of pr.bom) {
          const iid = byName[norm(l.name)];
          if (!iid) continue;
          bMax2++; boms2.push({ bom_id: 'B-' + bMax2, product_id: pid, ingredient_id: iid, qty_per_yield: String(l.qty) });
          prodBomAdded++;
        }
      }
      db.replace('bom', boms2);
    }
    this.forceUpdate();
    this.notify('✓ 匯入完成:半成品 +' + addedSemi + '、新原料 +' + addedRaw + '(沿用 ' + matchedRaw + ' 筆)、廠商 +' + addedSup + '、半成品配方 ' + bomAdded + ' 行;產品 +' + prodsAdded + '(沿用 ' + matchedProd + ')、產品配方 ' + prodBomAdded + ' 行 — 產品售價/工序待補');
    } catch (err) { console.error('IMPORT-ERR', err); this.notify('✕ 匯入失敗:' + (err && err.message || err)); }
  }
  // 還原誤匯入:刪除編號大於界線的原料 + 其配方行/備料配置(分類、廠商保留)
  revertImport() {
    const v = window.prompt('刪除「編號大於此數字」的原料(含其配方行與備料配置),用於還原誤匯入:', '520');
    if (v === null) return;
    const n = parseInt(v, 10);
    if (isNaN(n) || n <= 0) { this.notify('請輸入數字(例 520)'); return; }
    const gone = {};
    const keep = this.t('ingredient').filter(g => { const m = String(g.ingredient_id).match(/(\d+)$/); const ok = !m || +m[1] <= n; if (!ok) gone[g.ingredient_id] = 1; return ok; });
    const cnt = Object.keys(gone).length;
    if (!cnt) { this.notify('沒有編號 > ING-' + n + ' 的原料'); return; }
    this.db.replace('ingredient', keep);
    // 產品同步還原(第二個界線,留空 = 不動產品)
    const v2 = window.prompt('同時刪除「編號大於此數字」的產品(PRD)?留空 = 不動產品:', '');
    let pCnt = 0;
    if (v2 !== null && String(v2).trim() !== '') {
      const n2 = parseInt(v2, 10);
      if (!isNaN(n2) && n2 > 0) {
        const keepP = this.t('product').filter(p => { const m = String(p.product_id).match(/(\d+)$/); const ok = !m || +m[1] <= n2; if (!ok) gone[p.product_id] = 1; return ok; });
        pCnt = this.t('product').length - keepP.length;
        this.db.replace('product', keepP);
      }
    }
    this.db.replace('bom', this.t('bom').filter(b => !gone[b.product_id] && !gone[b.ingredient_id]));
    this.db.replace('location_stock', this.t('location_stock').filter(r => !gone[r.ingredient_id]));
    this.forceUpdate();
    this.notify('✓ 已刪除:原料 ' + cnt + ' 筆' + (pCnt ? '、產品 ' + pCnt + ' 筆' : '') + ' 與相關配方行;要重匯請再按「匯入半成品(Excel)」兩次');
  }
  catFullBase() { // 主檔全序(沒 order 的照列序排後面)
    return this.t('category')
      .map((c, i) => ({ n: c.name, o: this.n(c.display_order) > 0 ? this.n(c.display_order) : 1000 + i }))
      .sort((a, b) => a.o - b.o).map(x => x.n);
  }
  catFull() { return this.state.catPrev || this.catFullBase(); } // 拖曳中回傳預覽順序
  catSorted(names) { // 資料中出現的分類,依主檔序;不在主檔的排最後
    const full = this.catFull();
    return names.filter(n => full.indexOf(n) >= 0).sort((a, b) => full.indexOf(a) - full.indexOf(b))
      .concat(names.filter(n => full.indexOf(n) < 0));
  }
  // 拖曳滑過某 pill:即時把 dragged 移過去(在前 → 插到 target 後;在後 → 插到 target 前)
  catHover(target) {
    const dragged = this.state.dragCat;
    if (!dragged || dragged === target) return;
    let full = (this.state.catPrev || this.catFullBase()).slice();
    if (full.indexOf(dragged) < 0) full.push(dragged);
    if (target === '__front') {
      full = full.filter(n => n !== dragged); full.unshift(dragged);
    } else {
      const di = full.indexOf(dragged), ti0 = full.indexOf(target);
      if (ti0 < 0) return;
      full.splice(di, 1);
      const ti = full.indexOf(target);
      full.splice(di < ti0 ? ti + 1 : ti, 0, dragged);
    }
    const cur = this.state.catPrev;
    if (cur && cur.join('|') === full.join('|')) return;
    this.setState({ catPrev: full });
  }
  // 放開:把預覽順序寫入分類主檔(display_order 1..N;不在主檔的分類自動補建)
  catCommit() {
    const full = this.state.catPrev;
    if (!full) { if (this.state.dragCat) this.setState({ dragCat: '' }); return; }
    let rows = this.t('category').slice();
    let mxId = 0; for (const c of rows) { const m = String(c.category_id).match(/(\d+)$/); if (m) mxId = Math.max(mxId, parseInt(m[1], 10)); }
    for (const n of full) if (!rows.some(c => c.name === n)) { mxId++; rows.push({ category_id: 'CAT-' + String(mxId).padStart(2, '0'), name: n }); }
    const pos = {}; full.forEach((n, i) => { pos[n] = i + 1; });
    rows = rows.map(c => Object.assign({}, c, { display_order: String(pos[c.name] || full.length + 1) }));
    rows.sort((a, b) => this.n(a.display_order) - this.n(b.display_order));
    this.db.replace('category', rows);
    this.setState({ dragCat: '', catPrev: null });
    this.notify('✓ 分類順序已更新,寫入 category.display_order');
  }
  catPill(c, activeName, onGo) { // 共用 pill props(庫存/原料目錄兩條分類列)
    const S = this.state;
    const isAll = c === '全部';
    const dragging = S.dragCat === c;
    return {
      style: (activeName ? 'background:#0e7490;border-color:#0e7490;color:#fff' : (dragging ? 'color:#0e7490;border-color:#0e7490;background:#e0f0f4' : 'color:#66707f;border-color:#e3e6eb'))
        + (isAll ? ';cursor:pointer' : ';cursor:grab') + (dragging ? ';border-style:dashed;opacity:.55' : '') + ';user-select:none',
      go: onGo,
      drag: !isAll,
      onDragStart: e => { this.setState({ dragCat: c }); try { e.dataTransfer.setData('text/plain', c); e.dataTransfer.effectAllowed = 'move'; } catch (x) { } },
      onDragOver: e => { e.preventDefault(); this.catHover(isAll ? '__front' : c); },
      onDrop: e => { e.preventDefault(); this.catCommit(); },
      onDragEnd: () => this.catCommit()
    };
  }
  // ── 全域可搜尋下拉(取代所有原生 select):一次只開一個,fixed 定位不被卡片裁切 ──
  // 用法:模板放觸發器(X.txt/X.meta/X.open),邏輯給 X = this.ddBtn(options, value, onPick, placeholder?)
  // options: [{id, name, meta?}] — meta 淡灰小字(如 廠商・分類)
  ddBtn(options, value, onPick, ph) {
    const cur = options.find(o => String(o.id) === String(value));
    return {
      txt: cur ? cur.name : (ph || '—'),
      meta: cur && cur.meta ? ' · ' + cur.meta : '',
      open: e => {
        e.stopPropagation();
        const r = e.currentTarget.getBoundingClientRect();
        this._dd = { options, value: cur ? cur.id : '', onPick };
        this.setState({ dd: { x: r.left, y: r.bottom, w: r.width, search: '' } });
        setTimeout(() => { const el = document.getElementById('dd-search'); if (el) el.focus(); }, 30); // 開啟即聚焦搜尋框,直接打字
      }
    };
  }
  ddClose() { this._dd = null; this.setState({ dd: null }); }
  // 多選下拉:build() 每次回傳最新 [{id,name,checked,toggle}];點選只切換不關閉,點背景才關
  ddBtnMulti(summary, build) {
    return {
      txt: summary,
      open: e => {
        e.stopPropagation();
        const r = e.currentTarget.getBoundingClientRect();
        this._dd = { multi: true, build };
        this.setState({ dd: { x: r.left, y: r.bottom, w: r.width, search: '' } });
      }
    };
  }
  // 帳號「門市範圍」的即時選項:ALL(不限)+ 各門市;讀 live state,面板開著也隨切換更新
  locItems(i) {
    const u = (this.state.accUsers || [])[i]; if (!u) return [];
    const cur = String(u.location_ids || '').trim();
    const isAll = !cur || cur.toUpperCase() === 'ALL';
    const list = isAll ? [] : cur.split(/[|;,]/).map(x => x.trim()).filter(Boolean);
    const setLoc = v => { const arr = (this.state.accUsers || []).slice(); arr[i] = Object.assign({}, arr[i], { location_ids: v }); this.setState({ accUsers: arr }); this.saveAccounts(); };
    const items = [{ id: 'ALL', name: '全部門市(不限)', checked: isAll, toggle: () => setLoc('ALL') }];
    this.t('location').forEach(l => {
      items.push({
        id: l.location_id, name: l.name, checked: !isAll && list.indexOf(l.location_id) >= 0,
        toggle: () => {
          const set = {}; (isAll ? [] : list).forEach(x => { set[x] = 1; });
          if (set[l.location_id]) delete set[l.location_id]; else set[l.location_id] = 1;
          const ids = this.t('location').map(x => x.location_id).filter(id2 => set[id2]);
          setLoc(ids.length ? ids.join('|') : 'ALL');
        }
      });
    });
    return items;
  }
  ddVals() {
    const D = this.state.dd, cfg = this._dd;
    if (!D || !cfg) return { ddBackdrop: 'display:none', ddPanelStyle: 'display:none', ddSearchStyle: 'display:none', ddSearch: '', onDdSearch: () => { }, ddCloseFn: () => { }, ddList: [], ddListEmpty: 'display:none', onDdScroll: () => { }, ddMoreTxt: '', ddMoreStyle: 'display:none' };
    if (cfg.multi) {
      const items = cfg.build();
      const q = (D.search || '').trim().toLowerCase();
      const all = items.filter(o => !q || this.lmatch(q, [String(o.name)]));
      const w = Math.max(D.w, 220);
      return {
        ddBackdrop: 'position:fixed;inset:0;z-index:59',
        ddPanelStyle: 'position:fixed;left:' + Math.max(8, Math.min(D.x, (window.innerWidth || 1200) - w - 12)) + 'px;top:' + Math.min(D.y + 4, (window.innerHeight || 800) - 330) + 'px;width:' + w + 'px;z-index:60;background:#fff;border:1px solid #e3e6eb;border-radius:8px;box-shadow:0 8px 24px rgba(16,24,40,.14);padding:8px;display:flex;flex-direction:column;gap:6px;box-sizing:border-box',
        ddSearchStyle: items.length > 8 ? 'width:100%;box-sizing:border-box' : 'display:none',
        ddSearch: D.search || '',
        onDdSearch: e => this.setState({ dd: Object.assign({}, D, { search: e.target.value }) }),
        ddCloseFn: () => this.ddClose(),
        onDdScroll: () => { },
        ddMoreTxt: '', ddMoreStyle: 'display:none',
        ddList: all.map(o => ({
          name: o.name, meta: '',
          checkStyle: 'font-size:18px;flex:none;' + (o.checked ? 'color:#0e7490' : 'color:#c6ccd4'),
          checkIcon: o.checked ? 'check_box' : 'check_box_outline_blank',
          rowStyle: 'padding:6px 10px;cursor:pointer;font-size:12.5px;border-radius:6px;display:flex;align-items:center;gap:8px' + (o.checked ? ';background:#eef6f8' : ''),
          pick: o.toggle
        })),
        ddListEmpty: all.length ? 'display:none' : 'padding:10px;font-size:12px;color:#66707f'
      };
    }
    const q = (D.search || '').trim().toLowerCase();
    const all = cfg.options.filter(o => !q || this.lmatch(q, [String(o.name), String(o.meta || ''), String(o.id || '')]));
    // 懶載入:先渲染 150 筆,捲到底自動加載;無上限
    const show = D.show || 150;
    const list = all.slice(0, show);
    const w = Math.max(D.w, 240);
    return {
      ddBackdrop: 'position:fixed;inset:0;z-index:59',
      ddPanelStyle: 'position:fixed;left:' + Math.max(8, Math.min(D.x, (window.innerWidth || 1200) - w - 12)) + 'px;top:' + Math.min(D.y + 4, (window.innerHeight || 800) - 330) + 'px;width:' + w + 'px;z-index:60;background:#fff;border:1px solid #e3e6eb;border-radius:8px;box-shadow:0 8px 24px rgba(16,24,40,.14);padding:8px;display:flex;flex-direction:column;gap:6px;box-sizing:border-box',
      ddSearchStyle: cfg.options.length > 8 ? 'width:100%;box-sizing:border-box' : 'display:none',
      ddSearch: D.search || '',
      onDdSearch: e => this.setState({ dd: Object.assign({}, D, { search: e.target.value, show: 150 }) }),
      ddCloseFn: () => this.ddClose(),
      onDdScroll: e => {
        const el = e.target;
        if (list.length < all.length && el.scrollTop + el.clientHeight >= el.scrollHeight - 80) {
          this.setState({ dd: Object.assign({}, D, { show: show + 200 }) });
        }
      },
      ddMoreTxt: list.length < all.length ? '已顯示 ' + list.length + ' / ' + all.length + ' — 捲動載入更多…' : '',
      ddMoreStyle: list.length < all.length ? 'padding:7px 10px;font-size:11px;color:#9aa1ab;text-align:center' : 'display:none',
      ddList: list.map(o => ({
        name: o.name, meta: o.meta ? ' · ' + o.meta : '',
        checkStyle: 'display:none', checkIcon: '',
        rowStyle: 'padding:6px 10px;cursor:pointer;font-size:12.5px;border-radius:6px' + (String(o.id) === String(cfg.value) ? ';background:#e0f0f4' : ''),
        pick: () => { const f = cfg.onPick; this.ddClose(); f(o.id); }
      })),
      ddListEmpty: list.length ? 'display:none' : 'padding:10px;font-size:12px;color:#66707f'
    };
  }

  // ── 清單工具:搜尋(任何欄位含編號)+ 欄頭排序;state[key]={q, sort:{key,dir}} ──
  lq(key, ph) { const cur = this.state[key] || {}; return { val: cur.q || '', ph: ph || '搜尋:名稱/編號/任何欄位', onQ: e => { const c2 = this.state[key] || {}; this.setState({ [key]: Object.assign({}, c2, { q: e.target.value }) }); } }; }
  // 模糊比對:空白切詞、每個詞都要命中;另把 - _ / . 去掉再比一次 → 「sup 25」「sup25」都找得到 SUP-25
  lmatch(q, texts) {
    const toks = q.split(/\s+/).filter(Boolean);
    if (!toks.length) return true;
    const hay = texts.join(' ').toLowerCase();
    const hay2 = hay.replace(/[-_/.\s]/g, '');
    return toks.every(t => { const t2 = t.replace(/[-_/.]/g, ''); return hay.indexOf(t) >= 0 || (t2 && hay2.indexOf(t2) >= 0); });
  }
  lfilter(key, arr, fields) {
    const q = ((this.state[key] || {}).q || '').trim().toLowerCase();
    if (!q) return arr;
    return arr.filter(r => this.lmatch(q, fields.map(f => String((typeof f === 'function' ? f(r) : r[f]) || ''))));
  }
  lsort(key, arr, vals) {
    const s = (this.state[key] || {}).sort;
    if (!s || !vals[s.key]) return arr;
    return arr.slice().sort((a, b) => {
      const va = vals[s.key](a), vb = vals[s.key](b);
      return (typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb), 'zh-Hant')) * s.dir;
    });
  }
  lhead(key, cols) { // cols: [sortKey|'', label, extraStyle?];sortKey 空 = 不可排序;點三下還原
    const s = (this.state[key] || {}).sort || null;
    return cols.map(c => ({
      label: c[1],
      arrow: c[0] && s && s.key === c[0] ? (s.dir > 0 ? ' ↑' : ' ↓') : '',
      style: (c[2] || '') + ';white-space:nowrap' + (c[0] ? ';cursor:pointer;user-select:none' : '') + (c[0] && s && s.key === c[0] ? ';color:#0e7490' : ''),
      onSort: c[0] ? () => { const cur = this.state[key] || {}; const ns = !s || s.key !== c[0] ? { key: c[0], dir: 1 } : (s.dir > 0 ? { key: c[0], dir: -1 } : null); this.setState({ [key]: Object.assign({}, cur, { sort: ns }) }); } : () => { }
    }));
  }
  // 進貨單預帶「稅前單價」:優先稅前報價;沒有 → 含稅報價÷稅率;再沒有 → 最新單價(含稅/每g)×換算÷稅率
  // 欄位語意:quote_price=含稅報價(廠商常直接報含稅)、quote_price_pre=稅前報價
  poPrice(g) {
    const rate = this.n(g.tax_rate) || 1;
    const pre = this.n(g.quote_price_pre), qp = this.n(g.quote_price);
    const conv = this.n(g.conversion_rate) || 1;
    const v = pre > 0 ? pre : qp > 0 ? qp / rate : this.n(g.latest_unit_cost) * conv / rate;
    return String(+v.toFixed(2));
  }
  // 原料的預設稅率(1.0 免稅 / 1.05 含營業稅);進貨單每行可改
  poTax(g) { const r = this.n(g && g.tax_rate); return r > 0 ? r : 1; }
  lnTax(ln) { const r = this.n(ln && ln.tax); return r > 0 ? r : this.poTax(this.ing(ln.iid)); }
  // ── 地點備料配置(location_stock):有列 = 該地點備這個料,安全庫存各地點獨立 ──
  locRow(loc, iid) { return this.t('location_stock').find(r => r.location_id === loc && r.ingredient_id === iid); }
  stocksAt(loc, iid) { return !!this.locRow(loc, iid); }
  safetyAt(loc, iid) { const r = this.locRow(loc, iid); return r ? this.n(r.safety_stock) : 0; }
  setLocStock(loc, iid, on, safety) {
    let rows = this.t('location_stock').filter(r => !(r.location_id === loc && r.ingredient_id === iid));
    if (on) rows = rows.concat([{ location_id: loc, ingredient_id: iid, safety_stock: String(this.n(safety)) }]);
    this.db.replace('location_stock', rows);
    this.forceUpdate();
  }
  // 調撥以包裝為單位:外購原料整包(袋/箱/瓶)進出,不走散裝;自製半成品維持 g
  isPackaged(g) { return !!g && g.purchase_unit !== '自製' && this.n(g.conversion_rate) > 1; }
  pkgCeil(g, q) { if (!this.isPackaged(g)) return Math.max(1, Math.ceil(this.n(q))); const c = this.n(g.conversion_rate); return Math.max(1, Math.ceil((this.n(q) - 1e-9) / c)) * c; }
  pkgTxt(g, q) { if (!this.isPackaged(g)) return ''; const c = this.n(g.conversion_rate); const n0 = this.n(q) / c; return this.fmt(n0, n0 % 1 ? 1 : 0) + ' ' + (g.purchase_unit || '包'); }
  addDraft(iid, qty, stay) {
    const g = this.ing(iid) || {};
    if (this.state.toDraft.some(l => l.iid === iid)) {
      this.notify('「' + (g.name || iid) + '」已在叫貨單草稿中');
      if (!stay) this.setState({ puView: 'store' });
      return;
    }
    const rq = this.pkgCeil(g, qty); // 需 5g 也進位到 1 整包
    let cfgNote = '';
    if (g.ingredient_id && !this.stocksAt(this.THIS_LOC, g.ingredient_id)) { this.setLocStock(this.THIS_LOC, g.ingredient_id, true, 0); cfgNote = ';已自動加入本店備料清單(之後可設安全庫存)'; }
    this.setState({ toDraft: this.state.toDraft.concat([{ iid, qty: String(rq) }]), puView: 'store' });
    this.notify('✓ 已加入叫貨單草稿:' + (g.name || iid) + (this.isPackaged(g) ? ' ' + this.pkgTxt(g, rq) + '(' + this.fmt(rq) + ' ' + (g.base_unit || 'g') + ')— 依包裝進位' : '') + cfgNote);
  }
  submitTO() {
    let adjusted = 0;
    const lines = this.state.toDraft.filter(l => this.ing(l.iid) && this.n(l.qty) > 0).map(l => {
      const g = this.ing(l.iid);
      const rq = this.pkgCeil(g, l.qty); // 送出前強制整包(手改的散量自動進位)
      if (rq !== this.n(l.qty)) adjusted++;
      return { iid: l.iid, qty: rq };
    });
    if (!lines.length) { this.notify('叫貨單沒有明細 — 從左側建議加入或手動加原料'); return; }
    const id = this.db.nextId('transfer_order', 'to_id', 'TO-', 4);
    const urg = this.state.tsUrgent;
    this.db.append('transfer_order', { to_id: id, from_loc: this.CENTRAL, to_loc: this.THIS_LOC, status: '叫貨', request_date: this.NOW, ship_date: '', receive_date: '', need_date: this.state.tsNeed || this.addDays(this.TODAY, 1), urgent: urg ? 'TRUE' : '' });
    for (const l of lines) this.db.append('transfer_line', { tl_id: this.db.nextId('transfer_line', 'tl_id', 'TL-', 3), to_id: id, ingredient_id: l.iid, qty: this.n(l.qty) });
    this.setState({ toDraft: [], tsUrgent: false });
    this.notify('✓ ' + id + ' 已送出叫貨(' + lines.length + ' 項' + (urg ? '・急件' : '') + (adjusted ? ';' + adjusted + ' 項散量已進位整包' : '') + ')— 等待中央倉出貨(頁籤 ②)');
  }
  setTOStatus(id, patch) {
    this.db.replace('transfer_order', this.t('transfer_order').map(t => t.to_id === id ? Object.assign({}, t, patch) : t));
  }
  shipTO(t) {
    const lines = this.t('transfer_line').filter(l => l.to_id === t.to_id);
    const lack = lines.filter(l => this.stock('ingredient', l.ingredient_id, this.CENTRAL) < this.n(l.qty)).map(l => (this.ing(l.ingredient_id) || {}).name || l.ingredient_id);
    if (lack.length) { this.notify('✕ 中央庫存不足:' + lack.join('、') + ' — 到「③ 中央採購」進貨後再出'); return; }
    for (const l of lines) {
      const g = this.ing(l.ingredient_id);
      this.db.append('stock_ledger', { ledger_id: this.db.nextId('stock_ledger', 'ledger_id', 'L-', 4), item_type: 'ingredient', item_id: l.ingredient_id, direction: 'out', qty: this.n(l.qty), source_type: 'transfer_out', source_id: t.to_id, unit_cost: g ? g.latest_unit_cost : 0, txn_date: this.NOW, location_id: this.CENTRAL });
    }
    this.setTOStatus(t.to_id, { status: '已出貨', ship_date: this.NOW });
    this.notify('✓ ' + t.to_id + ' 已出貨 → ' + this.locName(t.to_loc) + ',中央庫存已扣(在途)' + (t.to_loc === this.THIS_LOC ? ' — 回頁籤 ① 確認收貨' : ''));
  }
  recvTO(t) {
    if (t.status !== '已出貨') { this.notify('此單不在「已出貨」狀態,無法收貨'); return; }
    const lines = this.t('transfer_line').filter(l => l.to_id === t.to_id);
    for (const l of lines) {
      const g = this.ing(l.ingredient_id);
      this.db.append('stock_ledger', { ledger_id: this.db.nextId('stock_ledger', 'ledger_id', 'L-', 4), item_type: 'ingredient', item_id: l.ingredient_id, direction: 'in', qty: this.n(l.qty), source_type: 'transfer_in', source_id: t.to_id, unit_cost: g ? g.latest_unit_cost : 0, txn_date: this.NOW, location_id: this.THIS_LOC });
    }
    this.setTOStatus(t.to_id, { status: '已收貨', receive_date: this.NOW });
    this.notify('✓ ' + t.to_id + ' 已收貨:' + lines.length + ' 項原料入本店庫存,排程與投料即可使用');
  }
  cancelTO(t) {
    if (t.status !== '叫貨') { this.notify('已出貨的叫貨單不可取消'); return; }
    this.setTOStatus(t.to_id, { status: '取消' });
    this.notify('已取消 ' + t.to_id);
  }
  // 部分出貨(短缺分配):有貨的先出,短缺量轉一張新叫貨單(補貨單),採購到貨後再出
  partialShipTO(t) {
    const mine = this.t('transfer_line').filter(l => l.to_id === t.to_id);
    const plan = mine.map(l => {
      const g = this.ing(l.ingredient_id);
      const cs = Math.max(0, this.stock('ingredient', l.ingredient_id, this.CENTRAL));
      // 外購原料部分出貨也要整包:可出量向下取整包(半包不出)
      const avail = this.isPackaged(g) ? Math.floor(cs / this.n(g.conversion_rate)) * this.n(g.conversion_rate) : cs;
      const s = Math.min(this.n(l.qty), avail);
      return { l, s, r: this.n(l.qty) - s };
    });
    if (!plan.some(p => p.s > 0)) { this.notify('✕ 中央庫存為 0,無法部分出貨 — 先到「③ 中央採購」進貨'); return; }
    if (!plan.some(p => p.r > 0)) { this.shipTO(t); return; }
    for (const p of plan) if (p.s > 0) {
      const g = this.ing(p.l.ingredient_id);
      this.db.append('stock_ledger', { ledger_id: this.db.nextId('stock_ledger', 'ledger_id', 'L-', 4), item_type: 'ingredient', item_id: p.l.ingredient_id, direction: 'out', qty: p.s, source_type: 'transfer_out', source_id: t.to_id, unit_cost: g ? g.latest_unit_cost : 0, txn_date: this.NOW, location_id: this.CENTRAL });
    }
    const keep = [];
    for (const x of this.t('transfer_line')) {
      if (x.to_id !== t.to_id) { keep.push(x); continue; }
      const p = plan.find(y => y.l.tl_id === x.tl_id);
      if (p && p.s > 0) keep.push(Object.assign({}, x, { qty: p.s }));
    }
    this.db.replace('transfer_line', keep);
    const boId = this.db.nextId('transfer_order', 'to_id', 'TO-', 4);
    this.db.append('transfer_order', { to_id: boId, from_loc: this.CENTRAL, to_loc: t.to_loc, status: '叫貨', request_date: this.NOW, ship_date: '', receive_date: '', need_date: t.need_date || '', urgent: t.urgent || '' });
    for (const p of plan) if (p.r > 0) this.db.append('transfer_line', { tl_id: this.db.nextId('transfer_line', 'tl_id', 'TL-', 3), to_id: boId, ingredient_id: p.l.ingredient_id, qty: p.r });
    this.setTOStatus(t.to_id, { status: '已出貨', ship_date: this.NOW });
    this.notify('✓ ' + t.to_id + ' 部分出貨 → ' + this.locName(t.to_loc) + ';短缺 ' + plan.filter(p => p.r > 0).length + ' 項轉補貨單 ' + boId + '(採購到貨後再出)');
  }

  // ── 新原料申請(門市送 → 中央歸戶)──
  submitReq() {
    const nm = (this.state.reqName || '').trim();
    if (!nm) { this.notify('請輸入原料名稱'); return; }
    if (this.t('ingredient').some(g => g.name === nm)) { this.notify('目錄已有「' + nm + '」— 直接在「中央目錄」加入本店即可'); return; }
    const urg = this.state.reqUrgent;
    this.db.append('ingredient_request', { req_id: this.db.nextId('ingredient_request', 'req_id', 'REQ-', 3), location_id: this.THIS_LOC, name: nm, spec: this.state.reqSpec || '', weekly_qty: this.n(this.state.reqQty) || '', urgent: urg ? 'TRUE' : '', status: '待處理', ingredient_id: '', request_date: this.NOW, done_date: '' });
    this.setState({ reqName: '', reqSpec: '', reqQty: '', reqUrgent: false });
    this.notify('✓ 申請已送出' + (urg ? '(急件)' : '') + ' — 中央倉「原料目錄」頁處理');
  }
  setReqStatus(id, patch) { this.db.replace('ingredient_request', this.t('ingredient_request').map(r => r.req_id === id ? Object.assign({}, r, patch) : r)); }
  acceptReq(r) {
    const id = this.db.nextId('ingredient', 'ingredient_id', 'ING-', 3);
    this.db.replace('ingredient', this.t('ingredient').concat([{ ingredient_id: id, name: r.name, category: this.catIdOf('其他'), base_unit: 'g', purchase_unit: '包', conversion_rate: '1000', safety_stock: '0', latest_unit_cost: '0', quote_price: '0', tax_rate: '1.05', shelf_life_days: '90', default_supplier_id: (this.t('supplier')[0] || {}).supplier_id || '' }]));
    this.setLocStock(this.CENTRAL, id, true, 0);
    this.setLocStock(r.location_id, id, true, 0);
    this.setReqStatus(r.req_id, { status: '已加入', ingredient_id: id, done_date: this.TODAY });
    this.setState({ selIng: id, draft: null });
    this.notify('✓ 已轉入目錄 ' + id + ':' + r.name + ' — 請在下方編輯補供應商/換算/單價;已自動配置到' + this.locName(r.location_id));
  }
  mergeReq(r, iid) {
    if (!iid) { this.notify('先在「併入現有…」下拉選要併入的原料'); return; }
    const g = this.ing(iid) || {};
    this.setLocStock(r.location_id, iid, true, this.safetyAt(r.location_id, iid) || this.n(g.safety_stock) || 0);
    this.setReqStatus(r.req_id, { status: '併入', ingredient_id: iid, done_date: this.TODAY });
    this.notify('✓ 已併入現有「' + (g.name || iid) + '」並配置到' + this.locName(r.location_id) + '(品名以目錄為準)');
  }
  rejectReq(r) { this.setReqStatus(r.req_id, { status: '婉拒', done_date: this.TODAY }); this.notify('已婉拒:' + r.name); }
  // 一鍵載入常用烘焙原料(只補目錄沒有的;供應商/單價之後補)
  loadCommon() {
    const L = [['高筋麵粉', '麵粉', 'g', '袋', 25000, 10000, 180], ['中筋麵粉', '麵粉', 'g', '袋', 22000, 5000, 180], ['低筋麵粉', '麵粉', 'g', '袋', 22000, 5000, 180], ['裸麥粉 T130', '麵粉', 'g', '袋', 25000, 0, 180], ['全麥粉', '麵粉', 'g', '袋', 25000, 0, 180], ['細砂糖', '糖', 'g', '包', 10000, 3000, 365], ['糖粉', '糖', 'g', '包', 3000, 0, 365], ['蜂蜜', '糖', 'g', '桶', 3000, 0, 365], ['無鹽發酵奶油', '油脂', 'g', '箱', 10000, 5000, 60], ['片狀奶油', '油脂', 'g', '箱', 10000, 0, 60], ['橄欖油', '油脂', 'ml', '瓶', 1000, 0, 365], ['全脂鮮奶', '乳品', 'ml', '瓶', 1000, 4000, 10], ['動物性鮮奶油', '乳品', 'ml', '瓶', 1000, 0, 14], ['雞蛋', '蛋', 'g', '箱', 10000, 3000, 21], ['法國海鹽', '鹽', 'g', '包', 1000, 500, 730], ['速發酵母', '發酵種', 'g', '包', 500, 200, 365], ['魯邦種(老麵)', '發酵種', 'g', '自製', 1, 0, 3], ['杏仁粒', '堅果果乾', 'g', '包', 1000, 0, 180], ['核桃', '堅果果乾', 'g', '包', 1000, 0, 180], ['70% 巧克力', '其他', 'g', '箱', 5000, 0, 365]];
    const have = {}; for (const g of this.t('ingredient')) have[g.name] = 1;
    let mx = 0; for (const g of this.t('ingredient')) { const m = String(g.ingredient_id).match(/(\d+)$/); if (m) mx = Math.max(mx, parseInt(m[1], 10)); }
    const rows = this.t('ingredient').slice(); let added = 0;
    for (const it of L) {
      if (have[it[0]]) continue;
      mx++; added++;
      rows.push({ ingredient_id: 'ING-' + String(mx).padStart(3, '0'), name: it[0], category: this.catIdOf(it[1]), base_unit: it[2], purchase_unit: it[3], conversion_rate: String(it[4]), safety_stock: String(it[5]), latest_unit_cost: '0', quote_price: '0', tax_rate: it[3] === '自製' ? '1.0' : '1.05', shelf_life_days: String(it[6]), default_supplier_id: '' });
    }
    if (!added) { this.notify('常用清單的品項目錄裡都有了'); return; }
    this.db.replace('ingredient', rows);
    const cats = {}; for (const c of this.t('category')) cats[c.name] = 1;
    const newCats = []; for (const it of L) if (!cats[it[1]]) { cats[it[1]] = 1; newCats.push(it[1]); }
    if (newCats.length) this.db.replace('category', this.t('category').concat(newCats.map((n, i) => ({ category_id: 'CAT-' + String(90 + i), name: n }))));
    this.setState({ selIng: (rows[0] || {}).ingredient_id || '', draft: null });
    this.notify('✓ 已載入 ' + added + ' 項常用原料 — 請逐筆補「預設供應商」與「最新單價」;各店再自行加入本店備料');
  }

  parseTarget(line) {
    const dayDiff = Math.round((new Date((line.date || this.TODAY) + 'T00:00:00') - new Date(this.TODAY + 'T00:00:00')) / 86400000);
    const m = String(line.time || '17:00').match(/(\d{1,2}):(\d{2})/); if (!m) return dayDiff * 1440 + 1020;
    return dayDiff * 1440 + parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  }
  fmtMin(mins) {
    const day = Math.floor(mins / 1440); const r = ((mins % 1440) + 1440) % 1440;
    const hh = String(Math.floor(r / 60)).padStart(2, '0'); const mm = String(r % 60).padStart(2, '0');
    return (day === 1 ? '明 ' : day === 2 ? '後 ' : day < 0 ? '昨 ' : day > 2 ? '+' + day + 'd ' : '') + hh + ':' + mm;
  }
  scheduleCalc() {
    return this.state.plan.map(line => {
      const p = this.prod(line.pid); const steps = this.routingOf(line.pid);
      const target = this.parseTarget(line);
      let cursor = target; const arr = [];
      for (let i = steps.length - 1; i >= 0; i--) {
        const dur = this.n(steps[i].duration_min);
        arr.unshift({ name: steps[i].step_name, start: cursor - dur, end: cursor, eq: steps[i].equipment_id });
        cursor -= dur;
      }
      return { pid: line.pid, name: p ? p.name : line.pid, qty: this.n(line.qty), target, feed: arr.length ? arr[0].start : target - 60, steps: arr };
    });
  }
  mrpNeed() {
    const need = {};
    const add = (iid, q) => { need[iid] = (need[iid] || 0) + q; };
    // A. 排程計畫(尚未轉單)
    for (const line of this.state.plan) {
      const p = this.prod(line.pid); if (!p) continue;
      const ratio = this.n(line.qty) / (this.n(p.default_yield) || 1);
      for (const b of this.bomOf(line.pid)) add(b.ingredient_id, ratio * this.n(b.qty_per_yield));
    }
    // B. 草稿生產單(已轉單、還沒投料 → 原料仍要備):
    //    產品草稿單 → 加其 BOM 需求(含半成品行);半成品草稿/在製單 → 產出算進「待製供給」,草稿單另加其原料需求
    const semiSupply = {};
    for (const o of this.lt('production_order')) {
      const pid = o.product_id;
      const isSemi = this.isIngId(pid);
      if (isSemi && this.isIssued(o.status)) { semiSupply[pid] = (semiSupply[pid] || 0) + this.n(o.plan_qty); continue; } // 在製:原料已扣,產出在途
      if (o.status !== '草稿') continue;
      if (isSemi) {
        semiSupply[pid] = (semiSupply[pid] || 0) + this.n(o.plan_qty);
        const g = this.ing(pid); if (!g) continue;
        const by = this.n(g.batch_yield) || 1;
        for (const b of this.bomOf(pid)) add(b.ingredient_id, this.n(o.plan_qty) / by * this.n(b.qty_per_yield));
      } else {
        const p = this.prod(pid); if (!p) continue;
        const ratio = this.n(o.plan_qty) / (this.n(p.default_yield) || 1);
        for (const b of this.bomOf(pid)) add(b.ingredient_id, ratio * this.n(b.qty_per_yield));
      }
    }
    // C. 多階展開:自製半成品「淨缺口」(需求 − 庫存 − 待製/在製供給)按配方往下爆原料;最多 4 階、防循環
    const done = {};
    for (let lvl = 0; lvl < 4; lvl++) {
      let changed = false;
      for (const iid of Object.keys(need)) {
        if (done[iid]) continue;
        const g = this.ing(iid);
        if (!g || g.purchase_unit !== '自製') { done[iid] = 1; continue; }
        const bom = this.bomOf(iid);
        done[iid] = 1;
        if (!bom.length) continue;
        const shortfall = Math.max(0, need[iid] - this.stock('ingredient', iid) - (semiSupply[iid] || 0));
        if (shortfall <= 0) continue;
        const by = this.n(g.batch_yield) || 1;
        for (const b of bom) add(b.ingredient_id, shortfall / by * this.n(b.qty_per_yield));
        changed = true;
      }
      if (!changed) break;
    }
    return need;
  }
  shortages() {
    const need = this.mrpNeed(); const out = [];
    for (const g of this.t('ingredient')) {
      if (this.isFreeRes(g)) continue; // 水等免備資源不列缺料
      const cfg = this.stocksAt(this.THIS_LOC, g.ingredient_id);
      const nd = need[g.ingredient_id] || 0;
      // 未備料的原料:只要生產有需求(含自製半成品往下爆的原料)就要列出來 → 不能因為「沒備」而看不見
      if (!cfg && nd <= 0) continue;
      const s = this.stock('ingredient', g.ingredient_id);
      const shortSched = Math.max(0, nd - s), shortSafe = cfg ? Math.max(0, this.safetyAt(this.THIS_LOC, g.ingredient_id) - s) : 0;
      const short = Math.max(shortSched, shortSafe);
      if (short > 0) out.push({ g, s, nd, short, why: shortSched > 0 ? (cfg ? '排程缺口' : '排程缺口・未備料') : '低於安全庫存', noCfg: !cfg });
    }
    return out;
  }

  // ── 交易動作 ──
  makeOrders() {
    if (!this.db) return; let c = 0; const remaining = [];
    // 先算多階需求(plan 清空前):自備半成品要一併開補製單,不能忽略
    const need = this.mrpNeed();
    for (const line of this.state.plan) {
      const p = this.prod(line.pid);
      if (!p || !this.n(line.qty)) { remaining.push(line); continue; }
      const id = this.db.nextId('production_order', 'prod_id', 'P-', 4);
      this.db.append('production_order', { prod_id: id, product_id: line.pid, plan_qty: this.n(line.qty), start_date: this.TODAY, finish_date: line.date || this.addDays(this.TODAY, this.leadOf(line.pid)), status: '草稿', location_id: this.THIS_LOC });
      if (line.who) this.assign({ prod_id: id, product_id: line.pid, status: '草稿' }, line.who, '排程指派');
      c++;
    }
    // 自備半成品補製單:淨需求 = 展開需求 − 現有庫存 − 已開立未完成的單;本店不備的列入「向中央叫貨」提醒
    let prepC = 0; const prepTxt = [], transferTxt = [];
    for (const iid of Object.keys(need)) {
      const g = this.ing(iid);
      if (!g || g.purchase_unit !== '自製' || this.isFreeRes(g)) continue;
      let open = 0;
      for (const o of this.t('production_order')) if (o.product_id === iid && (o.status === '草稿' || this.isIssued(o.status)) && (o.location_id || 'LOC-A') === this.THIS_LOC) open += this.n(o.plan_qty);
      const net = Math.ceil(need[iid] - this.stock('ingredient', iid) - open);
      if (net <= 0) continue;
      if (!this.stocksAt(this.THIS_LOC, iid)) {
        // 本店沒配置:中央有備 → 提醒叫貨;誰都沒備(剛匯入的配方)→ 自動配置到本店、現做現用
        if (this.stocksAt(this.CENTRAL, iid)) { transferTxt.push(g.name + ' ' + this.fmt(net) + ' g'); continue; }
        this.setLocStock(this.THIS_LOC, iid, true, 0);
      }
      const id2 = this.db.nextId('production_order', 'prod_id', 'P-', 4);
      const lead = this.routingOf(iid).length ? Math.max(this.leadOf(iid), 0) : 1;
      this.db.append('production_order', { prod_id: id2, product_id: iid, plan_qty: net, start_date: this.TODAY, finish_date: this.addDays(this.TODAY, lead), status: '草稿', location_id: this.THIS_LOC });
      prepC++; prepTxt.push(g.name + ' ' + this.fmt(net) + ' g');
    }
    // L1 修復:已轉單的計畫列即刻清除,避免缺料需求被重複計算(並同步 plan_draft 表)
    this.setPlan(remaining, { screen: 'production' });
    this.notify('✓ 生產單 ' + c + ' 張' + (prepC ? ' + 自備半成品補製單 ' + prepC + ' 張:' + prepTxt.join('、') : '') + (transferTxt.length ? ';⚠ 本店不備、請向中央叫貨:' + transferTxt.join('、') : '') + ' — 對應計畫已清空,請於工位任務板投料');
  }
  setOrderStatus(id, status) {
    this.db.replace('production_order', this.t('production_order').map(o => o.prod_id === id ? Object.assign({}, o, { status }) : o));
  }
  issue(o) {
    const p = this.prod(o.product_id); const isIng = this.isIngId(o.product_id);
    // 自製半成品:plan_qty 為基本單位(g);配方=每批用量,ratio=計畫量/批次產出(batch_yield 未填視為 1 → 舊「每 1g」語意)
    const ratio = p ? this.n(o.plan_qty) / (this.n(p.default_yield) || 1) : this.n(o.plan_qty) / (this.n((this.ing(o.product_id) || {}).batch_yield) || 1);
    const bomL = this.bomOf(o.product_id);
    const lack = [];
    for (const b of bomL) {
      const g = this.ing(b.ingredient_id); const q = ratio * this.n(b.qty_per_yield);
      if (this.stock('ingredient', b.ingredient_id) < q) lack.push(g ? g.name : b.ingredient_id);
    }
    if (lack.length) { this.notify('✕ 本店庫存不足,無法投料:' + lack.join('、') + ' — 請到「叫貨與採購」向中央倉叫貨'); return; }
    for (const b of bomL) {
      const g = this.ing(b.ingredient_id); const q = Math.round(ratio * this.n(b.qty_per_yield) * 10) / 10;
      this.db.append('stock_ledger', { ledger_id: this.db.nextId('stock_ledger', 'ledger_id', 'L-', 4), item_type: 'ingredient', item_id: b.ingredient_id, direction: 'out', qty: q, source_type: 'production_out', source_id: o.prod_id, unit_cost: g ? g.latest_unit_cost : 0, txn_date: this.NOW, location_id: this.THIS_LOC });
    }
    this.setOrderStatus(o.prod_id, '投料');
    const vA = this.state.viewAs; if (vA && vA !== 'all' && this.holderOf(o.prod_id) !== vA) this.assign(o, vA, '認領開工');
    this.notify(isIng
      ? '✓ ' + o.prod_id + ' 開始續養「' + this.nameOf(o.product_id) + '」' + (bomL.length ? ',已扣餵養原料 ' + bomL.length + ' 項' : '(未設定配方,不扣料)') + ';完成後入庫原料'
      : '✓ ' + o.prod_id + ' 已投料,依配方扣減 ' + bomL.length + ' 項原料');
  }
  finish(o) {
    const isIng = this.isIngId(o.product_id);
    const plan = this.n(o.plan_qty);
    const actual = this.state.finVals[o.prod_id] === undefined || this.state.finVals[o.prod_id] === '' ? plan : this.n(this.state.finVals[o.prod_id]);
    // 半成品完成入庫:每 g 成本 = 批成本 ÷ 批次產出,並自動回寫「最新單價」→ 上層產品配方成本即時反映
    const uc = isIng ? (() => {
      const g0 = this.ing(o.product_id) || {};
      const by = this.n(g0.batch_yield) || 1;
      const bc = this.bomOf(o.product_id).reduce((a, b) => a + this.n(b.qty_per_yield) * this.n((this.ing(b.ingredient_id) || {}).latest_unit_cost), 0);
      if (bc > 0) {
        const v = bc / by;
        this.db.replace('ingredient', this.t('ingredient').map(x => x.ingredient_id === o.product_id ? Object.assign({}, x, { latest_unit_cost: v.toFixed(4) }) : x));
        return v.toFixed(3);
      }
      return this.n(g0.latest_unit_cost).toFixed(3);
    })() : this.unitCost(o.product_id).toFixed(2);
    this.db.append('stock_ledger', { ledger_id: this.db.nextId('stock_ledger', 'ledger_id', 'L-', 4), item_type: isIng ? 'ingredient' : 'product', item_id: o.product_id, direction: 'in', qty: actual, source_type: 'production_in', source_id: o.prod_id, unit_cost: uc, txn_date: this.NOW, location_id: this.THIS_LOC });
    const diff = plan - actual;
    if (diff > 0) this.db.append('waste', { waste_id: this.db.nextId('waste', 'waste_id', 'W-', 3), target_type: isIng ? 'ingredient' : 'product', target_id: o.product_id, qty: diff, reason: '生產失敗', date: this.NOW, location_id: this.THIS_LOC });
    const vF = this.state.viewAs; if (vF && vF !== 'all' && this.holderOf(o.prod_id) !== vF) this.assign(o, vF, '完成入庫經手');
    this.setOrderStatus(o.prod_id, '完成');
    this.notify('✓ ' + o.prod_id + ' 完成:' + this.nameOf(o.product_id) + ' 入庫 ' + actual + (isIng ? ' g(原料庫存)' : '') + (diff > 0 ? ',損耗 ' + diff + '(已記報廢)' : ''));
  }
  // 自製原料(老麵)補製單:排程/建議一鍵建立
  schedulePrep(gid, shortQty) {
    const g = this.ing(gid); if (!g) return;
    const qty = Math.max(1, Math.ceil(this.n(shortQty)));
    const id = this.db.nextId('production_order', 'prod_id', 'P-', 4);
    // 完成日按工序逆推:有設工序用 leadOf(>8h 跨天),沒設維持隔日
    const lead = this.routingOf(gid).length ? this.leadOf(gid) : 1;
    this.db.append('production_order', { prod_id: id, product_id: gid, plan_qty: qty, start_date: this.TODAY, finish_date: this.addDays(this.TODAY, Math.max(lead, 0)), status: '草稿', location_id: this.THIS_LOC });
    this.setState({ screen: 'production' });
    this.notify('✓ 已建立補製單 ' + id + ':「' + g.name + '」' + qty + ' g,今日投料、' + (lead <= 0 ? '當日' : lead === 1 ? '明日' : lead + ' 天後') + '完成入庫' + (this.routingOf(gid).length ? '(依工序工時)' : ''));
  }
  checkout() {
    const items = Object.entries(this.state.cart).filter(([, q]) => q > 0);
    if (!items.length) { this.notify('購物清單是空的 — 點上方產品磁磚加入'); return; }
    for (const [pid, q] of items) if (this.stock('product', pid) < q) { this.notify('✕ ' + this.prod(pid).name + ' 庫存不足'); return; }
    const soid = this.db.nextId('sales_line', 'so_id', 'SO-', 4); let total = 0;
    for (const [pid, q] of items) {
      const p = this.prod(pid); total += q * this.n(p.sale_price);
      this.db.append('sales_line', { so_id: soid, product_id: pid, qty: q, sale_price: p.sale_price, sale_date: this.NOW, idempotency_key: 'ui-' + Date.now() + '-' + pid, location_id: this.THIS_LOC });
      this.db.append('stock_ledger', { ledger_id: this.db.nextId('stock_ledger', 'ledger_id', 'L-', 4), item_type: 'product', item_id: pid, direction: 'out', qty: q, source_type: 'sales', source_id: soid, unit_cost: this.unitCost(pid).toFixed(2), txn_date: this.NOW, location_id: this.THIS_LOC });
    }
    this.setState({ cart: {} });
    this.notify('✓ ' + soid + ' 已過帳 NT$' + this.fmt(total) + ',成品已自動扣庫');
  }
  doCount() {
    const v = this.state.countQty; if (v === '') { this.notify('請先輸入實盤數量'); return; }
    const type = this.state.invTab, id = this.state.selItem;
    const cur = this.stock(type, id); const diff = this.n(v) - cur;
    if (!diff) { this.setState({ countQty: '' }); this.notify('實盤與帳上一致,無需調整'); return; }
    const stid = this.db.nextId('stocktake', 'stocktake_id', 'ST-', 3);
    this.db.append('stocktake', { stocktake_id: stid, target_type: type, target_id: id, counted_qty: this.n(v), date: this.NOW, location_id: this.THIS_LOC });
    this.db.append('stock_ledger', { ledger_id: this.db.nextId('stock_ledger', 'ledger_id', 'L-', 4), item_type: type, item_id: id, direction: diff > 0 ? 'in' : 'out', qty: Math.abs(diff), source_type: 'stocktake', source_id: stid, unit_cost: type === 'ingredient' ? (this.ing(id) || {}).latest_unit_cost || 0 : this.unitCost(id).toFixed(2), txn_date: this.NOW, location_id: this.THIS_LOC });
    this.setState({ countQty: '' });
    this.notify('✓ 盤點完成:' + (diff > 0 ? '盤盈 +' : '盤虧 −') + Math.abs(diff) + ',已寫入調整流水');
  }
  // 下單:只建採購單(已下單),不動庫存;到貨後 receivePO 對貨入庫
  postPO() {
    const lines = this.state.poLines; if (!lines.length) { this.notify('進貨單沒有明細 — 從左側建議加入'); return; }
    const etaDef = this.state.poEta || this.addDays(this.TODAY, 2);
    const nm = (this.state.poName || '').trim();
    // 依供應商拆單:一個供應商一張採購單;統一名字+流水號(補貨-00、補貨-01…);各單各自的預計到貨日
    const groups = {};
    for (const ln of lines) { const g = this.ing(ln.iid); const sid = (g && g.default_supplier_id) || ''; (groups[sid] = groups[sid] || []).push(ln); }
    const noSup = groups[''] || []; delete groups[''];
    if (!Object.keys(groups).length) { this.notify('✕ 草稿裡的原料都沒設供應商 — 到「原料目錄」補上預設供應商再送單'); return; }
    const made = []; let grand = 0;
    Object.keys(groups).sort().forEach((sid, gi) => {
      const poid = this.db.nextId('purchase_line', 'po_id', 'PO-', 4);
      const ov = (this.state.poNameBySup || {})[sid]; // 每張單可改名;沒改用預設「名字-NN」
      const poNm = ov !== undefined ? ov.trim() : (nm ? nm + '-' + String(gi).padStart(2, '0') : '');
      const eta = (this.state.poEtaBySup || {})[sid] || etaDef;
      let total = 0;
      for (const ln of groups[sid]) {
        const g = this.ing(ln.iid);
        const tx = this.lnTax(ln);
        const sub = +(this.n(ln.units) * this.n(ln.price) * tx).toFixed(2); total += sub; // 小計=含稅,保留 2 位小數不進位
        this.db.append('purchase_line', { po_id: poid, po_name: poNm, ingredient_id: ln.iid, qty: ln.units, purchase_unit: g.purchase_unit, unit_price: ln.price, subtotal: sub, supplier_id: sid, order_date: this.NOW, arrival_date: eta, status: '已下單', location_id: this.CENTRAL, received_qty: '0', tax_rate: String(tx) });
      }
      grand += total;
      const sp = this.t('supplier').find(s2 => s2.supplier_id === sid);
      made.push(poid + (poNm ? '「' + poNm + '」' : '') + ' ' + (sp ? sp.name : sid) + ' NT$' + this.fmt(total) + '(' + eta + ' 到)');
    });
    this.setPoDraft({ poLines: noSup, poName: noSup.length ? this.state.poName : '', poEtaBySup: {}, poNameBySup: {} });
    this.notify('✓ 已依供應商拆 ' + made.length + ' 張採購單(共 NT$' + this.fmt(grand) + '):' + made.join(';') + (noSup.length ? ';⚠ ' + noSup.length + ' 項未設供應商仍留在草稿' : '') + ' — 到貨後「對貨入庫」');
  }
  // 改預計到貨日(廠商改期):整張單一起改
  setPOEta(poid, date) {
    if (!date) return;
    this.db.replace('purchase_line', this.t('purchase_line').map(r => (r.po_id === poid && (r.location_id || 'LOC-A') === this.CENTRAL) ? Object.assign({}, r, { arrival_date: date }) : r));
    this.forceUpdate();
    this.notify('✓ ' + poid + ' 預計到貨改為 ' + date);
  }
  // 改訂購數量(廠商缺貨砍單/加量):下限=已實收量;降到等於已收 → 該行自動結案
  setPOQty(poid, iid, val) {
    const rows = this.t('purchase_line').map(r => {
      if (r.po_id !== poid || r.ingredient_id !== iid || (r.location_id || 'LOC-A') !== this.CENTRAL) return r;
      const rec = this.n(r.received_qty);
      let q = Math.max(this.n(val), rec);
      if (q <= 0) q = rec > 0 ? rec : 1;
      const done = rec >= q;
      return Object.assign({}, r, { qty: q, subtotal: q * this.n(r.unit_price), status: done ? '已到貨' : (this.n(r.received_qty) > 0 ? '部分到貨' : r.status) });
    });
    this.db.replace('purchase_line', rows);
    this.forceUpdate();
    const still = rows.filter(r => r.po_id === poid && (r.location_id || 'LOC-A') === this.CENTRAL).some(r => this.n(r.received_qty) < this.n(r.qty));
    this.notify('✓ ' + poid + ' 訂購量已更新' + (still ? '' : ' — 整單結案,歸檔到採購紀錄'));
  }
  // 退貨:退回量寫庫存流水(out, purchase_return)並自實收扣回
  // mode=resend 退貨補送:訂購量不變 → 單據回「待收貨」(狀態 補送中)等廠商再送
  // mode=cut    退貨減單:訂購量同步扣減(退款),扣到等於已收即結案
  doReturn(pid) {
    const mode = (this.state.retMode || {})[pid] || 'resend';
    const mine = this.t('purchase_line').filter(r => r.po_id === pid && (r.location_id || 'LOC-A') === this.CENTRAL);
    const acts = [];
    for (const r of mine) {
      let q = this.n((this.state.retVals || {})[pid + '|' + r.ingredient_id]);
      if (q <= 0) continue;
      q = Math.min(q, this.n(r.received_qty));
      if (q > 0) acts.push({ iid: r.ingredient_id, q });
    }
    if (!acts.length) { this.notify('填「退回」數量(採購單位)再按確認退貨'); return; }
    for (const a of acts) {
      const r = mine.find(x => x.ingredient_id === a.iid);
      const g = this.ing(a.iid) || {};
      const conv = this.n(g.conversion_rate) || 1;
      this.db.append('stock_ledger', { ledger_id: this.db.nextId('stock_ledger', 'ledger_id', 'L-', 4), item_type: 'ingredient', item_id: a.iid, direction: 'out', qty: a.q * conv, source_type: 'purchase_return', source_id: pid, unit_cost: (this.n(r.unit_price) / conv).toFixed(4), txn_date: this.NOW, location_id: this.CENTRAL });
    }
    this.db.replace('purchase_line', this.t('purchase_line').map(r => {
      if (r.po_id !== pid || (r.location_id || 'LOC-A') !== this.CENTRAL) return r;
      const a = acts.find(x => x.iid === r.ingredient_id);
      if (!a) return r;
      const rec = this.n(r.received_qty) - a.q;
      let qty = this.n(r.qty), st;
      if (mode === 'cut') { qty = Math.max(rec, qty - a.q); st = rec >= qty ? '已到貨' : (rec > 0 ? '部分到貨' : '已下單'); }
      else st = '補送中';
      return Object.assign({}, r, { received_qty: rec, qty, subtotal: qty * this.n(r.unit_price), status: st });
    }));
    const rv = Object.assign({}, this.state.retVals); Object.keys(rv).forEach(k => { if (k.indexOf(pid + '|') === 0) delete rv[k]; });
    this.setState({ retVals: rv, retOpen: '' });
    this.notify(mode === 'cut' ? '✓ ' + pid + ' 退貨減單:退回量已扣中央庫存,訂購量與金額同步扣減' : '✓ ' + pid + ' 退貨補送:退回量已扣中央庫存,單據回「待收貨」(補送中)');
  }
  // 手動更新採購單狀態(下單後、收貨前:已下單/廠商已確認/配送中/暫緩);收貨動作會自動蓋成 部分到貨/已到貨
  setPOStatus(poid, st) {
    this.db.replace('purchase_line', this.t('purchase_line').map(r => {
      if (r.po_id !== poid || (r.location_id || 'LOC-A') !== this.CENTRAL) return r;
      if (this.n(r.received_qty) >= this.n(r.qty) && this.n(r.qty) > 0) return r; // 已到齊的行不動
      return Object.assign({}, r, { status: st });
    }));
    this.forceUpdate();
    this.notify('✓ ' + poid + ' 狀態 → ' + st);
  }
  // 對貨入庫:按「本次到貨」實收數入庫;缺的留 0 等下批,單據保持開放直到全到
  receivePO(poid) {
    const mine = this.t('purchase_line').filter(r => r.po_id === poid && (r.location_id || 'LOC-A') === this.CENTRAL);
    let masters = this.t('ingredient').slice();
    const patches = {}; let got = 0;
    for (const r of mine) {
      const rem = Math.max(0, this.n(r.qty) - this.n(r.received_qty));
      if (rem <= 0) continue;
      const raw = (this.state.rcvVals || {})[poid + '|' + r.ingredient_id];
      let rcv = (raw === undefined || raw === '') ? rem : this.n(raw);
      rcv = Math.max(0, Math.min(rcv, rem));
      if (rcv <= 0) continue;
      const g = this.ing(r.ingredient_id) || {};
      const conv = this.n(g.conversion_rate) || 1;
      const tx = this.n(r.tax_rate) > 0 ? this.n(r.tax_rate) : 1; // 舊單沒稅率欄 → 1(單價視為含稅)
      const nuc = (this.n(r.unit_price) * tx / conv).toFixed(4); // 最新單價 = 含稅每 g
      this.db.append('stock_ledger', { ledger_id: this.db.nextId('stock_ledger', 'ledger_id', 'L-', 4), item_type: 'ingredient', item_id: r.ingredient_id, direction: 'in', qty: rcv * conv, source_type: 'purchase', source_id: poid, unit_cost: nuc, txn_date: this.NOW, location_id: this.CENTRAL });
      // 聯動回寫原料目錄:最新單價(含稅/每g)+ 這次採購的未稅報價與稅率(下次進貨單自動預帶)
      masters = masters.map(m => m.ingredient_id === r.ingredient_id ? Object.assign({}, m, { latest_unit_cost: nuc, quote_price: String(+(this.n(r.unit_price) * tx).toFixed(2)), quote_price_pre: String(this.n(r.unit_price)), tax_rate: String(tx) }) : m);
      patches[r.ingredient_id] = this.n(r.received_qty) + rcv;
      got++;
    }
    if (!got) { this.notify('本次到貨數量都是 0 — 在「本次到貨」欄填實收數再入庫'); return; }
    this.db.replace('purchase_line', this.t('purchase_line').map(r => {
      if (r.po_id !== poid || (r.location_id || 'LOC-A') !== this.CENTRAL || patches[r.ingredient_id] === undefined) return r;
      const nrec = patches[r.ingredient_id];
      return Object.assign({}, r, { received_qty: nrec, status: nrec >= this.n(r.qty) ? '已到貨' : '部分到貨' });
    }));
    this.db.replace('ingredient', masters);
    const rv = Object.assign({}, this.state.rcvVals); for (const k of Object.keys(rv)) if (k.indexOf(poid + '|') === 0) delete rv[k];
    this.setState({ rcvVals: rv });
    const allDone = this.t('purchase_line').filter(r => r.po_id === poid && (r.location_id || 'LOC-A') === this.CENTRAL).every(r => this.n(r.received_qty) >= this.n(r.qty));
    this.notify('✓ ' + poid + ' 對貨入庫 ' + got + ' 項,已回寫原料目錄(報價/稅率/最新單價)' + (allDone ? ',整單結案' : ',其餘待下批到貨') + ';短缺的叫貨單可回「②」補出');
  }
  doClose() {
    if (this.state.closed) { this.notify('今日已完成日結'); return; }
    let wasteC = 0, staffC = 0;
    for (const p of this.t('product')) {
      const st = this.stock('product', p.product_id); if (st <= 0) continue;
      const ch = this.state.closing[p.product_id] || 'keep';
      if (ch === 'waste') {
        const wid = this.db.nextId('waste', 'waste_id', 'W-', 3);
        this.db.append('waste', { waste_id: wid, target_type: 'product', target_id: p.product_id, qty: st, reason: '賣剩', date: this.NOW, location_id: this.THIS_LOC });
        this.db.append('stock_ledger', { ledger_id: this.db.nextId('stock_ledger', 'ledger_id', 'L-', 4), item_type: 'product', item_id: p.product_id, direction: 'out', qty: st, source_type: 'waste', source_id: wid, unit_cost: this.unitCost(p.product_id).toFixed(2), txn_date: this.NOW, location_id: this.THIS_LOC });
        wasteC++;
      } else if (ch === 'staff') {
        const soid = this.db.nextId('sales_line', 'so_id', 'SO-', 4);
        this.db.append('sales_line', { so_id: soid, product_id: p.product_id, qty: st, sale_price: Math.round(this.n(p.sale_price) / 2), sale_date: this.NOW, idempotency_key: 'staff-' + Date.now() + p.product_id, location_id: this.THIS_LOC });
        this.db.append('stock_ledger', { ledger_id: this.db.nextId('stock_ledger', 'ledger_id', 'L-', 4), item_type: 'product', item_id: p.product_id, direction: 'out', qty: st, source_type: 'sales', source_id: soid, unit_cost: this.unitCost(p.product_id).toFixed(2), txn_date: this.NOW, location_id: this.THIS_LOC });
        staffC++;
      }
    }
    this.setState({ closed: true, closing: {} });
    this.notify('✓ 日結完成:報廢 ' + wasteC + ' 項、員工價 ' + staffC + ' 項,其餘留存明日續售');
  }

  // ── renderVals ──
  renderVals() {
    const S = this.state, C = this.C, db = this.db;
    const atCentral = this.THIS_LOC === this.CENTRAL;
    const SCREENS = [
      ['setup', '開始設定', 0],
      ['overview', '營運總覽', 0], ['schedule', '每日排程', 0], ['production', '生產管理', 0],
      ['sales', '前台銷售', 0], ['inventory', atCentral ? '庫存(中央倉)' : '庫存', 0], ['purchase', atCentral ? '出貨與採購' : '叫貨與採購', 0],
      ['ingredients', atCentral ? '原料目錄' : '本店備料', 1], ['locations', '門市地點', 1], ['products', '產品與配方', 1], ['suppliers', '供應商・設備', 1], ['staff', '人員', 1],
      ['reports', '報表', 2], ['closing', '日結', 2], ['connect', '資料連線', 2], ['accounts', '帳號與角色', 2]
    ];
    if (db && this.t('location').length && !this.t('location').some(l => l.location_id === this.THIS_LOC)) setTimeout(() => this.setLoc(this.CENTRAL, true), 0); // 目前視角的地點不存在(如雲端拉回舊資料)→ 靜默退回中央倉(登入畫面不跳吐司)
    if (db && atCentral && this.allowedLoc(this.CENTRAL) && !this.CENOK[S.screen]) setTimeout(() => this.setState({ screen: 'purchase', puView: 'central' }), 0); // 站在不被允許的地點時不搶跳畫面 — 先讓下方的地點守門把視角換走
    // ── 角色範圍強制(Phase 2):視角限縮到帳號的 location_ids;畫面限縮到 role_permission ──
    if (db && S.authState === 'ok') {
      if (this.t('location').length && !this.allowedLoc(this.THIS_LOC)) {
        const firstLoc = this.t('location').find(l => this.allowedLoc(l.location_id));
        if (firstLoc) setTimeout(() => this.setLoc(firstLoc.location_id, true), 0);
      }
      if (this.allowedLoc(this.THIS_LOC) && !this.hasPerm('screen.' + S.screen)) { // 等地點守門先把視角換到允許的店,再挑畫面
        const okScr = k => this.hasPerm('screen.' + k) && (!atCentral || this.CENOK[k]);
        const next = ['overview', 'production', 'sales', 'purchase', 'inventory'].find(okScr) || (SCREENS.map(s => s[0]).find(okScr));
        if (next && next !== S.screen) setTimeout(() => this.setState({ screen: next }), 0);
      }
      if (S.screen === 'accounts' && this.hasPerm('screen.accounts') && !S.accUsers && !S.accBusy) setTimeout(() => this.loadAccounts(), 0);
    }
    if (db && atCentral && S.invTab === 'product') setTimeout(() => this.setState({ invTab: 'ingredient', selItem: (this.t('ingredient')[0] || {}).ingredient_id || '' }), 0);
    const draftCount = db ? this.lt('production_order').filter(o => o.status === '草稿').length : 0;
    const lowCount = db && !atCentral ? this.shortages().length : 0;
    const openTOCount = db ? this.t('transfer_order').filter(t => atCentral ? t.status === '叫貨' : (t.to_loc === this.THIS_LOC && (t.status === '叫貨' || t.status === '已出貨'))).length : 0;
    const pendReqCount = db ? this.t('ingredient_request').filter(r => r.status === '待處理').length : 0;
    // 導覽 icon(Google Material Symbols)+ 收合狀態
    const navFold = S.navFold !== undefined ? !!S.navFold : (() => { try { return !!localStorage.getItem('bakery_navfold_v2'); } catch (e2) { return false; } })();
    const NAVICON = { setup: 'rocket_launch', overview: 'dashboard', schedule: 'calendar_month', production: 'factory', sales: 'point_of_sale', inventory: 'inventory_2', purchase: 'shopping_cart', ingredients: 'egg_alt', locations: 'storefront', products: 'bakery_dining', suppliers: 'handshake', staff: 'group', reports: 'monitoring', closing: 'receipt_long', connect: 'cloud_sync', accounts: 'manage_accounts' };
    const mkNav = grp => SCREENS.filter(s => s[2] === grp && (!atCentral || this.CENOK[s[0]]) && (atCentral || s[0] !== 'locations') && this.hasPerm('screen.' + s[0])).map(s => {
      let badge = '', bs = 'display:none';
      if (s[0] === 'production' && draftCount) { badge = String(draftCount); bs = this.tag(C.amb); }
      if (s[0] === 'inventory' && lowCount) { badge = String(lowCount); bs = this.tag(C.red); }
      if (s[0] === 'purchase' && openTOCount) { badge = String(openTOCount); bs = this.tag(C.amb); }
      if (s[0] === 'ingredients' && atCentral && pendReqCount) { badge = String(pendReqCount); bs = this.tag(C.red); }
      const active = S.screen === s[0];
      return {
        label: s[1], badge,
        badgeStyle: (navFold ? 'display:none' : bs + (bs === 'display:none' ? '' : ';margin-left:auto')),
        icon: NAVICON[s[0]] || 'circle',
        icoStyle: active ? 'color:#0e7490;font-variation-settings:\'FILL\' 1,\'wght\' 400,\'GRAD\' 0,\'opsz\' 20' : '',
        style: (active ? 'background:#e0f0f4;color:#0e7490;font-weight:600' : '') + (navFold ? ';justify-content:center;padding:9px 0' : '') + (!navFold && badge && bs !== 'display:none' ? '' : ''),
        go: () => this.setState({ screen: s[0] })
      };
    });
    const flags = {}; SCREENS.forEach(s => flags['is' + s[0][0].toUpperCase() + s[0].slice(1)] = S.screen === s[0]);
    const base = Object.assign({
      nowTxt: (() => {
        const d = new Date();
        const wd = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
        return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') + '(' + wd + ')' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
      })(),
      ready: S.ready, toast: S.toast,
      toastStyle: 'position:fixed;right:20px;bottom:20px;z-index:50;background:#1b2330;color:#fff;padding:10px 16px;border-radius:10px;font-size:13px;box-shadow:0 6px 24px rgba(0,0,0,.25);max-width:420px;transition:opacity .3s;' + (S.toast ? 'opacity:1' : 'opacity:0;pointer-events:none'),
      screenTitle: (SCREENS.find(s => s[0] === S.screen) || [])[1] || '',
      navOps: mkNav(0), navMaster: mkNav(1), navAna: mkNav(2),
      navStyle: navFold ? 'width:56px;padding:14px 6px' : '',
      navLblStyle: navFold ? 'display:none' : '',
      hglStyle: navFold ? 'border-top:1px solid #eef0f3;margin:8px 8px;padding:0;height:0;overflow:hidden' : '',
      navFoldBtnStyle: 'color:#66707f;font-size:12px' + (navFold ? ';justify-content:center;padding:9px 0' : ''),
      navFoldIcon: navFold ? 'left_panel_open' : 'left_panel_close',
      navFoldTitle: navFold ? '展開選單' : '收合選單(只留 icon,擴大顯示空間)',
      toggleNav: () => { const v = !navFold; try { localStorage.setItem('bakery_navfold_v2', v ? '1' : ''); } catch (e2) { } this.setState({ navFold: v }); },
      connChipTxt: !db ? '載入中…' : db.mode === 'cloud' ? (db.cfg.kind === 'gapi' ? '☁ Google Sheet 直連' : '☁ Apps Script 已連線') : '本地示範資料(未連線)',
      connChipStyle: (!db ? this.tag(C.mut) : db.mode === 'cloud' ? this.tag(C.grn) : this.tag(C.amb)) + ';cursor:pointer',
      goConnect: () => this.setState({ screen: 'connect' }),
      doReset: () => { if (db) { db.reset(); this.setState({ cart: {}, poLines: [], toDraft: [], closing: {}, closed: false, draft: null, finVals: {} }); this.notify('已重置為示範資料'); } },
      // ── 登入閘門顯示狀態:app 內容只在 通過名單(ok)或 免登入(off,本地示範)時渲染 ──
      splashOn: S.splashOn,
      splashStyle: S.splashHide ? 'opacity:0;pointer-events:none' : 'opacity:1',
      authLoginOn: !!db && S.authState === 'login',
      authBlockedOn: !!db && S.authState === 'blocked',
      appOn: !!db && (S.authState === 'ok' || S.authState === 'off'),
      gsiRef: el => this.mountGsi(el),
      // 驗證期間:藏 Google 按鈕(display:none 保住 GIS iframe)、換上 Google 色轉圈 — 防止等待中重複點擊
      gsiWrapStyle: S.authBusy ? 'display:none' : '',
      authBusyStyle: S.authBusy ? 'display:flex;align-items:center;gap:10px;min-height:44px;color:#66707f;font-size:13px' : 'display:none',
      blockedEmail: S.blockedEmail || '',
      doSwitchAccount: () => this.doLogout(),
      userInitial: S.authState === 'ok' ? String(S.authName || S.authEmail || '?').charAt(0) : '林',
      userChipName: S.authState === 'ok' ? (S.authName || S.authEmail) : '店長',
      userChipTitle: S.authState === 'ok' ? [S.authEmail, S.authRole].filter(Boolean).join(' · ') : '',
      logoutStyle: S.authState === 'ok' ? '' : 'display:none',
      doLogoutBtn: () => this.doLogout('已登出'),
      resetBtnStyle: db && db.mode === 'local' ? '' : 'display:none',
      // 成本可見性(feature.cost):門市角色(含店長)隱藏所有成本欄位/卡片
      canCost: this.canCost(),
      costColStyle: this.canCost() ? '' : 'display:none'
    }, flags);
    if (!db) return Object.assign(base, { lowRows: [], prodRows: [], saleBars: [], recentRows: [], planRows: [], prodOptions: [], mrpRows: [], feedRows: [], ganttLanes: [], conflictMsg: '', conflictStyle: 'display:none', lowNote: '載入資料中…', apStyle: 'display:none', apBackStyle: 'display:none', apDayChips: [], apTimeChips: [], apTimeVal: '', apOnTime: () => { }, apClose: () => { } });

    // ── overview ──
    const todaySales = this.lt('sales_line').filter(s => this.day(s.sale_date) === this.TODAY);
    const kSalesN = todaySales.reduce((a, s) => a + this.n(s.qty) * this.n(s.sale_price), 0);
    const prodInToday = this.lt('stock_ledger').filter(l => l.source_type === 'production_in' && this.day(l.txn_date) === this.TODAY && l.item_type === 'product');
    const kBaked = prodInToday.reduce((a, l) => a + this.n(l.qty), 0);
    const kPlanned = this.lt('production_order').filter(o => o.finish_date === this.TODAY).reduce((a, o) => a + this.n(o.plan_qty), 0);
    const wipAll = this.lt('production_order').filter(o => this.isIssued(o.status));
    const wip = wipAll.filter(o => !this.isIngId(o.product_id));
    const wipPrep = wipAll.filter(o => this.isIngId(o.product_id));
    const wasteToday = this.lt('waste').filter(w => this.day(w.date) === this.TODAY);
    const wasteCostToday = wasteToday.reduce((a, w) => a + this.n(w.qty) * (w.target_type === 'product' ? this.unitCost(w.target_id) : this.n((this.ing(w.target_id) || {}).latest_unit_cost)), 0);
    const prodCostToday = prodInToday.reduce((a, l) => a + this.n(l.qty) * this.n(l.unit_cost), 0);
    const shorts = this.shortages();
    const need = this.mrpNeed();
    const kg = v => v >= 1000 ? this.fmt(v / 1000, 1) + ' kg' : this.fmt(v) + ' g';

    const lowRows = shorts.map(x => {
      const selfMade = x.g.purchase_unit === '自製';
      return {
        name: x.g.name, stockTxt: kg(x.s), needTxt: x.nd ? kg(x.nd) : '—',
        gapTxt: '−' + kg(x.short),
        tagTxt: x.why, tagStyle: this.tag(x.why === '排程缺口' ? C.red : C.amb),
        btnTxt: selfMade ? '排入續養' : '轉叫貨',
        go: selfMade
          ? () => this.schedulePrep(x.g.ingredient_id, x.short)
          : () => { this.addDraft(x.g.ingredient_id, x.short, true); this.setState({ screen: 'purchase', puView: 'store' }); }
      };
    });
    const stTag = o => {
      if (o.status === '完成') return ['已入庫', this.tag(C.grn)];
      if (o.status === '取消') return ['取消', this.tag(C.mut)];
      if (this.isIssued(o.status)) {
        const st = this.routingOf(o.product_id);
        const ci = this.stepIdx(o);
        if (st.length && ci >= st.length) return ['待入庫', this.tag(C.amb)];
        return [st.length ? '在製·' + st[ci].step_name : '在製', this.tag(C.acc)];
      }
      return ['草稿', 'color:#66707f;border-color:#e3e6eb'];
    };
    const prodRows = this.lt('production_order').slice().reverse().slice(0, 6).map(o => {
      const tg = stTag(o);
      return { id: o.prod_id, name: this.nameOf(o.product_id) + (this.isIngId(o.product_id) ? '(自製)' : ''), qty: o.plan_qty, dates: o.start_date.slice(5) + ' → ' + o.finish_date.slice(5), tag: tg[0], tagStyle: tg[1] };
    });
    const saleBars = this.t('product').map(p => {
      const st = this.stock('product', p.product_id);
      const sold = todaySales.filter(s => s.product_id === p.product_id).reduce((a, s) => a + this.n(s.qty), 0);
      const denom = st + sold || 1; const pct = Math.round(st / denom * 100);
      const col = st === 0 ? C.red : st <= 3 ? C.amb : C.acc;
      return { name: p.name, txt: st + ' / ' + (st + sold), barStyle: 'display:block;height:100%;width:' + pct + '%;background:' + col, tagTxt: st === 0 ? '售罄' : st <= 3 ? '低量' : '', tagStyle: st <= 3 ? this.tag(col) : 'display:none' };
    });
    const soAgg = {};
    todaySales.forEach(s => { (soAgg[s.so_id] = soAgg[s.so_id] || []).push(s); });
    const recentRows = Object.keys(soAgg).slice(-5).reverse().map(id => {
      const ls = soAgg[id];
      return { id: id + (String(ls[0].sale_date).length > 10 ? ' · ' + String(ls[0].sale_date).slice(11, 16) : ''), txt: ls.map(l => (this.prod(l.product_id) || {}).name + '×' + l.qty).join('、'), amt: this.fmt(ls.reduce((a, l) => a + this.n(l.qty) * this.n(l.sale_price), 0)) };
    });

    // ── schedule ──
    const sched = this.scheduleCalc();
    const chip = on => 'display:inline-block;font-size:12px;padding:4px 10px;border-radius:8px;cursor:pointer;user-select:none;border:1px solid ' + (on ? '#0e7490;background:#0e7490;color:#fff;font-weight:500' : '#e3e6eb;background:#fff;color:#1b2330');
    const TIMES = ['06:00', '08:00', '12:00', '15:30', '17:00'];
    const mkPicker = (line, key, setLine) => ({
      targetTxt: this.dayLabel(line.date) + ' ' + (line.time || ''),
      openPicker: e => {
        if (S.picker === key) { this.setState({ picker: null }); return; }
        const r = e.currentTarget.getBoundingClientRect();
        const x = Math.max(8, Math.min(r.left, window.innerWidth - 264));
        const y = r.bottom + 240 > window.innerHeight ? Math.max(8, r.top - 244) : r.bottom + 6;
        this.setState({ picker: key, popXY: [x, y] });
      },
      dayChips: [0, 1, 2].map(dd => {
        const ds = this.addDays(this.TODAY, dd);
        return { lbl: ['今日', '明日', '後天'][dd], style: chip(line.date === ds), onPick: () => setLine({ date: ds }) };
      }),
      timeChips: TIMES.map(t => ({ lbl: t, style: chip(line.time === t), onPick: () => setLine({ time: t }) })),
      timeVal: line.time, onTime: e => setLine({ time: e.target.value }),
      closePicker: () => this.setState({ picker: null })
    });
    const planRows = S.plan.map((line, i) => Object.assign({
      name: (this.prod(line.pid) || {}).name || line.pid,
      nameTag: this.prod(line.pid) ? '' : '產品不存在',
      nameTagStyle: this.prod(line.pid) ? 'display:none' : this.tag(C.red),
      whoVal: line.who || '',
      onWho: e => { const p = S.plan.slice(); p[i] = Object.assign({}, p[i], { who: e.target.value }); this.setPlan(p); },
      whoBtn: this.ddBtn([{ id: '', name: '—' }].concat(this.t('staff').filter(s2 => s2.active !== 'FALSE').map(s2 => ({ id: s2.staff_id, name: s2.name }))), line.who || '', v => { const p = S.plan.slice(); p[i] = Object.assign({}, p[i], { who: v }); this.setPlan(p); }),
      qtyVal: line.qty,
      onQty: e => { const p = S.plan.slice(); p[i] = Object.assign({}, p[i], { qty: e.target.value }); this.setPlan(p); },
      remove: () => this.setPlan(S.plan.filter((_, j) => j !== i))
    }, mkPicker(line, 'row' + i, patch => { const p = S.plan.slice(); p[i] = Object.assign({}, p[i], patch); this.setPlan(p); })));
    const newPicker = mkPicker({ date: S.planDate, time: S.planTime }, 'new', patch => this.setState({ planDate: patch.date === undefined ? S.planDate : patch.date, planTime: patch.time === undefined ? S.planTime : patch.time }));
    // 目前開啟的 picker → 以 fixed 定位彈出於最上層(不被面板裁切)
    let ap = null;
    if (S.picker === 'new') ap = newPicker;
    else if (S.picker && S.picker.indexOf('row') === 0) ap = planRows[parseInt(S.picker.slice(3), 10)] || null;
    const xy = S.popXY || [200, 200];
    const apVals = {
      apStyle: ap ? 'position:fixed;left:' + xy[0] + 'px;top:' + xy[1] + 'px;z-index:60;background:#fff;border:1px solid #e3e6eb;border-radius:10px;box-shadow:0 8px 28px rgba(16,24,40,.2);padding:12px;width:236px' : 'display:none',
      apBackStyle: ap ? 'position:fixed;inset:0;z-index:55' : 'display:none',
      apDayChips: ap ? ap.dayChips : [], apTimeChips: ap ? ap.timeChips : [],
      apTimeVal: ap ? ap.timeVal : '', apOnTime: ap ? ap.onTime : () => { },
      apClose: () => this.setState({ picker: null })
    };
    const mrpRows = this.t('ingredient').filter(g => need[g.ingredient_id]).map(g => {
      const nd = need[g.ingredient_id], st = this.stock('ingredient', g.ingredient_id), gap = nd - st;
      const selfMade = g.purchase_unit === '自製';
      return {
        name: g.name, needTxt: kg(nd), stockTxt: kg(st),
        gapTxt: gap > 0 ? '−' + kg(gap) : '—', gapStyle: gap > 0 ? 'color:#c11f28;font-weight:600' : 'color:#66707f',
        tagTxt: gap > 0 ? (selfMade ? '缺料(自製)' : '缺料') : '足夠', tagStyle: this.tag(gap > 0 ? C.red : C.grn),
        actTxt: gap > 0 ? (selfMade ? '排入續養' : '轉叫貨') : '',
        actStyle: gap > 0 ? '' : 'display:none',
        onAct: gap > 0 ? (selfMade ? () => this.schedulePrep(g.ingredient_id, gap) : () => { this.addDraft(g.ingredient_id, gap, true); this.setState({ screen: 'purchase', puView: 'store' }); }) : () => { }
      };
    });
    const feedRows = sched.map(s => ({
      name: s.name + ' ×' + s.qty,
      feedTxt: s.steps.length ? this.fmtMin(s.feed) + ' 投料' : '—',
      stepsTxt: s.steps.length ? s.steps.map(st => st.name + ' ' + this.fmtMin(st.start)).join(' → ') : '⚠ 未設定製程工序,無法逆推(產品與配方 → 製程工序)',
      outTxt: this.fmtMin(s.target)
    }));
    // 計畫品項缺配方/工序 → 明確提示
    const cfgIssues = []; const seenPid = {};
    S.plan.forEach(l => {
      if (seenPid[l.pid]) return; seenPid[l.pid] = 1;
      const p = this.prod(l.pid);
      if (!p) { cfgIssues.push('「' + l.pid + '」產品不存在,請按 ✕ 移除該列'); return; }
      const miss = [];
      if (!this.bomOf(l.pid).length) miss.push('配方 BOM');
      if (!this.routingOf(l.pid).length) miss.push('製程工序');
      if (miss.length) cfgIssues.push('「' + p.name + '」尚未設定' + miss.join('與'));
    });
    const cfgWarnTxt = cfgIssues.length ? '⚠ ' + cfgIssues.join(';') + ' — 需求展開、甘特與投料時間都依賴它們,請到「產品與配方」補齊' : '';
    const cfgWarnStyle = cfgIssues.length ? 'margin:10px 16px 2px;padding:8px 12px;border:1px solid #946800;border-radius:8px;background:#fdf8ee;font-size:12px;color:#946800' : 'display:none';
    // gantt: 視窗依所有工序 min–max 動態決定(支援跨日;無資料時 02:00–18:00)
    const palette = ['#0e7490', '#155e70', '#7c9a3d', '#946800', '#5b5f97'];
    let gMin = Infinity, gMax = -Infinity;
    sched.forEach(s => s.steps.forEach(st => { if (st.eq) { gMin = Math.min(gMin, st.start); gMax = Math.max(gMax, st.end); } }));
    if (!isFinite(gMin)) { gMin = 120; gMax = 1080; }
    const W0 = Math.floor((gMin - 30) / 120) * 120;
    const W1 = Math.max(W0 + 480, Math.ceil((gMax + 30) / 120) * 120);
    const WW = W1 - W0;
    const gZoom = S.ganttZoom || 1;
    const gStep = gZoom >= 4 ? 30 : gZoom >= 2 ? 60 : 120;
    const tickLbl = t => {
      const day = Math.floor(t / 1440);
      const mm = ((t % 1440) + 1440) % 1440;
      const hh = String(Math.floor(mm / 60)).padStart(2, '0');
      return (day === 1 ? '明' : day === 2 ? '後' : day < 0 ? '昨' : '') + hh + (gStep < 60 ? ':' + String(mm % 60).padStart(2, '0') : '');
    };
    const ganttTicks = [];
    for (let t = W0; t <= W1; t += gStep) ganttTicks.push({ lbl: tickLbl(t), style: (t === W1 ? 'width:38px;flex:none' : 'flex:1') + ';white-space:nowrap;overflow:hidden' });
    const ganttRangeTxt = this.fmtMin(W0) + ' – ' + this.fmtMin(W1);
    let conflictMsg = '';
    const ganttLanes = this.t('equipment').map(eq => {
      // 收集此設備的所有工序區間
      const items = [];
      sched.forEach((s, si) => s.steps.forEach(st => {
        if (st.eq !== eq.equipment_id) return;
        items.push({ start: st.start, end: st.end, si, label: s.name + '·' + st.name });
      }));
      // 重疊 → 分行:貪婪塞入最早空出的一行
      items.sort((a, b) => a.start - b.start || a.end - b.end);
      const rowEnds = [];
      items.forEach(it => {
        let r = rowEnds.findIndex(e => e <= it.start);
        if (r === -1) { r = rowEnds.length; rowEnds.push(it.end); } else rowEnds[r] = it.end;
        it.row = r;
      });
      const rows = Math.max(1, rowEnds.length);
      const bars = [];
      items.forEach(it => {
        const a = Math.max(it.start, W0), b = Math.min(it.end, W1);
        if (b <= W0 || a >= W1) return;
        bars.push({
          style: 'position:absolute;top:' + (5 + it.row * 27) + 'px;height:22px;border-radius:5px;color:#fff;font-size:10.5px;display:flex;align-items:center;padding:0 7px;white-space:nowrap;overflow:hidden;left:' + ((a - W0) / WW * 100).toFixed(1) + '%;width:' + Math.max((b - a) / WW * 100, 1).toFixed(1) + '%;background:' + palette[it.si % palette.length],
          label: it.label
        });
      });
      // 產能衝突:同時段占用 > 台數
      const cnt = this.n(eq.count) || 1;
      const evs = []; items.forEach(iv => { evs.push([iv.start, 1]); evs.push([iv.end, -1]); });
      evs.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      let cur = 0, mx = 0; evs.forEach(e => { cur += e[1]; mx = Math.max(mx, cur); });
      if (mx > cnt) conflictMsg += '「' + eq.name + '」同時段需求 ' + mx + ' 批 > 產能 ' + cnt + ' 台;';
      return { label: eq.name + ' ×' + eq.count, bars, laneStyle: 'flex:1;height:' + (rows * 27 + 5) + 'px' };
    });
    const conflictStyle = conflictMsg
      ? 'margin:6px 16px 12px;padding:8px 12px;border:1px solid #c11f28;border-radius:8px;background:#fdf2f2;font-size:12px;color:#c11f28'
      : 'margin:6px 16px 12px;padding:8px 12px;border:1px solid #177a4c;border-radius:8px;background:#f0f8f4;font-size:12px;color:#177a4c';
    const conflictFull = conflictMsg ? '⚠ 設備負載:' + conflictMsg + '建議錯開時間或分批' : '✓ 設備負載檢查通過,無時段衝突';
    const prodOptions = this.t('product').filter(p => this.prodAtStore(p, this.THIS_LOC)).map(p => ({ id: p.product_id, name: p.name }));
    // 修正:下拉顯示值與實際加入值不同步(舊 id 已刪除時退回第一個真實產品)
    const effPlanPid = this.prod(S.planPid) ? S.planPid : (prodOptions[0] || {}).id || '';

    return Object.assign(base, {
      cfgWarnTxt, cfgWarnStyle,
      lowNote: shorts.length ? '缺口 = max(排程需求 − 庫存, 安全庫存 − 庫存);點「轉叫貨」帶入向中央倉的叫貨單' : '目前無缺料,所有原料高於安全庫存與排程需求',
      kSales: 'NT$' + this.fmt(kSalesN), kSalesD: todaySales.length + ' 筆交易(結帳即時累計)',
      kBaked: this.fmt(kBaked), kPlanned: this.fmt(kPlanned),
      kWip: wip.length + ' 批 · ' + wip.reduce((a, o) => a + this.n(o.plan_qty), 0) + ' 個',
      kWipD: (wip.map(o => this.nameOf(o.product_id) + '×' + o.plan_qty).join('、') || '無在製批次') + (wipPrep.length ? ' · 續養中:' + wipPrep.map(o => this.nameOf(o.product_id)).join('、') : ''),
      kWasteRate: (() => {
        // L3 修復:分母改「銷貨成本+報廢成本」,避免賣剩報廢(昨日生產)除以今日生產造成 >100% 失真
        const cogsToday = todaySales.reduce((a, s) => a + this.n(s.qty) * this.unitCost(s.product_id), 0);
        const denom = cogsToday + wasteCostToday;
        return denom ? (wasteCostToday / denom * 100).toFixed(1) + '%' : '—';
      })(),
      lowRows, prodRows, saleBars, recentRows,
      planRows, prodOptions,
      planPid: effPlanPid, onPlanPid: e => this.setState({ planPid: e.target.value }),
      planBtn: this.ddBtn(prodOptions, effPlanPid, v => this.setState({ planPid: v })),
      planQty: S.planQty, onPlanQty: e => this.setState({ planQty: e.target.value }),
      newPicker,
      addPlan: () => {
        if (!effPlanPid) { this.notify('請先到「產品與配方」建立產品,才能排生產計畫'); return; }
        this.setPlan(S.plan.concat([{ pid: effPlanPid, qty: S.planQty, date: S.planDate, time: S.planTime }]), { picker: null });
      },
      makeOrders: () => this.makeOrders(),
      staffOptions: this.t('staff').filter(s => s.active !== 'FALSE').map(s => ({ id: s.staff_id, name: s.name })),
      viewAs: S.viewAs || 'all', onViewAs: e => this.setState({ viewAs: e.target.value }),
      viewAsBtn: this.ddBtn([{ id: 'all', name: '全部人員' }].concat(this.t('staff').filter(s2 => s2.active !== 'FALSE').map(s2 => ({ id: s2.staff_id, name: s2.name }))), S.viewAs || 'all', v => this.setState({ viewAs: v })),
      mrpRows, feedRows, ganttLanes, ganttTicks, ganttRangeTxt, conflictMsg: conflictFull, conflictStyle,
      ganttInnerStyle: 'width:' + (gZoom * 100) + '%;min-width:max(100%,' + (110 + ganttTicks.length * 46) + 'px)',
      gZoomTxt: '×' + gZoom,
      gZoomIn: () => this.setState({ ganttZoom: Math.min(8, (S.ganttZoom || 1) * 2) }),
      gZoomOut: () => this.setState({ ganttZoom: Math.max(1, (S.ganttZoom || 1) / 2) }),
      ganttRef: el => { this._gEl = el; },
      ganttPan: this.chartPan('_gEl')
    }, apVals, this.extraVals(base));
  }

  // 其餘畫面的值(生產/銷售/庫存/採購/主資料/報表/日結)
  extraVals() {
    const S = this.state, C = this.C, db = this.db;
    if (!db) return {};
    const atCentral = this.THIS_LOC === this.CENTRAL;
    const locTabs = this.t('location').filter(l => this.allowedLoc(l.location_id)).map(l => ({
      name: l.name,
      style: 'padding:5px 12px;cursor:pointer' + (l.location_id === this.THIS_LOC ? ';background:#0e7490;color:#fff;font-weight:500;border-radius:7px' : ''),
      go: () => this.setLoc(l.location_id)
    }));
    const kg = v => v >= 1000 ? this.fmt(v / 1000, 1) + ' kg' : this.fmt(v) + ' g';
    const stTag = o => {
      if (o.status === '完成') return ['已入庫', this.tag(C.grn)];
      if (this.isIssued(o.status)) {
        const st = this.routingOf(o.product_id);
        const ci = this.stepIdx(o);
        if (st.length && ci >= st.length) return ['待入庫', this.tag(C.amb)];
        return [st.length ? '在製·' + st[ci].step_name : '在製', this.tag(C.acc)];
      }
      return ['草稿', 'color:#66707f;border-color:#e3e6eb'];
    };

    // ── production ──
    const bomTxtOf = o => {
      const p = this.prod(o.product_id); const isIngO = this.isIngId(o.product_id);
      const ratio = p ? this.n(o.plan_qty) / (this.n(p.default_yield) || 1) : this.n(o.plan_qty) / (this.n((this.ing(o.product_id) || {}).batch_yield) || 1);
      const bomL = this.bomOf(o.product_id);
      if (bomL.length) return bomL.map(b => (this.ing(b.ingredient_id) || {}).name + ' ' + kg(this.n(b.qty_per_yield) * ratio)).join('、');
      return isIngO ? '續養:餵麵粉+水(未設定配方,不自動扣料),完成後入原料庫存' : '⚠ 未設定配方,投料不會扣原料';
    };
    const qtyTxtOf = o => this.isIngId(o.product_id) ? this.fmt(o.plan_qty) + ' g' : '×' + o.plan_qty;
    const ordSortV = { id: o => o.prod_id, prod: o => (this.prod(o.product_id) || {}).name || o.product_id, qty: o => this.n(o.plan_qty), date: o => String(o.finish_date || ''), st: o => o.status || '' };
    const orderRows = this.lsort('lsOrd', this.lfilter('lsOrd', this.lt('production_order').slice().reverse(), ['prod_id', o => (this.prod(o.product_id) || {}).name, 'status', 'finish_date', 'start_date']), ordSortV).map(o => {
      const p = this.prod(o.product_id) || {}; const tg = stTag(o);
      const stepsL = this.routingOf(o.product_id); const curI = this.stepIdx(o);
      const canIssue = o.status === '草稿';
      const canFinish = this.isIssued(o.status) && (stepsL.length === 0 || curI >= stepsL.length - 1);
      const canNext = this.isIssued(o.status) && stepsL.length > 0 && curI < stepsL.length - 1;
      return {
        id: o.prod_id, name: this.nameOf(o.product_id), qty: qtyTxtOf(o),
        ownerTxt: this.staffName(this.holderOf(o.prod_id)) || '—',
        selfStyle: this.isIngId(o.product_id) ? this.tag(C.amb) : 'display:none',
        dates: o.start_date.slice(5) + ' → ' + o.finish_date.slice(5) + (this.leadOf(o.product_id) ? '(跨 ' + this.leadOf(o.product_id) + ' 天)' : ''),
        tag: tg[0], tagStyle: tg[1],
        bomTxt: bomTxtOf(o),
        issueStyle: canIssue ? '' : 'display:none', doIssue: () => this.issue(o),
        nextStyle: canNext ? '' : 'display:none',
        nextTxt: canNext ? '完成「' + stepsL[curI].step_name + '」' : '',
        doNext: () => this.advanceStep(o),
        onTrace: () => this.setState({ traceId: o.prod_id, prodView: 'list' }),
        finStyle: canFinish ? '' : 'display:none',
        finVal: S.finVals[o.prod_id] === undefined ? o.plan_qty : S.finVals[o.prod_id],
        onFin: e => this.setState({ finVals: Object.assign({}, S.finVals, { [o.prod_id]: e.target.value }) }),
        doFinish: () => this.finish(o)
      };
    });
    const wipRows = this.lt('production_order').filter(o => this.isIssued(o.status)).map(o => {
      const st = this.routingOf(o.product_id);
      return {
        name: this.nameOf(o.product_id) + ' ' + qtyTxtOf(o) + (this.isIngId(o.product_id) ? '(續養)' : ''),
        sub: '投料 ' + o.start_date.slice(5) + ' · 預計 ' + o.finish_date.slice(5) + (this.isIngId(o.product_id) ? ' 可用' : ' 出爐') + (st.length ? ' · 目前 ' + st[Math.min(this.stepIdx(o), st.length - 1)].step_name : '')
      };
    });
    // ── 工位任務板(看板)──
    const draftOrders = this.lt('production_order').filter(o => o.status === '草稿');
    const issuedOrders = this.lt('production_order').filter(o => this.isIssued(o.status));
    const vAs = S.viewAs || 'all';
    const ownerLbl = o => { const h = this.holderOf(o.prod_id); return h ? '負責:' + this.staffName(h) : '未認領'; };
    const cardSty = (o, base) => base;
    const byMine = arr => arr;
    // 員工視角:只顯示 自己的+未認領;其他人的任務收到欄位底部,可一鍵接手
    const isOthers = o => { const h = this.holderOf(o.prod_id); return vAs !== 'all' && h && h !== vAs; };
    const stepInfo = o => {
      if (o.status === '草稿') return '待投料';
      const st = this.routingOf(o.product_id);
      if (st.length && this.stepIdx(o) >= st.length) return '待入庫盤點';
      const i = Math.min(this.stepIdx(o), Math.max(st.length - 1, 0));
      return st.length ? '目前「' + st[i].step_name + '」' : '進行中';
    };
    const mkOther = o => ({
      name: this.nameOf(o.product_id) + ' ' + qtyTxtOf(o),
      info: stepInfo(o),
      holder: this.staffName(this.holderOf(o.prod_id)),
      onTake: () => this.assign(o, vAs, '接手')
    });
    // 自適應時間跨度:秒 → 分秒 → 時分 → 天時 → 週天
    const fsSpan = s => {
      s = Math.max(0, Math.round(Math.abs(s)));
      const w = Math.floor(s / 604800), d = Math.floor((s % 604800) / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
      if (w) return w + ' 週 ' + d + ' 天';
      if (d) return d + ' 天 ' + h + ' 時';
      if (h) return h + ' 時 ' + String(m).padStart(2, '0') + ' 分';
      if (m) return m + ' 分 ' + String(ss).padStart(2, '0') + ' 秒';
      return ss + ' 秒';
    };
    // 工序倒數:目前工序開始時刻 = 最後一筆該工序的 assignment(或投料流水),與工序時間比對
    const stepTimer = (o, steps, cur) => {
      const hide = { timerTxt: '', timerStyle: 'display:none', tOk: false, tRemain: 0, tDur: 0 };
      if (!steps.length) return hide;
      const dur = this.n(steps[cur].duration_min);
      const hasTime = s => /\d{1,2}:\d{2}/.test(String(s).slice(10));
      // 取「第一筆」進入此工序的紀錄:中途接手不會重置倒數;刷新/重載後從持久化時間戳重算
      const arows = this.t('assignment').filter(a => a.prod_id === o.prod_id && this.n(a.step_no) === cur && hasTime(a.ts));
      let ts = arows.length ? arows[0].ts : null;
      if (!ts && cur === 0) {
        const led = this.t('stock_ledger').find(l => l.source_type === 'production_out' && l.source_id === o.prod_id && hasTime(l.txn_date));
        if (led) ts = led.txn_date;
      }
      if (!ts || !dur) return hide;
      const start = new Date(String(ts).replace(' ', 'T'));
      if (isNaN(start.getTime())) return hide;
      const remainSec = dur * 60 - (Date.now() - start.getTime()) / 1000;
      const base = 'margin-top:6px;font-size:11.5px;font-weight:600;';
      return {
        tOk: true, tRemain: remainSec, tDur: dur,
        timerTxt: remainSec >= 0
          ? '「' + steps[cur].step_name + '」倒數 ' + fsSpan(remainSec) + ' / 共 ' + dur + ' 分'
          : '「' + steps[cur].step_name + '」已超時 ' + fsSpan(remainSec),
        timerStyle: base + (remainSec >= 0 ? 'color:#8a919e' : 'color:#c11f28')
      };
    };
    const boardPrep = byMine(draftOrders.filter(o => !isOthers(o)).map(o => ({
      _mine: this.holderOf(o.prod_id) === vAs,
      name: this.nameOf(o.product_id), qtyTxt: qtyTxtOf(o),
      selfStyle: this.isIngId(o.product_id) ? this.tag(C.amb) : 'display:none',
      bomTxt: bomTxtOf(o),
      cardStyle: cardSty(o, 'border-color:#0e7490'),
      subTxt: o.prod_id + ' · 完成日 ' + o.finish_date.slice(5) + ' · ' + ownerLbl(o),
      issueBtnTxt: vAs === 'all' ? '投料過帳' : '認領並投料',
      doIssue: () => this.issue(o)
    })));
    // ② 製程中:所有工序(含最後一道)都在這裡完成;③ 入庫:全工序結束後才進入,盤點實際數量
    const midOrders = issuedOrders.filter(o => { const st = this.routingOf(o.product_id); return st.length > 0 && this.stepIdx(o) < st.length; });
    const finOrders = issuedOrders.filter(o => { const st = this.routingOf(o.product_id); return st.length === 0 || this.stepIdx(o) >= st.length; });
    const boardMid = byMine(midOrders.filter(o => !isOthers(o)).map(o => {
      const steps = this.routingOf(o.product_id); const cur = this.stepIdx(o);
      const tm = stepTimer(o, steps, cur);
      return {
        _mine: this.holderOf(o.prod_id) === vAs,
        cardStyle: cardSty(o, ''),
        name: this.nameOf(o.product_id), qtyTxt: qtyTxtOf(o),
        selfStyle: this.isIngId(o.product_id) ? this.tag(C.amb) : 'display:none',
        chips: steps.map((r, i) => ({
          txt: (i < cur ? '✓ ' : '') + r.step_name + (i >= cur && this.n(r.duration_min) ? ' ' + r.duration_min + '分' : ''),
          style: i < cur ? this.tag(C.grn) + ';opacity:.7' : i === cur ? 'background:#0e7490;color:#fff;border-color:#0e7490' : 'color:#66707f;border-color:#e3e6eb'
        })),
        subTxt: o.prod_id + ' · 第 ' + (cur + 1) + '/' + steps.length + ' 道 · 預計 ' + o.finish_date.slice(5) + ' 完成 · ' + ownerLbl(o),
        nextTxt: (vAs !== 'all' && this.holderOf(o.prod_id) && this.holderOf(o.prod_id) !== vAs ? '接手並' : '') + '完成「' + steps[cur].step_name + '」' + (steps[cur + 1] ? '→ ' + steps[cur + 1].step_name + (cur + 2 === steps.length ? '(最後工序)' : '') : '→ 移入入庫欄'),
        doNext: () => this.advanceStep(o),
        // 倒數整合進按鈕:時間內灰色、超時紅色(都可點)
        nextBtnStyle: 'display:block;text-align:center;padding:8px 6px;margin-top:8px;line-height:1.35;' + (!tm.tOk
          ? 'border-color:#0e7490;color:#0e7490'
          : tm.tRemain >= 0
            ? 'border-color:#cfd4db;color:#66707f;background:#fafbfc'
            : 'border-color:#c11f28;color:#c11f28;background:#fdf2f2'),
        btnSub: tm.tOk ? (tm.tRemain >= 0 ? '倒數 ' + fsSpan(tm.tRemain) + '(共 ' + tm.tDur + ' 分)' : '已超時 ' + fsSpan(tm.tRemain)) : '',
        btnSubStyle: tm.tOk ? 'display:block;font-size:11px;font-weight:700;margin-top:2px' : 'display:none'
      };
    }));
    const boardFin = byMine(finOrders.filter(o => !isOthers(o)).map(o => {
      const steps = this.routingOf(o.product_id);
      // 全工序已結束:顯示等待入庫多久(最後一筆工序時間戳起算)
      const lastA = this.t('assignment').filter(a => a.prod_id === o.prod_id && /\d{1,2}:\d{2}/.test(String(a.ts).slice(10))).pop();
      const waitSec = lastA ? Math.max(0, (Date.now() - new Date(String(lastA.ts).replace(' ', 'T')).getTime()) / 1000) : null;
      return {
        _mine: this.holderOf(o.prod_id) === vAs,
        cardStyle: cardSty(o, ''),
        name: this.nameOf(o.product_id), planTxt: qtyTxtOf(o),
        selfStyle: this.isIngId(o.product_id) ? this.tag(C.amb) : 'display:none',
        ownerTxt: ownerLbl(o),
        stageTxt: steps.length
          ? '全工序完成' + (waitSec !== null ? ' · 已等待 ' + fsSpan(waitSec) : '') + ' — 盤點實際數量入庫'
          : (this.isIngId(o.product_id) ? '發酵/熟成中 — 完成後回原料庫存' : '未設定工序 — 可直接入庫'),
        dueTag: o.finish_date <= this.TODAY ? '今日' : o.finish_date.slice(5),
        dueStyle: this.tag(o.finish_date <= this.TODAY ? C.acc : C.mut),
        finVal: S.finVals[o.prod_id] === undefined ? o.plan_qty : S.finVals[o.prod_id],
        onFin: e => this.setState({ finVals: Object.assign({}, S.finVals, { [o.prod_id]: e.target.value }) }),
        doFinish: () => this.finish(o),
        finBtnStyle: 'flex:none;padding:6px 12px;line-height:1.3;text-align:center;',
        finBtnSub: '', finBtnSubStyle: 'display:none'
      };
    }));
    const emptyNote = n => n ? 'display:none' : 'font-size:12px;color:#66707f;padding:4px 2px';
    const boardVals = {
      showBoard: S.prodView === 'board', showList: S.prodView === 'list', showTime: S.prodView === 'time', showLine: S.prodView === 'line',
      pvLineStyle: S.prodView === 'line' ? 'background:#0e7490;color:#fff;font-weight:500' : '',
      goLine: () => this.setState({ prodView: 'line' }),
      pvBoardStyle: S.prodView === 'board' ? 'background:#0e7490;color:#fff;font-weight:500' : '',
      pvListStyle: S.prodView === 'list' ? 'background:#0e7490;color:#fff;font-weight:500' : '',
      pvTimeStyle: S.prodView === 'time' ? 'background:#0e7490;color:#fff;font-weight:500' : '',
      goBoard: () => this.setState({ prodView: 'board' }),
      goList: () => this.setState({ prodView: 'list' }),
      goTime: () => this.setState({ prodView: 'time' }),
      boardPrep, boardMid, boardFin,
      prepCount: String(boardPrep.length), midCount: String(boardMid.length), finCount: String(boardFin.length),
      prepEmpty: emptyNote(boardPrep.length), midEmpty: emptyNote(boardMid.length), finEmpty: emptyNote(boardFin.length),
      othersPrep: draftOrders.filter(isOthers).map(mkOther),
      othersMid: midOrders.filter(isOthers).map(mkOther),
      othersFin: finOrders.filter(isOthers).map(mkOther),
      opHead: vAs !== 'all' && draftOrders.some(isOthers) ? '' : 'display:none',
      omHead: vAs !== 'all' && midOrders.some(isOthers) ? '' : 'display:none',
      ofHead: vAs !== 'all' && finOrders.some(isOthers) ? '' : 'display:none'
    };

    // ── 流水線視圖(B 矩陣 + C 工位終端)──
    const lines = this.t('line');
    const lineSel = lines.find(l => l.line_id === S.lineSel) ? S.lineSel : (lines[0] || {}).line_id || '';
    const lineStations = this.stationsOf(lineSel);
    const stationSel = S.stationSel === 'all' || S.stationSel === '_fin' || lineStations.find(x => x.station_id === S.stationSel) ? S.stationSel : 'all';
    const activeOrds = this.lt('production_order').filter(o => o.status === '草稿' || this.isIssued(o.status));
    const lineOrds = activeOrds.filter(o => { const st = this.routingOf(o.product_id); return st.length && st.some(r => this.stationOfStep(lineStations, r.step_name)); });
    // B 矩陣
    const matHead = lineStations.map(x => ({ name: x.name, sub: this.staffName(x.staff_id) || '未指派' })).concat([{ name: '入庫', sub: '' }]);
    const matRows = lineOrds.map(o => {
      const steps = this.routingOf(o.product_id); const cur = this.stepIdx(o); const issued = this.isIssued(o.status);
      const tm = issued && cur < steps.length ? stepTimer(o, steps, cur) : { tOk: false };
      const byStation = {};
      steps.forEach((r, i) => { const sid = this.stationOfStep(lineStations, r.step_name); if (sid) (byStation[sid] = byStation[sid] || []).push(i); });
      const cells = lineStations.map(x => {
        const idxs = byStation[x.station_id];
        if (!idxs) return { txt: '—', style: 'color:#cfd4db' };
        if (!issued) return { txt: '○', style: 'color:#cfd4db' };
        if (idxs.indexOf(cur) >= 0) {
          const t = tm.tOk ? (tm.tRemain >= 0 ? Math.ceil(tm.tRemain / 60) + '分' : '超時' + Math.ceil(-tm.tRemain / 60) + '分') : '';
          return { txt: '● ' + steps[cur].step_name + (t ? ' · ' + t : ''), style: 'font-weight:600;white-space:nowrap;' + (tm.tOk && tm.tRemain < 0 ? 'color:#c11f28' : 'color:#0e7490') };
        }
        if (idxs.every(i => i < cur)) return { txt: '✓', style: 'color:#177a4c;font-weight:600' };
        if (idxs.some(i => i < cur)) return { txt: '◐', style: 'color:#946800' };
        return { txt: '○', style: 'color:#8a919e' };
      });
      cells.push(issued && cur >= steps.length ? { txt: '● 待盤點', style: 'font-weight:600;color:#946800;white-space:nowrap' } : { txt: '○', style: 'color:#8a919e' });
      return {
        name: this.nameOf(o.product_id) + ' ' + qtyTxtOf(o),
        sub: o.prod_id + (o.status === '草稿' ? ' · 待投料' : '') + ' · ' + this.staffName(this.holderOf(o.prod_id)),
        cells, onTrace: () => this.setState({ traceId: o.prod_id, prodView: 'list' })
      };
    });
    // C 工位終端
    const termStation = lineStations.find(x => x.station_id === stationSel);
    const termOps = [], termDrafts = [];
    if (termStation) {
      lineOrds.forEach(o => {
        const steps = this.routingOf(o.product_id);
        if (o.status === '草稿') {
          if (this.stationOfStep(lineStations, (steps[0] || {}).step_name || '') === termStation.station_id)
            termDrafts.push({
              name: this.nameOf(o.product_id) + ' ' + qtyTxtOf(o), sub: o.prod_id + ' · 投料=依配方扣原料',
              doIssue: () => { if (termStation.staff_id) this.assign(o, termStation.staff_id, '認領'); this.issue(o); }
            });
          return;
        }
        const cur = this.stepIdx(o);
        if (cur >= steps.length) return;
        if (this.stationOfStep(lineStations, steps[cur].step_name) !== termStation.station_id) return;
        const tm = stepTimer(o, steps, cur);
        const nxt = steps[cur + 1];
        const nxtSt = nxt ? lineStations.find(x => x.station_id === this.stationOfStep(lineStations, nxt.step_name)) : null;
        termOps.push({
          name: this.nameOf(o.product_id) + ' ' + qtyTxtOf(o),
          sub: o.prod_id + ' · 「' + steps[cur].step_name + '」第 ' + (cur + 1) + '/' + steps.length + ' 道 · ' + this.staffName(this.holderOf(o.prod_id)),
          cd: tm.tOk ? (tm.tRemain >= 0 ? '倒數 ' + fsSpan(tm.tRemain) : '已超時 ' + fsSpan(tm.tRemain)) : '未計時',
          cdStyle: 'margin-top:8px;font-size:17px;font-weight:700;font-variant-numeric:tabular-nums;' + (tm.tOk ? (tm.tRemain >= 0 ? 'color:#1b2330' : 'color:#c11f28') : 'color:#8a919e'),
          btnTxt: '完成「' + steps[cur].step_name + '」' + (nxt ? '→ 送往 ' + (nxtSt ? nxtSt.name : '其他') : '→ 移入入庫'),
          doNext: () => this.advanceStep(o, termStation.staff_id || null),
          _r: tm.tOk ? tm.tRemain : 1e9
        });
      });
      termOps.sort((a, b) => a._r - b._r);
    }
    const termFin = finOrders.map(o => ({
      name: this.nameOf(o.product_id) + ' ' + qtyTxtOf(o), sub: o.prod_id + ' · 全工序完成,盤點實際數量',
      finVal: S.finVals[o.prod_id] === undefined ? o.plan_qty : S.finVals[o.prod_id],
      onFin: e => this.setState({ finVals: Object.assign({}, S.finVals, { [o.prod_id]: e.target.value }) }),
      doFinish: () => this.finish(o)
    }));
    // 流水線設定
    const setSta = (id, k) => e => { db.replace('station', this.t('station').map(x => x.station_id === id ? Object.assign({}, x, { [k]: e.target.value }) : x)); this.forceUpdate(); };
    const stfOpts2 = [{ id: '', name: '— 未指派' }].concat(this.t('staff').filter(s => s.active !== 'FALSE').map(s => ({ id: s.staff_id, name: s.name })));
    const stCfgRows = lineStations.map(x => ({
      seqVal: x.seq, onSeq: setSta(x.station_id, 'seq'),
      nameVal: x.name, onName: setSta(x.station_id, 'name'),
      matchVal: x.match, onMatch: setSta(x.station_id, 'match'),
      staffVal: x.staff_id || '', onStaff: setSta(x.station_id, 'staff_id'),
      staffBtn: this.ddBtn(stfOpts2, x.staff_id || '', v => { db.replace('station', this.t('station').map(y => y.station_id === x.station_id ? Object.assign({}, y, { staff_id: v }) : y)); this.forceUpdate(); }),
      onDel: () => { db.replace('station', this.t('station').filter(y => y.station_id !== x.station_id)); this.forceUpdate(); }
    }));
    const lineVals = {
      lineSel, stationSel, stCfgRows, matHead, matRows, termOps, termDrafts, termFin, stfOpts2,
      lineOpts: lines.map(l => ({ id: l.line_id, name: l.name })),
      stationOpts: lineStations.map(x => ({ id: x.station_id, name: x.name })),
      onLineSel: e => this.setState({ lineSel: e.target.value, stationSel: 'all' }),
      onStationSel: e => this.setState({ stationSel: e.target.value }),
      lineBtn: this.ddBtn(lines.map(l => ({ id: l.line_id, name: l.name })), lineSel, v => this.setState({ lineSel: v, stationSel: 'all' })),
      stationBtn: this.ddBtn([{ id: 'all', name: '全部 — 矩陣總覽' }].concat(lineStations.map(x => ({ id: x.station_id, name: x.name }))).concat([{ id: '_fin', name: '入庫盤點' }]), stationSel, v => this.setState({ stationSel: v })),
      lineCfgStyle: S.lineCfg ? 'border-top:1px solid #eef0f3' : 'display:none',
      toggleLineCfg: () => this.setState({ lineCfg: !S.lineCfg }),
      lineCfgTxt: S.lineCfg ? '收合設定' : '⚙ 設定流水線',
      lineNameVal: (lines.find(l => l.line_id === lineSel) || {}).name || '',
      onLineName: e => { db.replace('line', lines.map(l => l.line_id === lineSel ? Object.assign({}, l, { name: e.target.value }) : l)); this.forceUpdate(); },
      addLine: () => { const id = db.nextId('line', 'line_id', 'LINE-', 2); db.replace('line', lines.concat([{ line_id: id, name: '新流水線' }])); this.setState({ lineSel: id, stationSel: 'all', lineCfg: true }); },
      delLine: () => { if (lineStations.length) { this.notify('✕ 請先刪除此線的全部工位'); return; } db.replace('line', lines.filter(l => l.line_id !== lineSel)); this.setState({ lineSel: '' }); },
      addStation: () => { db.replace('station', this.t('station').concat([{ station_id: db.nextId('station', 'station_id', 'ST-', 2), line_id: lineSel, seq: String(lineStations.length + 1), name: '新工位', match: '', staff_id: '' }])); this.forceUpdate(); },
      lineMatrixOn: stationSel === 'all', lineTermOn: !!termStation, lineFinOn: stationSel === '_fin',
      termTitle: termStation ? '工位終端 — ' + termStation.name + ' · 值班:' + (this.staffName(termStation.staff_id) || '未指派') : '',
      matEmpty: matRows.length ? 'display:none' : 'padding:14px 16px;font-size:12px;color:#66707f',
      termEmpty: (termOps.length + termDrafts.length) ? 'display:none' : 'padding:14px 16px;font-size:12px;color:#66707f',
      finEmpty2: termFin.length ? 'display:none' : 'padding:14px 16px;font-size:12px;color:#66707f'
    };

    // ── sales ──
    const tiles = this.t('product').filter(p => this.prodAtStore(p, this.THIS_LOC)).map(p => {
      const st = this.stock('product', p.product_id);
      const inCart = S.cart[p.product_id] || 0; const left = st - inCart;
      return {
        name: p.name, price: 'NT$' + p.sale_price,
        stockTag: left <= 0 ? '售罄' : '餘 ' + left,
        tagStyle: this.tag(left <= 0 ? C.red : left <= 3 ? C.amb : C.acc),
        tileStyle: 'text-align:center;padding:16px 8px;cursor:pointer;' + (left <= 0 ? 'opacity:.45;pointer-events:none' : ''),
        onTap: () => { if (left > 0) this.setState({ cart: Object.assign({}, S.cart, { [p.product_id]: inCart + 1 }) }); }
      };
    });
    const cartRows = Object.entries(S.cart).filter(([, q]) => q > 0).map(([pid, q]) => {
      const p = this.prod(pid);
      return { txt: p.name + ' × ' + q, amt: this.fmt(q * this.n(p.sale_price)), onMinus: () => this.setState({ cart: Object.assign({}, S.cart, { [pid]: q - 1 }) }) };
    });
    const cartTotal = 'NT$' + this.fmt(Object.entries(S.cart).reduce((a, [pid, q]) => a + q * this.n((this.prod(pid) || {}).sale_price), 0));
    const comingRows = this.lt('production_order').filter(o => this.isIssued(o.status) && !this.isIngId(o.product_id)).map(o => ({
      txt: this.nameOf(o.product_id) + ' ×' + o.plan_qty + ' → ' + (o.finish_date === this.TODAY ? '今日出爐' : o.finish_date.slice(5) + ' 出爐')
    }));

    // ── inventory ──
    // 包裝換算:結存 → 幾個未開封採購包裝 + 1 個開封中(剩多少)。做麵包不會整袋用完,
    // 實際倉庫樣貌 = N 袋全新 + 開封 1 袋 — 盤點時對這個數最直覺。
    const pkgOf = (g, s) => {
      const conv = this.n(g.conversion_rate) || 1, u = g.purchase_unit;
      if (!u || u === '自製' || conv <= 1 || s <= 0) return '—';
      const full = Math.floor(s / conv), rem = Math.round((s - full * conv) * 10) / 10;
      if (!rem) return full + ' ' + u + '未開封';
      if (!full) return '1 ' + u + '開封中(剩 ' + kg(rem) + ')';
      return full + ' ' + u + '未開封 + 1 ' + u + '開封中(剩 ' + kg(rem) + ')';
    };
    const isIng = S.invTab === 'ingredient';
    const invNeed = this.mrpNeed(); // 庫存頁自用(排程+草稿生產單展開需求;外層 need 在其他區塊作用域)
    const invBase = isIng ? this.t('ingredient').filter(g => this.stocksAt(this.THIS_LOC, g.ingredient_id) || this.stock('ingredient', g.ingredient_id) > 0 || (invNeed[g.ingredient_id] || 0) > 0) : this.t('product'); // 有生產需求的也要出現(即使未備料)
    const invCatF = S.invCatFilter || '全部';
    const invCats = []; if (isIng) for (const g of invBase) { const cn = this.gcat(g); if (cn && invCats.indexOf(cn) < 0) invCats.push(cn); }
    const invCatTabs = ['全部'].concat(this.catSorted(invCats)).map(c => Object.assign(
      this.catPill(c, c === invCatF, () => this.setState({ invCatFilter: c })),
      { name: c === '全部' ? '全部 ' + invBase.length : c }
    ));
    const invSortV = {
      id: r => isIng ? r.ingredient_id : r.product_id, name: r => r.name || '', cat: r => (isIng ? this.gcat(r) : r.type) || '', stock: r => this.stock(S.invTab, isIng ? r.ingredient_id : r.product_id), safe: r => isIng ? this.safetyAt(this.THIS_LOC, r.ingredient_id) : 0,
      st: r => { // 狀態排序:需求缺口(0) → 低庫存(0.5) → 接近下限(1) → 正常(2)
        if (!isIng) return 2;
        const id = r.ingredient_id, st0 = this.stock(S.invTab, id), sf = this.safetyAt(this.THIS_LOC, id);
        if ((invNeed[id] || 0) > st0) return 0;
        return st0 < sf ? 0.5 : st0 < sf * 1.2 ? 1 : 2;
      }
    };
    const invRows = this.lsort('lsInv', this.lfilter('lsInv', (isIng && invCatF !== '全部' ? invBase.filter(g => this.gcat(g) === invCatF) : invBase), [r => isIng ? r.ingredient_id : r.product_id, 'name', r => this.gcat(r), 'type']), invSortV).map(r => {
      const id = isIng ? r.ingredient_id : r.product_id;
      const st = this.stock(S.invTab, id);
      const safe = isIng ? this.safetyAt(this.THIS_LOC, id) : 0;
      const nd0 = isIng ? (invNeed[id] || 0) : 0; // 排程+草稿生產單的展開需求(含自製半成品的原料)
      const needGap = isIng && nd0 > st && !this.isFreeRes(r);
      const low = isIng && !needGap && st < safe;
      const warnAmb = isIng && !needGap && !low && st < safe * 1.2;
      return {
        id, name: r.name, cat: isIng ? this.gcat(r) : (r.type === 'bread' ? '麵包' : r.type === 'dessert' ? '甜點' : '堂食'),
        stockTxt: isIng ? kg(st) : this.fmt(st) + ' 個',
        pkgTxt: isIng ? pkgOf(r, st) : '—',
        stockStyle: needGap || low ? 'color:#c11f28;font-weight:600' : warnAmb ? 'color:#946800;font-weight:600' : '',
        safeTxt: isIng ? kg(safe) : '—',
        tagTxt: needGap ? '需求缺口 ' + kg(nd0 - st) : low ? '低庫存' : warnAmb ? '接近下限' : '正常',
        tagStyle: this.tag(needGap || low ? C.red : warnAmb ? C.amb : C.grn),
        rowStyle: S.selItem === id ? 'background:#e0f0f4;cursor:pointer' : 'cursor:pointer',
        onSel: () => this.setState({ selItem: id })
      };
    });
    const selRow = isIng ? this.ing(S.selItem) : this.prod(S.selItem);
    const srcZh = { purchase: '進貨入庫', production_out: '生產投料', production_in: '生產入庫', sales: '銷售', waste: '報廢', stocktake: '盤點調整', transfer_in: '中央調撥入庫', transfer_out: '調撥出庫', purchase_return: '採購退貨' };
    let bal = 0;
    const led = this.t('stock_ledger').filter(l => l.item_type === S.invTab && l.item_id === S.selItem && (l.location_id || 'LOC-A') === this.THIS_LOC)
      .map(l => { bal += (l.direction === 'in' ? 1 : -1) * this.n(l.qty); return Object.assign({ bal }, l); });
    const ledgerRows = led.slice().reverse().slice(0, 10).map(l => ({
      date: String(l.txn_date).slice(5).replace('T', ' '), src: (srcZh[l.source_type] || l.source_type) + ' ' + l.source_id,
      qtyTxt: (l.direction === 'in' ? '+' : '−') + this.fmt(this.n(l.qty)),
      qtyStyle: l.direction === 'in' ? 'color:#177a4c' : 'color:#c11f28',
      balTxt: this.fmt(l.bal)
    }));
    const curStock = this.stock(S.invTab, S.selItem);

    // ── 叫貨與採購(中央倉模式):① 門市叫貨 ② 中央出貨 ③ 中央採購 ──
    const pendReqCount2 = this.t('ingredient_request').filter(r => r.status === '待處理').length;
    const buyable = g => g.purchase_unit !== '自製'; // 自製=明確標記;沒設廠商仍可採購(下單時選廠商)
    // 視角隔離:中央倉沒有「① 門市叫貨」;門市沒有「② 中央倉出貨 / ③ 中央採購」(那是中央倉的管理)
    const puV = atCentral ? (S.puView === 'store' ? 'central' : S.puView) : 'store';
    const allTO = this.t('transfer_order');
    // 門市↔中央以「包/箱/瓶」溝通:外購原料顯示包數(散裝只用於自製半成品)
    const qtyUnitTxt = (g, q) => this.isPackaged(g) ? this.pkgTxt(g, q) : kg(this.n(q));
    // 原料資訊列(對齊「產品與配方」的顯示):ING id · 供應商 · 分類
    const supNmP = {}; for (const s2 of this.t('supplier')) supNmP[s2.supplier_id] = s2.name;
    const ingSub = g => [g.ingredient_id, supNmP[g.default_supplier_id] || (g.purchase_unit === '自製' ? '自製' : ''), this.gcat(g)].filter(Boolean).join(' · ');
    const toTxt = id => this.t('transfer_line').filter(l => l.to_id === id).map(l => { const g = this.ing(l.ingredient_id) || {}; return (g.name || l.ingredient_id) + ' ' + qtyUnitTxt(g, l.qty); }).join('、');
    // 在途/已叫量(本店):狀態=叫貨或已出貨的明細加總 → 建議量會扣除,避免重複叫貨
    const transitMine = iid => {
      let q = 0;
      for (const t of allTO) {
        if (t.to_loc !== this.THIS_LOC || (t.status !== '叫貨' && t.status !== '已出貨')) continue;
        for (const l of this.t('transfer_line')) if (l.to_id === t.to_id && l.ingredient_id === iid) q += this.n(l.qty);
      }
      return q;
    };
    // ① 門市叫貨建議(排程缺口+安全庫存,扣在途;自製原料仍走續養)
    const tsSugRows = this.shortages().map(x => {
      // 自製半成品:中央有備 → 可向中央叫貨;中央沒備 → 排入續養(本店自製)
      if (!buyable(x.g) && !this.stocksAt(this.CENTRAL, x.g.ingredient_id)) return {
        name: x.g.name, sub: ingSub(x.g), why: x.why, whyStyle: this.tag(x.why === '排程缺口' ? C.red : C.amb),
        sugTxt: kg(x.short), sugSub: '自製', btnTxt: '排入續養',
        onAdd: () => this.schedulePrep(x.g.ingredient_id, x.short)
      };
      const tq = transitMine(x.g.ingredient_id);
      const eff = Math.max(0, x.short - tq);
      const rq = eff > 0 ? this.pkgCeil(x.g, eff) : 0; // 叫貨以整包計
      const pk2 = this.isPackaged(x.g);
      return {
        name: x.g.name, sub: ingSub(x.g), why: x.why, whyStyle: this.tag(x.why === '排程缺口' ? C.red : C.amb),
        // 主行短而不折行(1 包 / 2.4 kg);細節下移小字:每包規格・實缺・在途
        sugTxt: eff > 0 ? (pk2 ? this.pkgTxt(x.g, rq) : kg(eff)) : '在途補足中',
        sugSub: eff > 0
          ? [(pk2 ? '每' + (x.g.purchase_unit || '包') + ' ' + kg(this.n(x.g.conversion_rate)) : ''), '缺 ' + kg(eff), (tq ? '在途 ' + kg(tq) : '')].filter(Boolean).join(' · ')
          : '在途 ' + kg(tq),
        btnTxt: eff > 0 ? '加入 →' : '已叫貨',
        onAdd: eff > 0 ? () => this.addDraft(x.g.ingredient_id, eff, true) : () => this.notify('已叫貨 — 等中央出貨後回此頁「確認收貨」')
      };
    });
    const tsDraftRows = S.toDraft.map((ln, i) => {
      const g = this.ing(ln.iid) || {};
      if (this.isPackaged(g)) {
        // 外購原料:直接以「包數」輸入(整數),底層仍存 g;跟中央溝通就是「我要幾包/幾箱」
        const conv = this.n(g.conversion_rate) || 1;
        return {
          name: g.name || ln.iid, sub: ingSub(g), qtyVal: String(Math.round(this.n(ln.qty) / conv * 10) / 10),
          unit: (g.purchase_unit || '包') + '(每' + (g.purchase_unit || '包') + ' ' + kg(conv) + ',共 ' + kg(this.n(ln.qty)) + ')',
          onQty: e => { const pk = Math.max(1, Math.ceil(this.n(e.target.value))); const d = S.toDraft.slice(); d[i] = Object.assign({}, d[i], { qty: String(pk * conv) }); this.setState({ toDraft: d }); },
          onRemove: () => this.setState({ toDraft: S.toDraft.filter((_, j) => j !== i) })
        };
      }
      return {
        name: g.name || ln.iid, sub: ingSub(g), qtyVal: ln.qty, unit: (g.base_unit || 'g') + '(自製半成品,散秤)',
        onQty: e => { const d = S.toDraft.slice(); d[i] = Object.assign({}, d[i], { qty: e.target.value }); this.setState({ toDraft: d }); },
        onRemove: () => this.setState({ toDraft: S.toDraft.filter((_, j) => j !== i) })
      };
    });
    // 半成品也可叫貨(中央做好調撥門市);只排除本店未配置的
    const tsIngOptions = this.t('ingredient').filter(g => this.stocksAt(this.THIS_LOC, g.ingredient_id)).map(g => ({ id: g.ingredient_id, name: g.name, meta: [this.gcat(g), buyable(g) ? '' : '自製'].filter(Boolean).join('・') }));
    const effTsIng = (this.ing(S.tsAddIng) && buyable(this.ing(S.tsAddIng))) ? S.tsAddIng : (tsIngOptions[0] || {}).id || '';
    const stTO = { '叫貨': ['待中央出貨', C.amb], '已出貨': ['在途 — 可收貨', C.acc], '已收貨': ['已收貨', C.grn], '取消': ['取消', C.mut] };
    const tsMyRows = allTO.filter(t => t.to_loc === this.THIS_LOC).slice().reverse().slice(0, 6).map(t => {
      const tg = stTO[t.status] || [t.status, C.mut];
      return {
        id: t.to_id, tag: tg[0], tagStyle: this.tag(tg[1]),
        needTag: (t.urgent === 'TRUE' ? '急件' : '') + (t.need_date ? (t.urgent === 'TRUE' ? ' · ' : '') + '需求 ' + String(t.need_date).slice(5) : ''),
        needStyle: (t.urgent === 'TRUE' ? this.tag(C.red) : 'color:#66707f;border-color:#e3e6eb') + (((t.urgent === 'TRUE' || t.need_date) && t.status !== '已收貨' && t.status !== '取消') ? '' : ';display:none'),
        dateTxt: (t.status === '已收貨' ? '收貨 ' + String(t.receive_date).slice(5, 16) : t.status === '已出貨' ? '出貨 ' + String(t.ship_date).slice(5, 16) : '叫貨 ' + String(t.request_date).slice(5, 16)).replace('T', ' '),
        txt: toTxt(t.to_id),
        recvStyle: t.status === '已出貨' ? 'flex:1;text-align:center;padding:8px 0' : 'display:none', doRecv: () => this.recvTO(t),
        cancelStyle: t.status === '叫貨' ? '' : 'display:none', doCancel: () => this.cancelTO(t)
      };
    });
    // ② 中央倉:待出貨叫貨單 + 即時庫存 + 在途
    const pendTOs = allTO.filter(t => t.status === '叫貨');
    const shipTOs = allTO.filter(t => t.status === '已出貨');
    const pendingAll = iid => {
      let q = 0;
      for (const t of pendTOs) for (const l of this.t('transfer_line')) if (l.to_id === t.to_id && l.ingredient_id === iid) q += this.n(l.qty);
      return q;
    };
    // 採購在途(已下單未到,基本單位):建議量要扣掉,避免重複下單
    const onOrder = iid => {
      let q = 0;
      for (const r of this.t('purchase_line')) {
        if (r.ingredient_id !== iid || (r.location_id || 'LOC-A') !== this.CENTRAL || r.status === '已過帳') continue;
        const rem = this.n(r.qty) - this.n(r.received_qty);
        if (rem > 0) { const g = this.ing(iid); q += rem * (this.n((g || {}).conversion_rate) || 1); }
      }
      return q;
    };
    const prioSort = (a, b) => ((b.urgent === 'TRUE') - (a.urgent === 'TRUE')) || String(a.need_date || '9999').localeCompare(String(b.need_date || '9999'));
    const tcPending = pendTOs.slice().sort(prioSort).map(t => {
      const ls = this.t('transfer_line').filter(l => l.to_id === t.to_id).map(l => {
        const g = this.ing(l.ingredient_id) || {};
        const cs = this.stock('ingredient', l.ingredient_id, this.CENTRAL);
        const ok = cs >= this.n(l.qty);
        return { name: g.name || l.ingredient_id, sub: ingSub(g), qtyTxt: qtyUnitTxt(g, l.qty), stockTxt: qtyUnitTxt(g, cs), okTxt: ok ? '足夠' : '不足', okStyle: this.tag(ok ? C.grn : C.red), _ok: ok, _s: cs };
      });
      const allOk = ls.length > 0 && ls.every(x => x._ok);
      const anyStock = ls.some(x => x._s > 0);
      return {
        id: t.to_id, store: this.locName(t.to_loc) + (t.to_loc === this.THIS_LOC ? '(本店)' : ''), storeStyle: this.tag(C.acc),
        prioTag: (t.urgent === 'TRUE' ? '急件' : '') + (t.need_date ? (t.urgent === 'TRUE' ? ' · ' : '') + '需求 ' + String(t.need_date).slice(5) : ''),
        prioStyle: (t.urgent === 'TRUE' ? this.tag(C.red) : 'color:#66707f;border-color:#e3e6eb') + ((t.urgent === 'TRUE' || t.need_date) ? '' : ';display:none'),
        date: String(t.request_date).slice(5, 16).replace('T', ' '),
        lines: ls, doShip: () => this.shipTO(t),
        shipStyle: allOk ? '' : 'opacity:.45;pointer-events:none',
        partStyle: allOk ? 'display:none' : (anyStock ? '' : 'opacity:.45;pointer-events:none'),
        doPart: () => this.partialShipTO(t),
        lackTxt: allOk ? '' : '⚠ 短缺 — 「部分出貨」先出有貨部分、餘量轉補貨單;或到 ③ 進貨後全量出', lackStyle: allOk ? 'display:none' : 'font-size:11.5px;color:#c11f28'
      };
    });
    const cInvRows = this.t('ingredient').filter(g => buyable(g) || this.stocksAt(this.CENTRAL, g.ingredient_id)).map(g => ({ g, s: this.stock('ingredient', g.ingredient_id, this.CENTRAL), dm: pendingAll(g.ingredient_id), cfg: this.stocksAt(this.CENTRAL, g.ingredient_id) }))
      .filter(x => x.cfg || x.s > 0 || x.dm > 0)
      .map(x => ({
        name: x.g.name, sub: ingSub(x.g), stockTxt: qtyUnitTxt(x.g, x.s), needTxt: x.dm ? qtyUnitTxt(x.g, x.dm) : '—',
        tagTxt: x.s < x.dm ? '不足' : (x.s - x.dm) < this.safetyAt(this.CENTRAL, x.g.ingredient_id) ? '偏低' : '正常',
        tagStyle: this.tag(x.s < x.dm ? C.red : (x.s - x.dm) < this.safetyAt(this.CENTRAL, x.g.ingredient_id) ? C.amb : C.grn)
      }));
    const tcShipped = shipTOs.map(t => ({ id: t.to_id, store: this.locName(t.to_loc) + (t.to_loc === this.THIS_LOC ? '(本店)' : ''), txt: toTxt(t.to_id) + ' · ' + String(t.ship_date).slice(5, 10) + ' 出貨' }));
    // ③ 中央採購建議:需求 = 各店待出貨叫貨 + 安全庫存,對中央倉庫存
    const sugRows = this.t('ingredient').filter(buyable).map(g => {
      const s = this.stock('ingredient', g.ingredient_id, this.CENTRAL);
      const pend = pendingAll(g.ingredient_id);
      // 中央不備的料:只在有門市叫貨時才建議代購(安全庫存 0)
      if (!this.stocksAt(this.CENTRAL, g.ingredient_id) && pend <= 0) return { g, s, pend, short: 0 };
      const short = Math.max(0, pend + this.safetyAt(this.CENTRAL, g.ingredient_id) - s - onOrder(g.ingredient_id));
      return { g, s, pend, short };
    }).filter(x => x.short > 0 && !S.poLines.some(l => l.iid === x.g.ingredient_id)) // 已加入進貨單/已下單在途的不再列,清單保持乾淨
      .map(x => {
        const conv = this.n(x.g.conversion_rate) || 1;
        const units = Math.max(1, Math.ceil(x.short / conv));
        return {
          name: x.g.name, sub: ingSub(x.g),
          why: x.pend > x.s ? '叫貨缺口' : '低於安全庫存',
          whyStyle: this.tag(x.pend > x.s ? C.red : C.amb),
          sugTxt: units + ' ' + (x.g.purchase_unit || '單位'),
          sugSub: kg(units * conv),
          btnTxt: '加入 →',
          onAdd: () => this.setPoDraft({ poLines: S.poLines.concat([{ iid: x.g.ingredient_id, units: String(units), price: this.poPrice(x.g), tax: String(this.poTax(x.g)) }]) })
        };
      });
    const sugAllBtn = sugRows.length > 1;
    // 進貨單草稿:依「原料的預設供應商」自動分組 → 送出時一組一張採購單(不可能跨供應商同一張單)
    const poGroupMap = {};
    S.poLines.forEach((ln, i) => {
      const g = this.ing(ln.iid); if (!g) return;
      const sid = g.default_supplier_id || '';
      (poGroupMap[sid] = poGroupMap[sid] || []).push({ ln, i, g });
    });
    const poNm0 = (S.poName || '').trim();
    const poGroups = Object.keys(poGroupMap).sort().map((sid, gi) => {
      const sp = this.t('supplier').find(s2 => s2.supplier_id === sid);
      const gt = poGroupMap[sid].reduce((a, x) => a + this.n(x.ln.units) * this.n(x.ln.price) * this.lnTax(x.ln), 0);
      // 整張單的稅率:全部同值 → 顯示該值;不一致 → 空(placeholder 混);改它 = 整組行一起改,單行仍可個別調
      const taxSet = {}; poGroupMap[sid].forEach(x => { taxSet[String(this.lnTax(x.ln))] = 1; });
      const taxKeys = Object.keys(taxSet);
      const gpTax = taxKeys.length === 1 ? taxKeys[0] : '';
      const nmv = (S.poNameBySup || {})[sid] !== undefined ? (S.poNameBySup || {})[sid] : (poNm0 || '未命名') + '-' + String(gi).padStart(2, '0');
      const vlen = s => [...String(s)].reduce((a, c) => a + (c.charCodeAt(0) > 255 ? 2 : 1), 0);
      return {
        supName: sp ? sp.name : '⚠ 未設供應商(先到原料目錄補)',
        supStyle: sp ? 'color:#1b2330' : 'color:#c11f28',
        way: sp ? [sp.contact_person, sp.phone || sp.email || sp.address].filter(Boolean).join(' ') : '',
        // 統一名字 + 分單流水號(補貨-00、補貨-01…)只是預設,每張單名可自行改;寬度隨內容
        nameVal: nmv, nameW: Math.max(12, vlen(nmv) + 5) + 'ch',
        onName: e => this.setPoDraft({ poNameBySup: Object.assign({}, S.poNameBySup, { [sid]: e.target.value }) }),
        taxVal: gpTax, taxW: Math.max(8, String(gpTax).length + 5) + 'ch',
        onTaxAll: e => {
          const v = e.target.value;
          const nt = this.n(v) > 0 ? this.n(v) : 1;
          const mine2 = {}; poGroupMap[sid].forEach(x => { mine2[x.i] = 1; });
          // 整單改稅率:每行含稅價不動、稅前反推
          this.setPoDraft({ poLines: S.poLines.map((l, j) => mine2[j] ? Object.assign({}, l, { tax: v, price: String(+(this.n(l.price) * this.lnTax(l) / nt).toFixed(4)) }) : l) });
          poGroupMap[sid].forEach(x => this.syncQuoteFromPO(x.ln.iid, this.n(x.ln.price) * this.lnTax(x.ln) / nt, nt));
        },
        etaVal: (S.poEtaBySup || {})[sid] || S.poEta || this.addDays(this.TODAY, 2),
        onEta: e => this.setPoDraft({ poEtaBySup: Object.assign({}, S.poEtaBySup, { [sid]: e.target.value }) }),
        cnt: poGroupMap[sid].length + ' 項', subTotal: 'NT$' + this.fmt(+gt.toFixed(2), gt % 1 ? 2 : 0),
        rows: poGroupMap[sid].map(({ ln, i, g }) => {
          const conv = this.n(g.conversion_rate) || 1;
          const tx = this.lnTax(ln);
          const w = s => Math.max(6.5, String(s === undefined || s === null ? '' : s).length + 5) + 'ch'; // 輸入框寬=內容長+內距,保證不截斷
          return {
            name: g.name, unitTxt: ingSub(g) + ' · ' + (g.purchase_unit || '包') + '(=' + kg(conv) + ')',
            qtyVal: ln.units, qtyW: w(ln.units), onQty: e => { const p = S.poLines.slice(); p[i] = Object.assign({}, p[i], { units: e.target.value }); this.setPoDraft({ poLines: p }); },
            priceVal: ln.price, priceW: w(ln.price), onPrice: e => { const p = S.poLines.slice(); p[i] = Object.assign({}, p[i], { price: e.target.value }); this.setPoDraft({ poLines: p }); this.syncQuoteFromPO(ln.iid, e.target.value, tx); },
            taxVal: String(tx), taxW: w(tx),
            // 改稅率:含稅單價不動,稅前反推(廠商報的是含稅價)
            onTax: e => { const p = S.poLines.slice(); const nt = this.n(e.target.value) > 0 ? this.n(e.target.value) : 1; const np = +(this.n(ln.price) * tx / nt).toFixed(4); p[i] = Object.assign({}, p[i], { tax: e.target.value, price: String(np) }); this.setPoDraft({ poLines: p }); this.syncQuoteFromPO(ln.iid, np, nt); },
            taxedVal: String(+(this.n(ln.price) * tx).toFixed(2)), taxedW: w(+(this.n(ln.price) * tx).toFixed(2)),
            // 直接填含稅單價 → 稅前自動反推
            onTaxed: e => { const p = S.poLines.slice(); const np = +(this.n(e.target.value) / tx).toFixed(4); p[i] = Object.assign({}, p[i], { price: String(np) }); this.setPoDraft({ poLines: p }); this.syncQuoteFromPO(ln.iid, np, tx); },
            subtotal: (() => { const st = this.n(ln.units) * this.n(ln.price) * tx; return this.fmt(+st.toFixed(2), st % 1 ? 2 : 0); })(), // 不四捨五入到整數,保留小數
            onRemove: () => this.setPoDraft({ poLines: S.poLines.filter((_, j) => j !== i) })
          };
        })
      };
    });
    const poSubmitTxt = poGroups.length > 1 ? '送出採購單(拆 ' + poGroups.length + ' 張)' : '送出採購單';
    const poEmptyStyle = S.poLines.length ? 'display:none' : 'padding:14px 16px;font-size:12px;color:#66707f';
    const poTotal = (() => { const t = S.poLines.reduce((a, l) => a + this.n(l.units) * this.n(l.price) * this.lnTax(l), 0); return 'NT$' + this.fmt(+t.toFixed(2), t % 1 ? 2 : 0) + '(含稅)'; })();
    const supOptions = this.t('supplier').map(s => ({ id: s.supplier_id, name: s.name }));

    // ── ingredient master ──
    const catFilter = S.ingCatFilter || '全部';
    const catsInUse = []; for (const g of this.t('ingredient')) { const cn = this.gcat(g); if (cn && catsInUse.indexOf(cn) < 0) catsInUse.push(cn); }
    const ingCatTabs = ['全部'].concat(this.catSorted(catsInUse)).map(c => Object.assign(
      this.catPill(c, c === catFilter, () => this.setState({ ingCatFilter: c })),
      { name: c === '全部' ? '全部 ' + this.t('ingredient').length : c }
    ));
    const supNmI = {}; for (const s2 of this.t('supplier')) supNmI[s2.supplier_id] = s2.name;
    const ingSortV = { id: g => g.ingredient_id, name: g => g.name || '', cat: g => this.gcat(g), quote: g => this.n(g.quote_price) > 0 ? this.n(g.quote_price) : this.n(g.quote_price_pre) * (this.n(g.tax_rate) || 1), cost: g => this.n(g.latest_unit_cost), sup: g => supNmI[g.default_supplier_id] || '' };
    const ingRows = this.lsort('lsIng', this.lfilter('lsIng', this.t('ingredient').filter(g => catFilter === '全部' || this.gcat(g) === catFilter), ['ingredient_id', 'name', g => this.gcat(g), g => supNmI[g.default_supplier_id]]), ingSortV).map(g => ({
      id: g.ingredient_id, name: g.name, cat: this.gcat(g), base: g.base_unit,
      convTxt: '1 ' + (g.purchase_unit || '—') + ' = ' + this.fmt(this.n(g.conversion_rate)) + ' ' + g.base_unit,
      safeTxt: this.t('location').filter(l => this.stocksAt(l.location_id, g.ingredient_id)).map(l => l.name.replace(/店$/, '')).join('・') || '—',
      quoteTxt: this.n(g.quote_price) > 0 ? this.fmt(Math.round(this.n(g.quote_price))) + ' /' + (g.purchase_unit || '單位') : '—', // quote_price 本身已含稅
      costTxt: this.n(g.latest_unit_cost).toFixed(3) + ' /' + g.base_unit,
      sup: (this.t('supplier').find(s => s.supplier_id === g.default_supplier_id) || {}).name || '—',
      rowStyle: S.selIng === g.ingredient_id ? 'background:#e0f0f4;cursor:pointer' : 'cursor:pointer',
      onSel: () => this.setState({ selIng: g.ingredient_id, draft: null })
    }));
    const selG = this.ing(S.selIng) || {};
    const d = S.draft || { name: selG.name, category: selG.category, base_unit: selG.base_unit, safety_stock: selG.safety_stock, conversion_rate: selG.conversion_rate, purchase_unit: selG.purchase_unit, shelf_life_days: selG.shelf_life_days, default_supplier_id: selG.default_supplier_id, latest_unit_cost: selG.latest_unit_cost, quote_price: selG.quote_price, tax_rate: selG.tax_rate };
    const setD = k => e => this.setState({ draft: Object.assign({}, d, { [k]: e.target.value }) });
    const ingUsage = this.t('bom').filter(b => b.ingredient_id === S.selIng).map(b => (this.prod(b.product_id) || {}).name).join('、');
    // 分類主檔(可增刪)
    const cats = this.t('category');
    const catOptions = cats.map(c => c.name);
    const dCatN = this.catName(d.category); if (dCatN && catOptions.indexOf(dCatN) < 0) catOptions.unshift(dCatN);
    const catVals = {
      catOptions,
      catPanelStyle: S.catOpen ? 'grid-column:1 / -1;border:1px solid #e3e6eb;border-radius:8px;padding:10px;background:#f7f8fa' : 'display:none',
      toggleCats: () => this.setState({ catOpen: !S.catOpen }),
      catToggleTxt: S.catOpen ? '收合' : '管理',
      catChips: cats.map(c => ({
        name: c.name,
        onDel: () => {
          const used = this.t('ingredient').filter(g => this.gcat(g) === c.name).length;
          if (used) { this.notify('✕ 無法刪除「' + c.name + '」:仍有 ' + used + ' 項原料使用此分類'); return; }
          db.replace('category', cats.filter(x => x.category_id !== c.category_id));
          this.forceUpdate();
        }
      })),
      newCatVal: S.newCat, onNewCat: e => this.setState({ newCat: e.target.value }),
      addCat: () => {
        const nm = S.newCat.trim();
        if (!nm) { this.notify('請輸入分類名稱'); return; }
        if (catOptions.indexOf(nm) >= 0) { this.notify('「' + nm + '」已存在'); return; }
        db.replace('category', cats.concat([{ category_id: db.nextId('category', 'category_id', 'CAT-', 2), name: nm }]));
        this.setState({ newCat: '' });
        this.notify('✓ 已新增分類「' + nm + '」');
      }
    };

    // ── products / bom ──
    const selP = this.prod(S.selProd) || {};
    const isIngSel = this.isIngId(S.selProd);
    const prodScope = this.prodScope(); // 'all'=中央全部;否則為門市 id
    const inProdScope = p => prodScope === 'all' || this.prodAtStore(p, prodScope);
    // 自製半成品是共用目錄：各店都可在配方中使用；備料(location_stock)只決定哪家店自己備、可各自客製 → 不過濾，只加標記
    const selfIngs = this.t('ingredient').filter(g => g.purchase_unit === '自製');
    const prodLocTabs = [{ id: 'all', name: '全部' }].concat(this.t('location').filter(l => l.type !== 'central').map(l => ({ id: l.location_id, name: l.name }))).map(o => ({
      name: o.name,
      style: 'padding:4px 11px;border-radius:7px;cursor:pointer;font-size:12px;user-select:none' + (prodScope === o.id ? ';background:#0e7490;color:#fff;font-weight:600' : ';color:#66707f;border:1px solid #e3e6eb'),
      go: () => this.setState({ prodLoc: o.id })
    }));
    const prodLocBarStyle = atCentral ? 'display:flex;gap:5px;padding:8px 12px;border-bottom:1px solid #eef0f3;flex-wrap:wrap;align-items:center' : 'display:none';
    const prodListRows = this.lfilter('lsProd', this.t('product').filter(inProdScope), ['product_id', 'name', 'type']).map(p => ({
      name: p.name, sub: (atCentral ? (this.prodShared(p) ? '共用 · ' : this.prodLocList(p).map(x => this.locName(x)).join('、') + ' · ') : '') + (this.leadOf(p.product_id) ? '跨 ' + this.leadOf(p.product_id) + ' 天' : '當日') + ' · NT$' + p.sale_price,
      rowStyle: S.selProd === p.product_id ? 'background:#e0f0f4;cursor:pointer' : 'cursor:pointer',
      onSel: () => this.setState({ selProd: p.product_id })
    })).concat(selfIngs.map(g => ({
      name: '🫙 ' + g.name, sub: '自製半成品' + (prodScope !== 'all' ? (this.stocksAt(prodScope, g.ingredient_id) ? ' · 已備料' : ' · 共用(未備料)') : '') + ' · 批產 ' + this.fmt(this.n(g.batch_yield) || 1) + ' g · ' + this.n(g.latest_unit_cost).toFixed(2) + '/g',
      rowStyle: S.selProd === g.ingredient_id ? 'background:#e0f0f4;cursor:pointer' : 'cursor:pointer',
      onSel: () => this.setState({ selProd: g.ingredient_id })
    })));
    // 選取產品不在目前地點範圍 → 退回範圍內第一個；半成品共用、不受限
    if (db && prodScope !== 'all') {
      const inSel = (this.prod(S.selProd) && this.prodAtStore(this.prod(S.selProd), prodScope)) || this.isIngId(S.selProd);
      if (!inSel) { const first = ((this.t('product').filter(inProdScope)[0] || {}).product_id) || ((selfIngs[0] || {}).ingredient_id); if (first && first !== S.selProd) setTimeout(() => this.setState({ selProd: first }), 0); }
    }
    const setP = k => e => db.replace('product', this.t('product').map(p => p.product_id === S.selProd ? Object.assign({}, p, { [k]: e.target.value }) : p)) || this.forceUpdate();
    const setR = (rid, k) => e => { db.replace('routing', this.t('routing').map(r => r.routing_id === rid ? Object.assign({}, r, { [k]: e.target.value }) : r)); this.forceUpdate(); };
    const bomRows = this.bomOf(S.selProd).map(b => {
      const g = this.ing(b.ingredient_id) || {};
      return {
        name: g.name, qtyVal: b.qty_per_yield,
        supTxt: (this.t('supplier').find(s2 => s2.supplier_id === g.default_supplier_id) || {}).name || (g.purchase_unit === '自製' ? '自製' : '—'),
        catTxt: this.gcat(g) || '—',
        onQty: e => { db.replace('bom', this.t('bom').map(x => x.bom_id === b.bom_id ? Object.assign({}, x, { qty_per_yield: e.target.value }) : x)); this.forceUpdate(); },
        price: this.n(g.latest_unit_cost).toFixed(3),
        cost: this.fmt(this.n(b.qty_per_yield) * this.n(g.latest_unit_cost), 1),
        onRemove: () => { db.replace('bom', this.t('bom').filter(x => x.bom_id !== b.bom_id)); this.forceUpdate(); }
      };
    });
    const selfG = this.ing(S.selProd) || {};
    const yieldN = Math.max(this.n(isIngSel ? selfG.batch_yield : selP.default_yield), 0) || 1; // 0/空/負 → 1
    const bCost = this.bomOf(S.selProd).reduce((a, b) => a + this.n(b.qty_per_yield) * this.n((this.ing(b.ingredient_id) || {}).latest_unit_cost), 0);
    const uCost = bCost / yieldN; const marginV = this.n(selP.sale_price) - uCost;
    const eqOptions = [{ id: '', name: '—(無設備)' }].concat(this.t('equipment').map(e => ({ id: e.equipment_id, name: e.name })));
    const routRows = this.routingOf(S.selProd).map(r => ({
      no: r.step_no,
      nameVal: r.step_name, onName: setR(r.routing_id, 'step_name'),
      durVal: r.duration_min, onDur: setR(r.routing_id, 'duration_min'),
      eqVal: r.equipment_id || '', onEq: setR(r.routing_id, 'equipment_id'),
      eqBtn: this.ddBtn(eqOptions, r.equipment_id || '', v => { db.replace('routing', this.t('routing').map(x => x.routing_id === r.routing_id ? Object.assign({}, x, { equipment_id: v }) : x)); this.forceUpdate(); }),
      cdTxt: '跨日', cdStyle: (r.cross_day === 'TRUE' ? this.tag(C.amb) : 'color:#9aa2ae;border-color:#e3e6eb') + ';cursor:pointer;user-select:none',
      onCd: () => { db.replace('routing', this.t('routing').map(x => x.routing_id === r.routing_id ? Object.assign({}, x, { cross_day: x.cross_day === 'TRUE' ? 'FALSE' : 'TRUE' }) : x)); this.forceUpdate(); },
      onRemove: () => { db.replace('routing', this.t('routing').filter(x => x.routing_id !== r.routing_id)); this.forceUpdate(); }
    }));
    const ingOptions = this.t('ingredient').map(g => ({ id: g.ingredient_id, name: g.name }));

    // ── suppliers / equipment(可增改刪)──
    const setSup = (id, k) => e => { db.replace('supplier', this.t('supplier').map(s => s.supplier_id === id ? Object.assign({}, s, { [k]: e.target.value }) : s)); this.forceUpdate(); };
    // 供應商清單:欄頭可排序(名稱/聯絡/付款/供應數,點三下還原);列收合,點擊展開編輯
    const supCnt = {}; for (const g of this.t('ingredient')) if (g.default_supplier_id) supCnt[g.default_supplier_id] = (supCnt[g.default_supplier_id] || 0) + 1;
    const sSort = S.supSort || null;
    const supSortVal = { name: s => s.name || '', contact: s => s.contact_person || s.phone || s.email || '', terms: s => s.payment_terms || '', cnt: s => supCnt[s.supplier_id] || 0 };
    let supList = this.lfilter('lsSup', this.t('supplier').slice(), ['supplier_id', 'name', 'contact_person', 'phone', 'email', 'address', 'payment_terms']);
    if (sSort) supList.sort((a, b) => {
      const va = supSortVal[sSort.key](a), vb = supSortVal[sSort.key](b);
      return (typeof va === 'number' ? va - vb : String(va).localeCompare(String(vb), 'zh-Hant')) * sSort.dir;
    });
    const supRows = supList.map(s => ({
      id: s.supplier_id,
      nameTxt: s.name,
      contactTxt: [s.contact_person, s.phone || s.email || s.address].filter(Boolean).join(' · ') || '—',
      termsTxt: s.payment_terms || '—',
      cntTxt: (supCnt[s.supplier_id] || 0) + ' 項',
      chev: S.supOpen === s.supplier_id ? '▼' : '▶',
      editStyle: S.supOpen === s.supplier_id ? 'padding:0 16px 12px 38px' : 'display:none',
      onToggle: () => this.setState({ supOpen: S.supOpen === s.supplier_id ? '' : s.supplier_id }),
      nameVal: s.name, onName: setSup(s.supplier_id, 'name'),
      personVal: s.contact_person || '', onPerson: setSup(s.supplier_id, 'contact_person'),
      phoneVal: s.phone || '', onPhone: setSup(s.supplier_id, 'phone'),
      emailVal: s.email || '', onEmail: setSup(s.supplier_id, 'email'),
      addrVal: s.address || '', onAddr: setSup(s.supplier_id, 'address'),
      termsVal: s.payment_terms, onTerms: setSup(s.supplier_id, 'payment_terms'),
      cnt: this.t('ingredient').filter(g => g.default_supplier_id === s.supplier_id).length,
      onDel: e => {
        if (e && e.stopPropagation) e.stopPropagation(); // ✕ 在可點擊列內,別觸發展開
        const used = this.t('ingredient').filter(g => g.default_supplier_id === s.supplier_id).length;
        if (used) { this.notify('✕ 無法刪除「' + s.name + '」:仍是 ' + used + ' 項原料的預設供應商'); return; }
        db.replace('supplier', this.t('supplier').filter(x => x.supplier_id !== s.supplier_id)); this.forceUpdate();
      }
    }));
    const EQT = ['mixer', 'proofer', 'oven'];
    const eqTypeOptions = EQT.concat(this.t('equipment').map(e => e.type).filter(t => t && EQT.indexOf(t) < 0)).map(t => ({ id: t, name: t }));
    const setEq = (id, k) => e => { db.replace('equipment', this.t('equipment').map(x => x.equipment_id === id ? Object.assign({}, x, { [k]: e.target.value }) : x)); this.forceUpdate(); };
    const eqRows = this.t('equipment').map(e => ({
      id: e.equipment_id,
      nameVal: e.name, onName: setEq(e.equipment_id, 'name'),
      typeVal: e.type, onType: setEq(e.equipment_id, 'type'),
      typeBtn: this.ddBtn(eqTypeOptions, e.type, v => { db.replace('equipment', this.t('equipment').map(x => x.equipment_id === e.equipment_id ? Object.assign({}, x, { type: v }) : x)); this.forceUpdate(); }),
      cntVal: e.count, onCnt: setEq(e.equipment_id, 'count'),
      capVal: e.capacity_per_batch, onCap: setEq(e.equipment_id, 'capacity_per_batch'),
      minVal: e.batch_minutes, onMin: setEq(e.equipment_id, 'batch_minutes'),
      onDel: () => {
        const used = this.t('routing').filter(r => r.equipment_id === e.equipment_id).length;
        if (used) { this.notify('✕ 無法刪除「' + e.name + '」:仍被 ' + used + ' 道工序使用(產品與配方 → 製程工序)'); return; }
        db.replace('equipment', this.t('equipment').filter(x => x.equipment_id !== e.equipment_id)); this.forceUpdate();
      }
    }));
    const addSup = () => { const id = db.nextId('supplier', 'supplier_id', 'SUP-', 2); db.replace('supplier', this.t('supplier').concat([{ supplier_id: id, name: '新供應商', contact_person: '', phone: '', email: '', address: '', payment_terms: '' }])); this.setState({ supOpen: id }); this.notify('✓ 已新增 ' + id + ',已展開編輯'); };
    // 供應商聯絡摘要:聯絡人 + 電話 > Email > 地址(擇一);都沒有就空
    this.supWay = s => { if (!s) return ''; const w = s.phone || s.email || s.address || ''; return [s.contact_person, w].filter(Boolean).join(' · '); };
    const addEq = () => { const id = db.nextId('equipment', 'equipment_id', 'EQ-', 2); db.replace('equipment', this.t('equipment').concat([{ equipment_id: id, name: '新設備', type: 'oven', count: '1', capacity_per_batch: '', batch_minutes: '' }])); this.forceUpdate(); this.notify('✓ 已新增 ' + id); };
    const supOptions2 = [{ id: '', name: '—(無/自製)' }].concat(this.t('supplier').map(s => ({ id: s.supplier_id, name: s.name })));

    // ── reports(近 7 日,含今天)──
    const WSTART = this.addDays(this.TODAY, -6);
    const rRangeTxt = WSTART.slice(5).replace('-', '/') + '–' + this.TODAY.slice(5).replace('-', '/');
    const wSales = this.lt('sales_line').filter(s => this.day(s.sale_date) >= WSTART && this.day(s.sale_date) <= this.TODAY);
    const grp = {};
    wSales.forEach(s => { const g = grp[s.product_id] = grp[s.product_id] || { qty: 0, rev: 0 }; g.qty += this.n(s.qty); g.rev += this.n(s.qty) * this.n(s.sale_price); });
    const marginRows = Object.keys(grp).map(pid => {
      const p = this.prod(pid) || {}; const uc = this.unitCost(pid);
      const cost = grp[pid].qty * uc; const mg = grp[pid].rev - cost;
      const pct = grp[pid].rev ? mg / grp[pid].rev * 100 : 0;
      return { name: p.name, qty: this.fmt(grp[pid].qty), rev: this.fmt(grp[pid].rev), cost: this.fmt(cost), mg: this.fmt(mg), mgN: mg, pct: pct.toFixed(1) + '%', pctStyle: pct >= 55 ? 'color:#177a4c' : 'color:#946800' };
    }).sort((a, b) => b.mgN - a.mgN);
    const rRevN = wSales.reduce((a, s) => a + this.n(s.qty) * this.n(s.sale_price), 0);
    const rCostN = Object.keys(grp).reduce((a, pid) => a + grp[pid].qty * this.unitCost(pid), 0);
    const wWaste = this.lt('waste').filter(w => this.day(w.date) >= WSTART);
    const wCost = w => this.n(w.qty) * (w.target_type === 'product' ? this.unitCost(w.target_id) : this.n((this.ing(w.target_id) || {}).latest_unit_cost));
    const wGrp = {}; wWaste.forEach(w => wGrp[w.reason] = (wGrp[w.reason] || 0) + wCost(w));
    const wMax = Math.max(1, ...Object.values(wGrp));
    const reasonCol = { '賣剩': C.red, '生產失敗': C.amb, '過期': C.mut, '試作': '#5b5f97' };
    const wasteBars = Object.keys(wGrp).map(rs => ({
      reason: rs, amt: this.canCost() ? 'NT$' + this.fmt(wGrp[rs]) : '', // 無成本權限:留相對長條、藏金額
      barStyle: 'display:block;height:100%;width:' + Math.round(wGrp[rs] / wMax * 100) + '%;background:' + (reasonCol[rs] || C.mut)
    }));
    const prodInWeek = this.t('stock_ledger').filter(l => l.source_type === 'production_in' && this.day(l.txn_date) >= WSTART && l.item_type === 'product');
    const prodCostW = prodInWeek.reduce((a, l) => a + this.n(l.qty) * this.n(l.unit_cost), 0);
    const wasteCostW = wWaste.reduce((a, w) => a + wCost(w), 0);

    // ── closing ──
    const mkSeg = (pid, cur) => ['waste', 'keep', 'staff'].map(ch => ({
      lbl: ch === 'waste' ? '報廢' : ch === 'keep' ? '留存' : '員工價',
      style: (cur === ch ? 'background:#0e7490;color:#fff;font-weight:500;' : '') + 'padding:4px 12px;cursor:pointer',
      onPick: () => this.setState({ closing: Object.assign({}, S.closing, { [pid]: ch }) })
    }));
    const closeRows = this.t('product').map(p => {
      const st = this.stock('product', p.product_id); if (st <= 0) return null;
      const cur = S.closing[p.product_id] || 'keep';
      return {
        name: p.name, qty: st, segs: mkSeg(p.product_id, cur),
        costTxt: cur === 'waste' ? (this.canCost() ? '−' + this.fmt(st * this.unitCost(p.product_id)) : '報廢') : cur === 'staff' ? '半價回收 ' + this.fmt(st * this.n(p.sale_price) / 2) : '明日續售'
      };
    }).filter(Boolean);
    const tSales = this.lt('sales_line').filter(s => this.day(s.sale_date) === this.TODAY);
    const cSalesN = tSales.reduce((a, s) => a + this.n(s.qty) * this.n(s.sale_price), 0);
    const cCogsN = tSales.reduce((a, s) => a + this.n(s.qty) * this.unitCost(s.product_id), 0);
    const tWaste = this.lt('waste').filter(w => this.day(w.date) === this.TODAY);
    const cWasteN = tWaste.reduce((a, w) => a + wCost(w), 0);

    // ── 開始設定(建置嚮導,狀態自動偵測)──
    const isDemo = this.t('sales_line').some(s => String(s.idempotency_key).indexOf('seed-') === 0)
      || this.t('product').some(p => p.product_id === 'PRD-01' && p.name === '魯邦鄉村');
    const cleared = !isDemo;
    const goCen = (scr, extra) => () => { this.setLoc(this.CENTRAL); this.setState(Object.assign({ screen: scr }, extra || {})); };
    const goStore = scr => () => { const st = this.t('location').find(l => l.type === 'store'); if (st) this.setLoc(st.location_id); this.setState({ screen: scr }); };
    const hasStoreCfg = this.t('location_stock').some(r => r.location_id !== this.CENTRAL);
    const reqsAll = this.t('ingredient_request');
    const stepDefs = [
      { title: '(可選)連線 Google Sheet 資料庫', desc: '「資料連線」完成方案 A 或 B;頂欄顯示 ☁ 已連線即可。不連線也能在本地完整試玩。', done: db.mode === 'cloud', screen: 'connect', btn: '去連線' },
      { title: '全部清空,從空表開始', desc: '資料連線 → 資料重置 →「全部清空」(點兩次確認),22 張表歸零、Sheet 同步清空;會保留中央倉地點。', done: cleared, screen: 'connect', btn: '去清空' },
      { title: '【中央】建立門市地點', desc: '切到中央倉視角 → 門市地點:新增各門市(例:信義店、大安店)。', done: cleared && this.t('location').some(l => l.type === 'store'), go: goCen('locations'), btn: '設門市' },
      { title: '【中央】新增供應商', desc: '聯絡方式、付款條件 — 之後只有中央對供應商下單。設備產能也在同頁維護。', done: cleared && this.t('supplier').length > 0, go: goCen('suppliers'), btn: '建供應商' },
      { title: '【中央】建立原料目錄', desc: '「載入常用清單」一鍵帶入約 20 項常用原料,或逐筆新增;再補預設供應商與最新單價。不用預知各店要什麼。', done: cleared && this.t('ingredient').length > 0, go: goCen('ingredients'), btn: '建目錄' },
      { title: '【門市】配置本店備料 / 申請新原料', desc: '切到門市視角 → 本店備料:從目錄「加入本店」+ 設各自安全庫存;目錄沒有的送申請(可標急件+每週用量)。', done: cleared && (hasStoreCfg || reqsAll.length > 0), go: goStore('ingredients'), btn: '去配置' },
      { title: '【中央】處理申請歸戶', desc: '原料目錄頁收件匣:轉入目錄(補參數,自動配置回申請門市)/ 併入現有 / 婉拒;急件排最前。', done: cleared && hasStoreCfg && !reqsAll.some(r => r.status === '待處理'), go: goCen('ingredients'), btn: '看申請' },
      { title: '【各地點】期初盤點', desc: '中央倉與各門市分別在庫存頁輸入實盤 → 期初流水;之後庫存全自動,不可手改。', done: cleared && this.t('stock_ledger').some(l => l.source_type === 'stocktake'), screen: 'inventory', btn: '去盤點' },
      { title: '【門市↔中央】跑一輪叫貨循環', desc: '門市叫貨(需求到貨日/急件)→ 中央出貨(短缺可部分出貨+補貨單)→ 門市確認收貨入庫。', done: cleared && this.t('transfer_order').some(t => t.status === '已收貨'), go: goStore('purchase'), btn: '去叫貨' },
      { title: '【中央】彙總採購入中央倉', desc: '需求 = 各店待出叫貨 + 中央安全庫存 − 中央庫存 → 向供應商過帳入中央倉,再補出短缺叫貨。', done: cleared && this.t('purchase_line').length > 0, go: goCen('purchase', { puView: 'buy' }), btn: '去採購' },
      { title: '【門市】建產品配方 → 排程生產 → 銷售日結', desc: '產品售價/BOM/工序 → 每日排程轉生產單、投料出爐 → 前台銷售、日結處置剩餘。', done: cleared && this.t('product').length > 0 && this.t('production_order').length > 0 && this.t('sales_line').length > 0, go: goStore('products'), btn: '建產品' }
    ];
    const curIdx = stepDefs.findIndex(s => !s.done);
    const setupSteps = stepDefs.map((s, i) => ({
      no: String(i + 1),
      title: s.title, desc: s.desc,
      numStyle: 'width:24px;height:24px;flex:none;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:12px;font-weight:600;color:#fff;background:' + (s.done ? '#177a4c' : i === curIdx ? '#0e7490' : '#c6ccd4'),
      rowStyle: 'display:flex;gap:12px;align-items:center;padding:12px 16px;border-bottom:1px solid #eef0f3' + (i === curIdx ? ';background:#e0f0f4' : ''),
      tagTxt: s.done ? '✓ 完成' : i === curIdx ? '目前步驟' : '待辦',
      tagStyle: this.tag(s.done ? C.grn : i === curIdx ? C.acc : C.mut),
      btnTxt: s.btn,
      go: s.go || (() => this.setState({ screen: s.screen }))
    }));
    const setupProg = stepDefs.filter(s => s.done).length + ' / ' + stepDefs.length + ' 完成';

    // ── 資料連線(方案 A:Sheets API 直連;方案 B:Apps Script)──
    const doPull = async okMsg => {
      this.setState({ connBusy: true });
      try {
        const missing = await db.pullAll();
        this.prunePlan();
        // user_account / role_permission 不在 SCHEMA(pullAll 不含)→ 同步時一併刷新(限能看帳號的 super_admin)
        if (this.hasPerm('screen.accounts')) this.loadAccounts(true);
        this.notify(missing.length ? '⚠ 已同步,但 Sheet 缺分頁:' + missing.join('、') + ' — 按「② 升級結構(保留資料)」補分頁;若後端太舊請重貼最新 apps-script.js 部署新版本再升級' : (okMsg || '✓ 已從 Google Sheet 載入最新資料'));
      } catch (e2) { this.notify('✕ 同步失敗:' + e2); }
      this.setState({ connBusy: false });
    };
    const saveGapiCfg = () => db.saveCfg({ kind: 'gapi', sid: S.sid.trim(), apiKey: S.gKey.trim(), clientId: S.gCid.trim() });
    const connVals = {
      connModeTxt: db.mode === 'cloud' ? (db.cfg.kind === 'gapi' ? '☁ 雲端 — Sheets API 直連' : '☁ 雲端 — Apps Script') : '本地 — 瀏覽器 CSV(未連線)',
      connModeStyle: this.tag(db.mode === 'cloud' ? C.grn : C.amb),
      connBusyStyle: S.connBusy ? 'opacity:.5;pointer-events:none' : '',
      sheetUrl: 'https://docs.google.com/spreadsheets/d/' + (S.sid || this.DEF.sid) + '/edit',
      sidVal: S.sid, onSid: e => this.setState({ sid: e.target.value }),
      gKeyVal: S.gKey, onGKey: e => this.setState({ gKey: e.target.value }),
      gCidVal: S.gCid, onGCid: e => this.setState({ gCid: e.target.value }),
      gLogin: async () => {
        saveGapiCfg(); this.setState({ connBusy: true });
        try { await db.ensureToken('consent'); this.notify('✓ Google 授權成功,已可寫入 Sheet'); }
        catch (e2) { this.notify('✕ 授權失敗:' + e2 + ' — 若為 origin/redirect 錯誤,到 GCP 憑證「已授權的 JavaScript 來源」加入本頁網域,或改用方案 B'); }
        this.setState({ connBusy: false });
      },
      gInit: async () => {
        saveGapiCfg(); this.setState({ connBusy: true });
        try { await db.gapiPushAll(); this.notify('✓ 初始化完成:分頁已建立,目前本地資料已上傳到 Sheet'); }
        catch (e2) { this.notify('✕ 初始化失敗:' + e2); }
        this.setState({ connBusy: false });
      },
      gConnect: async () => { saveGapiCfg(); db.setCloud(); await doPull('✓ 已連線 Sheets API 並載入;之後每筆過帳即時同步到 Sheet'); },
      gasUrlVal: S.apiUrl, onGasUrl: e => this.setState({ apiUrl: e.target.value }),
      gasTest: async () => {
        if (!S.apiUrl.trim()) { this.notify('請先貼上 /exec 網址'); return; }
        db.saveCfg({ kind: 'gas', url: S.apiUrl.trim() }); this.setState({ connBusy: true });
        try { const j = await db.api('action=tables'); this.notify(j.ok ? '✓ 連線成功,後端就緒' : '✕ 回應異常:' + (j.error || '')); }
        catch (e2) { this.notify('✕ 連線失敗:' + e2 + '(確認部署存取權=任何人)'); }
        this.setState({ connBusy: false });
      },
      gasInit: async () => {
        if (!S.apiUrl.trim()) { this.notify('請先貼上 /exec 網址'); return; }
        if (!window.confirm('⚠ 初始化 = 清空重建:Sheet 全部分頁會重設為示範資料,現有資料將被刪除!\n只是要補新分頁請改用「升級結構(保留資料)」。\n\n確定要清空重建?')) return;
        db.saveCfg({ kind: 'gas', url: S.apiUrl.trim() }); this.setState({ connBusy: true });
        try { const j = await db.api('action=setup'); this.notify(j.ok ? '✓ ' + (j.msg || '初始化完成') : '✕ ' + (j.error || '初始化失敗')); }
        catch (e2) { this.notify('✕ 初始化失敗:' + e2); }
        this.setState({ connBusy: false });
      },
      // 安全升級:只補缺的分頁/欄位,現有資料保留(後端 action=migrate)
      gasMigrate: async () => {
        if (!S.apiUrl.trim()) { this.notify('請先貼上 /exec 網址'); return; }
        db.saveCfg({ kind: 'gas', url: S.apiUrl.trim() }); this.setState({ connBusy: true });
        try { const j = await db.api('action=migrate'); this.notify(j.ok ? '✓ 結構升級完成(資料保留)' + (j.msg ? ':' + j.msg : '') : '✕ ' + (j.error || '升級失敗')); }
        catch (e2) { this.notify('✕ 升級失敗:' + e2 + ' — 舊版後端沒有 migrate:重貼最新 apps-script.js → 部署新版本再試'); }
        this.setState({ connBusy: false });
      },
      gasConnect: async () => {
        if (!S.apiUrl.trim()) { this.notify('請先貼上 /exec 網址'); return; }
        db.saveCfg({ kind: 'gas', url: S.apiUrl.trim() }); db.setCloud();
        await doPull('✓ 已連線 Apps Script 並載入資料');
      },
      pullNow: () => { if (db.mode !== 'cloud') { this.notify('尚未連線 — 先完成方案 A 或 B 的步驟 ③'); return; } doPull(); },
      goLocalMode: () => { db.setLocal(); this.forceUpdate(); this.notify('已切回本地示範模式(不再同步 Sheet)'); },
      copyBackend: async () => {
        try { const code = await (await fetch('./apps-script.js')).text(); await navigator.clipboard.writeText(code); this.notify('✓ 已複製後端程式碼(' + code.length + ' 字),貼到 Apps Script 編輯器'); }
        catch (e2) { this.notify('✕ 無法自動複製 — 請開啟專案檔 apps-script.js 手動複製'); }
      },
      tableRows: Object.keys(db.t).map(nm => ({ name: nm, cnt: db.t[nm].length })),
      wipeTxTxt: S.confirmWipe === 'tx' ? '⚠ 再點一次確認:清空交易' : '清空交易資料(保留主資料)',
      wipeAllTxt: S.confirmWipe === 'all' ? '⚠ 再點一次確認:全部清空' : '全部清空(從零建立真實資料)',
      onWipeTx: () => this.armWipe('tx'),
      onWipeAll: () => this.armWipe('all'),
      seedCloudTxt: S.confirmWipe === 'seed' ? '⚠ 再點一次確認:覆寫為示範快照' : '還原示範資料到雲端(本地 + Sheet)',
      onSeedCloud: () => this.armSeed()
    };

    // ── 人員時間軸(今日):認領/接手 → 下一次交接或入庫 ──
    const toMinT = ts => {
      const s = String(ts);
      if (this.day(s) < this.TODAY) return -1;
      if (this.day(s) > this.TODAY) return 1441;
      const m = s.slice(10).match(/(\d{1,2}):(\d{2})/);
      if (!m) return -3; // 只有日期、沒有時間(舊資料)
      return (+m[1]) * 60 + (+m[2]);
    };
    const nowMin = (() => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); })();
    const finAt = {};
    this.t('stock_ledger').forEach(l => { if (l.source_type === 'production_in') { const m = toMinT(l.txn_date); if (m >= 0 && m <= 1440) finAt[l.source_id] = m; } });
    const byOrd = {};
    this.t('assignment').forEach(a => (byOrd[a.prod_id] = byOrd[a.prod_id] || []).push(a));
    const segs = [];
    Object.keys(byOrd).forEach((pid, oi) => {
      const rows = byOrd[pid];
      const ord = this.t('production_order').find(x => x.prod_id === pid);
      rows.forEach((a, i) => {
        let st = toMinT(a.ts);
        // 昨日以前的紀錄:只有「仍在製、且無後續交接」的單才延伸到今天,其餘略過
        if (this.day(a.ts) < this.TODAY) {
          const live = ord && this.isIssued(ord.status) && i === rows.length - 1;
          if (!live) return;
        }
        if (st === -3) return; // 舊紀錄缺時間 → 無法定位,略過
        let en = i + 1 < rows.length ? toMinT(rows[i + 1].ts) : (ord && ord.status === '完成' ? finAt[pid] : nowMin);
        if (en === -3) en = ord && ord.status === '完成' ? finAt[pid] : nowMin;
        if (en === undefined || en === -3) return; // 完成單但入庫時間不明 → 不畫
        if (st > 1440 || en < 0) return;
        st = Math.max(0, st); en = Math.min(1440, Math.max(en, st + 10));
        const steps = this.routingOf(ord ? ord.product_id : '');
        const sn = steps[Math.min(this.n(a.step_no), Math.max(steps.length - 1, 0))];
        segs.push({ sid: a.staff_id, st, en, oi, txt: this.nameOf(ord ? ord.product_id : pid) + (sn ? '·' + sn.step_name + '起' : '') });
      });
    });
    let t0 = 1440, t1 = 0;
    segs.forEach(x => { t0 = Math.min(t0, x.st); t1 = Math.max(t1, x.en); });
    if (t1 <= t0) { t0 = 240; t1 = 1200; }
    t0 = Math.max(0, Math.floor((t0 - 20) / 120) * 120); t1 = Math.min(1440, Math.max(t0 + 360, Math.ceil((t1 + 20) / 120) * 120));
    const tlPal = ['#0e7490', '#155e70', '#7c9a3d', '#946800', '#5b5f97', '#8a4f24', '#356e35', '#7a3b62'];
    const hhmmT = m => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
    const tlZoom = S.tlZoom || 1;
    const tlStep = tlZoom >= 4 ? 30 : tlZoom >= 2 ? 60 : 120;
    const tlTicks = []; for (let t = t0; t <= t1; t += tlStep) tlTicks.push({ lbl: tlStep < 60 ? hhmmT(t) : String(Math.floor(t / 60)).padStart(2, '0'), style: (t === t1 ? 'width:38px;flex:none' : 'flex:1') + ';white-space:nowrap;overflow:hidden' });
    const tlLanes = this.t('staff').filter(s => s.active !== 'FALSE').map(s => ({
      label: s.name,
      bars: segs.filter(x => x.sid === s.staff_id).map(x => ({
        label: x.txt,
        style: 'position:absolute;top:6px;height:22px;border-radius:5px;color:#fff;font-size:10.5px;display:flex;align-items:center;padding:0 6px;white-space:nowrap;overflow:hidden;left:' + ((x.st - t0) / (t1 - t0) * 100).toFixed(1) + '%;width:' + Math.max((x.en - x.st) / (t1 - t0) * 100, 1.2).toFixed(1) + '%;background:' + tlPal[x.oi % tlPal.length]
      }))
    }));
    const hhmm = m => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
    const tlRangeTxt = hhmm(t0) + ' – ' + hhmm(t1);
    const tlNote = segs.length ? '色塊長度 = 從認領/接手起,到下一次交接或入庫(進行中的算到現在);同色 = 同一張生產單,顏色跨行 = 交接。點「生產單列表」的單號可看單筆完整追溯。' : '今日尚無認領/接手紀錄 — 在工位任務板以員工身分操作後,這裡會出現時間分配';
    // ── 批次追溯 ──
    const traceOrd = this.t('production_order').find(x => x.prod_id === S.traceId);
    const traceEvents = [];
    if (traceOrd) {
      (byOrd[S.traceId] || []).forEach(a => {
        const steps = this.routingOf(traceOrd.product_id);
        const sn = steps[Math.min(this.n(a.step_no), Math.max(steps.length - 1, 0))];
        traceEvents.push({ ts: String(a.ts), who: this.staffName(a.staff_id), what: '認領/接手' + (sn ? ' · 自「' + sn.step_name + '」起' : '') });
      });
      this.t('stock_ledger').forEach(l => {
        if (l.source_id !== S.traceId) return;
        traceEvents.push({ ts: String(l.txn_date), who: '', what: (l.direction === 'out' ? '投料 −' : '入庫 +') + this.fmt(this.n(l.qty)) + ' ' + this.nameOf(l.item_id) });
      });
      this.t('waste').forEach(w => { if (this.day(w.date) === this.day(traceOrd.finish_date) && w.reason === '生產失敗' && w.target_id === traceOrd.product_id) traceEvents.push({ ts: String(w.date), who: '', what: '生產損耗 ' + w.qty + '(報廢)' }); });
      traceEvents.sort((a, b) => a.ts < b.ts ? -1 : 1);
    }
    // 工序時長分析:每道工序 實際耗時 vs 標準,判定 達標/超時/過短
    const tHasT = s => /\d{1,2}:\d{2}/.test(String(s).slice(10));
    const tMs = s => new Date(String(s).replace(' ', 'T')).getTime();
    let traceSteps = [], traceSum = '';
    if (traceOrd) {
      const steps = this.routingOf(traceOrd.product_id);
      const entries = {}, entryWho = {};
      (byOrd[S.traceId] || []).forEach(a => {
        if (!tHasT(a.ts)) return;
        const k = this.n(a.step_no);
        if (!(k in entries) || String(a.ts) < entries[k]) { entries[k] = String(a.ts); entryWho[k] = a.staff_id; }
      });
      const ledOut = this.t('stock_ledger').find(l => l.source_id === S.traceId && l.source_type === 'production_out' && tHasT(l.txn_date));
      const ledIn = this.t('stock_ledger').find(l => l.source_id === S.traceId && l.source_type === 'production_in' && tHasT(l.txn_date));
      if (ledOut) entries[0] = String(ledOut.txn_date);
      const curIdx = this.isIssued(traceOrd.status) ? this.stepIdx(traceOrd) : -1;
      traceSteps = steps.map((st, i) => {
        const std = this.n(st.duration_min);
        const start = entries[i];
        let end = entries[i + 1] || (i === steps.length - 1 && ledIn ? String(ledIn.txn_date) : null);
        let ongoing = false;
        if (!end && curIdx === i && traceOrd.status !== '完成') { end = this.NOW; ongoing = true; }
        let actualTxt = '—', tagTxt = '無紀錄', tagC = C.mut, mins = null;
        if (start && end) {
          mins = (tMs(end) - tMs(start)) / 60000;
          actualTxt = fsSpan(mins * 60) + (ongoing ? '…' : '');
          if (ongoing) { tagTxt = mins <= std ? '進行中' : '超時中'; tagC = mins <= std ? C.acc : C.red; }
          else if (!std) { tagTxt = '無標準'; tagC = C.mut; }
          else {
            const r = mins / std;
            if (r > 1.15) { tagTxt = '超時 +' + Math.round((r - 1) * 100) + '%'; tagC = C.red; }
            else if (r < 0.85) { tagTxt = '過短 −' + Math.round((1 - r) * 100) + '%'; tagC = C.amb; }
            else { tagTxt = '達標'; tagC = C.grn; }
          }
        }
        return { name: st.step_name, timeTxt: actualTxt + ' / ' + (std ? std + '分' : '—'), whoTxt: this.staffName(entryWho[i]) || '—', tag: tagTxt, tagStyle: this.tag(tagC) + ';white-space:nowrap' };
      });
      if (ledOut && ledIn) {
        const tot = (tMs(String(ledIn.txn_date)) - tMs(String(ledOut.txn_date))) / 60000;
        const stdTot = steps.reduce((a, x) => a + this.n(x.duration_min), 0);
        traceSum = '投料 → 入庫 共 ' + fsSpan(tot * 60) + (stdTot ? '(標準 ' + fsSpan(stdTot * 60) + ',' + (tot >= stdTot ? '+' : '−') + Math.round(Math.abs(tot / stdTot - 1) * 100) + '%)' : '');
      }
    }
    const traceStepsStyle = traceSteps.length ? '' : 'display:none';
    const traceSumStyle = traceSum ? 'padding:8px 16px;font-size:12px;font-weight:600;border-top:1px solid #eef0f3;background:#f4f6f8' : 'display:none';
    const traceRows = traceEvents.map(e => ({ t: e.ts.slice(5, 16).replace('T', ' '), who: e.who, what: e.what }));
    const traceStyle = traceOrd ? '' : 'display:none';
    const traceTitle = traceOrd ? S.traceId + ' ' + this.nameOf(traceOrd.product_id) : '';
    const traceClose = () => this.setState({ traceId: '' });
    const setStf = (id, k) => e => { db.replace('staff', this.t('staff').map(s => s.staff_id === id ? Object.assign({}, s, { [k]: e.target.value }) : s)); this.forceUpdate(); };
    const staffRows = this.t('staff').map(s => ({
      id: s.staff_id,
      nameVal: s.name, onName: setStf(s.staff_id, 'name'),
      roleVal: s.role, onRole: setStf(s.staff_id, 'role'),
      todayCnt: this.t('assignment').filter(a => a.staff_id === s.staff_id && this.day(a.ts) === this.TODAY).length,
      actTxt: s.active === 'FALSE' ? '停用' : '在職',
      actStyle: this.tag(s.active === 'FALSE' ? C.mut : C.grn) + ';cursor:pointer',
      onToggle: () => { db.replace('staff', this.t('staff').map(x => x.staff_id === s.staff_id ? Object.assign({}, x, { active: x.active === 'FALSE' ? 'TRUE' : 'FALSE' }) : x)); this.forceUpdate(); },
      onDel: () => {
        const used = this.t('assignment').filter(a => a.staff_id === s.staff_id).length;
        if (used) { this.notify('✕ 「' + s.name + '」有 ' + used + ' 筆經手紀錄,不可刪除 — 請改停用'); return; }
        db.replace('staff', this.t('staff').filter(x => x.staff_id !== s.staff_id)); this.forceUpdate();
      }
    }));
    const addStaff = () => { const id = db.nextId('staff', 'staff_id', 'EMP-', 2); db.replace('staff', this.t('staff').concat([{ staff_id: id, name: '新人員', role: '', active: 'TRUE' }])); this.forceUpdate(); this.notify('✓ 已新增 ' + id + ',直接在表格內修改'); };
    const assignRows = this.t('assignment').slice().reverse().slice(0, 14).map(a => {
      const o = this.t('production_order').find(x => x.prod_id === a.prod_id) || {};
      const steps = this.routingOf(o.product_id || '');
      const st = steps[Math.min(this.n(a.step_no), Math.max(steps.length - 1, 0))];
      return { ts: String(a.ts).slice(5, 16).replace('T', ' '), who: this.staffName(a.staff_id), ord: a.prod_id + ' ' + this.nameOf(o.product_id || ''), step: st ? st.step_name : '—' };
    });
    return {
      ...connVals,
      ...boardVals,
      ...lineVals,
      staffRows, addStaff, assignRows,
      tlLanes, tlTicks, tlRangeTxt, tlNote,
      tlRef: el => { this._tEl = el; },
      tlPan: this.chartPan('_tEl'),
      tlInnerStyle: 'width:' + (tlZoom * 100) + '%;min-width:max(100%,' + (96 + tlTicks.length * 50) + 'px)',
      tlZoomTxt: '×' + tlZoom,
      tlZoomIn: () => this.setState({ tlZoom: Math.min(8, (S.tlZoom || 1) * 2) }),
      tlZoomOut: () => this.setState({ tlZoom: Math.max(1, (S.tlZoom || 1) / 2) }),
      traceStyle, traceTitle, traceRows, traceClose, traceSteps, traceStepsStyle, traceSum, traceSumStyle,
      setupSteps, setupProg,
      orderRows, wipRows,
      tiles, cartRows, cartTotal, doCheckout: () => this.checkout(), comingRows,
      invIngStyle: isIng ? 'background:#0e7490;color:#fff;font-weight:500' : '', invProdStyle: (!isIng ? 'background:#0e7490;color:#fff;font-weight:500' : '') + (atCentral ? ';display:none' : ''),
      goInvIng: () => this.setState({ invTab: 'ingredient', selItem: 'ING-001' }),
      goInvProd: () => this.setState({ invTab: 'product', selItem: 'PRD-01' }),
      invRows, invCatTabs,
      invCatBarStyle: isIng ? 'display:flex;gap:6px;padding:9px 14px;border-bottom:1px solid #eef0f3;flex-wrap:wrap' : 'display:none',
      catBarOver: e => e.preventDefault(),
      catBarDrop: e => { e.preventDefault(); this.catCommit(); },
      // ── 補貨(庫存明細直接補,不用等建議清單)──
      ...(() => {
        const off = { rsPanStyle: 'display:none', rsPendStyle: 'display:none', rsPendTxt: '', rsTransitLabel: '在途', rsTransitTxt: '—', rsSafeTxt: '', rsQtyVal: '', onRsQty: () => { }, doRestock: () => { }, rsBtnTxt: '', rsNote: '', rsUnit: '' };
        if (!isIng || !selRow || !db) return off;
        const iid = S.selItem;
        // ⚠ 一律用 selRow(庫存頁選中項);selG 是「原料目錄」頁的選中項,在這裡是錯的資料來源
        const conv = this.n(selRow.conversion_rate) || 1;
        const selfMade = selRow.purchase_unit === '自製';
        const safe = this.safetyAt(this.THIS_LOC, iid);
        const pend = atCentral ? pendingAll(iid) : 0;
        const transit = atCentral ? onOrder(iid) : transitMine(iid);
        const sug = Math.max(0, (atCentral ? pend : 0) + safe - curStock - transit);
        // 補貨量單位與叫貨/採購對齊:外購原料以「包/箱/瓶」輸入;讀不到包裝(自製或規格≤1)fallback 成基本單位 g/ml
        const pk = this.isPackaged(selRow);
        const sugDef = pk ? Math.max(1, Math.ceil(sug / conv)) : (sug > 0 ? Math.ceil(sug) : 1000);
        const eff = S.rsQtyItem === iid && S.rsQty !== '' && S.rsQty !== undefined ? this.n(S.rsQty) : sugDef; // pk=包數;否則=g
        return {
          rsPanStyle: '',
          rsPendStyle: atCentral ? '' : 'display:none', rsPendTxt: kg(pend),
          rsTransitLabel: atCentral ? '採購在途' : '叫貨在途', rsTransitTxt: transit > 0 ? kg(transit) : '—',
          rsSafeTxt: kg(safe),
          rsUnit: pk ? (selRow.purchase_unit || '包') + ' · 每' + (selRow.purchase_unit || '包') + ' ' + kg(conv) + ' · 共 ' + kg(Math.max(1, Math.ceil(this.n(eff))) * conv) : (selRow.base_unit || 'g'),
          rsQtyVal: String(eff),
          onRsQty: e => this.setState({ rsQty: e.target.value, rsQtyItem: iid }),
          rsBtnTxt: selfMade ? (!atCentral && this.stocksAt(this.CENTRAL, iid) ? '補貨 → 向中央叫貨' : '自製 — 排入生產') : (atCentral ? '補貨 → 加入進貨單' : '補貨 → 加入叫貨單'),
          doRestock: () => {
            const q = Math.max(1, pk ? Math.ceil(this.n(eff)) * conv : this.n(eff)); // 統一換回 g 記帳
            if (selfMade) {
              if (!atCentral && this.stocksAt(this.CENTRAL, iid)) { this.addDraft(iid, q, true); this.setState({ screen: 'purchase', puView: 'store', rsQty: '' }); return; }
              this.schedulePrep(iid, q); this.setState({ rsQty: '' }); return;
            }
            if (atCentral) {
              if (S.poLines.some(l => l.iid === iid)) { this.notify('「' + selRow.name + '」已在進貨單草稿'); }
              else {
                const units = pk ? Math.max(1, Math.ceil(this.n(eff))) : Math.max(1, Math.ceil(q / conv));
                this.setPoDraft({ poLines: S.poLines.concat([{ iid, units: String(units), price: this.poPrice(selRow), tax: String(this.poTax(selRow)) }]) });
                this.notify('✓ 已加入進貨單:' + selRow.name + ' ' + units + ' ' + (selRow.purchase_unit || '單位'));
              }
              this.setState({ screen: 'purchase', puView: 'buy', rsQty: '' });
            } else {
              this.addDraft(iid, q, true);
              this.setState({ screen: 'purchase', puView: 'store', rsQty: '' });
            }
          },
          rsNote: (pk ? '補貨量以「' + (selRow.purchase_unit || '包') + '」為單位(與叫貨/採購一致);' : '') + (atCentral
            ? '建議 = 待出叫貨 + 安全庫存 − 結存 − 採購在途;加入後到「③ 中央採購」送單'
            : '建議 = 安全庫存 − 結存 − 叫貨在途;加入後到「① 門市叫貨」送出向中央倉叫貨')
        };
      })(),
      selName: (selRow || {}).name || '', selStockTxt: isIng ? kg(curStock) : this.fmt(curStock) + ' 個',
      selPkgTxt: (() => { if (!isIng || !selRow) return ''; const p = pkgOf(selG, curStock); return p === '—' ? '' : ' = ' + p; })(),
      ledgerRows, countVal: S.countQty, onCount: e => this.setState({ countQty: e.target.value }), doCount: () => this.doCount(),
      countUnit: isIng ? (selG.base_unit || 'g') : '個',
      sugRows, poGroups, poSubmitTxt, poEmptyStyle, poTotal, supOptions,
      sugEmpty: sugRows.length ? 'display:none' : 'padding:14px 16px;font-size:12px;color:#66707f',
      addAllSug: () => {
        const adds = [];
        for (const g of this.t('ingredient')) {
          if (!buyable(g) || S.poLines.some(l => l.iid === g.ingredient_id) || adds.some(a => a.iid === g.ingredient_id)) continue;
          const s = this.stock('ingredient', g.ingredient_id, this.CENTRAL);
          const pend = pendingAll(g.ingredient_id);
          if (!this.stocksAt(this.CENTRAL, g.ingredient_id) && pend <= 0) continue;
          const short = Math.max(0, pend + this.safetyAt(this.CENTRAL, g.ingredient_id) - s - onOrder(g.ingredient_id));
          if (short <= 0) continue;
          const conv = this.n(g.conversion_rate) || 1;
          const units = Math.max(1, Math.ceil(short / conv));
          adds.push({ iid: g.ingredient_id, units: String(units), price: this.poPrice(g), tax: String(this.poTax(g)) });
        }
        if (!adds.length) { this.notify('沒有可加入的建議'); return; }
        this.setPoDraft({ poLines: S.poLines.concat(adds) });
        this.notify('✓ 已把 ' + adds.length + ' 項建議全部帶入進貨單');
      },
      addAllStyle: sugAllBtn ? 'margin-left:auto' : 'display:none',
      poEtaVal: S.poEta || this.addDays(this.TODAY, 2), onPoEta: e => this.setPoDraft({ poEta: e.target.value }),
      poSupWay: (() => { const s = this.t('supplier').find(x => x.supplier_id === S.poSupplier); const w = this.supWay ? this.supWay(s) : ''; return w ? '聯絡:' + w : ''; })(),
      poNameVal: S.poName || '', onPoName: e => this.setPoDraft({ poName: e.target.value }),
      poOpenRows: (() => {
        const poAll = this.t('purchase_line').filter(r => (r.location_id || 'LOC-A') === this.CENTRAL && r.status !== '已過帳');
        const openIds = [];
        for (const r of poAll) if (this.n(r.received_qty) < this.n(r.qty) && openIds.indexOf(r.po_id) < 0) openIds.push(r.po_id);
        this._poOpenN = openIds.length;
        const POST = { '已下單': C.amb, '廠商已確認': C.acc, '配送中': C.grn, '暫緩': C.red, '部分到貨': C.acc, '補送中': C.amb, '退貨': C.red };
        // 退貨處理區(待收貨卡與紀錄卡共用):列出已收>0 的行,填退回量+選補送/減單
        this.mkRet = (pid, ls) => {
          const rows = ls.filter(r => this.n(r.received_qty) > 0).map(r => {
            const g = this.ing(r.ingredient_id) || {};
            const key = pid + '|' + r.ingredient_id;
            return {
              name: g.name || r.ingredient_id,
              gotTxt: this.fmt(this.n(r.received_qty)) + ' ' + (r.purchase_unit || ''),
              val: (S.retVals || {})[key] || '',
              onVal: e => { const m = Object.assign({}, S.retVals || {}); m[key] = e.target.value; this.setState({ retVals: m }); }
            };
          });
          const mode = (S.retMode || {})[pid] || 'resend';
          const setMode = md => () => { const m = Object.assign({}, S.retMode || {}); m[pid] = md; this.setState({ retMode: m }); };
          const on = S.retOpen === pid;
          return {
            retLinkStyle: rows.length ? 'color:#c11f28;cursor:pointer;font-size:11.5px;margin-left:auto;white-space:nowrap' : 'display:none',
            retLinkTxt: on ? '收起退貨 ▴' : '退貨處理 ▾',
            onRetToggle: () => this.setState({ retOpen: on ? '' : pid }),
            retSecStyle: on && rows.length ? 'border-top:1px dashed #e3e6eb;margin-top:10px;padding-top:10px;display:flex;flex-direction:column;gap:8px' : 'display:none',
            retRows: rows,
            retResendStyle: (mode === 'resend' ? 'background:#0e7490;border-color:#0e7490;color:#fff' : 'color:#66707f;border-color:#e3e6eb') + ';cursor:pointer',
            retCutStyle: (mode === 'cut' ? 'background:#0e7490;border-color:#0e7490;color:#fff' : 'color:#66707f;border-color:#e3e6eb') + ';cursor:pointer',
            onRetResend: setMode('resend'), onRetCut: setMode('cut'),
            doReturn: () => this.doReturn(pid)
          };
        };
        return openIds.map(pid => {
          const ls = poAll.filter(r => r.po_id === pid);
          const started = ls.some(r => this.n(r.received_qty) > 0);
          const eta = ls[0].arrival_date || '';
          const supRec = this.t('supplier').find(s2 => s2.supplier_id === ls[0].supplier_id);
          const curSt = ls.some(r => r.status === '補送中') ? '補送中' : (started ? '部分到貨' : (ls[0].status || '已下單'));
          return Object.assign(this.mkRet(pid, ls), {
            id: pid,
            nmTxt: ls[0].po_name || '', nmStyle: ls[0].po_name ? 'font-weight:600;color:#1b2330' : 'display:none',
            sup: (supRec || {}).name || ls[0].supplier_id,
            supWayTxt: this.supWay ? this.supWay(supRec) : '',
            od: String(ls[0].order_date).slice(5, 10),
            etaVal: eta ? String(eta).slice(0, 10) : '', onEta: e => this.setPOEta(pid, e.target.value),
            stTag: curSt, stStyle: this.tag(POST[curSt] || C.amb),
            stSelVal: started ? '' : curSt,
            stSelStyle: started ? 'display:none' : 'font-size:11px;padding:2px 6px;width:112px;display:inline-flex;gap:5px;align-items:center;cursor:pointer;background:#fff;user-select:none;box-sizing:border-box',
            onStSel: e => { if (e.target.value) this.setPOStatus(pid, e.target.value); },
            stBtn: this.ddBtn(['已下單', '廠商已確認', '配送中', '補送中', '暫緩', '退貨'].map(s3 => ({ id: s3, name: s3 })), curSt, v => this.setPOStatus(pid, v)),
            lateStyle: (eta && eta < this.TODAY ? this.tag(C.red) : 'display:none') + ';margin-left:2px',
            lines: ls.map(r => {
              const g = this.ing(r.ingredient_id) || {};
              const rem = Math.max(0, this.n(r.qty) - this.n(r.received_qty));
              const key = pid + '|' + r.ingredient_id;
              const val = (S.rcvVals || {})[key];
              const conv = this.n(g.conversion_rate) || 1;
              return {
                name: g.name || r.ingredient_id, unit: r.purchase_unit || '',
                ordVal: r.qty, onOrd: e => this.setPOQty(pid, r.ingredient_id, e.target.value),
                ordSub: (r.purchase_unit || '') + '(' + kg(this.n(r.qty) * conv) + ')',
                gotTxt: this.n(r.received_qty) ? this.fmt(this.n(r.received_qty)) : '—',
                inpStyle: rem > 0 ? 'width:60px;text-align:right' : 'display:none',
                doneStyle: rem > 0 ? 'display:none' : this.tag(C.grn),
                rcvVal: val === undefined ? String(rem) : val,
                onRcv: e => { const m = Object.assign({}, S.rcvVals || {}); m[key] = e.target.value; this.setState({ rcvVals: m }); }
              };
            }),
            doReceive: () => this.receivePO(pid)
          });
        });
      })(),
      poOpenEmpty: this._poOpenN ? 'display:none' : 'padding:14px 16px;font-size:12px;color:#66707f',
      puBuyBadge: this._poOpenN ? '(' + this._poOpenN + ')' : '',
      poHistRows: (() => {
        const all = this.t('purchase_line').filter(r => (r.location_id || 'LOC-A') === this.CENTRAL);
        const ids = []; for (const r of all) if (ids.indexOf(r.po_id) < 0) ids.push(r.po_id);
        const closed = ids.filter(pid => all.filter(r => r.po_id === pid).every(r => r.status === '已過帳' || this.n(r.received_qty) >= this.n(r.qty)));
        this._poHistN = closed.length;
        return closed.slice().reverse().slice(0, 8).map(pid => {
          const ls = all.filter(r => r.po_id === pid);
          const led = this.t('stock_ledger').filter(l => l.source_type === 'purchase' && l.source_id === pid && (l.location_id || 'LOC-A') === this.CENTRAL);
          const open = S.poHistOpen === pid;
          const supRec2 = this.t('supplier').find(s2 => s2.supplier_id === ls[0].supplier_id);
          return Object.assign(this.mkRet ? this.mkRet(pid, ls) : {}, {
            id: pid,
            nmTxt: ls[0].po_name || '', nmStyle: ls[0].po_name ? 'font-weight:600;color:#1b2330' : 'display:none',
            sup: (supRec2 || {}).name || ls[0].supplier_id,
            supWayTxt: this.supWay ? this.supWay(supRec2) : '',
            od: String(ls[0].order_date).slice(5, 10),
            done: led.length ? String(led[led.length - 1].txn_date).slice(5, 10) : String(ls[0].arrival_date || '—').slice(5, 10),
            sumTxt: ls.length + ' 項品項',
            amt: this.fmt(ls.reduce((a, r) => a + this.n(r.subtotal), 0)),
            chev: open ? '▼' : '▶',
            detStyle: open ? '' : 'display:none',
            onToggle: () => this.setState({ poHistOpen: open ? '' : pid }),
            lines: ls.map(r => {
              const g = this.ing(r.ingredient_id) || {};
              const conv = this.n(g.conversion_rate) || 1;
              const batches = led.filter(l => l.item_id === r.ingredient_id).map(l => String(l.txn_date).slice(5, 10) + ' +' + kg(this.n(l.qty)));
              return {
                name: g.name || r.ingredient_id,
                ordTxt: this.fmt(this.n(r.qty)) + ' ' + (r.purchase_unit || '') + '(' + kg(this.n(r.qty) * conv) + ')',
                rcvTxt: this.fmt(this.n(r.received_qty)) + ' ' + (r.purchase_unit || ''),
                priceTxt: this.fmt(this.n(r.unit_price)),
                subTxt: this.fmt(this.n(r.subtotal)),
                batchTxt: batches.join('、') || '—'
              };
            })
          });
        });
      })(),
      poHistEmpty: this._poHistN ? 'display:none' : 'padding:12px 16px;font-size:12px;color:#66707f',
      poStOptions: ['已下單', '廠商已確認', '配送中', '補送中', '暫緩', '退貨'].map(s2 => ({ id: s2, name: s2 })),
      poSupplier: S.poSupplier, onSupplier: e => this.setState({ poSupplier: e.target.value }),
      poSupBtn: this.ddBtn(supOptions, S.poSupplier, v => this.setState({ poSupplier: v })),
      doPostPO: () => this.postPO(),
      centralName: this.locName(this.CENTRAL),
      ...this.ddVals(),
      // 清單搜尋框+可排序欄頭
      ingQ: this.lq('lsIng'), ingHead: this.lhead('lsIng', [['id', '編號'], ['name', '名稱'], ['cat', '分類'], ['', '換算'], ['', '備料地點'], ['quote', '含稅報價', 'text-align:right'], ['cost', '最新單價', 'text-align:right'], ['sup', '預設供應商']]),
      invQ: this.lq('lsInv'), invHead: this.lhead('lsInv', [['id', '編號'], ['name', '名稱'], ['cat', '分類'], ['stock', '即時庫存', 'text-align:right'], ['', '包裝換算'], ['safe', '安全庫存', 'text-align:right'], ['st', '狀態']]),
      smQ: this.lq('lsSm', '搜尋'), smHead: this.lhead('lsSm', [['name', '原料'], ['cat', '分類'], ['stock', '現有庫存', 'text-align:right'], ['safe', '安全庫存', 'text-align:right'], ['', '']]),
      scQ: this.lq('lsSc', '搜尋'), scHead: this.lhead('lsSc', [['name', '原料'], ['cat', '分類'], ['', '換算'], ['', '']]),
      supQ: this.lq('lsSup'),
      prodQ: this.lq('lsProd', '搜尋'),
      ordQ: this.lq('lsOrd', '搜尋:單號/產品/狀態'), ordHead: this.lhead('lsOrd', [['id', '單號(點擊追溯)'], ['prod', '產品'], ['qty', '計畫', 'text-align:right'], ['date', '日期'], ['st', '狀態'], ['', '負責人']]),
      locTabs, locShort: this.locName(this.THIS_LOC),
      puStoreOn: puV === 'store', puCentralOn: puV === 'central', puBuyOn: puV === 'buy',
      puStoreStyle: (puV === 'store' ? 'background:#0e7490;color:#fff;font-weight:500' : '') + (atCentral ? ';display:none' : ''),
      puCentralStyle: (puV === 'central' ? 'background:#0e7490;color:#fff;font-weight:500' : '') + (atCentral ? '' : ';display:none'),
      puBuyStyle: (puV === 'buy' ? 'background:#0e7490;color:#fff;font-weight:500' : '') + (atCentral ? '' : ';display:none'),
      goPuStore: () => this.setState({ puView: 'store' }),
      goPuCentral: () => this.setState({ puView: 'central' }),
      goPuBuy: () => this.setState({ puView: 'buy' }),
      puCenBadge: pendTOs.length ? '(' + pendTOs.length + ')' : '',
      puHintTxt: atCentral ? '中央倉管理:② 彙總各店叫貨出貨;③ 向供應商採購入中央倉' : '門市不直接向供應商採購:缺料 → 向中央叫貨 → 中央出貨 → 回此頁確認收貨;出貨/採購由中央倉視角管理',
      tsSugRows, tsDraftRows, tsIngOptions, tsMyRows,
      tsSugEmpty: tsSugRows.length ? 'display:none' : 'padding:14px 16px;font-size:12px;color:#66707f',
      tsMyEmpty: tsMyRows.length ? 'display:none' : 'font-size:12px;color:#66707f;padding:4px 2px',
      tsAddIng: effTsIng, onTsAddIng: e => this.setState({ tsAddIng: e.target.value }),
      tsIngBtn: this.ddBtn(tsIngOptions, effTsIng, v => this.setState({ tsAddIng: v, tsAddQty: this.isPackaged(this.ing(v)) ? '1' : '1000' })),
      tsAddQty: S.tsAddQty, onTsAddQty: e => this.setState({ tsAddQty: e.target.value }),
      // 手動加入:外購原料輸入的是「包數」(×規格轉 g);自製半成品輸入 g
      tsAddUnit: (() => { const g0 = this.ing(effTsIng); return this.isPackaged(g0) ? (g0.purchase_unit || '包') + '(每' + (g0.purchase_unit || '包') + ' ' + kg(this.n(g0.conversion_rate)) + ')' : ((g0 || {}).base_unit || 'g'); })(),
      tsAddLine: () => {
        if (!effTsIng) { this.notify('沒有可叫貨的原料(自製原料不可叫貨)'); return; }
        const g0 = this.ing(effTsIng);
        const n0 = Math.max(1, this.n(S.tsAddQty) || 1);
        this.addDraft(effTsIng, this.isPackaged(g0) ? n0 * this.n(g0.conversion_rate) : n0, true);
      },
      tsSubmit: () => this.submitTO(),
      tsNeedVal: S.tsNeed || this.addDays(this.TODAY, 1), onTsNeed: e => this.setState({ tsNeed: e.target.value }),
      tsUrgentVal: !!S.tsUrgent, onTsUrgent: e => this.setState({ tsUrgent: e.target.checked }),
      // ── 本店備料(門市視角)──
      ingStoreOn: !atCentral, ingCentralOn: atCentral,
      smRows: this.lsort('lsSm', this.lfilter('lsSm', this.t('location_stock').filter(r => r.location_id === this.THIS_LOC), ['ingredient_id', r => (this.ing(r.ingredient_id) || {}).name, r => this.gcat(this.ing(r.ingredient_id))]), { name: r => (this.ing(r.ingredient_id) || {}).name || '', cat: r => this.gcat(this.ing(r.ingredient_id)), stock: r => this.stock('ingredient', r.ingredient_id), safe: r => this.n(r.safety_stock) }).map(r => {
        const g = this.ing(r.ingredient_id) || {};
        return {
          name: g.name || r.ingredient_id, cat: this.gcat(g) || '', stockTxt: kg(this.stock('ingredient', r.ingredient_id)),
          safeVal: r.safety_stock,
          onSafe: e => this.setLocStock(this.THIS_LOC, r.ingredient_id, true, e.target.value),
          onDrop: () => { this.setLocStock(this.THIS_LOC, r.ingredient_id, false, 0); this.notify('已移除本店備料:' + (g.name || r.ingredient_id)); }
        };
      }),
      smEmpty: this.t('location_stock').some(r => r.location_id === this.THIS_LOC) ? 'display:none' : 'padding:14px 16px;font-size:12px;color:#66707f',
      scRows: this.lsort('lsSc', this.lfilter('lsSc', this.t('ingredient').filter(g => !this.stocksAt(this.THIS_LOC, g.ingredient_id)), ['ingredient_id', 'name', g => this.gcat(g)]), { name: g => g.name || '', cat: g => this.gcat(g) }).map(g => ({
        name: g.name, cat: this.gcat(g), convTxt: '1 ' + (g.purchase_unit || '單位') + ' = ' + kg(this.n(g.conversion_rate) || 1),
        onAdd: () => { this.setLocStock(this.THIS_LOC, g.ingredient_id, true, this.n(g.safety_stock) || 0); this.notify('✓ 已加入本店:' + g.name + '(安全庫存帶預設值,可在左側改)'); }
      })),
      scEmpty: this.t('ingredient').some(g => !this.stocksAt(this.THIS_LOC, g.ingredient_id)) ? 'display:none' : 'padding:14px 16px;font-size:12px;color:#66707f',
      reqName: S.reqName || '', onReqName: e => this.setState({ reqName: e.target.value }),
      reqSpec: S.reqSpec || '', onReqSpec: e => this.setState({ reqSpec: e.target.value }),
      reqQty: S.reqQty || '', onReqQty: e => this.setState({ reqQty: e.target.value }),
      reqUrgentVal: !!S.reqUrgent, onReqUrgent: e => this.setState({ reqUrgent: e.target.checked }),
      doReq: () => this.submitReq(),
      myReqRows: this.t('ingredient_request').filter(r => r.location_id === this.THIS_LOC).slice().reverse().slice(0, 6).map(r => {
        const st = { '待處理': ['待中央處理', C.amb], '已加入': ['已加入 ' + r.ingredient_id, C.grn], '併入': ['已併入 ' + ((this.ing(r.ingredient_id) || {}).name || r.ingredient_id), C.grn], '婉拒': ['婉拒', C.mut] }[r.status] || [r.status, C.mut];
        return { name: r.name + (r.urgent === 'TRUE' ? ' ⚡' : ''), tag: st[0], tagStyle: this.tag(st[1]), date: String(r.request_date).slice(5, 10) };
      }),
      myReqEmpty: this.t('ingredient_request').some(r => r.location_id === this.THIS_LOC) ? 'display:none' : 'padding:12px 16px;font-size:12px;color:#66707f',
      // ── 申請歸戶(中央視角)──
      reqRows: this.t('ingredient_request').filter(r => r.status === '待處理').slice().sort((a, b) => ((b.urgent === 'TRUE') - (a.urgent === 'TRUE')) || String(a.request_date).localeCompare(String(b.request_date))).map(r => ({
        store: this.locName(r.location_id), storeStyle: this.tag(C.amb),
        name: r.name, spec: r.spec || '—',
        qtyTxt: r.weekly_qty ? kg(this.n(r.weekly_qty)) + ' /週' : '—',
        urgStyle: r.urgent === 'TRUE' ? this.tag(C.red) : 'display:none',
        mergeVal: (S.mergePick || {})[r.req_id] || '',
        onMerge: e => { const m = Object.assign({}, S.mergePick || {}); m[r.req_id] = e.target.value; this.setState({ mergePick: m }); },
        mergeBtn: this.ddBtn(this.t('ingredient').map(g => ({ id: g.ingredient_id, name: g.name, meta: this.gcat(g) || '' })), (S.mergePick || {})[r.req_id] || '', v => { const m = Object.assign({}, S.mergePick || {}); m[r.req_id] = v; this.setState({ mergePick: m }); }, '併入現有…'),
        doAccept: () => this.acceptReq(r), doMerge: () => this.mergeReq(r, (S.mergePick || {})[r.req_id]), doReject: () => this.rejectReq(r)
      })),
      mergeOptions: this.t('ingredient').map(g => ({ id: g.ingredient_id, name: g.name })),
      reqCountTxt: pendReqCount2 + ' 筆', reqCountStyle: this.tag(pendReqCount2 ? C.red : C.mut),
      reqEmpty: pendReqCount2 ? 'display:none' : 'padding:12px 16px;font-size:12px;color:#66707f',
      loadCommon: () => this.loadCommon(),
      importSemis: () => this.importSemis(),
      revertImport: () => this.revertImport(),
      // 新增自製半成品(麵團/餡料/菌種…):中央或門市都能建(門市研發自己的),自動配置到當前地點
      addSelfIng: () => {
        const id = db.nextId('ingredient', 'ingredient_id', 'ING-', 3);
        db.replace('ingredient', this.t('ingredient').concat([{ ingredient_id: id, name: '新自製半成品', category: this.catIdOf('其他'), base_unit: 'g', purchase_unit: '自製', conversion_rate: '1', safety_stock: '0', latest_unit_cost: '0', quote_price: '0', tax_rate: '1.0', shelf_life_days: '3', default_supplier_id: '', batch_yield: '1000' }]));
        this.setLocStock(this.THIS_LOC, id, true, 0);
        this.setState({ selIng: id, draft: null, screen: 'ingredients' });
        this.notify('✓ 已建立 ' + id + ' 自製半成品(已配置到' + this.locName(this.THIS_LOC) + ')— 到「產品與配方」寫配方與批次產出;分類請改成 麵團/餡料 等');
      },
      // ── 門市地點(中央管理)──
      locMgrRows: this.t('location').map(l => ({
        id: l.location_id, name: l.name,
        onName: e => { const v = e.target.value; this.db.replace('location', this.t('location').map(x => x.location_id === l.location_id ? Object.assign({}, x, { name: v }) : x)); this.forceUpdate(); },
        typeTxt: l.type === 'central' ? '中央倉' : '門市', typeStyle: this.tag(l.type === 'central' ? C.acc : C.amb),
        cfgTxt: String(this.t('location_stock').filter(r => r.location_id === l.location_id).length),
        openTxt: String(this.t('transfer_order').filter(t => t.to_loc === l.location_id && (t.status === '叫貨' || t.status === '已出貨')).length)
      })),
      newStoreName: S.newStoreName || '', onNewStoreName: e => this.setState({ newStoreName: e.target.value }),
      doAddStore: () => {
        const nm = (S.newStoreName || '').trim();
        if (!nm) { this.notify('請輸入門市名稱'); return; }
        let id = '';
        for (let i = 0; i < 26; i++) { const c = 'LOC-' + String.fromCharCode(65 + i); if (!this.t('location').some(l => l.location_id === c)) { id = c; break; } }
        if (!id) { this.notify('地點數已達上限'); return; }
        this.db.append('location', { location_id: id, name: nm, type: 'store' });
        this.setState({ newStoreName: '' });
        this.notify('✓ 已新增門市 ' + nm + '(' + id + ')— 用頂部切換器進入該店配置備料');
      },
      tcPending, cInvRows, tcShipped,
      tcPendEmpty: tcPending.length ? 'display:none' : 'font-size:12px;color:#66707f;padding:4px 2px',
      tcShipEmpty: tcShipped.length ? 'display:none' : 'padding:12px 16px;font-size:12px;color:#66707f',
      addIng: () => {
        const id = db.nextId('ingredient', 'ingredient_id', 'ING-', 3);
        db.replace('ingredient', this.t('ingredient').concat([{ ingredient_id: id, name: '新原料', category: this.catIdOf('其他'), base_unit: 'g', purchase_unit: '包', conversion_rate: '1000', safety_stock: '0', latest_unit_cost: '0', shelf_life_days: '90', default_supplier_id: '' }]));
        this.setState({ selIng: id, draft: null });
        this.notify('✓ 已新增 ' + id + ',請在右側編輯名稱與參數後儲存');
      },
      ...catVals,
      locCfgRows: !S.selIng ? [] : this.t('location').map(l => {
        const r = this.locRow(l.location_id, S.selIng);
        const on = !!r;
        return {
          name: l.name,
          tagTxt: on ? '✓ 備料' : '不備',
          tagStyle: (on ? this.tag(C.grn) : 'color:#66707f;border-color:#e3e6eb') + ';cursor:pointer;min-width:48px;text-align:center',
          onToggle: () => this.setLocStock(l.location_id, S.selIng, !on, r ? r.safety_stock : selG.safety_stock),
          safeVal: r ? r.safety_stock : '',
          inpStyle: 'width:78px;text-align:right' + (on ? '' : ';visibility:hidden'),
          unitStyle: 'color:#66707f;font-size:11px' + (on ? '' : ';visibility:hidden'),
          onSafe: e => this.setLocStock(l.location_id, S.selIng, true, e.target.value)
        };
      }),
      ingRows, ingCatTabs, dName: d.name, onDName: setD('name'),
      dCat: this.catName(d.category), onDCat: setD('category'), dBase: d.base_unit, onDBase: setD('base_unit'),
      dCatBtn: this.ddBtn(this.t('category').map(c => ({ id: c.category_id, name: c.name })), this.catIdOf(this.catName(d.category)), v => this.setState({ draft: Object.assign({}, d, { category: v }) })),
      dSafety: d.safety_stock, onDSafety: setD('safety_stock'),
      dConv: d.conversion_rate, onDConv: setD('conversion_rate'), dUnit: d.purchase_unit, onDUnit: setD('purchase_unit'),
      dShelf: d.shelf_life_days, onDShelf: setD('shelf_life_days'),
      saveIng: () => {
        db.replace('ingredient', this.t('ingredient').map(g => g.ingredient_id === S.selIng ? Object.assign({}, g, d) : g));
        // 主檔報價改了 → 進貨單草稿裡同品項的行同步新價(稅前+稅率,含稅自動推導;會覆蓋該行手改價)
        const ng = this.ing(S.selIng);
        if (ng && (S.poLines || []).some(l => l.iid === S.selIng)) {
          this.setPoDraft({ poLines: S.poLines.map(l => l.iid === S.selIng ? Object.assign({}, l, { price: this.poPrice(ng), tax: String(this.poTax(ng)) }) : l) });
        }
        this.setState({ draft: null }); this.notify('✓ 已儲存原料主檔'); },
      deleteIng: () => {
        const used = this.t('bom').filter(b => b.ingredient_id === S.selIng);
        if (used.length) { this.notify('✕ 無法刪除:「' + (selG.name || S.selIng) + '」仍用於 ' + used.length + ' 個配方,請先從配方移除'); return; }
        if (this.stock('ingredient', S.selIng) > 0) { this.notify('✕ 無法刪除:此原料仍有庫存,請先盤點歸零'); return; }
        db.replace('ingredient', this.t('ingredient').filter(g => g.ingredient_id !== S.selIng));
        const next = this.t('ingredient')[0];
        this.setState({ selIng: next ? next.ingredient_id : '', draft: null });
        this.notify('✓ 已刪除原料 ' + S.selIng);
      },
      ingUsage: ingUsage ? '用於配方:' + ingUsage : '尚未用於任何配方',
      selIngCost: this.n(selG.latest_unit_cost).toFixed(3) + ' /' + (selG.base_unit || 'g'),
      addProd: () => {
        if (!atCentral) { this.notify('產品與配方由中央維護,門市無法新增(請切換到中央倉)'); return; }
        const id = db.nextId('product', 'product_id', 'PRD-', 2);
        const loc = atCentral ? (S.prodLoc && S.prodLoc !== 'all' ? S.prodLoc : this.firstStoreLoc()) : this.THIS_LOC;
        db.replace('product', this.t('product').concat([{ product_id: id, name: '新產品', type: 'bread', sale_price: '50', lead_days: '0', default_yield: '10', is_active: 'TRUE', location_id: loc }]));
        this.setState(Object.assign({ selProd: id }, atCentral ? { prodLoc: loc } : {}));
        this.notify('✓ 已新增 ' + id + '(' + this.locName(loc) + '),請編輯名稱、售價、配方與工序' + (atCentral ? ';可在標題列改門市' : ''));
      },
      addRout: () => {
        const steps = this.routingOf(S.selProd);
        const no = steps.length ? Math.max(...steps.map(s => this.n(s.step_no))) + 1 : 1;
        db.replace('routing', this.t('routing').concat([{ routing_id: db.nextId('routing', 'routing_id', 'R-', 2), product_id: S.selProd, step_no: String(no), step_name: '新工序', duration_min: '30', equipment_id: '', cross_day: 'FALSE' }]));
        this.forceUpdate();
      },
      eqOptions,
      prodListRows, prodLocTabs, prodLocBarStyle,
      addProdShow: atCentral ? '' : 'display:none',
      prodEditPE: atCentral ? '' : 'pointer-events:none',
      prodRoStyle: atCentral ? 'display:none' : 'padding:9px 14px;background:#fff7ed;border:1px solid #fed7aa;border-radius:9px;font-size:12px;color:#9a3412;font-weight:500',
      pLocStyle: (isIngSel || !atCentral) ? 'display:none' : 'margin-left:8px;display:inline-flex;align-items:center;gap:5px;font-size:12.5px;font-weight:400',
      pLocChips: (() => {
        const stores = this.t('location').filter(l => l.type !== 'central');
        const shared = this.prodShared(selP);
        const cur = this.prodLocList(selP); // 只用明確指定的門市(共用時為空)→ 各店 chip 獨立開關
        const chip = (active, extra) => 'padding:3px 10px;border-radius:7px;cursor:pointer;font-size:11.5px;user-select:none;white-space:nowrap' + (active ? ';background:#0e7490;color:#fff;font-weight:600' : ';background:#fff;color:#66707f;border:1px solid #dfe3e8') + (extra || '');
        const write = ids => { const uniq = stores.map(x => x.location_id).filter(id => ids.indexOf(id) >= 0); const nv = uniq.length ? uniq.join('|') : ''; db.replace('product', this.t('product').map(p => p.product_id === S.selProd ? Object.assign({}, p, { location_id: nv }) : p)); this.forceUpdate(); this.notify('✓ 已改門市：' + (selP.name || '') + ' → ' + (nv ? uniq.map(x => this.locName(x)).join('、') : '共用(全門市)')); };
        const setShared = () => { db.replace('product', this.t('product').map(p => p.product_id === S.selProd ? Object.assign({}, p, { location_id: '' }) : p)); this.forceUpdate(); this.notify('✓ 已改門市：' + (selP.name || '') + ' → 共用(全門市)'); };
        const chips = [{ name: '共用', style: chip(shared, ';margin-right:2px'), toggle: setShared }];
        stores.forEach(st => { const on = cur.indexOf(st.location_id) >= 0; chips.push({ name: st.name, style: chip(on), toggle: () => { const set = new Set(cur); if (set.has(st.location_id)) set.delete(st.location_id); else set.add(st.location_id); write([...set]); } }); });
        return chips;
      })(),
      pName: selP.name !== undefined ? selP.name : ((this.ing(S.selProd) || {}).name || ''),
      onPName: setP('name'),
      pHeadStyle: isIngSel ? 'display:none' : 'margin-left:auto;display:flex;gap:10px;font-size:12.5px;font-weight:400;align-items:center',
      pIngTagStyle: isIngSel ? this.tag(C.amb) : 'display:none',
      pIngYieldStyle: isIngSel ? 'margin-left:auto;display:flex;gap:6px;font-size:12.5px;font-weight:400;align-items:center' : 'display:none',
      pIngYield: selfG.batch_yield || '',
      onPIngYield: e => { const v = e.target.value; db.replace('ingredient', this.t('ingredient').map(x => x.ingredient_id === S.selProd ? Object.assign({}, x, { batch_yield: v }) : x)); this.forceUpdate(); },
      routPanelStyle: '', // 自製半成品也有工序(菌種續養/熬煮/冷藏等),供逆推排程與製作天數
      routNote: isIngSel ? '自製半成品工序:攪拌/熬煮/發酵/冷藏等;工時 >8 小時自動 +1 天(排入生產時反映在完成日)' : '',
      routNoteStyle: isIngSel ? 'padding:8px 16px;font-size:11.5px;color:#66707f;border-top:1px solid #eef0f3' : 'display:none',
      mgHideStyle: (isIngSel || !this.canCost()) ? 'display:none' : '', // 批成本/毛利/毛利率:半成品或無成本權限都藏
      unitCostLbl: isIngSel ? '每 g 成本' : '單位成本',
      unitCostTip: isIngSel ? '每 g 成本 = 批成本 ÷ 產出 g 數(標準產出 ' + yieldN + ')' : '單位成本 = 批成本 ÷ 標準產出(' + yieldN + ')',
      costNote: !this.canCost() ? '' : isIngSel ? '自製半成品:配方=每批用量,「批次產出」填一批做出的 g/ml 數;生產完成入庫時自動以 批成本÷批次產出 回寫「最新單價」,上層產品成本即時反映' : '改用量/售價即時重算;單價取最新進貨價',
      pPrice: selP.sale_price, onPPrice: setP('sale_price'), pYield: selP.default_yield, onPYield: setP('default_yield'),
      pLeadTxt: (() => {
        const t = this.totalMinOf(S.selProd); if (!t) return '未設定工序';
        const ld = this.leadOf(S.selProd);
        return (t >= 60 ? (t / 60).toFixed(1) + ' 小時' : t + ' 分') + (ld ? ' · 跨 ' + ld + ' 天' : ' · 當日完成');
      })(),
      bomRows,
      // 加原料:先用 廠商/分類 縮小原料清單(目錄大時好找)
      ...(() => {
        const supF = S.bomSupFilter || '';
        // 分類選項連動:只列「該廠商供應的原料」出現的分類;換廠商後原分類不適用就自動回「全部分類」
        const supPool = this.t('ingredient').filter(g => !supF || (supF === '__self' ? g.purchase_unit === '自製' : g.default_supplier_id === supF));
        const catsOfSup = this.catSorted(supPool.map(g => this.gcat(g)).filter((c, i, a) => c && a.indexOf(c) === i));
        const catF = catsOfSup.indexOf(S.bomCatFilter) >= 0 ? S.bomCatFilter : '';
        const pool = supPool.filter(g => !catF || this.gcat(g) === catF);
        const supNm = {}; for (const s2 of this.t('supplier')) supNm[s2.supplier_id] = s2.name;
        const metaOf = g => [(supNm[g.default_supplier_id] || (g.purchase_unit === '自製' ? '自製' : '')), this.gcat(g)].filter(Boolean).join('・');
        const effBomIng = pool.some(g => g.ingredient_id === S.bomAddIng) ? S.bomAddIng : ((pool[0] || {}).ingredient_id || '');
        return {
          // 選項尾端帶各自 id(熟手直接記/搜 id 最快;搜尋框也搜得到 id)
          bomIngBtn: this.ddBtn(pool.map(g => ({ id: g.ingredient_id, name: g.name, meta: [metaOf(g), g.ingredient_id].filter(Boolean).join(' · ') })), effBomIng, v => this.setState({ bomAddIng: v }), '(無符合原料)'),
          bomSupBtn: this.ddBtn([{ id: '', name: '全部廠商' }, { id: '__self', name: '自製半成品' }].concat(this.t('supplier').map(s2 => ({ id: s2.supplier_id, name: s2.name, meta: s2.supplier_id }))), supF, v => this.setState({ bomSupFilter: v, bomCatFilter: '' })),
          bomCatBtn: this.ddBtn([{ id: '', name: '全部分類' }].concat(catsOfSup.map(c => { const cid = this.catIdOf(c); return { id: c, name: c, meta: cid !== c ? cid : '' }; })), catF, v => this.setState({ bomCatFilter: v })),
          bomSupOptions: [{ id: '', name: '全部廠商' }].concat(this.t('supplier').map(s2 => ({ id: s2.supplier_id, name: s2.name }))),
          bomCatOptions: [{ id: '', name: '全部分類' }].concat(catsOfSup.map(c => ({ id: c, name: c }))),
          bomSupF: supF, onBomSupF: e => this.setState({ bomSupFilter: e.target.value, bomCatFilter: '', bomIngOpen: false }),
          bomCatF: catF, onBomCatF: e => this.setState({ bomCatFilter: e.target.value, bomIngOpen: false }),
          addBom: () => {
            if (!effBomIng) { this.notify('此篩選下沒有原料 — 換一個廠商/分類'); return; }
            db.replace('bom', this.t('bom').concat([{ bom_id: db.nextId('bom', 'bom_id', 'B-', 2), product_id: S.selProd, ingredient_id: effBomIng, qty_per_yield: S.bomAddQty }]));
            this.forceUpdate();
          }
        };
      })(),
      bomAddQty: S.bomAddQty, onBomAddQty: e => this.setState({ bomAddQty: e.target.value }),
      batchCost: 'NT$' + this.fmt(bCost, 1), unitCostTxt: 'NT$' + uCost.toFixed(1),
      marginTxt: 'NT$' + marginV.toFixed(1), marginPct: this.n(selP.sale_price) ? (marginV / this.n(selP.sale_price) * 100).toFixed(1) + '%' : '—',
      // 雙向定價:毛利率 → 售價 = 單位成本 ÷ (1−毛利率),四捨五入到整數;售價 → 毛利率(原有)
      marginPctVal: this.n(selP.sale_price) ? (marginV / this.n(selP.sale_price) * 100).toFixed(1) : '',
      // 輸入框寬度跟著內容長(數字再長也顯示完整,不截斷)
      mgRateInpStyle: 'text-align:right;color:#177a4c;font-weight:700;width:' + (String(this.n(selP.sale_price) ? (marginV / this.n(selP.sale_price) * 100).toFixed(1) : '').length + 4.5) + 'ch',
      onMarginPct: e => {
        const m = parseFloat(e.target.value);
        if (isNaN(m)) return;
        if (m >= 100) { this.notify('毛利率需小於 100%'); this.forceUpdate(); return; }
        if (!(uCost > 0)) { this.notify('此產品尚無配方成本 — 先建 BOM(批成本 > 0)才能由毛利率反推售價'); this.forceUpdate(); return; }
        const price = Math.round(uCost / (1 - m / 100));
        db.replace('product', this.t('product').map(x => x.product_id === S.selProd ? Object.assign({}, x, { sale_price: String(price) }) : x));
        this.forceUpdate();
        this.notify('✓ 毛利率 ' + m + '% → 售價 NT$' + price + '(單位成本 NT$' + uCost.toFixed(1) + ');標準產出不變');
      },
      routRows,
      supRows, eqRows, addSup, addEq, eqTypeOptions, supOptions2,
      supHead: [['name', '名稱', 'width:160px;flex:none'], ['contact', '聯絡方式', 'flex:1'], ['terms', '付款方式', 'width:110px;flex:none'], ['cnt', '供應品項', 'width:74px;flex:none;text-align:right']].map(h => ({
        label: h[1],
        arrow: sSort && sSort.key === h[0] ? (sSort.dir > 0 ? ' ↑' : ' ↓') : '',
        style: h[2] + ';font-size:11px;font-weight:600;cursor:pointer;user-select:none;white-space:nowrap;' + (sSort && sSort.key === h[0] ? 'color:#0e7490' : 'color:#66707f'),
        onSort: () => this.setState({ supSort: !sSort || sSort.key !== h[0] ? { key: h[0], dir: 1 } : (sSort.dir > 0 ? { key: h[0], dir: -1 } : null) })
      })),
      dSup: d.default_supplier_id || '', onDSup: setD('default_supplier_id'),
      dSupBtn: this.ddBtn(supOptions2, d.default_supplier_id || '', v => this.setState({ draft: Object.assign({}, d, { default_supplier_id: v }) })),
      dCost: d.latest_unit_cost, onDCost: setD('latest_unit_cost'),
      // 報價三欄連動:稅前×稅率=含稅;改含稅 → 稅前反推;改稅率 → 含稅不動、稅前反推
      dQuotePre: d.quote_price_pre !== undefined && d.quote_price_pre !== '' ? d.quote_price_pre : (this.n(d.quote_price) > 0 ? String(+(this.n(d.quote_price) / (this.n(d.tax_rate) || 1)).toFixed(2)) : ''),
      onDQuotePre: e => { const v = this.n(e.target.value); const rate = this.n(d.tax_rate) || 1; this.setState({ draft: Object.assign({}, d, { quote_price_pre: e.target.value, quote_price: v > 0 ? String(+(v * rate).toFixed(2)) : '' }) }); },
      dQuote: d.quote_price || '',
      onDQuote: e => { const v = this.n(e.target.value); const rate = this.n(d.tax_rate) || 1; this.setState({ draft: Object.assign({}, d, { quote_price: e.target.value, quote_price_pre: v > 0 ? String(+(v / rate).toFixed(2)) : '' }) }); },
      dTax: this.n(d.tax_rate) === 1 ? '1.0' : '1.05', onDTax: setD('tax_rate'),
      dTaxBtn: this.ddBtn([{ id: '1.0', name: '1.0(免稅)' }, { id: '1.05', name: '1.05(含 5% 營業稅)' }], this.n(d.tax_rate) === 1 ? '1.0' : '1.05', v => { const rate = this.n(v) || 1; const qp = this.n(d.quote_price); this.setState({ draft: Object.assign({}, d, { tax_rate: v, quote_price_pre: qp > 0 ? String(+(qp / rate).toFixed(2)) : d.quote_price_pre }) }); }),
      dTaxedTxt: (() => { const qp = this.n(d.quote_price); if (qp <= 0) return '—'; const rate = this.n(d.tax_rate) || 1.05; return 'NT$ ' + this.fmt(Math.round(qp * rate)) + ' /' + (d.purchase_unit || '單位'); })(),
      rRangeTxt,
      rRev: 'NT$' + this.fmt(rRevN), rCost: 'NT$' + this.fmt(rCostN),
      rMargin: 'NT$' + this.fmt(rRevN - rCostN), rMarginPct: !this.canCost() ? '' : rRevN ? ((rRevN - rCostN) / rRevN * 100).toFixed(1) + '% 毛利率' : '—',
      rWasteRate: prodCostW ? (wasteCostW / prodCostW * 100).toFixed(1) + '%' : '—',
      marginRows, wasteBars,
      closeRows, closeEmpty: closeRows.length ? 'display:none' : 'padding:14px 16px;color:#66707f;font-size:12.5px',
      cSales: this.fmt(cSalesN), cCogs: this.fmt(cCogsN), cMargin: this.fmt(cSalesN - cCogsN),
      cWaste: '−' + this.fmt(cWasteN), cNet: this.fmt(cSalesN - cCogsN - cWasteN),
      doClose: () => this.doClose(),
      closedTag: S.closed ? '已完成日結' : '未結',
      closedStyle: this.tag(S.closed ? C.grn : C.amb),
      // ── 帳號與角色(super_admin;資料在 user_account / role_permission 分頁,可直接改 Sheet)──
      ...(() => {
        const chip = on => (on ? 'background:#0e7490;border-color:#0e7490;color:#fff' : 'color:#66707f;border-color:#e3e6eb') + ';cursor:pointer;user-select:none';
        const setAcc = (i, k, v) => {
          const arr = (S.accUsers || []).slice();
          arr[i] = Object.assign({}, arr[i], { [k]: v });
          this.setState({ accUsers: arr });
          this.saveAccounts();
        };
        const PERM_ROLES = [['central_ops', '中央倉'], ['store_admin', '店長'], ['store_kitchen', '內場'], ['store_front', '外場']];
        const PERM_ITEMS = [['screen.setup', '開始設定'], ['screen.overview', '營運總覽'], ['screen.schedule', '每日排程'], ['screen.production', '生產管理'], ['screen.sales', '前台銷售'], ['screen.inventory', '庫存'], ['screen.purchase', '叫貨與採購'], ['screen.ingredients', '原料/本店備料'], ['screen.locations', '門市地點'], ['screen.products', '產品與配方'], ['screen.suppliers', '供應商・設備'], ['screen.staff', '人員'], ['screen.reports', '報表'], ['screen.closing', '日結'], ['screen.connect', '資料連線'], ['feature.cost', '成本可見(單價/毛利)']];
        return {
          accBusyTxt: S.accBusy ? '載入中…' : (S.accErr ? '✕ ' + S.accErr : ''),
          accReload: () => this.loadAccounts(true),
          accAdd: () => {
            const arr = (S.accUsers || []).slice();
            let mx = 0; arr.forEach(u => { const m = String(u.user_id).match(/(\d+)$/); if (m) mx = Math.max(mx, +m[1]); });
            const firstStore = (this.t('location').find(l => l.type !== 'central') || {}).location_id || 'LOC-A';
            arr.push({ user_id: 'U-' + String(mx + 1).padStart(3, '0'), name: '新帳號', email: '', role: 'store_front', location_ids: firstStore, active: 'TRUE', created_at: this.TODAY, last_login: '' });
            this.setState({ accUsers: arr });
            this.saveAccounts();
            this.notify('✓ 已新增帳號 — 填上對方的 Google Email 即可登入');
          },
          accRows: (S.accUsers || []).map((u, i) => {
            const locsCur = String(u.location_ids || '').trim();
            const isAll = !locsCur || locsCur.toUpperCase() === 'ALL';
            const list = isAll ? [] : locsCur.split(/[|;,]/).map(x => x.trim()).filter(Boolean);
            return {
              id: u.user_id,
              nameVal: u.name, onName: e => setAcc(i, 'name', e.target.value),
              emailVal: u.email, onEmail: e => setAcc(i, 'email', e.target.value.trim().toLowerCase()),
              roleBtn: this.ddBtn(this.ROLE_OPTS, u.role, v => setAcc(i, 'role', v)),
              locBtn: this.ddBtnMulti(
                isAll ? '全部門市(不限)' : (list.map(id => (this.t('location').find(l => l.location_id === id) || {}).name || id).join('、') || '未選門市'),
                () => this.locItems(i)
              ),
              actTxt: String(u.active).toUpperCase() === 'TRUE' ? '啟用' : '停用',
              actStyle: this.tag(String(u.active).toUpperCase() === 'TRUE' ? C.grn : C.mut) + ';cursor:pointer',
              onToggle: () => setAcc(i, 'active', String(u.active).toUpperCase() === 'TRUE' ? 'FALSE' : 'TRUE'),
              lastLogin: u.last_login || '—'
            };
          }),
          accEmpty: ((S.accUsers && S.accUsers.length) || S.accBusy) ? 'display:none' : 'padding:14px 16px;font-size:12px;color:#66707f',
          permRoleHead: PERM_ROLES.map(r => r[1]),
          permMatrix: PERM_ITEMS.map(it => ({
            label: it[1],
            cells: PERM_ROLES.map(pr => {
              const on = (S.accPerms || []).some(p => p.role_id === pr[0] && p.perm_key === it[0] && String(p.allow).toUpperCase() === 'TRUE');
              return {
                txt: on ? '✓' : '—',
                style: (on ? this.tag(C.grn) : 'color:#c6ccd4;border-color:#eef0f3') + ';cursor:pointer;min-width:26px;text-align:center;user-select:none',
                toggle: () => {
                  let arr = (S.accPerms || []).filter(p => !(p.role_id === pr[0] && p.perm_key === it[0]));
                  if (!on) arr = arr.concat([{ role_id: pr[0], perm_key: it[0], allow: 'TRUE' }]);
                  this.setState({ accPerms: arr });
                  this.savePerms();
                }
              };
            })
          }))
        };
      })()
    };
  }
}



mountApp(Component, document.getElementById('app'), document.getElementById('app-tpl').textContent);
