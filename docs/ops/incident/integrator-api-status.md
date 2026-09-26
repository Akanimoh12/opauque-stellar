# Template: Integrator / API Status Update

**Use when:** an incident affects programmatic consumers of Opaque's Soroban
contracts, RPC endpoints, relayer gateway, reputation publisher, or deployment
manifest — not just the wallet UI. Post this in addition to (not instead of)
the user-facing templates. Integrators want structured, stable fields they can
parse or watch for; keep the shape of this template consistent between
incidents.

---

## Fill-in template

```
Component: <e.g. "stealth-announcer contract" | "privacy pool contract" |
            "Soroban RPC (primary)" | "Horizon (primary)" | "relayer gateway"
            | "reputation publisher" | "deployments/v1/testnet.json manifest">
Network: <testnet | futurenet | mainnet | local>
Status: <operational | degraded_performance | partial_outage | major_outage
         | under_maintenance>
Severity: <P0 | P1 | P2 | P3>
Incident started: <UTC timestamp>
This update: <UTC timestamp>

Affected contract IDs / endpoints:
- <contract ID(s) from deployments/v1/<network>.json, or RPC/Horizon/relayer URL(s)>

Observed behavior:
- <e.g. "getTransaction polling times out after ~60s" or "announce() calls
  reverting with <error>" — be specific enough that an integrator can match
  it against their own logs.>

Recommended integrator action:
- <e.g. "Fail over to your configured VITE_STELLAR_RPC_FALLBACK_URLS
  equivalent" or "Pause automated sends; queued sends will not be lost.">
- <Never recommend an action that involves moving funds or re-signing
  anything outside normal application flow.>

Not recommended:
- <e.g. "Do not retry failed announce() calls in a tight loop; this adds
  load during an active incident.">

Next update by: <UTC timestamp>
Machine-readable status page: <link, if available>
```

---

## Notes

- Cross-reference the exact contract or endpoint against
  [`deployments/README.md`](../../../deployments/README.md) and the relevant
  network's manifest (`deployments/v1/<network>.json`) so integrators can
  verify they're looking at the same deployment.
- If the incident stems from an off-chain service falling outside its
  objective, link the specific service and objective from
  [`docs/testnet-slos.md`](../../testnet-slos.md) rather than re-describing it.
- Keep the `Status` field values stable release-over-release
  (`operational`, `degraded_performance`, `partial_outage`, `major_outage`,
  `under_maintenance`) so integrators can key automation off them.
