/* Control de entregas de material a subcontratas · v2
 * PWA sin compilación. Backend: Supabase (o modo demo local si no hay config). */
'use strict';

const CFG = window.APP_CONFIG || {};
const DEMO = !CFG.SUPABASE_URL || !CFG.SUPABASE_ANON_KEY;
const VERSION = '2.0';

/* ------------------------------------------------------------------ */
/* Utilidades                                                          */
/* ------------------------------------------------------------------ */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nf = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 3 });
const fmt = (n) => nf.format(Number(n) || 0);
const round3 = (n) => Math.round((Number(n) || 0) * 1000) / 1000;
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const fdate = (iso) => new Date(iso).toLocaleString('es-ES', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
const fday = (d) => (d ? new Date(String(d).length === 10 ? d + 'T12:00:00' : d).toLocaleDateString('es-ES') : '');
const today = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
  : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = (Math.random() * 16) | 0; return (c === 'x' ? r : (r & 3) | 8).toString(16); }));
const valeNum = (v) => (v?.numero ? `${v.clase === 'devolucion' ? 'D' : 'V'}-${String(v.numero).padStart(5, '0')}` : 'Sin número (pendiente de envío)');
const sum = (arr) => arr.reduce((a, b) => a + (Number(b) || 0), 0);

const LS = {
  get(k, d) { try { const v = localStorage.getItem('ent_' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('ent_' + k, JSON.stringify(v)); } catch { /* sin almacenamiento */ } },
};

function parseNum(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (v == null) return 0;
  let s = String(v).trim().replace(/\s/g, '');
  if (!s) return 0;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

// Error de red (se reintenta) frente a rechazo del servidor (se muestra)
const isNetErr = (e) => !navigator.onLine || /failed to fetch|networkerror|load failed|network request failed|timeout|jwt/i.test(e?.message || '');

let toastTimer;
function toast(msg, action) {
  const t = $('#toast');
  t.innerHTML = `<span>${esc(msg)}</span>` + (action ? `<button>${esc(action.label)}</button>` : '');
  if (action) t.querySelector('button').onclick = () => { t.hidden = true; action.fn(); };
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, action ? 8000 : 4000);
}

/* ------------------------------------------------------------------ */
/* Backend: Supabase                                                   */
/* ------------------------------------------------------------------ */
function supabaseBackend() {
  const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true },
  });
  const ok = ({ data, error }) => { if (error) throw new Error(error.message); return data; };
  // Supabase devuelve como máximo 1000 filas por petición: paginar
  async function all(build) {
    const out = [];
    for (let from = 0; ; from += 1000) {
      const data = ok(await build().range(from, from + 999));
      out.push(...data);
      if (data.length < 1000) return out;
    }
  }
  return {
    async user() { const { data } = await sb.auth.getSession(); return data.session?.user || null; },
    async signIn(email, password) { return ok(await sb.auth.signInWithPassword({ email, password })).user; },
    async signOut() { await sb.auth.signOut(); },
    async perfil() { return ok(await sb.rpc('mi_perfil')); },
    async subcontratas() { return ok(await sb.from('subcontratas').select('*').eq('activo', true).order('orden')); },
    async materiales() { return all(() => sb.from('materiales').select('*').order('codigo')); },
    async resumen() { return all(() => sb.from('v_resumen').select('*')); },
    async ajustes() { return Object.fromEntries(ok(await sb.from('ajustes').select('*')).map((r) => [r.clave, r.valor])); },
    async tiposTracker() { return ok(await sb.from('tipos_tracker').select('*').order('orden')); },
    async reparto() { return ok(await sb.from('reparto').select('*')); },
    async guardarReparto(rows) { ok(await sb.from('reparto').upsert(rows)); },
    async vales({ limit = 200, subId } = {}) {
      let q = sb.from('vales').select('*, lineas:entregas(*)').order('creado', { ascending: false }).limit(limit);
      if (subId) q = q.eq('subcontrata_id', subId);
      return ok(await q);
    },
    async vale(id) { return ok(await sb.from('vales').select('*, lineas:entregas(*)').eq('id', id).single()); },
    async porAprobar() {
      return ok(await sb.from('entregas').select('*').eq('requiere_aprobacion', true).is('aprobado_fecha', null).eq('anulada', false).order('id'));
    },
    async todosVales() { return all(() => sb.from('vales').select('*').order('creado')); },
    async todasLineas() { return all(() => sb.from('entregas').select('*').order('id')); },
    async registrarVale(p) { return ok(await sb.rpc('registrar_vale', { p })); },
    async anularVale(id, motivo) { ok(await sb.rpc('anular_vale', { p_id: id, p_motivo: motivo })); },
    async anularLinea(id, motivo) { ok(await sb.rpc('anular_linea', { p_id: id, p_motivo: motivo })); },
    async aprobarLinea(id) { ok(await sb.rpc('aprobar_linea', { p_id: id })); },
    async importar(items, revision, tipos) { return ok(await sb.rpc('importar_bom', { p_items: items, p_revision: revision, p_tipos: tipos })); },
    async usuarios() { return ok(await sb.from('usuarios').select('*').order('email')); },
    async guardarUsuario(u) {
      ok(await sb.from('usuarios').update({ nombre: u.nombre || null, rol: u.rol, subcontrata_id: u.subcontrata_id || null }).eq('email', u.email));
    },
    subscribe(onChange, onStatus) {
      let ch = sb.channel('cambios');
      for (const t of ['entregas', 'vales', 'materiales', 'reparto']) ch = ch.on('postgres_changes', { event: '*', schema: 'public', table: t }, () => onChange(t));
      ch.subscribe((status) => onStatus(status === 'SUBSCRIBED' ? 'ok' : status === 'CHANNEL_ERROR' || status === 'CLOSED' ? 'off' : 'mid'));
    },
  };
}

/* ------------------------------------------------------------------ */
/* Backend: demo local (mismo interfaz, guarda en localStorage)        */
/* ------------------------------------------------------------------ */
function demoBackend() {
  const KEY = 'ent_demo_db';
  const blank = () => ({
    subs: [{ id: 1, nombre: 'SOLERGY', orden: 1 }, { id: 2, nombre: 'SOLMONTECH', orden: 2 }, { id: 3, nombre: 'SUBCONTRATA 3', orden: 3 }],
    mats: [], vales: [], ents: [], tipos: [], reparto: [], ajustes: { proyecto: CFG.PROYECTO || '' }, nextId: 1, nextNum: 1,
    usuarios: [{ email: 'demo@local', nombre: '', rol: 'admin', subcontrata_id: null }],
  });
  const load = () => { try { return { ...blank(), ...JSON.parse(localStorage.getItem(KEY)) }; } catch { return blank(); } };
  const listeners = [];
  const save = (db, what = 'entregas') => { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch { /* sin almacenamiento */ } listeners.forEach((f) => f(what)); };
  const me = () => ({ email: 'demo@local', nombre: LS.get('nombre', ''), rol: LS.get('demo_rol', 'admin'), subcontrata_id: LS.get('demo_sub', 1) });
  const visible = (x) => me().rol !== 'subcontrata' || x.subcontrata_id === me().subcontrata_id;
  const red = () => { if (LS.get('demo_offline', false)) throw new TypeError('Failed to fetch'); };
  const exigir = (roles, msg) => { if (!roles.includes(me().rol)) throw new Error(msg); };
  const nombre = () => me().nombre || me().email;
  const conLineas = (db, v) => ({ ...v, lineas: db.ents.filter((e) => e.vale_id === v.id) });
  return {
    async user() { return { email: me().email }; },
    async signIn() { return { email: me().email }; },
    async signOut() {},
    async perfil() { return me(); },
    async subcontratas() { red(); return load().subs; },
    async materiales() { return load().mats; },
    async resumen() {
      const m = new Map();
      for (const e of load().ents) {
        if (e.anulada || !visible(e)) continue;
        const k = `${e.codigo}|${e.subcontrata_id}|${e.tipo}`;
        const r = m.get(k) || { codigo: e.codigo, subcontrata_id: e.subcontrata_id, tipo: e.tipo, total: 0, movimientos: 0 };
        r.total += e.clase === 'devolucion' ? -e.cantidad : e.cantidad; r.movimientos++; m.set(k, r);
      }
      return [...m.values()];
    },
    async ajustes() { return load().ajustes; },
    async tiposTracker() { return load().tipos; },
    async reparto() { return load().reparto.filter(visible); },
    async guardarReparto(rows) {
      exigir(['admin'], 'Solo un administrador puede cambiar el reparto');
      const db = load();
      for (const r of rows) {
        const i = db.reparto.findIndex((x) => x.subcontrata_id === r.subcontrata_id && x.tipo === r.tipo);
        if (i >= 0) db.reparto[i] = r; else db.reparto.push(r);
      }
      save(db, 'reparto');
    },
    async vales({ limit = 200, subId } = {}) {
      const db = load();
      return db.vales.filter((v) => visible(v) && (!subId || v.subcontrata_id === subId)).sort((a, b) => b.numero - a.numero).slice(0, limit).map((v) => conLineas(db, v));
    },
    async vale(id) { const db = load(); const v = db.vales.find((x) => x.id === id); return v && conLineas(db, v); },
    async porAprobar() { return load().ents.filter((e) => e.requiere_aprobacion && !e.aprobado_fecha && !e.anulada); },
    async todosVales() { return load().vales.filter(visible); },
    async todasLineas() { return load().ents.filter(visible); },
    async registrarVale(p) {
      red();
      exigir(['admin', 'almacen'], 'Tu usuario no tiene permiso para registrar vales');
      const db = load();
      const prev = db.vales.find((v) => v.id === p.id);
      if (prev) return { id: prev.id, numero: prev.numero, repetido: true };
      const now = new Date().toISOString();
      const v = { id: p.id, numero: db.nextNum++, creado: now, fecha: p.fecha || today(), subcontrata_id: p.subcontrata_id, clase: p.clase,
        entregado_por: p.entregado_por || null, receptor: p.receptor || null, observaciones: p.observaciones || null, usuario_email: me().email, anulado: false };
      db.vales.push(v);
      for (const l of p.lineas) {
        db.ents.push({ id: db.nextId++, vale_id: v.id, creado: now, codigo: l.codigo, subcontrata_id: v.subcontrata_id, tipo: l.tipo, clase: v.clase,
          cantidad: l.cantidad, receptor: v.receptor, entregado_por: v.entregado_por, observaciones: l.observaciones || null,
          usuario_email: v.usuario_email, requiere_aprobacion: !!l.requiere_aprobacion, anulada: false });
      }
      save(db);
      return { id: v.id, numero: v.numero };
    },
    async anularVale(id, motivo) {
      red(); exigir(['admin', 'almacen', 'jefe_obra'], 'Tu usuario no tiene permiso para anular');
      const db = load(); const now = new Date().toISOString();
      const v = db.vales.find((x) => x.id === id);
      if (v && !v.anulado) Object.assign(v, { anulado: true, anulado_por: nombre(), anulado_motivo: motivo, anulado_fecha: now });
      for (const e of db.ents) if (e.vale_id === id && !e.anulada) Object.assign(e, { anulada: true, anulada_por: nombre(), anulada_motivo: motivo, anulada_fecha: now });
      save(db);
    },
    async anularLinea(id, motivo) {
      red(); exigir(['admin', 'almacen', 'jefe_obra'], 'Tu usuario no tiene permiso para anular');
      const db = load(); const e = db.ents.find((x) => x.id === id);
      if (e && !e.anulada) Object.assign(e, { anulada: true, anulada_por: nombre(), anulada_motivo: motivo, anulada_fecha: new Date().toISOString() });
      save(db);
    },
    async aprobarLinea(id) {
      red(); exigir(['admin', 'jefe_obra'], 'Solo el jefe de obra o un administrador pueden aprobar excesos');
      const db = load(); const e = db.ents.find((x) => x.id === id);
      if (e) Object.assign(e, { aprobado_por: nombre(), aprobado_fecha: new Date().toISOString() });
      save(db);
    },
    async importar(items, revision, tipos) {
      exigir(['admin'], 'Solo un administrador puede importar el BOM');
      const db = load(); const old = new Map(db.mats.map((m) => [m.codigo, m])); const seen = new Set();
      let nuevos = 0, modificados = 0, desactivados = 0;
      for (const it of items) {
        seen.add(it.codigo);
        const o = old.get(it.codigo);
        if (!o) nuevos++;
        else if (['descripcion', 'unidad', 'cant_proyecto', 'spare_cliente', 'spare_axial'].some((k) => o[k] !== it[k]) || !o.activo) modificados++;
        old.set(it.codigo, { ...it, revision, activo: true });
      }
      for (const [c, m] of old) if (!seen.has(c) && m.activo) { m.activo = false; desactivados++; }
      db.mats = [...old.values()].sort((a, b) => a.codigo.localeCompare(b.codigo));
      for (const t of tipos || []) { const i = db.tipos.findIndex((x) => x.nombre === t.nombre); if (i >= 0) db.tipos[i] = t; else db.tipos.push(t); }
      db.tipos.sort((a, b) => a.orden - b.orden);
      db.ajustes.bom_revision = revision;
      db.ajustes.bom_fecha = new Date().toLocaleString('es-ES');
      save(db, 'materiales');
      return { nuevos, modificados, desactivados };
    },
    async usuarios() { return load().usuarios.map((u) => (u.email === 'demo@local' ? { ...u, ...me() } : u)); },
    async guardarUsuario(u) {
      if (u.email === 'demo@local') { LS.set('demo_rol', u.rol); LS.set('demo_sub', u.subcontrata_id || 1); LS.set('nombre', u.nombre || ''); return; }
      const db = load(); const i = db.usuarios.findIndex((x) => x.email === u.email); if (i >= 0) db.usuarios[i] = u; save(db, 'usuarios');
    },
    subscribe(onChange, onStatus) {
      listeners.push(onChange);
      window.addEventListener('storage', (e) => { if (e.key === KEY) onChange('entregas'); });
      onStatus('ok');
    },
  };
}

