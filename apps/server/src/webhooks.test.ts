import type { NotificationEvent } from '@rooster/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { webhookCrowNotifier } from './crow-webhook.js'
import { webhookEmailSender } from './email-webhook.js'

describe('webhookCrowNotifier', () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
    vi.restoreAllMocks()
  })

  it('is disabled when no URL is configured', () => {
    expect(webhookCrowNotifier(undefined)).toBeUndefined()
    expect(webhookCrowNotifier('')).toBeUndefined()
  })

  it('POSTs the event as JSON with the kind hoisted to `type`', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return new Response('ok', { status: 200 })
    }) as typeof fetch

    const notifier = webhookCrowNotifier('https://hook.test/crow')!
    const event: NotificationEvent = {
      kind: 'crow',
      orgId: 'org-1',
      ticketId: 'tkt-1',
      ticketKey: 'ROOST-1',
      title: 'wake me',
      byPrincipalId: 'prin-1',
      recipientIds: ['prin-2'],
      assigneeId: 'prin-2',
    }
    await notifier.notify(event)

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('https://hook.test/crow')
    expect(calls[0]?.init.method).toBe('POST')
    const headers = calls[0]?.init.headers as Record<string, string>
    expect(headers['content-type']).toBe('application/json')
    const body = JSON.parse(String(calls[0]?.init.body))
    // `type` mirrors `kind`, and the full event payload is preserved.
    expect(body).toMatchObject({
      type: 'crow',
      kind: 'crow',
      ticketKey: 'ROOST-1',
      assigneeId: 'prin-2',
    })
  })
})

describe('webhookEmailSender', () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
    vi.restoreAllMocks()
  })

  it('is disabled when no URL is configured', () => {
    expect(webhookEmailSender(undefined)).toBeUndefined()
    expect(webhookEmailSender('')).toBeUndefined()
  })

  it('POSTs the message as JSON tagged with type `email`', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return new Response('ok', { status: 200 })
    }) as typeof fetch

    const sender = webhookEmailSender('https://hook.test/email')!
    await sender.send({
      to: 'ada@acme.test',
      subject: 'Reset your Rooster password',
      text: 'link: https://x/y',
      kind: 'reset-password',
      url: 'https://x/y',
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('https://hook.test/email')
    expect(calls[0]?.init.method).toBe('POST')
    const headers = calls[0]?.init.headers as Record<string, string>
    expect(headers['content-type']).toBe('application/json')
    const body = JSON.parse(String(calls[0]?.init.body))
    expect(body).toMatchObject({
      type: 'email',
      to: 'ada@acme.test',
      subject: 'Reset your Rooster password',
      kind: 'reset-password',
    })
  })
})
