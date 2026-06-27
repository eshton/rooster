import type { Actor, OrgMember } from '@rooster/core'
import type {
  Agent,
  Attachment,
  AuditLog,
  Comment,
  Org,
  Project,
  Team,
  Ticket,
  TicketStatus,
} from '@rooster/schema'
import { ESTIMATE_POINTS, TICKET_PRIORITIES, TICKET_STATUSES } from '@rooster/schema'

/** Escape untrusted text for safe HTML interpolation. */
export function esc(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/**
 * Render a safe subset of Markdown to HTML (ticket descriptions, comments).
 *
 * Security model: the input is escaped FIRST, then block/inline transforms only
 * *insert* tags around already-escaped text — user content is never
 * reintroduced unescaped, so there is no XSS vector (and link hrefs are
 * scheme-validated to block `javascript:`). Dependency-free and DOM-free, so it
 * runs identically on Node and the Cloudflare Worker (where DOMPurify can't).
 *
 * Supports: headings, bold, italics, inline and fenced code, links
 * (http/https/mailto/relative only), bullet and numbered lists, GFM tables,
 * blockquotes, horizontal rules and paragraphs.
 */
export function renderMarkdown(md: string): string {
  const lines = esc(md).replace(/\r\n?/g, '\n').split('\n')
  const out: string[] = []
  let i = 0
  // Indexed access is `string | undefined` (noUncheckedIndexedAccess); the
  // loop guards keep `i` in range, so default out-of-range reads to ''.
  const at = (k: number): string => lines[k] ?? ''

  const inline = (s: string): string => {
    const spans: string[] = []
    // Stash inline code so * _ ` inside it aren't treated as formatting.
    let t = s.replace(/`([^`]+)`/g, (_m, c) => `\uE000${spans.push(c) - 1}\uE000`)
    t = t
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, text, url) => {
        const u = String(url).trim()
        if (!/^(https?:\/\/|mailto:|\/|#)/i.test(u)) return text // block javascript: etc.
        return `<a href="${u}" rel="noopener noreferrer">${text}</a>`
      })
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/__([^_]+)__/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*(?!\s)([^*]+?)\*/g, '$1<em>$2</em>')
    return t.replace(/\uE000(\d+)\uE000/g, (_m, n) => `<code>${spans[Number(n)]}</code>`)
  }

  const isBlockStart = (l: string) =>
    /^\s*$/.test(l) ||
    /^\s*(#{1,6}\s|```|>\s?|[-*+]\s|\d+\.\s)/.test(l) ||
    /^\s*([-*_])(\s*\1){2,}\s*$/.test(l) ||
    /^\s*\|.*\|\s*$/.test(l)

  while (i < lines.length) {
    const line = at(i)

    if (/^\s*$/.test(line)) {
      i++
      continue
    }
    // fenced code
    if (/^\s*```/.test(line)) {
      const body: string[] = []
      i++
      while (i < lines.length && !/^\s*```/.test(at(i))) body.push(at(i++))
      i++ // closing fence
      out.push(`<pre class="md-code"><code>${body.join('\n')}</code></pre>`)
      continue
    }
    // heading
    const h = line.match(/^(#{1,6})\s+(.*)$/)
    if (h) {
      const n = (h[1] ?? '#').length
      out.push(`<h${n}>${inline((h[2] ?? '').trim())}</h${n}>`)
      i++
      continue
    }
    // horizontal rule
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push('<hr>')
      i++
      continue
    }
    // GFM table: a row of cells followed by a |---|---| separator
    if (
      /^\s*\|.*\|\s*$/.test(line) &&
      i + 1 < lines.length &&
      /^\s*\|?[\s:|-]+\|?\s*$/.test(at(i + 1)) &&
      at(i + 1).includes('-')
    ) {
      const cells = (r: string) =>
        r
          .trim()
          .replace(/^\||\|$/g, '')
          .split('|')
          .map((c) => c.trim())
      const head = cells(line)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(at(i))) rows.push(cells(at(i++)))
      const thead = `<thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead>`
      const tbody = `<tbody>${rows
        .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`)
        .join('')}</tbody>`
      out.push(`<table>${thead}${tbody}</table>`)
      continue
    }
    // blockquote
    if (/^\s*>\s?/.test(line)) {
      const body: string[] = []
      while (i < lines.length && /^\s*>\s?/.test(at(i))) body.push(at(i++).replace(/^\s*>\s?/, ''))
      out.push(`<blockquote>${inline(body.join(' '))}</blockquote>`)
      continue
    }
    // unordered list
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*[-*+]\s+/.test(at(i)))
        items.push(at(i++).replace(/^\s*[-*+]\s+/, ''))
      out.push(`<ul>${items.map((it) => `<li>${inline(it)}</li>`).join('')}</ul>`)
      continue
    }
    // ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*\d+\.\s+/.test(at(i)))
        items.push(at(i++).replace(/^\s*\d+\.\s+/, ''))
      out.push(`<ol>${items.map((it) => `<li>${inline(it)}</li>`).join('')}</ol>`)
      continue
    }
    // paragraph: gather until a blank line or the next block
    const para: string[] = []
    let l: string | undefined = line
    while (l !== undefined && !isBlockStart(l)) {
      para.push(l)
      i++
      l = at(i)
    }
    out.push(`<p>${inline(para.join(' '))}</p>`)
  }

  return out.join('\n')
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
.avatar{display:inline-flex;align-items:center;justify-content:center;width:1.5rem;height:1.5rem;border-radius:50%;background:#fde68a;color:#92400e;font-size:.68rem;font-weight:700;vertical-align:middle;margin-right:.2rem}
.codebox{display:inline-block;font-family:ui-monospace,monospace;background:#1c1917;color:#fcd34d;padding:.35rem .65rem;border-radius:8px;margin-top:.3rem;user-select:all}
.prio{display:inline-block;width:.6rem;height:.6rem;border-radius:50%;vertical-align:middle;margin-right:.35rem;background:#d4d4d8}
.prio.low{background:#93c5fd}.prio.medium{background:#fcd34d}.prio.high{background:#fb923c}.prio.urgent{background:#ef4444}
.due{font-size:.7rem;color:#92400e;background:#fef3c7;border-radius:999px;padding:.05rem .45rem}
.due.over{color:#991b1b;background:#fee2e2}
.filters{display:flex;gap:.5rem;flex-wrap:wrap;align-items:center;margin:.5rem 0 1rem}
.coop-foot{text-align:center;letter-spacing:.45rem;opacity:.4;font-size:1.05rem;padding:2.5rem 0 1.4rem;user-select:none;white-space:nowrap;overflow:hidden}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(6.5rem,1fr));gap:.7rem;margin:1.1rem 0 .5rem}
.stat{background:var(--bg);border:1px solid var(--line);border-radius:12px;padding:.85rem .6rem;text-align:center}
.stat .n{font-size:1.6rem;font-weight:800;color:var(--amber-dark);line-height:1.1}
.stat .l{font-size:.72rem;color:var(--muted);text-transform:uppercase;letter-spacing:.03em}
.switch-list{list-style:none;padding:0;margin:1rem 0;display:flex;flex-direction:column;gap:.55rem}
.switch-row{display:flex;justify-content:space-between;align-items:center;gap:1rem;background:var(--bg);border:1px solid var(--line);border-radius:12px;padding:.7rem 1rem}
.switch-row.current{border-color:var(--amber)}
.md-body{overflow-wrap:anywhere}
.md-body>:first-child{margin-top:0}.md-body>:last-child{margin-bottom:0}
.md-body h1,.md-body h2,.md-body h3,.md-body h4,.md-body h5,.md-body h6{margin:1.1rem 0 .5rem;line-height:1.3}
.md-body h1{font-size:1.25rem}.md-body h2{font-size:1.1rem}.md-body h3{font-size:1rem}
.md-body h4,.md-body h5,.md-body h6{font-size:.92rem}
.md-body p{margin:.5rem 0}
.md-body ul,.md-body ol{margin:.5rem 0;padding-left:1.4rem}.md-body li{margin:.15rem 0}
.md-body a{color:var(--amber-dark);text-decoration:underline}
.md-body code{font-family:ui-monospace,monospace;font-size:.88em;background:#f4f4f5;padding:.08em .35em;border-radius:4px}
.md-body pre.md-code{background:#1c1917;color:#e7e5e4;padding:.8rem 1rem;border-radius:10px;overflow-x:auto;margin:.6rem 0}
.md-body pre.md-code code{background:none;color:inherit;padding:0;font-size:.85rem;white-space:pre}
.md-body blockquote{margin:.6rem 0;padding:.2rem 0 .2rem .9rem;border-left:3px solid var(--line);color:var(--muted)}
.md-body hr{border:0;border-top:1px solid var(--line);margin:1rem 0}
.md-body table{margin:.6rem 0;font-size:.88rem}
.md-body th{font-weight:700;background:var(--soft)}
@media (max-width:640px){
  .grid-2{grid-template-columns:1fr !important}
  header.top{flex-direction:column;align-items:flex-start;gap:.5rem;padding:.6rem 1rem}
  header.top nav{width:100%;gap:.55rem .9rem;flex-wrap:wrap}
  table{display:block;overflow-x:auto}
}
`