const API = DEMO ? demoBackend() : supabaseBackend();

/* ------------------------------------------------------------------ */
/* Estado                                                              */
/* ------------------------------------------------------------------ */
const ROLES = { admin: 'Administrador', almacen: 'Almacén', jefe_obra: 'Jefe de obra', subcontrata: 'Subcontrata', consulta: 'Consulta' };

const S = {
  user: null, me: null,
  subs: [], mats: [], matMap: new Map(),
  resRows: [],             // filas de v_resumen tal y como llegan del servidor
  res: new Map(),          // codigo -> { proyecto: {subId: n}, spare: {subId: n}, movs: n } (incluye vales en cola)
  ajustes: {}, tipos: [], reparto: new Map(), // subId -> { tipo: trackers }
  tab: 'entregar',
  q: '',
  resFiltro: 0, resQ: '', resPend: false,
  valFiltro: 0, vales: [], aprobar: [],
  conn: 'mid', offlineData: false,
  draft: LS.get('vale', null) || { sub: null, clase: 'entrega', lineas: [] },
};

const can = {
  registrar: () => ['admin', 'almacen'].includes(S.me?.rol),
  anular: () => ['admin', 'almacen', 'jefe_obra'].includes(S.me?.rol),
  aprobar: () => ['admin', 'jefe_obra'].includes(S.me?.rol),
  admin: () => S.me?.rol === 'admin',
};
const fixedSub = () => (S.me?.rol === 'subcontrata' ? S.me.subcontrata_id : 0);
const saveDraft = () => { LS.set('vale', S.draft); renderValeBar(); };

/* --- Cálculo de totales --- */
function buildRes() {
  const res = new Map();
  const add = (codigo, subId, tipo, n, movs = 1) => {
    const o = res.get(codigo) || { proyecto: {}, spare: {}, movs: 0 };
    o[tipo][subId] = round3((o[tipo][subId] || 0) + n);
    o.movs += movs;
    res.set(codigo, o);
  };
  for (const r of S.resRows) add(r.codigo, r.subcontrata_id, r.tipo, Number(r.total), Number(r.movimientos) || 0);
  // Vales confirmados pero aún sin enviar (sin cobertura) también cuentan
  for (const it of cola()) for (const l of it.p.lineas) add(l.codigo, it.p.subcontrata_id, l.tipo, it.p.clase === 'devolucion' ? -l.cantidad : l.cantidad);
  S.res = res;
}

function matTotals(codigo, subId) {
  const m = S.matMap.get(codigo);
  const r = S.res.get(codigo) || { proyecto: {}, spare: {} };
  const tot = (o) => round3(sum(Object.values(o)));
  const pTot = m ? Number(m.cant_proyecto) : 0;
  const sTot = m ? Number(m.spare_cliente) + Number(m.spare_axial) : 0;
  const pAll = tot(r.proyecto), sAll = tot(r.spare);
  return {
    pTot, sTot, pAll, sAll,
    pEnt: subId ? r.proyecto[subId] || 0 : pAll, sEnt: subId ? r.spare[subId] || 0 : sAll,
    pPend: round3(pTot - pAll), sPend: round3(sTot - sAll), r,
  };
}

// Cupo de proyecto de una subcontrata: la cantidad de proyecto se reparte en proporción a los
// trackers asignados, ponderando cada tipo por sus unidades/tracker (W–AB). Cuando el BOM cuadra
// (AC = Σ unidades × trackers) coincide con Σ unidades × trackers asignados; sin W–AB, pesa
// solo el número de trackers.
function cupo(codigo, subId) {
  const rep = S.reparto.get(subId); if (!rep || !S.tipos.length) return null;
  if (!Object.values(rep).some((n) => n > 0)) return null;
  const m = S.matMap.get(codigo); if (!m) return null;
  const pt = m.por_tracker || {};
  const peso = (tipo) => (Object.keys(pt).length ? Number(pt[tipo]) || 0 : 1);
  const wTot = sum(S.tipos.map((t) => peso(t.nombre) * Number(t.total)));
  if (!wTot) return null;
  const wSub = sum(S.tipos.map((t) => peso(t.nombre) * (rep[t.nombre] || 0)));
  return Math.round((Number(m.cant_proyecto) * wSub) / wTot);
}

/* --- Carga de datos y caché para trabajar sin cobertura --- */
async function loadMats() {
  setMats(await API.materiales());
  S.ajustes = (await API.ajustes()) || {};
  S.tipos = await API.tiposTracker();
}
function setMats(list) {
  S.mats = list.map((m) => ({ ...m, _s: norm(m.codigo + ' ' + m.descripcion + ' ' + String(m.descripcion).replace(/_/g, ' ')) }));
  S.matMap = new Map(S.mats.map((m) => [m.codigo, m]));
}
async function loadResumen() { S.resRows = await API.resumen(); buildRes(); }
async function loadReparto() {
  const rep = new Map();
  for (const r of await API.reparto()) { const o = rep.get(r.subcontrata_id) || {}; o[r.tipo] = Number(r.trackers); rep.set(r.subcontrata_id, o); }
  S.reparto = rep;
}
async function loadAll() {
  S.me = (await API.perfil()) || null;
  const [subs] = await Promise.all([API.subcontratas(), loadMats(), loadResumen(), loadReparto()]);
  S.subs = subs;
  saveCache();
}
function saveCache() {
  LS.set('cache', {
    me: S.me, subs: S.subs, resRows: S.resRows, ajustes: S.ajustes, tipos: S.tipos,
    reparto: [...S.reparto.entries()], mats: S.mats.map(({ _s, ...m }) => m), fecha: new Date().toISOString(),
  });
}
function loadCache() {
  const c = LS.get('cache', null); if (!c) return false;
  Object.assign(S, { me: c.me, subs: c.subs, resRows: c.resRows, ajustes: c.ajustes, tipos: c.tipos || [], reparto: new Map(c.reparto || []) });
  setMats(c.mats); buildRes();
  S.offlineData = c.fecha;
  return true;
}

let refreshTimer;
function scheduleRefresh(what) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    try {
      if (what === 'materiales') await loadMats();
      if (what === 'reparto' || what === 'materiales') await loadReparto();
      await loadResumen();
      if (S.tab === 'vales') await loadVales();
      S.offlineData = false; saveCache();
      rerender();
    } catch (e) { console.warn(e); }
  }, 350);
}

function setConn(state) {
  S.conn = navigator.onLine ? state : 'off';
  const c = $('#conn');
  c.className = 'conn ' + S.conn;
  c.title = { ok: 'Conectado en tiempo real', mid: 'Conectando…', off: 'Sin conexión' }[S.conn];
}

/* ------------------------------------------------------------------ */
/* Cola de vales sin enviar (modo sin cobertura)                       */
/* ------------------------------------------------------------------ */
const cola = () => LS.get('cola', []);
function setCola(q) { LS.set('cola', q); buildRes(); renderColaBadge(); }
function renderColaBadge() {
  const n = cola().length, b = $('#cola');
  b.hidden = !n; b.textContent = `${n} sin enviar`;
}

let flushing = false;
async function flushCola() {
  if (flushing || !cola().length) return [];
  flushing = true;
  const sent = [];
  try {
    for (const it of cola()) {
      if (it.error) continue;
      try {
        const r = await API.registrarVale(it.p);
        sent.push({ ...it.p, numero: r.numero });
        setCola(cola().filter((x) => x.p.id !== it.p.id));
      } catch (e) {
        if (isNetErr(e)) break;
        setCola(cola().map((x) => (x.p.id === it.p.id ? { ...x, error: e.message } : x)));
      }
    }
  } finally { flushing = false; }
  if (sent.length) { try { await loadResumen(); } catch { /* se recarga después */ } rerender(); }
  return sent;
}
setInterval(() => { if (navigator.onLine && cola().some((x) => !x.error)) flushCola(); }, 30000);

/* ------------------------------------------------------------------ */
/* Búsqueda                                                            */
/* ------------------------------------------------------------------ */
function search(q, list = S.mats.filter((m) => m.activo !== false)) {
  const toks = norm(q).split(/\s+/).filter(Boolean);
  if (!toks.length) return [];
  const nq = toks.join(' ');
  return list
    .filter((m) => toks.every((t) => m._s.includes(t)))
    .map((m) => {
      const c = norm(m.codigo);
      return [c === nq ? 0 : c.startsWith(nq) ? 1 : c.includes(nq) ? 2 : 3, m];
    })
    .sort((a, b) => a[0] - b[0] || a[1].codigo.localeCompare(b[1].codigo))
    .map((x) => x[1]);
}

/* ------------------------------------------------------------------ */
/* Vistas                                                              */
/* ------------------------------------------------------------------ */
const view = () => $('#view');
const subName = (id) => S.subs.find((s) => s.id === id)?.nombre || '—';

function rerender() {
  if (!S.me) return;
  if (S.tab === 'entregar') renderEntregarResults();
  else if (S.tab === 'resumen') renderResumenList();
  else if (S.tab === 'vales') renderValesList();
  else if (S.tab === 'mas') renderMas();
  renderValeBar(); renderColaBadge();
  if (sheet && sheet.kind !== 'print') renderSheet();
}

function subChips(selected, { all = false, attr = 'data-sub', disabled = false } = {}) {
  return `<div class="chips">` +
    (all ? `<button class="chip ${!selected ? 'on' : ''}" ${attr}="0">Todas</button>` : '') +
    S.subs.map((s) => `<button class="chip ${selected === s.id ? 'on' : ''}" ${attr}="${s.id}" ${disabled && selected !== s.id ? 'disabled' : ''}>${esc(s.nombre)}</button>`).join('') +
    `</div>`;
}

