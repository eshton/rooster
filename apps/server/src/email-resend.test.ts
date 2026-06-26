import { afterEach, describe, expect, it, vi } from 'vitest'
import { resendEmailSender } from './email-resend.js'

describe('resendEmailSender', () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
    vi.restoreAllMocks()
  })

  it('is disabled unless both API key and from-address are set', () => {
    expect(resendEmailSender(undefined, 'a@b.test')).toBeUndefined()
    expect(resendEmailSender('re_key', undefined)).toBeUndefined()
    expect(resendEmailSender('re_key', 'Rooster <no-reply@b.test>')).toBeDefined()
  })

  it('POSTs the message to the Resend API with a bearer token', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return new Response('{"id":"abc"}', { status: 200 })
    }) as typeof fetch

    const sender = resendEmailSender('re_secret', 'Rooster <no-reply@rooster.test>')!
    await sender.send({
      to: 'ada@acme.test',
      subject: 'Reset your Rooster password',
      text: 'link: https://x/y',
      kind: 'reset-password',
      url: 'https://x/y',
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('https://api.resend.com/emails')
    const headers = calls[0]?.init.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer re_secret')
    const body = JSON.parse(String(calls[0]?.init.body))
    expect(body).toMatchObject({
      from: 'Rooster <no-reply@rooster.test>',
      to: 'ada@acme.test',
      subject: 'Reset your Rooster password',
    })
  })

  it('throws when Resend rejects the request', async () => {
    globalThis.fetch = (async () =>
      new Response('domain not verified', { status: 403 })) as typeof fetch
    const sender = resendEmailSender('re_secret', 'no-reply@rooster.test')!
    await expect(
      sender.send({
        to: 'ada@acme.test',
        subject: 's',
        text: 't',
        kind: 'reset-password',
        url: 'u',
      }),
    ).rejects.toThrow(/Resend email failed \(403\)/)
  })
})
