import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import { createClient } from '@supabase/supabase-js';

// =====================================================================
// CONTROL ECONÓMICO DE OBRAS — v2
// Facturas, cobros y pagos con imputación; cuentas corrientes de
// clientes, proveedores y empleados; posición del socio que lo lleva.
// =====================================================================
const CFG = window.OB_CONFIG || {};
const sb = CFG.supabaseUrl && CFG.supabaseAnonKey ? createClient(CFG.supabaseUrl, CFG.supabaseAnonKey) : null;
const BUCKET = 'ob-comprobantes';

// ---------- utilidades ----------
const fmtM = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const $ = v => fmtM.format(Number(v) || 0);
const n = v => Number(v) || 0;
const r2 = v => Math.round((Number(v) || 0) * 100) / 100;
const hoy = () => new Date().toLocaleDateString('en-CA');
const mesDe = f => (f || '').slice(0, 7);
const finDeMes = p => { const [y, m] = p.split('-').map(Number); const d = new Date(y, m, 0); return `${p}-${String(d.getDate()).padStart(2, '0')}`; };
const addDias = (f, d) => { const x = new Date(f + 'T12:00:00'); x.setDate(x.getDate() + d); return x.toLocaleDateString('en-CA'); };
const fD = f => (f ? f.split('-').reverse().join('/') : '');
const sum = (arr, fn) => arr.reduce((a, x) => a + n(fn(x)), 0);
const vivos = arr => arr.filter(x => !x.anulado);
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const mesLabel = p => { const [y, m] = p.split('-'); return `${MESES[Number(m) - 1]} ${y}`; };
const numCSV = v => String(r2(v)).replace('.', ',');
const cls = (...a) => a.filter(Boolean).join(' ');
const idN = v => (v === '' || v === null || v === undefined ? null : Number(v));

function mesesEntre(desde, hasta) {
  const out = []; let [y, m] = mesDe(desde).split('-').map(Number); const [yh, mh] = mesDe(hasta).split('-').map(Number);
  while (y < yh || (y === yh && m <= mh)) { out.push(`${y}-${String(m).padStart(2, '0')}`); m++; if (m > 12) { m = 1; y++; } }
  return out;
}

const ERRORES = {
  ob_cob_destino: 'Indicá una sola cuenta donde entró el dinero.',
  ob_cob_total: 'El cobro tiene que tener importe o retenciones.',
  ob_pag_quien: 'Indicá quién pagó: una cuenta de la sociedad o un socio.',
  ob_gas_prov: 'Indicá el proveedor.',
  ob_ing_iva_ok: 'El IVA no puede superar el total.',
  ob_gas_iva_ok: 'El IVA no puede superar el importe.',
  ob_tr_distintas: 'La cuenta de origen y la de destino tienen que ser distintas.',
  ob_terceros_tipo_nombre_key: 'Ya existe alguien con ese nombre en esa lista.',
};
function textoError(e) {
  const msg = (e && (e.message || e.details)) || String(e);
  for (const k of Object.keys(ERRORES)) if (msg.includes(k)) return ERRORES[k];
  if (/_anul_ok/.test(msg)) return 'Para anular hay que indicar el motivo.';
  if (/row-level security|permission denied/i.test(msg)) return 'Tu usuario no tiene permiso para esta operación.';
  if (/duplicate key/i.test(msg)) return 'Ya existe un registro con ese código o nombre.';
  return msg;
}

// ---------- acceso a datos ----------
const TABLAS = {
  socios: ['ob_socios', 'id'], cuentas: ['ob_cuentas', 'id'], categorias: ['ob_categorias', 'id'], obras: ['ob_obras', 'id'],
  reparto: ['ob_obra_reparto', 'obra_id'], param: ['ob_parametros', 'id'], terceros: ['ob_terceros', 'id'],
  ingresos: ['ob_ingresos', 'id'], cobros: ['ob_cobros', 'id'], cobroAplic: ['ob_cobro_aplic', 'id'],
  gastos: ['ob_gastos', 'id'], pagos: ['ob_pagos', 'id'], pagoAplic: ['ob_pago_aplic', 'id'], compromisos: ['ob_compromisos', 'id'],
  mov: ['ob_mov_socios', 'id'], transf: ['ob_transferencias', 'id'], liqs: ['ob_liquidaciones', 'id'],
  liqDet: ['ob_liquidacion_detalle', 'liquidacion_id'], cierres: ['ob_cierres', 'periodo'], reclamos: ['ob_reclamos', 'id'],
};

async function traerTabla(tabla, orden) {
  let out = [], desde = 0; const paso = 1000;
  for (;;) {
    const { data, error } = await sb.from(tabla).select('*').order(orden, { ascending: true }).range(desde, desde + paso - 1);
    if (error) throw new Error(`${tabla}: ${textoError(error)}`);
    out = out.concat(data || []);
    if (!data || data.length < paso) break;
    desde += paso;
  }
  return out;
}

async function traerTodo() {
  const claves = Object.keys(TABLAS);
  const res = await Promise.all(claves.map(k => traerTabla(TABLAS[k][0], TABLAS[k][1])));
  const d = {};
  claves.forEach((k, i) => { d[k] = res[i]; });
  d.param = d.param[0] || { fondo_reserva_pct: 0, fecha_corte: hoy(), empresa: 'Sociedad', socio_propio_id: null };
  const { data: perfiles } = await sb.from('ob_perfiles').select('user_id,nombre,rol,socio_id');
  d.perfiles = perfiles || [];
  d.X = indice(d);
  return d;
}

async function guardarFila(tabla, fila, id) {
  const q = id ? sb.from(tabla).update(fila).eq('id', id).select() : sb.from(tabla).insert(fila).select();
  const { data, error } = await q;
  if (error) throw new Error(textoError(error));
  if (!data || !data.length) throw new Error('No se guardó: tu usuario no tiene permiso para esta operación.');
  return data[0];
}

async function rpc(nombre, p) {
  const { data, error } = await sb.rpc(nombre, { p });
  if (error) throw new Error(textoError(error));
  if (data === null || data === undefined) throw new Error('La operación no devolvió resultado.');
  return data;
}

async function subirComprobante(file) {
  if (file.size > 10 * 1024 * 1024) throw new Error('El archivo supera 10 MB.');
  const ext = ((file.name.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '')) || 'bin';
  const path = `${mesDe(hoy())}/${crypto.randomUUID()}.${ext}`;
  const { error } = await sb.storage.from(BUCKET).upload(path, file, { contentType: file.type || undefined, upsert: false });
  if (error) throw new Error('No se pudo subir el comprobante: ' + error.message);
  return path;
}

async function verComprobante(path) {
  const w = window.open('', '_blank');
  const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(path, 300);
  if (error) { if (w) w.close(); throw new Error('No se pudo abrir el comprobante: ' + error.message); }
  if (w) w.location.href = data.signedUrl; else window.location.href = data.signedUrl;
}