function chrome(title: string, actor: Actor | null, body: string): string {
  const nav = actor
    ? `<nav>
        <a href="/app">Overview</a>
        <a href="/app/mine">My tickets</a>
        <a href="/app/search">Search</a>
        <a href="/app/members">Members</a>
        <a href="/app/agents">Agents</a>
        <a href="/app/audit">Audit</a>
        <a href="/app/switch">Switch ⇄</a>
        <span class="muted">${esc(actor.role)}</span>
        <button id="logout" class="btn" style="padding:.3rem .7rem">Sign out</button>
      </nav>`
    : ''
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<title>${esc(title)} · Rooster</title><style>${STYLES}</style></head>
<body><header class="top"><a class="brand" href="${actor ? '/app' : '/'}">🐓 Rooster</a>${nav}</header>
<div class="wrap">${body}</div>
<footer class="coop-foot" aria-hidden="true">🌾 🐓 🥚 🐤 🪺 🌾 🐓 🥚 🐤 🪺</footer>
<script>for(const el of document.querySelectorAll('.ts')){const d=new Date((el.textContent||'').trim());if(!Number.isNaN(d.getTime()))el.textContent=d.toLocaleString();}
document.getElementById('logout')?.addEventListener('click',async()=>{try{await fetch('/api/auth/sign-out',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});}finally{location.href='/app';}});</script>
</body></html>`
}

// better-auth's email endpoints take JSON, so submit the form via fetch and
// redirect on success. `next` is where to go after auth — the dashboard by
// default, or the OAuth authorize URL when resuming an MCP login.
function authScript(next: string): string {
  return `<script>