function cupoPill(codigo, subId) {
  const c = cupo(codigo, subId); if (c == null || !subId) return '';
  const ent = matTotals(codigo, subId).pEnt;
  if (c === 0 && ent === 0) return '';
  const pct = c ? (ent / c) * 100 : 100;
  return pct > 100 ? `<span class="pill x">Sobre cupo</span>` : pct >= 90 ? `<span class="pill w">${Math.floor(pct)}% cupo</span>` : '';
}

function matItem(m, subId) {
  const t = matTotals(m.codigo);
  const pPct = t.pTot ? Math.min(100, (t.pAll / t.pTot) * 100) : 0;
  const c = subId ? cupo(m.codigo, subId) : null;
  return `<button class="item" data-open="${esc(m.codigo)}">
    <div class="row"><span class="code grow">${esc(m.codigo)}</span>${cupoPill(m.codigo, subId)}${m.activo === false ? '<span class="pill x">Fuera de BOM</span>' : ''}</div>
    <div class="desc">${esc(m.descripcion)}</div>
    <div class="bar ${t.pAll > t.pTot ? 'over' : ''}"><i style="width:${pPct}%"></i></div>
    <div class="meta">
      <span><span class="pill p">Proyecto</span> pend. <b>${fmt(t.pPend)}</b> / ${fmt(t.pTot)} ${esc(m.unidad || '')}</span>
      <span><span class="pill s">Spare</span> pend. <b>${fmt(t.sPend)}</b> / ${fmt(t.sTot)}</span>
      ${c != null ? `<span>Cupo ${esc(subName(subId))}: <b>${fmt(matTotals(m.codigo, subId).pEnt)}</b> / ${fmt(c)}</span>` : ''}
    </div>
  </button>`;
}

/* --- Entregar --- */
function renderEntregar() {
  const d = S.draft;
  view().innerHTML = `
    <div class="seg clase"><button class="${d.clase === 'entrega' ? 'on p' : 'p'}" data-clase="entrega">Entrega</button><button class="${d.clase === 'devolucion' ? 'on d' : 'd'}" data-clase="devolucion">Devolución</button></div>
    <h2>Subcontrata</h2>
    <div id="ent-subs">${subChips(d.sub)}</div>
    <input id="q" class="search" type="search" placeholder="Buscar por código o descripción…" autocomplete="off" value="${esc(S.q)}">
    <div id="ent-res" class="list"></div>`;
  $$('[data-clase]').forEach((b) => (b.onclick = () => {
    if (b.dataset.clase === d.clase) return;
    if (d.lineas.length && !confirm('Hay un vale a medias. ¿Vaciarlo para cambiar entre entrega y devolución?')) return;
    S.draft = { ...d, clase: b.dataset.clase, lineas: [] }; saveDraft(); renderEntregar();
  }));
  $('#ent-subs').onclick = (e) => {
    const b = e.target.closest('[data-sub]'); if (!b) return;
    const id = Number(b.dataset.sub); if (id === d.sub) return;
    if (d.lineas.length && !confirm(`El vale tiene ${d.lineas.length} líneas para ${subName(d.sub)}. ¿Vaciarlo y cambiar de subcontrata?`)) return;
    S.draft = { ...S.draft, sub: id, lineas: [] }; saveDraft(); renderEntregar();
  };
  $('#q').oninput = (e) => { S.q = e.target.value; renderEntregarResults(); };
  renderEntregarResults();
}
function renderEntregarResults() {
  const box = $('#ent-res'); if (!box) return;
  if (!S.mats.length) {
    box.innerHTML = `<div class="empty">Todavía no hay materiales cargados.<br>${can.admin() ? 'Ve a <b>Más → Importar BOM</b> para cargar el Excel.' : 'Pide al administrador que importe el BOM.'}</div>`;
    return;
  }
  const sub = S.draft.sub;
  if (!S.q.trim()) {
    const rec = LS.get('recientes', []).map((c) => S.matMap.get(c)).filter(Boolean);
    box.innerHTML = rec.length
      ? `<div class="muted small">Usados recientemente</div>` + rec.map((m) => matItem(m, sub)).join('')
      : `<div class="empty">Escribe parte del código (ej. <code>0171</code>) o de la descripción (ej. <code>M12X30</code>).</div>`;
    return;
  }
  const found = search(S.q);
  box.innerHTML = found.length
    ? found.slice(0, 60).map((m) => matItem(m, sub)).join('') + (found.length > 60 ? `<div class="empty">${found.length - 60} resultados más: afina la búsqueda.</div>` : '')
    : `<div class="empty">Sin resultados para “${esc(S.q)}”.</div>`;
}

function renderValeBar() {
  const bar = $('#valebar'); const d = S.draft;
  const show = S.me && can.registrar() && d.lineas.length > 0 && S.tab === 'entregar';
  bar.hidden = !show; document.body.classList.toggle('has-vale', !!show);
  if (!show) return;
  bar.innerHTML = `<div class="grow"><b>${d.clase === 'devolucion' ? 'Devolución' : 'Vale'} · ${esc(subName(d.sub))}</b><div class="small">${d.lineas.length} línea${d.lineas.length > 1 ? 's' : ''}</div></div>
    <button class="btn" id="vb-go">Revisar y confirmar</button>`;
  $('#vb-go').onclick = () => openSheet({ kind: 'draft' });
}

/* --- Resumen --- */
function renderResumen() {
  const fx = fixedSub();
  if (fx) S.resFiltro = fx;
  view().innerHTML = `
    <div id="res-cards"></div>
    <h2>Material</h2>
    ${fx ? `<div class="muted small">Material entregado a <b>${esc(subName(fx))}</b></div>` : `<div id="res-subs">${subChips(S.resFiltro, { all: true })}</div>`}
    <input id="rq" class="search" type="search" placeholder="Filtrar por código o descripción…" value="${esc(S.resQ)}">
    <label class="toggle"><input type="checkbox" id="rpend" ${S.resPend ? 'checked' : ''}> Solo con material de proyecto pendiente</label>
    <div id="res-list" class="list"></div>`;
  if (!fx) $('#res-subs').onclick = (e) => {
    const b = e.target.closest('[data-sub]'); if (!b) return;
    S.resFiltro = Number(b.dataset.sub); $('#res-subs').innerHTML = subChips(S.resFiltro, { all: true }); renderResumenList();
  };
  $('#rq').oninput = (e) => { S.resQ = e.target.value; renderResumenList(); };
  $('#rpend').onchange = (e) => { S.resPend = e.target.checked; renderResumenList(); };
  renderResumenList();
}
function renderResumenList() {
  const cards = $('#res-cards'), box = $('#res-list'); if (!box) return;
  const activos = S.mats.filter((m) => m.activo !== false);
  const fx = fixedSub();
  if (!fx) {
    let completas = 0, excedidas = 0, sinEmpezar = 0;
    for (const m of activos) {
      const t = matTotals(m.codigo);
      if (t.pAll >= t.pTot && t.pTot > 0) completas++;
      if (t.pAll > t.pTot || t.sAll > t.sTot) excedidas++;
      if (t.pAll === 0 && t.sAll === 0) sinEmpezar++;
    }
    cards.innerHTML = `
      <div class="cards">
        <div class="card"><div class="big">${completas}<span class="muted small"> / ${activos.length}</span></div><div class="lbl">Códigos con proyecto completo</div></div>
        <div class="card"><div class="big">${sinEmpezar}</div><div class="lbl">Códigos sin entregas</div></div>
        <div class="card"><div class="big" style="color:${excedidas ? 'var(--bad)' : 'inherit'}">${excedidas}</div><div class="lbl">Códigos excedidos</div></div>
      </div>`;
  } else cards.innerHTML = '';
  cards.innerHTML += `<div class="cards" style="margin-top:8px">${S.subs.filter((s) => !fx || s.id === fx).map((s) => {
    let lineas = 0, sobre = 0;
    for (const m of activos) {
      const t = matTotals(m.codigo, s.id);
      if (t.pEnt + t.sEnt > 0) lineas++;
      const c = cupo(m.codigo, s.id); if (c != null && t.pEnt > c) sobre++;
    }
    return `<div class="card"><div class="lbl">${esc(s.nombre)}</div><div class="big">${lineas}</div><div class="lbl">códigos recibidos${sobre ? ` · <span style="color:var(--bad)">${sobre} sobre cupo</span>` : ''}</div></div>`;
  }).join('')}</div>`;

  let list = S.resQ.trim() ? search(S.resQ, S.mats) : S.mats.slice();
  if (S.resFiltro) list = list.filter((m) => { const t = matTotals(m.codigo, S.resFiltro); return t.pEnt + t.sEnt !== 0 || (fx && cupo(m.codigo, fx)); });
  if (S.resPend) list = list.filter((m) => (fx ? (cupo(m.codigo, fx) ?? 0) - matTotals(m.codigo, fx).pEnt > 0 : matTotals(m.codigo).pPend > 0));
  box.innerHTML = list.length
    ? list.slice(0, 300).map((m) => resItem(m)).join('') + (list.length > 300 ? `<div class="empty">Mostrando 300 de ${list.length}. Filtra o descarga el Excel.</div>` : '')
    : `<div class="empty">Nada que mostrar con estos filtros.</div>`;
}
function resItem(m) {
  const sub = S.resFiltro || 0;
  const t = matTotals(m.codigo, sub);
  const pPct = t.pTot ? Math.min(100, (t.pAll / t.pTot) * 100) : 0;
  const sPct = t.sTot ? Math.min(100, (t.sAll / t.sTot) * 100) : 0;
  const c = sub ? cupo(m.codigo, sub) : null;
  const subLine = sub ? `<span>${esc(subName(sub))}: <b>${fmt(t.pEnt)}</b> proy.${c != null ? ` de ${fmt(c)} de cupo` : ''} · <b>${fmt(t.sEnt)}</b> spare</span>` : '';
  return `<button class="item" data-open="${esc(m.codigo)}">
    <div class="row"><span class="code grow">${esc(m.codigo)}</span>${cupoPill(m.codigo, sub)}${m.activo === false ? '<span class="pill x">Fuera de BOM</span>' : t.pPend <= 0 && t.pTot > 0 ? '<span class="pill ok">Proyecto completo</span>' : ''}</div>
    <div class="desc">${esc(m.descripcion)}</div>
    <div class="meta"><span class="grow">Proyecto <b>${fmt(t.pAll)}</b> / ${fmt(t.pTot)} ${esc(m.unidad || '')}</span><span>pend. <b>${fmt(t.pPend)}</b></span></div>
    <div class="bar ${t.pAll > t.pTot ? 'over' : ''}"><i style="width:${pPct}%"></i></div>
    <div class="meta"><span class="grow">Spare <b>${fmt(t.sAll)}</b> / ${fmt(t.sTot)}</span><span>pend. <b>${fmt(t.sPend)}</b></span></div>
    <div class="bar spare ${t.sAll > t.sTot ? 'over' : ''}"><i style="width:${sPct}%"></i></div>
    ${subLine ? `<div class="meta">${subLine}</div>` : ''}
  </button>`;
}

