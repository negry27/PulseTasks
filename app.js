import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

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

let me = null, people = [], tab = 'tasks', filter = '', unread = 0;
const who = id => esc(people.find(p => p.id === id)?.name ?? '—');
const toast = m => { const t = $('#toast'); t.textContent = m; t.className = 'show'; setTimeout(() => t.className = '', 3200); };
const fail = e => { console.error(e); toast(e?.message || 'Erro'); };

function shell(html) {
  const items = [['tasks', 'Tarefas'], ['team', 'Equipe'], ['notif', 'Avisos' + (unread ? ` (${unread})` : '')], ['reports', 'Relatórios'], ...(me.role === 'admin' ? [['admin', 'Admin']] : [])];
  app.innerHTML = `<header><h1>Pulse<span>Tasks</span></h1><div class="me">${esc(me.name)} · ${me.xp} XP <button class="ghost" data-a="out">Sair</button></div></header><main>${html}</main><nav>${items.map(([k, l]) => `<button data-a="tab" data-v="${k}" class="${k === tab ? 'on' : ''}">${l}</button>`).join('')}</nav>`;
}

function loginView(msg = '') {
  me = null;
  app.innerHTML = `<div class="login"><h1>Pulse<span>Tasks</span></h1><form data-f="login"><input name="u" placeholder="Usuário" autocapitalize="none" autocomplete="username" required><input name="p" type="password" placeholder="Senha" autocomplete="current-password" required><button class="gold">Entrar</button><p class="err">${esc(msg)}</p></form></div>`;
}

async function boot() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return loginView();
  const { data: p } = await sb.from('profiles').select('id,username,name,role,xp,active').eq('id', session.user.id).maybeSingle();
  if (!p || !p.active) { await sb.auth.signOut(); return loginView('Conta sem acesso.'); }
  me = p; go('tasks');
}

async function go(t = tab) {
  tab = t;
  const [ps, n] = await Promise.all([
    sb.from('profiles').select('id,username,name,role,xp,active').order('name'),
    sb.from('notifications').select('id', { count: 'exact', head: true }).eq('read', false)]);
  people = ps.data ?? []; unread = n.count ?? 0; me = people.find(p => p.id === me.id) ?? me;
  ({ tasks: viewTasks, team: viewTeam, notif: viewNotif, reports: viewReports, admin: viewAdmin }[t] || viewTasks)();
}

const avg = t => t.task_assignees.length ? Math.round(t.task_assignees.reduce((s, x) => s + x.progress, 0) / t.task_assignees.length) : 0;
const card = t => {
  const late = t.due_date && t.due_date < today() && t.status !== 'concluida';
  return `<article class="card" data-a="open" data-v="${t.id}"><div class="row"><b>${esc(t.title)}</b><span class="chip p-${t.priority}">${PR[t.priority]}</span></div>
  <div class="mut">${ST[t.status]}${t.validated ? ' · ✔ validada' : ''} · prazo ${fmtDate(t.due_date)}${late ? ' <span class="late">atrasada</span>' : ''}</div>
  <div class="bar"><i style="width:${avg(t)}%"></i></div>
  <div class="mut">${t.task_assignees.length ? t.task_assignees.map(a => who(a.user_id)).join(', ') : 'Sem responsável'} · ${avg(t)}%</div></article>`;
};

async function viewTasks() {
  const { data, error } = await sb.from('tasks').select('*,task_assignees(user_id,progress)').order('created_at', { ascending: false });
  if (error) return fail(error);
  const list = data.filter(t => !filter || t.status === filter);
  shell(`<div class="row"><select data-c="filter" style="width:auto"><option value="">Todas</option>${opts(ST, filter)}</select><button class="gold" data-a="new">+ Nova tarefa</button></div>` + (list.map(card).join('') || '<p class="mut">Nenhuma tarefa.</p>'));
}

