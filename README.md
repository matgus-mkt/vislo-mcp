# vislo-mcp

Servidor MCP remoto do Vislo — conecta o Claude.ai diretamente aos projetos e eventos da conta do usuário.

## Tools disponíveis

| Tool | Descrição |
|---|---|
| `list_projects` | Lista projetos ativos com detecção de abandono (14+ dias) |
| `get_project_events` | Eventos de um projeto com filtros de data e categoria |
| `create_project` | Cria novo projeto |
| `create_event` | Cria evento + dispara email de notificação ao cliente |
| `get_audit_log` | Log de atividade da conta |
| `get_project_summary` | Resumo executivo do período (padrão: últimos 30 dias) |

---

## Deploy no Railway (recomendado)

### 1. Criar repositório

```bash
git init
git add .
git commit -m "vislo-mcp v1.0.0"
# criar repo no GitHub e fazer push
git remote add origin https://github.com/SEU_USER/vislo-mcp.git
git push -u origin main
```

### 2. Deploy no Railway

1. Acesse [railway.app](https://railway.app) → **New Project → Deploy from GitHub repo**
2. Selecione o repositório `vislo-mcp`
3. Railway detecta automaticamente Node.js e usa `npm start`
4. Após o deploy, copie a URL pública (ex: `https://vislo-mcp.up.railway.app`)

Sem variáveis de ambiente necessárias — as chaves estão no server.js.

---

## Deploy no Render (alternativa gratuita)

1. [render.com](https://render.com) → **New → Web Service**
2. Conecte o repositório GitHub
3. **Build Command:** `npm install`
4. **Start Command:** `node server.js`
5. **Instance Type:** Free

> ⚠️ O free tier do Render hiberna após 15 min de inatividade — primeira requisição pode levar ~30s. Para produção, use Railway (free tier não hiberna).

---

## Conectar no Claude.ai

### Gerar o token do usuário

No admin do Vislo, o usuário vai em **Minha Conta → Token de Integração** e copia o JWT.

> Enquanto essa UI não existe: o token é o `access_token` retornado pelo Supabase Auth no login.
> Temporariamente, pode ser obtido via DevTools → Application → Local Storage → `sb-wnwowuxlndslofgjluqb-auth-token` → `access_token`.

### Adicionar a integração

1. [claude.ai](https://claude.ai) → **Settings → Integrations → Add Custom Integration**
2. **Name:** Vislo
3. **URL:** `https://vislo-mcp.up.railway.app` (sua URL do Railway)
4. Clicar em **Add**
5. Quando o Claude pedir autenticação, colar o token JWT no campo **Authorization**

---

## Exemplos de uso no Claude

```
Liste meus projetos no Vislo

Quais projetos estão sem atualização há mais de 2 semanas?

Adiciona um evento no projeto acme-tecnologia:
título "Landing page no ar", data de hoje, categoria resultado,
descrição "Taxa de conversão inicial de 3,2% nas primeiras 24h"

Me dá um resumo do projeto acme-tecnologia dos últimos 30 dias

Gera um relatório de maio para o projeto globo-marketing

O que aconteceu nos meus projetos essa semana?

Cria o projeto "Nubank Q3" com slug nubank-q3,
email de notificação cliente@nubank.com.br
```

---

## Desenvolvimento local

```bash
npm install
node server.js
# → http://localhost:3000/health
```

### Testar o handshake MCP

```bash
# Discovery
curl -I http://localhost:3000/

# Initialize (sem token)
curl -X POST http://localhost:3000/ \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}'

# tools/list (com token)
curl -X POST http://localhost:3000/ \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer SEU_JWT_AQUI" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
```

---

## Arquitetura de autenticação

```
Usuário faz login no Vislo (Supabase Auth)
         ↓
  Recebe JWT pessoal
         ↓
  Cola no Claude.ai como Bearer token
         ↓
  Claude envia token em cada request ao MCP server
         ↓
  MCP server valida JWT no Supabase Auth → getUser()
         ↓
  Todas as queries usam o JWT do usuário → RLS aplicado
         ↓
  Usuário só vê SEUS projetos e eventos
```

O RLS do Supabase garante isolamento total: cada JWT só acessa os dados do seu owner.

---

## Próximos passos

- [ ] UI "Token de Integração" no admin.html (seção Minha Conta)
- [ ] OAuth 2.1 completo para listagem no Anthropic Connector Directory
- [ ] Tool `update_event` para edições via Claude
- [ ] Tool `generate_monthly_report` que usa a API do Claude para escrever o relatório em linguagem natural
- [ ] Webhook ao criar evento (Make/Zapier)