function exportarCSV(nombre, columnas, filas) {
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const txt = [columnas.map(c => esc(c.label)).join(';'),
    ...filas.map(f => columnas.map(c => esc(c.csv ? c.csv(f) : f[c.k])).join(';'))].join('\n');
  const blob = new Blob(['\ufeff' + txt], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = `${nombre}-${hoy()}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1500);
}

// ---------- índice de imputaciones ----------
function indice(d) {
  const cobVivo = new Map(d.cobros.filter(c => !c.anulado).map(c => [c.id, c]));
  const pagVivo = new Map(d.pagos.filter(p => !p.anulado).map(p => [p.id, p]));
  const aplCob = d.cobroAplic.filter(a => cobVivo.has(a.cobro_id));
  const aplPag = d.pagoAplic.filter(a => pagVivo.has(a.pago_id));
  const acum = (arr, k) => { const m = new Map(); arr.forEach(a => m.set(a[k], (m.get(a[k]) || 0) + n(a.importe))); return m; };
  const cobradoIng = acum(aplCob, 'ingreso_id'), pagadoGas = acum(aplPag, 'gasto_id');
  const aplicadoCobro = acum(aplCob, 'cobro_id'), aplicadoPago = acum(aplPag, 'pago_id');
  const ingById = new Map(d.ingresos.map(i => [i.id, i])), gasById = new Map(d.gastos.map(g => [g.id, g]));
  const factor = c => { const t = n(c.importe) + n(c.retenciones); return t ? n(c.importe) / t : 0; };
  return {
    cobVivo, pagVivo, aplCob, aplPag, ingById, gasById, factor,
    cobrado: i => r2(cobradoIng.get(i.id) || 0),
    pagado: g => r2(pagadoGas.get(g.id) || 0),
    saldoIng: i => r2(n(i.bruto) - (cobradoIng.get(i.id) || 0)),
    saldoGas: g => r2(n(g.importe) - (pagadoGas.get(g.id) || 0)),
    restoCobro: c => r2(n(c.importe) + n(c.retenciones) - (aplicadoCobro.get(c.id) || 0)),
    restoPago: p => r2(n(p.importe) - (aplicadoPago.get(p.id) || 0)),
  };
}

function estadoIng(d, i) {
  if (i.anulado) return { t: 'Anulada', c: 'neu', k: 'anulado' };
  const s = d.X.saldoIng(i), c = d.X.cobrado(i);
  if (s <= 0.01) return { t: 'Cobrada', c: 'ok', k: 'cobrado' };
  if (i.fecha_estimada && i.fecha_estimada < hoy()) return { t: c > 0 ? 'Parcial, atrasada' : 'Atrasada', c: 'mal', k: c > 0 ? 'parcial' : 'pendiente' };
  return c > 0 ? { t: 'Cobro parcial', c: 'pend', k: 'parcial' } : { t: 'Pendiente', c: 'pend', k: 'pendiente' };
}
function estadoGas(d, g) {
  if (g.anulado) return { t: 'Anulado', c: 'neu', k: 'anulado' };
  const s = d.X.saldoGas(g), p = d.X.pagado(g);
  if (s <= 0.01) return { t: 'Pagado', c: 'ok', k: 'pagado' };
  if (g.vencimiento && g.vencimiento < hoy()) return { t: `Vencido ${fD(g.vencimiento)}`, c: 'mal', k: p > 0 ? 'parcial' : 'pendiente' };
  return { t: p > 0 ? 'Pago parcial' : (g.vencimiento ? `Vence ${fD(g.vencimiento)}` : 'Pendiente'), c: 'pend', k: p > 0 ? 'parcial' : 'pendiente' };
}

// ---------- cálculos ----------
function cajaCuentas(d, hasta = '9999-12-31') {
  return d.cuentas.map(c => {
    let s = n(c.saldo_inicial);
    d.X.cobVivo.forEach(x => { if (x.cuenta_id === c.id && x.fecha <= hasta) s += n(x.importe); });
    d.X.pagVivo.forEach(x => { if (x.pagado_por === 'sociedad' && x.cuenta_id === c.id && x.fecha <= hasta) s -= n(x.importe); });
    vivos(d.mov).forEach(m => { if (m.cuenta_id === c.id && m.fecha <= hasta) s += m.tipo === 'aporte' ? n(m.importe) : -n(m.importe); });
    vivos(d.transf).forEach(t => {
      if (t.fecha > hasta) return;
      if (t.cuenta_origen === c.id) s -= n(t.importe);
      if (t.cuenta_destino === c.id) s += n(t.importe);
    });
    return { ...c, saldo: r2(s) };
  });
}

function saldosSocios(d, hasta = '9999-12-31') {
  const aprobadas = new Set(d.liqs.filter(l => l.estado === 'aprobada' && l.fecha <= hasta).map(l => l.id));
  const cob = [...d.X.cobVivo.values()], pag = [...d.X.pagVivo.values()];
  return d.socios.map(s => {
    const mv = vivos(d.mov).filter(m => m.socio_id === s.id && m.fecha <= hasta);
    const t = tipo => sum(mv.filter(m => m.tipo === tipo), m => m.importe);
    const aportes = t('aporte'), reint = t('reintegro'), antic = t('anticipo'), pagos = t('pago_utilidades');
    const gastosPag = sum(pag.filter(p => p.pagado_por === 'socio' && p.socio_id === s.id && p.fecha <= hasta), p => p.importe);
    const cobrosRet = sum(cob.filter(c => c.socio_id === s.id && c.fecha <= hasta), c => c.importe);
    const asignadas = sum(d.liqDet.filter(x => x.socio_id === s.id && aprobadas.has(x.liquidacion_id)), x => x.importe);
    const saldoReint = r2(n(s.saldo_ini_reintegro) + aportes + gastosPag - cobrosRet - reint);
    const saldoUtil = r2(n(s.saldo_ini_utilidades) + asignadas - antic - pagos);
    return { socio: s, aportes, gastosPag, cobrosRet, reint, puso: aportes + gastosPag, asignadas, antic, pagos, retiros: antic + pagos, saldoReint, saldoUtil, total: r2(saldoReint + saldoUtil) };
  });
}

function pendientesLiquidar(d, obraId) {
  return d.X.aplCob.filter(a => !a.liquidacion_id && (d.X.ingById.get(a.ingreso_id) || {}).obra_id === obraId).map(a => {
    const c = d.X.cobVivo.get(a.cobro_id), i = d.X.ingById.get(a.ingreso_id);
    return { ...a, cobro: c, ingreso: i, caja: r2(n(a.importe) * d.X.factor(c)), iva: r2(n(i.bruto) ? n(a.importe) * n(i.iva) / n(i.bruto) : 0) };
  });
}

function resumenObras(d) {
  const aprob = d.liqs.filter(l => l.estado === 'aprobada');
  const genAsignados = sum(aprob, l => l.generales);
  return d.obras.map(o => {
    const ing = vivos(d.ingresos).filter(i => i.obra_id === o.id);
    const gas = vivos(d.gastos).filter(g => g.obra_id === o.id);
    const com = d.compromisos.filter(c => c.obra_id === o.id && c.estado === 'vigente');
    const la = aprob.filter(l => l.obra_id === o.id);
    const r = {
      obra: o,
      facturado: sum(ing, i => i.bruto),
      cobrado: sum(ing, i => d.X.cobrado(i)),
      porCobrar: sum(ing, i => d.X.saldoIng(i)),
      gastado: sum(gas, g => d.X.pagado(g)),
      pendiente: sum(gas, g => d.X.saldoGas(g)),
      compromisos: sum(com, c => c.importe),
      ingNeto: sum(ing, i => (n(i.bruto) ? d.X.cobrado(i) * (1 - n(i.iva) / n(i.bruto)) : 0)),
      gasNeto: sum(gas, g => n(g.importe) - n(g.iva_credito)),
      otrosImp: sum(la, l => l.otros_impuestos),
      generales: sum(la, l => l.generales),
      distribuido: sum(la, l => l.distribuible),
      sinLiquidar: o.es_general ? 0 : sum(pendientesLiquidar(d, o.id), a => a.caja),
    };
    if (o.es_general) {
      r.asignados = genAsignados;
      r.sinAsignar = r2(r.gasNeto + r.compromisos - genAsignados);
      r.resultado = r2(-r.sinAsignar);
      r.pendDistribuir = 0;
    } else {
      r.resultado = r2(r.ingNeto - r.gasNeto - r.compromisos - r.otrosImp - r.generales);
      r.pendDistribuir = r2(r.resultado - r.distribuido);
    }
    return r;
  });
}

function estadoReparto(d, obraId) {
  const filas = d.reparto.filter(x => x.obra_id === obraId);
  const total = r2(sum(filas, x => x.pct));
  return { filas, total, completo: Math.abs(total - 100) < 0.01, acordado: filas.length > 0 && filas.every(x => x.acordado) };
}

// Cuenta corriente. Clientes: saldo positivo = nos debe. Proveedores/empleados: saldo positivo = le debemos.
function ctaCte(d, t) {
  const mov = [];
  if (t.tipo === 'cliente') {
    vivos(d.ingresos).filter(i => i.tercero_id === t.id).forEach(i => mov.push({ k: 'i' + i.id, fecha: i.fecha, txt: `${i.nro_factura ? `Fact. ${i.nro_factura}` : 'Factura'} – ${i.concepto}`, debe: n(i.bruto), haber: 0 }));
    [...d.X.cobVivo.values()].filter(c => c.tercero_id === t.id).forEach(c => mov.push({ k: 'c' + c.id, fecha: c.fecha, txt: `Cobro${c.nro_recibo ? ` rec. ${c.nro_recibo}` : ''}${n(c.retenciones) ? ` (ret. ${$(c.retenciones)})` : ''}`, debe: 0, haber: n(c.importe) + n(c.retenciones) }));
  } else {
    vivos(d.gastos).filter(g => g.tercero_id === t.id).forEach(g => mov.push({ k: 'g' + g.id, fecha: g.fecha, txt: `${g.nro_comprobante ? `Comp. ${g.nro_comprobante}` : 'Gasto'} – ${g.concepto}`, debe: 0, haber: n(g.importe) }));
    [...d.X.pagVivo.values()].filter(p => p.tercero_id === t.id).forEach(p => mov.push({ k: 'p' + p.id, fecha: p.fecha, txt: `Pago${p.medio ? ` (${p.medio})` : ''}${p.pagado_por === 'socio' ? ` por ${(d.socios.find(s => s.id === p.socio_id) || {}).nombre}` : ''}`, debe: n(p.importe), haber: 0 }));
  }
  mov.sort((a, b) => a.fecha.localeCompare(b.fecha) || a.k.localeCompare(b.k));
  let s = 0;
  const signo = t.tipo === 'cliente' ? 1 : -1;
  mov.forEach(m => { s += signo * (m.debe - m.haber); m.saldo = r2(s); });
  const pendientes = t.tipo === 'cliente'
    ? vivos(d.ingresos).filter(i => i.tercero_id === t.id && d.X.saldoIng(i) > 0.01)
    : vivos(d.gastos).filter(g => g.tercero_id === t.id && d.X.saldoGas(g) > 0.01);
  const aCuenta = t.tipo === 'cliente'
    ? [...d.X.cobVivo.values()].filter(c => c.tercero_id === t.id && d.X.restoCobro(c) > 0.01)
    : [...d.X.pagVivo.values()].filter(p => p.tercero_id === t.id && d.X.restoPago(p) > 0.01);
  return { mov, saldo: r2(s), pendientes, aCuenta };
}

function calcularAlertas(d, socios, cajas) {
  const out = []; const h = hoy(); const en7 = addDias(h, 7);
  const g = vivos(d.gastos);
  const sinComp = g.filter(x => x.tipo_comprobante === 'sin_comprobante' || (x.tipo_comprobante !== 'saldo_inicial' && !x.comprobante_path && !x.nro_comprobante));
  if (sinComp.length) out.push({ nivel: 'alta', txt: `${sinComp.length} gasto(s) sin comprobante o sin número`, ir: 'compras' });
  const vencG = g.filter(x => x.vencimiento && x.vencimiento < h && d.X.saldoGas(x) > 0.01);
  const vencC = d.compromisos.filter(c => c.estado === 'vigente' && c.vencimiento && c.vencimiento < h);
  if (vencG.length + vencC.length) out.push({ nivel: 'alta', txt: `${vencG.length + vencC.length} deuda(s) vencida(s) por ${$(sum(vencG, x => d.X.saldoGas(x)) + sum(vencC, x => x.importe))}`, ir: 'compromisos' });
  const proxG = g.filter(x => x.vencimiento && x.vencimiento >= h && x.vencimiento <= en7 && d.X.saldoGas(x) > 0.01);
  const proxC = d.compromisos.filter(c => c.estado === 'vigente' && c.vencimiento && c.vencimiento >= h && c.vencimiento <= en7);
  if (proxG.length + proxC.length) out.push({ nivel: 'media', txt: `${proxG.length + proxC.length} deuda(s) vencen en los próximos 7 días`, ir: 'compromisos' });
  cajas.filter(c => c.saldo < 0).forEach(c => out.push({ nivel: 'alta', txt: `La cuenta ${c.nombre} da saldo negativo (${$(c.saldo)}): falta cargar algún cobro o aporte`, ir: 'caja' }));
  const ingVenc = vivos(d.ingresos).filter(i => i.fecha_estimada && i.fecha_estimada < h && d.X.saldoIng(i) > 0.01);
  if (ingVenc.length) out.push({ nivel: 'media', txt: `${ingVenc.length} factura(s) de venta con cobro atrasado por ${$(sum(ingVenc, i => d.X.saldoIng(i)))}`, ir: 'ventas' });
  const sinLiq = sum(d.obras.filter(o => !o.es_general), o => sum(pendientesLiquidar(d, o.id), a => a.caja));
  if (sinLiq > 0.01) out.push({ nivel: 'media', txt: `Cobros sin liquidar por ${$(sinLiq)}`, ir: 'liquidaciones' });
  const cobAC = [...d.X.cobVivo.values()].filter(c => d.X.restoCobro(c) > 0.01);
  const pagAC = [...d.X.pagVivo.values()].filter(p => p.tercero_id && d.X.restoPago(p) > 0.01);
  if (cobAC.length) out.push({ nivel: 'baja', txt: `${cobAC.length} cobro(s) con saldo sin imputar a facturas (${$(sum(cobAC, c => d.X.restoCobro(c)))})`, ir: 'ventas' });
  if (pagAC.length) out.push({ nivel: 'baja', txt: `${pagAC.length} pago(s) a cuenta o adelantos sin imputar (${$(sum(pagAC, p => d.X.restoPago(p)))})`, ir: 'compras' });
  d.obras.filter(o => !o.es_general && o.estado === 'activa').forEach(o => {
    const er = estadoReparto(d, o.id);
    if (!er.completo) out.push({ nivel: 'media', txt: `${o.nombre}: falta cargar el reparto entre socios (suma ${er.total}%)`, ir: 'config' });
  });
  socios.filter(s => s.saldoUtil < 0).forEach(s => out.push({ nivel: 'media', txt: `${s.socio.nombre} retiró ${$(-s.saldoUtil)} más de las utilidades liquidadas`, ir: 'socios' }));
  const vistos = new Set(); let dup = 0;
  g.forEach(x => { const k = `${x.tercero_id || (x.proveedor || '').trim().toLowerCase()}|${r2(x.importe)}|${x.fecha}`; if (vistos.has(k)) dup++; else vistos.add(k); });
  if (dup) out.push({ nivel: 'media', txt: `${dup} posible(s) gasto(s) duplicado(s)`, ir: 'compras' });
  const recl = d.reclamos.filter(r => r.estado === 'pendiente');
  if (recl.length) out.push({ nivel: 'media', txt: `${recl.length} reclamo(s) sin respuesta`, ir: 'reclamos' });
  const actual = mesDe(h);
  const abiertos = mesesEntre(d.param.fecha_corte || h, h).filter(p => p < actual && !d.cierres.some(c => c.periodo === p));
  if (abiertos.length) out.push({ nivel: 'media', txt: `Mes(es) sin cerrar: ${abiertos.map(mesLabel).join(', ')}`, ir: 'cierre' });
  const sinEnvio = d.cierres.filter(c => c.respuesta === 'sin_envio');
  if (sinEnvio.length) out.push({ nivel: 'baja', txt: `Resumen no enviado a los socios: ${sinEnvio.map(c => mesLabel(c.periodo)).join(', ')}`, ir: 'cierre' });
  return out;
}

function pctVerificado(d) {
  const todos = [...vivos(d.ingresos), ...vivos(d.gastos), ...d.X.cobVivo.values(), ...d.X.pagVivo.values()];
  if (!todos.length) return 100;
  return Math.round(100 * todos.filter(x => x.fuente === 'verificado').length / todos.length);
}

// ---------- componentes comunes ----------
function Modal({ titulo, onClose, children, pie, ancho }) {
  useEffect(() => {
    const k = e => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="velo" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={cls('modal', ancho && 'ancho')} role="dialog" aria-modal="true" aria-label={titulo}>
        <header><h2>{titulo}</h2><button className="x" onClick={onClose} aria-label="Cerrar">×</button></header>
        <div className="cuerpo">{children}</div>
        {pie && <footer>{pie}</footer>}
      </div>
    </div>
  );
}

function Campo({ c, v, set }) {
  const id = 'f_' + c.k;
  const lab = <label htmlFor={id}>{c.label}{c.req && <i> *</i>}</label>;
  let inp;
  if (c.tipo === 'select') {
    const cambiar = async e => {
      const val = e.target.value;
      const nv = (c.nuevos || []).find(x => x.v === val);
      if (!nv) { set(c.k, val); return; }
      try { const nid = await nv.fn(); if (nid) set(c.k, String(nid)); }
      catch (err) { window.alert(textoError(err)); }
    };
    inp = (
      <select id={id} value={v ?? ''} onChange={cambiar}>
        {!c.sinVacio && <option value="">{c.vacio || 'Elegir…'}</option>}
        {c.opciones.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}
        {(c.nuevos || []).map(o => <option key={o.v} value={o.v}>{o.l}</option>)}
      </select>
    );
  } else if (c.tipo === 'textarea') {
    inp = <textarea id={id} rows={2} value={v ?? ''} onChange={e => set(c.k, e.target.value)} />;
  } else if (c.tipo === 'file') {
    inp = <input id={id} type="file" accept="image/*,application/pdf" onChange={e => set(c.k, e.target.files[0] || null)} />;
  } else if (c.tipo === 'check') {
    return (
      <div className={cls('campo', 'check', c.full && 'full')}>
        <input id={id} type="checkbox" checked={!!v} onChange={e => set(c.k, e.target.checked)} />
        <label htmlFor={id}>{c.label}</label>
      </div>
    );
  } else {
    inp = <input id={id} type={c.tipo || 'text'} step={c.tipo === 'number' ? '0.01' : undefined} inputMode={c.tipo === 'number' ? 'decimal' : undefined}
      value={v ?? ''} onChange={e => set(c.k, e.target.value)} />;
  }
  return <div className={cls('campo', c.full && 'full')}>{lab}{inp}{c.ayuda && <span className="ay">{c.ayuda}</span>}</div>;
}

function FormModal({ titulo, campos, inicial, validar, onGuardar, onClose, extra }) {
  const [f, setF] = useState(inicial);
  const [err, setErr] = useState('');
  const [enviando, setEnviando] = useState(false);
  const set = useCallback((k, v) => setF(p => ({ ...p, [k]: v })), []);
  const visibles = campos.filter(c => !c.visible || c.visible(f));
  const guardar = async () => {
    setErr('');
    const falta = visibles.filter(c => c.req && (f[c.k] === '' || f[c.k] === null || f[c.k] === undefined));
    if (falta.length) { setErr('Completá: ' + falta.map(c => c.label).join(', ')); return; }
    const e = validar ? validar(f) : '';
    if (e) { setErr(e); return; }
    setEnviando(true);
    try { await onGuardar(f); onClose(); }
    catch (x) { setErr(textoError(x)); }
    finally { setEnviando(false); }
  };
  return (
    <Modal titulo={titulo} onClose={onClose} pie={<>
      <button className="btn sec" onClick={onClose}>Cancelar</button>
      <button className="btn" onClick={guardar} disabled={enviando}>{enviando ? 'Guardando…' : 'Guardar'}</button>
    </>}>
      {err && <div className="error" role="alert">{err}</div>}
      {extra && extra(f)}
      <div className="campos">{visibles.map(c => <Campo key={c.k} c={c} v={f[c.k]} set={set} />)}</div>
    </Modal>
  );
}

function Tabla({ columnas, filas, onFila, vacio, pie, claseFila }) {
  if (!filas.length) return <div className="vacio">{vacio || 'No hay registros.'}</div>;
  return (
    <div className="scroll">
      <table>
        <thead><tr>{columnas.map(c => <th key={c.k} className={c.der ? 'der' : ''}>{c.label}</th>)}</tr></thead>
        <tbody>
          {filas.map((f, i) => (
            <tr key={f.id ?? i} className={cls(onFila && 'clic', claseFila && claseFila(f))} onClick={onFila ? () => onFila(f) : undefined}>
              {columnas.map(c => <td key={c.k} className={c.der ? 'der' : ''}>{c.render ? c.render(f) : f[c.k]}</td>)}
            </tr>
          ))}
        </tbody>
        {pie && <tfoot><tr>{columnas.map(c => <td key={c.k} className={c.der ? 'der' : ''}>{pie[c.k] ?? ''}</td>)}</tr></tfoot>}
      </table>
    </div>
  );
}

function Filtros({ f, set, obras, estados, conMes = true, conAnulados = true }) {
  return (
    <div className="filtros">
      <input placeholder="Buscar…" value={f.q} onChange={e => set({ ...f, q: e.target.value })} aria-label="Buscar" />
      {obras && <select value={f.obra} onChange={e => set({ ...f, obra: e.target.value })} aria-label="Obra">
        <option value="">Todas las obras</option>
        {obras.map(o => <option key={o.id} value={o.id}>{o.nombre}</option>)}
      </select>}
      {estados && (
        <select value={f.estado} onChange={e => set({ ...f, estado: e.target.value })} aria-label="Estado">
          <option value="">Todos los estados</option>
          {estados.map(s => <option key={s.v} value={s.v}>{s.l}</option>)}
        </select>
      )}
      {conMes && <input type="month" value={f.mes} onChange={e => set({ ...f, mes: e.target.value })} aria-label="Mes" />}
      {conAnulados && <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 14 }}>
        <input type="checkbox" checked={f.anulados} onChange={e => set({ ...f, anulados: e.target.checked })} /> Ver anulados
      </label>}
    </div>
  );
}
const FILTRO0 = { q: '', obra: '', estado: '', mes: '', anulados: false };

function Chip({ t, c }) { return <span className={cls('chip', c)}>{t}</span>; }
const Neg = ({ v }) => <span className={n(v) < 0 ? 'neg' : ''}>{$(v)}</span>;

async function anular(tabla, fila, notify, recargar) {
  const motivo = window.prompt('Motivo de la anulación (queda registrado):');
  if (motivo === null) return;
  if (!motivo.trim()) { notify('Hay que indicar un motivo para anular.', true); return; }
  try { await guardarFila(tabla, { anulado: true, motivo_anulacion: motivo.trim() }, fila.id); notify('Registro anulado.'); recargar(); }
  catch (e) { notify(textoError(e), true); }
}


// ---------- helpers de formularios ----------
const FUENTES = [{ v: 'verificado', l: 'Verificado con comprobante' }, { v: 'informado', l: 'Informado por un socio' }, { v: 'estimado', l: 'Estimado' }];
const COMP_VENTA = [{ v: 'factura_a', l: 'Factura A' }, { v: 'factura_b', l: 'Factura B' }, { v: 'factura_c', l: 'Factura C' }, { v: 'certificado', l: 'Certificado de obra' }, { v: 'saldo_inicial', l: 'Saldo inicial al corte' }, { v: 'otro', l: 'Otro' }];
const COMP_GASTO = [{ v: 'factura_a', l: 'Factura A' }, { v: 'factura_b', l: 'Factura B' }, { v: 'factura_c', l: 'Factura C' }, { v: 'recibo', l: 'Recibo' }, { v: 'recibo_sueldo', l: 'Recibo de sueldo / jornal' }, { v: 'ticket', l: 'Ticket' }, { v: 'saldo_inicial', l: 'Saldo inicial al corte' }, { v: 'sin_comprobante', l: 'Sin comprobante' }];
const MEDIOS = [{ v: 'transferencia', l: 'Transferencia' }, { v: 'efectivo', l: 'Efectivo' }, { v: 'cheque', l: 'Cheque' }, { v: 'echeq', l: 'E-cheq' }, { v: 'otro', l: 'Otro' }];
const TIPOS_MOV = [
  { v: 'aporte', l: 'Aporte: el socio pone dinero en una cuenta de la sociedad' },
  { v: 'reintegro', l: 'Reintegro: la sociedad le devuelve lo que puso' },
  { v: 'anticipo', l: 'Anticipo de utilidades: retiro personal sin liquidación' },
  { v: 'pago_utilidades', l: 'Pago de utilidades ya liquidadas' },
];
const TIPO_MOV_CORTO = { aporte: 'Aporte', reintegro: 'Reintegro', anticipo: 'Anticipo de utilidades', pago_utilidades: 'Pago de utilidades' };
const TIPO_TER = { cliente: 'Cliente', proveedor: 'Proveedor', empleado: 'Empleado' };
const compLabel = (lista, v) => (lista.find(x => x.v === v) || {}).l || v;

function lookups(d) {
  const m = arr => new Map(arr.map(x => [x.id, x]));
  const O = m(d.obras), C = m(d.cuentas), S = m(d.socios), K = m(d.categorias), T = m(d.terceros);
  return {
    obra: id => (O.get(id) || {}).nombre || '—', obraObj: id => O.get(id),
    cuenta: id => (C.get(id) || {}).nombre || '—', socio: id => (S.get(id) || {}).nombre || '—',
    cat: id => (K.get(id) || {}).nombre || '—', ter: id => (T.get(id) || {}).nombre || '', terObj: id => T.get(id),
  };
}
function obrasOpc(d, conGeneral, incluirId) {
  return d.obras.filter(o => (conGeneral || !o.es_general) && (o.estado === 'activa' || o.id === Number(incluirId)))
    .map(o => ({ v: String(o.id), l: o.es_general ? `${o.nombre} (sin obra)` : o.nombre }));
}
function destinoOpc(d, verboSocio) {
  return [
    ...d.cuentas.filter(c => c.activa).map(c => ({ v: `c:${c.id}`, l: `Sociedad: ${c.nombre}` })),
    ...d.socios.filter(s => s.activo).map(s => ({ v: `s:${s.id}`, l: `${s.nombre} (${verboSocio})` })),
  ];
}
function terceroOpc(d, tipos, incluirId) {
  return d.terceros.filter(t => tipos.includes(t.tipo) && (t.activo || t.id === Number(incluirId)))
    .sort((a, b) => a.nombre.localeCompare(b.nombre))
    .map(t => ({ v: String(t.id), l: tipos.length > 1 ? `${t.nombre} (${TIPO_TER[t.tipo].toLowerCase()})` : t.nombre }));
}
async function crearTercero(ctx, tipo) {
  const nombre = window.prompt(`Nombre del nuevo ${TIPO_TER[tipo].toLowerCase()}:`);
  if (!nombre || !nombre.trim()) return null;
  const fila = await guardarFila('ob_terceros', { tipo, nombre: nombre.trim() });
  await ctx.recargar();
  ctx.notify(`${TIPO_TER[tipo]} creado.`);
  return fila.id;
}
function filtrar(arr, f, fechaFn, textoFn, estadoFn) {
  const q = (f.q || '').trim().toLowerCase();
  return arr.filter(x => (f.anulados || !x.anulado) && (!f.obra || String(x.obra_id) === f.obra) &&
    (!f.estado || (estadoFn ? estadoFn(x) : x.estado) === f.estado) && (!f.mes || mesDe(fechaFn(x)) === f.mes) &&
    (!q || textoFn(x).toLowerCase().includes(q)));
}
const porFechaDesc = k => (a, b) => (b[k] || '').localeCompare(a[k] || '') || b.id - a.id;
const porFechaAsc = k => (a, b) => (a[k] || '').localeCompare(b[k] || '') || a.id - b.id;
const splitDestino = v => { const [t, id] = (v || '').split(':'); return { cuenta_id: t === 'c' ? Number(id) : null, socio_id: t === 's' ? Number(id) : null }; };

function ListaAlertas({ alertas, ir }) {
  if (!alertas.length) return <p style={{ margin: 0 }}>Sin alertas.</p>;
  return (
    <ul className="alertas">
      {alertas.map((a, i) => (
        <li key={i}><span className={cls('m', a.nivel)} aria-label={a.nivel} />
          <span>{a.txt} <button className="link" onClick={() => ir(a.ir)}>Revisar</button></span></li>
      ))}
    </ul>
  );
}

// ---------- MI POSICIÓN ----------
function Posicion({ ctx }) {
  const { d, L, ir } = ctx;
  const sp = d.socios.find(s => s.id === d.param.socio_propio_id);
  const socios = useMemo(() => saldosSocios(d), [d]);
  const cajas = useMemo(() => cajaCuentas(d), [d]);
  const obras = useMemo(() => resumenObras(d), [d]);
  const alertas = useMemo(() => calcularAlertas(d, socios, cajas), [d, socios, cajas]);
  const [reclamo, setReclamo] = useState(null);
  if (!sp) return (
    <div className="bloque"><div className="cuerpo">
      <h2>Falta indicar quién lleva el sistema</h2>
      <p>En Configuración &gt; Parámetros elegí el socio para ver su posición.</p>
      <button className="btn" onClick={() => ir('config')}>Ir a Configuración</button>
    </div></div>
  );
  const s = socios.find(x => x.socio.id === sp.id);
  const aprob = d.liqs.filter(l => l.estado === 'aprobada');
  const pagadoLiq = liqId => sum(vivos(d.mov).filter(m => m.socio_id === sp.id && m.tipo === 'pago_utilidades' && m.liquidacion_id === liqId), m => m.importe);
  const miLiq = aprob.map(l => {
    const det = d.liqDet.find(x => x.liquidacion_id === l.id && x.socio_id === sp.id);
    const calc = det ? n(det.importe) : 0; const cob = pagadoLiq(l.id);
    return { ...l, calc, cob, dif: r2(calc - cob) };
  }).filter(l => l.calc > 0).sort((a, b) => b.id - a.id);
  const porObra = obras.filter(o => !o.obra.es_general && (o.facturado || o.gastado || o.pendiente || o.obra.estado === 'activa')).map(o => {
    const rp = d.reparto.find(x => x.obra_id === o.obra.id && x.socio_id === sp.id);
    const pct = rp ? n(rp.pct) : null;
    const liq = sum(miLiq.filter(l => l.obra_id === o.obra.id), l => l.calc);
    const cob = sum(miLiq.filter(l => l.obra_id === o.obra.id), l => l.cob);
    return { ...o, id: o.obra.id, pct, acordado: rp && rp.acordado, miParte: pct === null ? null : r2(o.resultado * pct / 100), liq, cob };
  });
  const recl = d.reclamos.filter(r => r.estado === 'pendiente' && (!r.socio_id || r.socio_id !== sp.id));
  const verif = pctVerificado(d);

  return (
    <>
      <div className="cab">
        <div><h1>Posición de {sp.nombre}</h1><p>En {d.param.empresa || 'la sociedad'} al {fD(hoy())}. Información verificada con comprobante: {verif}%.</p></div>
        <div className="acciones"><button className="btn sec" onClick={() => window.print()}>Imprimir</button></div>
      </div>
      <div className="franja">
        <div><div className="q">Puse</div><div className="v">{$(s.puso)}</div><div className="d">Aportes y pagos con mi dinero</div></div>
        <div><div className="q">Me devolvieron</div><div className="v">{$(s.reint)}</div><div className="d">Reintegros recibidos</div></div>
        <div><div className="q">Me deben (reintegro)</div><div className={cls('v', s.saldoReint < 0 && 'neg')}>{$(s.saldoReint)}</div><div className="d">Incluye saldo inicial {$(sp.saldo_ini_reintegro)}</div></div>
        <div><div className="q">Utilidades liquidadas</div><div className="v">{$(s.asignadas)}</div><div className="d">Según mis liquidaciones</div></div>
        <div><div className="q">Retiré</div><div className="v">{$(s.retiros)}</div><div className="d">Anticipos y pagos de utilidades</div></div>
        <div className="clave"><div className="q">Total a cobrar</div><div className={cls('v', s.total < 0 && 'neg')}>{$(s.total)}</div><div className="d">Reintegro más utilidades sin cobrar</div></div>
      </div>

      <div className="grid2">
        <section className="bloque">
          <header><h3>Mi parte por obra</h3><span className="sub">Resultado sin IVA según lo cargado</span></header>
          <Tabla filas={porObra} vacio="No hay obras cargadas." columnas={[
            { k: 'n', label: 'Obra', render: o => o.obra.nombre },
            { k: 'r', label: 'Resultado', der: true, render: o => <Neg v={o.resultado} /> },
            { k: 'p', label: 'Mi %', der: true, render: o => o.pct === null ? <Chip t="Sin cargar" c="mal" /> : <>{o.pct}%{!o.acordado && <span className="sub">propuesto</span>}</> },
            { k: 'm', label: 'Mi parte', der: true, render: o => o.miParte === null ? '—' : <strong><Neg v={o.miParte} /></strong> },
            { k: 'l', label: 'Liquidado', der: true, render: o => $(o.liq) },
            { k: 'c', label: 'Cobrado', der: true, render: o => $(o.cob) },
          ]} />
        </section>
        <section className="bloque">
          <header><h3>Alertas</h3><span className="chip neu">{alertas.length}</span></header>
          <div className="cuerpo"><ListaAlertas alertas={alertas} ir={ir} /></div>
        </section>
      </div>

      <section className="bloque">
        <header><h3>Liquidaciones: calculado contra cobrado</h3><button className="link" onClick={() => ir('liquidaciones')}>Ver liquidaciones</button></header>
        <Tabla filas={miLiq} vacio="Todavía no hay liquidaciones aprobadas con importe para vos." columnas={[
          { k: 'id', label: '#' },
          { k: 'f', label: 'Fecha', render: l => fD(l.fecha) },
          { k: 'o', label: 'Obra', render: l => L.obra(l.obra_id) },
          { k: 'c', label: 'Me corresponde', der: true, render: l => $(l.calc) },
          { k: 'b', label: 'Me pagaron', der: true, render: l => $(l.cob) },
          { k: 'd', label: 'Diferencia', der: true, render: l => Math.abs(l.dif) <= 1 ? <Chip t="OK" c="ok" /> : <strong className="neg">{$(l.dif)}</strong> },
          { k: 'a', label: '', render: l => l.dif > 1 && ctx.puede ? <button className="btn sec chico" onClick={() => setReclamo({ fecha: hoy(), socio_id: '', concepto: `Diferencia en liquidación #${l.id} (${L.obra(l.obra_id)})`, importe: String(l.dif), medio: '', estado: 'pendiente', respuesta: '', fecha_respuesta: '', obs: '' })}>Reclamar</button> : null },
        ]} />
      </section>

      <section className="bloque">
        <header><h3>Reclamos pendientes</h3><button className="link" onClick={() => ir('reclamos')}>Ver reclamos</button></header>
        <Tabla filas={recl} vacio="No hay reclamos pendientes." columnas={[
          { k: 'f', label: 'Fecha', render: r => fD(r.fecha) },
          { k: 's', label: 'A', render: r => r.socio_id ? L.socio(r.socio_id) : 'Todos' },
          { k: 'c', label: 'Concepto', render: r => r.concepto },
          { k: 'i', label: 'Importe', der: true, render: r => r.importe ? $(r.importe) : '' },
        ]} pie={{ f: 'Total', i: $(sum(recl, r => r.importe)) }} />
      </section>
      {reclamo && <FormReclamo ctx={ctx} inicial={reclamo} onClose={() => setReclamo(null)} />}
    </>
  );
}