function viewNew() {
  shell(`<form data-f="new" class="card"><h2>Nova tarefa</h2><input name="title" placeholder="Título" required maxlength="140"><textarea name="description" placeholder="Descrição" maxlength="2000"></textarea><div class="row"><select name="priority" style="width:auto">${opts(PR, 'media')}</select><input type="date" name="due_date" style="width:auto"></div><p class="mut">Responsáveis (opcional, pode atribuir depois)</p>${people.filter(p => p.active).map(p => `<label class="chk"><input type="checkbox" name="as" value="${p.id}">${esc(p.name)}</label>`).join('')}<div class="row"><button type="button" class="ghost" data-a="tab" data-v="tasks">Cancelar</button><button class="gold">Criar</button></div></form>`);
}

async function viewDetail(id) {
  const [t, a, c] = await Promise.all([
    sb.from('tasks').select('*').eq('id', id).single(),
    sb.from('task_assignees').select('*').eq('task_id', id),
    sb.from('comments').select('*').eq('task_id', id).order('created_at')]);
  if (t.error) return fail(t.error);
  const k = t.data, as = a.data ?? [], cm = c.data ?? [];
  const adm = me.role === 'admin', mng = adm || k.created_by === me.id, mine = as.find(x => x.user_id === me.id), lock = k.validated;
  const coll = as.length ? Math.round(as.reduce((s, x) => s + x.progress, 0) / as.length) : 0;
  shell(`<button class="ghost" data-a="tab" data-v="tasks">← Voltar</button>
  <section class="card"><h2>${esc(k.title)}</h2><p>${esc(k.description) || '<span class="mut">Sem descrição</span>'}</p>
  <div class="mut">Criada por ${who(k.created_by)} · prazo ${fmtDate(k.due_date)} · <span class="chip p-${k.priority}">${PR[k.priority]}</span></div>
  <label>Status <select data-c="status" data-v="${k.id}" ${lock ? 'disabled' : ''}>${opts(ST, k.status)}</select></label>
  ${k.validated ? `<p class="ok">✔ Validada por ${who(k.validated_by)} em ${fmtDT(k.validated_at)}</p>` : ''}
  ${adm && k.status === 'concluida' && !k.validated ? `<button class="gold" data-a="validate" data-v="${k.id}">Validar conclusão (+XP)</button>` : ''}
  ${adm ? `<button class="danger" data-a="del" data-v="${k.id}">Excluir tarefa</button>` : ''}</section>
  <section class="card"><h3>Responsáveis · progresso coletivo ${coll}%</h3>
  ${as.map(x => `<div class="row"><span>${who(x.user_id)}</span><b>${x.progress}%</b></div>`).join('') || '<p class="mut">Ninguém atribuído.</p>'}
  ${mine && !lock ? `<label>Meu progresso<input type="range" min="0" max="100" step="5" value="${mine.progress}" data-c="prog" data-v="${k.id}"></label>` : ''}
  ${mng && !lock ? `<form data-f="assign" data-v="${k.id}">${people.filter(p => p.active).map(p => `<label class="chk"><input type="checkbox" name="as" value="${p.id}" ${as.some(x => x.user_id === p.id) ? 'checked' : ''}>${esc(p.name)}</label>`).join('')}<button class="ghost">Salvar responsáveis</button></form>` : ''}</section>
  <section class="card"><h3>Comentários e impedimentos</h3>
  ${cm.map(m => `<div class="cm ${m.is_blocker ? 'blk' : ''}"><b>${who(m.user_id)}</b> <span class="mut">${fmtDT(m.created_at)}</span>${m.is_blocker ? ` <span class="chip p-urgente">${m.resolved ? 'impedimento resolvido' : 'impedimento'}</span>` : ''}<p>${esc(m.body)}</p>${m.is_blocker && !m.resolved && (mng || m.user_id === me.id) ? `<button class="ghost" data-a="resolve" data-v="${m.id}" data-t="${k.id}">Marcar resolvido</button>` : ''}</div>`).join('') || '<p class="mut">Sem comentários.</p>'}
  <form data-f="comment" data-v="${k.id}" data-lock="${lock}"><textarea name="body" required maxlength="1000" placeholder="Escreva um comentário"></textarea><label class="chk"><input type="checkbox" name="blk">É um impedimento</label><button class="gold">Enviar</button></form></section>`);
}

