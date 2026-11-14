/* Equipos: maquinaria prestada a subcontratas, baños portátiles, casetas y generadores.
 * Entregas/instalaciones y devoluciones/retiradas con fotos, y averías, roturas y reparaciones.
 * Se carga después de app.js y usa su estado y utilidades (S, API, sheet, toast…). */
'use strict';

const CATS = {
  maquinaria: ['Maquinaria', '🚜'], bano: ['Baño portátil', '🚻'], caseta: ['Caseta', '🏠'],
  generador: ['Generador', '⚡'], otro: ['Otro', '📦'],
};
const INC_TIPOS = { averia: 'Avería', rotura: 'Rotura', reparacion: 'Reparación', mantenimiento: 'Mantenimiento' };
const INC_EST = { abierta: 'Abierta', en_reparacion: 'En reparación', resuelta: 'Resuelta' };

const EQ = { equipos: [], prestamos: [], incidencias: [], cat: 'todos', est: 'todos', q: '', urls: {}, offline: false };

const canEq = {
  gestionar: () => ['admin', 'almacen'].includes(S.me?.rol),
  reportar: () => ['admin', 'almacen', 'jefe_obra', 'subcontrata'].includes(S.me?.rol),
  resolver: () => ['admin', 'almacen', 'jefe_obra'].includes(S.me?.rol),
};

/* ------------------------------------------------------------------ */
/* Backends                                                            */
/* ------------------------------------------------------------------ */
function equiposSupabase(sb) {
  const ok = ({ data, error }) => { if (error) throw new Error(error.message); return data; };
  return {
    async eqDatos() {
      const [e, p, i] = await Promise.all([
        sb.from('equipos').select('*').order('nombre'),
        sb.from('prestamos').select('*').order('fecha_entrega', { ascending: false }),
        sb.from('incidencias').select('*').order('fecha', { ascending: false }),
      ]);
      return { equipos: ok(e), prestamos: ok(p), incidencias: ok(i) };
    },
    async eqGuardar(e) { ok(await sb.from('equipos').upsert(e)); },
    async eqEntregar(p) { ok(await sb.rpc('entregar_equipo', { p })); },
    async eqDevolver(p) { ok(await sb.rpc('devolver_equipo', { p })); },
    async eqIncidencia(p) { ok(await sb.rpc('reportar_incidencia', { p })); },
    async eqActualizarInc(id, p) { ok(await sb.rpc('actualizar_incidencia', { p_id: id, p })); },
    async subirFoto(path, blob) {
      ok(await sb.storage.from('fotos').upload(path, blob, { contentType: 'image/jpeg', upsert: false }));
      return path;
    },
    async urlsFotos(paths) {
      const data = ok(await sb.storage.from('fotos').createSignedUrls(paths, 3600));
      return Object.fromEntries(data.filter((d) => d.signedUrl).map((d) => [d.path, d.signedUrl]));
    },
  };
}

// Demo: mismo interfaz en localStorage; las fotos se guardan como imagen dentro de los datos
function equiposDemo() {
  const KEY = 'ent_demo_eq';
  const blank = () => ({ equipos: [], prestamos: [], incidencias: [] });
  const load = () => { try { return { ...blank(), ...JSON.parse(localStorage.getItem(KEY)) }; } catch { return blank(); } };
  const save = (db) => {
    try { localStorage.setItem(KEY, JSON.stringify(db)); } catch { throw new Error('No queda espacio en este móvil para más fotos de la demo.'); }
    setTimeout(() => scheduleRefresh('equipos'), 0);
  };
  const rol = () => LS.get('demo_rol', 'admin'), sub = () => LS.get('demo_sub', 1);
  const nombre = () => LS.get('nombre', '') || 'demo@local';
  const red = () => { if (LS.get('demo_offline', false)) throw new TypeError('Failed to fetch'); };
  const exigir = (roles, msg) => { if (!roles.includes(rol())) throw new Error(msg); };
  const now = () => new Date().toISOString();
  const abierto = (db, eqId) => db.prestamos.find((x) => x.equipo_id === eqId && !x.fecha_devolucion);
  return {
    async eqDatos() {
      red();
      const db = load();
      if (rol() !== 'subcontrata') return db;
      const ps = db.prestamos.filter((p) => p.subcontrata_id === sub());
      const ids = new Set(ps.map((p) => p.equipo_id));
      return { equipos: db.equipos.filter((e) => ids.has(e.id)), prestamos: ps, incidencias: db.incidencias.filter((i) => i.subcontrata_id === sub()) };
    },
    async eqGuardar(e) {
      red(); exigir(['admin', 'almacen'], 'Tu usuario no puede dar de alta ni editar equipos');
      const db = load(); const i = db.equipos.findIndex((x) => x.id === e.id);
      if (i >= 0) db.equipos[i] = { ...db.equipos[i], ...e }; else db.equipos.push({ activo: true, creado: now(), ...e });
      save(db);
    },
    async eqEntregar(p) {
      red(); exigir(['admin', 'almacen'], 'Tu usuario no puede entregar equipos');
      const db = load();
      if (db.prestamos.some((x) => x.id === p.id)) return;
      const e = db.equipos.find((x) => x.id === p.equipo_id);
      if (!e || !e.activo) throw new Error('El equipo no existe o está dado de baja');
      if (abierto(db, p.equipo_id)) throw new Error('El equipo ya está entregado: registra antes su devolución');
      db.prestamos.push({ ...p, fotos_devolucion: [], con_danos: false, usuario_email: 'demo@local', creado: now() });
      save(db);
    },
    async eqDevolver(p) {
      red(); exigir(['admin', 'almacen'], 'Tu usuario no puede registrar devoluciones');
      const db = load(); const pr = db.prestamos.find((x) => x.id === p.prestamo_id && !x.fecha_devolucion);
      if (!pr) throw new Error('Esta entrega ya está cerrada');
      if (p.fecha_devolucion < pr.fecha_entrega) throw new Error('La fecha de devolución es anterior a la de entrega');
      const { incidencia, prestamo_id, ...campos } = p;
      Object.assign(pr, campos, { cerrado: now() });
      if (p.con_danos && incidencia) {
        db.incidencias.push({ id: incidencia.id, equipo_id: pr.equipo_id, prestamo_id: pr.id, subcontrata_id: pr.subcontrata_id, tipo: 'rotura',
          fecha: p.fecha_devolucion, descripcion: p.obs_devolucion || 'Devuelto con daños', fuera_servicio: !!incidencia.fuera_servicio,
          fotos: p.fotos_devolucion, reportado_por: nombre(), creado: now(), estado: 'abierta', fotos_resolucion: [] });
      }
      save(db);
    },
    async eqIncidencia(p) {
      red(); exigir(['admin', 'almacen', 'jefe_obra', 'subcontrata'], 'Tu usuario no puede reportar incidencias');
      const db = load();
      if (db.incidencias.some((i) => i.id === p.id)) return;
      const pr = abierto(db, p.equipo_id);
      let s = p.subcontrata_id ?? null;
      if (rol() === 'subcontrata') {
        if (!pr || pr.subcontrata_id !== sub()) throw new Error('Solo puedes reportar equipos que tienes ahora');
        s = sub();
      }
      db.incidencias.push({ ...p, subcontrata_id: s, prestamo_id: pr?.id || null, estado: 'abierta', reportado_por: nombre(), creado: now(), fotos_resolucion: [] });
      save(db);
    },
    async eqActualizarInc(id, p) {
      red(); exigir(['admin', 'almacen', 'jefe_obra'], 'Tu usuario no puede actualizar incidencias');
      const db = load(); const i = db.incidencias.find((x) => x.id === id); if (!i) return;
      const res = p.estado === 'resuelta';
      Object.assign(i, {
        estado: p.estado, resuelta_fecha: res ? p.resuelta_fecha || today() : null, resolucion: p.resolucion || null,
        coste: p.coste === '' || p.coste == null ? null : Number(p.coste), fuera_servicio: res ? false : !!p.fuera_servicio,
        fotos_resolucion: [...(i.fotos_resolucion || []), ...(p.fotos_resolucion || [])],
      });
      save(db);
    },
    async subirFoto(path, blob) {
      red();
      return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(blob); });
    },
    async urlsFotos() { return {}; },
  };
}
Object.assign(API, DEMO ? equiposDemo() : equiposSupabase(API._sb));