// ---------- SOCIEDAD ----------
function Sociedad({ ctx }) {
  const { d, ir } = ctx;
  const [per, setPer] = useState(mesDe(hoy()));
  const cajas = useMemo(() => cajaCuentas(d), [d]);
  const socios = useMemo(() => saldosSocios(d), [d]);
  const obras = useMemo(() => resumenObras(d), [d]);
  const meses = mesesEntre(d.param.fecha_corte || hoy(), hoy()).reverse();
  const enPer = f => f && (per === 'acum' || mesDe(f) === per);
  const cob = [...d.X.cobVivo.values()], pag = [...d.X.pagVivo.values()];
  const entro = sum(cob.filter(c => enPer(c.fecha)), c => c.importe);
  const salio = sum(pag.filter(p => enPer(p.fecha)), p => p.importe);
  const nosDeben = sum(vivos(d.ingresos), i => d.X.saldoIng(i));
  const debemosF = sum(vivos(d.gastos), g => d.X.saldoGas(g));
  const cv = sum(d.compromisos.filter(c => c.estado === 'vigente'), c => c.importe);
  const caja = sum(cajas, c => c.saldo);
  const debeSocios = sum(socios.filter(s => s.saldoReint > 0), s => s.saldoReint);
  const utilSinRetirar = sum(socios.filter(s => s.saldoUtil > 0), s => s.saldoUtil);
  const libre = r2(caja - debemosF - cv - debeSocios - utilSinRetirar);
  const general = obras.find(o => o.obra.es_general);
  const obrasVis = obras.filter(o => !o.obra.es_general && (o.obra.estado === 'activa' || o.facturado || o.gastado || o.pendiente));

  return (
    <>
      <div className="cab">
        <div><h1>{d.param.empresa || 'Sociedad'}</h1><p>Según la información cargada al {fD(hoy())}. Verificado: {pctVerificado(d)}%.</p></div>
        <div className="acciones">
          <select value={per} onChange={e => setPer(e.target.value)} aria-label="Período" className="btn sec">
            {meses.map(m => <option key={m} value={m}>{mesLabel(m)}</option>)}
            <option value="acum">Acumulado desde el corte</option>
          </select>
          <button className="btn sec" onClick={() => window.print()}>Imprimir</button>
        </div>
      </div>
      <div className="franja">
        <div><div className="q">¿Cuánto entró?</div><div className="v">{$(entro)}</div><div className="d">Cobros {per === 'acum' ? 'desde el corte' : `de ${mesLabel(per)}`}</div></div>
        <div><div className="q">¿Cuánto se pagó?</div><div className="v">{$(salio)}</div><div className="d">Pagos del período</div></div>
        <div><div className="q">¿Cuánto nos deben?</div><div className="v">{$(nosDeben)}</div><div className="d">Saldo de clientes</div></div>
        <div><div className="q">¿Qué debemos?</div><div className="v neg">{$(debemosF + cv)}</div><div className="d">Proveedores y empleados {$(debemosF)} · compromisos {$(cv)}</div></div>
        <div><div className="q">¿Cuánto hay en caja?</div><div className={cls('v', caja < 0 && 'neg')}>{$(caja)}</div><div className="d">Suma de cuentas</div></div>
        <div className="clave"><div className="q">¿Cuánto está libre?</div><div className={cls('v', libre < 0 && 'neg')}>{$(libre)}</div><div className="d">Caja menos deudas y saldos de socios</div></div>
      </div>

      <section className="bloque">
        <header><h3>Socios</h3><button className="link" onClick={() => ir('socios')}>Ver movimientos</button></header>
        <Tabla filas={socios.map(s => ({ ...s, id: s.socio.id }))} columnas={[
          { k: 'n', label: 'Socio', render: s => s.socio.nombre },
          { k: 'puso', label: 'Puso', der: true, render: s => $(s.puso) },
          { k: 'dev', label: 'Le devolvieron', der: true, render: s => $(s.reint) },
          { k: 'deb', label: 'Se le debe', der: true, render: s => <Neg v={s.saldoReint} /> },
          { k: 'asig', label: 'Utilidad liquidada', der: true, render: s => $(s.asignadas) },
          { k: 'ret', label: 'Retiró', der: true, render: s => $(s.retiros) },
          { k: 'su', label: 'Utilidad sin cobrar', der: true, render: s => <Neg v={s.saldoUtil} /> },
          { k: 'tot', label: 'Total a su favor', der: true, render: s => <strong><Neg v={s.total} /></strong> },
        ]} />
      </section>

      <section className="bloque">
        <header><h3>Obras</h3><button className="link" onClick={() => ir('obras')}>Detalle por obra</button></header>
        <Tabla filas={obrasVis.map(o => ({ ...o, id: o.obra.id }))} vacio="Todavía no hay obras cargadas." columnas={[
          { k: 'n', label: 'Obra', render: o => o.obra.nombre },
          { k: 'c', label: 'Cobrado', der: true, render: o => $(o.cobrado) },
          { k: 'pc', label: 'Por cobrar', der: true, render: o => $(o.porCobrar) },
          { k: 'g', label: 'Pagado', der: true, render: o => $(o.gastado) },
          { k: 'd', label: 'Se debe', der: true, render: o => $(o.pendiente + o.compromisos) },
          { k: 'r', label: 'Resultado', der: true, render: o => <Neg v={o.resultado} /> },
          { k: 'sl', label: 'Sin liquidar', der: true, render: o => $(o.sinLiquidar) },
          { k: 'pd', label: 'Por distribuir', der: true, render: o => <Neg v={o.pendDistribuir} /> },
        ]} />
        {general && (general.gasNeto > 0 || general.compromisos > 0) && (
          <div className="cuerpo" style={{ fontSize: 14 }}>Gastos generales: {$(general.gasNeto + general.compromisos)}, asignados {$(general.asignados)}, <strong>sin asignar {$(general.sinAsignar)}</strong>.</div>
        )}
      </section>

      <section className="bloque">
        <header><h3>Caja por cuenta</h3><button className="link" onClick={() => ir('caja')}>Ver caja</button></header>
        <Tabla filas={cajas.filter(c => c.activa || c.saldo)} vacio="No hay cuentas cargadas." columnas={[
          { k: 'nombre', label: 'Cuenta' },
          { k: 'saldo', label: 'Saldo según lo cargado', der: true, render: c => <Neg v={c.saldo} /> },
        ]} />
      </section>
    </>
  );
}

// ---------- COBRO / PAGO CON IMPUTACIÓN ----------
function MovModal({ ctx, tipo, tercero_id, preAplic, existente, sinTercero, onClose }) {
  const { d, L, notify, recargar } = ctx;
  const esCobro = tipo === 'cobro';
  const pre = preAplic || {};
  const totPre = r2(Object.values(pre).reduce((a, v) => a + n(v), 0));
  const [f, setF] = useState({ fecha: hoy(), tercero_id: tercero_id ? String(tercero_id) : '', importe: totPre ? String(totPre) : '', retenciones: '',
    destino: '', nro: '', obra_id: '', medio: 'transferencia', fuente: 'verificado', obs: '' });
  const [aplic, setAplic] = useState(Object.fromEntries(Object.entries(pre).map(([k, v]) => [k, String(r2(v))])));
  const [err, setErr] = useState('');
  const [enviando, setEnviando] = useState(false);
  const set = useCallback((k, v) => setF(p => ({ ...p, [k]: v })), []);
  const terId = existente ? existente.tercero_id : idN(f.tercero_id);
  const saldoDe = x => (esCobro ? d.X.saldoIng(x) : d.X.saldoGas(x));
  const pendientes = useMemo(() => {
    if (sinTercero) return Object.keys(pre).map(id => d.X.gasById.get(Number(id))).filter(Boolean);
    if (!terId) return [];
    return (esCobro ? vivos(d.ingresos).filter(i => i.tercero_id === terId && d.X.saldoIng(i) > 0.01)
      : vivos(d.gastos).filter(g => g.tercero_id === terId && d.X.saldoGas(g) > 0.01)).sort(porFechaAsc('fecha'));
  }, [d, terId]); // eslint-disable-line
  const total = existente ? (esCobro ? d.X.restoCobro(existente) : d.X.restoPago(existente)) : r2(n(f.importe) + (esCobro ? n(f.retenciones) : 0));
  const aplicado = r2(Object.values(aplic).reduce((a, v) => a + n(v), 0));
  const auto = () => {
    let resto = total; const nv = {};
    pendientes.forEach(x => { const v = r2(Math.min(saldoDe(x), Math.max(0, resto))); if (v > 0) { nv[x.id] = String(v); resto = r2(resto - v); } });
    setAplic(nv);
  };
  const cambiaTercero = v => { set('tercero_id', v); setAplic({}); };

  const guardar = async () => {
    setErr('');
    if (!existente) {
      if (!f.fecha) { setErr('Indicá la fecha.'); return; }
      if (!sinTercero && !f.tercero_id) { setErr(`Elegí el ${esCobro ? 'cliente' : 'proveedor o empleado'}.`); return; }
      if (!f.destino) { setErr(esCobro ? 'Indicá dónde entró el dinero.' : 'Indicá quién pagó.'); return; }
      if (esCobro ? n(f.importe) + n(f.retenciones) <= 0 || n(f.importe) < 0 : n(f.importe) <= 0) { setErr('El importe tiene que ser mayor a cero.'); return; }
    }
    for (const x of pendientes) if (n(aplic[x.id]) > saldoDe(x) + 0.01) { setErr(`Se imputa más que el saldo de ${x.nro_factura || x.nro_comprobante || x.concepto}.`); return; }
    if (Object.values(aplic).some(v => n(v) < 0)) { setErr('Las imputaciones no pueden ser negativas.'); return; }
    if (aplicado > total + 0.01) { setErr(`Se imputan ${$(aplicado)} y el ${esCobro ? 'cobro' : 'pago'} es de ${$(total)}.`); return; }
    if (aplicado < total - 0.01 && !window.confirm(`Quedan ${$(total - aplicado)} sin imputar a ${esCobro ? 'facturas' : 'gastos'} (a cuenta). ¿Guardar igual?`)) return;
    const lista = Object.entries(aplic).filter(([, v]) => n(v) > 0).map(([id, v]) => ({ [esCobro ? 'ingreso_id' : 'gasto_id']: Number(id), importe: r2(v) }));
    let p;
    if (existente) p = { id: existente.id, aplic: lista };
    else if (esCobro) p = { fecha: f.fecha, tercero_id: Number(f.tercero_id), importe: r2(f.importe), retenciones: r2(f.retenciones), ...splitDestino(f.destino),
      obra_id: idN(f.obra_id), nro_recibo: f.nro || null, fuente: f.fuente, obs: f.obs || null, aplic: lista };
    else {
      const dst = splitDestino(f.destino);
      const terPago = sinTercero ? null : Number(f.tercero_id);
      p = { fecha: f.fecha, tercero_id: terPago, importe: r2(f.importe), pagado_por: dst.cuenta_id ? 'sociedad' : 'socio', ...dst,
        medio: f.medio || null, nro_comprobante: f.nro || null, fuente: f.fuente, obs: f.obs || null, aplic: lista };
    }
    setEnviando(true);
    try {
      await rpc(esCobro ? 'ob_guardar_cobro' : 'ob_guardar_pago', p);
      notify(existente ? 'Imputación guardada.' : `${esCobro ? 'Cobro' : 'Pago'} guardado.`);
      await recargar(); onClose();
    } catch (e) { setErr(textoError(e)); } finally { setEnviando(false); }
  };

  const campos = existente ? [] : [
    { k: 'fecha', label: 'Fecha', tipo: 'date', req: true },
    ...(sinTercero ? [] : [{ k: 'tercero_id', label: esCobro ? 'Cliente' : 'Proveedor o empleado', tipo: 'select', req: true, opciones: terceroOpc(d, esCobro ? ['cliente'] : ['proveedor', 'empleado'], f.tercero_id) }]),
    { k: 'importe', label: esCobro ? 'Importe recibido' : 'Importe pagado', tipo: 'number', req: true },
    ...(esCobro ? [{ k: 'retenciones', label: 'Retenciones sufridas', tipo: 'number', ayuda: 'Cancelan factura pero no entran a caja' }] : [{ k: 'medio', label: 'Medio', tipo: 'select', sinVacio: true, opciones: MEDIOS }]),
    { k: 'destino', label: esCobro ? '¿Dónde entró el dinero?' : '¿Quién pagó?', tipo: 'select', req: true, opciones: destinoOpc(d, esCobro ? 'lo cobró en su cuenta' : 'de su bolsillo'),
      ayuda: esCobro ? undefined : 'Si pagó un socio con su dinero, queda a su favor en su cuenta de reintegro.' },
    { k: 'nro', label: esCobro ? 'N° de recibo' : 'N° de comprobante / orden de pago' },
    ...(esCobro ? [{ k: 'obra_id', label: 'Obra (si queda a cuenta)', tipo: 'select', opciones: obrasOpc(d, false) }] : []),
    { k: 'fuente', label: 'Origen del dato', tipo: 'select', sinVacio: true, opciones: FUENTES },
    { k: 'obs', label: 'Observaciones', tipo: 'textarea', full: true },
  ];
  const titulo = existente ? `Imputar saldo del ${esCobro ? 'cobro' : 'pago'} #${existente.id}` : esCobro ? 'Registrar cobro' : 'Registrar pago';

  return (
    <Modal titulo={titulo} ancho onClose={onClose} pie={<>
      <button className="btn sec" onClick={onClose}>Cancelar</button>
      <button className="btn" onClick={guardar} disabled={enviando}>{enviando ? 'Guardando…' : 'Guardar'}</button></>}>
      {err && <div className="error" role="alert">{err}</div>}
      {existente && <p style={{ marginTop: 0 }}>{L.ter(existente.tercero_id) || 'Sin proveedor'} · {fD(existente.fecha)} · saldo sin imputar <strong>{$(total)}</strong></p>}
      {!existente && <div className="campos">{campos.map(c => <Campo key={c.k} c={c} v={f[c.k]} set={c.k === 'tercero_id' ? (k, v) => cambiaTercero(v) : set} />)}</div>}
      <h3 style={{ margin: '18px 0 8px' }}>{esCobro ? 'Facturas que cancela' : 'Gastos que cancela'}</h3>
      {!pendientes.length ? <p className="sub">{terId || sinTercero ? `No hay ${esCobro ? 'facturas' : 'gastos'} pendientes: el importe queda a cuenta.` : `Elegí el ${esCobro ? 'cliente' : 'proveedor'} para ver lo pendiente.`}</p> : (
        <>
          <Tabla filas={pendientes} columnas={[
            { k: 'f', label: 'Fecha', render: x => fD(x.fecha) },
            { k: 'o', label: 'Obra', render: x => L.obra(x.obra_id) },
            { k: 'c', label: 'Comprobante', render: x => <>{x.nro_factura || x.nro_comprobante || '—'}<span className="sub">{x.concepto}</span></> },
            { k: 's', label: 'Saldo', der: true, render: x => $(saldoDe(x)) },
            { k: 'a', label: 'Imputar', der: true, render: x => <input type="number" step="0.01" inputMode="decimal" aria-label="Importe a imputar"
                style={{ width: 140, padding: '5px 7px', textAlign: 'right', border: '1px solid var(--linea)', borderRadius: 4 }}
                value={aplic[x.id] ?? ''} onChange={e => setAplic({ ...aplic, [x.id]: e.target.value })} /> },
          ]} />
          <p style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
            <button className="btn sec chico" onClick={auto}>Imputar automático (más antiguo primero)</button>
            <span>Total {$(total)} · imputado {$(aplicado)} · <strong className={aplicado > total + 0.01 ? 'neg' : ''}>a cuenta {$(total - aplicado)}</strong></span>
          </p>
        </>
      )}
    </Modal>
  );
}

// ---------- VENTAS: FACTURAS Y COBROS ----------
function Ventas({ ctx, filtroIni }) {
  const [tab, setTab] = useState('facturas');
  return (
    <>
      <div className="cab"><div><h1>Ventas y cobros</h1><p>Facturas y certificados a clientes, y lo que efectivamente se cobró.</p></div></div>
      <div className="tabs" role="tablist">
        {[['facturas', 'Facturas'], ['cobros', 'Cobros']].map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'act' : ''} onClick={() => setTab(k)}>{l}</button>)}
      </div>
      {tab === 'facturas' ? <FacturasVenta ctx={ctx} filtroIni={filtroIni} /> : <ListaCobros ctx={ctx} />}
    </>
  );
}

function FacturasVenta({ ctx, filtroIni }) {
  const { d, L, puede, notify, recargar } = ctx;
  const [f, setF] = useState({ ...FILTRO0, ...(filtroIni || {}) });
  const [edit, setEdit] = useState(null);
  const [mov, setMov] = useState(null);
  const filas = useMemo(() => filtrar(d.ingresos, f, i => i.fecha, i => `${i.concepto} ${L.ter(i.tercero_id)} ${i.nro_factura || ''} ${L.obra(i.obra_id)}`,
    i => estadoIng(d, i).k).sort(porFechaDesc('fecha')), [d, f, L]);
  const vv = vivos(filas);
  const campos = edit ? [
    { k: 'fecha', label: 'Fecha', tipo: 'date', req: true },
    { k: 'obra_id', label: 'Obra', tipo: 'select', req: true, opciones: obrasOpc(d, false, edit.obra_id) },
    { k: 'tercero_id', label: 'Cliente', tipo: 'select', req: true, opciones: terceroOpc(d, ['cliente'], edit.tercero_id),
      nuevos: [{ v: '__nc', l: '+ Nuevo cliente…', fn: () => crearTercero(ctx, 'cliente') }] },
    { k: 'tipo_comprobante', label: 'Comprobante', tipo: 'select', req: true, sinVacio: true, opciones: COMP_VENTA },
    { k: 'nro_factura', label: 'Número' },
    { k: 'concepto', label: 'Concepto', req: true, ayuda: 'Ej.: certificado N° 3, anticipo financiero' },
    { k: 'bruto', label: 'Total facturado', tipo: 'number', req: true, ayuda: 'Con IVA incluido' },
    { k: 'iva', label: 'IVA incluido', tipo: 'number' },
    { k: 'fecha_estimada', label: 'Fecha estimada de cobro', tipo: 'date', visible: x => !x.cobrada },
    { k: 'cobrada', label: 'Ya está cobrada: registrar el cobro ahora', tipo: 'check', full: true, visible: x => !x.id },
    { k: 'fecha_cobro', label: 'Fecha de cobro', tipo: 'date', req: true, visible: x => x.cobrada },
    { k: 'destino', label: '¿Dónde entró el dinero?', tipo: 'select', req: true, visible: x => x.cobrada, opciones: destinoOpc(d, 'lo cobró en su cuenta') },
    { k: 'retenciones', label: 'Retenciones sufridas', tipo: 'number', visible: x => x.cobrada },
    { k: 'nro_recibo', label: 'N° de recibo', visible: x => x.cobrada },
    { k: 'fuente', label: 'Origen del dato', tipo: 'select', sinVacio: true, opciones: FUENTES },
    { k: 'obs', label: 'Observaciones', tipo: 'textarea', full: true },
  ] : [];
  const abrir = row => setEdit(row && row.id
    ? { ...row, obra_id: String(row.obra_id), tercero_id: String(row.tercero_id), nro_factura: row.nro_factura || '', fecha_estimada: row.fecha_estimada || '', obs: row.obs || '', bruto: String(row.bruto), iva: String(row.iva) }
    : { fecha: hoy(), obra_id: f.obra || '', tercero_id: '', tipo_comprobante: 'factura_a', nro_factura: '', concepto: '', bruto: '', iva: '', fecha_estimada: '', cobrada: false,
        fecha_cobro: hoy(), destino: '', retenciones: '', nro_recibo: '', fuente: 'verificado', obs: '' });
  const validar = x => {
    if (n(x.bruto) <= 0) return 'El total tiene que ser mayor a cero.';
    if (n(x.iva) > n(x.bruto)) return 'El IVA no puede superar el total.';
    if (x.cobrada && n(x.retenciones) > n(x.bruto)) return 'Las retenciones no pueden superar el total.';
    return '';
  };
  const guardar = async x => {
    const fac = { fecha: x.fecha, obra_id: Number(x.obra_id), tercero_id: Number(x.tercero_id), tipo_comprobante: x.tipo_comprobante, nro_factura: x.nro_factura || null,
      concepto: x.concepto.trim(), bruto: r2(x.bruto), iva: r2(x.iva), fecha_estimada: x.fecha_estimada || null, fuente: x.fuente, obs: x.obs || null };
    if (!x.id && x.cobrada) {
      await rpc('ob_guardar_cobro', { fecha: x.fecha_cobro, tercero_id: fac.tercero_id, importe: r2(n(x.bruto) - n(x.retenciones)), retenciones: r2(x.retenciones),
        ...splitDestino(x.destino), nro_recibo: x.nro_recibo || null, fuente: x.fuente, ingreso: fac });
      notify('Factura y cobro guardados.');
    } else {
      await guardarFila('ob_ingresos', fac, x.id);
      notify(x.id ? 'Factura actualizada.' : 'Factura guardada.');
    }
    recargar();
  };
  const cols = [
    { k: 'fecha', label: 'Fecha', render: i => fD(i.fecha), csv: i => i.fecha },
    { k: 'obra', label: 'Obra', render: i => L.obra(i.obra_id), csv: i => L.obra(i.obra_id) },
    { k: 'cli', label: 'Cliente', render: i => L.ter(i.tercero_id), csv: i => L.ter(i.tercero_id) },
    { k: 'comp', label: 'Comprobante', render: i => <>{compLabel(COMP_VENTA, i.tipo_comprobante)} {i.nro_factura}<span className="sub">{i.concepto}</span></>, csv: i => `${i.tipo_comprobante} ${i.nro_factura || ''} ${i.concepto}` },
    { k: 'bruto', label: 'Total', der: true, render: i => $(i.bruto), csv: i => numCSV(i.bruto) },
    { k: 'cob', label: 'Cobrado', der: true, render: i => $(d.X.cobrado(i)), csv: i => numCSV(d.X.cobrado(i)) },
    { k: 'saldo', label: 'Saldo', der: true, render: i => i.anulado ? '' : <strong>{$(d.X.saldoIng(i))}</strong>, csv: i => numCSV(i.anulado ? 0 : d.X.saldoIng(i)) },
    { k: 'est', label: 'Estado', render: i => { const e = estadoIng(d, i); return <Chip t={e.t} c={e.c} />; }, csv: i => estadoIng(d, i).k },
    { k: 'fuente', label: 'Dato', render: i => i.fuente === 'verificado' ? '' : <Chip t={i.fuente} c="info" />, csv: i => i.fuente },
    { k: 'acc', label: '', render: i => puede && !i.anulado ? <span style={{ display: 'flex', gap: 6 }}>
      {d.X.saldoIng(i) > 0.01 && <button className="btn chico" onClick={e => { e.stopPropagation(); setMov({ tipo: 'cobro', tercero_id: i.tercero_id, preAplic: { [i.id]: d.X.saldoIng(i) } }); }}>Cobrar</button>}
      <button className="btn sec chico" onClick={e => { e.stopPropagation(); anular('ob_ingresos', i, notify, recargar); }}>Anular</button></span> : null },
  ];
  return (
    <>
      <div className="acciones" style={{ marginBottom: 12 }}>
        {puede && <button className="btn" onClick={() => abrir(null)}>Nueva factura</button>}
        <button className="btn sec" onClick={() => exportarCSV('facturas-venta', cols.filter(c => c.csv), filas)}>Exportar CSV</button>
      </div>
      <section className="bloque">
        <Filtros f={f} set={setF} obras={d.obras.filter(o => !o.es_general)} estados={[{ v: 'pendiente', l: 'Pendientes' }, { v: 'parcial', l: 'Cobro parcial' }, { v: 'cobrado', l: 'Cobradas' }]} />
        <Tabla columnas={cols} filas={filas} onFila={puede ? abrir : undefined} claseFila={i => i.anulado && 'anul'} vacio="No hay facturas con estos filtros."
          pie={{ fecha: 'Total', bruto: $(sum(vv, i => i.bruto)), cob: $(sum(vv, i => d.X.cobrado(i))), saldo: $(sum(vv, i => d.X.saldoIng(i))) }} />
      </section>
      {edit && <FormModal titulo={edit.id ? `Factura #${edit.id}` : 'Nueva factura de venta'} campos={campos} inicial={edit} validar={validar} onGuardar={guardar} onClose={() => setEdit(null)} />}
      {mov && <MovModal ctx={ctx} {...mov} onClose={() => setMov(null)} />}
    </>
  );
}

