-- Rode UMA vez se você já executou o schema.sql antes desta versão.
-- 1) Admin não pode ser responsável por tarefas  2) Admin nunca recebe XP
drop policy if exists a_ins on task_assignees;
create policy a_ins on task_assignees for insert to authenticated with check (can_manage_task(task_id) and exists(select 1 from profiles where id=user_id and active and role='user'));

create or replace function after_task_update() returns trigger language plpgsql security definer set search_path=public as $$
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

-- v2: usuário comum precisa ler de volta a tarefa que acabou de criar
drop policy if exists t_sel on tasks;
create policy t_sel on tasks for select to authenticated using ((created_by=auth.uid() and is_active()) or can_see_task(id));

-- Endurecimento: funções de gatilho não ficam chamáveis pela API; funções futuras nascem fechadas
revoke execute on function public.after_task_update(), public.audit(), public.guard_task(), public.notify_assign(), public.notify_comment(), public.guard_assignee(), public.guard_comment() from public, anon, authenticated;
alter function public.guard_assignee() set search_path = public;
alter function public.guard_comment() set search_path = public;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;

-- ===================== v3: horário 06-20, XP variável, desempenho, velocidade =====================
create table if not exists public.app_settings(
  id boolean primary key default true check (id),
  open_time time not null default '06:00',
  close_time time not null default '20:00',
  tz text not null default 'America/Sao_Paulo',
  last_recall date,
  check (open_time < close_time));
insert into public.app_settings(id) values (true) on conflict do nothing;
alter table public.app_settings enable row level security;
revoke all on public.app_settings from anon;
grant select, update on public.app_settings to authenticated;
drop policy if exists s_sel on public.app_settings;
drop policy if exists s_upd on public.app_settings;
create policy s_sel on public.app_settings for select to authenticated using (true);
create policy s_upd on public.app_settings for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));

alter table public.tasks add column if not exists estimated_minutes int check (estimated_minutes between 5 and 1440);
alter table public.tasks add column if not exists started_at timestamptz;
alter table public.tasks add column if not exists rating int check (rating between 1 and 5);
alter table public.task_assignees add column if not exists assigned_at timestamptz not null default now();
alter table public.xp_log add column if not exists rating int, add column if not exists minutes int, add column if not exists on_time boolean,
  add column if not exists priority text, add column if not exists title text, add column if not exists time_factor numeric,
  add column if not exists quality_factor numeric, add column if not exists luck numeric;

create index if not exists idx_comments_task on public.comments(task_id);
create index if not exists idx_comments_user on public.comments(user_id);
create index if not exists idx_notif_user on public.notifications(user_id, read);
create index if not exists idx_assignees_user on public.task_assignees(user_id);
create index if not exists idx_tasks_created_by on public.tasks(created_by);
create index if not exists idx_tasks_validated_by on public.tasks(validated_by);
create index if not exists idx_tasks_status on public.tasks(status, validated);
create index if not exists idx_xp_task on public.xp_log(task_id);
create index if not exists idx_xp_user_date on public.xp_log(user_id, created_at);
create index if not exists idx_audit_created on public.audit_log(created_at desc);

create or replace function public.work_open() returns boolean language sql stable security definer set search_path=public as
$$ select ((now() at time zone s.tz)::time >= s.open_time and (now() at time zone s.tz)::time < s.close_time) from public.app_settings s limit 1 $$;
create or replace function public.can_manage_task(t uuid) returns boolean language sql stable security definer set search_path=public as
$$ select public.is_admin() or (public.is_active() and public.work_open() and exists(select 1 from public.tasks where id=t and created_by=(select auth.uid()))) $$;
create or replace function public.can_see_task(t uuid) returns boolean language sql stable security definer set search_path=public as
$$ select public.is_admin() or (public.is_active() and public.work_open() and (exists(select 1 from public.tasks where id=t and created_by=(select auth.uid())) or exists(select 1 from public.task_assignees where task_id=t and user_id=(select auth.uid())))) $$;
create or replace function public.my_task_ids() returns setof uuid language sql stable security definer set search_path=public as $$
  select id from public.tasks where created_by=(select auth.uid())
  union select task_id from public.task_assignees where user_id=(select auth.uid()) $$;

