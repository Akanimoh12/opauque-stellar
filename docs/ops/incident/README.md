# Incident Communication Templates

Pre-written communication templates for security or outage incidents affecting
Opaque. These exist so that, mid-incident, nobody is drafting a user-facing
message from scratch while also trying to fix the problem — and so that the
language around a **funds-related** incident is decided calmly in advance, not
improvised under pressure.

These templates are the *communications* layer. For vulnerability reporting and
the technical response process, see [`SECURITY.md`](../../../SECURITY.md) and
[`docs/testnet-slos.md`](../../testnet-slos.md) (off-chain service health
objectives that often precede or accompany an incident).

## Severity levels

| Severity | Definition | Examples | Initial notice target |
|---|---|---|---|
| **P0 — Critical** | User funds are at risk, being lost, or a core contract is unusable | Exploited contract (registry, announcer, privacy pool, verifiers), scanner producing wrong stealth matches, a verifier accepting invalid proofs, private key exposure | Within 30 minutes of confirmation |
| **P1 — Major** | Core functionality degraded but funds are not directly at risk | RPC/Horizon outage, proof verification failures, registration or send failing network-wide, relayer/publisher outage past its `docs/testnet-slos.md` objective | Within 2 hours of confirmation |
| **P2 — Minor** | Partial or cosmetic degradation, workaround available | Slow scans, one RPC fallback down, UI bug with a workaround | Status page update; no forced notice |
| **P3 — Informational** | No user impact, scheduled or already resolved | Planned maintenance, resolved transient blip | Optional, pre-announced |

## Files in this directory

| Template | Use when |
|---|---|
| [`initial-notice.md`](initial-notice.md) | The first message to users/integrators after an incident is confirmed (P0/P1) |
| [`status-update.md`](status-update.md) | Periodic updates while an incident is ongoing |
| [`resolution-postmortem.md`](resolution-postmortem.md) | Closing message once resolved, plus the internal/public postmortem structure |
| [`integrator-api-status.md`](integrator-api-status.md) | Machine-readable-friendly status update for integrators consuming Opaque's RPC/contracts programmatically |

## Ground rules for funds-related incidents

1. **Never speculate on cause or scope before it's confirmed.** State only what
   is verified. "We are investigating reports of X" is fine; "this was caused by
   Y" is not, until it's true.
2. **Never tell users to move funds, sign anything, or connect a wallet** as part
   of an incident response message, even to "fix" the problem. That instruction
   pattern is indistinguishable from a phishing attempt. Recovery actions are
   initiated by the team via audited multisig processes (see
   [`docs/MULTISIG_ADMIN.md`](../../MULTISIG_ADMIN.md)), not by asking users to act.
3. **State what users should NOT do** as prominently as what's happening (e.g.
   "do not send funds to any stealth address generated in the last N hours until
   this notice is lifted, and do not deposit into the privacy pool").
4. **Timestamps in UTC, always**, alongside the user's local time if the channel
   supports it.
5. **One canonical source of truth per incident** — a status page entry or pinned
   post that every other channel (Discord, Twitter/X, email) links back to,
   rather than independently drifting messages.
6. **Every notice gets a follow-up**, even "no update, still investigating."
   Silence during a funds incident is read as something being hidden.
7. **Legal/compliance review** is required before publishing anything that
   quantifies user impact (dollar amounts, number of accounts affected).

## Disclosure timeline (target)

| Stage | Target time from confirmation | Owner |
|---|---|---|
| Internal declare + severity assignment | Immediate | On-call / incident owner |
| Initial user-facing notice (P0/P1) | ≤ 30 min (P0) / ≤ 2h (P1) | Comms lead + incident owner |
| First status update | ≤ 2h after initial notice | Comms lead |
| Subsequent status updates | Every 2–4h while unresolved, or on material change | Comms lead |
| Resolution notice | Immediately once fix is verified | Comms lead + incident owner |
| Public postmortem (P0) | Within 5 business days | Incident owner |
| Public postmortem (P1) | Within 10 business days | Incident owner |

## Tabletop exercise

Run a tabletop walkthrough of this process **at least annually**, using a
fictional P0 scenario (e.g. "Groth16 verifier accepting invalid proofs" or
"stealth-announcer emitting malformed events"). The exercise should:

- Walk through severity assignment, escalation, and the disclosure timeline above.
- Have a comms lead actually draft the initial notice using these templates,
  timeboxed to 30 minutes, and get it reviewed.
- Confirm reporting/escalation contacts in [`SECURITY.md`](../../../SECURITY.md)
  are current.
- Record outcomes and any template/process changes as a dated entry appended to
  [`tabletop-log.md`](tabletop-log.md).

Ownership of scheduling the annual exercise should sit with whoever currently
owns incident response per the project's operational docs; record that owner
in the tabletop log entry itself so it stays current without needing to be
hardcoded here.