/* ------------------------------------------------------------------ */
/* Datos y estado de cada equipo                                       */
/* ------------------------------------------------------------------ */
async function loadEquipos() {
  try {
    const d = await API.eqDatos();
    Object.assign(EQ, d, { offline: false });
    LS.set('cache_eq', d);
  } catch (e) {
    const c = LS.get('cache_eq', null);
    if (!isNetErr(e) || !c) throw e;
    Object.assign(EQ, c, { offline: true });
  }
}

const eqById = (id) => EQ.equipos.find((e) => e.id === id);
const prestamoAbierto = (eqId) => EQ.prestamos.find((p) => p.equipo_id === eqId && !p.fecha_devolucion);
const diasEntre = (a, b) => Math.round((new Date(b + 'T12:00:00') - new Date(a + 'T12:00:00')) / 86400000);
const nDias = (a, b) => { const n = diasEntre(a, b) + 1; return n === 1 ? '1 día' : `${n} días`; };
const destino = (p) => (p.subcontrata_id ? subName(p.subcontrata_id) : 'En obra / uso propio') + (p.ubicacion ? ` · ${p.ubicacion}` : '');

function eqEstado(e) {
  const p = prestamoAbierto(e.id);
  const inc = EQ.incidencias.filter((i) => i.equipo_id === e.id && i.estado !== 'resuelta');
  const parada = inc.some((i) => i.fuera_servicio);
  let alq = null;
  if (e.activo && e.fin_alquiler) {
    const d = diasEntre(today(), e.fin_alquiler);
    if (d < 0) alq = { cls: 'x', txt: 'Alquiler vencido' };
    else if (d <= 7) alq = { cls: 'w', txt: `Alquiler vence ${fday(e.fin_alquiler)}` };
  }
  return { p, inc, parada, alq, baja: !e.activo };
}

function eqPills(e) {
  const s = eqEstado(e);
  let h = s.baja ? '<span class="pill">De baja</span>'
    : s.p ? `<span class="pill p">${s.p.subcontrata_id ? 'En ' + esc(subName(s.p.subcontrata_id)) : 'En obra'}</span>`
    : '<span class="pill ok">Disponible</span>';
  if (s.parada) h += '<span class="pill x">Fuera de servicio</span>';
  else if (s.inc.length) h += `<span class="pill w">${s.inc.length} incidencia${s.inc.length > 1 ? 's' : ''}</span>`;
  if (s.alq) h += `<span class="pill ${s.alq.cls}">${esc(s.alq.txt)}</span>`;
  return h;
}

/* ------------------------------------------------------------------ */
/* Fotos: reducir, estampar fecha, subir y mostrar                     */
/* ------------------------------------------------------------------ */
async function procesarFoto(file, etiqueta) {
  const max = DEMO ? 900 : 1600, q = DEMO ? 0.6 : 0.78;
  let img;
  try { img = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch {
    img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('No se pudo leer la foto')); i.src = URL.createObjectURL(file); });
  }
  const k = Math.min(1, max / Math.max(img.width, img.height));
  const w = Math.round(img.width * k), h = Math.round(img.height * k);
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0, w, h);
  // Fecha y hora de la foto estampadas abajo, como prueba
  const cuando = new Date(file.lastModified || Date.now()).toLocaleString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const txt = `${cuando} · ${etiqueta}`;
  const fs = Math.max(14, Math.round(w / 38));
  g.font = `600 ${fs}px system-ui, sans-serif`;
  g.fillStyle = 'rgba(0,0,0,.55)'; g.fillRect(0, h - fs * 1.8, w, fs * 1.8);
  g.fillStyle = '#fff'; g.fillText(txt, fs * 0.6, h - fs * 0.6, w - fs * 1.2);
  const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', q));
  return { blob, url: URL.createObjectURL(blob) };
}

async function subirFotos(eqId, grupo, fotos, progreso) {
  const out = [];
  for (let i = 0; i < fotos.length; i++) {
    progreso?.(i + 1, fotos.length);
    out.push(await API.subirFoto(`${eqId}/${grupo}-${uuid()}.jpg`, fotos[i].blob));
  }
  return out;
}

const fotoSrc = (p) => (String(p).startsWith('data:') ? p : EQ.urls[p] || '');
function fotosHtml(paths) {
  if (!paths?.length) return '';
  return `<div class="fotos">${paths.map((p) => { const s = fotoSrc(p); return `<div class="ft"><img data-path="${esc(p)}" ${s ? `src="${esc(s)}"` : ''} alt="Foto" data-visor></div>`; }).join('')}</div>`;
}
// Pide las URLs firmadas de las fotos que se ven y las pone sin volver a pintar la hoja
async function cargarFotos(root) {
  const faltan = [...new Set($$('img[data-path]', root).map((i) => i.dataset.path))].filter((p) => !p.startsWith('data:') && !EQ.urls[p]);
  if (faltan.length) { try { Object.assign(EQ.urls, await API.urlsFotos(faltan)); } catch { /* sin conexión: se verán al volver */ } }
  $$('img[data-path]', root).forEach((i) => { if (!i.getAttribute('src') && fotoSrc(i.dataset.path)) i.src = fotoSrc(i.dataset.path); });
}