function ListaCobros({ ctx }) {
  const { d, L, puede, notify, recargar } = ctx;
  const [f, setF] = useState({ ...FILTRO0 });
  const [mov, setMov] = useState(null);
  const filas = useMemo(() => filtrar(d.cobros, f, c => c.fecha, c => `${L.ter(c.tercero_id)} ${c.nro_recibo || ''} ${c.obs || ''}`).sort(porFechaDesc('fecha')), [d, f, L]);
  const vv = vivos(filas);
  const cols = [
    { k: 'fecha', label: 'Fecha', render: c => fD(c.fecha), csv: c => c.fecha },
    { k: 'cli', label: 'Cliente', render: c => <>{L.ter(c.tercero_id)}<span className="sub">{c.nro_recibo ? `Rec. ${c.nro_recibo}` : ''}</span></>, csv: c => L.ter(c.tercero_id) },
    { k: 'imp', label: 'Recibido', der: true, render: c => $(c.importe), csv: c => numCSV(c.importe) },
    { k: 'ret', label: 'Retenciones', der: true, render: c => $(c.retenciones), csv: c => numCSV(c.retenciones) },
    { k: 'dest', label: 'Entró en', render: c => c.cuenta_id ? L.cuenta(c.cuenta_id) : <Chip t={`Cuenta de ${L.socio(c.socio_id)}`} c="info" />, csv: c => c.cuenta_id ? L.cuenta(c.cuenta_id) : L.socio(c.socio_id) },
    { k: 'resto', label: 'Sin imputar', der: true, render: c => c.anulado ? '' : d.X.restoCobro(c) > 0.01 ? <Chip t={$(d.X.restoCobro(c))} c="pend" /> : '', csv: c => numCSV(c.anulado ? 0 : d.X.restoCobro(c)) },
    { k: 'fuente', label: 'Dato', render: c => c.fuente === 'verificado' ? '' : <Chip t={c.fuente} c="info" />, csv: c => c.fuente },
    { k: 'acc', label: '', render: c => puede && !c.anulado ? <span style={{ display: 'flex', gap: 6 }}>
      {d.X.restoCobro(c) > 0.01 && <button className="btn chico" onClick={() => setMov({ tipo: 'cobro', existente: c })}>Imputar</button>}
      <button className="btn sec chico" onClick={() => anular('ob_cobros', c, notify, recargar)}>Anular</button></span> : null },
  ];
  return (
    <>
      <div className="acciones" style={{ marginBottom: 12 }}>
        {puede && <button className="btn" onClick={() => setMov({ tipo: 'cobro' })}>Nuevo cobro</button>}
        <button className="btn sec" onClick={() => exportarCSV('cobros', cols.filter(c => c.csv), filas)}>Exportar CSV</button>
      </div>
      <section className="bloque">
        <Filtros f={f} set={setF} obras={null} />
        <Tabla columnas={cols} filas={filas} claseFila={c => c.anulado && 'anul'} vacio="No hay cobros con estos filtros."
          pie={{ fecha: 'Total', imp: $(sum(vv, c => c.importe)), ret: $(sum(vv, c => c.retenciones)) }} />
      </section>
      {mov && <MovModal ctx={ctx} {...mov} onClose={() => setMov(null)} />}
    </>
  );
}

// ---------- COMPRAS: GASTOS Y PAGOS ----------
function camposGasto(d, edit, ctx) {
  return [
    { k: 'fecha', label: 'Fecha del comprobante', tipo: 'date', req: true },
    { k: 'obra_id', label: 'Obra', tipo: 'select', req: true, opciones: obrasOpc(d, true, edit.obra_id) },
    { k: 'categoria_id', label: 'Categoría', tipo: 'select', req: true, opciones: d.categorias.filter(c => c.activa || String(c.id) === String(edit.categoria_id)).map(c => ({ v: String(c.id), l: c.nombre })) },
    { k: 'tercero_id', label: 'Proveedor o empleado', tipo: 'select', vacio: 'No registrado (escribir abajo)', opciones: terceroOpc(d, ['proveedor', 'empleado'], edit.tercero_id),
      nuevos: [{ v: '__np', l: '+ Nuevo proveedor…', fn: () => crearTercero(ctx, 'proveedor') }, { v: '__ne', l: '+ Nuevo empleado…', fn: () => crearTercero(ctx, 'empleado') }],
      ayuda: 'Registralo para llevar su cuenta corriente.' },
    { k: 'proveedor', label: 'Proveedor (texto)', req: true, visible: x => !x.tercero_id, ayuda: 'Para compras sueltas: estación de servicio, ferretería, etc.' },
    { k: 'concepto', label: 'Concepto', req: true, full: true },
    { k: 'importe', label: 'Importe total', tipo: 'number', req: true },
    { k: 'iva_credito', label: 'IVA crédito fiscal', tipo: 'number', ayuda: 'Solo facturas A' },
    { k: 'vencimiento', label: 'Vencimiento', tipo: 'date', visible: x => !x.pagado },
    { k: 'tipo_comprobante', label: 'Comprobante', tipo: 'select', req: true, sinVacio: true, opciones: COMP_GASTO },
    { k: 'nro_comprobante', label: 'N° de comprobante', visible: x => x.tipo_comprobante !== 'sin_comprobante' },
    { k: 'archivo', label: edit.comprobante_path ? 'Reemplazar archivo' : 'Foto o PDF del comprobante', tipo: 'file', full: true, visible: x => x.tipo_comprobante !== 'sin_comprobante' },
    { k: 'pagado', label: 'Ya está pagado: registrar el pago ahora', tipo: 'check', full: true, visible: x => !x.id },
    { k: 'fecha_pago', label: 'Fecha de pago', tipo: 'date', req: true, visible: x => x.pagado },
    { k: 'pago', label: '¿Quién pagó?', tipo: 'select', req: true, visible: x => x.pagado, opciones: destinoOpc(d, 'de su bolsillo'),
      ayuda: 'Si pagó un socio con su dinero, queda a su favor. No lo cargues también como aporte.' },
    { k: 'medio', label: 'Medio de pago', tipo: 'select', sinVacio: true, visible: x => x.pagado, opciones: MEDIOS },
    { k: 'fuente', label: 'Origen del dato', tipo: 'select', sinVacio: true, opciones: FUENTES },
    { k: 'obs', label: 'Observaciones', tipo: 'textarea', full: true },
  ];
}
function gastoVacio(pre) {
  return { fecha: hoy(), obra_id: '', categoria_id: '', tercero_id: '', proveedor: '', concepto: '', importe: '', iva_credito: '', vencimiento: '', tipo_comprobante: 'factura_a',
    nro_comprobante: '', archivo: null, pagado: false, fecha_pago: hoy(), pago: '', medio: 'transferencia', fuente: 'verificado', obs: '', compromiso_id: null, ...(pre || {}) };
}
function gastoDesdeFila(row) {
  return { ...row, obra_id: String(row.obra_id), categoria_id: row.categoria_id ? String(row.categoria_id) : '', tercero_id: row.tercero_id ? String(row.tercero_id) : '',
    proveedor: row.proveedor || '', vencimiento: row.vencimiento || '', nro_comprobante: row.nro_comprobante || '', obs: row.obs || '', archivo: null,
    importe: String(row.importe), iva_credito: String(row.iva_credito), pagado: false };
}
const validarGasto = x => {
  if (n(x.importe) <= 0) return 'El importe tiene que ser mayor a cero.';
  if (n(x.iva_credito) > n(x.importe)) return 'El IVA no puede superar el importe.';
  if (x.pagado && x.fecha_pago < x.fecha && !window.confirm('La fecha de pago es anterior a la del comprobante. ¿Es correcto?')) return 'Revisá las fechas.';
  return '';
};
function guardadorGasto(ctx) {
  const { d, notify, recargar } = ctx;
  return async x => {
    if (!x.id) {
      const k = `${x.tercero_id || (x.proveedor || '').trim().toLowerCase()}|${r2(x.importe)}|${x.fecha}`;
      const dup = vivos(d.gastos).some(g => `${g.tercero_id || (g.proveedor || '').trim().toLowerCase()}|${r2(g.importe)}|${g.fecha}` === k);
      if (dup && !window.confirm('Ya hay un gasto del mismo proveedor, importe y fecha. ¿Guardar igual?')) throw new Error('Guardado cancelado.');
    }
    let path = x.comprobante_path || null;
    const conComp = x.tipo_comprobante !== 'sin_comprobante';
    if (x.archivo && conComp) path = await subirComprobante(x.archivo);
    const gasto = {
      fecha: x.fecha, obra_id: Number(x.obra_id), categoria_id: idN(x.categoria_id), tercero_id: idN(x.tercero_id),
      proveedor: x.tercero_id ? null : (x.proveedor || '').trim(), concepto: x.concepto.trim(), importe: r2(x.importe), iva_credito: r2(x.iva_credito),
      vencimiento: x.vencimiento || null, tipo_comprobante: x.tipo_comprobante, nro_comprobante: conComp ? (x.nro_comprobante || null) : null,
      comprobante_path: conComp ? path : null, fuente: x.fuente, obs: x.obs || null,
    };
    if (!x.id && x.compromiso_id) gasto.compromiso_id = x.compromiso_id;
    if (!x.id && x.pagado) {
      const dst = splitDestino(x.pago);
      await rpc('ob_guardar_pago', { fecha: x.fecha_pago, tercero_id: gasto.tercero_id, importe: gasto.importe, pagado_por: dst.cuenta_id ? 'sociedad' : 'socio', ...dst,
        medio: x.medio || null, fuente: x.fuente, gasto });
      notify('Gasto y pago guardados.');
    } else {
      await guardarFila('ob_gastos', gasto, x.id);
      notify(x.id ? 'Gasto actualizado.' : 'Gasto guardado.');
    }
    recargar();
  };
}

function Compras({ ctx, filtroIni }) {
  const [tab, setTab] = useState('gastos');
  return (
    <>
      <div className="cab"><div><h1>Gastos y pagos</h1><p>Facturas de proveedores, jornales y sueldos, y lo que efectivamente se pagó.</p></div></div>
      <div className="tabs" role="tablist">
        {[['gastos', 'Gastos'], ['pagos', 'Pagos']].map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'act' : ''} onClick={() => setTab(k)}>{l}</button>)}
      </div>
      {tab === 'gastos' ? <ListaGastos ctx={ctx} filtroIni={filtroIni} /> : <ListaPagos ctx={ctx} />}
    </>
  );
}

function ListaGastos({ ctx, filtroIni }) {
  const { d, L, puede, notify, recargar } = ctx;
  const [f, setF] = useState({ ...FILTRO0, ...(filtroIni || {}) });
  const [edit, setEdit] = useState(null);
  const [mov, setMov] = useState(null);
  const guardar = guardadorGasto(ctx);
  const nomProv = g => g.tercero_id ? L.ter(g.tercero_id) : g.proveedor;
  const filas = useMemo(() => filtrar(d.gastos, f, g => g.fecha, g => `${g.concepto} ${nomProv(g)} ${g.nro_comprobante || ''} ${L.obra(g.obra_id)} ${L.cat(g.categoria_id)}`,
    g => estadoGas(d, g).k).sort(porFechaDesc('fecha')), [d, f, L]); // eslint-disable-line
  const vv = vivos(filas);
  const abrirComp = (e, g) => { e.stopPropagation(); verComprobante(g.comprobante_path).catch(x => notify(textoError(x), true)); };
  const cols = [
    { k: 'fecha', label: 'Fecha', render: g => fD(g.fecha), csv: g => g.fecha },
    { k: 'obra', label: 'Obra', render: g => L.obra(g.obra_id), csv: g => L.obra(g.obra_id) },
    { k: 'prov', label: 'Proveedor y concepto', render: g => <>{nomProv(g)}<span className="sub">{g.concepto} · {L.cat(g.categoria_id)}</span></>, csv: g => `${nomProv(g)} - ${g.concepto}` },
    { k: 'imp', label: 'Importe', der: true, render: g => $(g.importe), csv: g => numCSV(g.importe) },
    { k: 'pag', label: 'Pagado', der: true, render: g => $(d.X.pagado(g)), csv: g => numCSV(d.X.pagado(g)) },
    { k: 'saldo', label: 'Saldo', der: true, render: g => g.anulado ? '' : <strong>{$(d.X.saldoGas(g))}</strong>, csv: g => numCSV(g.anulado ? 0 : d.X.saldoGas(g)) },
    { k: 'est', label: 'Estado', render: g => { const e = estadoGas(d, g); return <Chip t={e.t} c={e.c} />; }, csv: g => estadoGas(d, g).k },
    { k: 'comp', label: 'Comprobante', render: g => g.tipo_comprobante === 'sin_comprobante' ? <Chip t="Sin comprobante" c="mal" /> :
        <>{compLabel(COMP_GASTO, g.tipo_comprobante)} {g.nro_comprobante || (g.tipo_comprobante !== 'saldo_inicial' && <Chip t="sin número" c="pend" />)}
          {g.comprobante_path && <span className="sub"><button className="link" onClick={e => abrirComp(e, g)}>Ver archivo</button></span>}</>,
      csv: g => `${g.tipo_comprobante} ${g.nro_comprobante || ''}` },
    { k: 'acc', label: '', render: g => puede && !g.anulado ? <span style={{ display: 'flex', gap: 6 }}>
      {d.X.saldoGas(g) > 0.01 && <button className="btn chico" onClick={e => { e.stopPropagation(); setMov({ tipo: 'pago', tercero_id: g.tercero_id, sinTercero: !g.tercero_id, preAplic: { [g.id]: d.X.saldoGas(g) } }); }}>Pagar</button>}
      <button className="btn sec chico" onClick={e => { e.stopPropagation(); anular('ob_gastos', g, notify, recargar); }}>Anular</button></span> : null },
  ];
  return (
    <>
      <div className="acciones" style={{ marginBottom: 12 }}>
        {puede && <button className="btn" onClick={() => setEdit(gastoVacio({ obra_id: f.obra || '' }))}>Nuevo gasto</button>}
        <button className="btn sec" onClick={() => exportarCSV('gastos', cols.filter(c => c.csv), filas)}>Exportar CSV</button>
      </div>
      <section className="bloque">
        <Filtros f={f} set={setF} obras={d.obras} estados={[{ v: 'pendiente', l: 'Pendientes' }, { v: 'parcial', l: 'Pago parcial' }, { v: 'pagado', l: 'Pagados' }]} />
        <Tabla columnas={cols} filas={filas} onFila={puede ? (g => setEdit(gastoDesdeFila(g))) : undefined} claseFila={g => g.anulado && 'anul'} vacio="No hay gastos con estos filtros."
          pie={{ fecha: 'Total', imp: $(sum(vv, g => g.importe)), pag: $(sum(vv, g => d.X.pagado(g))), saldo: $(sum(vv, g => d.X.saldoGas(g))) }} />
      </section>
      {edit && <FormModal titulo={edit.id ? `Gasto #${edit.id}` : 'Nuevo gasto'} campos={camposGasto(d, edit, ctx)} inicial={edit} validar={validarGasto} onGuardar={guardar} onClose={() => setEdit(null)} />}
      {mov && <MovModal ctx={ctx} {...mov} onClose={() => setMov(null)} />}
    </>
  );
}

function ListaPagos({ ctx }) {
  const { d, L, puede, notify, recargar } = ctx;
  const [f, setF] = useState({ ...FILTRO0 });
  const [mov, setMov] = useState(null);
  const aplDe = useMemo(() => { const m = new Map(); d.pagoAplic.forEach(a => { if (!m.has(a.pago_id)) m.set(a.pago_id, []); m.get(a.pago_id).push(a); }); return m; }, [d]);
  const nomPago = p => p.tercero_id ? L.ter(p.tercero_id) : (((aplDe.get(p.id) || [])[0] && (d.X.gasById.get(aplDe.get(p.id)[0].gasto_id) || {}).proveedor) || '—');
  const filas = useMemo(() => filtrar(d.pagos, f, p => p.fecha, p => `${nomPago(p)} ${p.nro_comprobante || ''} ${p.obs || ''}`).sort(porFechaDesc('fecha')), [d, f, L]); // eslint-disable-line
  const vv = vivos(filas);
  const cols = [
    { k: 'fecha', label: 'Fecha', render: p => fD(p.fecha), csv: p => p.fecha },
    { k: 'ter', label: 'A quién', render: p => <>{nomPago(p)}<span className="sub">{[p.medio, p.nro_comprobante].filter(Boolean).join(' · ')}</span></>, csv: p => nomPago(p) },
    { k: 'quien', label: 'Pagó', render: p => p.pagado_por === 'socio' ? <Chip t={L.socio(p.socio_id)} c="info" /> : L.cuenta(p.cuenta_id), csv: p => p.pagado_por === 'socio' ? L.socio(p.socio_id) : L.cuenta(p.cuenta_id) },
    { k: 'imp', label: 'Importe', der: true, render: p => $(p.importe), csv: p => numCSV(p.importe) },
    { k: 'resto', label: 'Sin imputar', der: true, render: p => p.anulado ? '' : d.X.restoPago(p) > 0.01 ? <Chip t={$(d.X.restoPago(p))} c="pend" /> : '', csv: p => numCSV(p.anulado ? 0 : d.X.restoPago(p)) },
    { k: 'fuente', label: 'Dato', render: p => p.fuente === 'verificado' ? '' : <Chip t={p.fuente} c="info" />, csv: p => p.fuente },
    { k: 'acc', label: '', render: p => puede && !p.anulado ? <span style={{ display: 'flex', gap: 6 }}>
      {p.tercero_id && d.X.restoPago(p) > 0.01 && <button className="btn chico" onClick={() => setMov({ tipo: 'pago', existente: p })}>Imputar</button>}
      <button className="btn sec chico" onClick={() => anular('ob_pagos', p, notify, recargar)}>Anular</button></span> : null },
  ];
  return (
    <>
      <div className="acciones" style={{ marginBottom: 12 }}>
        {puede && <button className="btn" onClick={() => setMov({ tipo: 'pago' })}>Nuevo pago</button>}
        <button className="btn sec" onClick={() => exportarCSV('pagos', cols.filter(c => c.csv), filas)}>Exportar CSV</button>
      </div>
      <p className="sub" style={{ marginTop: 0 }}>Un pago sin gastos imputados queda como adelanto a favor de la sociedad (por ejemplo, adelanto de jornal).</p>
      <section className="bloque">
        <Filtros f={f} set={setF} obras={null} />
        <Tabla columnas={cols} filas={filas} claseFila={p => p.anulado && 'anul'} vacio="No hay pagos con estos filtros." pie={{ fecha: 'Total', imp: $(sum(vv, p => p.importe)) }} />
      </section>
      {mov && <MovModal ctx={ctx} {...mov} onClose={() => setMov(null)} />}
    </>
  );
}

// ---------- CUENTAS CORRIENTES ----------
function CtaCte({ ctx }) {
  const { d, puede, notify, recargar } = ctx;
  const [tipo, setTipo] = useState('cliente');
  const [verInact, setVerInact] = useState(false);
  const [edit, setEdit] = useState(null);
  const [ver, setVer] = useState(null);
  const filas = useMemo(() => d.terceros.filter(t => t.tipo === tipo && (verInact || t.activo)).map(t => ({ ...t, cc: ctaCte(d, t) }))
    .sort((a, b) => Math.abs(b.cc.saldo) - Math.abs(a.cc.saldo) || a.nombre.localeCompare(b.nombre)), [d, tipo, verInact]);
  const esCli = tipo === 'cliente';
  const labelSaldo = esCli ? 'Nos debe' : 'Le debemos';
  const guardarT = async x => {
    await guardarFila('ob_terceros', { tipo, nombre: x.nombre.trim(), cuit: x.cuit || null, contacto: x.contacto || null, obs: x.obs || null, activo: !!x.activo }, x.id);
    notify('Datos guardados.'); recargar();
  };
  const verT = ver ? d.terceros.find(t => t.id === ver) : null;
  return (
    <>
      <div className="cab">
        <div><h1>Cuentas corrientes</h1><p>Saldo con cada cliente, proveedor y empleado.</p></div>
        <div className="acciones">
          <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}><input type="checkbox" checked={verInact} onChange={e => setVerInact(e.target.checked)} /> Ver inactivos</label>
          {puede && <button className="btn" onClick={() => setEdit({ nombre: '', cuit: '', contacto: '', obs: '', activo: true })}>Nuevo {TIPO_TER[tipo].toLowerCase()}</button>}
        </div>
      </div>
      <div className="tabs" role="tablist">
        {[['cliente', 'Clientes'], ['proveedor', 'Proveedores'], ['empleado', 'Empleados']].map(([k, l]) => <button key={k} role="tab" aria-selected={tipo === k} className={tipo === k ? 'act' : ''} onClick={() => setTipo(k)}>{l}</button>)}
      </div>
      <section className="bloque">
        <Tabla filas={filas} onFila={t => setVer(t.id)} vacio={`No hay ${TIPO_TER[tipo].toLowerCase()}s cargados.`} columnas={[
          { k: 'nombre', label: 'Nombre', render: t => <>{t.nombre}<span className="sub">{[t.cuit, t.contacto].filter(Boolean).join(' · ')}</span></> },
          { k: 'p', label: esCli ? 'Facturas pendientes' : 'Gastos pendientes', der: true, render: t => t.cc.pendientes.length || '' },
          { k: 'ac', label: esCli ? 'Cobros a cuenta' : 'Adelantos', der: true, render: t => { const v = sum(t.cc.aCuenta, x => esCli ? d.X.restoCobro(x) : d.X.restoPago(x)); return v ? $(v) : ''; } },
          { k: 's', label: labelSaldo, der: true, render: t => <strong><Neg v={t.cc.saldo} /></strong> },
        ]} pie={{ nombre: 'Total', s: $(sum(filas, t => t.cc.saldo)) }} />
        <div className="cuerpo sub">{esCli ? 'Saldo negativo: el cliente pagó de más o hay un cobro a cuenta.' : 'Saldo negativo: le adelantamos dinero que todavía no tiene factura o jornal que lo cubra.'}</div>
      </section>
      {edit && <FormModal titulo={edit.id ? edit.nombre : `Nuevo ${TIPO_TER[tipo].toLowerCase()}`} inicial={edit} onGuardar={guardarT} onClose={() => setEdit(null)} campos={[
        { k: 'nombre', label: 'Nombre', req: true, full: true }, { k: 'cuit', label: esCli || tipo === 'proveedor' ? 'CUIT' : 'CUIL' },
        { k: 'contacto', label: 'Contacto', ayuda: 'Teléfono o email' }, { k: 'obs', label: 'Observaciones', tipo: 'textarea', full: true }, { k: 'activo', label: 'Activo', tipo: 'check' },
      ]} />}
      {verT && <DetalleCtaCte ctx={ctx} t={verT} onEditar={() => { setEdit({ ...verT, cuit: verT.cuit || '', contacto: verT.contacto || '', obs: verT.obs || '' }); setVer(null); }} onClose={() => setVer(null)} />}
    </>
  );
}

