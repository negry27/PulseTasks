-- Zera os dados de uso e mantém o admin. Rode antes de colocar em produção.
delete from tasks;           -- apaga atribuições e comentários em cascata
delete from notifications;
delete from xp_log;
delete from audit_log;
update profiles set xp = 0;
-- Para apagar também os usuários de teste (mantém só o admin), descomente:
-- delete from auth.users where email <> 'admin@pulsetasks.app';