/* --- Vales --- */
async function loadVales() {
  const fx = fixedSub();
  S.vales = await API.vales({ subId: fx || S.valFiltro || undefined });
  S.aprobar = can.aprobar() ? await API.porAprobar() : [];
}
async function renderVales() {
  const fx = fixedSub();
  view().innerHTML = `
    <div id="val-top"></div>
    ${fx ? '' : `<div id="val-subs">${subChips(S.valFiltro, { all: true })}</div>`}
    <div id="val-list" class="list"><div class="spin">Cargando…</div></div>`;
  if (!fx) $('#val-subs').onclick = async (e) => {
    const b = e.target.closest('[data-sub]'); if (!b) return;
    S.valFiltro = Number(b.dataset.sub); $('#val-subs').innerHTML = subChips(S.valFiltro, { all: true });
    await loadVales(); renderValesList();
  };
  try { await loadVales(); } catch (e) { S.vales = []; toast('Sin conexión: no se pueden cargar los vales.'); }
  renderValesList();
}
function lineaTxt(l) {
  const m = S.matMap.get(l.codigo);
  return `<b>${fmt(l.cantidad)} ${esc(m?.unidad || '')}</b> <span class="pill ${l.tipo === 'spare' ? 's' : 'p'}">${l.tipo === 'spare' ? 'Spare' : 'Proyecto'}</span> <span class="mono">${esc(l.codigo)}</span>`;
}
function renderValesList() {
  const top = $('#val-top'), box = $('#val-list'); if (!box) return;
  let html = '';
  const q = cola();
  if (q.length) {
    html += `<h2>Pendientes de envío (${q.length})</h2><div class="list">` + q.map((it) => `
      <div class="mov ${it.error ? 'err' : 'pend'}">
        <div class="top-line"><span>${fday(it.p.fecha)} · ${it.p.lineas.length} líneas</span><b>${esc(subName(it.p.subcontrata_id))}</b></div>
        <div class="small">${it.p.clase === 'devolucion' ? 'Devolución' : 'Entrega'} · Recibe: ${esc(it.p.receptor || '—')}</div>
        ${it.error ? `<div class="small" style="color:var(--bad)">Rechazado: ${esc(it.error)}</div>
          <div class="row" style="justify-content:flex-end;margin-top:6px"><button class="btn sm ghost" data-qretry="${it.p.id}">Reintentar</button><button class="btn sm bad" data-qdel="${it.p.id}">Descartar</button></div>`
          : `<div class="small muted">Se enviará automáticamente al recuperar la conexión.</div>`}
      </div>`).join('') + `</div>`;
  }
  if (can.aprobar() && S.aprobar.length) {
    html += `<h2>Excesos por aprobar (${S.aprobar.length})</h2><div class="list">` + S.aprobar.map((l) => `
      <div class="mov warnb">
        <div class="top-line"><span>${esc(fdate(l.creado))}</span><b>${esc(subName(l.subcontrata_id))}</b></div>
        <div style="margin-top:4px">${lineaTxt(l)}</div>
        <div class="muted small">${esc(S.matMap.get(l.codigo)?.descripcion || '')}</div>
        ${l.observaciones ? `<div class="small">Motivo: “${esc(l.observaciones)}”</div>` : ''}
        <div class="row" style="justify-content:flex-end;margin-top:6px">
          <button class="btn sm ghost" data-lanular="${l.id}">Anular</button><button class="btn sm" data-aprobar="${l.id}">Aprobar</button></div>
      </div>`).join('') + `</div>`;
  }
  top.innerHTML = html;
  if (!S.vales.length) { box.innerHTML = `<div class="empty">No hay vales registrados.</div>`; return; }
  box.innerHTML = S.vales.map((v) => {
    const pend = (v.lineas || []).filter((l) => l.requiere_aprobacion && !l.aprobado_fecha && !l.anulada).length;
    return `<button class="item ${v.anulado ? 'anul' : ''}" data-vale="${v.id}">
      <div class="row"><span class="code grow">${esc(valeNum(v))}</span>
        ${v.clase === 'devolucion' ? '<span class="pill d">Devolución</span>' : ''}${v.anulado ? '<span class="pill x">Anulado</span>' : ''}${pend ? `<span class="pill w">${pend} por aprobar</span>` : ''}</div>
      <div class="meta"><span>${fday(v.fecha)}</span><b>${esc(subName(v.subcontrata_id))}</b><span>${(v.lineas || []).length} líneas</span></div>
      <div class="desc">Entrega: ${esc(v.entregado_por || '—')} · Recibe: ${esc(v.receptor || '—')}</div>
    </button>`;
  }).join('') + (S.vales.length >= 200 ? `<div class="empty">Se muestran los 200 últimos. El reporte Excel incluye todos.</div>` : '');
}

/* --- Más --- */
let installEvt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; if (S.tab === 'mas') renderMas(); });

function renderMas() {
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const nMovs = sum([...S.res.values()].map((r) => r.movs));
  view().innerHTML = `
    <h2>Reporte</h2>
    <button class="btn block" id="btn-xls">⬇ Descargar reporte Excel</button>
    <p class="muted small">Resumen por código con cupos, detalle por subcontrata, vales y todas las líneas (${fmt(nMovs)} líneas activas).</p>

    <h2>Proyecto</h2>
    <div class="card kv">
      <span>Proyecto</span><b>${esc(S.ajustes.proyecto || CFG.PROYECTO || '')}</b>
      <span>Revisión BOM</span><b>${esc(S.ajustes.bom_revision || '—')}</b>
      <span>Importado</span><b>${esc(S.ajustes.bom_fecha || '—')}</b>
      <span>Códigos activos</span><b>${S.mats.filter((m) => m.activo !== false).length}</b>
      <span>Usuario</span><b>${esc(S.me?.email || '')}</b>
      <span>Rol</span><b>${esc(ROLES[S.me?.rol] || 'Sin rol')}${S.me?.rol === 'subcontrata' ? ' · ' + esc(subName(S.me.subcontrata_id)) : ''}</b>
      <span>Modo</span><b>${DEMO ? 'Demo local' : 'En la nube'}</b>
      ${S.offlineData ? `<span>Datos</span><b style="color:var(--warn)">Sin conexión (del ${fdate(S.offlineData)})</b>` : ''}
    </div>

    <h2>Tus datos en este móvil</h2>
    <div class="field"><label>Tu nombre (aparece como “Entrega” en los vales)</label><input id="my-name" value="${esc(LS.get('nombre', '') || S.me?.nombre || '')}" placeholder="Nombre y apellido"></div>

    ${can.admin() ? `
      <h2>Reparto por subcontrata</h2>
      <p class="muted small">Indica cuántos trackers de cada tipo monta cada subcontrata. El cupo de cada código se calcula con las unidades por tracker del BOM (columnas W–AB).</p>
      <div id="reparto"></div>

      <h2>Usuarios</h2>
      <p class="muted small">${DEMO ? 'En la demo puedes cambiar tu propio rol para probar cómo lo ve cada usuario.' : 'Para añadir a alguien, créalo en Supabase → Authentication → Add user. Aparecerá aquí con rol “Consulta”.'}</p>
      <div id="usuarios" class="list"><div class="spin">Cargando…</div></div>

      <h2>Importar BOM</h2>
      <p class="muted small">Excel del BOM (hoja <b>BOM - Piezas Totales</b>). Se toman las columnas I, J, O, AC, AD, AE y las unidades por tracker W–AB. Los kits se excluyen y los códigos repetidos se suman. Las entregas ya registradas se conservan.</p>
      <input type="file" id="bom-file" accept=".xlsx,.xlsm,.xls">
      <div id="bom-prev"></div>` : ''}

    <h2>Instalar en el móvil</h2>
    ${standalone ? '<p class="muted small">La app ya está instalada.</p>'
      : installEvt ? '<button class="btn ghost block" id="btn-inst">Instalar app</button>'
      : ios ? '<p class="muted small">En iPhone: abre esta página en Safari → botón Compartir → “Añadir a pantalla de inicio”.</p>'
      : '<p class="muted small">En Android: menú ⋮ del navegador → “Instalar aplicación” o “Añadir a pantalla de inicio”.</p>'}

    ${DEMO ? `<h2>Demo</h2>
      ${S.me?.rol !== 'admin' ? `<button class="btn ghost block" id="btn-demo-admin">Volver a rol Administrador</button>` : ''}
      <label class="toggle"><input type="checkbox" id="demo-off" ${LS.get('demo_offline', false) ? 'checked' : ''}> Simular móvil sin cobertura</label>
      <button class="btn bad block" id="btn-reset" style="margin-top:10px">Borrar datos de la demo</button>`
      : `<h2>Sesión</h2><button class="btn ghost block" id="btn-out">Cerrar sesión</button>`}
    <p class="muted small" style="text-align:center;margin-top:24px">v${VERSION}</p>`;

  $('#btn-xls').onclick = exportExcel;
  $('#my-name').onchange = (e) => LS.set('nombre', e.target.value.trim());
  if ($('#btn-inst')) $('#btn-inst').onclick = async () => { installEvt.prompt(); installEvt = null; };
  if ($('#btn-out')) $('#btn-out').onclick = async () => { await API.signOut(); LS.set('cache', null); location.reload(); };
  if ($('#btn-reset')) $('#btn-reset').onclick = () => {
    if (confirm('¿Borrar todos los datos de la demo en este dispositivo?')) { ['demo_db', 'cola', 'vale', 'cache', 'demo_rol', 'demo_offline'].forEach((k) => localStorage.removeItem('ent_' + k)); location.reload(); }
  };
  if ($('#btn-demo-admin')) $('#btn-demo-admin').onclick = async () => { LS.set('demo_rol', 'admin'); await start(); };
  if ($('#demo-off')) $('#demo-off').onchange = (e) => { LS.set('demo_offline', e.target.checked); setConn(e.target.checked ? 'off' : 'ok'); if (!e.target.checked) flushCola().then(avisarEnviados); };
  if ($('#bom-file')) $('#bom-file').onchange = onBomFile;
  if (can.admin()) { renderReparto(); renderUsuarios(); }
}

function renderReparto() {
  const box = $('#reparto'); if (!box) return;
  if (!S.tipos.length) { box.innerHTML = `<div class="alert">Vuelve a importar el BOM para cargar los tipos de tracker.</div>`; return; }
  box.innerHTML = `<div class="list">${S.tipos.map((t) => `
    <div class="card rep" data-tipo="${esc(t.nombre)}">
      <div class="row"><b class="grow">${esc(t.nombre)}</b><span class="tot small"></span></div>
      <div class="rep-grid" style="grid-template-columns:repeat(${S.subs.length},1fr)">
        ${S.subs.map((s) => `<label><span>${esc(s.nombre)}</span><input inputmode="numeric" data-rs="${s.id}" value="${S.reparto.get(s.id)?.[t.nombre] ?? ''}" placeholder="0"></label>`).join('')}
      </div>
    </div>`).join('')}</div>
    <button class="btn block" id="rep-ok" style="margin-top:10px">Guardar reparto</button>`;
  const upd = () => {
    for (const tr of $$('[data-tipo]', box)) {
      const t = S.tipos.find((x) => x.nombre === tr.dataset.tipo);
      const a = sum($$('input', tr).map((i) => parseNum(i.value)));
      const td = $('.tot', tr); td.textContent = `asignados ${fmt(a)} / ${fmt(t.total)}`;
      td.style.color = a > t.total ? 'var(--bad)' : a === Number(t.total) ? 'var(--ok)' : '';
    }
  };
  box.oninput = upd; upd();
  $('#rep-ok').onclick = async () => {
    const rows = [];
    for (const tr of $$('[data-tipo]', box)) for (const i of $$('input', tr)) rows.push({ subcontrata_id: Number(i.dataset.rs), tipo: tr.dataset.tipo, trackers: parseNum(i.value) });
    try { await API.guardarReparto(rows); await loadReparto(); saveCache(); toast('Reparto guardado'); upd(); }
    catch (e) { toast('Error: ' + e.message); }
  };
}