function DetalleCtaCte({ ctx, t, onEditar, onClose }) {
  const { d, L, puede } = ctx;
  const [mov, setMov] = useState(null);
  const cc = useMemo(() => ctaCte(d, t), [d, t]);
  const esCli = t.tipo === 'cliente';
  const cols = [
    { k: 'fecha', label: 'Fecha', render: m => fD(m.fecha), csv: m => m.fecha },
    { k: 'txt', label: 'Movimiento', csv: m => m.txt },
    { k: 'debe', label: esCli ? 'Facturado' : 'Pagado', der: true, render: m => m.debe ? $(m.debe) : '', csv: m => numCSV(m.debe) },
    { k: 'haber', label: esCli ? 'Cobrado' : 'Facturado', der: true, render: m => m.haber ? $(m.haber) : '', csv: m => numCSV(m.haber) },
    { k: 'saldo', label: 'Saldo', der: true, render: m => <Neg v={m.saldo} />, csv: m => numCSV(m.saldo) },
  ];
  // proveedores: en el libro el "debe" es lo pagado y el "haber" lo facturado; se muestran en ese orden para leer de izquierda a derecha
  return (
    <Modal titulo={`${TIPO_TER[t.tipo]}: ${t.nombre}`} ancho onClose={onClose} pie={<>
      <button className="btn sec" onClick={() => exportarCSV(`cuenta-${t.nombre}`, cols, cc.mov)}>Exportar CSV</button>
      <button className="btn sec" onClick={() => window.print()}>Imprimir</button>
      {puede && <button className="btn sec" onClick={onEditar}>Editar datos</button>}
      {puede && <button className="btn" onClick={() => setMov({ tipo: esCli ? 'cobro' : 'pago', tercero_id: t.id })}>{esCli ? 'Registrar cobro' : 'Registrar pago'}</button>}
    </>}>
      <p style={{ marginTop: 0 }}>{[t.cuit, t.contacto].filter(Boolean).join(' · ')}{t.obs ? ` · ${t.obs}` : ''}</p>
      <p><strong style={{ fontSize: 20 }}>{esCli ? 'Nos debe' : 'Le debemos'}: <Neg v={cc.saldo} /></strong></p>
      <Tabla filas={cc.mov.map(m => ({ ...m, id: m.k }))} columnas={esCli ? cols : [cols[0], cols[1], cols[3], cols[2], cols[4]]} vacio="Sin movimientos." />
      {cc.pendientes.length > 0 && <>
        <h3 style={{ margin: '18px 0 8px' }}>{esCli ? 'Facturas pendientes de cobro' : 'Gastos pendientes de pago'}</h3>
        <Tabla filas={cc.pendientes} columnas={[
          { k: 'f', label: 'Fecha', render: x => fD(x.fecha) },
          { k: 'o', label: 'Obra', render: x => L.obra(x.obra_id) },
          { k: 'c', label: 'Comprobante', render: x => <>{x.nro_factura || x.nro_comprobante || '—'}<span className="sub">{x.concepto}</span></> },
          { k: 'v', label: esCli ? 'Cobro estimado' : 'Vence', render: x => fD(esCli ? x.fecha_estimada : x.vencimiento) },
          { k: 's', label: 'Saldo', der: true, render: x => $(esCli ? d.X.saldoIng(x) : d.X.saldoGas(x)) },
        ]} />
      </>}
      {cc.aCuenta.length > 0 && <>
        <h3 style={{ margin: '18px 0 8px' }}>{esCli ? 'Cobros con saldo sin imputar' : 'Pagos a cuenta y adelantos'}</h3>
        <Tabla filas={cc.aCuenta} columnas={[
          { k: 'f', label: 'Fecha', render: x => fD(x.fecha) },
          { k: 'i', label: 'Importe', der: true, render: x => $(x.importe) },
          { k: 'r', label: 'Sin imputar', der: true, render: x => $(esCli ? d.X.restoCobro(x) : d.X.restoPago(x)) },
          { k: 'a', label: '', render: x => puede && cc.pendientes.length ? <button className="btn chico" onClick={() => setMov({ tipo: esCli ? 'cobro' : 'pago', existente: x })}>Imputar</button> : null },
        ]} />
      </>}
      {mov && <MovModal ctx={ctx} {...mov} onClose={() => setMov(null)} />}
    </Modal>
  );
}

// ---------- DEUDAS Y COMPROMISOS ----------
function Compromisos({ ctx }) {
  const { d, L, puede, notify, recargar } = ctx;
  const [f, setF] = useState({ ...FILTRO0, estado: 'vigente' });
  const [edit, setEdit] = useState(null);
  const [aGasto, setAGasto] = useState(null);
  const [mov, setMov] = useState(null);
  const guardarGasto = guardadorGasto(ctx);
  const pendFact = useMemo(() => vivos(d.gastos).filter(g => d.X.saldoGas(g) > 0.01 && (!f.obra || String(g.obra_id) === f.obra))
    .sort((a, b) => (a.vencimiento || '9999').localeCompare(b.vencimiento || '9999')), [d, f.obra]);
  const filas = useMemo(() => filtrar(d.compromisos, { ...f, anulados: true }, c => c.vencimiento, c => `${c.concepto} ${c.proveedor || ''} ${L.obra(c.obra_id)}`)
    .sort((a, b) => (a.vencimiento || '9999').localeCompare(b.vencimiento || '9999')), [d, f, L]);
  const vig = filas.filter(c => c.estado === 'vigente');
  const campos = [
    { k: 'concepto', label: 'Concepto', req: true, full: true, ayuda: 'Ej.: IVA de septiembre, cuota del préstamo, jornales de la semana' },
    { k: 'proveedor', label: 'A quién se le debe' },
    { k: 'obra_id', label: 'Obra', tipo: 'select', req: true, opciones: obrasOpc(d, true, edit && edit.obra_id) },
    { k: 'importe', label: 'Importe estimado', tipo: 'number', req: true },
    { k: 'vencimiento', label: 'Vencimiento', tipo: 'date' },
    { k: 'prioridad', label: 'Prioridad', tipo: 'select', req: true, sinVacio: true, opciones: [{ v: 'alta', l: 'Alta: impuestos, sueldos, frena la obra' }, { v: 'media', l: 'Media' }, { v: 'baja', l: 'Baja' }] },
    { k: 'obs', label: 'Observaciones', tipo: 'textarea', full: true },
  ];
  const abrir = row => setEdit(row && row.id ? { ...row, obra_id: String(row.obra_id), vencimiento: row.vencimiento || '', proveedor: row.proveedor || '', obs: row.obs || '', importe: String(row.importe) }
    : { concepto: '', proveedor: '', obra_id: f.obra || '', importe: '', vencimiento: '', prioridad: 'media', obs: '' });
  const guardar = async x => {
    await guardarFila('ob_compromisos', { concepto: x.concepto.trim(), proveedor: x.proveedor || null, obra_id: Number(x.obra_id), importe: r2(x.importe),
      vencimiento: x.vencimiento || null, prioridad: x.prioridad, obs: x.obs || null }, x.id);
    notify('Compromiso guardado.'); recargar();
  };
  const cancelar = async c => {
    const motivo = window.prompt('¿Por qué se cancela este compromiso?');
    if (motivo === null) return;
    try { await guardarFila('ob_compromisos', { estado: 'cancelado', obs: [c.obs, `Cancelado: ${motivo}`].filter(Boolean).join(' | ') }, c.id); notify('Compromiso cancelado.'); recargar(); }
    catch (e) { notify(textoError(e), true); }
  };
  const PRI = { alta: 'mal', media: 'pend', baja: 'neu' };
  return (
    <>
      <div className="cab">
        <div><h1>Deudas y compromisos</h1><p>Gastos sin pagar y obligaciones asumidas que todavía no tienen factura.</p></div>
        <div className="acciones">{puede && <button className="btn" onClick={() => abrir(null)}>Nuevo compromiso</button>}</div>
      </div>
      <div className="aviso">Si la deuda ya tiene factura, cargala en Gastos. Acá van las obligaciones sin factura; cuando llegue, usá “Cargar factura” para no contarla dos veces.</div>
      <section className="bloque">
        <header><h3>Gastos pendientes de pago</h3><strong>{$(sum(pendFact, g => d.X.saldoGas(g)))}</strong></header>
        <Tabla filas={pendFact} vacio="No hay gastos pendientes." columnas={[
          { k: 'v', label: 'Vence', render: g => g.vencimiento ? <span className={g.vencimiento < hoy() ? 'neg' : ''}>{fD(g.vencimiento)}</span> : '—' },
          { k: 'p', label: 'Proveedor', render: g => <>{g.tercero_id ? L.ter(g.tercero_id) : g.proveedor}<span className="sub">{g.concepto}</span></> },
          { k: 'o', label: 'Obra', render: g => L.obra(g.obra_id) },
          { k: 'i', label: 'Saldo', der: true, render: g => $(d.X.saldoGas(g)) },
          { k: 'a', label: '', render: g => puede ? <button className="btn chico" onClick={() => setMov({ tipo: 'pago', tercero_id: g.tercero_id, sinTercero: !g.tercero_id, preAplic: { [g.id]: d.X.saldoGas(g) } })}>Pagar</button> : null },
        ]} />
      </section>
      <section className="bloque">
        <header><h3>Compromisos</h3><strong>{$(sum(vig, c => c.importe))} vigentes</strong></header>
        <Filtros f={f} set={setF} obras={d.obras} conAnulados={false} estados={[{ v: 'vigente', l: 'Vigentes' }, { v: 'convertido', l: 'Con factura cargada' }, { v: 'cancelado', l: 'Cancelados' }]} />
        <Tabla filas={filas} onFila={puede ? (c => c.estado === 'vigente' && abrir(c)) : undefined} vacio="No hay compromisos con estos filtros." columnas={[
          { k: 'v', label: 'Vence', render: c => c.vencimiento ? <span className={c.estado === 'vigente' && c.vencimiento < hoy() ? 'neg' : ''}>{fD(c.vencimiento)}</span> : '—' },
          { k: 'c', label: 'Concepto', render: c => <>{c.concepto}<span className="sub">{c.proveedor}</span></> },
          { k: 'o', label: 'Obra', render: c => L.obra(c.obra_id) },
          { k: 'i', label: 'Importe', der: true, render: c => $(c.importe) },
          { k: 'p', label: 'Prioridad', render: c => <Chip t={c.prioridad} c={PRI[c.prioridad]} /> },
          { k: 'e', label: 'Estado', render: c => c.estado === 'vigente' ? <Chip t="Vigente" c="pend" /> : c.estado === 'convertido' ? <Chip t={`Gasto #${c.gasto_id}`} c="ok" /> : <Chip t="Cancelado" c="neu" /> },
          { k: 'a', label: '', render: c => puede && c.estado === 'vigente' ? <span style={{ display: 'flex', gap: 6 }}>
            <button className="btn chico" onClick={e => { e.stopPropagation(); setAGasto(gastoVacio({ obra_id: String(c.obra_id), proveedor: c.proveedor || '', concepto: c.concepto, importe: String(c.importe), compromiso_id: c.id })); }}>Cargar factura</button>
            <button className="btn sec chico" onClick={e => { e.stopPropagation(); cancelar(c); }}>Cancelar</button></span> : null },
        ]} />
      </section>
      {edit && <FormModal titulo={edit.id ? `Compromiso #${edit.id}` : 'Nuevo compromiso'} campos={campos} inicial={edit}
        validar={x => n(x.importe) <= 0 ? 'El importe tiene que ser mayor a cero.' : ''} onGuardar={guardar} onClose={() => setEdit(null)} />}
      {aGasto && <FormModal titulo="Cargar factura del compromiso" campos={camposGasto(d, aGasto, ctx)} inicial={aGasto} validar={validarGasto} onGuardar={guardarGasto} onClose={() => setAGasto(null)}
        extra={() => <div className="aviso">Al guardar, el compromiso queda convertido y deja de sumar como deuda aparte.</div>} />}
      {mov && <MovModal ctx={ctx} {...mov} onClose={() => setMov(null)} />}
    </>
  );
}

// ---------- SOCIOS ----------
function Socios({ ctx }) {
  const { d, L, puede, notify, recargar } = ctx;
  const saldos = useMemo(() => saldosSocios(d), [d]);
  const [f, setF] = useState({ socio: '', tipo: '', mes: '', anulados: false });
  const [edit, setEdit] = useState(null);
  const filas = useMemo(() => d.mov.filter(m => (f.anulados || !m.anulado) && (!f.socio || String(m.socio_id) === f.socio) &&
    (!f.tipo || m.tipo === f.tipo) && (!f.mes || mesDe(m.fecha) === f.mes)).sort(porFechaDesc('fecha')), [d, f]);
  const pagosSocio = useMemo(() => [...d.X.pagVivo.values()].filter(p => p.pagado_por === 'socio' &&
    (!f.socio || String(p.socio_id) === f.socio) && (!f.mes || mesDe(p.fecha) === f.mes)).sort(porFechaDesc('fecha')), [d, f]);
  const cobrosSocio = useMemo(() => [...d.X.cobVivo.values()].filter(c => c.socio_id &&
    (!f.socio || String(c.socio_id) === f.socio) && (!f.mes || mesDe(c.fecha) === f.mes)).sort(porFechaDesc('fecha')), [d, f]);
  const liqOpc = x => d.liqs.filter(l => l.estado === 'aprobada' && d.liqDet.some(y => y.liquidacion_id === l.id && String(y.socio_id) === String(x.socio_id)))
    .map(l => ({ v: String(l.id), l: `#${l.id} ${L.obra(l.obra_id)} (${fD(l.fecha)})` }));
  const campos = edit ? [
    { k: 'fecha', label: 'Fecha', tipo: 'date', req: true },
    { k: 'socio_id', label: 'Socio', tipo: 'select', req: true, opciones: d.socios.filter(s => s.activo || String(s.id) === String(edit.socio_id)).map(s => ({ v: String(s.id), l: s.nombre })) },
    { k: 'tipo', label: 'Tipo de movimiento', tipo: 'select', req: true, full: true, opciones: TIPOS_MOV },
    { k: 'importe', label: 'Importe', tipo: 'number', req: true },
    { k: 'cuenta_id', label: 'Cuenta de la sociedad', tipo: 'select', req: true, opciones: d.cuentas.filter(c => c.activa || String(c.id) === String(edit.cuenta_id)).map(c => ({ v: String(c.id), l: c.nombre })),
      ayuda: 'Aporte: cuenta donde entró. Resto: cuenta de donde salió.' },
    { k: 'liquidacion_id', label: 'Liquidación que se paga', tipo: 'select', visible: x => x.tipo === 'pago_utilidades', opciones: liqOpc(edit) },
    { k: 'obra_id', label: 'Obra (opcional)', tipo: 'select', opciones: obrasOpc(d, true, edit.obra_id) },
    { k: 'obs', label: 'Observaciones', tipo: 'textarea', full: true },
  ] : [];
  const abrir = row => setEdit(row && row.id ? { ...row, socio_id: String(row.socio_id), cuenta_id: String(row.cuenta_id), obra_id: row.obra_id ? String(row.obra_id) : '',
    liquidacion_id: row.liquidacion_id ? String(row.liquidacion_id) : '', obs: row.obs || '', importe: String(row.importe) }
    : { fecha: hoy(), socio_id: f.socio || '', tipo: '', importe: '', cuenta_id: '', obra_id: '', liquidacion_id: '', obs: '' });
  const validar = x => {
    if (n(x.importe) <= 0) return 'El importe tiene que ser mayor a cero.';
    const s = saldos.find(y => String(y.socio.id) === x.socio_id);
    const previo = x.id ? n((d.mov.find(m => m.id === x.id) || {}).importe) : 0;
    if (s && x.tipo === 'reintegro' && n(x.importe) > s.saldoReint + previo + 0.01 &&
      !window.confirm(`A ${s.socio.nombre} se le deben ${$(s.saldoReint)} de reintegro. Este importe lo supera. ¿Guardar igual?`)) return 'Revisá el importe.';
    if (s && x.tipo === 'pago_utilidades' && n(x.importe) > s.saldoUtil + previo + 0.01 &&
      !window.confirm(`${s.socio.nombre} tiene ${$(s.saldoUtil)} de utilidades liquidadas sin cobrar. Si cobra más, es un anticipo. ¿Guardar igual?`)) return 'Revisá el importe o el tipo.';
    return '';
  };
  const guardar = async x => {
    await guardarFila('ob_mov_socios', { fecha: x.fecha, socio_id: Number(x.socio_id), tipo: x.tipo, importe: r2(x.importe), cuenta_id: Number(x.cuenta_id),
      obra_id: idN(x.obra_id), liquidacion_id: x.tipo === 'pago_utilidades' ? idN(x.liquidacion_id) : null, obs: x.obs || null }, x.id);
    notify('Movimiento guardado.'); recargar();
  };
  const cols = [
    { k: 'fecha', label: 'Fecha', render: m => fD(m.fecha), csv: m => m.fecha },
    { k: 'socio', label: 'Socio', render: m => L.socio(m.socio_id), csv: m => L.socio(m.socio_id) },
    { k: 'tipo', label: 'Tipo', render: m => <><Chip t={TIPO_MOV_CORTO[m.tipo]} c={m.tipo === 'aporte' ? 'info' : m.tipo === 'reintegro' ? 'ok' : 'pend'} />{m.liquidacion_id && <span className="sub">Liquidación #{m.liquidacion_id}</span>}</>, csv: m => m.tipo },
    { k: 'cuenta', label: 'Cuenta', render: m => L.cuenta(m.cuenta_id), csv: m => L.cuenta(m.cuenta_id) },
    { k: 'importe', label: 'Importe', der: true, render: m => $(m.importe), csv: m => numCSV(m.importe) },
    { k: 'obs', label: 'Obs.', render: m => <span className="sub">{m.obs}</span>, csv: m => m.obs || '' },
    { k: 'acc', label: '', render: m => puede && !m.anulado ? <button className="btn sec chico" onClick={e => { e.stopPropagation(); anular('ob_mov_socios', m, notify, recargar); }}>Anular</button> : null },
  ];
  return (
    <>
      <div className="cab">
        <div><h1>Socios</h1><p>Lo que cada socio puso, lo que se le devolvió y las utilidades, en cuentas separadas.</p></div>
        <div className="acciones">
          <button className="btn sec" onClick={() => exportarCSV('movimientos-socios', cols.filter(c => c.csv), filas)}>Exportar CSV</button>
          {puede && <button className="btn" onClick={() => abrir(null)}>Nuevo movimiento</button>}
        </div>
      </div>
      <section className="bloque">
        <header><h3>Cuenta de reintegro</h3><span className="sub">Positivo: la sociedad le debe. Negativo: él le debe a la sociedad.</span></header>
        <Tabla filas={saldos.map(s => ({ ...s, id: s.socio.id }))} columnas={[
          { k: 'n', label: 'Socio', render: s => s.socio.nombre },
          { k: 'i', label: 'Saldo inicial', der: true, render: s => $(s.socio.saldo_ini_reintegro) },
          { k: 'a', label: '+ Aportes', der: true, render: s => $(s.aportes) },
          { k: 'g', label: '+ Pagos con su dinero', der: true, render: s => $(s.gastosPag) },
          { k: 'c', label: '− Cobros en su cuenta', der: true, render: s => $(s.cobrosRet) },
          { k: 'r', label: '− Reintegros', der: true, render: s => $(s.reint) },
          { k: 's', label: '= Se le debe', der: true, render: s => <strong><Neg v={s.saldoReint} /></strong> },
        ]} />
      </section>
      <section className="bloque">
        <header><h3>Cuenta de utilidades</h3><span className="sub">Positivo: ganancia liquidada sin cobrar. Negativo: retiró de más.</span></header>
        <Tabla filas={saldos.map(s => ({ ...s, id: s.socio.id }))} columnas={[
          { k: 'n', label: 'Socio', render: s => s.socio.nombre },
          { k: 'i', label: 'Saldo inicial', der: true, render: s => $(s.socio.saldo_ini_utilidades) },
          { k: 'a', label: '+ Liquidadas', der: true, render: s => $(s.asignadas) },
          { k: 'an', label: '− Anticipos', der: true, render: s => $(s.antic) },
          { k: 'p', label: '− Pagos de utilidades', der: true, render: s => $(s.pagos) },
          { k: 's', label: '= Sin cobrar', der: true, render: s => <strong><Neg v={s.saldoUtil} /></strong> },
        ]} />
      </section>
      <section className="bloque">
        <header><h3>Movimientos</h3></header>
        <div className="filtros">
          <select value={f.socio} onChange={e => setF({ ...f, socio: e.target.value })} aria-label="Socio"><option value="">Todos los socios</option>{d.socios.map(s => <option key={s.id} value={s.id}>{s.nombre}</option>)}</select>
          <select value={f.tipo} onChange={e => setF({ ...f, tipo: e.target.value })} aria-label="Tipo"><option value="">Todos los tipos</option>{TIPOS_MOV.map(t => <option key={t.v} value={t.v}>{TIPO_MOV_CORTO[t.v]}</option>)}</select>
          <input type="month" value={f.mes} onChange={e => setF({ ...f, mes: e.target.value })} aria-label="Mes" />
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 14 }}><input type="checkbox" checked={f.anulados} onChange={e => setF({ ...f, anulados: e.target.checked })} /> Ver anulados</label>
        </div>
        <Tabla columnas={cols} filas={filas} onFila={puede ? abrir : undefined} claseFila={m => m.anulado && 'anul'} vacio="No hay movimientos con estos filtros." />
      </section>
      <div className="grid2">
        <section className="bloque">
          <header><h3>Pagos hechos por socios</h3><span className="sub">Se cargan en Gastos y pagos</span></header>
          <Tabla filas={pagosSocio} vacio="Sin pagos de socios en este filtro." columnas={[
            { k: 'f', label: 'Fecha', render: p => fD(p.fecha) }, { k: 's', label: 'Socio', render: p => L.socio(p.socio_id) },
            { k: 't', label: 'A quién', render: p => L.ter(p.tercero_id) || '—' }, { k: 'i', label: 'Importe', der: true, render: p => $(p.importe) },
          ]} pie={{ f: 'Total', i: $(sum(pagosSocio, p => p.importe)) }} />
        </section>
        <section className="bloque">
          <header><h3>Cobros que entraron a cuentas de socios</h3></header>
          <Tabla filas={cobrosSocio} vacio="Sin cobros en cuentas de socios." columnas={[
            { k: 'f', label: 'Fecha', render: c => fD(c.fecha) }, { k: 's', label: 'Socio', render: c => L.socio(c.socio_id) },
            { k: 't', label: 'Cliente', render: c => L.ter(c.tercero_id) }, { k: 'i', label: 'Importe', der: true, render: c => $(c.importe) },
          ]} pie={{ f: 'Total', i: $(sum(cobrosSocio, c => c.importe)) }} />
        </section>
      </div>
      {edit && <FormModal titulo={edit.id ? `Movimiento #${edit.id}` : 'Nuevo movimiento de socio'} campos={campos} inicial={edit} validar={validar} onGuardar={guardar} onClose={() => setEdit(null)}
        extra={x => x.tipo === 'aporte' ? <div className="aviso">Si el socio pagó directamente a un proveedor, no es un aporte: cargalo como pago con “¿Quién pagó?” = el socio.</div> : null} />}
    </>
  );
}

