-- PulseTasks: schema + RLS + gatilhos. Rode inteiro no SQL Editor do Supabase.
create table public.profiles(
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null unique check (username = lower(username) and username ~ '^[a-z0-9._-]{3,30}$'),
  name text not null check (char_length(name) between 1 and 80),
  role text not null default 'user' check (role in ('admin','user')),
  xp int not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now());
create table public.tasks(
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(title) between 1 and 140),
  description text check (char_length(description) <= 2000),
  status text not null default 'pendente' check (status in ('pendente','andamento','bloqueada','concluida')),
  priority text not null default 'media' check (priority in ('baixa','media','alta','urgente')),
  due_date date,
  created_by uuid not null default auth.uid() references public.profiles(id),
  validated boolean not null default false,
  validated_by uuid references public.profiles(id),
  validated_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now());
create table public.task_assignees(
  task_id uuid references public.tasks(id) on delete cascade,
  user_id uuid references public.profiles(id) on delete cascade,
  progress int not null default 0 check (progress between 0 and 100),
  primary key(task_id,user_id));
create table public.comments(
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks(id) on delete cascade,
  user_id uuid not null default auth.uid() references public.profiles(id),
  body text not null check (char_length(body) between 1 and 1000),
  is_blocker boolean not null default false,
  resolved boolean not null default false,
  created_at timestamptz not null default now());
create table public.notifications(
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  title text not null, body text,
  read boolean not null default false,
  created_at timestamptz not null default now());
create table public.xp_log(
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  task_id uuid references public.tasks(id) on delete set null,
  xp int not null, reason text,
  created_at timestamptz not null default now());
create table public.audit_log(
  id bigint generated always as identity primary key,
  actor uuid, table_name text, op text, row_id text,
  old_data jsonb, new_data jsonb,
  created_at timestamptz not null default now());

-- Funções auxiliares (security definer evita recursão de RLS)
create function public.is_admin() returns boolean language sql stable security definer set search_path=public as
$$ select exists(select 1 from profiles where id=auth.uid() and role='admin' and active) $$;
create function public.is_active() returns boolean language sql stable security definer set search_path=public as
$$ select exists(select 1 from profiles where id=auth.uid() and active) $$;
create function public.can_manage_task(t uuid) returns boolean language sql stable security definer set search_path=public as
$$ select public.is_admin() or exists(select 1 from tasks where id=t and created_by=auth.uid()) $$;
create function public.can_see_task(t uuid) returns boolean language sql stable security definer set search_path=public as
$$ select public.is_active() and (public.can_manage_task(t) or exists(select 1 from task_assignees where task_id=t and user_id=auth.uid())) $$;

-- Permissões base: anon não acessa nada
revoke all on all tables in schema public from anon;
revoke all on all functions in schema public from anon, public;
grant select,insert,update,delete on all tables in schema public to authenticated;
grant execute on function public.is_admin(), public.is_active(), public.can_manage_task(uuid), public.can_see_task(uuid) to authenticated;

-- RLS
alter table profiles enable row level security;
alter table tasks enable row level security;
alter table task_assignees enable row level security;
alter table comments enable row level security;
alter table notifications enable row level security;
alter table xp_log enable row level security;
alter table audit_log enable row level security;

create policy p_sel on profiles for select to authenticated using (id=auth.uid() or is_active());
create policy p_upd on profiles for update to authenticated using (is_admin()) with check (is_admin());

create policy t_sel on tasks for select to authenticated using ((created_by=auth.uid() and is_active()) or can_see_task(id));
create policy t_ins on tasks for insert to authenticated with check (is_active() and created_by=auth.uid() and not validated);
create policy t_upd on tasks for update to authenticated using (can_see_task(id)) with check (can_see_task(id));
create policy t_del on tasks for delete to authenticated using (is_admin());

create policy a_sel on task_assignees for select to authenticated using (can_see_task(task_id));
create policy a_ins on task_assignees for insert to authenticated with check (can_manage_task(task_id) and exists(select 1 from profiles where id=user_id and active and role='user'));
create policy a_upd on task_assignees for update to authenticated using (user_id=auth.uid() or is_admin()) with check (user_id=auth.uid() or is_admin());
create policy a_del on task_assignees for delete to authenticated using (can_manage_task(task_id));

create policy c_sel on comments for select to authenticated using (can_see_task(task_id));
create policy c_ins on comments for insert to authenticated with check (user_id=auth.uid() and can_see_task(task_id));
create policy c_upd on comments for update to authenticated using (user_id=auth.uid() or can_manage_task(task_id)) with check (user_id=auth.uid() or can_manage_task(task_id));
create policy c_del on comments for delete to authenticated using (is_admin());

create policy n_sel on notifications for select to authenticated using (user_id=auth.uid());
create policy n_upd on notifications for update to authenticated using (user_id=auth.uid()) with check (user_id=auth.uid());
create policy x_sel on xp_log for select to authenticated using (user_id=auth.uid() or is_admin());
create policy l_sel on audit_log for select to authenticated using (is_admin());

