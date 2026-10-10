# AGENTS.md

The only binding contract in this repository. Everything under `docs/` is a descriptive
reference for the code as it exists today; it describes, it does not rule. Release notes
live in `CHANGELOG.md`, open work in `BACKLOG.md`.

## 1. What we are building

A Telegram-first control plane for Pi. You operate it from a phone.

- **Telegram is the interface.** Buttons over typed command grammars; a menu beats a
  syntax; a path is picked, never typed.
- **The daemon is the only transport leader.** `pi-telegram-daemon` owns `getUpdates` and
  the direct Bot API. Pi instances never acquire transport and followers never promote
  (`telegram.json.cluster.leader: "daemon"`). With no daemon running, Telegram is down on
  purpose.
- **Managed workers are daemon-spawned `pi --mode rpc`.** They run the same bridge
  extension a terminal Pi runs, so every Telegram surface — commands, menus, model and
  thinking pickers, streaming previews, queue controls, voice, rendering, callback
  namespaces — stays exactly one implementation. The daemon presses `/telegram connect`
  for the operator; the operator never opens a terminal.
- **The `/daemon` panel is the control surface.** It never closes itself, every nested
  layer offers the way back, lifecycle actions re-render in place, and only an explicit
  Close dismisses it.

## 2. Fork override

The previous author's design decisions are not binding on us. If a rule, convention, or
documented contract blocks a decision the owner has made, change the rule in the same
change — do not work around it and do not quietly violate it. State the change in the
report so the override is visible.

## 3. Rules we hold

1. **One leader, one bot owner.** Never introduce a second poller, a second transport
   owner, or a promotion path around the daemon.
2. **No duplicated Telegram surface.** A capability that already exists in the bridge is
   reached through the bridge, from inside the worker's Pi process. Adding a second
   implementation in the daemon is a design error.
3. **No ambient-state hacks.** Behaviour comes from explicit configuration, declared
   inputs, or durable state — never from whatever happens to be in the environment. Each
   managed worker declares its own identity (`PI_TELEGRAM_FOLLOWER_OWNER_ID`) rather than
   inheriting the launcher's. If something genuinely must be inherited, read it in one
   obvious place and say why.
4. **Stable identity.** A worker is its directory; a restart returns to the same Telegram
   Thread. Anything user-visible must keep its identity across a worker or daemon restart.
5. **Destructive actions are fenced, explicit, and observable.** They run under the
   existing cleanup/retirement fence, revalidate exact evidence at the moment of action,
   are never replayed when the outcome is unknown, and report what they did. Unattended
   deletion happens only when the owner switched it on; default is off.
6. **Fail closed.** Missing, malformed, unknown, or partial evidence means "do nothing".
   Never guess, never widen scope to keep a flow moving.
7. **Keep the tree green.** `npm run typecheck`, `npm test`, the Domain DAG validator, and
   `npm run build` must pass before a change is called done. `dist/pi-telegram` is what
   actually runs, so rebuild before any live check.

## 4. How we work

- **Finish, then report.** Complete the slice, verify it, then report. No running
  commentary, no "in progress" hand-offs.
- **Evidence over speculation.** Find the cause in code, logs, or durable state before
  proposing a fix. If an earlier diagnosis turns out wrong, say so plainly and correct it.
- **The strongest available proof.** A real run beats a mock; a log line beats an
  inference. Prefer one decisive experiment over a page of reasoning.
- **Irreversible or external actions need explicit authorization:** commit, publish, tag,
  deploy, delete user data, or drive Telegram beyond the action that was requested. When
  unsure, ask — one short question, the blocking one.
- **Report shape:** what changed, what was verified and with what evidence, what is still
  open. Name the files. Do not pad.

## 5. Repository facts

- `index.ts` is the thin package entrypoint that re-exports `lib/extension.ts`, the Pi extension entry; `bin/pi-telegram-daemon.mjs` the daemon entry.
- `lib/` holds flat domains; `lib/bridge.ts` is a declarative composition root shared by
  the Pi extension and the daemon, so domain logic belongs in its owning module and never
  in the composition root.
- `tests/*.test.ts` mirror domains; `tests/invariants.test.ts` holds architectural
  regression checks, including the composition-root shape above.
- `dist/` is the runtime artifact; `npm run build` regenerates it.
- Commands: `npm run typecheck`, `npm test`, `npm run build`, `npm run check`,
  `npm run validate`, and the Domain DAG validator under `.agents/skills/domain-dag`.

## 6. Before touching the intricate parts

The queue, durable admission, streaming preview, rendering, and workspace/fence
machinery are subtle and already tested. Read the matching `docs/` file first as
reference, then change the owning module and its mirrored tests together.
