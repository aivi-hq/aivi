# Integrations and documentation roadmap

Status: collecting. Rule: only features 90% of installations will want.

## Communication channels (adapters)

Candidates named by the owner: Slack, Telegram, Signal, WhatsApp, email (with
aivi getting its own mailbox). Each maps onto the shared access policy and the
session driver; the Discord module is the template.

## Documentation

- A proper docs site (GitHub Pages) generated from `docs/`.
- `docs/install.md` as the newcomer path; keep README short.

## Research wanted

For each channel: official bot API maturity, self-hosting requirements
(Signal and WhatsApp need bridges or business APIs), thread/reply model, and
whether DMs + shared channels map cleanly onto `access`.