// ---------- CAJA ----------
function libroCuenta(d, L, cuentaId) {
  const c = d.cuentas.find(x => x.id === cuentaId);
  if (!c) return [];
  const e = [];
  d.X.cobVivo.forEach(x => { if (x.cuenta_id === cuentaId) e.push({ fecha: x.fecha, desc: `Cobro: ${L.ter(x.tercero_id)}${x.nro_recibo ? ` rec. ${x.nro_recibo}` : ''}`, entra: n(x.importe), sale: 0, k: 'c' + x.id }); });
  d.X.pagVivo.forEach(x => { if (x.pagado_por === 'sociedad' && x.cuenta_id === cuentaId) e.push({ fecha: x.fecha, desc: `Pago: ${L.ter(x.tercero_id) || 'varios'}${x.medio ? ` (${x.medio})` : ''}`, entra: 0, sale: n(x.importe), k: 'p' + x.id }); });
  vivos(d.mov).forEach(m => { if (m.cuenta_id === cuentaId) e.push({ fecha: m.fecha, desc: `${TIPO_MOV_CORTO[m.tipo]}: ${L.socio(m.socio_id)}`, entra: m.tipo === 'aporte' ? n(m.importe) : 0, sale: m.tipo === 'aporte' ? 0 : n(m.importe), k: 'm' + m.id }); });
  vivos(d.transf).forEach(t => {
    if (t.cuenta_origen === cuentaId) e.push({ fecha: t.fecha, desc: `Transferencia a ${L.cuenta(t.cuenta_destino)}`, entra: 0, sale: n(t.importe), k: 'to' + t.id });
    if (t.cuenta_destino === cuentaId) e.push({ fecha: t.fecha, desc: `Transferencia desde ${L.cuenta(t.cuenta_origen)}`, entra: n(t.importe), sale: 0, k: 'td' + t.id });
  });
  e.sort((a, b) => a.fecha.localeCompare(b.fecha));
  let s = n(c.saldo_inicial);
  const out = [{ fecha: d.param.fecha_corte || '', desc: 'Saldo inicial', entra: 0, sale: 0, saldo: s, k: 'ini' }];
  e.forEach(x => { s += x.entra - x.sale; out.push({ ...x, saldo: r2(s) }); });
  return out;
}

function Caja({ ctx }) {
  const { d, L, puede, notify, recargar } = ctx;
  const cajas = useMemo(() => cajaCuentas(d), [d]);
  const [cta, setCta] = useState(cajas[0] ? cajas[0].id : null);
  const [mes, setMes] = useState('');
  const [edit, setEdit] = useState(null);
  const libro = useMemo(() => (cta ? libroCuenta(d, L, cta) : []), [d, L, cta]);
  const libroF = mes ? libro.filter(x => x.k === 'ini' || mesDe(x.fecha) === mes) : libro;
  const ctas = d.cuentas.filter(c => c.activa).map(c => ({ v: String(c.id), l: c.nombre }));
  return (
    <>
      <div className="cab">
        <div><h1>Caja</h1><p>Saldo de cada cuenta de la sociedad según lo cargado.</p></div>
        <div className="acciones">{puede && <button className="btn" onClick={() => setEdit({ fecha: hoy(), cuenta_origen: '', cuenta_destino: '', importe: '', obs: '' })}>Nueva transferencia</button>}</div>
      </div>
      <section className="bloque">
        <Tabla filas={cajas} vacio="No hay cuentas. Crealas en Configuración." onFila={c => setCta(c.id)} claseFila={c => c.id === cta ? 'sel' : ''} columnas={[
          { k: 'nombre', label: 'Cuenta', render: c => <>{c.nombre}<span className="sub">{c.tipo}{c.activa ? '' : ' · inactiva'}</span></> },
          { k: 'ini', label: 'Saldo inicial', der: true, render: c => $(c.saldo_inicial) },
          { k: 'saldo', label: 'Saldo actual', der: true, render: c => <strong><Neg v={c.saldo} /></strong> },
        ]} pie={{ nombre: 'Total', saldo: $(sum(cajas, c => c.saldo)) }} />
      </section>
      {cta && (
        <section className="bloque">
          <header><h3>Movimientos de {L.cuenta(cta)}</h3>
            <input type="month" value={mes} onChange={e => setMes(e.target.value)} aria-label="Mes" style={{ padding: '5px 8px', border: '1px solid var(--linea)', borderRadius: 4 }} /></header>
          <Tabla filas={libroF.map(x => ({ ...x, id: x.k }))} columnas={[
            { k: 'fecha', label: 'Fecha', render: x => fD(x.fecha) }, { k: 'desc', label: 'Detalle' },
            { k: 'entra', label: 'Entra', der: true, render: x => x.entra ? $(x.entra) : '' },
            { k: 'sale', label: 'Sale', der: true, render: x => x.sale ? $(x.sale) : '' },
            { k: 'saldo', label: 'Saldo', der: true, render: x => <Neg v={x.saldo} /> },
          ]} />
        </section>
      )}
      <section className="bloque">
        <header><h3>Transferencias entre cuentas</h3></header>
        <Tabla filas={d.transf.slice().sort(porFechaDesc('fecha'))} vacio="Sin transferencias." claseFila={t => t.anulado && 'anul'} columnas={[
          { k: 'f', label: 'Fecha', render: t => fD(t.fecha) }, { k: 'o', label: 'Desde', render: t => L.cuenta(t.cuenta_origen) },
          { k: 'd', label: 'Hacia', render: t => L.cuenta(t.cuenta_destino) }, { k: 'i', label: 'Importe', der: true, render: t => $(t.importe) },
          { k: 'obs', label: 'Obs.', render: t => <span className="sub">{t.obs}</span> },
          { k: 'a', label: '', render: t => puede && !t.anulado ? <button className="btn sec chico" onClick={() => anular('ob_transferencias', t, notify, recargar)}>Anular</button> : null },
        ]} />
      </section>
      {edit && <FormModal titulo="Nueva transferencia" inicial={edit} onClose={() => setEdit(null)} campos={[
        { k: 'fecha', label: 'Fecha', tipo: 'date', req: true }, { k: 'importe', label: 'Importe', tipo: 'number', req: true },
        { k: 'cuenta_origen', label: 'Desde', tipo: 'select', req: true, opciones: ctas }, { k: 'cuenta_destino', label: 'Hacia', tipo: 'select', req: true, opciones: ctas },
        { k: 'obs', label: 'Observaciones', tipo: 'textarea', full: true, ayuda: 'Ej.: extracción de efectivo para jornales' },
      ]} validar={x => n(x.importe) <= 0 ? 'El importe tiene que ser mayor a cero.' : x.cuenta_origen === x.cuenta_destino ? 'Elegí dos cuentas distintas.' : ''}
        onGuardar={async x => { await guardarFila('ob_transferencias', { fecha: x.fecha, cuenta_origen: Number(x.cuenta_origen), cuenta_destino: Number(x.cuenta_destino), importe: r2(x.importe), obs: x.obs || null }); notify('Transferencia guardada.'); recargar(); }} />}
    </>
  );
}

// ---------- OBRAS ----------
function Obras({ ctx }) {
  const { d, ir } = ctx;
  const [verTerm, setVerTerm] = useState(false);
  const res = useMemo(() => resumenObras(d), [d]);
  const filas = res.filter(o => !o.obra.es_general && (verTerm || o.obra.estado !== 'terminada'));
  const gen = res.find(o => o.obra.es_general);
  const TIPO = { mantenimiento: 'Mantenimiento', construccion: 'Construcción', especial: 'Especial', general: 'General' };
  const t = k => $(sum(filas, o => o[k]));
  return (
    <>
      <div className="cab">
        <div><h1>Control por obra</h1><p>Resultado sin IVA: lo cobrado menos todos los gastos (pagados o no), compromisos, impuestos y gastos generales asignados.</p></div>
        <div className="acciones"><label style={{ display: 'flex', gap: 6, alignItems: 'center' }}><input type="checkbox" checked={verTerm} onChange={e => setVerTerm(e.target.checked)} /> Incluir terminadas</label></div>
      </div>
      <section className="bloque">
        <Tabla filas={filas.map(o => ({ ...o, id: o.obra.id }))} vacio="No hay obras. Crealas en Configuración." columnas={[
          { k: 'n', label: 'Obra', render: o => <>{o.obra.nombre}<span className="sub">{TIPO[o.obra.tipo]} · {o.obra.estado}{o.obra.cliente ? ` · ${o.obra.cliente}` : ''}</span></> },
          { k: 'facturado', label: 'Facturado', der: true, render: o => $(o.facturado) },
          { k: 'cobrado', label: 'Cobrado', der: true, render: o => $(o.cobrado) },
          { k: 'porCobrar', label: 'Por cobrar', der: true, render: o => $(o.porCobrar) },
          { k: 'gastado', label: 'Pagado', der: true, render: o => $(o.gastado) },
          { k: 'pendiente', label: 'Por pagar', der: true, render: o => $(o.pendiente) },
          { k: 'compromisos', label: 'Compromisos', der: true, render: o => $(o.compromisos) },
          { k: 'resultado', label: 'Resultado', der: true, render: o => <strong><Neg v={o.resultado} /></strong> },
          { k: 'sinLiquidar', label: 'Cobrado sin liquidar', der: true, render: o => $(o.sinLiquidar) },
          { k: 'pendDistribuir', label: 'Por distribuir', der: true, render: o => <Neg v={o.pendDistribuir} /> },
          { k: 'rep', label: 'Reparto', render: o => { const er = estadoReparto(d, o.obra.id); return !er.completo ? <Chip t="Sin cargar" c="mal" /> : er.acordado ? <Chip t="Acordado" c="ok" /> : <Chip t="Propuesto" c="pend" />; } },
          { k: 'a', label: '', render: o => <span style={{ display: 'flex', gap: 10 }}>
            <button className="link" onClick={() => ir('ventas', { obra: String(o.obra.id) })}>Ventas</button>
            <button className="link" onClick={() => ir('compras', { obra: String(o.obra.id) })}>Gastos</button></span> },
        ]} pie={{ n: 'Total', facturado: t('facturado'), cobrado: t('cobrado'), porCobrar: t('porCobrar'), gastado: t('gastado'), pendiente: t('pendiente'),
          compromisos: t('compromisos'), resultado: t('resultado'), sinLiquidar: t('sinLiquidar'), pendDistribuir: t('pendDistribuir') }} />
      </section>
      {gen && (
        <section className="bloque">
          <header><h3>Gastos generales</h3><button className="link" onClick={() => ir('compras', { obra: String(gen.obra.id) })}>Ver gastos</button></header>
          <div className="cuerpo">Total sin IVA (con compromisos): <strong>{$(gen.gasNeto + gen.compromisos)}</strong>. Asignado a obras: {$(gen.asignados)}. <strong>Sin asignar: {$(gen.sinAsignar)}</strong>.
            <br /><span className="sub">Se asignan en cada liquidación, en proporción a lo cobrado pendiente de liquidar.</span></div>
        </section>
      )}
    </>
  );
}

// ---------- RECLAMOS ----------
function FormReclamo({ ctx, inicial, onClose }) {
  const { d, notify, recargar } = ctx;
  const campos = [
    { k: 'fecha', label: 'Fecha del reclamo', tipo: 'date', req: true },
    { k: 'socio_id', label: 'A quién', tipo: 'select', vacio: 'A todos los socios', opciones: d.socios.map(s => ({ v: String(s.id), l: s.nombre })) },
    { k: 'concepto', label: 'Qué se reclama', req: true, full: true, ayuda: 'Ej.: comprobante del pago a X, diferencia en la liquidación #3' },
    { k: 'importe', label: 'Importe', tipo: 'number' },
    { k: 'medio', label: 'Medio', ayuda: 'Mail, WhatsApp, nota' },
    { k: 'estado', label: 'Estado', tipo: 'select', req: true, sinVacio: true, opciones: [{ v: 'pendiente', l: 'Sin respuesta' }, { v: 'respondido', l: 'Respondido' }, { v: 'resuelto', l: 'Resuelto' }, { v: 'desistido', l: 'Desistido' }] },
    { k: 'fecha_respuesta', label: 'Fecha de respuesta', tipo: 'date', visible: x => x.estado !== 'pendiente' },
    { k: 'respuesta', label: 'Respuesta recibida', tipo: 'textarea', full: true, visible: x => x.estado !== 'pendiente' },
    { k: 'obs', label: 'Observaciones', tipo: 'textarea', full: true },
  ];
  const guardar = async x => {
    await guardarFila('ob_reclamos', { fecha: x.fecha, socio_id: idN(x.socio_id), concepto: x.concepto.trim(), importe: x.importe === '' ? null : r2(x.importe), medio: x.medio || null,
      estado: x.estado, respuesta: x.estado === 'pendiente' ? null : (x.respuesta || null), fecha_respuesta: x.estado === 'pendiente' ? null : (x.fecha_respuesta || null), obs: x.obs || null }, x.id);
    notify('Reclamo guardado.'); recargar();
  };
  return <FormModal titulo={inicial.id ? `Reclamo #${inicial.id}` : 'Nuevo reclamo'} campos={campos} inicial={inicial} onGuardar={guardar} onClose={onClose} />;
}

function Reclamos({ ctx }) {
  const { d, L, puede } = ctx;
  const [f, setF] = useState({ estado: 'pendiente' });
  const [edit, setEdit] = useState(null);
  const filas = d.reclamos.filter(r => !f.estado || r.estado === f.estado).sort(porFechaDesc('fecha'));
  const EST = { pendiente: ['Sin respuesta', 'mal'], respondido: ['Respondido', 'pend'], resuelto: ['Resuelto', 'ok'], desistido: ['Desistido', 'neu'] };
  const cols = [
    { k: 'f', label: 'Fecha', render: r => fD(r.fecha), csv: r => r.fecha },
    { k: 's', label: 'A', render: r => r.socio_id ? L.socio(r.socio_id) : 'Todos', csv: r => r.socio_id ? L.socio(r.socio_id) : 'Todos' },
    { k: 'c', label: 'Concepto', render: r => <>{r.concepto}<span className="sub">{r.medio}</span></>, csv: r => r.concepto },
    { k: 'i', label: 'Importe', der: true, render: r => r.importe ? $(r.importe) : '', csv: r => numCSV(r.importe) },
    { k: 'e', label: 'Estado', render: r => <Chip t={EST[r.estado][0]} c={EST[r.estado][1]} />, csv: r => r.estado },
    { k: 'r', label: 'Respuesta', render: r => <span className="sub">{r.fecha_respuesta ? `${fD(r.fecha_respuesta)}: ` : ''}{r.respuesta}</span>, csv: r => r.respuesta || '' },
  ];
  const abrir = r => setEdit(r && r.id ? { ...r, socio_id: r.socio_id ? String(r.socio_id) : '', importe: r.importe === null ? '' : String(r.importe), medio: r.medio || '',
    respuesta: r.respuesta || '', fecha_respuesta: r.fecha_respuesta || '', obs: r.obs || '' }
    : { fecha: hoy(), socio_id: '', concepto: '', importe: '', medio: '', estado: 'pendiente', respuesta: '', fecha_respuesta: '', obs: '' });
  return (
    <>
      <div className="cab">
        <div><h1>Reclamos</h1><p>Pedidos de información o de pago a los otros socios, con su respuesta. Dejarlos por escrito es lo que les da valor.</p></div>
        <div className="acciones">
          <button className="btn sec" onClick={() => exportarCSV('reclamos', cols, filas)}>Exportar CSV</button>
          {puede && <button className="btn" onClick={() => abrir(null)}>Nuevo reclamo</button>}
        </div>
      </div>
      <section className="bloque">
        <div className="filtros">
          <select value={f.estado} onChange={e => setF({ estado: e.target.value })} aria-label="Estado">
            <option value="">Todos</option>{Object.entries(EST).map(([k, v]) => <option key={k} value={k}>{v[0]}</option>)}
          </select>
        </div>
        <Tabla filas={filas} columnas={cols} onFila={puede ? abrir : undefined} vacio="No hay reclamos con este filtro." pie={{ f: 'Total', i: $(sum(filas, r => r.importe)) }} />
      </section>
      {edit && <FormReclamo ctx={ctx} inicial={edit} onClose={() => setEdit(null)} />}
    </>
  );
}

// ---------- LIQUIDACIONES ----------
function calcularLiq(d, obraId, pend, inp) {
  const gp = sum(vivos(d.gastos).filter(g => g.obra_id === obraId), g => d.X.saldoGas(g));
  const comp = sum(d.compromisos.filter(c => c.obra_id === obraId && c.estado === 'vigente'), c => c.importe);
  const res = resumenObras(d);
  const ro = res.find(x => x.obra.id === obraId);
  const gen = res.find(x => x.obra.es_general);
  const neto = r2(sum(pend, a => a.caja));
  const cajaLibre = r2(neto - gp - comp - n(inp.iva) - n(inp.otros) - n(inp.generales) - n(inp.fondo));
  const cajaDist = r2(cajaLibre - n(inp.reint));
  const resPend = r2(ro.pendDistribuir - n(inp.otros) - n(inp.generales));
  const distribuible = r2(Math.max(0, Math.min(cajaDist, resPend)));
  const er = estadoReparto(d, obraId);
  const det = d.socios.map(s => {
    const rp = er.filas.find(x => x.socio_id === s.id);
    const pct = rp ? n(rp.pct) : 0;
    return { socio_id: s.id, nombre: s.nombre, pct, importe: r2(distribuible * pct / 100) };
  }).filter(x => x.pct > 0);
  const dif = r2(distribuible - sum(det, x => x.importe));
  if (dif && det.length) { const mayor = det.reduce((a, b) => (b.pct > a.pct ? b : a)); mayor.importe = r2(mayor.importe + dif); }
  const socios = saldosSocios(d);
  return { gp: r2(gp), comp: r2(comp), neto, cajaLibre, cajaDist, resPend, distribuible, det, er, ro, genSinAsignar: gen ? gen.sinAsignar : 0,
    reintPend: r2(sum(socios.filter(s => s.saldoReint > 0), s => s.saldoReint)), socios };
}

function Cascada({ v, editable, inp, setInp, ayudas }) {
  const fila = (s, txt, val, k, ayuda) => (
    <tr><td>{s}</td><td>{txt}{ayuda && <span className="sub">{ayuda}</span>}</td>
      <td className="der">{editable && k ? <input type="number" step="0.01" inputMode="decimal" value={inp[k]} onChange={e => setInp({ ...inp, [k]: e.target.value })} aria-label={txt} /> : $(val)}</td></tr>
  );
  return (
    <table className="cascada"><tbody>
      {fila('', 'Cobrado que entró a caja', v.neto)}
      {fila('−', 'Gastos pendientes de pago de la obra', v.gp)}
      {fila('−', 'Compromisos vigentes de la obra', v.comp)}
      {fila('−', 'IVA a reservar', v.iva, 'iva', ayudas && ayudas.iva)}
      {fila('−', 'Otros impuestos a reservar', v.otros, 'otros', ayudas && ayudas.otros)}
      {fila('−', 'Gastos generales asignados', v.generales, 'generales', ayudas && ayudas.generales)}
      {fila('−', 'Fondo de reserva', v.fondo, 'fondo', ayudas && ayudas.fondo)}
      <tr className="tot"><td>=</td><td>Caja libre</td><td className="der"><Neg v={v.cajaLibre} /></td></tr>
      {fila('−', 'Reintegros a socios (devolver lo que pusieron)', v.reint, 'reint', ayudas && ayudas.reint)}
      <tr className="tot"><td>=</td><td>Caja distribuible</td><td className="der"><Neg v={v.cajaDist} /></td></tr>
      <tr><td></td><td>Resultado de la obra pendiente de distribuir<span className="sub">Después de impuestos y gastos generales de esta liquidación</span></td><td className="der"><Neg v={v.resPend} /></td></tr>
      <tr className="fin"><td></td><td>Se distribuye (el menor de los dos)</td><td className="der">{$(v.distribuible)}</td></tr>
    </tbody></table>
  );
}

