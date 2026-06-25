import type { Actor } from '@rooster/core'
import type {
  Agent,
  AuditLog,
  Comment,
  Org,
  Project,
  Team,
  Ticket,
  TicketStatus,
} from '@rooster/schema'
import { TICKET_STATUSES } from '@rooster/schema'

/** Escape untrusted text for safe HTML interpolation. */
export function esc(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

const STYLES = `
:root{--amber:#d97706;--amber-dark:#b45309;--ink:#18181b;--muted:#71717a;--line:#e4e4e7;--bg:#fff;--soft:#fafaf9}
*{box-sizing:border-box}
body{margin:0;font:15px/1.6 ui-sans-serif,system-ui,sans-serif;color:var(--ink);background:var(--soft)}
a{color:var(--amber-dark);text-decoration:none}a:hover{text-decoration:underline}
header.top{display:flex;align-items:center;justify-content:space-between;background:#1c1917;color:#fafaf9;padding:.7rem 1.25rem}
header.top .brand{font-weight:700;color:#fafaf9}
header.top nav{display:flex;gap:1.1rem;align-items:center}
header.top nav a{color:#d6d3d1;font-size:.92rem}header.top nav a:hover{color:#fbbf24}
.wrap{max-width:64rem;margin:1.75rem auto;padding:0 1.25rem}
h1{font-size:1.5rem;margin:0 0 .25rem}h2{font-size:1.15rem;margin:1.75rem 0 .75rem}
.muted{color:var(--muted)}
.card{background:var(--bg);border:1px solid var(--line);border-radius:12px;padding:1rem 1.1rem;margin-bottom:.75rem}
.row{display:flex;justify-content:space-between;gap:1rem;align-items:baseline}
.badge{display:inline-block;font-size:.72rem;font-weight:600;padding:.12rem .5rem;border-radius:999px;background:#f4f4f5;color:var(--ink)}
.badge.amber{background:#fef3c7;color:#92400e}
.key{font-family:ui-monospace,monospace;color:var(--amber-dark);font-weight:600}
.board{display:grid;grid-template-columns:repeat(auto-fill,minmax(13rem,1fr));gap:.9rem}
.col{background:var(--bg);border:1px solid var(--line);border-radius:12px;padding:.75rem}
.col h3{font-size:.8rem;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin:.1rem 0 .6rem}
.tk{border:1px solid var(--line);border-radius:9px;padding:.5rem .6rem;margin-bottom:.5rem;background:var(--soft)}
.tk a{color:var(--ink);font-weight:500}
.btn{display:inline-block;background:var(--amber);color:#fff;padding:.5rem .9rem;border-radius:9px;font-weight:600;border:0;cursor:pointer}
.btn:hover{background:var(--amber-dark);text-decoration:none}
.tags{display:flex;gap:.3rem;flex-wrap:wrap;margin-top:.35rem}.tags .t{font-size:.7rem;background:#eef;color:#334;border-radius:999px;padding:.05rem .45rem}
form.auth{max-width:22rem}form.auth input{width:100%;padding:.55rem .65rem;border:1px solid var(--line);border-radius:8px;margin:.35rem 0}
table{width:100%;border-collapse:collapse;font-size:.9rem}td,th{text-align:left;padding:.45rem .5rem;border-bottom:1px solid var(--line);vertical-align:top}
.empty{color:var(--muted);font-style:italic}
.actions{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;margin:.6rem 0}
.actions input,.actions select,.actions textarea{padding:.45rem .6rem;border:1px solid var(--line);border-radius:8px;font:inherit}
.actions input,.actions textarea{flex:1;min-width:10rem}
.actions textarea{min-height:3.5rem}
.btn.sm{padding:.35rem .7rem;font-size:.85rem}
.btn.ghost{background:transparent;border:1px solid var(--line);color:var(--ink)}
.btn.ghost:hover{border-color:var(--amber);color:var(--amber-dark);background:transparent}
fieldset{border:1px solid var(--line);border-radius:12px;padding:.75rem 1rem;margin:.75rem 0}
fieldset legend{font-size:.78rem;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);padding:0 .35rem}
`

function chrome(title: string, actor: Actor | null, body: string): string {
  const nav = actor
    ? `<nav>
        <a href="/app">Overview</a>
        <a href="/app/agents">Agents</a>
        <a href="/app/audit">Audit</a>
        <span class="muted">${esc(actor.role)}</span>
        <form method="post" action="/api/auth/sign-out" style="margin:0"><button class="btn" style="padding:.3rem .7rem">Sign out</button></form>
      </nav>`
    : ''
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Rooster</title><style>${STYLES}</style></head>
<body><header class="top"><a class="brand" href="/app">🐓 Rooster</a>${nav}</header>
<div class="wrap">${body}</div></body></html>`
}

// better-auth's email endpoints take JSON, so submit the form via fetch and
// redirect to the dashboard on success.
const AUTH_SCRIPT = `<script>
document.getElementById('auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.currentTarget;
  const res = await fetch(f.action, { method:'POST', headers:{'content-type':'application/json'},
    body: JSON.stringify(Object.fromEntries(new FormData(f))) });
  if (res.ok) { location.href = '/app'; return; }
  const data = await res.json().catch(() => ({}));
  document.getElementById('auth-err').textContent = data.message || 'Authentication failed';
});
</script>`

export function loginPage(opts: { providers: string[]; error?: string }): string {
  const oauth = opts.providers
    .map(
      (p) =>
        `<a class="btn" style="display:block;text-align:center;margin:.4rem 0" href="/api/auth/sign-in/social?provider=${esc(p)}">Continue with ${esc(p)}</a>`,
    )
    .join('')
  return chrome(
    'Sign in',
    null,
    `<h1>Sign in</h1><p class="muted">Access your Rooster dashboard.</p>
    <p id="auth-err" style="color:#b91c1c">${esc(opts.error ?? '')}</p>
    ${oauth}
    <form id="auth-form" class="auth" method="post" action="/api/auth/sign-in/email">
      <input name="email" type="email" placeholder="you@example.com" required>
      <input name="password" type="password" placeholder="Password" required>
      <button class="btn" type="submit" style="width:100%">Sign in</button>
    </form>
    <p class="muted" style="margin-top:1rem">No account? <a href="/app/signup">Create one</a>.</p>
    ${AUTH_SCRIPT}`,
  )
}

export function signupPage(opts: { error?: string } = {}): string {
  return chrome(
    'Create account',
    null,
    `<h1>Create account</h1>
    <p id="auth-err" style="color:#b91c1c">${esc(opts.error ?? '')}</p>
    <form id="auth-form" class="auth" method="post" action="/api/auth/sign-up/email">
      <input name="name" type="text" placeholder="Your name" required>
      <input name="email" type="email" placeholder="you@example.com" required>
      <input name="password" type="password" placeholder="Password (min 8 chars)" required minlength="8">
      <button class="btn" type="submit" style="width:100%">Create account</button>
    </form>
    <p class="muted" style="margin-top:1rem">Already have one? <a href="/app/login">Sign in</a>.</p>
    ${AUTH_SCRIPT}`,
  )
}

export function noOrgPage(actor: Actor | null, email: string): string {
  return chrome(
    'Welcome',
    actor,
    `<h1>You're signed in</h1>
    <p class="muted">${esc(email)} isn't a member of any organization yet.</p>
    <p>Provision a tenant with <code>POST /onboard</code> (see <a href="/llms.txt">/llms.txt</a>),
    or ask an admin to add you.</p>`,
  )
}

export function orgOverview(data: {
  org: Org
  teams: Team[]
  projects: Project[]
  actor: Actor
}): string {
  const teams = data.teams.length
    ? data.teams
        .map((t) => {
          const projects = data.projects.filter((p) => p.teamId === t.id)
          const items = projects.length
            ? projects
                .map(
                  (p) =>
                    `<div class="row"><a href="/app/projects/${esc(p.id)}">${esc(p.name)}</a>${p.archived ? '<span class="badge">archived</span>' : ''}</div>`,
                )
                .join('')
            : '<div class="empty">No projects</div>'
          return `<div class="card"><div class="row"><strong>${esc(t.name)}</strong><span class="key">${esc(t.key)}</span></div><div style="margin-top:.5rem">${items}</div></div>`
        })
        .join('')
    : '<div class="empty">No teams yet.</div>'
  return chrome(
    data.org.name,
    data.actor,
    `<h1>${esc(data.org.name)}</h1><p class="muted">${esc(data.org.slug)}</p><h2>Teams &amp; projects</h2>${teams}`,
  )
}

const STATUS_LABEL: Record<TicketStatus, string> = {
  backlog: 'Backlog',
  todo: 'To do',
  in_progress: 'In progress',
  in_review: 'In review',
  done: 'Done',
  canceled: 'Canceled',
}

export function projectBoard(data: {
  project: Project
  tickets: Ticket[]
  actor: Actor
  canWrite: boolean
}): string {
  const createForm = data.canWrite
    ? `<form method="post" action="/app/projects/${esc(data.project.id)}/tickets" class="actions">
        <input name="title" placeholder="New ticket title" required maxlength="300">
        <input name="labels" placeholder="tags, comma-separated">
        <button class="btn" type="submit">Create ticket</button>
      </form>`
    : ''
  const cols = TICKET_STATUSES.map((status) => {
    const inCol = data.tickets.filter((t) => t.status === status)
    const cards = inCol.length
      ? inCol
          .map(
            (t) =>
              `<div class="tk"><div><span class="key">${esc(t.key)}</span></div>
              <a href="/app/tickets/${esc(t.id)}">${esc(t.title)}</a>
              ${t.labels.length ? `<div class="tags">${t.labels.map((l) => `<span class="t">${esc(l)}</span>`).join('')}</div>` : ''}</div>`,
          )
          .join('')
      : '<div class="empty" style="font-size:.8rem">—</div>'
    return `<div class="col"><h3>${esc(STATUS_LABEL[status])} · ${inCol.length}</h3>${cards}</div>`
  }).join('')
  return chrome(
    data.project.name,
    data.actor,
    `<p class="muted"><a href="/app">← Overview</a></p><h1>${esc(data.project.name)}</h1>
    ${data.project.description ? `<p class="muted">${esc(data.project.description)}</p>` : ''}
    ${createForm}
    <div class="board">${cols}</div>`,
  )
}

export function ticketDetail(data: {
  ticket: Ticket
  comments: Comment[]
  actor: Actor
  canWrite: boolean
  allowedStatuses: readonly TicketStatus[]
}): string {
  const t = data.ticket
  const comments = data.comments.length
    ? data.comments
        .map(
          (c) =>
            `<div class="card"><div class="muted" style="font-size:.8rem">${esc(c.authorId)} · ${esc(c.createdAt)}</div><div>${esc(c.body)}</div></div>`,
        )
        .join('')
    : '<div class="empty">No comments.</div>'

  const statusForm =
    data.canWrite && data.allowedStatuses.length
      ? `<form method="post" action="/app/tickets/${esc(t.id)}/status" class="actions">
          <select name="status">${data.allowedStatuses.map((s) => `<option value="${esc(s)}">${esc(STATUS_LABEL[s])}</option>`).join('')}</select>
          <button class="btn sm" type="submit">Move</button>
        </form>`
      : ''
  const assignForm = data.canWrite
    ? `<form method="post" action="/app/tickets/${esc(t.id)}/assign" class="actions">
        <input name="assigneeId" placeholder="principal id (blank = unassign)" value="${esc(t.assigneeId ?? '')}">
        <button class="btn sm ghost" type="submit">Assign</button>
      </form>`
    : ''
  const commentForm = data.canWrite
    ? `<form method="post" action="/app/tickets/${esc(t.id)}/comments" class="actions">
        <textarea name="body" placeholder="Add a comment" required maxlength="50000"></textarea>
        <button class="btn sm" type="submit">Comment</button>
      </form>`
    : ''
  const controls = data.canWrite
    ? `<fieldset><legend>Actions</legend>${statusForm}${assignForm}</fieldset>`
    : ''

  return chrome(
    t.key,
    data.actor,
    `<p class="muted"><a href="/app/projects/${esc(t.projectId)}">← Board</a></p>
    <div class="row"><h1><span class="key">${esc(t.key)}</span> ${esc(t.title)}</h1></div>
    <div style="margin:.25rem 0 1rem"><span class="badge amber">${esc(STATUS_LABEL[t.status])}</span>
      <span class="badge">priority: ${esc(t.priority)}</span>
      ${t.assigneeId ? `<span class="badge">assignee: ${esc(t.assigneeId)}</span>` : '<span class="badge">unassigned</span>'}</div>
    ${t.description ? `<div class="card">${esc(t.description)}</div>` : ''}
    ${t.labels.length ? `<div class="tags">${t.labels.map((l) => `<span class="t">${esc(l)}</span>`).join('')}</div>` : ''}
    ${controls}
    <h2>Comments</h2>${comments}${commentForm}`,
  )
}

const AGENT_STATUS_OPTIONS = ['active', 'suspended', 'revoked'] as const

export function agentsList(data: { agents: Agent[]; actor: Actor; canManage: boolean }): string {
  const actionsCol = data.canManage ? '<th>Manage</th>' : ''
  const rows = data.agents.length
    ? data.agents
        .map((a) => {
          const manage = data.canManage
            ? `<td>
                <form method="post" action="/app/agents/${esc(a.id)}/status" class="actions" style="margin:0">
                  <select name="status">${AGENT_STATUS_OPTIONS.map((s) => `<option value="${s}"${s === a.status ? ' selected' : ''}>${s}</option>`).join('')}</select>
                  <button class="btn sm ghost" type="submit">Set</button>
                </form>
                <form method="post" action="/app/agents/${esc(a.id)}/bind" class="actions" style="margin:.3rem 0 0">
                  <input name="clientId" placeholder="OAuth client id" value="${esc(a.oauthClientId ?? '')}">
                  <button class="btn sm ghost" type="submit">Bind</button>
                </form>
              </td>`
            : ''
          return `<tr><td><strong>${esc(a.displayName)}</strong></td><td>${esc(a.kind)}</td>
            <td><span class="badge ${a.status === 'active' ? 'amber' : ''}">${esc(a.status)}</span></td>
            <td class="muted">${esc(a.oauthClientId ?? '—')}</td>${manage}</tr>`
        })
        .join('')
    : `<tr><td colspan="${data.canManage ? 5 : 4}" class="empty">No agents registered.</td></tr>`
  return chrome(
    'Agents',
    data.actor,
    `<h1>Agent registry</h1><table><thead><tr><th>Name</th><th>Kind</th><th>Status</th><th>OAuth client</th>${actionsCol}</tr></thead><tbody>${rows}</tbody></table>`,
  )
}

export function auditList(data: { entries: AuditLog[]; actor: Actor }): string {
  const rows = data.entries.length
    ? data.entries
        .map(
          (e) =>
            `<tr><td class="muted">${esc(e.createdAt)}</td><td><span class="key">${esc(e.action)}</span></td>
            <td>${esc(e.targetType)}</td><td class="muted">${esc(e.principalId)}</td>
            <td class="muted">${e.clientInfo ? esc(`${e.clientInfo.name} ${e.clientInfo.version}`) : '—'}</td></tr>`,
        )
        .join('')
    : '<tr><td colspan="5" class="empty">No audit entries.</td></tr>'
  return chrome(
    'Audit log',
    data.actor,
    `<h1>Audit log</h1><p class="muted">Append-only; attributed to the trusted principal.</p>
    <table><thead><tr><th>When</th><th>Action</th><th>Target</th><th>Principal</th><th>Client (reported)</th></tr></thead><tbody>${rows}</tbody></table>`,
  )
}

export function messagePage(actor: Actor | null, title: string, message: string): string {
  return chrome(title, actor, `<h1>${esc(title)}</h1><p class="muted">${esc(message)}</p>`)
}
