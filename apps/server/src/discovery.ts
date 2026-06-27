import type { ServerContext } from './context.js'

/** Machine-readable service discovery document (served at /.well-known/rooster). */
export function discoveryDocument(ctx: ServerContext) {
  const base = ctx.config.baseUrl
  return {
    name: 'rooster',
    description: 'A project manager for software agents.',
    version: '0.1.0',
    mcp: { endpoint: `${base}/mcp`, transport: 'streamable-http' },
    oauth: {
      authorizationServerMetadata: `${base}/api/auth/.well-known/oauth-authorization-server`,
      protectedResourceMetadata: `${base}/api/auth/.well-known/oauth-protected-resource`,
      dynamicClientRegistration: true,
      pkce: 'required',
    },
    onboard: {
      // Preferred: bootstrap a workspace over MCP with the `create_tenant` tool
      // (open, account-anchored). The HTTP endpoint below is the
      // self-host alternative, optionally gated by a signup token.
      mcpTool: 'create_tenant',
      endpoint: `${base}/onboard`,
      method: 'POST',
      gated: 'signup-token',
    },
    docs: `${base}/llms.txt`,
  }
}

/** Plain-text onboarding guide for agents (served at /llms.txt). */
export function llmsText(ctx: ServerContext): string {
  const base = ctx.config.baseUrl
  return `# Rooster — a project manager for software agents

You are an AI agent. Rooster lets you track work (orgs -> teams -> projects ->
tickets) and is designed so agents are first-class: you authenticate, carry a
stable identity, and every action you take is audited.

## Get started: sign in once, then create_tenant
1. Connect over OAuth (below). Your human signs in in the browser (creating an
   account the first time), which anchors the workspace to their account — the
   only manual step.
2. Call \`create_tenant\` with a workspace name and your first project's name +
   key (the uppercase ticket prefix, e.g. "ROOST"). That's it — start filing
   tickets.

Until you have a workspace your token resolves to a *provisional* identity that
exposes only \`whoami\` and \`create_tenant\`. After \`create_tenant\`, the full
toolset below is available, and reconnecting later from any MCP client (Claude,
opencode, …) lands you back in the same workspace — it's tied to the account,
not the client.

## Connect (OAuth 2.1)
1. Discover the authorization server: ${base}/api/auth/.well-known/oauth-authorization-server
2. Register a client via Dynamic Client Registration (RFC 7591). PKCE is REQUIRED.
3. Complete the authorization code + PKCE flow to obtain an access token.
4. Connect your MCP client (Streamable HTTP) to: ${base}/mcp
   Send the token as: Authorization: Bearer <access_token>

## What you can do
- whoami — confirm your trusted identity, org and scopes.
- create_tenant — (when you have no workspace yet) create your org + first
  project, then start filing tickets.
- join_tenant — (when you have no workspace yet) join an existing workspace with
  an invite code a teammate shared with you.
- create_team / create_project — grow your workspace with more teams + projects.
- list_teams / list_projects / list_tickets / get_ticket — read the board.
  list_tickets accepts optional \`status\` and \`assigneeId\` filters.
- create_ticket — open work. ALWAYS add relevant \`labels\` (tags) so related
  tickets are easy to find, set \`parentId\` for subtasks, set \`dueDate\`
  (ISO-8601) when there's a deadline, and set \`estimate\` (complexity points —
  see "Estimating work" below) when you can size it.
- update_ticket / change_status / assign_ticket / comment — manage work.
- my_tickets — list tickets assigned to you. find_by_label — by tag.
  search_tickets — free-text search over titles + descriptions.
- list_subtasks — list a ticket's children.
- crow — wake/notify a ticket's assignee.
- invite_member — invite a human teammate by email (admin). create_invite —
  mint a shareable join code (admin). read_audit — read the audit log (admin).

## Self-hosting note
A non-interactive HTTP bootstrap also exists (POST ${base}/onboard with
{ signupToken?, org, founder, team, project, agent? }), optionally gated by a
signup token. Most agents should prefer the \`create_tenant\` tool above.

## Estimating work
A ticket's \`estimate\` is a **complexity point** on a fixed Fibonacci scale:
one of 1, 2, 3, 5, 8, 13 (anything else is rejected). Because agents have no
shared velocity baseline, the scale is anchored to objective signals so any
agent sizes similar work the same way. Score **complexity + uncertainty, not
wall-clock time**:
- 1  — trivial one-file mechanical change; existing pattern; no design choices.
- 2  — small; a few files in one layer; clear approach; no new abstractions.
- 3  — moderate; crosses a few layers following a documented pattern; a few edge cases.
- 5  — sizable; new component or cross-cutting change with some unknowns.
- 8  — large; new subsystem or many modules; real design work; broad test surface.
- 13 — epic or too uncertain to size — split it into subtasks instead.
The scale is ordinal (gaps widen on purpose); round UP when between two values.

## Scopes
Tokens carry scopes that map to permissions (e.g. ticket:read, ticket:write).
You only get what you were granted; the server enforces both your role and scope.

## Resources
- ticket://{key}   e.g. ticket://ROOST-42
- project://{id}
`
}

/** Minimal HTML landing page (served at /). */
export function landingHtml(ctx: ServerContext): string {
  const base = ctx.config.baseUrl
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Rooster</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:42rem;margin:4rem auto;padding:0 1rem;color:#1a1a1a}code{background:#f4f4f5;padding:.1em .35em;border-radius:4px}a{color:#b45309}.cta{display:inline-block;background:#d97706;color:#fff;padding:.6rem 1.05rem;border-radius:9px;font-weight:600;text-decoration:none}.cta:hover{background:#b45309}</style>
</head><body>
<h1>🐓 Rooster</h1>
<p>A project manager for software agents. Humans and AI agents share one domain
(orgs → teams → projects → tickets); agents are first-class principals.</p>
<p><a class="cta" href="${base}/app">Sign in to the dashboard →</a></p>
<ul>
<li><strong>Humans:</strong> <a href="${base}/app/login">sign in</a> to the dashboard at <code>${base}/app</code>.</li>
<li><strong>Agents:</strong> read <a href="${base}/llms.txt"><code>/llms.txt</code></a> to connect over MCP.</li>
<li>Service discovery: <a href="${base}/.well-known/rooster"><code>/.well-known/rooster</code></a></li>
<li>MCP endpoint: <code>${base}/mcp</code></li>
</ul>
</body></html>`
}
