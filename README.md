# PulseTasks (PWA + GitHub Pages + Supabase)

Sem build, sem npm: o GitHub Pages serve os arquivos direto, igual ao app de orçamentos.

## Instalação (ordem)
1. **Supabase**: crie um projeto novo.
2. **SQL Editor** → cole todo o `supabase/schema.sql` → Run.
3. **Authentication → Sign In / Providers**: desligue **"Allow new users to sign up"** (só o admin cria contas). Em Email, mínimo de senha = 8.
4. **Criar o administrador**: Authentication → Users → *Add user* → e-mail `admin@pulsetasks.app` + sua senha, marcando *Auto Confirm*. Depois, no SQL Editor:
   ```sql
   insert into profiles(id,username,name,role)
   select id,'admin','Administrador','admin' from auth.users where email='admin@pulsetasks.app';
   ```
   (o usuário de login será `admin`; para outro nome, troque nos dois lugares, sempre minúsculo).
5. **Edge Function**: Edge Functions → *Deploy a new function* → nome **exatamente** `admin-users` (o painel sugere nomes aleatórios como `swift-service`; troque) → cole `supabase/functions/admin-users/index.ts`. (Ou CLI: `supabase functions deploy admin-users`.) As chaves secretas já são injetadas pelo Supabase (`SUPABASE_SECRET_KEYS`); não copie para lugar nenhum. **Desmarque "Verify JWT"** ao publicar (ou use `--no-verify-jwt`): com as chaves novas a verificação automática falha, e a própria função já valida o usuário e exige papel admin.
   Se seu usuário do GitHub não for `negry27`, ajuste a origem CORS no topo do arquivo.
6. **config.js**: Project Settings → API → copie o *Project URL* e a chave **Publishable** (`sb_publishable_...`). NUNCA a Secret (`sb_secret_...`).
7. **GitHub**: crie o repositório `negry27/pulsetasks`, envie todos os arquivos na branch `main`. Em Settings → Pages → Source: **GitHub Actions**. O deploy roda a cada push.
8. Abra `https://negry27.github.io/pulsetasks/`. No celular: menu do navegador → *Adicionar à tela inicial*.

## Atualizando uma instalação que já está rodando
1. SQL Editor → rode `supabase/update.sql` (admin sem tarefas/XP, leitura da tarefa recém-criada e endurecimento de funções). Pode rodar mais de uma vez.
2. Substitua os arquivos do repositório pelos novos e faça o commit; o Pages republica sozinho.
3. Antes de usar de verdade: rode `supabase/reset.sql` para zerar tarefas, avisos, XP e auditoria.

## Fluxo de uso
- **Tarefas → + Nova tarefa**: abre uma janelinha só para criar (título, descrição, prioridade, prazo). A tarefa nasce sem responsável.
- **Atribuir** (só admin): lista todas as tarefas ainda não validadas, as sem responsável primeiro. Marque uma ou mais pessoas e salve.
- Admin não recebe tarefas nem XP; só usuários comuns entram no ranking.

## Problemas comuns
- **"Não consegui falar com a função admin-users"** ao criar usuário: a função não foi publicada com o nome exato `admin-users`, ou está com *Verify JWT* ligado. Confira em Edge Functions e republique com Verify JWT desligado.
- **Outra mensagem de erro**: o app agora mostra o texto devolvido pela função; veja também Edge Functions → admin-users → Logs.

## Regras implementadas
- Login: usuário em minúsculas automático; senha exata (Supabase Auth, hash gerenciado).
- Admin exclusivo cria/desativa usuários e troca senhas (Edge Function).
- Tarefa sem responsável; atribuição posterior a várias pessoas; progresso individual e coletivo.
- Status, prioridade, prazo, comentários, impedimentos (resolvíveis).
- Validação só pelo admin, após "concluída"; validada fica travada; XP automático (10/20/40/60 por prioridade + 10 se no prazo).
- Notificações, relatórios, auditoria (tabela `audit_log`, só o admin lê).

## Segurança (o que protege de verdade)
- RLS em todas as tabelas; `anon` sem acesso a nada; gatilhos impedem não-admin de validar, mudar criador, XP ou papéis.
- Usuário comum só vê tarefas que criou ou em que é responsável. Admin vê tudo.
- Todo texto do banco é escapado no front (XSS) + CSP no `index.html`.
- Chave admin só dentro da Edge Function. Sem dados reais até concluir o checklist.

## Checklist de testes (antes de usar dados reais)
Crie 3 contas: admin, `ana`, `bruno`.
- [ ] Login `ANA` e `ana` funcionam; senha com maiúscula errada falha.
- [ ] Sem login, abrir `https://SEU-PROJETO.supabase.co/rest/v1/tasks` com a chave anon retorna `[]`/401.
- [ ] Ana não vê tarefa de Bruno; admin vê todas.
- [ ] Ana não consegue validar tarefa (erro) nem mudar `role`/`xp` (via console: `sb.from('profiles').update(...)`).
- [ ] Ana não cria usuário (função retorna "Acesso negado").
- [ ] Ana não lê `audit_log` nem notificações de Bruno.
- [ ] Ana não edita título/prazo de tarefa criada por outra pessoa.
- [ ] Tarefa validada não aceita mais alterações; XP creditado uma única vez.
- [ ] Usuário desativado não consegue logar.
- [ ] Cadastro público (signup) está desligado.
- [ ] Nenhum arquivo do repositório contém `service_role`.

## Limitações conhecidas
- Edição de título/descrição/prazo de tarefa existente ainda não tem tela (o banco já protege).
- Sem tempo real: os dados atualizam ao navegar/recarregar.
- Biblioteca do Supabase vem do CDN jsDelivr; offline o app não abre dados (apenas a casca é cacheada).
- Dados do sistema antigo não foram migrados.