function viewTeam() {
  shell('<h2>Equipe e XP</h2>' + people.filter(p => p.active).sort((a, b) => b.xp - a.xp).map((p, i) => `<div class="card row"><span>${i + 1}. ${esc(p.name)} ${p.role === 'admin' ? '<span class="chip">admin</span>' : ''}</span><b>Nv ${Math.floor(p.xp / 100) + 1} · ${p.xp} XP</b></div>`).join(''));
}

async function viewNotif() {
  const { data, error } = await sb.from('notifications').select('*').order('created_at', { ascending: false }).limit(50);
  if (error) return fail(error);
  shell(`<div class="row"><h2>Avisos</h2><button class="ghost" data-a="readall">Marcar lidas</button></div>` + (data.map(n => `<div class="card ${n.read ? '' : 'new'}"><b>${esc(n.title)}</b><p>${esc(n.body)}</p><span class="mut">${fmtDT(n.created_at)}</span></div>`).join('') || '<p class="mut">Sem avisos.</p>'));
}

async function viewReports() {
  const { data: L, error } = await sb.from('tasks').select('*,task_assignees(user_id,progress)');
  if (error) return fail(error);
  const c = s => L.filter(k => k.status === s).length;
  const late = L.filter(k => k.due_date && k.due_date < today() && k.status !== 'concluida').length;
  const per = people.filter(p => p.active).map(p => { const m = L.filter(k => k.task_assignees.some(a => a.user_id === p.id)); return { n: p.name, tot: m.length, done: m.filter(k => k.validated).length }; }).filter(r => r.tot);
  shell(`<h2>Relatórios</h2><div class="grid">${Object.entries(ST).map(([k, v]) => `<div class="card stat"><b>${c(k)}</b><span>${v}</span></div>`).join('')}<div class="card stat"><b>${late}</b><span>Atrasadas</span></div><div class="card stat"><b>${L.filter(k => k.validated).length}</b><span>Validadas</span></div></div><h3>Produtividade por pessoa</h3>` + (per.map(r => `<div class="card row"><span>${esc(r.n)}</span><b>${r.done}/${r.tot} validadas</b></div>`).join('') || '<p class="mut">Sem dados.</p>'));
}

async function viewAdmin() {
  if (me.role !== 'admin') return go('tasks');
  const { data: log } = await sb.from('audit_log').select('*').order('created_at', { ascending: false }).limit(40);
  shell(`<h2>Usuários</h2>${people.map(p => `<div class="card row"><span>${esc(p.name)} <span class="mut">@${esc(p.username)}</span> ${p.active ? '' : '<span class="chip p-urgente">inativo</span>'}</span>${p.id === me.id ? '' : `<span><button class="ghost" data-a="reset" data-v="${p.id}">Senha</button><button class="ghost" data-a="toggle" data-v="${p.id}" data-on="${p.active}">${p.active ? 'Desativar' : 'Ativar'}</button></span>`}</div>`).join('')}
  <form data-f="newuser" class="card"><h3>Novo usuário</h3><input name="name" placeholder="Nome" required maxlength="80"><input name="username" placeholder="usuário (letras e números)" required pattern="[A-Za-z0-9._-]{3,30}" autocapitalize="none"><input name="password" type="password" placeholder="Senha (mín. 8)" minlength="8" maxlength="72" required autocomplete="new-password"><button class="gold">Criar usuário</button></form>
  <h3>Auditoria (últimas 40)</h3>${(log ?? []).map(l => `<div class="mut log">${fmtDT(l.created_at)} · ${who(l.actor)} · ${esc(l.op)} ${esc(l.table_name)}</div>`).join('')}`);
}

async function adminFn(body) {
  const { data, error } = await sb.functions.invoke('admin-users', { body });
  let m = data?.error;
  if (error && !m) { try { m = (await error.context.json()).error; } catch { m = 'Falha na operação'; } }
  if (m) { toast(m); return false; }
  return true;
}

