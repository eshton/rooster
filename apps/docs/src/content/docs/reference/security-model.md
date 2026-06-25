---
title: Security model
description: The trust boundary, the role + scope check, and the audit log.
---

Rooster is secure-first. The model fits in one line:

> **Agents need both a sufficient role and the token scope; humans are governed
> by role alone; `clientInfo` is display-only, never authorization.**

## Trusted vs. untrusted identity

- **Trusted**: the `agent_id` (a stable UUID) bound into every issued OAuth
  token at registration. This is what authorization and audit use.
- **Untrusted**: the `clientInfo {name, version}` an MCP client self-reports in
  its `initialize` request. It is captured into the audit log as a display
  snapshot and **never** used for authorization.

So an audit entry can read: *agent `<uuid>` (claude-code, reported "Claude Code
1.x") moved ROOST-42 → Done*.

## Authorization: role ∧ scope

Permissions map to a minimum membership role, and — for agents — a matching
token scope:

- A **human** passes if their effective org role meets the floor.
- An **agent** passes only if its role meets the floor **and** its token carries
  the scope. Token scopes are intersected with the agent's configured allowance,
  so a token can never exceed what its agent is permitted.

Checks live in `@rooster/core` (defense in depth), not only at the transport.

## Tenant isolation

Every repository method takes and enforces an `orgId`. A token scoped to org A
cannot read or write org B's rows — verified by tests at both the repository and
service layers.

## Enrollment & onboarding gates

- **Agent enrollment** into an existing org follows the org's policy: `token`
  (a valid enrollment token), `approval` (a human admits a suspended agent), or
  `open`.
- **Tenant self-registration** (`POST /onboard`) is gated by
  `ROOSTER_SIGNUP_TOKEN` on hosted instances (constant-time comparison), and
  open when no token is configured (self-host convenience).

## Audit log

The audit log is **append-only** — no update or delete. Every mutating service
method writes one record attributed to the trusted principal, with before/after
snapshots and the untrusted `clientInfo`.