drop policy if exists p_sel on public.profiles;
create policy p_sel on public.profiles for select to authenticated using (id=(select auth.uid()) or (select public.is_active()));
drop policy if exists t_sel on public.tasks;
create policy t_sel on public.tasks for select to authenticated using ((select public.is_admin()) or ((select (public.is_active() and public.work_open())) and (created_by=(select auth.uid()) or id in (select public.my_task_ids()))));
drop policy if exists t_ins on public.tasks;
create policy t_ins on public.tasks for insert to authenticated with check ((select public.is_active()) and created_by=(select auth.uid()) and not validated and ((select public.is_admin()) or (select public.work_open())));
drop policy if exists a_sel on public.task_assignees;
create policy a_sel on public.task_assignees for select to authenticated using ((select public.is_admin()) or ((select (public.is_active() and public.work_open())) and (user_id=(select auth.uid()) or task_id in (select public.my_task_ids()))));
drop policy if exists a_upd on public.task_assignees;
create policy a_upd on public.task_assignees for update to authenticated using (user_id=(select auth.uid()) or (select public.is_admin())) with check (user_id=(select auth.uid()) or (select public.is_admin()));
drop policy if exists c_sel on public.comments;
create policy c_sel on public.comments for select to authenticated using ((select public.is_admin()) or ((select (public.is_active() and public.work_open())) and task_id in (select public.my_task_ids())));
drop policy if exists c_ins on public.comments;
create policy c_ins on public.comments for insert to authenticated with check (user_id=(select auth.uid()) and public.can_see_task(task_id));
drop policy if exists c_upd on public.comments;
create policy c_upd on public.comments for update to authenticated using (user_id=(select auth.uid()) or public.can_manage_task(task_id)) with check (user_id=(select auth.uid()) or public.can_manage_task(task_id));
drop policy if exists n_sel on public.notifications;
create policy n_sel on public.notifications for select to authenticated using (user_id=(select auth.uid()) and ((select public.is_admin()) or (select public.work_open())));
drop policy if exists n_upd on public.notifications;
create policy n_upd on public.notifications for update to authenticated using (user_id=(select auth.uid()) and ((select public.is_admin()) or (select public.work_open()))) with check (user_id=(select auth.uid()));
drop policy if exists x_sel on public.xp_log;
create policy x_sel on public.xp_log for select to authenticated using (user_id=(select auth.uid()) or (select public.is_admin()));

create or replace function public.guard_task() returns trigger language plpgsql security definer set search_path=public as $$
declare recall boolean := coalesce(current_setting('app.recall', true),'')='1';
begin
  if old.validated and not recall then raise exception 'Tarefa validada não pode ser alterada'; end if;
  if new.created_by is distinct from old.created_by then raise exception 'Criador não pode mudar'; end if;
  if not recall then new.started_at := old.started_at; end if;
  if not recall and not is_admin() and (new.validated or new.validated_by is not null or new.validated_at is not null or new.rating is distinct from old.rating) then
    raise exception 'Apenas o administrador valida e dá nota às tarefas'; end if;
  if not recall and not (is_admin() or old.created_by=auth.uid()) and
     (new.title is distinct from old.title or new.description is distinct from old.description or new.priority is distinct from old.priority
      or new.due_date is distinct from old.due_date or new.estimated_minutes is distinct from old.estimated_minutes) then
    raise exception 'Sem permissão para editar os dados da tarefa'; end if;
  if new.validated then
    if new.status<>'concluida' then raise exception 'Só tarefas concluídas podem ser validadas'; end if;
    if new.rating is null then raise exception 'Dê uma nota de 1 a 5 para validar'; end if;
    new.validated_by:=auth.uid(); new.validated_at:=now();
  elsif new.rating is not null then raise exception 'A nota só vale junto com a validação'; end if;
  if new.status='andamento' and old.status is distinct from 'andamento' and new.started_at is null then new.started_at:=now(); end if;
  if new.status='concluida' and old.status<>'concluida' then
    new.completed_at:=now();
    if new.started_at is null then new.started_at := coalesce((select min(assigned_at) from task_assignees where task_id=new.id), now()); end if;
  elsif new.status<>'concluida' then new.completed_at:=null; end if;
  return new;
end $$;

create or replace function public.work_minutes(p_start timestamptz, p_end timestamptz) returns numeric language sql stable set search_path=public as
$$ select greatest(0, round(extract(epoch from (p_end - greatest(p_start, (((p_end at time zone s.tz)::date + s.open_time) at time zone s.tz))))/60.0, 1)) from public.app_settings s limit 1 $$;

