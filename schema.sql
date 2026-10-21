-- =====================================================================
-- CONTROL ECONÓMICO DE OBRAS — esquema Supabase v2
-- Cambios vs v1: clientes/proveedores/empleados con cuenta corriente,
-- cobros y pagos separados de las facturas (con imputación parcial),
-- liquidación por obra sobre cobros imputados, reclamos, cierre con
-- registro de envío a socios. Pensado para que lo lleve un solo socio.
--
-- SI YA EJECUTASTE LA v1 (sin datos reales), borrá sus tablas primero:
-- drop table if exists ob_cierre_conformidad, ob_cierres, ob_liquidacion_detalle, ob_liquidaciones,
--   ob_transferencias, ob_mov_socios, ob_gastos, ob_compromisos, ob_ingresos, ob_parametros,
--   ob_obra_reparto, ob_obras, ob_categorias, ob_cuentas, ob_perfiles, ob_socios cascade;
-- drop function if exists ob_guardar_liquidacion(jsonb);
-- =====================================================================

-- ---------- Maestros ----------
create table if not exists ob_socios (
  id bigserial primary key,
  nombre text not null,
  saldo_ini_reintegro numeric(14,2) not null default 0,
  saldo_ini_utilidades numeric(14,2) not null default 0,
  activo boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists ob_perfiles (
  user_id uuid primary key references auth.users on delete cascade,
  nombre text not null,
  rol text not null check (rol in ('admin','carga','lectura')),
  socio_id bigint references ob_socios(id),
  created_at timestamptz not null default now()
);

create table if not exists ob_cuentas (
  id bigserial primary key,
  nombre text not null,
  tipo text not null default 'banco' check (tipo in ('banco','efectivo','billetera','otra')),
  saldo_inicial numeric(14,2) not null default 0,
  activa boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists ob_categorias (
  id bigserial primary key,
  nombre text not null unique,
  activa boolean not null default true
);

create table if not exists ob_obras (
  id bigserial primary key,
  codigo text not null unique,
  nombre text not null,
  cliente text,
  tipo text not null default 'mantenimiento' check (tipo in ('mantenimiento','construccion','especial','general')),
  estado text not null default 'activa' check (estado in ('activa','terminada','suspendida')),
  es_general boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists ob_obra_reparto (
  obra_id bigint not null references ob_obras(id),
  socio_id bigint not null references ob_socios(id),
  pct numeric(5,2) not null check (pct >= 0 and pct <= 100),
  acordado boolean not null default false,   -- informativo: propuesto vs. acordado por escrito
  primary key (obra_id, socio_id)
);

create table if not exists ob_parametros (
  id int primary key default 1 check (id = 1),
  empresa text,
  fecha_corte date,
  fondo_reserva_pct numeric(5,2) not null default 0,
  socio_propio_id bigint references ob_socios(id)   -- el socio que lleva el sistema
);

create table if not exists ob_terceros (
  id bigserial primary key,
  tipo text not null check (tipo in ('cliente','proveedor','empleado')),
  nombre text not null,
  cuit text,
  contacto text,
  obs text,
  activo boolean not null default true,
  created_at timestamptz not null default now(),
  unique (tipo, nombre)
);

-- ---------- Facturas de venta ----------
create table if not exists ob_ingresos (
  id bigserial primary key,
  fecha date not null,
  obra_id bigint not null references ob_obras(id),
  tercero_id bigint not null references ob_terceros(id),
  tipo_comprobante text not null default 'factura_a'
    check (tipo_comprobante in ('factura_a','factura_b','factura_c','certificado','saldo_inicial','otro')),
  nro_factura text,
  concepto text not null,
  bruto numeric(14,2) not null check (bruto > 0),
  iva numeric(14,2) not null default 0 check (iva >= 0),
  fecha_estimada date,
  fuente text not null default 'verificado' check (fuente in ('verificado','informado','estimado')),
  obs text,
  anulado boolean not null default false,
  motivo_anulacion text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ob_ing_iva_ok check (iva <= bruto),
  constraint ob_ing_anul_ok check (not anulado or coalesce(motivo_anulacion,'') <> '')
);

-- ---------- Cobros (recibos) ----------
create table if not exists ob_cobros (
  id bigserial primary key,
  fecha date not null,
  tercero_id bigint not null references ob_terceros(id),
  importe numeric(14,2) not null check (importe >= 0),          -- lo que entró en caja
  retenciones numeric(14,2) not null default 0 check (retenciones >= 0),
  cuenta_id bigint references ob_cuentas(id),
  socio_id bigint references ob_socios(id),                      -- el cliente pagó en la cuenta de un socio
  obra_id bigint references ob_obras(id),                        -- orientativo si queda a cuenta
  nro_recibo text,
  fuente text not null default 'verificado' check (fuente in ('verificado','informado','estimado')),
  obs text,
  anulado boolean not null default false,
  motivo_anulacion text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ob_cob_total check (importe + retenciones > 0),
  constraint ob_cob_destino check ((cuenta_id is not null) <> (socio_id is not null)),
  constraint ob_cob_anul_ok check (not anulado or coalesce(motivo_anulacion,'') <> '')
);

-- ---------- Gastos / facturas de compra ----------
create table if not exists ob_compromisos (
  id bigserial primary key,
  concepto text not null,
  proveedor text,
  obra_id bigint not null references ob_obras(id),
  importe numeric(14,2) not null check (importe > 0),
  vencimiento date,
  prioridad text not null default 'media' check (prioridad in ('alta','media','baja')),
  estado text not null default 'vigente' check (estado in ('vigente','convertido','cancelado')),
  gasto_id bigint,
  obs text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists ob_gastos (
  id bigserial primary key,
  fecha date not null,
  obra_id bigint not null references ob_obras(id),
  categoria_id bigint references ob_categorias(id),
  tercero_id bigint references ob_terceros(id),
  proveedor text,                                  -- texto libre si no hay tercero (ticket de estación, etc.)
  concepto text not null,
  importe numeric(14,2) not null check (importe > 0),
  iva_credito numeric(14,2) not null default 0 check (iva_credito >= 0),
  vencimiento date,
  tipo_comprobante text not null default 'factura_a'
    check (tipo_comprobante in ('factura_a','factura_b','factura_c','recibo','recibo_sueldo','ticket','saldo_inicial','sin_comprobante')),
  nro_comprobante text,
  comprobante_path text,
  compromiso_id bigint references ob_compromisos(id),
  fuente text not null default 'verificado' check (fuente in ('verificado','informado','estimado')),
  obs text,
  anulado boolean not null default false,
  motivo_anulacion text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ob_gas_iva_ok check (iva_credito <= importe),
  constraint ob_gas_prov check (tercero_id is not null or coalesce(proveedor,'') <> ''),
  constraint ob_gas_anul_ok check (not anulado or coalesce(motivo_anulacion,'') <> '')
);

-- ---------- Pagos (órdenes de pago) ----------
create table if not exists ob_pagos (
  id bigserial primary key,
  fecha date not null,
  tercero_id bigint references ob_terceros(id),
  importe numeric(14,2) not null check (importe > 0),
  pagado_por text not null check (pagado_por in ('sociedad','socio')),
  cuenta_id bigint references ob_cuentas(id),
  socio_id bigint references ob_socios(id),
  medio text,
  nro_comprobante text,
  fuente text not null default 'verificado' check (fuente in ('verificado','informado','estimado')),
  obs text,
  anulado boolean not null default false,
  motivo_anulacion text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ob_pag_quien check (
    (pagado_por = 'sociedad' and cuenta_id is not null and socio_id is null) or
    (pagado_por = 'socio' and socio_id is not null and cuenta_id is null)),
  constraint ob_pag_anul_ok check (not anulado or coalesce(motivo_anulacion,'') <> '')
);

-- ---------- Socios, caja, liquidaciones ----------
create table if not exists ob_transferencias (
  id bigserial primary key,
  fecha date not null,
  cuenta_origen bigint not null references ob_cuentas(id),
  cuenta_destino bigint not null references ob_cuentas(id),
  importe numeric(14,2) not null check (importe > 0),
  obs text,
  anulado boolean not null default false,
  motivo_anulacion text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ob_tr_distintas check (cuenta_origen <> cuenta_destino),
  constraint ob_tr_anul_ok check (not anulado or coalesce(motivo_anulacion,'') <> '')
);

create table if not exists ob_liquidaciones (
  id bigserial primary key,
  fecha date not null default current_date,
  obra_id bigint not null references ob_obras(id),
  neto_cobrado numeric(14,2) not null,
  gastos_pendientes numeric(14,2) not null default 0,
  compromisos numeric(14,2) not null default 0,
  iva_reserva numeric(14,2) not null default 0,
  otros_impuestos numeric(14,2) not null default 0,
  generales numeric(14,2) not null default 0,
  fondo_reserva numeric(14,2) not null default 0,
  reintegros numeric(14,2) not null default 0,
  caja_distribuible numeric(14,2) not null,
  resultado_pendiente numeric(14,2) not null,
  distribuible numeric(14,2) not null check (distribuible >= 0),
  estado text not null default 'borrador' check (estado in ('borrador','aprobada','anulada')),
  aprobado_por uuid,
  aprobado_at timestamptz,
  obs text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);

create table if not exists ob_liquidacion_detalle (
  liquidacion_id bigint not null references ob_liquidaciones(id),
  socio_id bigint not null references ob_socios(id),
  pct numeric(5,2) not null,
  importe numeric(14,2) not null,
  primary key (liquidacion_id, socio_id)
);

create table if not exists ob_mov_socios (
  id bigserial primary key,
  fecha date not null,
  socio_id bigint not null references ob_socios(id),
  tipo text not null check (tipo in ('aporte','reintegro','anticipo','pago_utilidades')),
  importe numeric(14,2) not null check (importe > 0),
  cuenta_id bigint not null references ob_cuentas(id),
  obra_id bigint references ob_obras(id),
  liquidacion_id bigint references ob_liquidaciones(id),
  obs text,
  anulado boolean not null default false,
  motivo_anulacion text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ob_mov_anul_ok check (not anulado or coalesce(motivo_anulacion,'') <> '')
);

-- ---------- Imputaciones ----------
create table if not exists ob_cobro_aplic (
  id bigserial primary key,
  cobro_id bigint not null references ob_cobros(id),
  ingreso_id bigint not null references ob_ingresos(id),
  importe numeric(14,2) not null check (importe > 0),
  liquidacion_id bigint references ob_liquidaciones(id),
  created_at timestamptz not null default now()
);
create index if not exists ob_cobro_aplic_ing on ob_cobro_aplic(ingreso_id);
create index if not exists ob_cobro_aplic_cob on ob_cobro_aplic(cobro_id);

create table if not exists ob_pago_aplic (
  id bigserial primary key,
  pago_id bigint not null references ob_pagos(id),
  gasto_id bigint not null references ob_gastos(id),
  importe numeric(14,2) not null check (importe > 0),
  created_at timestamptz not null default now()
);
create index if not exists ob_pago_aplic_gas on ob_pago_aplic(gasto_id);
create index if not exists ob_pago_aplic_pag on ob_pago_aplic(pago_id);

-- ---------- Reclamos y cierres ----------
create table if not exists ob_reclamos (
  id bigserial primary key,
  fecha date not null default current_date,
  socio_id bigint references ob_socios(id),       -- a quién se reclama
  concepto text not null,
  importe numeric(14,2),
  medio text,
  estado text not null default 'pendiente' check (estado in ('pendiente','respondido','resuelto','desistido')),
  respuesta text,
  fecha_respuesta date,
  obs text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists ob_cierres (
  periodo text primary key check (periodo ~ '^\d{4}-\d{2}$'),
  conciliacion jsonb not null,
  resumen jsonb,
  obs text,
  envio_fecha date,
  envio_medio text,
  respuesta text not null default 'sin_envio' check (respuesta in ('sin_envio','sin_respuesta','conformidad','objecion')),
  respuesta_fecha date,
  respuesta_detalle text,
  cerrado_por uuid default auth.uid(),
  cerrado_at timestamptz not null default now()
);

-- ---------- Funciones auxiliares ----------
create or replace function ob_rol() returns text
language sql stable security definer set search_path = public as $$
  select rol from ob_perfiles where user_id = auth.uid()
$$;

create or replace function ob_touch() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;

create or replace function ob_aplicado_ingreso(p_id bigint) returns numeric
language sql stable set search_path = public as $$
  select coalesce(sum(a.importe),0) from ob_cobro_aplic a join ob_cobros c on c.id = a.cobro_id
  where a.ingreso_id = p_id and not c.anulado
$$;

create or replace function ob_aplicado_gasto(p_id bigint) returns numeric
language sql stable set search_path = public as $$
  select coalesce(sum(a.importe),0) from ob_pago_aplic a join ob_pagos p on p.id = a.pago_id
  where a.gasto_id = p_id and not p.anulado
$$;

-- Períodos cerrados: no se carga ni se modifica nada con fecha en un mes cerrado,
-- salvo las columnas pasadas como argumento (observaciones, archivo, etc.).
create or replace function ob_periodo_guard() returns trigger language plpgsql as $$
declare permitidos text[] := coalesce(tg_argv, '{}'::text[]);
begin
  if tg_op = 'INSERT' then
    if exists (select 1 from ob_cierres where periodo = to_char(new.fecha,'YYYY-MM')) then
      raise exception 'El período % está cerrado. Usá una fecha de un mes abierto.', to_char(new.fecha,'YYYY-MM');
    end if;
  else
    if exists (select 1 from ob_cierres where periodo in (to_char(old.fecha,'YYYY-MM'), to_char(new.fecha,'YYYY-MM')))
       and (to_jsonb(old) - permitidos - 'updated_at') <> (to_jsonb(new) - permitidos - 'updated_at') then
      raise exception 'El registro pertenece a un período cerrado. Para corregir, cargá un ajuste en un mes abierto.';
    end if;
  end if;
  return new;
end $$;

-- Facturas: no bajar el importe por debajo de lo ya cobrado/pagado ni anular con imputaciones vigentes.
create or replace function ob_ingreso_guard() returns trigger language plpgsql as $$
declare v numeric := ob_aplicado_ingreso(old.id);
begin
  if new.anulado and not old.anulado and v > 0 then
    raise exception 'La factura tiene cobros imputados por %. Anulá primero esos cobros.', v;
  end if;
  if new.bruto < v then
    raise exception 'El importe no puede ser menor a lo ya cobrado (%).', v;
  end if;
  if new.tercero_id <> old.tercero_id and v > 0 then
    raise exception 'No se puede cambiar el cliente de una factura con cobros imputados.';
  end if;
  if new.obra_id <> old.obra_id and exists (select 1 from ob_cobro_aplic a join ob_liquidaciones l on l.id = a.liquidacion_id
      where a.ingreso_id = old.id and l.estado <> 'anulada') then
    raise exception 'La factura tiene cobros ya liquidados: no se puede cambiar de obra.';
  end if;
  return new;
end $$;

create or replace function ob_gasto_guard() returns trigger language plpgsql as $$
declare v numeric := ob_aplicado_gasto(old.id);
begin
  if new.anulado and not old.anulado and v > 0 then
    raise exception 'El gasto tiene pagos imputados por %. Anulá primero esos pagos.', v;
  end if;
  if new.importe < v then
    raise exception 'El importe no puede ser menor a lo ya pagado (%).', v;
  end if;
  if new.tercero_id is distinct from old.tercero_id and v > 0 then
    raise exception 'No se puede cambiar el proveedor de un gasto con pagos imputados.';
  end if;
  return new;
end $$;

-- Cobros y pagos: los importes no se editan (se anula y se recarga).
create or replace function ob_cobro_guard() returns trigger language plpgsql as $$
begin
  if new.anulado and not old.anulado and exists (select 1 from ob_cobro_aplic a join ob_liquidaciones l on l.id = a.liquidacion_id
      where a.cobro_id = old.id and l.estado <> 'anulada') then
    raise exception 'El cobro está incluido en una liquidación vigente. Anulá primero la liquidación.';
  end if;
  if (to_jsonb(old) - array['obs','anulado','motivo_anulacion','updated_at','nro_recibo','fuente'])
     <> (to_jsonb(new) - array['obs','anulado','motivo_anulacion','updated_at','nro_recibo','fuente']) then
    raise exception 'Los importes de un cobro no se modifican: anulalo y cargalo de nuevo.';
  end if;
  return new;
end $$;

create or replace function ob_pago_guard() returns trigger language plpgsql as $$
begin
  if (to_jsonb(old) - array['obs','anulado','motivo_anulacion','updated_at','nro_comprobante','medio','fuente'])
     <> (to_jsonb(new) - array['obs','anulado','motivo_anulacion','updated_at','nro_comprobante','medio','fuente']) then
    raise exception 'Los importes de un pago no se modifican: anulalo y cargalo de nuevo.';
  end if;
  return new;
end $$;

-- Gasto cargado desde un compromiso: el compromiso queda convertido; si el gasto se anula, vuelve a vigente.
create or replace function ob_gasto_compromiso() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' and new.anulado and not old.anulado and new.compromiso_id is not null then
    update ob_compromisos set estado = 'vigente', gasto_id = null where id = new.compromiso_id;
    return new;
  end if;
  if new.compromiso_id is not null and (tg_op = 'INSERT' or old.compromiso_id is distinct from new.compromiso_id) then
    update ob_compromisos set estado = 'convertido', gasto_id = new.id where id = new.compromiso_id and estado = 'vigente';
    if not found then raise exception 'El compromiso % no está vigente.', new.compromiso_id; end if;
  end if;
  return new;
end $$;

-- Liquidación: aprobada o anulada = inmutable. Al anular se liberan los cobros imputados.
create or replace function ob_liq_guard() returns trigger language plpgsql as $$
declare v_sum numeric;
begin
  if coalesce(ob_rol(),'') <> 'admin' and new.estado <> old.estado then
    raise exception 'Solo un administrador puede aprobar o anular liquidaciones.';
  end if;
  if old.estado = 'anulada' then raise exception 'La liquidación % está anulada.', old.id; end if;
  if old.estado = 'aprobada' and new.estado <> 'anulada' then
    raise exception 'La liquidación % está aprobada. Anulala y generá una nueva.', old.id;
  end if;
  if new.estado = 'anulada' and (to_jsonb(old) - 'estado' - 'obs') <> (to_jsonb(new) - 'estado' - 'obs') then
    raise exception 'Al anular solo se cambia el estado y la observación.';
  end if;
  if old.estado = 'borrador' and new.estado = 'aprobada' then
    select coalesce(sum(pct),0) into v_sum from ob_liquidacion_detalle where liquidacion_id = old.id;
    if abs(v_sum - 100) > 0.01 then raise exception 'El reparto suma % %% y debe sumar 100 %%.', v_sum; end if;
    new.aprobado_por := auth.uid();
    new.aprobado_at := now();
  end if;
  if new.estado = 'anulada' then
    update ob_cobro_aplic set liquidacion_id = null where liquidacion_id = old.id;
  end if;
  return new;
end $$;

create or replace function ob_cierre_guard() returns trigger language plpgsql as $$
declare libres text[] := array['envio_fecha','envio_medio','respuesta','respuesta_fecha','respuesta_detalle','obs'];
begin
  if (to_jsonb(old) - libres) <> (to_jsonb(new) - libres) then
    raise exception 'De un mes cerrado solo se registra el envío y la respuesta de los socios.';
  end if;
  return new;
end $$;

-- ---------- Operaciones atómicas ----------
-- Cobro con imputaciones. p: {id?, fecha, tercero_id, importe, retenciones, cuenta_id, socio_id, obra_id,
--   nro_recibo, fuente, obs, aplic:[{ingreso_id, importe}], ingreso:{...} (factura nueva cobrada en el acto)}
-- Con p.id solo agrega imputaciones a un cobro existente (aplicar saldo a cuenta).
create or replace function ob_guardar_cobro(p jsonb) returns bigint
language plpgsql security invoker set search_path = public as $$
declare v_id bigint; v_ing bigint; c record; a jsonb; v_aplic jsonb := coalesce(p->'aplic','[]'::jsonb);
        v_total numeric; v_prev numeric; v_saldo numeric; f record;
begin
  if p ? 'ingreso' and jsonb_typeof(p->'ingreso') = 'object' then
    insert into ob_ingresos (fecha, obra_id, tercero_id, tipo_comprobante, nro_factura, concepto, bruto, iva, fuente, obs)
    values ((p->'ingreso'->>'fecha')::date, (p->'ingreso'->>'obra_id')::bigint, (p->>'tercero_id')::bigint,
      p->'ingreso'->>'tipo_comprobante', p->'ingreso'->>'nro_factura', p->'ingreso'->>'concepto',
      (p->'ingreso'->>'bruto')::numeric, coalesce((p->'ingreso'->>'iva')::numeric,0), coalesce(p->>'fuente','verificado'), p->'ingreso'->>'obs')
    returning id into v_ing;
    v_aplic := jsonb_build_array(jsonb_build_object('ingreso_id', v_ing, 'importe', (p->'ingreso'->>'bruto')::numeric));
  end if;

  if p ? 'id' and (p->>'id') is not null then
    v_id := (p->>'id')::bigint;
  else
    insert into ob_cobros (fecha, tercero_id, importe, retenciones, cuenta_id, socio_id, obra_id, nro_recibo, fuente, obs)
    values ((p->>'fecha')::date, (p->>'tercero_id')::bigint, (p->>'importe')::numeric, coalesce((p->>'retenciones')::numeric,0),
      (p->>'cuenta_id')::bigint, (p->>'socio_id')::bigint, (p->>'obra_id')::bigint, p->>'nro_recibo',
      coalesce(p->>'fuente','verificado'), p->>'obs')
    returning id into v_id;
  end if;

  select * into c from ob_cobros where id = v_id;
  if not found then raise exception 'El cobro % no existe.', v_id; end if;
  if c.anulado then raise exception 'El cobro está anulado.'; end if;
  select coalesce(sum(importe),0) into v_prev from ob_cobro_aplic where cobro_id = v_id;
  select coalesce(sum((x->>'importe')::numeric),0) into v_total from jsonb_array_elements(v_aplic) x;
  if v_prev + v_total > c.importe + c.retenciones + 0.01 then
    raise exception 'Se imputa % y el cobro (con retenciones) es de %.', v_prev + v_total, c.importe + c.retenciones;
  end if;
  for a in select * from jsonb_array_elements(v_aplic) loop
    if (a->>'importe')::numeric <= 0 then continue; end if;
    select * into f from ob_ingresos where id = (a->>'ingreso_id')::bigint;
    if not found or f.anulado then raise exception 'La factura % no existe o está anulada.', a->>'ingreso_id'; end if;
    if f.tercero_id <> c.tercero_id then raise exception 'La factura % es de otro cliente.', f.id; end if;
    v_saldo := f.bruto - ob_aplicado_ingreso(f.id);
    if (a->>'importe')::numeric > v_saldo + 0.01 then
      raise exception 'A la factura % le quedan % por cobrar y se imputan %.', f.id, v_saldo, a->>'importe';
    end if;
    insert into ob_cobro_aplic (cobro_id, ingreso_id, importe) values (v_id, f.id, (a->>'importe')::numeric);
  end loop;
  return v_id;
end $$;

-- Pago con imputaciones. p: {id?, fecha, tercero_id, importe, pagado_por, cuenta_id, socio_id, medio,
--   nro_comprobante, fuente, obs, aplic:[{gasto_id, importe}], gasto:{...} (gasto nuevo pagado en el acto)}
create or replace function ob_guardar_pago(p jsonb) returns bigint
language plpgsql security invoker set search_path = public as $$
declare v_id bigint; v_gas bigint; pg record; a jsonb; v_aplic jsonb := coalesce(p->'aplic','[]'::jsonb);
        v_total numeric; v_prev numeric; v_saldo numeric; g record; v_ter bigint := (p->>'tercero_id')::bigint;
begin
  if p ? 'gasto' and jsonb_typeof(p->'gasto') = 'object' then
    insert into ob_gastos (fecha, obra_id, categoria_id, tercero_id, proveedor, concepto, importe, iva_credito, vencimiento,
      tipo_comprobante, nro_comprobante, comprobante_path, compromiso_id, fuente, obs)
    values ((p->'gasto'->>'fecha')::date, (p->'gasto'->>'obra_id')::bigint, (p->'gasto'->>'categoria_id')::bigint, v_ter,
      p->'gasto'->>'proveedor', p->'gasto'->>'concepto', (p->'gasto'->>'importe')::numeric,
      coalesce((p->'gasto'->>'iva_credito')::numeric,0), (p->'gasto'->>'vencimiento')::date,
      p->'gasto'->>'tipo_comprobante', p->'gasto'->>'nro_comprobante', p->'gasto'->>'comprobante_path',
      (p->'gasto'->>'compromiso_id')::bigint, coalesce(p->>'fuente','verificado'), p->'gasto'->>'obs')
    returning id into v_gas;
    v_aplic := jsonb_build_array(jsonb_build_object('gasto_id', v_gas, 'importe', (p->'gasto'->>'importe')::numeric));
  end if;

  if p ? 'id' and (p->>'id') is not null then
    v_id := (p->>'id')::bigint;
  else
    insert into ob_pagos (fecha, tercero_id, importe, pagado_por, cuenta_id, socio_id, medio, nro_comprobante, fuente, obs)
    values ((p->>'fecha')::date, v_ter, (p->>'importe')::numeric, p->>'pagado_por', (p->>'cuenta_id')::bigint,
      (p->>'socio_id')::bigint, p->>'medio', p->>'nro_comprobante', coalesce(p->>'fuente','verificado'), p->>'obs')
    returning id into v_id;
  end if;

  select * into pg from ob_pagos where id = v_id;
  if not found then raise exception 'El pago % no existe.', v_id; end if;
  if pg.anulado then raise exception 'El pago está anulado.'; end if;
  select coalesce(sum(importe),0) into v_prev from ob_pago_aplic where pago_id = v_id;
  select coalesce(sum((x->>'importe')::numeric),0) into v_total from jsonb_array_elements(v_aplic) x;
  if v_prev + v_total > pg.importe + 0.01 then
    raise exception 'Se imputa % y el pago es de %.', v_prev + v_total, pg.importe;
  end if;
  for a in select * from jsonb_array_elements(v_aplic) loop
    if (a->>'importe')::numeric <= 0 then continue; end if;
    select * into g from ob_gastos where id = (a->>'gasto_id')::bigint;
    if not found or g.anulado then raise exception 'El gasto % no existe o está anulado.', a->>'gasto_id'; end if;
    if g.tercero_id is distinct from pg.tercero_id then raise exception 'El gasto % es de otro proveedor.', g.id; end if;
    v_saldo := g.importe - ob_aplicado_gasto(g.id);
    if (a->>'importe')::numeric > v_saldo + 0.01 then
      raise exception 'Al gasto % le quedan % por pagar y se imputan %.', g.id, v_saldo, a->>'importe';
    end if;
    insert into ob_pago_aplic (pago_id, gasto_id, importe) values (v_id, g.id, (a->>'importe')::numeric);
  end loop;
  return v_id;
end $$;

-- Liquidación de una obra sobre imputaciones de cobro todavía no liquidadas.
create or replace function ob_guardar_liquidacion(p jsonb) returns bigint
language plpgsql security invoker set search_path = public as $$
declare v_id bigint; v_sum numeric; v_ids bigint[]; v_ok int;
begin
  select coalesce(sum((d->>'pct')::numeric),0) into v_sum from jsonb_array_elements(p->'detalle') d;
  if abs(v_sum - 100) > 0.01 then raise exception 'Los porcentajes suman % %% y deben sumar 100 %%.', v_sum; end if;
  select array_agg((x)::bigint) into v_ids from jsonb_array_elements_text(p->'aplic_ids') x;
  if v_ids is null then raise exception 'No hay cobros para liquidar.'; end if;
  select count(*) into v_ok from ob_cobro_aplic a join ob_cobros c on c.id = a.cobro_id join ob_ingresos i on i.id = a.ingreso_id
   where a.id = any(v_ids) and a.liquidacion_id is null and not c.anulado and i.obra_id = (p->>'obra_id')::bigint;
  if v_ok <> array_length(v_ids,1) then
    raise exception 'Algún cobro ya fue liquidado, anulado o no es de esta obra. Volvé a abrir la liquidación.';
  end if;
  insert into ob_liquidaciones (fecha, obra_id, neto_cobrado, gastos_pendientes, compromisos, iva_reserva, otros_impuestos,
    generales, fondo_reserva, reintegros, caja_distribuible, resultado_pendiente, distribuible, obs)
  values ((p->>'fecha')::date, (p->>'obra_id')::bigint, (p->>'neto_cobrado')::numeric, (p->>'gastos_pendientes')::numeric,
    (p->>'compromisos')::numeric, (p->>'iva_reserva')::numeric, (p->>'otros_impuestos')::numeric, (p->>'generales')::numeric,
    (p->>'fondo_reserva')::numeric, (p->>'reintegros')::numeric, (p->>'caja_distribuible')::numeric,
    (p->>'resultado_pendiente')::numeric, (p->>'distribuible')::numeric, p->>'obs')
  returning id into v_id;
  insert into ob_liquidacion_detalle (liquidacion_id, socio_id, pct, importe)
  select v_id, (d->>'socio_id')::bigint, (d->>'pct')::numeric, (d->>'importe')::numeric from jsonb_array_elements(p->'detalle') d;
  update ob_cobro_aplic set liquidacion_id = v_id where id = any(v_ids);
  return v_id;
end $$;

-- ---------- Triggers ----------
do $$
declare t text;
begin
  foreach t in array array['ob_ingresos','ob_cobros','ob_gastos','ob_pagos','ob_compromisos','ob_mov_socios','ob_transferencias','ob_reclamos'] loop
    execute format('drop trigger if exists %I on %I', t||'_touch', t);
    execute format('create trigger %I before update on %I for each row execute function ob_touch()', t||'_touch', t);
  end loop;
end $$;

drop trigger if exists ob_per_ing on ob_ingresos;
create trigger ob_per_ing before insert or update on ob_ingresos for each row execute function ob_periodo_guard('obs','fecha_estimada','fuente');
drop trigger if exists ob_per_cob on ob_cobros;
create trigger ob_per_cob before insert or update on ob_cobros for each row execute function ob_periodo_guard('obs','nro_recibo','fuente');
drop trigger if exists ob_per_gas on ob_gastos;
create trigger ob_per_gas before insert or update on ob_gastos for each row execute function ob_periodo_guard('obs','vencimiento','nro_comprobante','comprobante_path','fuente');
drop trigger if exists ob_per_pag on ob_pagos;
create trigger ob_per_pag before insert or update on ob_pagos for each row execute function ob_periodo_guard('obs','nro_comprobante','medio','fuente');
drop trigger if exists ob_per_mov on ob_mov_socios;
create trigger ob_per_mov before insert or update on ob_mov_socios for each row execute function ob_periodo_guard('obs');
drop trigger if exists ob_per_tr on ob_transferencias;
create trigger ob_per_tr before insert or update on ob_transferencias for each row execute function ob_periodo_guard('obs');
drop trigger if exists ob_per_liq on ob_liquidaciones;
create trigger ob_per_liq before insert on ob_liquidaciones for each row execute function ob_periodo_guard();

drop trigger if exists ob_ing_guard on ob_ingresos;
create trigger ob_ing_guard before update on ob_ingresos for each row execute function ob_ingreso_guard();
drop trigger if exists ob_gas_guard on ob_gastos;
create trigger ob_gas_guard before update on ob_gastos for each row execute function ob_gasto_guard();
drop trigger if exists ob_cob_guard on ob_cobros;
create trigger ob_cob_guard before update on ob_cobros for each row execute function ob_cobro_guard();
drop trigger if exists ob_pag_guard on ob_pagos;
create trigger ob_pag_guard before update on ob_pagos for each row execute function ob_pago_guard();
drop trigger if exists ob_gas_comp on ob_gastos;
create trigger ob_gas_comp after insert or update on ob_gastos for each row execute function ob_gasto_compromiso();
drop trigger if exists ob_liq_guard_t on ob_liquidaciones;
create trigger ob_liq_guard_t before update on ob_liquidaciones for each row execute function ob_liq_guard();
drop trigger if exists ob_cierre_guard_t on ob_cierres;
create trigger ob_cierre_guard_t before update on ob_cierres for each row execute function ob_cierre_guard();

-- ---------- RLS ----------
do $$
declare t text;
begin
  foreach t in array array['ob_ingresos','ob_cobros','ob_cobro_aplic','ob_gastos','ob_pagos','ob_pago_aplic','ob_compromisos',
                           'ob_mov_socios','ob_transferencias','ob_liquidaciones','ob_liquidacion_detalle','ob_reclamos','ob_terceros'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t||'_sel', t);
    execute format('create policy %I on %I for select to authenticated using (ob_rol() is not null)', t||'_sel', t);
    execute format('drop policy if exists %I on %I', t||'_ins', t);
    execute format('create policy %I on %I for insert to authenticated with check (ob_rol() in (''admin'',''carga''))', t||'_ins', t);
    execute format('drop policy if exists %I on %I', t||'_upd', t);
    execute format('create policy %I on %I for update to authenticated using (ob_rol() in (''admin'',''carga'')) with check (ob_rol() in (''admin'',''carga''))', t||'_upd', t);
  end loop;
  foreach t in array array['ob_socios','ob_cuentas','ob_categorias','ob_obras','ob_obra_reparto','ob_parametros'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t||'_sel', t);
    execute format('create policy %I on %I for select to authenticated using (ob_rol() is not null)', t||'_sel', t);
    execute format('drop policy if exists %I on %I', t||'_all', t);
    execute format('create policy %I on %I for all to authenticated using (ob_rol() = ''admin'') with check (ob_rol() = ''admin'')', t||'_all', t);
  end loop;
end $$;

alter table ob_perfiles enable row level security;
drop policy if exists ob_perfiles_sel on ob_perfiles;
create policy ob_perfiles_sel on ob_perfiles for select to authenticated using (user_id = auth.uid() or ob_rol() = 'admin');

alter table ob_cierres enable row level security;
drop policy if exists ob_cierres_sel on ob_cierres;
create policy ob_cierres_sel on ob_cierres for select to authenticated using (ob_rol() is not null);
drop policy if exists ob_cierres_ins on ob_cierres;
create policy ob_cierres_ins on ob_cierres for insert to authenticated with check (ob_rol() = 'admin');
drop policy if exists ob_cierres_upd on ob_cierres;
create policy ob_cierres_upd on ob_cierres for update to authenticated using (ob_rol() = 'admin') with check (ob_rol() = 'admin');
drop policy if exists ob_cierres_del on ob_cierres;
create policy ob_cierres_del on ob_cierres for delete to authenticated using (ob_rol() = 'admin');

-- ---------- Storage de comprobantes ----------
insert into storage.buckets (id, name, public) values ('ob-comprobantes','ob-comprobantes', false) on conflict (id) do nothing;
drop policy if exists ob_comp_sel on storage.objects;
create policy ob_comp_sel on storage.objects for select to authenticated using (bucket_id = 'ob-comprobantes' and ob_rol() is not null);
drop policy if exists ob_comp_ins on storage.objects;
create policy ob_comp_ins on storage.objects for insert to authenticated with check (bucket_id = 'ob-comprobantes' and ob_rol() in ('admin','carga'));

-- ---------- Datos iniciales ----------
insert into ob_parametros (id, empresa, fecha_corte, fondo_reserva_pct) values (1, 'Sociedad', current_date, 0) on conflict (id) do nothing;
insert into ob_categorias (nombre) values
  ('Materiales'),('Combustible'),('Mano de obra'),('Sueldos y jornales'),('Cargas sociales'),('Alquiler de equipos'),
  ('Viáticos'),('Fletes'),('Impuestos y tasas'),('Honorarios'),('Seguros'),('Herramientas'),('Otros')
on conflict (nombre) do nothing;
insert into ob_obras (codigo, nombre, tipo, es_general)
select 'GEN', 'Gastos generales', 'general', true where not exists (select 1 from ob_obras where es_general);
insert into ob_socios (nombre)
select x from unnest(array['Diego Cambas','Alfredo Daroni','José María Ginestar']) x where not exists (select 1 from ob_socios);
update ob_parametros set socio_propio_id = (select id from ob_socios where nombre = 'Alfredo Daroni')
where id = 1 and socio_propio_id is null;

-- ---------- Alta de usuarios ----------
-- 1) Crear el usuario en Authentication > Users.
-- 2) insert into ob_perfiles (user_id, nombre, rol, socio_id)
--    select id, 'Alfredo', 'admin', (select id from ob_socios where nombre = 'Alfredo Daroni')
--    from auth.users where email = 'usuario@dominio.com';
