// Edge Function: operações privilegiadas (criar usuário, trocar senha, ativar/desativar).
// A service_role fica só aqui (variável injetada pelo Supabase), nunca no front-end.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
const cors = {
  'Access-Control-Allow-Origin': 'https://negry27.github.io',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const DOMAIN = '@pulsetasks.app';
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
  try {
    const url = Deno.env.get('SUPABASE_URL')!;
    // Chaves novas (sb_publishable/sb_secret) com fallback para as legadas
    const pick = (n: string) => { try { return JSON.parse(Deno.env.get(n) ?? '{}').default as string | undefined; } catch { return undefined; } };
    const anonKey = pick('SUPABASE_PUBLISHABLE_KEYS') ?? Deno.env.get('SUPABASE_ANON_KEY')!;
    const secretKey = pick('SUPABASE_SECRET_KEYS') ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const caller = createClient(url, anonKey, {
      global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
    });
    const { data: { user } } = await caller.auth.getUser();
    if (!user) return json({ error: 'Não autenticado' }, 401);
    const admin = createClient(url, secretKey);
    const { data: me } = await admin.from('profiles').select('role,active').eq('id', user.id).single();
    if (me?.role !== 'admin' || !me.active) return json({ error: 'Acesso negado' }, 403);

    const b = await req.json();
    const log = (op: string, row: string) =>
      admin.from('audit_log').insert({ actor: user.id, table_name: 'admin-users', op, row_id: row });

    if (b.action === 'create') {
      const username = String(b.username ?? '').trim().toLowerCase();
      const name = String(b.name ?? '').trim();
      const password = String(b.password ?? '');
      if (!/^[a-z0-9._-]{3,30}$/.test(username)) return json({ error: 'Usuário inválido' }, 400);
      if (!name || name.length > 80) return json({ error: 'Nome inválido' }, 400);
      if (password.length < 8 || password.length > 72) return json({ error: 'Senha deve ter 8 a 72 caracteres' }, 400);
      const { data, error } = await admin.auth.admin.createUser({ email: username + DOMAIN, password, email_confirm: true });
      if (error) return json({ error: error.message }, 400);
      const { error: e2 } = await admin.from('profiles').insert({ id: data.user.id, username, name, role: 'user' });
      if (e2) { await admin.auth.admin.deleteUser(data.user.id); return json({ error: 'Usuário já existe' }, 400); }
      await log('create_user', username);
      return json({ ok: true });
    }
    if (b.action === 'reset') {
      const password = String(b.password ?? '');
      if (password.length < 8 || password.length > 72) return json({ error: 'Senha deve ter 8 a 72 caracteres' }, 400);
      const { error } = await admin.auth.admin.updateUserById(String(b.user_id), { password });
      if (error) return json({ error: error.message }, 400);
      await log('reset_password', String(b.user_id));
      return json({ ok: true });
    }
    if (b.action === 'toggle') {
      if (b.user_id === user.id) return json({ error: 'Não é possível desativar a si mesmo' }, 400);
      const active = !!b.active;
      await admin.from('profiles').update({ active }).eq('id', String(b.user_id));
      await admin.auth.admin.updateUserById(String(b.user_id), { ban_duration: active ? 'none' : '876000h' });
      await log(active ? 'activate_user' : 'deactivate_user', String(b.user_id));
      return json({ ok: true });
    }
    return json({ error: 'Ação inválida' }, 400);
  } catch (_e) {
    return json({ error: 'Erro interno' }, 500);
  }
});