document.getElementById('auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.currentTarget;
  const res = await fetch(f.action, { method:'POST', headers:{'content-type':'application/json'},
    body: JSON.stringify(Object.fromEntries(new FormData(f))) });
  if (res.ok) { location.href = ${JSON.stringify(next)}; return; }
  const data = await res.json().catch(() => ({}));
  document.getElementById('auth-err').textContent = data.message || 'Authentication failed';
});
</script>`
}

export function loginPage(opts: {
  providers: string[]
  error?: string
  next?: string
  allowSignup?: boolean
}): string {
  const next = opts.next ?? '/app'
  const cb = encodeURIComponent(next)
  const resuming = next !== '/app'
  const allowSignup = opts.allowSignup ?? true
  const oauth = opts.providers
    .map(
      (p) =>
        `<a class="btn" style="display:block;text-align:center;margin:.4rem 0" href="/api/auth/sign-in/social?provider=${esc(p)}&callbackURL=${cb}">Continue with ${esc(p)}</a>`,
    )
    .join('')
  const signupHref = resuming ? `/signup?next=${cb}` : '/app/signup'
  const blurb = resuming
    ? 'Sign in to connect your agent to Rooster.'
    : 'Access your Rooster dashboard.'
  const footer = allowSignup
    ? `<p class="muted" style="margin-top:1rem">No account? <a href="${signupHref}">Create one</a> &middot; <a href="/app/forgot-password">Forgot password?</a></p>`
    : `<p class="muted" style="margin-top:1rem">Sign-up is invite-only here &middot; <a href="/app/forgot-password">Forgot password?</a></p>`
  return chrome(
    'Sign in',
    null,
    `<h1>Sign in</h1><p class="muted">${blurb}</p>
    <p id="auth-err" style="color:#b91c1c">${esc(opts.error ?? '')}</p>
    ${oauth}
    <form id="auth-form" class="auth" method="post" action="/api/auth/sign-in/email">
      <input name="email" type="email" placeholder="you@example.com" required>
      <input name="password" type="password" placeholder="Password" required>
      <button class="btn" type="submit" style="width:100%">Sign in</button>
    </form>
    ${footer}
    ${authScript(next)}`,
  )
}

/** Step 1 of password reset: request a reset link by email. */
export function forgotPasswordPage(opts: { sent?: boolean; error?: string } = {}): string {
  const body = opts.sent
    ? `<h1>Check your email</h1>
    <p class="muted">If an account exists for that address, we've sent a link to reset your password. 🐔</p>
    <p style="margin-top:1rem"><a class="btn" href="/app/login">Back to sign in</a></p>`
    : `<h1>Reset your password</h1>
    <p class="muted">Enter your email and we'll send you a reset link.</p>
    <p id="auth-err" style="color:#b91c1c">${esc(opts.error ?? '')}</p>
    <form id="forgot-form" class="auth" method="post" action="/api/auth/request-password-reset">
      <input name="email" type="email" placeholder="you@example.com" required>
      <button class="btn" type="submit" style="width:100%">Send reset link</button>
    </form>
    <p class="muted" style="margin-top:1rem">Remembered it? <a href="/app/login">Sign in</a>.</p>
    <script>