function fotosPicker(key) {
  const arr = sheet.f[key];
  return `<div class="fotos">
    ${arr.map((f, i) => `<div class="ft"><img src="${f.url}" alt="Foto" data-visor><button type="button" class="ft-del" data-fdel="${key}:${i}" aria-label="Quitar">×</button></div>`).join('')}
    <label class="ft add"><input type="file" accept="image/*" capture="environment" data-fadd="${key}" hidden><b>📷</b><span>Cámara</span></label>
    <label class="ft add"><input type="file" accept="image/*" multiple data-fadd="${key}" hidden><b>🖼</b><span>Galería</span></label>
  </div>`;
}

/* ------------------------------------------------------------------ */
/* Pestaña Equipos                                                     */
/* ------------------------------------------------------------------ */
function eqChips(sel, opts, attr) {
  return `<div class="chips">${Object.entries(opts).map(([k, v]) => `<button class="chip ${sel === k ? 'on' : ''}" ${attr}="${k}">${v}</button>`).join('')}</div>`;
}
const CAT_OPTS = () => ({ todos: 'Todos', ...Object.fromEntries(Object.entries(CATS).map(([k, [n, i]]) => [k, `${i} ${n}`])) });
const EST_OPTS = { todos: 'Cualquier estado', disponible: 'Disponibles', entregado: 'Entregados', incidencia: 'Con incidencias', baja: 'De baja' };

async function renderEquipos() {
  view().innerHTML = `
    <div id="eq-cards"></div>
    ${canEq.gestionar() ? '<button class="btn block" id="eq-nuevo" style="margin-top:10px">＋ Nuevo equipo</button>' : ''}
    <div id="eq-cat" class="chips-scroll" style="margin-top:12px">${eqChips(EQ.cat, CAT_OPTS(), 'data-cat')}</div>
    <div id="eq-est" class="chips-scroll" style="margin-top:6px">${eqChips(EQ.est, EST_OPTS, 'data-est')}</div>
    <input id="eq-q" class="search" type="search" placeholder="Buscar equipo, matrícula o subcontrata…" value="${esc(EQ.q)}">
    <div id="eq-list" class="list"><div class="spin">Cargando…</div></div>`;
  $('#eq-cat').onclick = (e) => { const b = e.target.closest('[data-cat]'); if (!b) return; EQ.cat = b.dataset.cat; $('#eq-cat').innerHTML = eqChips(EQ.cat, CAT_OPTS(), 'data-cat'); renderEquiposList(); };
  $('#eq-est').onclick = (e) => { const b = e.target.closest('[data-est]'); if (!b) return; EQ.est = b.dataset.est; $('#eq-est').innerHTML = eqChips(EQ.est, EST_OPTS, 'data-est'); renderEquiposList(); };
  $('#eq-q').oninput = (e) => { EQ.q = e.target.value; renderEquiposList(); };
  if ($('#eq-nuevo')) $('#eq-nuevo').onclick = () => abrirEquipo(null);
  try { await loadEquipos(); } catch (e) { $('#eq-list').innerHTML = `<div class="alert bad">${esc(e.message)}</div>`; return; }
  renderEquiposList();
}

function renderEquiposList() {
  const box = $('#eq-list'), cards = $('#eq-cards'); if (!box) return;
  const activos = EQ.equipos.filter((e) => e.activo);
  const est = activos.map(eqEstado);
  const enSub = est.filter((s) => s.p?.subcontrata_id).length, enObra = est.filter((s) => s.p && !s.p.subcontrata_id).length;
  const incAb = EQ.incidencias.filter((i) => i.estado !== 'resuelta').length;
  cards.innerHTML = `
    ${EQ.offline ? '<div class="alert">Sin conexión: se muestran los últimos datos descargados.</div>' : ''}
    <div class="cards">
      <div class="card"><div class="big">${enSub}</div><div class="lbl">En subcontratas</div></div>
      <div class="card"><div class="big">${est.length - enSub - enObra}</div><div class="lbl">Disponibles${enObra ? ` · ${enObra} en obra` : ''}</div></div>
      <div class="card"><div class="big" style="color:${incAb ? 'var(--warn)' : 'inherit'}">${incAb}</div><div class="lbl">Incidencias abiertas</div></div>
    </div>`;
  const toks = norm(EQ.q).split(/\s+/).filter(Boolean);
  const list = EQ.equipos.filter((e) => {
    const s = eqEstado(e);
    if (EQ.cat !== 'todos' && e.categoria !== EQ.cat) return false;
    if (EQ.est === 'baja' ? !s.baja : s.baja && EQ.est !== 'todos') return false;
    if (EQ.est === 'disponible' && (s.p || s.baja)) return false;
    if (EQ.est === 'entregado' && !s.p) return false;
    if (EQ.est === 'incidencia' && !s.inc.length) return false;
    const txt = norm([e.nombre, e.codigo, e.modelo, e.matricula, e.proveedor, s.p ? destino(s.p) : ''].join(' '));
    return toks.every((t) => txt.includes(t));
  });
  if (!EQ.equipos.length) {
    box.innerHTML = `<div class="empty">Todavía no hay equipos.${canEq.gestionar() ? '<br>Pulsa <b>＋ Nuevo equipo</b> para dar de alta el primero.' : ''}</div>`;
    return;
  }
  box.innerHTML = list.length ? list.map((e) => {
    const s = eqEstado(e);
    return `<button class="item ${s.baja ? 'anul' : ''}" data-eq="${e.id}">
      <div class="row"><span class="eq-ico">${CATS[e.categoria]?.[1] || '📦'}</span><b class="grow">${esc(e.nombre)}</b></div>
      <div class="desc">${esc([CATS[e.categoria]?.[0], e.codigo, e.modelo, e.matricula].filter(Boolean).join(' · '))}</div>
      <div class="meta">${eqPills(e)}</div>
      ${s.p ? `<div class="desc">${esc(destino(s.p))} · desde ${fday(s.p.fecha_entrega)} (${nDias(s.p.fecha_entrega, today())})</div>` : ''}
    </button>`;
  }).join('') : '<div class="empty">Ningún equipo con estos filtros.</div>';
}

/* ------------------------------------------------------------------ */
/* Hoja de un equipo: ficha, alta/edición, entrega, devolución…        */
/* ------------------------------------------------------------------ */
function abrirEquipo(id, modo = 'ver') {
  sheet = { kind: 'equipo', id, modo: id ? modo : 'editar' };
  prepararForm(sheet.modo);
  openSheet(sheet);
}

