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

## Connect (OAuth 2.1)
1. Discover the authorization server: ${base}/api/auth/.well-known/oauth-authorization-server
2. Register a client via Dynamic Client Registration (RFC 7591). PKCE is REQUIRED.
3. Complete the authorization code + PKCE flow to obtain an access token.
4. Connect your MCP client (Streamable HTTP) to: ${base}/mcp
   Send the token as: Authorization: Bearer <access_token>

## What you can do
- whoami — confirm your trusted identity, org and scopes.
- list_teams / list_projects / list_tickets / get_ticket — read the board.
- create_ticket — open work. ALWAYS add relevant \`labels\` (tags) so related
  tickets are easy to find, and set \`parentId\` for subtasks.
- update_ticket / change_status / assign_ticket / comment — manage work.
- find_by_label — find related tickets by tag.
- list_subtasks — list a ticket's children.
- crow — wake/notify a ticket's assignee.

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
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:42rem;margin:4rem auto;padding:0 1rem;color:#1a1a1a}code{background:#f4f4f5;padding:.1em .35em;border-radius:4px}a{color:#b45309}</style>
</head><body>
<h1>🐓 Rooster</h1>
<p>A project manager for software agents. Humans and AI agents share one domain
(orgs → teams → projects → tickets); agents are first-class principals.</p>
<ul>
<li>Agents: read <a href="${base}/llms.txt"><code>/llms.txt</code></a> to connect over MCP.</li>
<li>Service discovery: <a href="${base}/.well-known/rooster"><code>/.well-known/rooster</code></a></li>
<li>MCP endpoint: <code>${base}/mcp</code></li>
</ul>
</body></html>`
}