create or replace function public.after_task_update() returns trigger language plpgsql security definer set search_path=public as $$
declare a record; base int; ratio numeric; tf numeric; qf numeric; lk numeric; mins numeric; pts int; ontime boolean; ldate date; tzn text;
begin
  if new.status='concluida' and old.status<>'concluida' then
    insert into notifications(user_id,title,body)
    select id,'Tarefa concluída: validar',new.title from profiles where role='admin' and active and id is distinct from auth.uid();
  end if;
  if new.validated and not old.validated then
    select s.tz into tzn from app_settings s limit 1;
    base := case new.priority when 'baixa' then 10 when 'media' then 20 when 'alta' then 40 else 60 end;
    mins := work_minutes(new.started_at, new.completed_at);
    ldate := (new.completed_at at time zone tzn)::date;
    if new.estimated_minutes is not null then
      ratio := mins / new.estimated_minutes;
      tf := case when ratio<=0.8 then 1.3 when ratio<=1.0 then 1.15 when ratio<=1.25 then 1.0 when ratio<=1.5 then 0.8 else 0.6 end;
      ontime := ratio<=1.0;
    elsif new.due_date is not null then
      ontime := ldate<=new.due_date;
      tf := case when ontime then 1.15 else greatest(0.5, 1.0 - 0.1*(ldate-new.due_date)) end;
    else tf := 1.0; ontime := true; end if;
    qf := case new.rating when 1 then 0.4 when 2 then 0.7 when 3 then 1.0 when 4 then 1.2 else 1.5 end;
    for a in select ta.user_id from task_assignees ta join profiles p on p.id=ta.user_id where ta.task_id=new.id and p.role='user' loop
      lk := round((0.9 + random()*0.2)::numeric, 2);
      pts := greatest(1, round(base*tf*qf*lk)::int);
      update profiles set xp=xp+pts where id=a.user_id;
      insert into xp_log(user_id,task_id,xp,reason,rating,minutes,on_time,priority,title,time_factor,quality_factor,luck)
        values(a.user_id,new.id,pts,'Tarefa validada',new.rating,round(mins)::int,ontime,new.priority,new.title,tf,qf,lk);
      insert into notifications(user_id,title,body) values(a.user_id,'Tarefa validada','+'||pts||' XP (nota '||new.rating||'/5): '||new.title);
    end loop;
  end if;
  return null;
end $$;

create or replace function public.recall_tasks() returns int language plpgsql security definer set search_path=public as $$
declare n int;
begin
  perform set_config('app.recall','1',true);
  with t as (select id from tasks where not validated and status<>'concluida' and exists(select 1 from task_assignees where task_id=tasks.id)),
       d as (delete from task_assignees where task_id in (select id from t) returning task_id)
  update tasks set status='pendente', started_at=null where id in (select id from t);
  get diagnostics n = row_count;
  insert into audit_log(actor,table_name,op,new_data) values(null,'tasks','RECALL',jsonb_build_object('recolhidas',n));
  return n;
end $$;
create or replace function public.recall_if_due() returns int language plpgsql security definer set search_path=public as $$
declare s record; loc timestamp; n int := 0;
begin
  select * into s from app_settings limit 1;
  loc := now() at time zone s.tz;
  if (loc::time >= s.close_time and (s.last_recall is null or s.last_recall < loc::date))
     or (loc::time < s.open_time and (s.last_recall is null or s.last_recall < loc::date - 1)) then
    n := recall_tasks();
    update app_settings set last_recall = case when loc::time >= s.close_time then loc::date else loc::date - 1 end where id;
  end if;
  return n;
end $$;
create or replace function public.recall_now() returns int language plpgsql security definer set search_path=public as $$
begin
  if not public.is_admin() then raise exception 'Apenas o administrador'; end if;
  return public.recall_tasks();
end $$;
create or replace function public.tick() returns int language sql security definer set search_path=public as $$ select public.recall_if_due() $$;

create or replace function public.team_month(p_month date)
returns table(uid uuid, nome text, tarefas int, xp_mes int, nota_media numeric, minutos_medios numeric, no_prazo int)
language sql stable security definer set search_path=public as $$
  select p.id, p.name, count(x.id)::int, coalesce(sum(x.xp),0)::int, round(avg(x.rating),1), round(avg(x.minutes),0), (count(*) filter (where x.on_time))::int
  from profiles p
  left join xp_log x on x.user_id=p.id
    and (x.created_at at time zone (select tz from app_settings limit 1))::date >= date_trunc('month',p_month)::date
    and (x.created_at at time zone (select tz from app_settings limit 1))::date < (date_trunc('month',p_month)+interval '1 month')::date
  where p.role='user' and p.active and public.is_active()
  group by p.id, p.name order by 4 desc, 2 $$;