function prepararForm(modo, extra = {}) {
  const e = eqById(sheet.id) || {};
  const pr = prestamoAbierto(sheet.id);
  const yo = LS.get('nombre', '') || S.me?.nombre || '';
  sheet.modo = modo; sheet.form = modo !== 'ver';
  sheet.f = {
    editar: () => ({ nombre: e.nombre || '', categoria: e.categoria || 'maquinaria', codigo: e.codigo || '', modelo: e.modelo || '', matricula: e.matricula || '',
      proveedor: e.proveedor || '', inicio_alquiler: e.inicio_alquiler || '', fin_alquiler: e.fin_alquiler || '', observaciones: e.observaciones || '' }),
    entregar: () => ({ dest: S.subs[0]?.id ?? 0, ubicacion: '', fecha: today(), entrega: yo, recibe: '', horas: '', obs: '', fotos: [] }),
    devolver: () => ({ fecha: today(), devuelve: pr?.recibe || '', recibe: yo, horas: '', danos: false, fuera: false, obs: '', fotos: [] }),
    incidencia: () => ({ tipo: 'averia', fecha: today(), desc: '', resp: pr?.subcontrata_id ?? 0, fuera: false, fotos: [] }),
    resolver: () => {
      const i = EQ.incidencias.find((x) => x.id === extra.incId) || {};
      return { incId: extra.incId, estado: i.estado === 'abierta' ? 'en_reparacion' : i.estado || 'en_reparacion', fecha: today(), resolucion: i.resolucion || '', coste: i.coste ?? '', fuera: !!i.fuera_servicio, fotos: [] };
    },
    ver: () => null,
  }[modo]();
}

function renderEquipoSheet() {
  const sh = $('#sheet');
  const e = eqById(sheet.id);
  if (sheet.id && !e) return closeSheet();
  const titulo = e ? e.nombre : 'Nuevo equipo';
  const sub = e ? [CATS[e.categoria]?.[0], e.codigo].filter(Boolean).join(' · ') : '';
  const cuerpo = { ver: eqVer, editar: eqFormEditar, entregar: eqFormEntregar, devolver: eqFormDevolver, incidencia: eqFormIncidencia, resolver: eqFormResolver }[sheet.modo];
  sh.innerHTML = sheetHead(titulo, sub) + cuerpo(e);
  $('h3', sh).classList.add('eq-title');
  cargarFotos(sh);
}

const fld = (label, k, attrs = '') => `<div class="field"><label>${label}</label><input data-k="${k}" value="${esc(sheet.f[k])}" ${attrs}></div>`;
const area = (label, k, ph = '') => `<div class="field"><label>${label}</label><textarea data-k="${k}" rows="2" placeholder="${esc(ph)}">${esc(sheet.f[k])}</textarea></div>`;
const segSet = (k, opts) => `<div class="seg" style="grid-template-columns:repeat(${Object.keys(opts).length},1fr)">${Object.entries(opts).map(([v, t]) => `<button type="button" class="${String(sheet.f[k]) === String(v) ? 'on p' : ''}" data-set="${k}:${v}">${t}</button>`).join('')}</div>`;
const subSet = (k, extraOpt) => `<div class="chips">${S.subs.map((s) => `<button type="button" class="chip ${sheet.f[k] === s.id ? 'on' : ''}" data-set="${k}:${s.id}">${esc(s.nombre)}</button>`).join('')}
  <button type="button" class="chip ${sheet.f[k] === 0 ? 'on' : ''}" data-set="${k}:0">${extraOpt}</button></div>`;
const btnVolver = () => '<button type="button" class="btn ghost block" data-modo="ver" style="margin-top:8px">Cancelar</button>';