document.getElementById('forgot-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.currentTarget;
  const body = Object.fromEntries(new FormData(f));
  body.redirectTo = location.origin + '/app/reset-password';
  const res = await fetch(f.action, { method:'POST', headers:{'content-type':'application/json'},
    body: JSON.stringify(body) });
  if (res.ok) { location.href = '/app/forgot-password?sent=1'; return; }
  const data = await res.json().catch(() => ({}));
  document.getElementById('auth-err').textContent = data.message || 'Could not send reset link';
});
</script>`
  return chrome('Reset password', null, body)
}

/** Step 2 of password reset: set a new password using the emailed token. */
export function resetPasswordPage(opts: { token?: string; error?: string } = {}): string {
  if (!opts.token) {
    return chrome(
      'Reset password',
      null,
      `<h1>Invalid reset link</h1>
      <p class="muted">This link is missing its token or has expired.</p>
      <p style="margin-top:1rem"><a class="btn" href="/app/forgot-password">Request a new link</a></p>`,
    )
  }
  return chrome(
    'Reset password',
    null,
    `<h1>Choose a new password</h1>
    <p id="auth-err" style="color:#b91c1c">${esc(opts.error ?? '')}</p>
    <form id="reset-form" class="auth" method="post" action="/api/auth/reset-password">
      <input type="hidden" name="token" value="${esc(opts.token)}">
      <input name="newPassword" type="password" placeholder="New password (min 8 chars)" required minlength="8">
      <button class="btn" type="submit" style="width:100%">Set new password</button>
    </form>
    <script>
document.getElementById('reset-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.currentTarget;
  const res = await fetch(f.action, { method:'POST', headers:{'content-type':'application/json'},
    body: JSON.stringify(Object.fromEntries(new FormData(f))) });
  if (res.ok) { location.href = '/app/login'; return; }
  const data = await res.json().catch(() => ({}));
  document.getElementById('auth-err').textContent = data.message || 'Could not reset password';
});
</script>`,
  )
}

export function signupPage(opts: { error?: string; next?: string } = {}): string {
  const next = opts.next ?? '/app'
  const loginHref = next !== '/app' ? `/login` : '/app/login'
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
    <p class="muted" style="margin-top:1rem">Already have one? <a href="${loginHref}">Sign in</a>.</p>
    ${authScript(next)}`,
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

