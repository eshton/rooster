import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { registerProvisioningTools, registerTools } from '@rooster/mcp'
import { describe, expect, it } from 'vitest'

/**
 * Every tool name the MCP server registers, across the provisional (orgless
 * bootstrap) and full toolsets. Registration only declares tool metadata — it
 * never calls the services/actor — so we can collect the names with a recorder
 * stub and no database.
 */
function registeredToolNames(): Set<string> {
  const names = new Set<string>()
  const recorder = {
    registerTool: (name: string) => names.add(name),
    registerResource: () => {},
  } as unknown as Parameters<typeof registerTools>[0]
  registerTools(recorder, { services: {} as never, actor: {} as never })
  registerProvisioningTools(recorder, { services: {} as never, provisional: {} as never })
  return names
}

const DOCS_REFERENCE = fileURLToPath(
  new URL('../../docs/src/content/docs/reference/mcp-tools.md', import.meta.url),
)

/**
 * Tool names documented in the reference tables. Each tool row leads with a
 * backticked name in its first cell (`| \`tool\` | scope | … |`). The scope
 * table is excluded automatically — its first cell holds `scope:tokens` whose
 * colon falls outside the `[a-z_]+` match.
 */
function documentedToolNames(md: string): Set<string> {
  const names = new Set<string>()
  for (const line of md.split('\n')) {
    const m = line.match(/^\|\s*`([a-z_]+)`\s*\|/)
    if (m) names.add(m[1])
  }
  return names
}

describe('docs/reference/mcp-tools stays in sync with the MCP server', () => {
  const registered = registeredToolNames()
  const documented = documentedToolNames(readFileSync(DOCS_REFERENCE, 'utf8'))

  it('documents every registered tool', () => {
    const missing = [...registered].filter((n) => !documented.has(n)).sort()
    expect(missing, `undocumented MCP tools: ${missing.join(', ') || '(none)'}`).toEqual([])
  })

  it('does not list tools that no longer exist', () => {
    const stale = [...documented].filter((n) => !registered.has(n)).sort()
    expect(stale, `stale tool rows in the docs: ${stale.join(', ') || '(none)'}`).toEqual([])
  })
})
