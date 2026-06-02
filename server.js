/**
 * Vislo MCP Server v1.0
 * Remote MCP server — conecta o Claude e o ChatGPT ao Vislo via Supabase JWT.
 *
 * Deploy: Railway / Render (free tier)
 * Auth: Bearer <supabase-access-token>
 */

import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

// ── CONFIG ────────────────────────────────────────────────────────────────────

const SUPABASE_URL      = 'https://wnwowuxlndslofgjluqb.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Indud293dXhsbmRzbG9mZ2psdXFiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwMTY3MDEsImV4cCI6MjA4OTU5MjcwMX0.Re7SIx2jcNPlQwUCY0BqIBYIygh8jMCbBPpCasYe-TA';
const EDGE_NOTIFY_URL   = 'https://wnwowuxlndslofgjluqb.supabase.co/functions/v1/notify-event';
const PORT              = process.env.PORT || 3000;

const EVENT_TYPES = ['update', 'milestone', 'meeting', 'result', 'alert'];
const TYPE_LABELS = { update:'Atualização', milestone:'Marco', meeting:'Reunião', result:'Resultado', alert:'Alerta' };
const STALE_DAYS  = 14;

// ── SUPABASE HELPERS ──────────────────────────────────────────────────────────

async function sbQuery(jwt, table, params = '') {
  const url = `${SUPABASE_URL}/rest/v1/${table}${params ? '?' + params : ''}`;
  const res = await fetch(url, {
    headers: {
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${jwt}`,
      'Accept': 'application/json',
    },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  return res.json();
}

async function sbInsert(jwt, table, payload) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${jwt}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Supabase insert ${res.status}: ${await res.text()}`);
  return res.json();
}

async function sbPatch(jwt, table, match, payload) {
  const qs = Object.entries(match).map(([k,v]) => `${k}=eq.${encodeURIComponent(v)}`).join('&');
  await fetch(`${SUPABASE_URL}/rest/v1/${table}?${qs}`, {
    method: 'PATCH',
    headers: {
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${jwt}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
}

async function getUser(jwt) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${jwt}` },
  });
  if (!res.ok) return null;
  return res.json();
}

const stripHtml  = (h) => h ? h.replace(/<[^>]*>/g, '').trim() : '';
const textToHtml = (t) => t ? t.split('\n').map(l => `<p>${l.trim() || '<br>'}</p>`).join('') : null;

// ── MCP SERVER FACTORY ────────────────────────────────────────────────────────

function createServer(userJwt, userEmail) {
  const server = new McpServer({ name: 'vislo', version: '1.0.0' });

  // ── list_projects ──────────────────────────────────────────────────────────
  server.tool(
    'list_projects',
    'Lista os projetos do usuário no Vislo. Mostra status, último evento e sinaliza projetos abandonados (14+ dias sem update).',
    { status: z.enum(['active','paused','done','all']).optional().describe('Filtrar por status. Padrão: active + paused.') },
    async ({ status }) => {
      let qs = 'select=slug,name,description,status,notify_email,last_event_date,created_at&deleted_at=is.null&order=created_at.desc';
      qs += (!status || status === 'all') ? '&status=in.(active,paused)' : `&status=eq.${status}`;

      const projects = await sbQuery(userJwt, 'projects', qs);
      if (!projects.length) return { content: [{ type: 'text', text: 'Nenhum projeto encontrado.' }] };

      const today = new Date();
      const lines = projects.map(p => {
        const lastDate  = p.last_event_date ? new Date(p.last_event_date) : null;
        const daysSince = lastDate ? Math.floor((today - lastDate) / 86400000) : null;
        const stale     = daysSince !== null && daysSince >= STALE_DAYS;
        return [
          `**${p.name}** (slug: \`${p.slug}\`)`,
          `  Status: ${p.status}${stale ? ` ⚠️ sem atualização há ${daysSince} dias` : ''}`,
          `  Último evento: ${p.last_event_date || 'nenhum'}`,
          `  Notificação: ${p.notify_email || 'não configurado'}`,
          `  Link: https://app.vislo.cc/timeline.html?cliente=${p.slug}`,
        ].join('\n');
      });

      return { content: [{ type: 'text', text: `## Projetos (${projects.length})\n\n${lines.join('\n\n')}` }] };
    }
  );

  // ── get_project_events ─────────────────────────────────────────────────────
  server.tool(
    'get_project_events',
    'Retorna os eventos de um projeto. Use para gerar resumos, relatórios mensais ou responder "o que foi feito no projeto X".',
    {
      slug:      z.string().describe('Slug do projeto (ex: acme-tecnologia)'),
      type:      z.enum([...EVENT_TYPES, 'all']).optional().describe('Filtrar por categoria'),
      date_from: z.string().optional().describe('Data inicial YYYY-MM-DD'),
      date_to:   z.string().optional().describe('Data final YYYY-MM-DD'),
      limit:     z.number().int().min(1).max(200).optional().describe('Máximo de eventos (padrão 50)'),
    },
    async ({ slug, type, date_from, date_to, limit = 50 }) => {
      const [project] = await sbQuery(userJwt, 'projects',
        `select=name,slug,status,last_event_date&slug=eq.${encodeURIComponent(slug)}&deleted_at=is.null`);
      if (!project) return { content: [{ type: 'text', text: `Projeto \`${slug}\` não encontrado.` }] };

      let qs = `select=title,date,type,description&project_slug=eq.${encodeURIComponent(slug)}&order=date.desc,position.asc&limit=${limit}`;
      if (type && type !== 'all') qs += `&type=eq.${type}`;
      if (date_from) qs += `&date=gte.${date_from}`;
      if (date_to)   qs += `&date=lte.${date_to}`;

      const events = await sbQuery(userJwt, 'events', qs);
      if (!events.length) return { content: [{ type: 'text', text: `Nenhum evento em **${project.name}**.` }] };

      const lines = events.map(e => {
        const desc = e.description ? `\n    > ${stripHtml(e.description).slice(0, 300)}` : '';
        return `- **[${TYPE_LABELS[e.type] || e.type}]** ${e.date} — ${e.title}${desc}`;
      });

      return {
        content: [{
          type: 'text',
          text: `## ${project.name} — Eventos (${events.length})\nStatus: ${project.status} | Último update: ${project.last_event_date || 'nenhum'}\n\n${lines.join('\n')}`,
        }],
      };
    }
  );

  // ── create_project ─────────────────────────────────────────────────────────
  server.tool(
    'create_project',
    'Cria um novo projeto no Vislo.',
    {
      name:         z.string().min(1).max(100).describe('Nome do cliente ou projeto'),
      slug:         z.string().min(1).max(60).regex(/^[a-z0-9-]+$/).describe('Slug para URL (letras minúsculas, números, hífens). Ex: acme-tecnologia'),
      description:  z.string().max(500).optional().describe('Descrição do projeto'),
      notify_email: z.string().email().optional().describe('Email do cliente para notificações automáticas'),
    },
    async ({ name, slug, description, notify_email }) => {
      const existing = await sbQuery(userJwt, 'projects', `select=slug&slug=eq.${encodeURIComponent(slug)}`);
      if (existing.length) return { content: [{ type: 'text', text: `❌ Slug \`${slug}\` já está em uso. Escolha outro.` }] };

      const [created] = await sbInsert(userJwt, 'projects', {
        name, slug, status: 'active',
        description: description || null,
        notify_email: notify_email || null,
      });

      await sbInsert(userJwt, 'audit_log', {
        user_email: userEmail, action: 'create', entity: 'projeto',
        entity_name: name, details: `Criado via MCP/Claude. Slug: ${slug}`,
      }).catch(() => {});

      return {
        content: [{
          type: 'text',
          text: [
            `✅ Projeto criado!`,
            `**${created.name}** — slug: \`${created.slug}\``,
            `Link público: https://app.vislo.cc/timeline.html?cliente=${created.slug}`,
            notify_email ? `📧 Notificações para: ${notify_email}` : '⚠️ Email de notificação não configurado.',
          ].join('\n'),
        }],
      };
    }
  );

  // ── create_event ───────────────────────────────────────────────────────────
  server.tool(
    'create_event',
    'Cria um evento na timeline de um projeto e dispara notificação por email ao cliente (se configurado).',
    {
      project_slug: z.string().describe('Slug do projeto'),
      title:        z.string().min(1).max(200).describe('Título do evento (ex: Campanha de remarketing no ar)'),
      date:         z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Data no formato YYYY-MM-DD'),
      type:         z.enum(EVENT_TYPES).describe('Categoria: update (atualização), milestone (marco), meeting (reunião), result (resultado), alert (alerta)'),
      description:  z.string().max(2000).optional().describe('Descrição detalhada (texto simples)'),
    },
    async ({ project_slug, title, date, type, description }) => {
      const [project] = await sbQuery(userJwt, 'projects',
        `select=id,name,slug,notify_email&slug=eq.${encodeURIComponent(project_slug)}&deleted_at=is.null`);
      if (!project) return { content: [{ type: 'text', text: `❌ Projeto \`${project_slug}\` não encontrado.` }] };

      const sameDay = await sbQuery(userJwt, 'events',
        `select=position&project_slug=eq.${project_slug}&date=eq.${date}&order=position.desc&limit=1`);
      const position = sameDay.length ? (sameDay[0].position ?? 0) + 1 : 0;

      const [created] = await sbInsert(userJwt, 'events', {
        project_slug, title, date, type, position,
        description: textToHtml(description),
      });

      await sbPatch(userJwt, 'projects', { slug: project_slug }, { last_event_date: date }).catch(() => {});

      let emailStatus = '📭 Email não configurado para este projeto.';
      if (project.notify_email) {
        try {
          const r = await fetch(EDGE_NOTIFY_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SUPABASE_ANON_KEY}` },
            body: JSON.stringify({ project, event: created }),
          });
          emailStatus = r.ok
            ? `📧 Email enviado para ${project.notify_email}`
            : `⚠️ Falha no envio de email (status ${r.status})`;
        } catch (e) {
          emailStatus = `⚠️ Erro no email: ${e.message}`;
        }
      }

      await sbInsert(userJwt, 'audit_log', {
        user_email: userEmail, action: 'create', entity: 'evento',
        entity_name: title, details: `Via MCP/Claude — ${project.name} | ${type}`,
      }).catch(() => {});

      return {
        content: [{
          type: 'text',
          text: [
            `✅ Evento criado!`,
            `**${title}**`,
            `Projeto: ${project.name} | Data: ${date} | Categoria: ${TYPE_LABELS[type]}`,
            emailStatus,
          ].join('\n'),
        }],
      };
    }
  );

  // ── get_audit_log ──────────────────────────────────────────────────────────
  server.tool(
    'get_audit_log',
    'Retorna o log de atividade da conta — quem fez o quê e quando.',
    {
      limit:  z.number().int().min(1).max(100).optional().describe('Número de entradas (padrão 20)'),
      action: z.enum(['create','update','delete','restore','all']).optional().describe('Filtrar por tipo de ação'),
    },
    async ({ limit = 20, action }) => {
      let qs = `select=user_email,action,entity,entity_name,details,created_at&order=created_at.desc&limit=${limit}`;
      if (action && action !== 'all') qs += `&action=eq.${action}`;

      const logs = await sbQuery(userJwt, 'audit_log', qs);
      if (!logs.length) return { content: [{ type: 'text', text: 'Nenhuma atividade registrada.' }] };

      const lines = logs.map(l => {
        const ts = new Date(l.created_at).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
        return `- \`${ts}\` **${l.action}** ${l.entity}: **${l.entity_name || '—'}** por ${l.user_email}${l.details ? `\n  _${l.details}_` : ''}`;
      });

      return { content: [{ type: 'text', text: `## Log de atividade (${logs.length})\n\n${lines.join('\n')}` }] };
    }
  );

  // ── get_project_summary ────────────────────────────────────────────────────
  server.tool(
    'get_project_summary',
    'Gera um resumo estruturado de um projeto por período (padrão: últimos 30 dias). Ideal para criar relatórios mensais para o cliente.',
    {
      slug: z.string().describe('Slug do projeto'),
      days: z.number().int().min(1).max(365).optional().describe('Dias retroativos (padrão 30)'),
    },
    async ({ slug, days = 30 }) => {
      const [project] = await sbQuery(userJwt, 'projects',
        `select=name,slug,description,status,last_event_date&slug=eq.${encodeURIComponent(slug)}&deleted_at=is.null`);
      if (!project) return { content: [{ type: 'text', text: `Projeto \`${slug}\` não encontrado.` }] };

      const dateFrom = new Date();
      dateFrom.setDate(dateFrom.getDate() - days);
      const from = dateFrom.toISOString().split('T')[0];
      const to   = new Date().toISOString().split('T')[0];

      const events = await sbQuery(userJwt, 'events',
        `select=title,date,type,description&project_slug=eq.${encodeURIComponent(slug)}&date=gte.${from}&order=date.asc`);

      const grouped = Object.fromEntries(EVENT_TYPES.map(t => [t, []]));
      for (const e of events) { if (grouped[e.type]) grouped[e.type].push(e); }

      const sections = EVENT_TYPES
        .filter(t => grouped[t].length > 0)
        .map(t => {
          const items = grouped[t].map(e => `  - ${e.date}: ${e.title}`).join('\n');
          return `### ${TYPE_LABELS[t]} (${grouped[t].length})\n${items}`;
        });

      return {
        content: [{
          type: 'text',
          text: [
            `## Resumo — ${project.name}`,
            `Período: ${from} → ${to} | Total: ${events.length} eventos | Status: ${project.status}`,
            project.description ? `\n_${project.description}_` : '',
            '',
            events.length === 0 ? '_Nenhum evento no período._' : sections.join('\n\n'),
          ].join('\n'),
        }],
      };
    }
  );

  return server;
}