function NuevaLiquidacion({ ctx, onClose }) {
  const { d, L, notify, recargar } = ctx;
  const conPend = d.obras.filter(o => !o.es_general).map(o => ({ o, pend: pendientesLiquidar(d, o.id) })).filter(x => x.pend.length);
  const totalPend = sum(conPend, x => sum(x.pend, a => a.caja));
  const [obraId, setObraId] = useState(conPend[0] ? String(conPend[0].o.id) : '');
  const sel = conPend.find(x => String(x.o.id) === obraId);
  const [inp, setInp] = useState(null);
  const [err, setErr] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [obs, setObs] = useState('');
  useEffect(() => {
    if (!sel) { setInp(null); return; }
    const base = calcularLiq(d, sel.o.id, sel.pend, { iva: 0, otros: 0, generales: 0, fondo: 0, reint: 0 });
    const iva = r2(sum(sel.pend, a => a.iva));
    const generales = base.genSinAsignar > 0 && totalPend > 0 ? r2(Math.min(base.genSinAsignar, base.genSinAsignar * base.neto / totalPend)) : 0;
    const fondo = r2(base.neto * n(d.param.fondo_reserva_pct) / 100);
    const reint = r2(Math.max(0, Math.min(base.neto - base.gp - base.comp - iva - generales - fondo, base.reintPend)));
    setInp({ iva: String(iva), otros: '0', generales: String(generales), fondo: String(fondo), reint: String(reint) });
  }, [obraId]); // eslint-disable-line
  const v = sel && inp ? calcularLiq(d, sel.o.id, sel.pend, inp) : null;
  const guardar = async () => {
    setErr('');
    if (!v.er.completo) { setErr(`El reparto de ${sel.o.nombre} suma ${v.er.total}%. Cargalo en Configuración > Obras.`); return; }
    if (['iva', 'otros', 'generales', 'fondo', 'reint'].some(k => n(inp[k]) < 0)) { setErr('Los importes a reservar no pueden ser negativos.'); return; }
    if (n(inp.generales) > v.genSinAsignar + 0.01) { setErr(`Los gastos generales superan lo que queda sin asignar (${$(v.genSinAsignar)}).`); return; }
    if (n(inp.reint) > v.reintPend + 0.01) { setErr(`Los reintegros superan lo que se les debe a los socios (${$(v.reintPend)}).`); return; }
    setEnviando(true);
    try {
      const id = await rpc('ob_guardar_liquidacion', { fecha: hoy(), obra_id: sel.o.id, aplic_ids: sel.pend.map(a => a.id), neto_cobrado: v.neto, gastos_pendientes: v.gp, compromisos: v.comp,
        iva_reserva: r2(inp.iva), otros_impuestos: r2(inp.otros), generales: r2(inp.generales), fondo_reserva: r2(inp.fondo), reintegros: r2(inp.reint),
        caja_distribuible: v.cajaDist, resultado_pendiente: v.resPend, distribuible: v.distribuible, obs: obs || null,
        detalle: v.det.map(x => ({ socio_id: x.socio_id, pct: x.pct, importe: x.importe })) });
      notify(`Liquidación #${id} guardada como borrador.`); await recargar(); onClose();
    } catch (e) { setErr(textoError(e)); } finally { setEnviando(false); }
  };
  return (
    <Modal titulo="Nueva liquidación" ancho onClose={onClose} pie={<>
      <button className="btn sec" onClick={onClose}>Cancelar</button>
      <button className="btn" onClick={guardar} disabled={!v || enviando}>{enviando ? 'Guardando…' : 'Guardar borrador'}</button></>}>
      {err && <div className="error" role="alert">{err}</div>}
      {!conPend.length ? <p>No hay cobros imputados a facturas pendientes de liquidar.</p> : (<>
        <div className="campo full" style={{ marginBottom: 14 }}>
          <label htmlFor="liq_obra">Obra</label>
          <select id="liq_obra" value={obraId} onChange={e => setObraId(e.target.value)}>
            {conPend.map(x => <option key={x.o.id} value={x.o.id}>{x.o.nombre}: {$(sum(x.pend, a => a.caja))} cobrado sin liquidar</option>)}
          </select>
        </div>
        {v && <>
          <Tabla filas={sel.pend} columnas={[
            { k: 'f', label: 'Cobro', render: a => fD(a.cobro.fecha) },
            { k: 'c', label: 'Cliente', render: a => L.ter(a.cobro.tercero_id) },
            { k: 'i', label: 'Factura', render: a => <>{a.ingreso.nro_factura || '—'}<span className="sub">{a.ingreso.concepto}</span></> },
            { k: 'm', label: 'Imputado', der: true, render: a => $(a.importe) },
            { k: 'x', label: 'Entró a caja', der: true, render: a => $(a.caja) },
          ]} />
          {!v.er.completo && <div className="error" style={{ marginTop: 12 }}>El reparto de esta obra no está cargado (suma {v.er.total}%).</div>}
          {v.er.completo && !v.er.acordado && <div className="aviso" style={{ marginTop: 12 }}>El reparto de esta obra está como propuesto, no acordado: la liquidación refleja ese criterio.</div>}
          <div style={{ marginTop: 14 }} />
          <Cascada v={{ ...v, iva: inp.iva, otros: inp.otros, generales: inp.generales, fondo: inp.fondo, reint: inp.reint }} editable inp={inp} setInp={setInp} ayudas={{
            iva: `IVA contenido en lo cobrado: ${$(sum(sel.pend, a => a.iva))}. Restá el crédito fiscal si corresponde.`,
            otros: 'IIBB, Ganancias estimado. Si ya está como compromiso de la obra, dejá 0.',
            generales: `Sin asignar: ${$(v.genSinAsignar)}. Sugerido en proporción a lo cobrado sin liquidar.`,
            fondo: `Parámetro: ${n(d.param.fondo_reserva_pct)}% de lo cobrado.`,
            reint: `A los socios se les debe ${$(v.reintPend)} en total.`,
          }} />
          {v.cajaDist < 0 && <div className="aviso" style={{ marginTop: 12 }}>La caja distribuible da negativa: lo cobrado no alcanza para cubrir deudas y reservas.</div>}
          <h3 style={{ margin: '18px 0 8px' }}>Por socio</h3>
          <Tabla filas={v.det.map(x => ({ ...x, id: x.socio_id, saldo: (v.socios.find(s => s.socio.id === x.socio_id) || {}).saldoUtil || 0 }))} vacio="Sin reparto." columnas={[
            { k: 'nombre', label: 'Socio' },
            { k: 'pct', label: '%', der: true, render: x => `${x.pct}%` },
            { k: 'importe', label: 'Le corresponde', der: true, render: x => <strong>{$(x.importe)}</strong> },
            { k: 'saldo', label: 'Utilidad sin cobrar hoy', der: true, render: x => <Neg v={x.saldo} /> },
            { k: 'desp', label: 'A cobrar después de aprobar', der: true, render: x => <Neg v={r2(x.saldo + x.importe)} /> },
          ]} />
          <div className="campo full" style={{ marginTop: 12 }}><label htmlFor="liq_obs">Observaciones</label><textarea id="liq_obs" rows={2} value={obs} onChange={e => setObs(e.target.value)} /></div>
        </>}
      </>)}
    </Modal>
  );
}

function DetalleLiquidacion({ ctx, liq, onClose }) {
  const { d, L, esAdmin, notify, recargar } = ctx;
  const det = d.liqDet.filter(x => x.liquidacion_id === liq.id);
  const apl = d.cobroAplic.filter(a => a.liquidacion_id === liq.id);
  const cajaLibre = r2(n(liq.neto_cobrado) - n(liq.gastos_pendientes) - n(liq.compromisos) - n(liq.iva_reserva) - n(liq.otros_impuestos) - n(liq.generales) - n(liq.fondo_reserva));
  const v = { neto: liq.neto_cobrado, gp: liq.gastos_pendientes, comp: liq.compromisos, iva: liq.iva_reserva, otros: liq.otros_impuestos, generales: liq.generales,
    fondo: liq.fondo_reserva, cajaLibre, reint: liq.reintegros, cajaDist: liq.caja_distribuible, resPend: liq.resultado_pendiente, distribuible: liq.distribuible };
  const pagado = sid => sum(vivos(d.mov).filter(m => m.liquidacion_id === liq.id && m.socio_id === sid && m.tipo === 'pago_utilidades'), m => m.importe);
  const cambiar = async (estado, extra) => {
    try { await guardarFila('ob_liquidaciones', { estado, ...(extra || {}) }, liq.id); notify(estado === 'aprobada' ? 'Liquidación aprobada.' : 'Liquidación anulada.'); recargar(); onClose(); }
    catch (e) { notify(textoError(e), true); }
  };
  const anularL = () => {
    const m = window.prompt('Motivo de la anulación:');
    if (m === null) return;
    if (!m.trim()) { notify('Hay que indicar un motivo.', true); return; }
    cambiar('anulada', { obs: [liq.obs, `Anulada: ${m.trim()}`].filter(Boolean).join(' | ') });
  };
  const EST = { borrador: 'pend', aprobada: 'ok', anulada: 'neu' };
  return (
    <Modal titulo={`Liquidación #${liq.id}`} ancho onClose={onClose} pie={<>
      <button className="btn sec" onClick={() => window.print()}>Imprimir</button>
      {esAdmin && liq.estado !== 'anulada' && <button className="btn peligro" onClick={anularL}>Anular</button>}
      {esAdmin && liq.estado === 'borrador' && <button className="btn" onClick={() => window.confirm('Al aprobar, las utilidades quedan asignadas a cada socio y la liquidación no se puede modificar. ¿Aprobar?') && cambiar('aprobada')}>Aprobar</button>}
    </>}>
      <p style={{ marginTop: 0 }}><Chip t={liq.estado} c={EST[liq.estado]} /> {L.obra(liq.obra_id)} · calculada el {fD(liq.fecha)}</p>
      {liq.estado === 'borrador' && <div className="aviso">Los importes quedaron fijos al guardar. Si después se cargaron gastos o compromisos de la obra, anulá este borrador y generá otro.</div>}
      {apl.length > 0 && <Tabla filas={apl} columnas={[
        { k: 'f', label: 'Cobro', render: a => { const c = d.cobros.find(x => x.id === a.cobro_id) || {}; return `${fD(c.fecha)} · ${L.ter(c.tercero_id)}`; } },
        { k: 'i', label: 'Factura', render: a => (d.X.ingById.get(a.ingreso_id) || {}).nro_factura || '—' },
        { k: 'm', label: 'Imputado', der: true, render: a => $(a.importe) },
      ]} />}
      <div style={{ marginTop: 14 }} />
      <Cascada v={v} />
      <h3 style={{ margin: '18px 0 8px' }}>Por socio: calculado contra pagado</h3>
      <Tabla filas={det.map(x => ({ ...x, id: x.socio_id, pag: pagado(x.socio_id) }))} columnas={[
        { k: 's', label: 'Socio', render: x => L.socio(x.socio_id) },
        { k: 'p', label: '%', der: true, render: x => `${n(x.pct)}%` },
        { k: 'i', label: 'Le corresponde', der: true, render: x => <strong>{$(x.importe)}</strong> },
        { k: 'g', label: 'Pagado', der: true, render: x => $(x.pag) },
        { k: 'd', label: 'Diferencia', der: true, render: x => <Neg v={r2(n(x.importe) - x.pag)} /> },
      ]} />
      {liq.estado === 'aprobada' && <p className="sub">Los pagos se registran en Socios como “Pago de utilidades”, eligiendo esta liquidación.</p>}
      {liq.obs && <p><strong>Observaciones:</strong> {liq.obs}</p>}
    </Modal>
  );
}

function Liquidaciones({ ctx }) {
  const { d, L, puede } = ctx;
  const [nueva, setNueva] = useState(false);
  const [ver, setVer] = useState(null);
  const filas = d.liqs.slice().sort((a, b) => b.id - a.id);
  const EST = { borrador: 'pend', aprobada: 'ok', anulada: 'neu' };
  return (
    <>
      <div className="cab">
        <div><h1>Liquidaciones</h1><p>Qué se hace con lo cobrado de cada obra: primero deudas y reservas, después devolver a los socios, y recién ahí repartir ganancia.</p></div>
        <div className="acciones">{puede && <button className="btn" onClick={() => setNueva(true)}>Liquidar una obra</button>}</div>
      </div>
      <section className="bloque">
        <Tabla filas={filas} onFila={setVer} claseFila={l => l.estado === 'anulada' && 'anul'} vacio="Todavía no hay liquidaciones." columnas={[
          { k: 'id', label: '#' },
          { k: 'f', label: 'Fecha', render: l => fD(l.fecha) },
          { k: 'o', label: 'Obra', render: l => L.obra(l.obra_id) },
          { k: 'n', label: 'Cobrado', der: true, render: l => $(l.neto_cobrado) },
          { k: 'r', label: 'Reintegros', der: true, render: l => $(l.reintegros) },
          { k: 'd', label: 'Distribuido', der: true, render: l => <strong>{$(l.distribuible)}</strong> },
          ...d.socios.map(s => ({ k: 's' + s.id, label: s.nombre.split(' ')[0], der: true, render: l => { const x = d.liqDet.find(y => y.liquidacion_id === l.id && y.socio_id === s.id); return x ? $(x.importe) : '—'; } })),
          { k: 'e', label: 'Estado', render: l => <Chip t={l.estado} c={EST[l.estado]} /> },
        ]} />
      </section>
      {nueva && <NuevaLiquidacion ctx={ctx} onClose={() => setNueva(false)} />}
      {ver && <DetalleLiquidacion ctx={ctx} liq={ver} onClose={() => setVer(null)} />}
    </>
  );
}

// ---------- CIERRE MENSUAL ----------
function Cierre({ ctx }) {
  const { d, esAdmin, notify, recargar } = ctx;
  const actual = mesDe(hoy());
  const meses = mesesEntre(d.param.fecha_corte || hoy(), hoy()).reverse();
  const [per, setPer] = useState(meses.find(m => m < actual) || meses[0]);
  const cierre = d.cierres.find(c => c.periodo === per);
  const hasta = finDeMes(per);
  const cajas = useMemo(() => cajaCuentas(d, hasta), [d, hasta]);
  const socios = useMemo(() => saldosSocios(d, hasta), [d, hasta]);
  const [reales, setReales] = useState({});
  const [obs, setObs] = useState('');
  const [env, setEnv] = useState({});
  useEffect(() => {
    setReales({}); setObs('');
    const c = d.cierres.find(x => x.periodo === per);
    setEnv(c ? { envio_fecha: c.envio_fecha || '', envio_medio: c.envio_medio || '', respuesta: c.respuesta, respuesta_fecha: c.respuesta_fecha || '', respuesta_detalle: c.respuesta_detalle || '' } : {});
  }, [per, d]);

  const enMes = f => f && mesDe(f) === per;
  const cob = [...d.X.cobVivo.values()], pag = [...d.X.pagVivo.values()];
  const facturado = sum(vivos(d.ingresos).filter(i => enMes(i.fecha)), i => i.bruto);
  const ingresado = sum(cob.filter(c => enMes(c.fecha)), c => c.importe);
  const gastado = sum(pag.filter(p => enMes(p.fecha)), p => p.importe);
  const devengado = sum(vivos(d.gastos).filter(g => enMes(g.fecha)), g => g.importe);
  const cobHasta = new Map(); d.X.aplCob.forEach(a => { if (d.X.cobVivo.get(a.cobro_id).fecha <= hasta) cobHasta.set(a.ingreso_id, (cobHasta.get(a.ingreso_id) || 0) + n(a.importe)); });
  const pagHasta = new Map(); d.X.aplPag.forEach(a => { if (d.X.pagVivo.get(a.pago_id).fecha <= hasta) pagHasta.set(a.gasto_id, (pagHasta.get(a.gasto_id) || 0) + n(a.importe)); });
  const porCobrar = sum(vivos(d.ingresos).filter(i => i.fecha <= hasta), i => Math.max(0, n(i.bruto) - (cobHasta.get(i.id) || 0)));
  const porPagar = sum(vivos(d.gastos).filter(g => g.fecha <= hasta), g => Math.max(0, n(g.importe) - (pagHasta.get(g.id) || 0)));
  const compVig = sum(d.compromisos.filter(c => c.estado === 'vigente'), c => c.importe);
  const cajaTot = sum(cajas, c => c.saldo);

  const conc = cierre ? cierre.conciliacion : cajas.map(c => ({ cuenta_id: c.id, nombre: c.nombre, sistema: c.saldo, real: reales[c.id] === undefined || reales[c.id] === '' ? null : r2(reales[c.id]) }));
  const difs = conc.map(c => (c.real === null || c.real === undefined ? null : r2(c.real - c.sistema)));
  const hayDif = difs.some(x => x !== null && Math.abs(x) > 1);

  const cerrar = async () => {
    if (per >= actual) { notify('Solo se pueden cerrar meses terminados.', true); return; }
    if (hayDif && !obs.trim()) { notify('Hay diferencias de conciliación: explicalas en observaciones antes de cerrar.', true); return; }
    if (!window.confirm(`Al cerrar ${mesLabel(per)} no se podrán cargar ni modificar movimientos de ese mes. ¿Cerrar?`)) return;
    const { data, error } = await sb.from('ob_cierres').insert({ periodo: per, conciliacion: conc, obs: obs || null,
      resumen: { facturado, ingresado, gastado, devengado, porCobrar, porPagar, compVig, cajaTot,
        socios: socios.map(s => ({ socio: s.socio.nombre, saldoReint: s.saldoReint, saldoUtil: s.saldoUtil })) } }).select();
    if (error || !data || !data.length) { notify(error ? textoError(error) : 'No se guardó: sin permisos.', true); return; }
    notify(`${mesLabel(per)} cerrado.`); recargar();
  };
  const guardarEnvio = async () => {
    const { data, error } = await sb.from('ob_cierres').update({ envio_fecha: env.envio_fecha || null, envio_medio: env.envio_medio || null, respuesta: env.respuesta,
      respuesta_fecha: env.respuesta_fecha || null, respuesta_detalle: env.respuesta_detalle || null }).eq('periodo', per).select();
    if (error || !data || !data.length) { notify(error ? textoError(error) : 'No se guardó: sin permisos.', true); return; }
    notify('Envío registrado.'); recargar();
  };
  const reabrir = async () => {
    if (!window.confirm(`¿Reabrir ${mesLabel(per)}? Se pierde el registro de envío.`)) return;
    const { data, error } = await sb.from('ob_cierres').delete().eq('periodo', per).select();
    if (error || !data || !data.length) { notify(error ? textoError(error) : 'No se pudo reabrir: sin permisos.', true); return; }
    notify(`${mesLabel(per)} reabierto.`); recargar();
  };
  const setE = (k, v) => setEnv(p => ({ ...p, [k]: v }));

  return (
    <>
      <div className="cab">
        <div><h1>Cierre de {mesLabel(per)}</h1><p>{cierre ? `Cerrado el ${fD(cierre.cerrado_at.slice(0, 10))}.` : 'Mes abierto.'} {d.param.empresa}</p></div>
        <div className="acciones">
          <select className="btn sec" value={per} onChange={e => setPer(e.target.value)} aria-label="Mes">
            {meses.map(m => <option key={m} value={m}>{mesLabel(m)}{d.cierres.some(c => c.periodo === m) ? ' (cerrado)' : ''}</option>)}
          </select>
          <button className="btn sec" onClick={() => window.print()}>Imprimir resumen</button>
        </div>
      </div>
      <div className="franja">
        <div><div className="q">Facturado</div><div className="v">{$(facturado)}</div></div>
        <div><div className="q">Cobrado</div><div className="v">{$(ingresado)}</div><div className="d">Entró a caja en el mes</div></div>
        <div><div className="q">Pagado</div><div className="v">{$(gastado)}</div><div className="d">Gastos del mes: {$(devengado)}</div></div>
        <div><div className="q">Nos deben al cierre</div><div className="v">{$(porCobrar)}</div></div>
        <div><div className="q">Debemos al cierre</div><div className="v neg">{$(porPagar)}</div><div className="d">Compromisos hoy: {$(compVig)}</div></div>
        <div className="clave"><div className="q">Caja al cierre</div><div className="v">{$(cajaTot)}</div></div>
      </div>

      <section className="bloque">
        <header><h3>Conciliación al {fD(hasta)}</h3><span className="sub">Opcional: completá solo las cuentas de las que tengas extracto</span></header>
        <Tabla filas={conc.map((c, i) => ({ ...c, id: c.cuenta_id, dif: difs[i] }))} vacio="No hay cuentas." columnas={[
          { k: 'nombre', label: 'Cuenta' },
          { k: 'sistema', label: 'Según lo cargado', der: true, render: c => $(c.sistema) },
          { k: 'real', label: 'Según extracto', der: true, render: c => cierre ? (c.real === null ? 'Sin dato' : $(c.real)) :
            <input type="number" step="0.01" inputMode="decimal" style={{ width: 150, padding: '5px 7px', textAlign: 'right', border: '1px solid var(--linea)', borderRadius: 4 }}
              value={reales[c.cuenta_id] ?? ''} onChange={e => setReales({ ...reales, [c.cuenta_id]: e.target.value })} aria-label={`Saldo según extracto ${c.nombre}`} /> },
          { k: 'dif', label: 'Diferencia', der: true, render: c => c.dif === null ? '—' : Math.abs(c.dif) <= 1 ? <Chip t="OK" c="ok" /> : <span className="neg">{$(c.dif)}</span> },
        ]} />
      </section>

      <section className="bloque">
        <header><h3>Saldo de cada socio al cierre</h3></header>
        <Tabla filas={socios.map(s => ({ ...s, id: s.socio.id }))} columnas={[
          { k: 'n', label: 'Socio', render: s => s.socio.nombre },
          { k: 'r', label: 'Se le debe (reintegro)', der: true, render: s => <Neg v={s.saldoReint} /> },
          { k: 'u', label: 'Utilidad sin cobrar', der: true, render: s => <Neg v={s.saldoUtil} /> },
          { k: 't', label: 'Total a su favor', der: true, render: s => <strong><Neg v={s.total} /></strong> },
        ]} />
      </section>

      <section className="bloque">
        <header><h3>{cierre ? 'Envío del resumen a los socios' : 'Cerrar el mes'}</h3></header>
        <div className="cuerpo">
          {cierre ? (<>
            {cierre.obs && <p style={{ marginTop: 0 }}><strong>Observaciones del cierre:</strong> {cierre.obs}</p>}
            <div className="campos">
              <Campo c={{ k: 'envio_fecha', label: 'Fecha de envío', tipo: 'date' }} v={env.envio_fecha} set={setE} />
              <Campo c={{ k: 'envio_medio', label: 'Medio', ayuda: 'Mail, WhatsApp, nota firmada' }} v={env.envio_medio} set={setE} />
              <Campo c={{ k: 'respuesta', label: 'Respuesta', tipo: 'select', sinVacio: true, opciones: [{ v: 'sin_envio', l: 'Todavía no se envió' }, { v: 'sin_respuesta', l: 'Enviado, sin respuesta' }, { v: 'conformidad', l: 'Dieron conformidad' }, { v: 'objecion', l: 'Objetaron' }] }} v={env.respuesta} set={setE} />
              <Campo c={{ k: 'respuesta_fecha', label: 'Fecha de respuesta', tipo: 'date' }} v={env.respuesta_fecha} set={setE} />
              <Campo c={{ k: 'respuesta_detalle', label: 'Detalle de la respuesta u objeción', tipo: 'textarea', full: true }} v={env.respuesta_detalle} set={setE} />
            </div>
            {esAdmin && <p className="acciones"><button className="btn" onClick={guardarEnvio}>Guardar envío</button><button className="btn sec" onClick={reabrir}>Reabrir mes</button></p>}
          </>) : (<>
            <div className="campo full" style={{ marginBottom: 12 }}><label htmlFor="c_obs">Observaciones del cierre{hayDif && <i> * (hay diferencias)</i>}</label><textarea id="c_obs" rows={2} value={obs} onChange={e => setObs(e.target.value)} /></div>
            {esAdmin ? <button className="btn" onClick={cerrar} disabled={per >= actual}>Cerrar {mesLabel(per)}</button> : <p className="sub">Solo un administrador puede cerrar el mes.</p>}
            {per >= actual && <p className="sub">El mes todavía no terminó.</p>}
          </>)}
        </div>
      </section>
    </>
  );
}