/** Workspace picker: every org the signed-in account belongs to. */
export function switchWorkspacePage(
  actor: Actor,
  orgs: Array<{ id: string; name: string; slug: string }>,
): string {
  const rows = orgs
    .map((o) => {
      const current = o.id === actor.orgId
      return `<li class="switch-row${current ? ' current' : ''}">
        <span>🪺 <strong>${esc(o.name)}</strong> <span class="muted">/${esc(o.slug)}</span></span>
        ${
          current
            ? '<span class="muted">current</span>'
            : `<a class="btn" href="/app/switch?org=${esc(o.id)}">Switch</a>`
        }
      </li>`
    })
    .join('')
  return chrome(
    'Switch workspace',
    actor,
    `<h1>Your workspaces</h1>
    <p class="muted">You belong to ${orgs.length} workspace${orgs.length === 1 ? '' : 's'}. Pick one to act in.</p>
    <ul class="switch-list">${rows}</ul>
    ${
      orgs.length === 1
        ? `<p class="muted" style="margin-top:1rem">Got an invite code to another workspace? Join it from
           <a href="/app/members">Members</a> once you're added, or redeem a code over MCP.</p>`
        : ''
    }`,
  )
}

export function orgOverview(data: {
  org: Org
  teams: Team[]
  projects: Project[]
  actor: Actor
  stats: { tickets: number; open: number; people: number; agents: number }
  recent: Ticket[]
  projectNames: Record<string, string>
  canCreateTeam: boolean
  canCreateProject: boolean
}): string {
  const teams = data.teams.length
    ? data.teams
        .map((t) => {
          const projects = data.projects.filter((p) => p.teamId === t.id)
          const items = projects.length
            ? projects
                .map(
                  (p) =>
                    `<div class="row"><span class="key">${esc(p.key)}</span><a href="/app/projects/${esc(p.id)}">${esc(p.name)}</a>${p.archived ? '<span class="badge">archived</span>' : ''}</div>`,
                )
                .join('')
            : '<div class="empty">🪹 No projects</div>'
          return `<div class="card"><div class="row"><strong>${esc(t.name)}</strong>${t.key ? `<span class="key">${esc(t.key)}</span>` : ''}</div><div style="margin-top:.5rem">${items}</div></div>`
        })
        .join('')
    : '<div class="empty">🪹 No teams yet.</div>'

  const stat = (n: number, label: string) =>
    `<div class="stat"><div class="n">${n}</div><div class="l">${label}</div></div>`
  const stats = `<div class="stats">
    ${stat(data.teams.length, 'Teams')}
    ${stat(data.projects.length, 'Projects')}
    ${stat(data.stats.open, 'Open tickets')}
    ${stat(data.stats.tickets, 'Total tickets')}
    ${stat(data.stats.people, 'People')}
    ${stat(data.stats.agents, 'Agents')}
  </div>`

  const recent = data.recent.length
    ? `<div class="card">${data.recent
        .map(
          (t) =>
            `<div class="row" style="padding:.35rem 0">
              <div><span class="key">${esc(t.key)}</span> <a href="/app/tickets/${esc(t.key)}">${esc(t.title)}</a>
                <span class="muted" style="font-size:.82rem">· ${esc(data.projectNames[t.projectId] ?? '')}</span></div>
              <span class="badge${t.status === 'done' ? '' : ' amber'}">${esc(STATUS_LABEL[t.status])}</span>
            </div>`,
        )
        .join('')}</div>`
    : '<div class="empty">🪹 No tickets yet — open one from a project board.</div>'

  const createTeam = data.canCreateTeam
    ? `<fieldset><legend>New team</legend>
        <form method="post" action="/app/teams" class="actions">
          <input name="key" placeholder="KEY (optional)" style="max-width:8rem;text-transform:uppercase">
          <input name="name" placeholder="Team name" required>
          <button class="btn sm" type="submit">Create team</button>
        </form></fieldset>`
    : ''
  const createProject =
    data.canCreateProject && data.teams.length
      ? `<fieldset><legend>New project</legend>
        <form method="post" action="/app/projects" class="actions">
          <select name="teamId">${data.teams.map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('')}</select>
          <input name="key" placeholder="KEY (e.g. ASA)" required minlength="3" maxlength="5" style="max-width:7rem;text-transform:uppercase" title="ticket prefix, 3–5 chars">
          <input name="name" placeholder="Project name" required>
          <button class="btn sm" type="submit">Create project</button>
        </form></fieldset>`
      : ''
  const createBlock =
    createTeam || createProject
      ? `<div class="grid-2" style="display:grid;grid-template-columns:1fr 1fr;gap:1rem">${createProject}${createTeam}</div>`
      : ''

  return chrome(
    data.org.name,
    data.actor,
    `<h1>${esc(data.org.name)}</h1><p class="muted">${esc(data.org.slug)}</p>
    ${stats}
    <h2>Recent tickets</h2>${recent}
    <h2>Teams &amp; projects</h2>${createBlock}${teams}`,
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

/** Today's date (YYYY-MM-DD) for overdue comparison. */
function today(): string {
  return new Date().toISOString().slice(0, 10)
}

function dueChip(dueDate: string | null): string {
  if (!dueDate) return ''
  const over = dueDate.slice(0, 10) < today()
  return `<span class="due${over ? ' over' : ''}">due ${esc(dueDate.slice(0, 10))}</span>`
}

function estimateChip(estimate: number | null): string {
  if (estimate == null) return ''
  return `<span class="due" title="estimate">${esc(String(estimate))} pts</span>`
}

function priorityOptions(selected: string): string {
  return TICKET_PRIORITIES.map(
    (p) => `<option value="${p}"${p === selected ? ' selected' : ''}>${p}</option>`,
  ).join('')
}

// Estimate is constrained to the canonical Fibonacci scale (see ESTIMATE_RUBRIC)
// so the form can't produce an off-scale value the service would reject.
function estimateOptions(selected: number | null): string {
  const opts = [`<option value=""${selected == null ? ' selected' : ''}>– pts</option>`]
  for (const p of ESTIMATE_POINTS) {
    opts.push(`<option value="${p}"${p === selected ? ' selected' : ''}>${p} pts</option>`)
  }
  return opts.join('')
}

export function projectBoard(data: {
  project: Project
  tickets: Ticket[]
  actor: Actor
  canWrite: boolean
  names: Record<string, string>
  status?: TicketStatus | null
}): string {
  const createForm = data.canWrite
    ? `<form method="post" action="/app/projects/${esc(data.project.id)}/tickets" class="actions">
        <input name="title" placeholder="New ticket title" required maxlength="300">
        <input name="labels" placeholder="tags, comma-separated">
        <select name="priority" title="priority">${priorityOptions('none')}</select>
        <input name="startDate" type="date" title="start date">
        <input name="dueDate" type="date" title="due date">
        <select name="estimate" title="estimate (complexity points)">${estimateOptions(null)}</select>
        <button class="btn" type="submit">Create ticket</button>
      </form>`
    : ''

  const card = (t: Ticket) => {
    const assignee = t.assigneeId
      ? `<span title="${esc(data.names[t.assigneeId] ?? t.assigneeId)}">${avatar(data.names[t.assigneeId] ?? '?')}</span>`
      : ''
    const meta =
      t.dueDate || t.estimate != null || t.assigneeId
        ? `<div class="row" style="margin-top:.35rem;align-items:center">${dueChip(t.dueDate)}${estimateChip(t.estimate)}<span>${assignee}</span></div>`
        : ''
    return `<div class="tk"><div class="row"><span class="key">${esc(t.key)}</span>${t.priority !== 'none' ? `<span class="prio ${esc(t.priority)}" title="${esc(t.priority)}"></span>` : ''}</div>
      <a href="/app/tickets/${esc(t.key)}">${esc(t.title)}</a>
      ${t.labels.length ? `<div class="tags">${t.labels.map((l) => `<span class="t">${esc(l)}</span>`).join('')}</div>` : ''}
      ${meta}</div>`
  }

  const statuses = data.status ? [data.status] : TICKET_STATUSES
  const cols = statuses
    .map((status) => {
      const inCol = data.tickets.filter((t) => t.status === status)
      const cards = inCol.length
        ? inCol.map(card).join('')
        : '<div class="empty" style="font-size:1.2rem">🪹</div>'
      return `<div class="col"><h3>${esc(STATUS_LABEL[status])} · ${inCol.length}</h3>${cards}</div>`
    })
    .join('')

  const filter = `<div class="filters"><span class="muted">Filter:</span>
    <a class="btn sm ghost" href="/app/projects/${esc(data.project.id)}">All</a>
    ${TICKET_STATUSES.map((s) => `<a class="btn sm ghost" href="/app/projects/${esc(data.project.id)}?status=${s}">${esc(STATUS_LABEL[s])}</a>`).join('')}</div>`

  return chrome(
    data.project.name,
    data.actor,
    `<p class="muted"><a href="/app">← Overview</a></p><h1><span class="key">${esc(data.project.key)}</span> ${esc(data.project.name)}</h1>
    ${data.project.description ? `<p class="muted">${esc(data.project.description)}</p>` : ''}
    ${createForm}
    ${filter}
    <div class="board">${cols}</div>`,
  )
}

export function ticketDetail(data: {
  ticket: Ticket
  comments: Comment[]
  attachments: Attachment[]
  actor: Actor
  canWrite: boolean
  allowedStatuses: readonly TicketStatus[]
  members: OrgMember[]
  names: Record<string, string>
}): string {
  const t = data.ticket
  const nameOf = (id: string) => data.names[id] ?? id
  const comments = data.comments.length
    ? data.comments
        .map(
          (c) =>
            `<div class="card"><div class="muted" style="font-size:.8rem">${avatar(nameOf(c.authorId))} ${esc(nameOf(c.authorId))} · <span class="ts">${esc(c.createdAt)}</span></div><div>${esc(c.body)}</div></div>`,
        )
        .join('')
    : '<div class="empty">🪶 No comments.</div>'

  const statusForm =
    data.canWrite && data.allowedStatuses.length
      ? `<form method="post" action="/app/tickets/${esc(t.key)}/status" class="actions">
          <select name="status">${data.allowedStatuses.map((s) => `<option value="${esc(s)}">${esc(STATUS_LABEL[s])}</option>`).join('')}</select>
          <button class="btn sm" type="submit">Move</button>
        </form>`
      : ''
  const assigneeOptions = [
    `<option value=""${t.assigneeId ? '' : ' selected'}>— unassigned —</option>`,
    ...data.members.map(
      (m) =>
        `<option value="${esc(m.principalId)}"${m.principalId === t.assigneeId ? ' selected' : ''}>${esc(m.displayName)}</option>`,
    ),
  ].join('')
  const assignForm = data.canWrite
    ? `<form method="post" action="/app/tickets/${esc(t.key)}/assign" class="actions">
        <select name="assigneeId">${assigneeOptions}</select>
        <button class="btn sm ghost" type="submit">Assign</button>
      </form>`
    : ''
  const editForm = data.canWrite
    ? `<fieldset><legend>Edit</legend>
        <form method="post" action="/app/tickets/${esc(t.key)}/update" class="actions" style="flex-direction:column;align-items:stretch">
          <input name="title" value="${esc(t.title)}" required maxlength="300">
          <textarea name="description" placeholder="Description">${esc(t.description ?? '')}</textarea>
          <div class="actions" style="margin:0">
            <select name="priority" title="priority">${priorityOptions(t.priority)}</select>
            <input name="startDate" type="date" value="${esc(t.startDate?.slice(0, 10) ?? '')}" title="start date">
            <input name="dueDate" type="date" value="${esc(t.dueDate?.slice(0, 10) ?? '')}" title="due date">
            <select name="estimate" title="estimate (complexity points)">${estimateOptions(t.estimate)}</select>
            <input name="labels" value="${esc(t.labels.join(', '))}" placeholder="tags, comma-separated">
          </div>
          <button class="btn sm" type="submit">Save changes</button>
        </form>
      </fieldset>`
    : ''
  const commentForm = data.canWrite
    ? `<form method="post" action="/app/tickets/${esc(t.key)}/comments" class="actions">
        <textarea name="body" placeholder="Add a comment" required maxlength="50000"></textarea>
        <button class="btn sm" type="submit">Comment</button>
      </form>`
    : ''
  const attachments = data.attachments.length
    ? data.attachments
        .map(
          (a) =>
            `<div class="card"><div class="row" style="align-items:center">
              <a href="${esc(a.url)}" rel="noopener noreferrer nofollow" target="_blank">🔗 ${esc(a.label ?? a.url)}</a>
              ${
                data.canWrite
                  ? `<form method="post" action="/app/tickets/${esc(t.key)}/attachments/${esc(a.id)}/remove" style="margin:0"><button class="btn sm ghost" type="submit">Remove</button></form>`
                  : ''
              }
            </div></div>`,
        )
        .join('')
    : '<div class="empty">📎 No attachments.</div>'
  const attachmentForm = data.canWrite
    ? `<form method="post" action="/app/tickets/${esc(t.key)}/attachments" class="actions">
        <input name="url" type="url" placeholder="https://… (link to a log, design, doc)" required maxlength="2000">
        <input name="label" placeholder="Label (optional)" maxlength="200">
        <button class="btn sm" type="submit">Attach link</button>
      </form>`
    : ''
  const controls = data.canWrite
    ? `<fieldset><legend>Workflow</legend>${statusForm}${assignForm}</fieldset>${editForm}`
    : ''

  return chrome(
    t.key,
    data.actor,
    `<p class="muted"><a href="/app/projects/${esc(t.projectId)}">← Board</a></p>
    <div class="row"><h1><span class="key">${esc(t.key)}</span> ${esc(t.title)}</h1></div>
    <div style="margin:.25rem 0 1rem"><span class="badge amber">${esc(STATUS_LABEL[t.status])}</span>
      <span class="badge"><span class="prio ${esc(t.priority)}"></span>${esc(t.priority)}</span>
      ${t.startDate ? `<span class="badge">starts ${esc(t.startDate.slice(0, 10))}</span>` : ''}
      ${t.dueDate ? dueChip(t.dueDate) : ''}
      ${estimateChip(t.estimate)}
      ${t.assigneeId ? `<span class="badge">${avatar(nameOf(t.assigneeId))} ${esc(nameOf(t.assigneeId))}</span>` : '<span class="badge">unassigned</span>'}</div>
    ${t.description ? `<div class="card md-body">${renderMarkdown(t.description)}</div>` : ''}
    ${t.labels.length ? `<div class="tags">${t.labels.map((l) => `<span class="t">${esc(l)}</span>`).join('')}</div>` : ''}
    ${controls}
    <h2>Attachments</h2>${attachments}${attachmentForm}
    <h2>Comments</h2>${comments}${commentForm}`,
  )
}

/** A flat ticket list (used by Search + My tickets), optionally with a search box. */
export function ticketListPage(data: {
  title: string
  tickets: Ticket[]
  actor: Actor
  query?: string
  search?: boolean
}): string {
  const searchBar = data.search
    ? `<form method="get" action="/app/search" class="actions">
        <input name="q" value="${esc(data.query ?? '')}" placeholder="Search titles + descriptions…" autofocus>
        <button class="btn sm" type="submit">Search</button>
      </form>`
    : ''
  const rows = data.tickets.length
    ? data.tickets
        .map(
          (t) =>
            `<div class="card"><div class="row">
              <div><span class="key">${esc(t.key)}</span> <a href="/app/tickets/${esc(t.key)}">${esc(t.title)}</a></div>
              <div>${t.priority !== 'none' ? `<span class="prio ${esc(t.priority)}"></span>` : ''}<span class="badge${t.status === 'done' ? '' : ' amber'}">${esc(STATUS_LABEL[t.status])}</span></div>
            </div>
            ${t.dueDate || t.labels.length ? `<div class="row" style="margin-top:.3rem;align-items:center">${dueChip(t.dueDate)}${t.labels.length ? `<div class="tags">${t.labels.map((l) => `<span class="t">${esc(l)}</span>`).join('')}</div>` : ''}</div>` : ''}</div>`,
        )
        .join('')
    : `<div class="empty">${data.query !== undefined && data.query !== '' ? '🪹 No matches.' : '🪹 Nothing here yet.'}</div>`
  return chrome(data.title, data.actor, `<h1>${esc(data.title)}</h1>${searchBar}${rows}`)
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
    : `<tr><td colspan="${data.canManage ? 5 : 4}" class="empty">🐤 No agents registered.</td></tr>`
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
            `<tr><td class="muted ts">${esc(e.createdAt)}</td><td><span class="key">${esc(e.action)}</span></td>
            <td>${esc(e.targetType)}</td><td class="muted">${esc(e.principalId)}</td>
            <td class="muted">${e.clientInfo ? esc(`${e.clientInfo.name} ${e.clientInfo.version}`) : '—'}</td></tr>`,
        )
        .join('')
    : '<tr><td colspan="5" class="empty">🐓 No audit entries.</td></tr>'
  return chrome(
    'Audit log',
    data.actor,
    `<h1>Audit log</h1><p class="muted">Append-only; attributed to the trusted principal.</p>
    <table><thead><tr><th>When</th><th>Action</th><th>Target</th><th>Principal</th><th>Client (reported)</th></tr></thead><tbody>${rows}</tbody></table>`,
  )
}

const MEMBER_ROLES = ['viewer', 'member', 'admin', 'owner'] as const
const INVITE_ROLES = ['viewer', 'member', 'admin'] as const

/** A small inline avatar (initials) for a display name. */
function avatar(name: string): string {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('')
  return `<span class="avatar">${esc(initials || '?')}</span>`
}

export function membersPage(data: {
  members: OrgMember[]
  actor: Actor
  canManage: boolean
  inviteCode?: string | null
}): string {
  const roleOpts = (selected: string, roles: readonly string[]) =>
    roles
      .map((r) => `<option value="${r}"${r === selected ? ' selected' : ''}>${r}</option>`)
      .join('')

  const rows = data.members
    .map((m) => {
      const isSelf = m.principalId === data.actor.principalId
      const roleCell =
        data.canManage && m.type === 'user' && !isSelf
          ? `<form method="post" action="/app/members/role" class="actions" style="margin:0">
              <input type="hidden" name="principalId" value="${esc(m.principalId)}">
              <select name="role">${roleOpts(m.role, MEMBER_ROLES)}</select>
              <button class="btn sm ghost" type="submit">Set</button>
            </form>`
          : `<span class="badge${m.role === 'owner' ? ' amber' : ''}">${esc(m.role)}</span>`
      return `<tr>
        <td>${avatar(m.displayName)} <strong>${esc(m.displayName)}</strong>${isSelf ? ' <span class="muted">(you)</span>' : ''}</td>
        <td class="muted">${esc(m.email ?? '—')}</td>
        <td><span class="badge">${esc(m.type)}</span></td>
        <td>${roleCell}</td>
      </tr>`
    })
    .join('')

  const manage = data.canManage
    ? `<div class="grid-2" style="display:grid;grid-template-columns:1fr 1fr;gap:1rem;margin:1rem 0">
        <fieldset><legend>Invite by email</legend>
          <form method="post" action="/app/members/invite" class="actions">
            <input name="email" type="email" placeholder="teammate@example.com" required>
            <select name="role">${roleOpts('member', INVITE_ROLES)}</select>
            <button class="btn sm" type="submit">Invite</button>
          </form>
          <p class="muted" style="font-size:.85rem;margin:.5rem 0 0">They join on first login (their account links automatically).</p>
        </fieldset>
        <fieldset><legend>Shareable join code</legend>
          <form method="post" action="/app/members/code" class="actions">
            <select name="role">${roleOpts('member', INVITE_ROLES)}</select>
            <button class="btn sm ghost" type="submit">Generate code</button>
          </form>
          ${
            data.inviteCode
              ? `<p style="margin:.5rem 0 0">Share this code — they redeem it with <span class="key">join_tenant</span>:<br><code class="codebox">${esc(data.inviteCode)}</code></p>`
              : '<p class="muted" style="font-size:.85rem;margin:.5rem 0 0">A one-time code an agent redeems to join.</p>'
          }
        </fieldset>
      </div>`
    : ''

  return chrome(
    'Members',
    data.actor,
    `<h1>Members</h1><p class="muted">People and agents with access to this workspace.</p>
    ${manage}
    <table><thead><tr><th>Name</th><th>Email</th><th>Type</th><th>Role</th></tr></thead><tbody>${rows || '<tr><td colspan="4" class="empty">🪹 No members yet.</td></tr>'}</tbody></table>`,
  )
}

export function messagePage(actor: Actor | null, title: string, message: string): string {
  return chrome(title, actor, `<h1>${esc(title)}</h1><p class="muted">${esc(message)}</p>`)
}