function eqVer(e) {
  const s = eqEstado(e);
  const hist = EQ.prestamos.filter((p) => p.equipo_id === e.id);
  const incs = EQ.incidencias.filter((i) => i.equipo_id === e.id);
  const cerrados = hist.filter((p) => p.fecha_devolucion);
  return `
    <div class="meta" style="margin-top:8px">${eqPills(e)}</div>
    <div class="card kv small" style="margin-top:10px">
      ${e.modelo ? `<span>Marca / modelo</span><b>${esc(e.modelo)}</b>` : ''}
      ${e.matricula ? `<span>Matrícula / nº serie</span><b>${esc(e.matricula)}</b>` : ''}
      ${e.proveedor ? `<span>Proveedor alquiler</span><b>${esc(e.proveedor)}</b>` : ''}
      ${e.inicio_alquiler || e.fin_alquiler ? `<span>Alquiler</span><b>${fday(e.inicio_alquiler) || '—'} → ${fday(e.fin_alquiler) || '—'}</b>` : ''}
      ${e.observaciones ? `<span>Observaciones</span><b>${esc(e.observaciones)}</b>` : ''}
      ${s.baja ? `<span>Baja</span><b>${fday(e.baja_fecha)}</b>` : ''}
    </div>

    ${s.p ? `
      <h2>Entregado ahora</h2>
      <div class="mov">
        <div class="row"><b class="grow">${esc(destino(s.p))}</b><span class="small">${nDias(s.p.fecha_entrega, today())}</span></div>
        <div class="small">Desde ${fday(s.p.fecha_entrega)} · Entrega: ${esc(s.p.entregado_por || '—')} · Recibe: ${esc(s.p.recibe || '—')}${s.p.horas_inicio != null ? ` · Horómetro ${fmt(s.p.horas_inicio)} h` : ''}</div>
        ${s.p.obs_entrega ? `<div class="small">“${esc(s.p.obs_entrega)}”</div>` : ''}
        ${fotosHtml(s.p.fotos_entrega)}
        <div class="row" style="justify-content:flex-end;margin-top:6px"><button class="btn sm ghost" data-acta="${s.p.id}">🖨 Acta</button></div>
      </div>` : ''}

    <div class="eq-acciones">
      ${canEq.gestionar() && !s.baja ? (s.p
        ? '<button class="btn block" data-modo="devolver">↩ Registrar devolución / retirada</button>'
        : '<button class="btn block" data-modo="entregar">➜ Entregar / instalar</button>') : ''}
      ${canEq.reportar() && !s.baja && (S.me.rol !== 'subcontrata' || s.p?.subcontrata_id === S.me.subcontrata_id)
        ? '<button class="btn warn block" data-modo="incidencia">⚠ Reportar avería o rotura</button>' : ''}
    </div>
    ${s.parada && !s.p ? '<div class="alert bad">Equipo fuera de servicio: revisa las incidencias antes de entregarlo.</div>' : ''}

    <h2>Incidencias (${incs.length})</h2>
    ${incs.length ? `<div class="list">${incs.map((i) => `
      <div class="mov ${i.estado === 'resuelta' ? '' : 'warnb'}">
        <div class="row"><span class="pill ${i.tipo === 'rotura' ? 'x' : 'w'}">${INC_TIPOS[i.tipo]}</span>
          <span class="pill ${i.estado === 'resuelta' ? 'ok' : 'w'}">${INC_EST[i.estado]}</span>${i.fuera_servicio ? '<span class="pill x">Fuera de servicio</span>' : ''}
          <span class="grow"></span><span class="small">${fday(i.fecha)}</span></div>
        <div style="margin-top:4px">${esc(i.descripcion)}</div>
        <div class="muted small">${i.subcontrata_id ? 'Responsable: ' + esc(subName(i.subcontrata_id)) + ' · ' : ''}Reporta: ${esc(i.reportado_por || '—')}</div>
        ${fotosHtml(i.fotos)}
        ${i.estado === 'resuelta' || i.resolucion ? `<div class="small" style="margin-top:4px"><b>${i.estado === 'resuelta' ? 'Resuelta ' + fday(i.resuelta_fecha) : 'Seguimiento'}:</b> ${esc(i.resolucion || '')}${i.coste != null ? ` · Coste ${fmt(i.coste)} €` : ''}</div>` : ''}
        ${fotosHtml(i.fotos_resolucion)}
        ${canEq.resolver() && i.estado !== 'resuelta' ? `<div class="row" style="justify-content:flex-end;margin-top:6px"><button class="btn sm" data-resolver="${i.id}">Actualizar / resolver</button></div>` : ''}
      </div>`).join('')}</div>` : '<p class="muted small">Sin incidencias.</p>'}

    <h2>Historial de entregas (${cerrados.length})</h2>
    ${cerrados.length ? `<div class="list">${cerrados.map((p) => `
      <div class="mov">
        <div class="row"><b class="grow">${esc(destino(p))}</b>${p.con_danos ? '<span class="pill x">Con daños</span>' : ''}</div>
        <div class="small">${fday(p.fecha_entrega)} → ${fday(p.fecha_devolucion)} (${nDias(p.fecha_entrega, p.fecha_devolucion)})${p.horas_inicio != null && p.horas_fin != null ? ` · ${fmt(p.horas_fin - p.horas_inicio)} h de uso` : ''}</div>
        <div class="muted small">Entrega: ${esc(p.entregado_por || '—')} → ${esc(p.recibe || '—')} · Devuelve: ${esc(p.devuelve || '—')} → ${esc(p.recibe_devolucion || '—')}</div>
        ${p.fotos_entrega?.length ? `<div class="small" style="margin-top:6px">Fotos de entrega</div>${fotosHtml(p.fotos_entrega)}` : ''}
        ${p.fotos_devolucion?.length ? `<div class="small" style="margin-top:6px">Fotos de devolución</div>${fotosHtml(p.fotos_devolucion)}` : ''}
        ${p.obs_devolucion ? `<div class="small">“${esc(p.obs_devolucion)}”</div>` : ''}
        <div class="row" style="justify-content:flex-end;margin-top:6px"><button class="btn sm ghost" data-acta="${p.id}">🖨 Acta</button></div>
      </div>`).join('')}</div>` : '<p class="muted small">Todavía no se ha devuelto nunca.</p>'}

    ${canEq.gestionar() ? `
      <button class="btn ghost block" data-modo="editar" style="margin-top:16px">✎ Editar datos del equipo</button>
      ${s.baja ? '<button class="btn ghost block" data-eqalta style="margin-top:8px">Volver a dar de alta</button>'
        : !s.p ? '<button class="btn ghost block" data-eqbaja style="margin-top:8px">Dar de baja (devuelto al proveedor)</button>' : ''}` : ''}`;
}

function eqFormEditar(e) {
  return `
    <div class="field"><label>Tipo</label>${segSet('categoria', Object.fromEntries(Object.entries(CATS).map(([k, [n, i]]) => [k, `${i}<br><small>${n.split(' ')[0]}</small>`])))}</div>
    ${fld('Nombre *', 'nombre', 'placeholder="Ej. Manipulador telescópico JCB 535"')}
    ${fld('Código interno', 'codigo', 'placeholder="Ej. MQ-03"')}
    ${fld('Marca / modelo', 'modelo')}
    ${fld('Matrícula / nº de serie', 'matricula')}
    ${fld('Proveedor de alquiler', 'proveedor', 'placeholder="Empresa a la que se alquila"')}
    <div class="row">
      <div class="grow">${fld('Inicio alquiler', 'inicio_alquiler', 'type="date"')}</div>
      <div class="grow">${fld('Fin alquiler', 'fin_alquiler', 'type="date"')}</div>
    </div>
    ${area('Observaciones', 'observaciones')}
    <div id="eq-err"></div>
    <button class="btn block" data-enviar="editar" style="margin-top:14px">${e ? 'Guardar cambios' : 'Dar de alta'}</button>
    ${e ? btnVolver() : ''}`;
}

function eqFormEntregar(e) {
  const maq = e.categoria === 'maquinaria';
  return `
    <h2>Entregar / instalar</h2>
    <div class="field"><label>Destino</label>${subSet('dest', '🏗 En obra / uso propio')}</div>
    ${fld('Ubicación / zona (opcional)', 'ubicacion', 'placeholder="Ej. Bloque 3, acceso norte"')}
    ${fld('Fecha', 'fecha', 'type="date"')}
    ${fld('Entrega', 'entrega', 'placeholder="Nombre"')}
    ${fld(sheet.f.dest ? 'Recibe (persona de la subcontrata)' : 'Responsable en obra (opcional)', 'recibe', 'placeholder="Nombre"')}
    ${maq ? fld('Horómetro al entregar (h)', 'horas', 'inputmode="decimal"') : ''}
    ${area('Estado / observaciones', 'obs', maq ? 'Ej. depósito lleno, sin golpes' : '')}
    <div class="field"><label>Fotos de la entrega</label>${fotosPicker('fotos')}</div>
    <div id="eq-err"></div>
    <button class="btn block" data-enviar="entregar" style="margin-top:14px">Registrar entrega</button>
    ${btnVolver()}`;
}