document.addEventListener('click', async e => {
  const el = e.target.closest('[data-a]'); if (!el) return;
  const a = el.dataset.a, v = el.dataset.v;
  try {
    if (a === 'out') { await sb.auth.signOut(); loginView(); }
    else if (a === 'tab') go(v);
    else if (a === 'new') viewNew();
    else if (a === 'open') viewDetail(v);
    else if (a === 'validate') { const { error } = await sb.from('tasks').update({ validated: true }).eq('id', v); if (error) return fail(error); toast('Validada, XP concedido'); viewDetail(v); }
    else if (a === 'del') { if (!confirm('Excluir esta tarefa?')) return; const { error } = await sb.from('tasks').delete().eq('id', v); if (error) return fail(error); go('tasks'); }
    else if (a === 'resolve') { const { error } = await sb.from('comments').update({ resolved: true }).eq('id', v); if (error) return fail(error); viewDetail(el.dataset.t); }
    else if (a === 'readall') { await sb.from('notifications').update({ read: true }).eq('read', false); go('notif'); }
    else if (a === 'reset') { const p = prompt('Nova senha (8 a 72 caracteres):'); if (p && await adminFn({ action: 'reset', user_id: v, password: p })) toast('Senha alterada'); }
    else if (a === 'toggle') { if (await adminFn({ action: 'toggle', user_id: v, active: el.dataset.on !== 'true' })) go('admin'); }
  } catch (x) { fail(x); }
});

document.addEventListener('change', async e => {
  const el = e.target, c = el.dataset.c; if (!c) return;
  try {
    if (c === 'filter') { filter = el.value; viewTasks(); }
    else if (c === 'status') { const { error } = await sb.from('tasks').update({ status: el.value }).eq('id', el.dataset.v); if (error) fail(error); viewDetail(el.dataset.v); }
    else if (c === 'prog') { const { error } = await sb.from('task_assignees').update({ progress: +el.value }).eq('task_id', el.dataset.v).eq('user_id', me.id); if (error) fail(error); viewDetail(el.dataset.v); }
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
      const { data: t, error } = await sb.from('tasks').insert({ title: d.get('title').trim(), description: d.get('description').trim() || null, priority: d.get('priority'), due_date: d.get('due_date') || null }).select('id').single();
      if (error) return fail(error);
      const ids = d.getAll('as');
      if (ids.length) { const { error: e2 } = await sb.from('task_assignees').insert(ids.map(u => ({ task_id: t.id, user_id: u }))); if (e2) fail(e2); }
      go('tasks');
    } else if (k === 'assign') {
      const cur = ((await sb.from('task_assignees').select('user_id').eq('task_id', id)).data ?? []).map(x => x.user_id);
      const want = d.getAll('as'), add = want.filter(u => !cur.includes(u)), rem = cur.filter(u => !want.includes(u));
      if (rem.length) { const { error } = await sb.from('task_assignees').delete().eq('task_id', id).in('user_id', rem); if (error) return fail(error); }
      if (add.length) { const { error } = await sb.from('task_assignees').insert(add.map(u => ({ task_id: id, user_id: u }))); if (error) return fail(error); }
      viewDetail(id);
    } else if (k === 'comment') {
      const blk = d.get('blk') === 'on';
      const { error } = await sb.from('comments').insert({ task_id: id, body: d.get('body').trim(), is_blocker: blk });
      if (error) return fail(error);
      if (blk && f.dataset.lock !== 'true') await sb.from('tasks').update({ status: 'bloqueada' }).eq('id', id);
      viewDetail(id);
    } else if (k === 'newuser') {
      if (await adminFn({ action: 'create', name: d.get('name'), username: d.get('username'), password: d.get('password') })) { toast('Usuário criado'); go('admin'); }
    }
  } catch (x) { fail(x); }
});

sb.auth.onAuthStateChange(ev => { if (ev === 'SIGNED_OUT') loginView(); });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
boot();