async function renderUsuarios() {
  const box = $('#usuarios'); if (!box) return;
  let us;
  try { us = await API.usuarios(); } catch (e) { box.innerHTML = `<div class="alert bad">${esc(e.message)}</div>`; return; }
  box.innerHTML = us.map((u) => `
    <div class="card usr" data-email="${esc(u.email)}">
      <div class="mono small"><b>${esc(u.email)}</b></div>
      <div class="row wrap" style="margin-top:6px">
        <input class="grow" data-f="nombre" value="${esc(u.nombre || '')}" placeholder="Nombre">
        <select data-f="rol">${Object.entries(ROLES).map(([k, v]) => `<option value="${k}" ${u.rol === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
        <select data-f="subcontrata_id" ${u.rol !== 'subcontrata' ? 'hidden' : ''}>${S.subs.map((s) => `<option value="${s.id}" ${u.subcontrata_id === s.id ? 'selected' : ''}>${esc(s.nombre)}</option>`).join('')}</select>
        <button class="btn sm" data-usave>Guardar</button>
      </div>
    </div>`).join('') || '<div class="empty">Sin usuarios.</div>';
  box.onchange = (e) => { if (e.target.dataset.f === 'rol') $('[data-f="subcontrata_id"]', e.target.closest('.usr')).hidden = e.target.value !== 'subcontrata'; };
  box.onclick = async (e) => {
    if (!e.target.matches('[data-usave]')) return;
    const c = e.target.closest('.usr'); const g = (f) => $(`[data-f="${f}"]`, c).value;
    const u = { email: c.dataset.email, nombre: g('nombre').trim(), rol: g('rol'), subcontrata_id: g('rol') === 'subcontrata' ? Number(g('subcontrata_id')) : null };
    try {
      await API.guardarUsuario(u); toast('Usuario guardado');
      if (u.email === S.me.email) await start(); // cambia lo que ve este mismo usuario
    } catch (er) { toast('Error: ' + er.message); }
  };
}

/* ------------------------------------------------------------------ */
/* Hoja inferior: ficha de material, vale en curso, vale registrado    */
/* ------------------------------------------------------------------ */
let sheet = null; // { kind: 'item', codigo } | { kind: 'draft' } | { kind: 'vale', id, data }
const form = { tipo: 'proyecto', cantidad: '', obs: '' };

function openSheet(s) {
  sheet = s;
  if (s.kind === 'item') {
    Object.assign(form, { tipo: 'proyecto', cantidad: '', obs: '' });
    const t = matTotals(s.codigo);
    if (S.draft.clase === 'entrega' && t.pPend <= 0 && t.sPend > 0) form.tipo = 'spare';
  }
  $('#sheet-bg').hidden = false; $('#sheet').hidden = false; $('#toast').hidden = true;
  document.body.style.overflow = 'hidden';
  renderSheet();
}
function closeSheet() {
  sheet = null;
  $('#sheet-bg').hidden = true; $('#sheet').hidden = true;
  document.body.style.overflow = '';
}
function renderSheet() {
  if (!sheet) return;
  const focused = document.activeElement?.id;
  if (sheet.kind === 'item') renderItemSheet();
  else if (sheet.kind === 'draft') renderDraftSheet();
  else if (sheet.kind === 'vale') renderValeSheet();
  if (focused && $('#' + focused, $('#sheet'))) $('#' + focused, $('#sheet')).focus();
}
const sheetHead = (title, sub) => `<div class="grab"></div><button class="close" data-close aria-label="Cerrar">×</button>
  <h3>${esc(title)}</h3>${sub ? `<div class="muted small" style="word-break:break-word;padding-right:24px">${esc(sub)}</div>` : ''}`;

/* --- Ficha de material --- */
function renderItemSheet() {
  const m = S.matMap.get(sheet.codigo); if (!m) return closeSheet();
  const t = matTotals(m.codigo);
  const u = esc(m.unidad || '');
  const hayCupo = S.subs.some((s) => cupo(m.codigo, s.id) != null);
  const d = S.draft;
  const dev = d.clase === 'devolucion';
  $('#sheet').innerHTML = sheetHead(m.codigo, m.descripcion) + `
    ${m.activo === false ? '<div class="alert bad">Este código ya no está en la revisión actual del BOM.</div>' : ''}
    <div class="stat2">
      <div class="card p"><div class="t">Proyecto</div>
        <div class="kv small"><span>Total</span><b>${fmt(t.pTot)} ${u}</b><span>Entregado</span><b>${fmt(t.pAll)}</b><span>Pendiente</span><b style="color:${t.pPend < 0 ? 'var(--bad)' : 'inherit'}">${fmt(t.pPend)}</b></div></div>
      <div class="card s"><div class="t">Spare</div>
        <div class="kv small"><span>Total</span><b>${fmt(t.sTot)} ${u}</b><span>Entregado</span><b>${fmt(t.sAll)}</b><span>Pendiente</span><b style="color:${t.sPend < 0 ? 'var(--bad)' : 'inherit'}">${fmt(t.sPend)}</b></div>
        <div class="muted" style="font-size:11px;margin-top:4px">Cliente ${fmt(m.spare_cliente)} · Axial ${fmt(m.spare_axial)}</div></div>
    </div>
    <table class="mini"><thead><tr><th>Subcontrata</th><th>Proyecto</th>${hayCupo ? '<th>Cupo</th>' : ''}<th>Spare</th></tr></thead><tbody>
      ${S.subs.filter((s) => !fixedSub() || s.id === fixedSub()).map((s) => {
        const c = cupo(m.codigo, s.id); const p = t.r.proyecto[s.id] || 0;
        return `<tr><td>${esc(s.nombre)}</td><td style="color:${c != null && p > c ? 'var(--bad)' : 'inherit'}">${fmt(p)}</td>${hayCupo ? `<td>${c == null ? '—' : fmt(c)}</td>` : ''}<td>${fmt(t.r.spare[s.id] || 0)}</td></tr>`;
      }).join('')}
    </tbody></table>
    ${can.registrar() ? `
    <h2>${dev ? 'Añadir a la devolución' : 'Añadir al vale'}</h2>
    <div class="field"><label>Subcontrata</label><div id="f-subs">${subChips(d.sub, { attr: 'data-fsub', disabled: d.lineas.length > 0 })}</div></div>
    <div class="field"><label>Tipo de material</label>
      <div class="seg"><button class="p ${form.tipo === 'proyecto' ? 'on' : ''}" data-tipo="proyecto">Proyecto</button><button class="s ${form.tipo === 'spare' ? 'on' : ''}" data-tipo="spare">Spare</button></div></div>
    <div class="field"><label>Cantidad${dev ? ' devuelta' : ''} (${u || 'ud'})</label>
      <div class="qty"><button data-step="-1">−</button><input id="f-cant" inputmode="decimal" placeholder="0" value="${esc(form.cantidad)}"><button data-step="1">+</button></div>
      <div class="row wrap" style="margin-top:6px">
        ${[10, 50, 100].map((n) => `<button class="btn sm ghost" data-add="${n}">+${n}</button>`).join('')}
        ${dev ? '' : '<button class="btn sm ghost" data-all>Todo lo pendiente</button>'}
      </div></div>
    <div class="field"><label>Observaciones de la línea</label><textarea id="f-obs" rows="2" placeholder="Opcional (obligatorio si se excede)">${esc(form.obs)}</textarea></div>
    <div id="f-warn"></div>
    <button class="btn block" id="f-ok" style="margin-top:14px">Añadir</button>` : ''}`;

  if (!can.registrar()) return;
  const sh = $('#sheet');
  $('#f-subs').onclick = (e) => { const b = e.target.closest('[data-fsub]'); if (!b || b.disabled) return; S.draft.sub = Number(b.dataset.fsub); saveDraft(); renderSheet(); };
  $$('[data-tipo]', sh).forEach((b) => (b.onclick = () => { form.tipo = b.dataset.tipo; renderSheet(); }));
  const cant = $('#f-cant');
  const setQ = (v) => { form.cantidad = String(Math.max(0, round3(v))); cant.value = form.cantidad; updateWarn(); };
  cant.oninput = () => { form.cantidad = cant.value; updateWarn(); };
  $$('[data-step]', sh).forEach((b) => (b.onclick = () => setQ(parseNum(form.cantidad) + Number(b.dataset.step))));
  $$('[data-add]', sh).forEach((b) => (b.onclick = () => setQ(parseNum(form.cantidad) + Number(b.dataset.add))));
  if ($('[data-all]', sh)) $('[data-all]', sh).onclick = () => { const p = planLinea(sheet.codigo, form.tipo, 0); setQ(form.tipo === 'spare' ? p.sPend : p.pPend); };
  $('#f-obs').oninput = (e) => { form.obs = e.target.value; updateWarn(); };
  $('#f-ok').onclick = () => { const p = planLinea(sheet.codigo, form.tipo, parseNum(form.cantidad)); if (!p.error && !(p.exceso && !form.obs.trim())) addLineas([{ codigo: sheet.codigo, tipo: form.tipo, cantidad: p.q }], p.exceso); };
  updateWarn();
}

// Comprueba una línea contra lo pendiente, el cupo y lo que ya hay en el vale en curso
function planLinea(codigo, tipo, cantidad) {
  const d = S.draft, sub = d.sub;
  const t = matTotals(codigo);
  const enVale = (tp) => sum(d.lineas.filter((l) => l.codigo === codigo && l.tipo === tp).map((l) => l.cantidad));
  const sign = d.clase === 'devolucion' ? -1 : 1;
  const pPend = round3(t.pPend - sign * enVale('proyecto')), sPend = round3(t.sPend - sign * enVale('spare'));
  const q = round3(cantidad);
  const out = { q, pPend, sPend, warns: [], exceso: false, split: null, error: '' };
  if (!sub) out.error = 'Elige la subcontrata.';
  else if (!(q > 0)) out.error = 'Indica una cantidad mayor que 0.';
  if (out.error) return out;

  if (d.clase === 'devolucion') {
    const neto = round3((t.r[tipo][sub] || 0) - enVale(tipo));
    if (q > neto) out.error = `${subName(sub)} solo tiene ${fmt(Math.max(0, neto))} de ${tipo} entregado.`;
    return out;
  }
  if (tipo === 'proyecto') {
    if (q > pPend) {
      const exceso = round3(q - Math.max(0, pPend));
      out.warns.push(`Excede en ${fmt(exceso)} la cantidad de proyecto pendiente (${fmt(Math.max(0, pPend))}).`);
      if (pPend > 0 && sPend >= exceso) out.split = [{ codigo, tipo: 'proyecto', cantidad: pPend }, { codigo, tipo: 'spare', cantidad: exceso }];
      out.exceso = true;
    }
    const c = cupo(codigo, sub);
    if (c != null) {
      const ya = round3((t.r.proyecto[sub] || 0) + enVale('proyecto'));
      if (ya + q > c) { out.warns.push(`Supera el cupo de ${subName(sub)}: lleva ${fmt(ya)} de ${fmt(c)}.`); out.exceso = true; }
    }
  } else if (q > sPend) {
    out.warns.push(`Excede en ${fmt(round3(q - Math.max(0, sPend)))} el spare disponible (${fmt(Math.max(0, sPend))}).`);
    out.exceso = true;
  }
  return out;
}

function updateWarn() {
  const w = $('#f-warn'); if (!w) return;
  const p = planLinea(sheet.codigo, form.tipo, parseNum(form.cantidad));
  const needObs = p.exceso && !form.obs.trim();
  w.innerHTML = p.warns.length
    ? `<div class="alert ${p.split ? '' : 'bad'}">${p.warns.map(esc).join('<br>')}
       ${needObs ? '<br><b>Para añadirlo igualmente escribe el motivo en Observaciones. Quedará pendiente de aprobación del jefe de obra.</b>' : ''}
       ${p.split ? `<div style="margin-top:8px"><button class="btn sm" id="f-split">Añadir ${fmt(p.split[0].cantidad)} proyecto + ${fmt(p.split[1].cantidad)} spare</button></div>` : ''}</div>`
    : '';
  if ($('#f-split')) $('#f-split').onclick = () => {
    // El reparto en spare evita el exceso global, pero el cupo de la subcontrata se sigue comprobando
    const cupoExc = planLinea(sheet.codigo, 'proyecto', p.split[0].cantidad).exceso;
    if (cupoExc && !form.obs.trim()) return toast('Supera el cupo de la subcontrata: escribe el motivo en Observaciones.');
    addLineas(p.split, cupoExc);
  };
  const ok = $('#f-ok');
  ok.disabled = !!p.error || needObs;
  ok.textContent = p.error || `${p.exceso ? 'Añadir igualmente' : 'Añadir'} ${fmt(p.q)} ${S.matMap.get(sheet.codigo)?.unidad || ''} al ${S.draft.clase === 'devolucion' ? 'vale de devolución' : 'vale'}`;
  ok.className = 'btn block' + (p.exceso ? ' warn' : '');
}

function addLineas(lineas, exceso) {
  for (const l of lineas) {
    S.draft.lineas.push({ ...l, cantidad: round3(l.cantidad), observaciones: form.obs.trim() || null, requiere_aprobacion: !!exceso && (l.tipo === lineas[0].tipo || lineas.length === 1) });
  }
  saveDraft();
  LS.set('recientes', [lineas[0].codigo, ...LS.get('recientes', []).filter((c) => c !== lineas[0].codigo)].slice(0, 8));
  closeSheet();
  renderEntregarResults();
  toast(`Añadido al vale (${S.draft.lineas.length} línea${S.draft.lineas.length > 1 ? 's' : ''})`, { label: 'Ver vale', fn: () => openSheet({ kind: 'draft' }) });
}

/* --- Vale en curso --- */
function renderDraftSheet() {
  const d = S.draft;
  if (!d.lineas.length) return closeSheet();
  const dev = d.clase === 'devolucion';
  const f = (sheet.f ||= { fecha: today(), entrega: LS.get('nombre', '') || S.me?.nombre || '', recibe: LS.get('receptor_' + d.sub, ''), obs: '' });
  $('#sheet').innerHTML = sheetHead(dev ? 'Vale de devolución' : 'Vale de entrega', subName(d.sub)) + `
    <div class="list">${d.lineas.map((l, i) => {
      const m = S.matMap.get(l.codigo);
      return `<div class="mov ${l.requiere_aprobacion ? 'warnb' : ''}">
        <div class="row">${lineaTxt(l)}<span class="grow"></span><button class="close-sm" data-rm="${i}" aria-label="Quitar">×</button></div>
        <div class="muted small">${esc(m?.descripcion || '')}</div>
        ${l.requiere_aprobacion ? `<div class="small" style="color:var(--warn)">Exceso · requiere aprobación${l.observaciones ? ': “' + esc(l.observaciones) + '”' : ''}</div>` : l.observaciones ? `<div class="small">“${esc(l.observaciones)}”</div>` : ''}
      </div>`;
    }).join('')}</div>
    <div class="field"><label>Fecha</label><input type="date" id="d-fecha" value="${esc(f.fecha)}"></div>
    <div class="field"><label>${dev ? 'Devuelve (persona de la subcontrata)' : 'Entrega (almacén)'}</label><input id="d-entrega" value="${esc(dev ? f.recibe : f.entrega)}" placeholder="Nombre"></div>
    <div class="field"><label>${dev ? 'Recibe (almacén)' : 'Recibe (persona de la subcontrata)'}</label><input id="d-recibe" value="${esc(dev ? f.entrega : f.recibe)}" placeholder="Nombre"></div>
    <div class="field"><label>Observaciones del vale</label><textarea id="d-obs" rows="2" placeholder="Opcional">${esc(f.obs)}</textarea></div>
    <div id="d-err"></div>
    <button class="btn block" id="d-ok" style="margin-top:14px">Confirmar ${dev ? 'devolución' : 'vale'} (${d.lineas.length} líneas)</button>
    <button class="btn ghost block" id="d-clear" style="margin-top:8px">Vaciar vale</button>`;
  const sh = $('#sheet');
  // En una devolución la subcontrata entrega y el almacén recibe
  const bind = (id, key) => ($('#' + id).oninput = (e) => { f[key] = e.target.value; });
  bind('d-fecha', 'fecha'); bind('d-obs', 'obs');
  bind('d-entrega', dev ? 'recibe' : 'entrega'); bind('d-recibe', dev ? 'entrega' : 'recibe');
  $$('[data-rm]', sh).forEach((b) => (b.onclick = () => { d.lineas.splice(Number(b.dataset.rm), 1); saveDraft(); d.lineas.length ? renderSheet() : closeSheet(); }));
  $('#d-clear').onclick = () => { if (confirm('¿Vaciar el vale?')) { d.lineas = []; saveDraft(); closeSheet(); } };
  $('#d-ok').onclick = confirmarVale;
}

async function confirmarVale() {
  const d = S.draft, f = sheet.f, dev = d.clase === 'devolucion';
  const entrega = (dev ? f.recibe : f.entrega).trim(), recibe = (dev ? f.entrega : f.recibe).trim();
  if (!f.fecha || !entrega || !recibe) { $('#d-err').innerHTML = `<div class="alert bad">Completa la fecha, quién entrega y quién recibe.</div>`; return; }
  const p = {
    id: uuid(), fecha: f.fecha, subcontrata_id: d.sub, clase: d.clase,
    entregado_por: entrega, receptor: recibe, observaciones: f.obs.trim() || null,
    lineas: d.lineas.map((l) => ({ codigo: l.codigo, tipo: l.tipo, cantidad: l.cantidad, observaciones: l.observaciones, requiere_aprobacion: !!l.requiere_aprobacion })),
  };
  if (!dev) { LS.set('nombre', entrega); LS.set('receptor_' + d.sub, recibe); }
  else LS.set('receptor_' + d.sub, entrega);
  setCola([...cola(), { p, creado: new Date().toISOString() }]);
  S.draft = { sub: d.sub, clase: d.clase, lineas: [] }; saveDraft();
  closeSheet();
  const sent = await flushCola();
  rerender();
  const mio = sent.find((x) => x.id === p.id);
  if (mio) toast(`${valeNum(mio)} registrado · ${subName(p.subcontrata_id)}`, { label: 'Ver vale', fn: () => abrirVale(p.id) });
  else if (cola().find((x) => x.p.id === p.id)?.error) toast('El servidor rechazó el vale. Revísalo en la pestaña Vales.');
  else toast('Sin conexión: el vale queda guardado y se enviará al recuperar cobertura.', { label: 'Imprimir', fn: () => imprimirVale({ ...p, lineas: p.lineas }) });
}
function avisarEnviados(sent) { if (sent?.length) toast(`${sent.length} vale(s) pendientes enviados`); }

/* --- Vale registrado --- */
async function abrirVale(id) {
  try { const v = await API.vale(id); if (v) openSheet({ kind: 'vale', id, data: v }); }
  catch (e) { toast('Error: ' + e.message); }
}
function renderValeSheet() {
  const v = sheet.data;
  const pendientes = (l) => l.requiere_aprobacion && !l.aprobado_fecha && !l.anulada;
  $('#sheet').innerHTML = sheetHead(valeNum(v), `${v.clase === 'devolucion' ? 'Devolución' : 'Entrega'} · ${subName(v.subcontrata_id)}`) + `
    ${v.anulado ? `<div class="alert bad">Vale anulado por ${esc(v.anulado_por || '')}: ${esc(v.anulado_motivo || '')}</div>` : ''}
    <div class="card kv small" style="margin-top:10px">
      <span>Fecha</span><b>${fday(v.fecha)}</b>
      <span>${v.clase === 'devolucion' ? 'Devuelve' : 'Entrega'}</span><b>${esc(v.entregado_por || '—')}</b>
      <span>Recibe</span><b>${esc(v.receptor || '—')}</b>
      <span>Registrado</span><b>${fdate(v.creado)}</b>
      ${v.observaciones ? `<span>Observaciones</span><b>${esc(v.observaciones)}</b>` : ''}
    </div>
    <div class="list">${(v.lineas || []).sort((a, b) => a.id - b.id).map((l) => `
      <div class="mov ${l.anulada ? 'anul' : pendientes(l) ? 'warnb' : ''}">
        <div>${lineaTxt(l)}</div>
        <div class="muted small">${esc(S.matMap.get(l.codigo)?.descripcion || '')}</div>
        ${l.observaciones ? `<div class="small">“${esc(l.observaciones)}”</div>` : ''}
        ${l.anulada ? `<div class="small" style="color:var(--bad)">Anulada por ${esc(l.anulada_por || '')}: ${esc(l.anulada_motivo || '')}</div>` : ''}
        ${pendientes(l) ? '<div class="small" style="color:var(--warn)">Exceso pendiente de aprobación</div>' : ''}
        ${l.aprobado_fecha ? `<div class="small" style="color:var(--ok)">Exceso aprobado por ${esc(l.aprobado_por || '')}</div>` : ''}
        ${!l.anulada && !v.anulado ? `<div class="row" style="justify-content:flex-end;margin-top:4px">
          ${can.aprobar() && pendientes(l) ? `<button class="btn sm" data-aprobar="${l.id}">Aprobar</button>` : ''}
          ${can.anular() ? `<button class="btn sm ghost" data-lanular="${l.id}">Anular línea</button>` : ''}</div>` : ''}
      </div>`).join('')}</div>
    <button class="btn block" id="v-print" style="margin-top:14px">🖨 Imprimir / guardar PDF</button>
    ${can.anular() && !v.anulado ? `<button class="btn ghost block" id="v-anular" style="margin-top:8px">Anular vale completo</button>` : ''}`;
  $('#v-print').onclick = () => imprimirVale(v);
  if ($('#v-anular')) $('#v-anular').onclick = async () => {
    const motivo = prompt('Motivo de la anulación del vale:'); if (motivo == null) return;
    if (!motivo.trim()) return toast('Hay que indicar un motivo.');
    try { await API.anularVale(v.id, motivo.trim()); await refrescarTrasCambio(v.id); toast('Vale anulado'); }
    catch (e) { toast('Error: ' + e.message); }
  };
}

async function refrescarTrasCambio(valeId) {
  await loadResumen();
  if (S.tab === 'vales') await loadVales();
  if (sheet?.kind === 'vale' && valeId) sheet.data = await API.vale(valeId);
  rerender();
}
async function anularLinea(id) {
  const motivo = prompt('Motivo de la anulación de la línea:'); if (motivo == null) return;
  if (!motivo.trim()) return toast('Hay que indicar un motivo.');
  try { await API.anularLinea(id, motivo.trim()); await refrescarTrasCambio(sheet?.kind === 'vale' ? sheet.id : null); toast('Línea anulada'); }
  catch (e) { toast('Error: ' + e.message); }
}
async function aprobarLinea(id) {
  try { await API.aprobarLinea(id); await refrescarTrasCambio(sheet?.kind === 'vale' ? sheet.id : null); toast('Exceso aprobado'); }
  catch (e) { toast('Error: ' + e.message); }
}

/* --- Impresión del vale (fecha, quién entrega, quién recibe) --- */
function imprimirVale(v) {
  const dev = v.clase === 'devolucion';
  const lineas = (v.lineas || []).filter((l) => !l.anulada);
  $('#print-area').innerHTML = `
    <div class="pv">
      <div class="pv-head">
        <div><div class="pv-title">${dev ? 'VALE DE DEVOLUCIÓN' : 'VALE DE ENTREGA'} DE MATERIAL</div>
          <div>${esc(S.ajustes.proyecto || CFG.PROYECTO || '')}</div></div>
        <div class="pv-num">${esc(valeNum(v))}${v.anulado ? '<div class="pv-anul">ANULADO</div>' : ''}</div>
      </div>
      <table class="pv-info">
        <tr><th>Fecha</th><td>${fday(v.fecha)}</td><th>Subcontrata</th><td>${esc(subName(v.subcontrata_id))}</td></tr>
        <tr><th>${dev ? 'Devuelve' : 'Entrega'}</th><td>${esc(v.entregado_por || '')}</td><th>Recibe</th><td>${esc(v.receptor || '')}</td></tr>
      </table>
      <table class="pv-lines">
        <thead><tr><th>#</th><th>Código</th><th>Descripción</th><th>Tipo</th><th>Cantidad</th><th>Ud</th></tr></thead>
        <tbody>${lineas.map((l, i) => {
          const m = S.matMap.get(l.codigo);
          return `<tr><td>${i + 1}</td><td>${esc(l.codigo)}</td><td>${esc(m?.descripcion || '')}${l.observaciones ? `<div class="pv-obs">${esc(l.observaciones)}</div>` : ''}</td><td>${l.tipo === 'spare' ? 'Spare' : 'Proyecto'}</td><td class="n">${fmt(l.cantidad)}</td><td>${esc(m?.unidad || '')}</td></tr>`;
        }).join('')}</tbody>
      </table>
      ${v.observaciones ? `<p><b>Observaciones:</b> ${esc(v.observaciones)}</p>` : ''}
    </div>`;
  window.print();
}

/* ------------------------------------------------------------------ */
/* Importación del BOM                                                 */
/* ------------------------------------------------------------------ */
const COL = { E: 4, I: 8, J: 9, O: 14, W: 22, AB: 27, AC: 28, AD: 29, AE: 30 };
const normTipo = (s) => norm(s).replace(/\s+/g, '');

function parseBOM(buf, fileName) {
  const wb = XLSX.read(buf, { type: 'array' });
  const hoja = wb.SheetNames.find((n) => /piezas\s*totales/i.test(n)) || wb.SheetNames.find((n) => /^bom/i.test(n));
  if (!hoja) throw new Error('No se encuentra la hoja "BOM - Piezas Totales".');
  const rowsOf = (ws) => { const ref = XLSX.utils.decode_range(ws['!ref']); ref.s.c = 0; ref.s.r = 0; return XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, range: ref }); };
  const rows = rowsOf(wb.Sheets[hoja]);
  let h = rows.findIndex((r, i) => i < 15 && r && /c[oó]digo\s*proyectos/i.test(String(r[COL.I] ?? '')));
  if (h < 0) h = 0;
  const head = rows[h] || [];

  // Tipos de tracker: cabeceras W..AB y su total en la hoja "Cantidad Trackers" (columna C)
  const tiposNombres = [];
  for (let c = COL.W; c <= COL.AB; c++) if (String(head[c] ?? '').trim()) tiposNombres.push([c, String(head[c]).trim()]);
  const hojaT = wb.SheetNames.find((n) => /cantidad\s*trackers/i.test(n));
  const totT = new Map();
  if (hojaT) for (const r of rowsOf(wb.Sheets[hojaT])) if (r && r[0] != null && typeof r[2] === 'number') { const k = normTipo(r[0]); if (!totT.has(k)) totT.set(k, r[2]); }
  const tipos = tiposNombres.map(([, nombre], i) => ({ nombre, total: totT.get(normTipo(nombre)) ?? 0, orden: i + 1 }));

  const map = new Map(); let kits = 0, lineas = 0, sinCant = 0;
  for (let i = h + 1; i < rows.length; i++) {
    const r = rows[i]; if (!r) continue;
    const codigo = String(r[COL.I] ?? '').trim();
    if (!codigo || codigo === '0' || codigo === '-') continue;
    const cat = String(r[COL.E] ?? '').trim().toUpperCase();
    if (cat.startsWith('KIT') || /^TO\.K\./i.test(codigo)) { kits++; continue; }
    const ac = parseNum(r[COL.AC]), ad = parseNum(r[COL.AD]), ae = parseNum(r[COL.AE]);
    if (ac + ad + ae <= 0) { sinCant++; continue; }
    lineas++;
    let m = map.get(codigo);
    if (!m) {
      m = { codigo, descripcion: String(r[COL.J] ?? '').trim() || codigo, unidad: String(r[COL.O] ?? '').trim() || 'UN', cant_proyecto: 0, spare_cliente: 0, spare_axial: 0, por_tracker: {} };
      map.set(codigo, m);
    }
    m.cant_proyecto += ac; m.spare_cliente += ad; m.spare_axial += ae;
    for (const [c, nombre] of tiposNombres) { const u = parseNum(r[c]); if (u) m.por_tracker[nombre] = round3((m.por_tracker[nombre] || 0) + u); }
  }
  const items = [...map.values()].map((m) => ({ ...m, cant_proyecto: round3(m.cant_proyecto), spare_cliente: round3(m.spare_cliente), spare_axial: round3(m.spare_axial) }));
  // Códigos cuyo total de proyecto no coincide con Σ unidades/tracker × trackers (su cupo será aproximado)
  const tot = new Map(tipos.map((t) => [t.nombre, t.total]));
  const noCuadran = items.filter((m) => Math.abs(sum(Object.entries(m.por_tracker).map(([k, u]) => u * (tot.get(k) || 0))) - m.cant_proyecto) > 0.01);
  const rev = (fileName.match(/rev\.?\s*_?(\d+)/i) || [])[1];
  return {
    hoja, items, kits, lineas, sinCant, tipos, noCuadran,
    revision: rev ? 'Rev' + rev : '',
    cabeceras: { I: head[COL.I], J: head[COL.J], O: head[COL.O], AC: head[COL.AC], AD: head[COL.AD], AE: head[COL.AE] },
  };
}

async function onBomFile(e) {
  const f = e.target.files[0]; if (!f) return;
  const box = $('#bom-prev');
  box.innerHTML = '<div class="spin">Leyendo Excel…</div>';
  try {
    const p = parseBOM(await f.arrayBuffer(), f.name);
    const old = new Map(S.mats.map((m) => [m.codigo, m]));
    const nuevos = p.items.filter((i) => !old.has(i.codigo));
    const cambios = p.items.filter((i) => { const o = old.get(i.codigo); return o && (Number(o.cant_proyecto) !== i.cant_proyecto || Number(o.spare_cliente) + Number(o.spare_axial) !== i.spare_cliente + i.spare_axial); });
    const codes = new Set(p.items.map((i) => i.codigo));
    const fuera = S.mats.filter((m) => m.activo !== false && !codes.has(m.codigo));
    const cab = p.cabeceras;
    box.innerHTML = `
      <div class="card" style="margin-top:10px">
        <div class="kv small">
          <span>Hoja</span><b>${esc(p.hoja)}</b>
          <span>Líneas válidas</span><b>${p.lineas}</b>
          <span>Códigos únicos</span><b>${p.items.length}</b>
          <span>Filas de kit excluidas</span><b>${p.kits}</b>
          <span>Tipos de tracker</span><b>${p.tipos.map((t) => `${esc(t.nombre)}: ${fmt(t.total)}`).join('<br>') || '—'}</b>
          <span>Nuevos</span><b>${nuevos.length}</b>
          <span>Cantidades cambiadas</span><b>${cambios.length}</b>
          <span>Dejan de estar en el BOM</span><b>${fuera.length}</b>
        </div>
        <div class="muted" style="font-size:12px;margin-top:8px">Cabeceras leídas → I: ${esc(cab.I)} · J: ${esc(cab.J)} · AC: ${esc(cab.AC)} · AD: ${esc(cab.AD)} · AE: ${esc(cab.AE)}</div>
        ${p.noCuadran.length ? `<p class="muted small">${p.items.length - p.noCuadran.length} códigos cuadran exactamente con unidades × trackers. Los otros ${p.noCuadran.length} reparten su cupo en proporción a los trackers asignados.</p>` : ''}
        ${cambios.length ? `<details style="margin-top:8px"><summary class="small">Ver cambios de cantidad</summary><table class="mini"><tr><th>Código</th><th>Proy. antes→ahora</th></tr>${cambios.map((i) => `<tr><td class="mono">${esc(i.codigo)}</td><td>${fmt(old.get(i.codigo).cant_proyecto)} → ${fmt(i.cant_proyecto)}</td></tr>`).join('')}</table></details>` : ''}
        ${fuera.length ? `<div class="alert">${fuera.length} códigos dejan de estar en el BOM: se marcarán como “Fuera de BOM” pero se conservan sus entregas.</div>` : ''}
        <div class="field"><label>Revisión</label><input id="bom-rev" value="${esc(p.revision)}" placeholder="ej. Rev3"></div>
        <button class="btn block" id="bom-ok" style="margin-top:10px">Importar ${p.items.length} códigos</button>
      </div>`;
    $('#bom-ok').onclick = async () => {
      const rev = $('#bom-rev').value.trim() || 'sin revisión';
      $('#bom-ok').disabled = true; $('#bom-ok').textContent = 'Importando…';
      try {
        const r = await API.importar(p.items, rev, p.tipos);
        await loadAll(); renderMas();
        toast(`BOM ${rev} importado: ${r.nuevos} nuevos, ${r.modificados} modificados, ${r.desactivados} fuera de BOM`);
      } catch (err) { toast('Error al importar: ' + err.message); $('#bom-ok').disabled = false; $('#bom-ok').textContent = 'Reintentar'; }
    };
  } catch (err) {
    box.innerHTML = `<div class="alert bad">${esc(err.message)}</div>`;
  }
}

/* ------------------------------------------------------------------ */
/* Reporte Excel                                                       */
/* ------------------------------------------------------------------ */
function sheetFrom(rows, widths) {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = widths.map((w) => ({ wch: w }));
  if (rows.length > 1) ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length - 1, c: rows[0].length - 1 } }) };
  return ws;
}
function fmtCols(ws, rows, cols, z) {
  for (let r = 1; r < rows.length; r++) for (const c of cols) { const cell = ws[XLSX.utils.encode_cell({ r, c })]; if (cell && cell.v !== '') cell.z = z; }
}

async function exportExcel() {
  const btn = $('#btn-xls'); if (btn) { btn.disabled = true; btn.textContent = 'Generando…'; }
  try {
    await loadResumen();
    const [vales, lineas] = await Promise.all([API.todosVales(), API.todasLineas()]);
    const vMap = new Map(vales.map((v) => [v.id, v]));
    const subs = S.subs.filter((s) => !fixedSub() || s.id === fixedSub());
    const hayCupo = subs.some((s) => S.reparto.has(s.id));
    const wb = XLSX.utils.book_new();

    // Resumen por código (cantidades netas: entregas − devoluciones)
    const head = ['Código', 'Descripción', 'Unidad', 'Cant. proyecto', 'Spare cliente', 'Spare Axial', 'Spare total'];
    for (const s of subs) head.push(...(hayCupo ? [`${s.nombre} cupo`] : []), `${s.nombre} proyecto`, `${s.nombre} spare`);
    head.push('Entregado proyecto', 'Pendiente proyecto', '% proyecto', 'Entregado spare', 'Pendiente spare', 'Estado', 'En BOM');
    const rows = [head];
    for (const m of S.mats) {
      const t = matTotals(m.codigo);
      const row = [m.codigo, m.descripcion, m.unidad, Number(m.cant_proyecto), Number(m.spare_cliente), Number(m.spare_axial), t.sTot];
      for (const s of subs) row.push(...(hayCupo ? [cupo(m.codigo, s.id) ?? ''] : []), t.r.proyecto[s.id] || 0, t.r.spare[s.id] || 0);
      const sobreCupo = subs.some((s) => { const c = cupo(m.codigo, s.id); return c != null && (t.r.proyecto[s.id] || 0) > c; });
      const estado = t.pAll > t.pTot || t.sAll > t.sTot ? 'Excedido' : sobreCupo ? 'Sobre cupo' : t.pTot > 0 && t.pAll >= t.pTot ? 'Proyecto completo' : t.pAll + t.sAll > 0 ? 'Parcial' : 'Sin entregas';
      row.push(t.pAll, t.pPend, t.pTot ? round3(t.pAll / t.pTot) : 0, t.sAll, t.sPend, estado, m.activo === false ? 'No' : 'Sí');
      rows.push(row);
    }
    const wsR = sheetFrom(rows, [18, 48, 7, 12, 11, 11, 11, ...subs.flatMap(() => (hayCupo ? [12, 14, 12] : [14, 12])), 14, 14, 10, 13, 13, 16, 7]);
    fmtCols(wsR, rows, [head.indexOf('% proyecto')], '0%');
    XLSX.utils.book_append_sheet(wb, wsR, 'Resumen');

    // Por subcontrata
    const ps = [['Subcontrata', 'Código', 'Descripción', 'Unidad', 'Cupo proyecto', 'Proyecto', 'Spare', 'Total', 'Pendiente de cupo']];
    for (const s of subs) for (const m of S.mats) {
      const r = S.res.get(m.codigo); const c = cupo(m.codigo, s.id);
      const p = r?.proyecto[s.id] || 0, sp = r?.spare[s.id] || 0;
      if (p || sp || c) ps.push([s.nombre, m.codigo, m.descripcion, m.unidad, c ?? '', p, sp, round3(p + sp), c != null ? round3(c - p) : '']);
    }
    XLSX.utils.book_append_sheet(wb, sheetFrom(ps, [16, 18, 48, 7, 12, 11, 11, 11, 14]), 'Por subcontrata');

    // Vales
    const nLin = new Map(); for (const l of lineas) nLin.set(l.vale_id, (nLin.get(l.vale_id) || 0) + 1);
    const vs = [['Nº vale', 'Clase', 'Fecha', 'Subcontrata', 'Entrega', 'Recibe', 'Observaciones', 'Nº líneas', 'Usuario', 'Registrado', 'Anulado', 'Motivo anulación', 'Anulado por']];
    for (const v of vales.slice().sort((a, b) => (a.numero || 0) - (b.numero || 0))) {
      vs.push([valeNum(v), v.clase === 'devolucion' ? 'Devolución' : 'Entrega', v.fecha ? new Date(v.fecha + 'T12:00:00') : '', subName(v.subcontrata_id),
        v.entregado_por || '', v.receptor || '', v.observaciones || '', nLin.get(v.id) || 0, v.usuario_email || '', new Date(v.creado),
        v.anulado ? 'Sí' : 'No', v.anulado_motivo || '', v.anulado_por || '']);
    }
    const wsV = sheetFrom(vs, [12, 11, 11, 15, 20, 20, 30, 9, 24, 16, 8, 24, 18]);
    fmtCols(wsV, vs, [2], 'dd/mm/yyyy'); fmtCols(wsV, vs, [9], 'dd/mm/yyyy hh:mm');
    XLSX.utils.book_append_sheet(wb, wsV, 'Vales');

    // Líneas
    const mv = [['ID', 'Nº vale', 'Fecha vale', 'Subcontrata', 'Clase', 'Código', 'Descripción', 'Tipo', 'Cantidad', 'Cantidad neta', 'Unidad', 'Entrega', 'Recibe',
      'Observaciones', 'Requiere aprobación', 'Aprobado por', 'Fecha aprobación', 'Anulada', 'Motivo anulación', 'Anulada por']];
    for (const e of lineas) {
      const m = S.matMap.get(e.codigo); const v = vMap.get(e.vale_id);
      const dev = e.clase === 'devolucion';
      mv.push([e.id, v ? valeNum(v) : '', v?.fecha ? new Date(v.fecha + 'T12:00:00') : new Date(e.creado), subName(e.subcontrata_id), dev ? 'Devolución' : 'Entrega',
        e.codigo, m?.descripcion || '', e.tipo === 'spare' ? 'Spare' : 'Proyecto', Number(e.cantidad), dev ? -Number(e.cantidad) : Number(e.cantidad), m?.unidad || '',
        e.entregado_por || '', e.receptor || '', e.observaciones || '', e.requiere_aprobacion ? 'Sí' : 'No', e.aprobado_por || '',
        e.aprobado_fecha ? new Date(e.aprobado_fecha) : '', e.anulada ? 'Sí' : 'No', e.anulada_motivo || '', e.anulada_por || '']);
    }
    const wsM = sheetFrom(mv, [7, 12, 11, 15, 11, 18, 48, 9, 10, 11, 7, 18, 18, 30, 10, 18, 16, 8, 24, 18]);
    fmtCols(wsM, mv, [2], 'dd/mm/yyyy'); fmtCols(wsM, mv, [16], 'dd/mm/yyyy hh:mm');
    XLSX.utils.book_append_sheet(wb, wsM, 'Líneas');

    // Reparto
    if (hayCupo) {
      const rp = [['Tipo de tracker', 'Total proyecto', ...subs.map((s) => s.nombre), 'Asignados']];
      for (const t of S.tipos) { const v = subs.map((s) => S.reparto.get(s.id)?.[t.nombre] || 0); rp.push([t.nombre, Number(t.total), ...v, sum(v)]); }
      XLSX.utils.book_append_sheet(wb, sheetFrom(rp, [18, 14, ...subs.map(() => 15), 11]), 'Reparto trackers');
    }

    const now = new Date();
    XLSX.utils.book_append_sheet(wb, sheetFrom([
      ['Proyecto', S.ajustes.proyecto || CFG.PROYECTO || ''],
      ['Revisión BOM', S.ajustes.bom_revision || ''],
      ['BOM importado', S.ajustes.bom_fecha || ''],
      ['Reporte generado', now.toLocaleString('es-ES')],
      ['Generado por', LS.get('nombre', '') || S.me?.email || ''],
      ['Nota', 'Spare total = Spare cliente (AD) + Spare contingencias Axial (AE). Las cantidades del Resumen son netas (entregas − devoluciones) y no incluyen anuladas.'],
      ['Nota', 'Cupo = cantidad de proyecto repartida en proporción a los trackers asignados a cada subcontrata, ponderados por las unidades por tracker (columnas W–AB del BOM).'],
    ], [20, 80]), 'Info');

    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}`;
    XLSX.writeFile(wb, `Entregas_FerraraBrancole_${stamp}.xlsx`, { cellDates: true });
  } catch (e) {
    toast(isNetErr(e) ? 'Sin conexión: el reporte necesita cobertura.' : 'Error al generar el reporte: ' + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '⬇ Descargar reporte Excel'; }
  }
}

/* ------------------------------------------------------------------ */
/* Login y navegación                                                  */
/* ------------------------------------------------------------------ */
function renderLogin(err = '') {
  $('#tabs').hidden = true;
  view().innerHTML = `
    <form class="login" id="login">
      <h2>Iniciar sesión</h2>
      <div class="field"><label>Correo</label><input type="email" id="l-email" autocomplete="username" required value="${esc(LS.get('last_email', ''))}"></div>
      <div class="field"><label>Contraseña</label><input type="password" id="l-pass" autocomplete="current-password" required></div>
      ${err ? `<div class="alert bad">${esc(err)}</div>` : ''}
      <button class="btn block" style="margin-top:16px">Entrar</button>
      <p class="muted small">Las cuentas las crea el administrador del proyecto.</p>
    </form>`;
  $('#login').onsubmit = async (e) => {
    e.preventDefault();
    const email = $('#l-email').value.trim();
    try {
      S.user = await API.signIn(email, $('#l-pass').value);
      LS.set('last_email', email);
      await start();
    } catch (er) { renderLogin(er.message === 'Invalid login credentials' ? 'Correo o contraseña incorrectos.' : er.message); }
  };
}

function go(tab) {
  S.tab = tab;
  $$('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  window.scrollTo(0, 0);
  ({ entregar: renderEntregar, resumen: renderResumen, vales: renderVales, mas: renderMas })[tab]();
  renderValeBar();
}

let started = false;
async function start() {
  view().innerHTML = '<div class="spin">Cargando datos del proyecto…</div>';
  try {
    await loadAll();
    S.offlineData = false;
  } catch (e) {
    if (!isNetErr(e) || !loadCache()) throw e;
    toast('Sin conexión: se muestran los últimos datos descargados.');
  }
  if (!S.me) {
    view().innerHTML = `<div class="alert bad">Tu usuario (${esc(S.user?.email || '')}) no está dado de alta en la app. Pide al administrador que te asigne un rol.</div>
      <button class="btn ghost block" style="margin-top:12px" id="btn-out2">Cerrar sesión</button>`;
    $('#btn-out2').onclick = async () => { await API.signOut(); location.reload(); };
    return;
  }
  S.resFiltro = S.valFiltro = S.me.rol === 'subcontrata' ? S.me.subcontrata_id : 0;
  $('#proj-name').textContent = S.ajustes.proyecto || CFG.PROYECTO || '';
  $('#tabs').hidden = false;
  $('#tab-entregar').hidden = !can.registrar();
  $('#tabs').style.gridTemplateColumns = `repeat(${can.registrar() ? 4 : 3}, 1fr)`;
  renderColaBadge();
  if (!started) {
    started = true;
    API.subscribe(scheduleRefresh, setConn);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { flushCola().then(avisarEnviados); scheduleRefresh('materiales'); } });
    window.addEventListener('online', () => { setConn('ok'); flushCola().then(avisarEnviados); scheduleRefresh('materiales'); });
    window.addEventListener('offline', () => setConn('off'));
  }
  flushCola().then(avisarEnviados);
  go(can.registrar() ? (S.mats.length || !can.admin() ? 'entregar' : 'mas') : 'resumen');
}