function eqFormDevolver(e) {
  const pr = prestamoAbierto(e.id);
  const maq = e.categoria === 'maquinaria';
  return `
    <h2>Devolución / retirada</h2>
    <div class="muted small">${esc(destino(pr))} · entregado el ${fday(pr.fecha_entrega)}${pr.horas_inicio != null ? ` con ${fmt(pr.horas_inicio)} h` : ''}</div>
    ${fld('Fecha', 'fecha', 'type="date"')}
    ${fld(pr.subcontrata_id ? 'Devuelve (persona de la subcontrata)' : 'Entrega', 'devuelve', 'placeholder="Nombre"')}
    ${fld('Recibe', 'recibe', 'placeholder="Nombre"')}
    ${maq ? fld('Horómetro al devolver (h)', 'horas', 'inputmode="decimal"') : ''}
    <div class="field"><label>Estado en que vuelve</label>${segSet('danos', { false: '✔ Correcto', true: '✖ Con daños' })}</div>
    ${String(sheet.f.danos) === 'true' ? `
      <label class="toggle"><input type="checkbox" data-k="fuera" ${sheet.f.fuera ? 'checked' : ''}> Queda fuera de servicio</label>
      <p class="muted small">Se abrirá una incidencia de rotura a nombre de ${esc(pr.subcontrata_id ? subName(pr.subcontrata_id) : 'obra')} con estas fotos.</p>` : ''}
    ${area(String(sheet.f.danos) === 'true' ? 'Describe los daños *' : 'Observaciones', 'obs')}
    <div class="field"><label>Fotos de la devolución</label>${fotosPicker('fotos')}</div>
    <div id="eq-err"></div>
    <button class="btn block" data-enviar="devolver" style="margin-top:14px">Registrar devolución</button>
    ${btnVolver()}`;
}

function eqFormIncidencia() {
  const esSub = S.me.rol === 'subcontrata';
  return `
    <h2>Reportar incidencia</h2>
    <div class="field"><label>Tipo</label>${segSet('tipo', INC_TIPOS)}</div>
    ${fld('Fecha', 'fecha', 'type="date"')}
    ${area('Qué ha pasado *', 'desc', 'Ej. pierde aceite hidráulico; rotura del cristal de la cabina')}
    ${esSub ? '' : `<div class="field"><label>Responsable</label>${subSet('resp', 'Ninguno / Suncraft')}</div>`}
    <label class="toggle"><input type="checkbox" data-k="fuera" ${sheet.f.fuera ? 'checked' : ''}> El equipo queda fuera de servicio</label>
    <div class="field"><label>Fotos</label>${fotosPicker('fotos')}</div>
    <div id="eq-err"></div>
    <button class="btn warn block" data-enviar="incidencia" style="margin-top:14px">Enviar incidencia</button>
    ${btnVolver()}`;
}

function eqFormResolver() {
  const i = EQ.incidencias.find((x) => x.id === sheet.f.incId);
  return `
    <h2>${INC_TIPOS[i.tipo]} del ${fday(i.fecha)}</h2>
    <div class="small">${esc(i.descripcion)}</div>
    <div class="field"><label>Estado</label>${segSet('estado', INC_EST)}</div>
    ${sheet.f.estado === 'resuelta' ? fld('Fecha de resolución', 'fecha', 'type="date"')
      : `<label class="toggle"><input type="checkbox" data-k="fuera" ${sheet.f.fuera ? 'checked' : ''}> Fuera de servicio</label>`}
    ${area('Reparación / seguimiento', 'resolucion', 'Ej. cambiado latiguillo por el taller del proveedor')}
    ${fld('Coste (€, opcional)', 'coste', 'inputmode="decimal"')}
    <div class="field"><label>Fotos de la reparación</label>${fotosPicker('fotos')}</div>
    <div id="eq-err"></div>
    <button class="btn block" data-enviar="resolver" style="margin-top:14px">Guardar</button>
    ${btnVolver()}`;
}

/* --- Envío de los formularios --- */
async function enviarEq(accion, btn) {
  if (sheet.busy) return;
  const f = sheet.f, err = (m) => { $('#eq-err').innerHTML = `<div class="alert bad">${esc(m)}</div>`; };
  const e = eqById(sheet.id);
  // Validaciones
  if (accion === 'editar' && !f.nombre.trim()) return err('Indica el nombre del equipo.');
  if (accion === 'editar' && f.inicio_alquiler && f.fin_alquiler && f.fin_alquiler < f.inicio_alquiler) return err('El fin de alquiler es anterior al inicio.');
  if (accion === 'entregar' && (!f.fecha || !f.entrega.trim() || (f.dest && !f.recibe.trim()))) return err('Completa la fecha, quién entrega y quién recibe.');
  if (accion === 'devolver' && (!f.fecha || !f.devuelve.trim() || !f.recibe.trim())) return err('Completa la fecha, quién devuelve y quién recibe.');
  if (accion === 'devolver' && String(f.danos) === 'true' && !f.obs.trim()) return err('Describe los daños.');
  if (accion === 'incidencia' && !f.desc.trim()) return err('Describe qué ha pasado.');
  if (['entregar', 'devolver', 'incidencia'].includes(accion) && !f.fotos.length && !confirm('No has añadido fotos. ¿Guardar sin fotos?')) return;

  sheet.busy = true; btn.disabled = true;
  const txt = btn.textContent;
  const prog = (i, n) => { btn.textContent = `Subiendo fotos ${i}/${n}…`; };
  try {
    if (accion === 'editar') {
      const id = sheet.id || uuid();
      const fecha = (v) => v || null;
      await API.eqGuardar({ id, nombre: f.nombre.trim(), categoria: f.categoria, codigo: f.codigo.trim() || null, modelo: f.modelo.trim() || null,
        matricula: f.matricula.trim() || null, proveedor: f.proveedor.trim() || null, inicio_alquiler: fecha(f.inicio_alquiler),
        fin_alquiler: fecha(f.fin_alquiler), observaciones: f.observaciones.trim() || null });
      sheet.id = id;
    } else if (accion === 'entregar') {
      const fotos = await subirFotos(e.id, 'entrega', f.fotos, prog);
      await API.eqEntregar({ id: uuid(), equipo_id: e.id, subcontrata_id: f.dest || null, ubicacion: f.ubicacion.trim() || null, fecha_entrega: f.fecha,
        entregado_por: f.entrega.trim(), recibe: f.recibe.trim() || null, horas_inicio: f.horas === '' ? null : parseNum(f.horas), obs_entrega: f.obs.trim() || null, fotos_entrega: fotos });
      LS.set('nombre', f.entrega.trim());
    } else if (accion === 'devolver') {
      const fotos = await subirFotos(e.id, 'devolucion', f.fotos, prog);
      const danos = String(f.danos) === 'true';
      await API.eqDevolver({ prestamo_id: prestamoAbierto(e.id).id, fecha_devolucion: f.fecha, devuelve: f.devuelve.trim(), recibe_devolucion: f.recibe.trim(),
        horas_fin: f.horas === '' ? null : parseNum(f.horas), obs_devolucion: f.obs.trim() || null, fotos_devolucion: fotos, con_danos: danos,
        ...(danos ? { incidencia: { id: uuid(), fuera_servicio: !!f.fuera } } : {}) });
    } else if (accion === 'incidencia') {
      const fotos = await subirFotos(e.id, 'incidencia', f.fotos, prog);
      await API.eqIncidencia({ id: uuid(), equipo_id: e.id, tipo: f.tipo, fecha: f.fecha, descripcion: f.desc.trim(),
        subcontrata_id: f.resp || null, fuera_servicio: !!f.fuera, fotos });
    } else if (accion === 'resolver') {
      const fotos = await subirFotos(e.id, 'reparacion', f.fotos, prog);
      await API.eqActualizarInc(f.incId, { estado: f.estado, resuelta_fecha: f.fecha, resolucion: f.resolucion.trim(),
        coste: f.coste === '' ? null : parseNum(f.coste), fuera_servicio: !!f.fuera, fotos_resolucion: fotos });
    }
  } catch (er) {
    sheet.busy = false; btn.disabled = false; btn.textContent = txt;
    return err(isNetErr(er) ? 'Sin conexión: las fotos y los equipos necesitan cobertura. Vuelve a intentarlo cuando tengas señal.' : er.message);
  }
  sheet.busy = false;
  await loadEquipos();
  prepararForm('ver');
  renderSheet();
  renderEquiposList();
  toast({ editar: 'Equipo guardado', entregar: 'Entrega registrada', devolver: 'Devolución registrada', incidencia: 'Incidencia enviada', resolver: 'Incidencia actualizada' }[accion]);
}

