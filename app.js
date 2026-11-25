import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

const pc = document.createElement('link'); pc.rel = 'preconnect'; pc.href = SUPABASE_URL; document.head.appendChild(pc); // conexão adiantada
const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const DOMAIN = '@pulsetasks.app';
const ST = { pendente: 'Pendente', andamento: 'Em andamento', bloqueada: 'Bloqueada', concluida: 'Concluída' };
const PR = { baixa: 'Baixa', media: 'Média', alta: 'Alta', urgente: 'Urgente' };
const $ = s => document.querySelector(s);
const app = $('#app');
// Todo texto vindo do banco passa por esc() (proteção contra XSS)
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const opts = (o, sel) => Object.entries(o).map(([k, v]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${v}</option>`).join('');
const today = () => new Date().toLocaleDateString('sv-SE');
const fmtDate = d => d ? new Date(d + 'T00:00:00').toLocaleDateString('pt-BR') : '—';
const fmtDT = d => new Date(d).toLocaleString('pt-BR');
const hhmm = t => String(t).slice(0, 5);

let me = null, people = [], tab = 'tasks', filter = '', unread = 0, openNow = true, cfg = { open: '06:00', close: '20:00' };
let cache = {}, nav = 0, metaAt = 0, month = today().slice(0, 7);
const who = id => esc(people.find(p => p.id === id)?.name ?? '—');
const staff = () => people.filter(p => p.active && p.role === 'user'); // admin nunca entra em XP/atribuição
const toast = m => { const t = $('#toast'); t.textContent = m; t.className = 'show'; setTimeout(() => t.className = '', 3200); };
const fail = e => { console.warn(e); toast(e?.message || 'Erro'); };
const typing = () => { const a = document.activeElement; return !!a && !!$('main')?.contains(a) && ['INPUT', 'TEXTAREA', 'SELECT'].includes(a.tagName) && a.type !== 'button'; };
const dirty = () => { cache = {}; metaAt = 0; };

// Mostra na hora o que já foi carregado e atualiza em seguida só se mudou (sensação de app rápido)
async function swr(key, load, render) {
  const my = nav;
  if (cache[key]) render(cache[key]);
  const fresh = await load();
  if (fresh === undefined) return;
  const same = cache[key] && JSON.stringify(cache[key]) === JSON.stringify(fresh);
  cache[key] = fresh;
  if (my !== nav || same || typing()) return;
  render(fresh);
}

async function meta(force = false) {
  if (!force && Date.now() - metaAt < 30000) return;
  metaAt = Date.now();
  const [ps, n, o, c] = await Promise.all([
    sb.from('profiles').select('id,username,name,role,xp,active').order('name'),
    sb.from('notifications').select('id', { count: 'exact', head: true }).eq('read', false),
    sb.rpc('work_open'),
    sb.from('app_settings').select('open_time,close_time').maybeSingle()]);
  people = ps.data ?? people; unread = n.count ?? 0; openNow = o.data !== false;
  if (c.data) cfg = { open: hhmm(c.data.open_time), close: hhmm(c.data.close_time) };
  me = people.find(p => p.id === me.id) ?? me;
}

function shell(html) {
  const items = [['tasks', 'Tarefas'], ['notif', 'Avisos' + (unread ? ` (${unread})` : '')], ['perf', 'Desempenho'], ...(me.role === 'admin' ? [['assign', 'Atribuir'], ['admin', 'Admin']] : [])];
  app.innerHTML = `<header><h1>Pulse<span>Tasks</span></h1><div class="me">${esc(me.name)}${me.role === 'admin' ? '' : ` · ${me.xp} XP`} <button class="ghost" data-a="out">Sair</button></div></header><main>${html}</main><nav>${items.map(([k, l]) => `<button data-a="tab" data-v="${k}" class="${k === tab ? 'on' : ''}">${l}</button>`).join('')}</nav>`;
}

function loginView(msg = '') {
  me = null; cache = {}; filter = ''; month = today().slice(0, 7); tab = 'tasks'; // estado limpo a cada login
  app.innerHTML = `<div class="login"><h1>Pulse<span>Tasks</span></h1><form data-f="login"><input name="u" placeholder="Usuário" autocapitalize="none" autocomplete="username" required><input name="p" type="password" placeholder="Senha" autocomplete="current-password" required><button class="gold">Entrar</button><p class="err">${esc(msg)}</p></form></div>`;
}

async function boot() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return loginView();
  const { data: p } = await sb.from('profiles').select('id,username,name,role,xp,active').eq('id', session.user.id).maybeSingle();
  if (!p || !p.active) { await sb.auth.signOut(); return loginView('Conta sem acesso.'); }
  me = p; sb.rpc('tick'); go('tasks');   // tick: recolhe tarefas se já passou do horário de fechar
}

async function go(t = tab) {
  nav++; tab = t;
  await meta();
  ({ tasks: viewTasks, assign: viewAssign, notif: viewNotif, perf: viewPerf, admin: viewAdmin }[t] || viewTasks)();
}

const avg = t => t.task_assignees.length ? Math.round(t.task_assignees.reduce((s, x) => s + x.progress, 0) / t.task_assignees.length) : 0;
const card = t => {
  const late = t.due_date && t.due_date < today() && t.status !== 'concluida';
  return `<article class="card" data-a="open" data-v="${t.id}"><div class="row"><b>${esc(t.title)}</b><span class="chip p-${t.priority}">${PR[t.priority]}</span></div>
  <div class="mut">${ST[t.status]}${t.validated ? ` · ✔ validada (nota ${t.rating}/5)` : ''} · prazo ${fmtDate(t.due_date)}${t.estimated_minutes ? ` · ⏱ ${t.estimated_minutes} min` : ''}${late ? ' <span class="late">atrasada</span>' : ''}</div>
  <div class="bar"><i style="width:${avg(t)}%"></i></div>
  <div class="mut">${t.task_assignees.length ? t.task_assignees.map(a => who(a.user_id)).join(', ') : 'Sem responsável'} · ${avg(t)}%</div></article>`;
};

function viewTasks() {
  swr('tasks', async () => {
    const [t, o] = await Promise.all([sb.from('tasks').select('*,task_assignees(user_id,progress)').order('created_at', { ascending: false }), sb.rpc('work_open')]);
    if (t.error) { fail(t.error); return; }
    openNow = o.data !== false; return t.data;
  }, data => {
    const adm = me.role === 'admin', closed = !adm && !openNow;
    const list = data.filter(t => !filter || t.status === filter);
    shell((closed ? `<div class="card warn"><b>Fora do horário.</b><br>As tarefas ficam disponíveis das ${cfg.open} às ${cfg.close}.</div>` : '')
      + (adm && !openNow ? `<p class="mut">Fora do horário: os funcionários não estão vendo tarefas agora (${cfg.open}–${cfg.close}).</p>` : '')
      + `<div class="row"><select data-c="filter" style="width:auto"><option value="">Todas</option>${opts(ST, filter)}</select>${closed ? '' : '<button class="gold" data-a="new">+ Nova tarefa</button>'}</div>`
      + (list.map(card).join('') || '<p class="mut">Nenhuma tarefa.</p>'));
  });
}

function openNew() {
  closeModal();
  const m = document.createElement('div'); m.id = 'modal'; m.className = 'modal';
  m.innerHTML = `<form data-f="new" class="card"><h2>Nova tarefa</h2><input name="title" placeholder="Título" required maxlength="140"><textarea name="description" placeholder="Descrição (opcional)" maxlength="2000"></textarea><div class="row"><select name="priority" style="width:auto">${opts(PR, 'media')}</select><input type="date" name="due_date" style="width:auto"></div><input type="number" name="est" min="5" max="1440" placeholder="Tempo estimado em minutos (opcional)"><p class="mut">Nasce sem responsável; atribua depois. O XP depende do tempo gasto e da nota do admin.</p><div class="row"><button type="button" class="ghost" data-a="closeModal">Cancelar</button><button class="gold">Criar</button></div></form>`;
  document.body.appendChild(m);
  m.querySelector('input').focus();
}
function closeModal() { $('#modal')?.remove(); }

function viewAssign() {
  if (me.role !== 'admin') return go('tasks');
  swr('assign', async () => {
    const { data, error } = await sb.from('tasks').select('*,task_assignees(user_id,progress)').eq('validated', false).order('created_at', { ascending: false });
    if (error) { fail(error); return; }
    return data.sort((a, b) => (a.task_assignees.length ? 1 : 0) - (b.task_assignees.length ? 1 : 0));
  }, data => {
    const n = data.filter(t => !t.task_assignees.length).length;
    shell(`<h2>Atribuir tarefas</h2><p class="mut">${n} sem responsável. Marque uma ou mais pessoas e salve.</p>` + (data.map(t => `<form data-f="assign" data-v="${t.id}" class="card"><div class="row"><b>${esc(t.title)}</b><span class="chip p-${t.priority}">${PR[t.priority]}</span></div><div class="mut">${ST[t.status]} · prazo ${fmtDate(t.due_date)}${t.estimated_minutes ? ` · ⏱ ${t.estimated_minutes} min` : ''}</div>${staff().map(p => `<label class="chk"><input type="checkbox" name="as" value="${p.id}" ${t.task_assignees.some(x => x.user_id === p.id) ? 'checked' : ''}>${esc(p.name)}</label>`).join('') || '<p class="mut">Crie usuários na aba Admin.</p>'}<button class="gold">Salvar responsáveis</button></form>`).join('') || '<p class="mut">Nenhuma tarefa para atribuir.</p>'));
  });
}

function viewDetail(id) {
  nav++;
  swr('d:' + id, async () => {
    const [t, a, c] = await Promise.all([
      sb.from('tasks').select('*').eq('id', id).single(),
      sb.from('task_assignees').select('*').eq('task_id', id),
      sb.from('comments').select('*').eq('task_id', id).order('created_at')]);
    if (t.error) { fail(t.error); return; }
    return { k: t.data, as: a.data ?? [], cm: c.data ?? [] };
  }, ({ k, as, cm }) => {
    const adm = me.role === 'admin', mng = adm || k.created_by === me.id, mine = as.find(x => x.user_id === me.id), lock = k.validated;
    const coll = as.length ? Math.round(as.reduce((s, x) => s + x.progress, 0) / as.length) : 0;
    shell(`<button class="ghost" data-a="tab" data-v="tasks">← Voltar</button>
  <section class="card"><h2>${esc(k.title)}</h2><p>${esc(k.description) || '<span class="mut">Sem descrição</span>'}</p>
  <div class="mut">Criada por ${who(k.created_by)} · prazo ${fmtDate(k.due_date)}${k.estimated_minutes ? ` · ⏱ estimado ${k.estimated_minutes} min` : ''} · <span class="chip p-${k.priority}">${PR[k.priority]}</span></div>
  <label>Status <select data-c="status" data-v="${k.id}" ${lock ? 'disabled' : ''}>${opts(ST, k.status)}</select></label>
  ${k.validated ? `<p class="ok">✔ Validada por ${who(k.validated_by)} em ${fmtDT(k.validated_at)} · nota ${k.rating}/5</p>` : ''}
  ${adm && k.status === 'concluida' && !k.validated ? `<div class="valid"><label>Nota do admin (qualidade)<select name="rating">${[5, 4, 3, 2, 1].map(n => `<option value="${n}" ${n === 3 ? 'selected' : ''}>${n} ${'★'.repeat(n)}</option>`).join('')}</select></label><button class="gold" data-a="validate" data-v="${k.id}">Aprovar e validar (+XP)</button></div>` : ''}
  ${adm ? `<button class="danger" data-a="del" data-v="${k.id}">Excluir tarefa</button>` : ''}</section>
  <section class="card"><h3>Responsáveis · progresso coletivo ${coll}%</h3>
  ${as.map(x => `<div class="row"><span>${who(x.user_id)}</span><b>${x.progress}%</b></div>`).join('') || '<p class="mut">Ninguém atribuído.</p>'}
  ${mine && !lock ? `<label>Meu progresso<input type="range" min="0" max="100" step="5" value="${mine.progress}" data-c="prog" data-v="${k.id}"></label>` : ''}
  ${mng && !lock ? `<form data-f="assign" data-v="${k.id}">${staff().map(p => `<label class="chk"><input type="checkbox" name="as" value="${p.id}" ${as.some(x => x.user_id === p.id) ? 'checked' : ''}>${esc(p.name)}</label>`).join('')}<button class="ghost">Salvar responsáveis</button></form>` : ''}</section>
  <section class="card"><h3>Comentários e impedimentos</h3>
  ${cm.map(m => `<div class="cm ${m.is_blocker ? 'blk' : ''}"><b>${who(m.user_id)}</b> <span class="mut">${fmtDT(m.created_at)}</span>${m.is_blocker ? ` <span class="chip p-urgente">${m.resolved ? 'impedimento resolvido' : 'impedimento'}</span>` : ''}<p>${esc(m.body)}</p>${m.is_blocker && !m.resolved && (mng || m.user_id === me.id) ? `<button class="ghost" data-a="resolve" data-v="${m.id}" data-t="${k.id}">Marcar resolvido</button>` : ''}</div>`).join('') || '<p class="mut">Sem comentários.</p>'}
  <form data-f="comment" data-v="${k.id}" data-lock="${lock}"><textarea name="body" required maxlength="1000" placeholder="Escreva um comentário"></textarea><label class="chk"><input type="checkbox" name="blk">É um impedimento</label><button class="gold">Enviar</button></form></section>`);
  });
}

function viewNotif() {
  swr('notif', async () => {
    const { data, error } = await sb.from('notifications').select('*').order('created_at', { ascending: false }).limit(50);
    if (error) { fail(error); return; } return data;
  }, data => shell(`<div class="row"><h2>Avisos</h2><button class="ghost" data-a="readall">Marcar lidas</button></div>` + (data.map(n => `<div class="card ${n.read ? '' : 'new'}"><b>${esc(n.title)}</b><p>${esc(n.body)}</p><span class="mut">${fmtDT(n.created_at)}</span></div>`).join('') || '<p class="mut">Sem avisos.</p>')));
}

const monthRange = () => {
  const [y, m] = month.split('-').map(Number), nm = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  return [`${month}-01T00:00:00-03:00`, `${nm}-01T00:00:00-03:00`];
};

function viewPerf() {
  swr('perf:' + month, async () => {
    const [r, t] = await Promise.all([sb.rpc('team_month', { p_month: month + '-01' }), me.role === 'admin' ? sb.from('tasks').select('status,validated,due_date') : Promise.resolve({ data: null })]);
    if (r.error) { fail(r.error); return; }
    return { rows: r.data ?? [], sit: t.data };
  }, ({ rows, sit }) => {
    const tot = rows.reduce((s, r) => s + r.tarefas, 0), xpm = rows.reduce((s, r) => s + r.xp_mes, 0);
    const wavg = k => { const w = rows.filter(r => r[k] != null && r.tarefas); const d = w.reduce((s, r) => s + r.tarefas, 0); return d ? (w.reduce((s, r) => s + r[k] * r.tarefas, 0) / d) : null; };
    const nota = wavg('nota_media'), mins = wavg('minutos_medios'), pz = tot ? Math.round(rows.reduce((s, r) => s + r.no_prazo, 0) * 100 / tot) : null;
    const maxXp = Math.max(1, ...rows.map(r => r.xp_mes));
    const late = sit ? sit.filter(k => k.due_date && k.due_date < today() && k.status !== 'concluida').length : 0;
    shell(`<div class="row"><h2>Desempenho</h2><input type="month" data-c="month" value="${month}" max="${today().slice(0, 7)}" style="width:auto"></div>
    <h3>Equipe no mês</h3><div class="grid"><div class="card stat"><b>${tot}</b><span>Tarefas validadas</span></div><div class="card stat"><b>${xpm}</b><span>XP ganho</span></div><div class="card stat"><b>${nota == null ? '—' : nota.toFixed(1)}</b><span>Nota média</span></div><div class="card stat"><b>${pz == null ? '—' : pz + '%'}</b><span>No prazo</span></div><div class="card stat"><b>${mins == null ? '—' : Math.round(mins)}</b><span>Min. médios</span></div></div>
    <h3>Por pessoa${me.role === 'admin' ? ' <span class="mut">(toque para ver as tarefas)</span>' : ''}</h3>
    ${rows.map(r => { const can = me.role === 'admin' || r.uid === me.id; return `<div class="card" ${can ? `data-a="perfuser" data-v="${r.uid}"` : ''}><div class="row"><b>${esc(r.nome)}</b><b>${r.xp_mes} XP</b></div><div class="bar"><i style="width:${Math.round(r.xp_mes * 100 / maxXp)}%"></i></div><div class="mut">${r.tarefas} tarefa(s) · nota ${r.nota_media ?? '—'} · ${r.minutos_medios ?? '—'} min médios · ${r.no_prazo} no prazo</div><div id="det-${r.uid}" data-a="none"></div></div>`; }).join('') || '<p class="mut">Sem funcionários.</p>'}
    <h3>Ranking geral</h3>${staff().sort((a, b) => b.xp - a.xp).map((p, i) => `<div class="card row"><span>${i + 1}. ${esc(p.name)}</span><b>Nv ${Math.floor(p.xp / 100) + 1} · ${p.xp} XP</b></div>`).join('')}
    ${sit ? `<h3>Situação atual</h3><div class="grid">${Object.entries(ST).map(([k, v]) => `<div class="card stat"><b>${sit.filter(x => x.status === k).length}</b><span>${v}</span></div>`).join('')}<div class="card stat"><b>${late}</b><span>Atrasadas</span></div></div>` : ''}`);
  });
}

async function showPerfUser(uid) {
  const box = $('#det-' + uid); if (!box) return;
  if (box.innerHTML) { box.innerHTML = ''; return; }
  const [a, b] = monthRange();
  const { data, error } = await sb.from('xp_log').select('title,xp,rating,minutes,on_time,created_at').eq('user_id', uid).gte('created_at', a).lt('created_at', b).order('created_at', { ascending: false });
  if (error) return fail(error);
  box.innerHTML = (data.map(x => `<div class="log">${esc(x.title)} — <b>${x.xp} XP</b> · nota ${x.rating}/5 · ${x.minutes} min · ${x.on_time ? 'no prazo' : 'fora do prazo'}</div>`).join('')) || '<p class="mut">Nenhuma tarefa validada neste mês.</p>';
}

const OPS = { INSERT: 'criou', UPDATE: 'alterou', DELETE: 'excluiu', RECALL: 'recolheu as tarefas não concluídas', create_user: 'criou o usuário', reset_password: 'trocou a senha de', deactivate_user: 'desativou', activate_user: 'reativou' };
const TBL = { tasks: 'tarefa', task_assignees: 'atribuição de', comments: 'comentário', profiles: 'perfil de', 'admin-users': '' };
function fmtAudit(l) {
  const d = l.new_data || l.old_data || {}; let det = '';
  if (l.table_name === 'tasks') {
    det = d.title ? ` “${esc(d.title)}”` : '';
    if (l.op === 'UPDATE' && l.old_data) { if (l.old_data.status !== d.status) det += ` (${ST[l.old_data.status]} → ${ST[d.status]})`; if (!l.old_data.validated && d.validated) det += ` (validada, nota ${esc(d.rating)})`; }
    if (l.op === 'RECALL') det = ` (${esc(d.recolhidas)})`;
  } else if (l.table_name === 'task_assignees') det = ' ' + who(d.user_id);
  else if (l.table_name === 'profiles') det = ' ' + esc(d.name);
  else if (l.table_name === 'comments') det = d.is_blocker ? ' (impedimento)' : '';
  else if (l.table_name === 'admin-users') det = ' ' + (l.op === 'create_user' ? esc(l.row_id) : who(l.row_id));
  return `${fmtDT(l.created_at)} · ${l.actor ? who(l.actor) : 'Sistema'} ${OPS[l.op] || esc(l.op)} ${TBL[l.table_name] ?? esc(l.table_name)}${det}`;
}

function viewAdmin() {
  if (me.role !== 'admin') return go('tasks');
  swr('admin', async () => {
    const { data, error } = await sb.from('audit_log').select('*').order('created_at', { ascending: false }).limit(40);
    if (error) { fail(error); return; } return data;
  }, log => shell(`<h2>Usuários</h2>${people.map(p => `<div class="card row"><span>${esc(p.name)} <span class="mut">@${esc(p.username)}</span> ${p.active ? '' : '<span class="chip p-urgente">inativo</span>'}</span>${p.id === me.id ? '' : `<span><button class="ghost" data-a="reset" data-v="${p.id}">Senha</button><button class="ghost" data-a="toggle" data-v="${p.id}" data-on="${p.active}">${p.active ? 'Desativar' : 'Ativar'}</button></span>`}</div>`).join('')}
  <form data-f="newuser" class="card"><h3>Novo usuário</h3><input name="name" placeholder="Nome" required maxlength="80"><input name="username" placeholder="usuário (letras e números)" required pattern="[A-Za-z0-9._\\-]{3,30}" autocapitalize="none"><input name="password" type="password" placeholder="Senha (mín. 8)" minlength="8" maxlength="72" required autocomplete="new-password"><button class="gold">Criar usuário</button></form>
  <form data-f="hours" class="card"><h3>Horário de liberação das tarefas</h3><div class="row"><label>Abre <input type="time" name="o" value="${cfg.open}" required></label><label>Fecha <input type="time" name="c" value="${cfg.close}" required></label></div><p class="mut">Fora desse horário os funcionários não veem tarefas. Ao fechar, as não concluídas voltam para você atribuir de novo.</p><button class="gold">Salvar horário</button><button type="button" class="ghost" data-a="recall">Recolher tarefas agora</button></form>
  <h3>Atividade (últimas 40)</h3>${log.map(l => `<div class="mut log">${fmtAudit(l)}</div>`).join('')}`));
}

async function adminFn(body) {
  const { data, error } = await sb.functions.invoke('admin-users', { body });
  let m = data?.error;
  if (error && !m) {
    if (error.context && typeof error.context.json === 'function') {
      try { const j = await error.context.json(); m = j.error || j.message || `Erro ${error.context.status}`; }
      catch { m = `Erro ${error.context.status || ''} na função admin-users`; }
    } else m = 'Não consegui falar com a função admin-users. Confira se foi publicada com esse nome e com "Verify JWT" desligado.';
  }
  if (m) { toast(m); return false; }
  return true;
}

document.addEventListener('click', async e => {
  const el = e.target.closest('[data-a]'); if (!el) return;
  const a = el.dataset.a, v = el.dataset.v;
  if (a === 'none') return;
  try {
    if (a === 'out') { await sb.auth.signOut(); loginView(); }
    else if (a === 'tab') go(v);
    else if (a === 'new') openNew();
    else if (a === 'closeModal') closeModal();
    else if (a === 'open') viewDetail(v);
    else if (a === 'validate') {
      const rating = +($('select[name=rating]')?.value || 3);
      const { error } = await sb.from('tasks').update({ validated: true, rating }).eq('id', v); if (error) return fail(error);
      toast('Validada, XP concedido'); dirty(); viewDetail(v);
    }
    else if (a === 'del') { if (!confirm('Excluir esta tarefa?')) return; const { error } = await sb.from('tasks').delete().eq('id', v); if (error) return fail(error); dirty(); go('tasks'); }
    else if (a === 'resolve') { const { error } = await sb.from('comments').update({ resolved: true }).eq('id', v); if (error) return fail(error); dirty(); viewDetail(el.dataset.t); }
    else if (a === 'readall') { await sb.from('notifications').update({ read: true }).eq('read', false); dirty(); go('notif'); }
    else if (a === 'reset') { const p = prompt('Nova senha (8 a 72 caracteres):'); if (p && await adminFn({ action: 'reset', user_id: v, password: p })) toast('Senha alterada'); }
    else if (a === 'toggle') { if (await adminFn({ action: 'toggle', user_id: v, active: el.dataset.on !== 'true' })) { dirty(); go('admin'); } }
    else if (a === 'recall') { if (!confirm('Devolver ao admin todas as tarefas não concluídas?')) return; const { data, error } = await sb.rpc('recall_now'); if (error) return fail(error); toast(`${data} tarefa(s) recolhida(s)`); dirty(); go('admin'); }
    else if (a === 'perfuser') showPerfUser(v);
  } catch (x) { fail(x); }
});

document.addEventListener('change', async e => {
  const el = e.target, c = el.dataset.c; if (!c) return;
  try {
    if (c === 'filter') { filter = el.value; viewTasks(); }
    else if (c === 'month') { if (el.value) { month = el.value; viewPerf(); } }
    else if (c === 'status') { const { error } = await sb.from('tasks').update({ status: el.value }).eq('id', el.dataset.v); if (error) fail(error); dirty(); viewDetail(el.dataset.v); }
    else if (c === 'prog') { const { error } = await sb.from('task_assignees').update({ progress: +el.value }).eq('task_id', el.dataset.v).eq('user_id', me.id); if (error) fail(error); dirty(); viewDetail(el.dataset.v); }
  } catch (x) { fail(x); }
});

document.addEventListener('submit', async e => {
  const f = e.target, k = f.dataset.f; if (!k) return;
  e.preventDefault();
  const d = new FormData(f), id = f.dataset.v;
  try {
    if (k === 'login') {
      const u = d.get('u').trim().toLowerCase();                 // usuário: sem diferenciar maiúsculas
      if (!/^[a-z0-9._-]{3,30}$/.test(u)) return loginView('Usuário ou senha inválidos.');
      const { error } = await sb.auth.signInWithPassword({ email: u + DOMAIN, password: d.get('p') }); // senha: exata
      if (error) return loginView('Usuário ou senha inválidos.');
      boot();
    } else if (k === 'new') {
      const { error } = await sb.from('tasks').insert({ title: d.get('title').trim(), description: d.get('description').trim() || null, priority: d.get('priority'), due_date: d.get('due_date') || null, estimated_minutes: d.get('est') ? +d.get('est') : null });
      if (error) return fail(error);
      closeModal(); toast('Tarefa criada'); dirty(); go('tasks');
    } else if (k === 'assign') {
      const cur = ((await sb.from('task_assignees').select('user_id').eq('task_id', id)).data ?? []).map(x => x.user_id);
      const want = d.getAll('as'), add = want.filter(u => !cur.includes(u)), rem = cur.filter(u => !want.includes(u));
      if (rem.length) { const { error } = await sb.from('task_assignees').delete().eq('task_id', id).in('user_id', rem); if (error) return fail(error); }
      if (add.length) { const { error } = await sb.from('task_assignees').insert(add.map(u => ({ task_id: id, user_id: u }))); if (error) return fail(error); }
      toast('Responsáveis salvos'); dirty(); tab === 'assign' ? viewAssign() : viewDetail(id);
    } else if (k === 'comment') {
      const blk = d.get('blk') === 'on';
      const { error } = await sb.from('comments').insert({ task_id: id, body: d.get('body').trim(), is_blocker: blk });
      if (error) return fail(error);
      if (blk && f.dataset.lock !== 'true') await sb.from('tasks').update({ status: 'bloqueada' }).eq('id', id);
      dirty(); viewDetail(id);
    } else if (k === 'newuser') {
      if (await adminFn({ action: 'create', name: d.get('name'), username: d.get('username'), password: d.get('password') })) { toast('Usuário criado'); dirty(); go('admin'); }
    } else if (k === 'hours') {
      const { error } = await sb.from('app_settings').update({ open_time: d.get('o'), close_time: d.get('c') }).eq('id', true);
      if (error) return fail(error.message.includes('check') ? { message: 'O horário de abrir precisa ser antes do de fechar.' } : error);
      toast('Horário salvo'); dirty(); go('admin');
    }
  } catch (x) { fail(x); }
});

sb.auth.onAuthStateChange(ev => { if (ev === 'SIGNED_OUT') loginView(); });
setInterval(() => { if (me && tab === 'tasks' && !$('#modal') && !typing()) viewTasks(); }, 60000); // acompanha abertura/fechamento sem recarregar
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
boot();