document.addEventListener('click', (e) => {
  const tab = e.target.closest('#tabs button'); if (tab) return go(tab.dataset.tab);
  if (e.target.closest('[data-close]') || e.target.id === 'sheet-bg') return closeSheet();
  const op = e.target.closest('[data-open]'); if (op) return openSheet({ kind: 'item', codigo: op.dataset.open });
  const va = e.target.closest('[data-vale]'); if (va) return abrirVale(va.dataset.vale);
  const la = e.target.closest('[data-lanular]'); if (la) return anularLinea(Number(la.dataset.lanular));
  const ap = e.target.closest('[data-aprobar]'); if (ap) return aprobarLinea(Number(ap.dataset.aprobar));
  const qr = e.target.closest('[data-qretry]');
  if (qr) { setCola(cola().map((x) => (x.p.id === qr.dataset.qretry ? { ...x, error: null } : x))); return flushCola().then(() => renderValesList()); }
  const qd = e.target.closest('[data-qdel]');
  if (qd && confirm('¿Descartar este vale? No se registrará.')) { setCola(cola().filter((x) => x.p.id !== qd.dataset.qdel)); renderValesList(); }
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && sheet) closeSheet(); });

(async function init() {
  $('#proj-name').textContent = CFG.PROYECTO || '';
  if (DEMO) $('#demo-banner').hidden = false;
  setConn('mid');
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
  try {
    S.user = await API.user();
    // Sin cobertura y con la sesión caducada: seguir con el último perfil guardado
    if (!S.user && !navigator.onLine && LS.get('cache', null)?.me) S.user = { email: LS.get('cache').me.email };
    if (S.user) await start(); else renderLogin();
  } catch (e) {
    view().innerHTML = `<div class="alert bad">No se pudo conectar: ${esc(e.message)}</div>`;
  }
})();