// ── EXPRESS APP ───────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

// CORS + Accept fix para ChatGPT
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  // ChatGPT não envia Accept correto — injeta antes do transport processar
  if (req.method === 'POST' && !req.headers['accept']?.includes('text/event-stream')) {
    req.headers['accept'] = 'application/json, text/event-stream';
  }
  next();
});

// Health check
app.get('/health', (_, res) => res.json({ status: 'ok', service: 'vislo-mcp', version: '1.0.0' }));

// MCP protocol discovery
app.head('/', (_, res) => {
  res.setHeader('MCP-Protocol-Version', '2025-06-18');
  res.sendStatus(200);
});

// Root GET — discovery para Claude, ChatGPT e outros clientes
app.get('/', (_, res) => {
  res.setHeader('MCP-Protocol-Version', '2025-06-18');
  res.json({ status: 'ok', service: 'vislo-mcp', version: '1.0.0' });
});

// MCP endpoint principal
app.post('/', async (req, res) => {
  if (!req.headers['accept']) {
    req.headers['accept'] = 'application/json, text/event-stream';
  }

  const message = req.body;
  const isHandshake = ['initialize', 'notifications/initialized'].includes(message?.method);

  let userJwt   = null;
  let userEmail = 'unknown';

  if (!isHandshake) {
    const auth = req.headers['authorization'] || '';
    if (!auth.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Token ausente. Use: Authorization: Bearer <token-vislo>' });
    }
    userJwt = auth.slice(7).trim();

    const user = await getUser(userJwt).catch(() => null);
    if (!user?.email) {
      return res.status(401).json({ error: 'Token inválido ou expirado. Gere um novo token no Vislo.' });
    }
    userEmail = user.email;
  }

  const mcpServer = createServer(userJwt, userEmail);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => `vislo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  });

  try {
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, message);
  } catch (err) {
    console.error('[vislo-mcp]', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
  }
});

app.listen(PORT, () => {
  console.log(`[vislo-mcp] porta ${PORT} — health: http://localhost:${PORT}/health`);
});
