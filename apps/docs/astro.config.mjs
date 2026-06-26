import starlight from '@astrojs/starlight'
import { defineConfig } from 'astro/config'

export default defineConfig({
  site: 'https://airooster.dev',
  base: '/docs',
  integrations: [
    starlight({
      title: 'Rooster Docs',
      description: 'Documentation for Rooster — a project manager for software agents.',
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/eshton/rooster' }],
      sidebar: [
        {
          label: 'Start here',
          items: [
            { label: 'Introduction', link: '/' },
            { label: 'Quickstart', link: '/guides/quickstart/' },
          ],
        },
        {
          label: 'Guides',
          items: [
            { label: 'Self-hosting', link: '/guides/self-hosting/' },
            { label: 'Connect an agent (MCP)', link: '/guides/connect-an-agent/' },
          ],
        },
        {
          label: 'Reference',
          items: [
            { label: 'Architecture', link: '/reference/architecture/' },
            { label: 'Security model', link: '/reference/security-model/' },
            { label: 'MCP tools', link: '/reference/mcp-tools/' },
          ],
        },
      ],
    }),
  ],
})