-- Guardas de colunas
create function guard_task() returns trigger language plpgsql security definer set search_path=public as $$
begin
  if old.validated then raise exception 'Tarefa validada não pode ser alterada'; end if;
  if new.created_by is distinct from old.created_by then raise exception 'Criador não pode mudar'; end if;
  if not is_admin() and (new.validated or new.validated_by is not null or new.validated_at is not null) then
    raise exception 'Apenas o administrador valida tarefas'; end if;
  if not (is_admin() or old.created_by=auth.uid()) and
     (new.title is distinct from old.title or new.description is distinct from old.description
      or new.priority is distinct from old.priority or new.due_date is distinct from old.due_date) then
    raise exception 'Sem permissão para editar os dados da tarefa'; end if;
  if new.validated then
    if new.status<>'concluida' then raise exception 'Só tarefas concluídas podem ser validadas'; end if;
    new.validated_by:=auth.uid(); new.validated_at:=now();
  end if;
  if new.status='concluida' and old.status<>'concluida' then new.completed_at:=now();
  elsif new.status<>'concluida' then new.completed_at:=null; end if;
  return new;
end $$;
create trigger a_guard before update on tasks for each row execute function guard_task();

create function guard_assignee() returns trigger language plpgsql as $$
begin
  if new.task_id<>old.task_id or new.user_id<>old.user_id then raise exception 'Apenas o progresso pode mudar'; end if;
  return new; end $$;
create trigger a_guard before update on task_assignees for each row execute function guard_assignee();

create function guard_comment() returns trigger language plpgsql as $$
begin
  if new.body<>old.body or new.task_id<>old.task_id or new.user_id<>old.user_id or new.is_blocker<>old.is_blocker then
    raise exception 'Apenas "resolvido" pode mudar'; end if;
  return new; end $$;
create trigger a_guard before update on comments for each row execute function guard_comment();

-- XP, notificações
create function after_task_update() returns trigger language plpgsql security definer set search_path=public as $$
declare a record; pts int;
begin
  if new.status='concluida' and old.status<>'concluida' then
    insert into notifications(user_id,title,body)
    select id,'Tarefa concluída: validar',new.title from profiles
    where role='admin' and active and id is distinct from auth.uid();
  end if;
  if new.validated and not old.validated then
    pts := case new.priority when 'baixa' then 10 when 'media' then 20 when 'alta' then 40 else 60 end;
    if new.due_date is null or new.completed_at::date <= new.due_date then pts := pts+10; end if;
    for a in select ta.user_id from task_assignees ta join profiles p on p.id=ta.user_id where ta.task_id=new.id and p.role='user' loop
      update profiles set xp=xp+pts where id=a.user_id;
      insert into xp_log(user_id,task_id,xp,reason) values(a.user_id,new.id,pts,'Tarefa validada');
      insert into notifications(user_id,title,body) values(a.user_id,'Tarefa validada','+'||pts||' XP: '||new.title);
    end loop;
  end if;
  return null;
end $$;
create trigger z_after after update on tasks for each row execute function after_task_update();

create function notify_assign() returns trigger language plpgsql security definer set search_path=public as $$
begin
  if new.user_id is distinct from auth.uid() then
    insert into notifications(user_id,title,body) select new.user_id,'Nova tarefa atribuída',title from tasks where id=new.task_id;
  end if; return null; end $$;
create trigger z_notify after insert on task_assignees for each row execute function notify_assign();

create function notify_comment() returns trigger language plpgsql security definer set search_path=public as $$
begin
  insert into notifications(user_id,title,body)
  select u, case when new.is_blocker then 'Novo impedimento' else 'Novo comentário' end, (select title from tasks where id=new.task_id)
  from (select created_by u from tasks where id=new.task_id union select user_id from task_assignees where task_id=new.task_id) s
  where u<>new.user_id;
  return null; end $$;
create trigger z_notify after insert on comments for each row execute function notify_comment();

-- Auditoria
create function audit() returns trigger language plpgsql security definer set search_path=public as $$
declare j jsonb;
begin
  j := case when tg_op='DELETE' then to_jsonb(old) else to_jsonb(new) end;
  insert into audit_log(actor,table_name,op,row_id,old_data,new_data)
  values(auth.uid(),tg_table_name,tg_op,coalesce(j->>'id',(j->>'task_id')||':'||(j->>'user_id')),
         case when tg_op<>'INSERT' then to_jsonb(old) end, case when tg_op<>'DELETE' then to_jsonb(new) end);
  return null; end $$;
create trigger zz_audit after insert or update or delete on tasks for each row execute function audit();
create trigger zz_audit after insert or update or delete on task_assignees for each row execute function audit();
create trigger zz_audit after insert or update or delete on comments for each row execute function audit();
create trigger zz_audit after insert or update or delete on profiles for each row execute function audit();

-- Endurecimento: funções de gatilho não ficam chamáveis pela API; funções futuras nascem fechadas
revoke execute on function public.after_task_update(), public.audit(), public.guard_task(), public.notify_assign(), public.notify_comment(), public.guard_assignee(), public.guard_comment() from public, anon, authenticated;
alter function public.guard_assignee() set search_path = public;
alter function public.guard_comment() set search_path = public;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;