-- permissões das funções: nada exposto a visitantes; internas só para o banco
alter default privileges revoke execute on functions from public;
revoke execute on function public.work_open(), public.recall_now(), public.tick(), public.team_month(date), public.my_task_ids(),
  public.recall_tasks(), public.recall_if_due(), public.work_minutes(timestamptz,timestamptz) from public, anon;
revoke execute on function public.recall_tasks(), public.recall_if_due(), public.work_minutes(timestamptz,timestamptz) from authenticated;
grant execute on function public.work_open(), public.can_manage_task(uuid), public.can_see_task(uuid), public.my_task_ids(),
  public.recall_now(), public.tick(), public.team_month(date) to authenticated;

-- agendador: confere a cada 10 min se já passou da hora de fechar e recolhe as tarefas (pg_cron)
create extension if not exists pg_cron;
select cron.unschedule(jobid) from cron.job where jobname='pulsetasks-recall';
select cron.schedule('pulsetasks-recall', '*/10 * * * *', 'select public.recall_if_due()');

-- ===================== v4: funcionário individual; só o admin cria/atribui =====================
create or replace function public.can_manage_task(t uuid) returns boolean language sql stable security definer set search_path=public as $$ select public.is_admin() $$;
drop policy if exists t_ins on public.tasks;
create policy t_ins on public.tasks for insert to authenticated with check ((select public.is_admin()) and created_by=(select auth.uid()) and not validated);
drop policy if exists p_sel on public.profiles;
create policy p_sel on public.profiles for select to authenticated using ((select public.is_admin()) or id=(select auth.uid()) or role='admin');
drop policy if exists a_sel on public.task_assignees;
create policy a_sel on public.task_assignees for select to authenticated using ((select public.is_admin()) or ((select (public.is_active() and public.work_open())) and user_id=(select auth.uid())));
drop policy if exists c_sel on public.comments;
create policy c_sel on public.comments for select to authenticated using ((select public.is_admin()) or ((select (public.is_active() and public.work_open())) and task_id in (select public.my_task_ids()) and (user_id=(select auth.uid()) or exists(select 1 from public.profiles p where p.id=user_id and p.role='admin'))));

create or replace function public.team_month(p_month date)
returns table(uid uuid, nome text, tarefas int, xp_mes int, nota_media numeric, minutos_medios numeric, no_prazo int)
language sql stable security definer set search_path=public as $$
  select p.id, p.name, count(x.id)::int, coalesce(sum(x.xp),0)::int, round(avg(x.rating),1), round(avg(x.minutes),0), (count(*) filter (where x.on_time))::int
  from profiles p
  left join xp_log x on x.user_id=p.id
    and (x.created_at at time zone (select tz from app_settings limit 1))::date >= date_trunc('month',p_month)::date
    and (x.created_at at time zone (select tz from app_settings limit 1))::date < (date_trunc('month',p_month)+interval '1 month')::date
  where p.role='user' and p.active and public.is_active() and (public.is_admin() or p.id=(select auth.uid()))
  group by p.id, p.name order by 4 desc, 2 $$;

create or replace function public.guard_status() returns trigger language plpgsql security definer set search_path=public as $$
begin
  if coalesce(current_setting('app.recall', true),'')='1' or is_admin() or new.status is not distinct from old.status then return new; end if;
  if (old.status='pendente' and new.status='andamento') or (old.status='andamento' and new.status in ('bloqueada','concluida'))
     or (old.status='bloqueada' and new.status in ('andamento','concluida')) or (old.status='concluida' and new.status='andamento') then return new; end if;
  raise exception 'Mudança de status não permitida';
end $$;
drop trigger if exists b_status on public.tasks;
create trigger b_status before update on public.tasks for each row execute function public.guard_status();
revoke execute on function public.guard_status() from public, anon, authenticated;

-- ===================== v5: tarefa em equipe só conclui quando todos terminam =====================
create or replace function public.auto_conclude() returns trigger language plpgsql security definer set search_path=public as $$
begin
  if new.progress=100 and old.progress<100 and not exists(select 1 from task_assignees where task_id=new.task_id and progress<100) then
    update tasks set status='concluida' where id=new.task_id and status in ('andamento','bloqueada');
  end if;
  return null;
end $$;
drop trigger if exists z_conclude on public.task_assignees;
create trigger z_conclude after update of progress on public.task_assignees for each row execute function public.auto_conclude();
revoke execute on function public.auto_conclude() from public, anon, authenticated;