async function bajaEquipo(alta) {
  const e = eqById(sheet.id);
  if (!alta && !confirm(`¿Dar de baja "${e.nombre}"? Queda en el historial pero no se podrá entregar.`)) return;
  try {
    await API.eqGuardar({ id: e.id, activo: !!alta, baja_fecha: alta ? null : today() });
    await loadEquipos(); renderSheet(); renderEquiposList();
    toast(alta ? 'Equipo dado de alta de nuevo' : 'Equipo dado de baja');
  } catch (er) { toast('Error: ' + er.message); }
}

/* --- Eventos de la hoja de equipo --- */
document.addEventListener('click', (ev) => {
  const t = ev.target;
  const eq = t.closest('[data-eq]'); if (eq) return abrirEquipo(eq.dataset.eq);
  const vis = t.closest('[data-visor]');
  if (vis && vis.src) { $('#visor').innerHTML = `<img src="${esc(vis.src)}" alt="Foto">`; $('#visor').hidden = false; return; }
  if (t.closest('#visor')) { $('#visor').hidden = true; return; }
  const acta = t.closest('[data-acta]'); if (acta) return imprimirActa(acta.dataset.acta);
  if (sheet?.kind !== 'equipo') return;
  const m = t.closest('[data-modo]'); if (m) { prepararForm(m.dataset.modo); return renderSheet(); }
  const rs = t.closest('[data-resolver]'); if (rs) { prepararForm('resolver', { incId: rs.dataset.resolver }); return renderSheet(); }
  const st = t.closest('[data-set]');
  if (st) {
    const [k, v] = st.dataset.set.split(':');
    sheet.f[k] = typeof sheet.f[k] === 'number' ? Number(v) : v;
    if (k === 'danos' && v === 'false') sheet.f.fuera = false;
    return renderSheet();
  }
  const fd = t.closest('[data-fdel]');
  if (fd) { const [k, i] = fd.dataset.fdel.split(':'); sheet.f[k].splice(Number(i), 1); return renderSheet(); }
  const en = t.closest('[data-enviar]'); if (en) return enviarEq(en.dataset.enviar, en);
  if (t.closest('[data-eqbaja]')) return bajaEquipo(false);
  if (t.closest('[data-eqalta]')) return bajaEquipo(true);
});
document.addEventListener('input', (ev) => {
  const k = ev.target.dataset?.k;
  if (k && sheet?.kind === 'equipo' && sheet.f) sheet.f[k] = ev.target.type === 'checkbox' ? ev.target.checked : ev.target.value;
});
document.addEventListener('change', async (ev) => {
  const k = ev.target.dataset?.k;
  if (k && ev.target.type === 'checkbox' && sheet?.f) sheet.f[k] = ev.target.checked;
  const key = ev.target.dataset?.fadd;
  if (!key || sheet?.kind !== 'equipo') return;
  const files = [...ev.target.files];
  const e = eqById(sheet.id);
  const etiqueta = { entregar: 'Entrega', devolver: 'Devolución', incidencia: 'Incidencia', resolver: 'Reparación' }[sheet.modo] || '';
  for (const file of files) {
    try { sheet.f[key].push(await procesarFoto(file, `${e?.nombre || ''} · ${etiqueta}`)); }
    catch (er) { toast(er.message); }
  }
  renderSheet();
});