// ---------- CONFIGURACIÓN ----------
function Reparto({ ctx, obra, onClose }) {
  const { d, notify, recargar } = ctx;
  const ini = {};
  d.socios.forEach(s => { const r = d.reparto.find(x => x.obra_id === obra.id && x.socio_id === s.id); ini[s.id] = r ? String(r.pct) : ''; });
  const [f, setF] = useState(ini);
  const [acordado, setAcordado] = useState(d.reparto.some(x => x.obra_id === obra.id) && d.reparto.filter(x => x.obra_id === obra.id).every(x => x.acordado));
  const [err, setErr] = useState('');
  const total = r2(Object.values(f).reduce((a, x) => a + n(x), 0));
  const guardar = async () => {
    setErr('');
    if (Math.abs(total - 100) > 0.01) { setErr(`Los porcentajes suman ${total}% y tienen que sumar 100%.`); return; }
    const filas = d.socios.map(s => ({ obra_id: obra.id, socio_id: s.id, pct: r2(f[s.id]), acordado }));
    const { data, error } = await sb.from('ob_obra_reparto').upsert(filas, { onConflict: 'obra_id,socio_id' }).select();
    if (error || !data || data.length !== filas.length) { setErr(error ? textoError(error) : 'No se guardó: sin permisos.'); return; }
    notify('Reparto guardado.'); recargar(); onClose();
  };
  return (
    <Modal titulo={`Reparto de ganancia: ${obra.nombre}`} onClose={onClose} pie={<><button className="btn sec" onClick={onClose}>Cancelar</button><button className="btn" onClick={guardar}>Guardar</button></>}>
      {err && <div className="error">{err}</div>}
      {d.liqs.some(l => l.obra_id === obra.id && l.estado === 'aprobada') && <div className="aviso">Hay liquidaciones aprobadas de esta obra: el cambio aplica solo a las próximas.</div>}
      <div className="campos">{d.socios.map(s => (
        <div className="campo" key={s.id}><label htmlFor={'rp' + s.id}>{s.nombre} (%)</label>
          <input id={'rp' + s.id} type="number" step="0.01" value={f[s.id]} onChange={e => setF({ ...f, [s.id]: e.target.value })} /></div>
      ))}</div>
      <p><strong className={Math.abs(total - 100) > 0.01 ? 'neg' : 'pos'}>Total: {total}%</strong></p>
      <div className="campo check"><input id="rp_ac" type="checkbox" checked={acordado} onChange={e => setAcordado(e.target.checked)} />
        <label htmlFor="rp_ac">Acordado por escrito entre los socios (si no, queda como propuesto)</label></div>
    </Modal>
  );
}

function Parametros({ ctx }) {
  const { d, esAdmin, notify, recargar } = ctx;
  const [f, setF] = useState({ empresa: d.param.empresa || '', fecha_corte: d.param.fecha_corte || hoy(), fondo_reserva_pct: String(d.param.fondo_reserva_pct ?? 0),
    socio_propio_id: d.param.socio_propio_id ? String(d.param.socio_propio_id) : '' });
  const [err, setErr] = useState('');
  const set = (k, v) => setF(p => ({ ...p, [k]: v }));
  const guardar = async () => {
    setErr('');
    if (n(f.fondo_reserva_pct) < 0 || n(f.fondo_reserva_pct) > 100) { setErr('El fondo de reserva tiene que estar entre 0 y 100%.'); return; }
    const { data, error } = await sb.from('ob_parametros').upsert({ id: 1, empresa: f.empresa || null, fecha_corte: f.fecha_corte, fondo_reserva_pct: r2(f.fondo_reserva_pct), socio_propio_id: idN(f.socio_propio_id) }).select();
    if (error || !data || !data.length) { setErr(error ? textoError(error) : 'No se guardó: sin permisos.'); return; }
    notify('Parámetros guardados.'); recargar();
  };
  return (
    <section className="bloque"><div className="cuerpo">
      {err && <div className="error">{err}</div>}
      <div className="campos">
        <Campo c={{ k: 'empresa', label: 'Nombre de la sociedad' }} v={f.empresa} set={set} />
        <Campo c={{ k: 'socio_propio_id', label: 'Socio que lleva el sistema', tipo: 'select', opciones: d.socios.map(s => ({ v: String(s.id), l: s.nombre })), ayuda: 'Define la pantalla “Mi posición”.' }} v={f.socio_propio_id} set={set} />
        <Campo c={{ k: 'fecha_corte', label: 'Fecha de corte (inicio del sistema)', tipo: 'date', ayuda: 'Saldos iniciales de cuentas y socios a esta fecha.' }} v={f.fecha_corte} set={set} />
        <Campo c={{ k: 'fondo_reserva_pct', label: 'Fondo de reserva (% de lo cobrado)', tipo: 'number', ayuda: 'Se propone en cada liquidación.' }} v={f.fondo_reserva_pct} set={set} />
      </div>
      {esAdmin && <p><button className="btn" onClick={guardar}>Guardar parámetros</button></p>}
      <p className="sub">Saldos iniciales de clientes y proveedores: cargalos como una factura o gasto con comprobante “Saldo inicial al corte”, así se pueden cobrar o pagar contra ellos.</p>
    </div></section>
  );
}

function Config({ ctx }) {
  const { d, esAdmin, notify, recargar } = ctx;
  const [tab, setTab] = useState('param');
  const [edit, setEdit] = useState(null);
  const [rep, setRep] = useState(null);
  const TABS = [['param', 'Parámetros'], ['obras', 'Obras'], ['socios', 'Socios'], ['cuentas', 'Cuentas'], ['categorias', 'Categorías'], ['usuarios', 'Usuarios']];
  const guardarGen = (tabla, map, msg) => async x => { await guardarFila(tabla, map(x), x.id); notify(msg); recargar(); };
  const nombreSocio = id => (((d.socios.find(s => s.id === id) || {}).nombre) || '?').split(' ')[0];
  const defs = {
    obras: {
      titulo: 'Obra', tabla: 'ob_obras', nuevo: { codigo: '', nombre: '', cliente: '', tipo: 'mantenimiento', estado: 'activa' },
      campos: [
        { k: 'codigo', label: 'Código', req: true, ayuda: 'Corto y único. Ej.: ULL-26' }, { k: 'nombre', label: 'Nombre', req: true }, { k: 'cliente', label: 'Comitente' },
        { k: 'tipo', label: 'Tipo', tipo: 'select', req: true, sinVacio: true, opciones: [{ v: 'mantenimiento', l: 'Mantenimiento' }, { v: 'construccion', l: 'Construcción' }, { v: 'especial', l: 'Especial' }] },
        { k: 'estado', label: 'Estado', tipo: 'select', req: true, sinVacio: true, opciones: [{ v: 'activa', l: 'Activa' }, { v: 'suspendida', l: 'Suspendida' }, { v: 'terminada', l: 'Terminada' }] },
      ],
      map: x => ({ codigo: x.codigo.trim().toUpperCase(), nombre: x.nombre.trim(), cliente: x.cliente || null, tipo: x.tipo, estado: x.estado }),
      filas: d.obras.filter(o => !o.es_general),
      cols: [
        { k: 'codigo', label: 'Código' }, { k: 'nombre', label: 'Nombre' }, { k: 'cliente', label: 'Comitente' }, { k: 'tipo', label: 'Tipo' }, { k: 'estado', label: 'Estado' },
        { k: 'rep', label: 'Reparto', render: o => { const er = estadoReparto(d, o.id); return <>{er.filas.filter(x => n(x.pct) > 0).map(x => `${nombreSocio(x.socio_id)} ${n(x.pct)}%`).join(' · ') || 'Sin cargar'}
          {' '}{er.completo ? (er.acordado ? <Chip t="Acordado" c="ok" /> : <Chip t="Propuesto" c="pend" />) : <Chip t="Incompleto" c="mal" />}</>; } },
        { k: 'a', label: '', render: o => esAdmin ? <button className="btn sec chico" onClick={e => { e.stopPropagation(); setRep(o); }}>Reparto</button> : null },
      ],
    },
    socios: {
      titulo: 'Socio', tabla: 'ob_socios', nuevo: { nombre: '', saldo_ini_reintegro: '0', saldo_ini_utilidades: '0', activo: true },
      campos: [
        { k: 'nombre', label: 'Nombre', req: true, full: true },
        { k: 'saldo_ini_reintegro', label: 'Saldo inicial de reintegro', tipo: 'number', ayuda: 'A la fecha de corte. Positivo: la sociedad le debe.' },
        { k: 'saldo_ini_utilidades', label: 'Saldo inicial de utilidades', tipo: 'number', ayuda: 'Positivo: sin cobrar. Negativo: retiró de más.' },
        { k: 'activo', label: 'Activo', tipo: 'check' },
      ],
      map: x => ({ nombre: x.nombre.trim(), saldo_ini_reintegro: r2(x.saldo_ini_reintegro), saldo_ini_utilidades: r2(x.saldo_ini_utilidades), activo: !!x.activo }),
      filas: d.socios,
      cols: [{ k: 'nombre', label: 'Nombre' }, { k: 'r', label: 'Saldo inicial reintegro', der: true, render: s => $(s.saldo_ini_reintegro) },
        { k: 'u', label: 'Saldo inicial utilidades', der: true, render: s => $(s.saldo_ini_utilidades) }, { k: 'a', label: 'Estado', render: s => s.activo ? 'Activo' : 'Inactivo' }],
    },
    cuentas: {
      titulo: 'Cuenta', tabla: 'ob_cuentas', nuevo: { nombre: '', tipo: 'banco', saldo_inicial: '0', activa: true },
      campos: [
        { k: 'nombre', label: 'Nombre', req: true, ayuda: 'Ej.: Banco San Juan cta. cte., Caja efectivo' },
        { k: 'tipo', label: 'Tipo', tipo: 'select', req: true, sinVacio: true, opciones: [{ v: 'banco', l: 'Banco' }, { v: 'efectivo', l: 'Efectivo' }, { v: 'billetera', l: 'Billetera virtual' }, { v: 'otra', l: 'Otra' }] },
        { k: 'saldo_inicial', label: 'Saldo a la fecha de corte', tipo: 'number' }, { k: 'activa', label: 'Activa', tipo: 'check' },
      ],
      map: x => ({ nombre: x.nombre.trim(), tipo: x.tipo, saldo_inicial: r2(x.saldo_inicial), activa: !!x.activa }),
      filas: d.cuentas,
      cols: [{ k: 'nombre', label: 'Nombre' }, { k: 'tipo', label: 'Tipo' }, { k: 's', label: 'Saldo inicial', der: true, render: c => $(c.saldo_inicial) }, { k: 'a', label: 'Estado', render: c => c.activa ? 'Activa' : 'Inactiva' }],
    },
    categorias: {
      titulo: 'Categoría', tabla: 'ob_categorias', nuevo: { nombre: '', activa: true },
      campos: [{ k: 'nombre', label: 'Nombre', req: true, full: true }, { k: 'activa', label: 'Activa', tipo: 'check' }],
      map: x => ({ nombre: x.nombre.trim(), activa: !!x.activa }), filas: d.categorias,
      cols: [{ k: 'nombre', label: 'Nombre' }, { k: 'a', label: 'Estado', render: c => c.activa ? 'Activa' : 'Inactiva' }],
    },
  };
  const def = defs[tab];
  const aForm = x => Object.fromEntries(Object.entries(x).map(([k, v]) => [k, typeof v === 'number' && k !== 'id' ? String(v) : (v ?? '')]));
  return (
    <>
      <div className="cab"><div><h1>Configuración</h1></div>
        <div className="acciones">{esAdmin && def && <button className="btn" onClick={() => setEdit({ ...def.nuevo })}>Agregar {def.titulo.toLowerCase()}</button>}</div></div>
      <div className="tabs" role="tablist">{TABS.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'act' : ''} onClick={() => setTab(k)}>{l}</button>)}</div>
      {!esAdmin && <div className="aviso">Solo un administrador puede modificar la configuración.</div>}
      {def && <section className="bloque"><Tabla filas={def.filas} columnas={def.cols} onFila={esAdmin ? (x => setEdit(aForm(x))) : undefined} vacio="Sin registros." /></section>}
      {tab === 'param' && <Parametros ctx={ctx} />}
      {tab === 'usuarios' && (
        <section className="bloque"><div className="cuerpo">
          <Tabla filas={d.perfiles.map(p => ({ ...p, id: p.user_id }))} columnas={[{ k: 'nombre', label: 'Nombre' }, { k: 'rol', label: 'Rol' },
            { k: 's', label: 'Socio', render: p => p.socio_id ? (d.socios.find(s => s.id === p.socio_id) || {}).nombre : '' }]} />
          <p className="sub">Roles: admin (todo), carga (movimientos), lectura (consulta). Alta desde Supabase con las instrucciones al final de schema.sql.</p>
        </div></section>
      )}
      {edit && def && <FormModal titulo={edit.id ? `${def.titulo}: ${edit.nombre}` : `Nueva ${def.titulo.toLowerCase()}`} campos={def.campos} inicial={edit}
        onGuardar={guardarGen(def.tabla, def.map, `${def.titulo} guardada.`)} onClose={() => setEdit(null)} />}
      {rep && <Reparto ctx={ctx} obra={rep} onClose={() => setRep(null)} />}
    </>
  );
}

// ---------- LOGIN Y APLICACIÓN ----------
function Login() {
  const [email, setEmail] = useState('');
  const [pass, setPass] = useState('');
  const [err, setErr] = useState('');
  const [enviando, setEnviando] = useState(false);
  const entrar = async e => {
    e.preventDefault(); setErr(''); setEnviando(true);
    const { error } = await sb.auth.signInWithPassword({ email: email.trim(), password: pass });
    setEnviando(false);
    if (error) setErr(/invalid/i.test(error.message) ? 'Email o contraseña incorrectos.' : error.message);
  };
  return (
    <div className="login">
      <h1 style={{ marginBottom: 16 }}>Control de obras</h1>
      {err && <div className="error" role="alert">{err}</div>}
      <form onSubmit={entrar}>
        <div className="campo"><label htmlFor="l_e">Email</label><input id="l_e" type="email" autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} required /></div>
        <div className="campo"><label htmlFor="l_p">Contraseña</label><input id="l_p" type="password" autoComplete="current-password" value={pass} onChange={e => setPass(e.target.value)} required /></div>
        <button className="btn" type="submit" disabled={enviando} style={{ width: '100%' }}>{enviando ? 'Ingresando…' : 'Ingresar'}</button>
      </form>
    </div>
  );
}

const PAGINAS = [
  ['posicion', 'Mi posición'], ['sociedad', 'Sociedad'], ['ventas', 'Ventas y cobros'], ['compras', 'Gastos y pagos'], ['ctacte', 'Cuentas corrientes'],
  ['compromisos', 'Deudas'], ['socios', 'Socios'], ['caja', 'Caja'], ['obras', 'Obras'], ['liquidaciones', 'Liquidaciones'], ['reclamos', 'Reclamos'],
  ['cierre', 'Cierre mensual'], ['config', 'Configuración'],
];

function App() {
  const [sesion, setSesion] = useState(undefined);
  const [perfil, setPerfil] = useState(undefined);
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [pag, setPag] = useState('posicion');
  const [filtroIni, setFiltroIni] = useState(null);
  const [toast, setToast] = useState(null);
  const uid = sesion && sesion.user ? sesion.user.id : null;

  useEffect(() => {
    sb.auth.getSession().then(({ data }) => setSesion(data.session));
    const { data: sub } = sb.auth.onAuthStateChange((_e, s) => setSesion(s));
    return () => sub.subscription.unsubscribe();
  }, []);
  useEffect(() => {
    if (!uid) { setPerfil(undefined); setD(null); return; }
    sb.from('ob_perfiles').select('*').eq('user_id', uid).maybeSingle().then(({ data, error }) => {
      if (error) setErr(textoError(error));
      setPerfil(data || null);
    });
  }, [uid]);
  const recargar = useCallback(async () => {
    try { setD(await traerTodo()); setErr(''); } catch (e) { setErr(textoError(e)); }
  }, []);
  useEffect(() => { if (perfil) recargar(); }, [perfil, recargar]);
  const notify = useCallback((msg, esErr) => {
    setToast({ msg, err: !!esErr });
    clearTimeout(window.__obToast);
    window.__obToast = setTimeout(() => setToast(null), esErr ? 7000 : 3500);
  }, []);
  const ir = useCallback((p, filtro) => { setPag(p); setFiltroIni(filtro || null); window.scrollTo(0, 0); }, []);
  const L = useMemo(() => (d ? lookups(d) : null), [d]);

  if (sesion === undefined) return <div className="cargando">Cargando…</div>;
  if (!sesion) return <Login />;
  if (perfil === undefined) return <div className="cargando">Verificando usuario…</div>;
  if (perfil === null) return (
    <div className="login"><h2>Usuario sin acceso</h2><p>{err || 'Tu usuario todavía no tiene un perfil asignado en este sistema.'}</p>
      <button className="btn sec" onClick={() => sb.auth.signOut()}>Salir</button></div>
  );
  if (!d) return <div className="cargando">{err ? <div className="error">{err} <button className="link" onClick={recargar}>Reintentar</button></div> : 'Cargando datos…'}</div>;

  const ctx = { d, L, perfil, puede: ['admin', 'carga'].includes(perfil.rol), esAdmin: perfil.rol === 'admin', notify, recargar, ir };
  const clave = pag + JSON.stringify(filtroIni || {});
  const P = {
    posicion: <Posicion ctx={ctx} />, sociedad: <Sociedad ctx={ctx} />,
    ventas: <Ventas ctx={ctx} filtroIni={filtroIni} key={clave} />, compras: <Compras ctx={ctx} filtroIni={filtroIni} key={clave} />,
    ctacte: <CtaCte ctx={ctx} />, compromisos: <Compromisos ctx={ctx} />, socios: <Socios ctx={ctx} />, caja: <Caja ctx={ctx} />, obras: <Obras ctx={ctx} />,
    liquidaciones: <Liquidaciones ctx={ctx} />, reclamos: <Reclamos ctx={ctx} />, cierre: <Cierre ctx={ctx} />, config: <Config ctx={ctx} />,
  };
  return (
    <div className="app">
      <nav className="nav" aria-label="Secciones">
        <div className="marca">{d.param.empresa || 'Control de obras'}<small>Control económico</small></div>
        {PAGINAS.map(([k, l]) => <button key={k} className={pag === k ? 'act' : ''} aria-current={pag === k ? 'page' : undefined} onClick={() => ir(k)}>{l}</button>)}
        <div className="pie">{perfil.nombre} · {perfil.rol}<br /><button onClick={() => sb.auth.signOut()}>Salir</button></div>
      </nav>
      <main className="main">
        {err && <div className="error">{err} <button className="link" onClick={recargar}>Reintentar</button></div>}
        {P[pag]}
      </main>
      {toast && <div className={cls('toast', toast.err && 'err')} role="status">{toast.msg}</div>}
    </div>
  );
}

function Arranque() {
  if (!sb || /TU-PROYECTO/.test(CFG.supabaseUrl) || /TU-ANON/.test(CFG.supabaseAnonKey))
    return <div className="login"><h2>Falta configurar</h2><p>Completá supabaseUrl y supabaseAnonKey en index.html.</p></div>;
  return <App />;
}

createRoot(document.getElementById('root')).render(<Arranque />);