/* ------------------------------------------------------------------ */
/* Acta imprimible de entrega / devolución con fotos                   */
/* ------------------------------------------------------------------ */
async function imprimirActa(prestamoId) {
  const p = EQ.prestamos.find((x) => x.id === prestamoId); if (!p) return;
  const e = eqById(p.equipo_id);
  const todas = [...(p.fotos_entrega || []), ...(p.fotos_devolucion || [])].filter((x) => !String(x).startsWith('data:') && !EQ.urls[x]);
  if (todas.length) { try { Object.assign(EQ.urls, await API.urlsFotos(todas)); } catch { /* se imprime sin las que falten */ } }
  const fotos = (arr) => (arr?.length ? `<div class="pv-fotos">${arr.map((x) => `<img src="${esc(fotoSrc(x))}">`).join('')}</div>` : '<p><i>Sin fotos</i></p>');
  const sub = p.subcontrata_id ? subName(p.subcontrata_id) : 'En obra / uso propio';
  $('#print-area').innerHTML = `
    <div class="pv">
      <div class="pv-head">
        <div><div class="pv-title">ACTA DE ${p.fecha_devolucion ? 'ENTREGA Y DEVOLUCIÓN' : 'ENTREGA'} DE EQUIPO</div>
          <div>${esc(S.ajustes.proyecto || CFG.PROYECTO || '')}</div></div>
        <div class="pv-num">${esc(e.codigo || '')}</div>
      </div>
      <table class="pv-info">
        <tr><th>Equipo</th><td>${esc(e.nombre)}</td><th>Tipo</th><td>${esc(CATS[e.categoria]?.[0] || '')}</td></tr>
        <tr><th>Modelo</th><td>${esc(e.modelo || '')}</td><th>Matrícula / serie</th><td>${esc(e.matricula || '')}</td></tr>
        <tr><th>Destino</th><td>${esc(sub)}</td><th>Ubicación</th><td>${esc(p.ubicacion || '')}</td></tr>
      </table>
      <h3>Entrega</h3>
      <table class="pv-info">
        <tr><th>Fecha</th><td>${fday(p.fecha_entrega)}</td><th>Horómetro</th><td>${p.horas_inicio != null ? fmt(p.horas_inicio) + ' h' : ''}</td></tr>
        <tr><th>Entrega</th><td>${esc(p.entregado_por || '')}</td><th>Recibe</th><td>${esc(p.recibe || '')}</td></tr>
        ${p.obs_entrega ? `<tr><th>Observaciones</th><td colspan="3">${esc(p.obs_entrega)}</td></tr>` : ''}
      </table>
      ${fotos(p.fotos_entrega)}
      ${p.fecha_devolucion ? `
        <h3>Devolución${p.con_danos ? ' — CON DAÑOS' : ''}</h3>
        <table class="pv-info">
          <tr><th>Fecha</th><td>${fday(p.fecha_devolucion)}</td><th>Horómetro</th><td>${p.horas_fin != null ? fmt(p.horas_fin) + ' h' : ''}</td></tr>
          <tr><th>Devuelve</th><td>${esc(p.devuelve || '')}</td><th>Recibe</th><td>${esc(p.recibe_devolucion || '')}</td></tr>
          ${p.obs_devolucion ? `<tr><th>Observaciones</th><td colspan="3">${esc(p.obs_devolucion)}</td></tr>` : ''}
        </table>
        ${fotos(p.fotos_devolucion)}` : ''}
    </div>`;
  // Esperar a que carguen las fotos antes de imprimir
  await Promise.all($$('#print-area img').map((i) => (i.complete ? null : new Promise((r) => { i.onload = i.onerror = r; }))));
  window.print();
}

/* ------------------------------------------------------------------ */
/* Hojas de equipos en el reporte Excel                                */
/* ------------------------------------------------------------------ */
async function hojasEquipos(wb) {
  try { await loadEquipos(); } catch { return; } // sin las tablas de equipos (esquema antiguo) el reporte sigue sin ellas
  if (!EQ.equipos.length) return;
  const d = (v) => (v ? new Date(v + 'T12:00:00') : '');
  const eqs = [['Equipo', 'Tipo', 'Código', 'Marca / modelo', 'Matrícula / nº serie', 'Proveedor', 'Inicio alquiler', 'Fin alquiler',
    'Estado', 'Dónde está', 'Desde', 'Días', 'Incidencias abiertas', 'Fuera de servicio']];
  for (const e of EQ.equipos) {
    const s = eqEstado(e);
    eqs.push([e.nombre, CATS[e.categoria]?.[0] || '', e.codigo || '', e.modelo || '', e.matricula || '', e.proveedor || '', d(e.inicio_alquiler), d(e.fin_alquiler),
      s.baja ? 'De baja' : s.p ? 'Entregado' : 'Disponible', s.p ? destino(s.p) : '', s.p ? d(s.p.fecha_entrega) : '',
      s.p ? diasEntre(s.p.fecha_entrega, today()) + 1 : '', s.inc.length, s.parada ? 'Sí' : 'No']);
  }
  const ws1 = sheetFrom(eqs, [30, 14, 10, 22, 18, 20, 11, 11, 11, 28, 11, 6, 10, 10]);
  fmtCols(ws1, eqs, [6, 7, 10], 'dd/mm/yyyy');
  XLSX.utils.book_append_sheet(wb, ws1, 'Equipos');

  const pr = [['Equipo', 'Tipo', 'Subcontrata', 'Ubicación', 'Fecha entrega', 'Entrega', 'Recibe', 'Horómetro inicio', 'Fotos entrega',
    'Fecha devolución', 'Devuelve', 'Recibe devolución', 'Horómetro fin', 'Horas de uso', 'Días', 'Con daños', 'Fotos devolución', 'Obs. entrega', 'Obs. devolución']];
  for (const p of EQ.prestamos.slice().sort((a, b) => a.fecha_entrega.localeCompare(b.fecha_entrega))) {
    const e = eqById(p.equipo_id) || {};
    pr.push([e.nombre || '', CATS[e.categoria]?.[0] || '', p.subcontrata_id ? subName(p.subcontrata_id) : 'En obra / uso propio', p.ubicacion || '',
      d(p.fecha_entrega), p.entregado_por || '', p.recibe || '', p.horas_inicio ?? '', (p.fotos_entrega || []).length,
      d(p.fecha_devolucion), p.devuelve || '', p.recibe_devolucion || '', p.horas_fin ?? '',
      p.horas_inicio != null && p.horas_fin != null ? round3(p.horas_fin - p.horas_inicio) : '',
      diasEntre(p.fecha_entrega, p.fecha_devolucion || today()) + 1, p.con_danos ? 'Sí' : 'No', (p.fotos_devolucion || []).length,
      p.obs_entrega || '', p.obs_devolucion || '']);
  }
  const ws2 = sheetFrom(pr, [30, 14, 16, 18, 11, 16, 16, 10, 7, 11, 16, 16, 10, 9, 6, 8, 7, 28, 28]);
  fmtCols(ws2, pr, [4, 9], 'dd/mm/yyyy');
  XLSX.utils.book_append_sheet(wb, ws2, 'Entregas equipos');

  const ic = [['Equipo', 'Tipo incidencia', 'Fecha', 'Descripción', 'Responsable', 'Fuera de servicio', 'Estado', 'Fecha resolución', 'Reparación / seguimiento', 'Coste (€)', 'Reportado por', 'Fotos']];
  for (const i of EQ.incidencias.slice().sort((a, b) => a.fecha.localeCompare(b.fecha))) {
    ic.push([eqById(i.equipo_id)?.nombre || '', INC_TIPOS[i.tipo], d(i.fecha), i.descripcion, i.subcontrata_id ? subName(i.subcontrata_id) : '',
      i.fuera_servicio ? 'Sí' : 'No', INC_EST[i.estado], d(i.resuelta_fecha), i.resolucion || '', i.coste ?? '', i.reportado_por || '',
      (i.fotos || []).length + (i.fotos_resolucion || []).length]);
  }
  const ws3 = sheetFrom(ic, [30, 13, 11, 40, 16, 9, 13, 11, 36, 10, 18, 7]);
  fmtCols(ws3, ic, [2, 7], 'dd/mm/yyyy');
  XLSX.utils.book_append_sheet(wb, ws3, 'Incidencias equipos');
}
