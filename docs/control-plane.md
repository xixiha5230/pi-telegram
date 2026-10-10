# Telegram Control Plane (`pi-telegram-daemon`)

> Descriptive reference for the current code; it describes, it does not rule.
> Binding rules live in [`../AGENTS.md`](../AGENTS.md).

## Status

**Approved design direction. Partially implemented.** This document owns the durable contract for an external `pi-telegram-daemon` control plane that can start, stop, and switch live Pi workers from Telegram. It supersedes the in-process-only assumptions of [Telegram Multi-Instance Bus](./multi-instance-bus.md) where they conflict; the bus document remains canonical for the current shipped runtime until this contract is implemented.

P0 (ownership decoupling) has landed in the extension: `cwd` no longer fences transport ownership, a cross-project session switch keeps the same live owner, and `owners.json` retains `cwd` only as a same-directory restart hint. The P1 host boundary, daemon entry, worker/route registries, snapshots, RPC channel, launch planning, control panel, and managed-worker supervisor are implemented. Managed workers currently join the existing authenticated follower bus; their updates use the bridge's existing journaled follower-forwarding path. An additional generation-fenced `leader.workerControl` envelope now routes allowlisted Pi-context operations over that bus, and the real attached receiver/leader routing path is covered by local-socket tests. A real local `pi --mode rpc` `get_state` smoke passed with extensions/network disabled. Managed workers now receive only a daemon-provisioned bot identity digest: their config store exposes no raw token and keys journals, workspace admission, queue transport stamps, and paired-user admission from that digest, while the daemon keeps the raw token for transport. A tokenless attached worker (`PI_TELEGRAM_TOKENLESS_WORKER=1`) reads the daemon-published identity instead of the shared profile token and is forced non-leading. Still incomplete: attached-worker dialog forwarding is not implemented, session/queue controls absent from `ExtensionContext` reject explicitly, and the full Telegram delivery path has not been live-smoked. Managed-worker `select`/`confirm`/`input`/`editor` dialogs do render through a bounded, generation-fenced Telegram bridge. Until those land, [architecture.md](./architecture.md#runtime-ownership) and [AGENTS.md](../AGENTS.md) remain authoritative for the runtime.

## Purpose

The current bridge is a **session-local companion**: one live Pi instance owns Telegram transport, and its owner record embeds the working directory that produced it. Supporting an operator who drives Pi entirely from Telegram requires three capabilities that the companion model cannot express safely:

1. **Start and stop Pi processes from Telegram.**
2. **Switch the served Pi instance and session without touching transport ownership.**
3. **Keep Telegram reachable while any individual Pi process or session changes.**

The control plane achieves this by separating three identities that the current owner record conflates:

- **Transport identity**: who may call `getUpdates` and the Bot API. Owned by the daemon, scoped only by bot profile.
- **Worker identity**: which live Pi process is being controlled. Owned by the process, stable across session and project changes.
- **Route identity**: which Telegram target currently reaches which worker. Mutable, daemon-fenced.

`cwd` is never part of transport ownership. Changing session or project therefore cannot invalidate, self-conflict with, or lock an operator out of Telegram.

## Non-goals

- Do not run a Pi model inside the daemon. The daemon is transport, registry, router, and supervisor only.
- Do not act as a raw remote terminal or PTY. Managed workers use Pi's native RPC mode; the daemon never injects keystrokes or scrapes ANSI output.
- Do not expose arbitrary shell execution to Telegram. The `bash` RPC command stays a local supervisor capability and is never reachable from a Telegram update.
- Do not let more than one process call `getUpdates` for one bot token.
- Do not treat a deliberate daemon kill as durable survival of in-flight Telegram effects; only accepted, durably admitted inbound work is retained.
- Do not replace Pi session files or Pi's own lifecycle. Session changes go through Pi's public RPC or extension APIs.

## Terms

- `Daemon`: The `pi-telegram-daemon` process. Owns the bot token, `getUpdates`, direct Bot API calls, the inbound journal, the worker registry, routing, and the process supervisor.
- `Managed worker`: A Pi process launched by the daemon as `pi --mode rpc`, controlled through Pi's RPC channel and (optionally) a worker extension over local IPC.
- `Attached worker`: A Pi process the operator started in a terminal, whose extension registers with a running daemon over local IPC.
- `Worker identity`: `{ workerId, pid, processBirthId, runtimeGeneration }`; stable for the life of the process.
- `Route`: `{ target, workerId, updatedAt, epoch }` where `target` is `{ chatId, threadId? }`.
- `Serve target`: A worker's current `{ cwd, sessionId }`, a mutable attribute, not an identity.
- `WorkerControlPort`: The daemon-facing abstraction that issues control commands to a worker, implemented by RPC for managed workers and by authenticated IPC for attached workers.
- `Standalone mode`: The current product shape, modeled as an **embedded daemon of one** sharing the same contracts as the external daemon.

## Topology

```text
                         ┌────────────────────────────────┐
   Telegram DM/Threads ──▶│      pi-telegram-daemon        │
                         │  bot token, allowedUserId      │
                         │  getUpdates + Bot API          │
                         │  durable inbound journal       │
                         │  worker registry + router       │
                         │  supervisor (spawn/stop)       │
                         │  Telegram UI + rendering       │
                         │  worker control + dir picker   │
                         └───────┬──────────────┬─────────┘
                   local authenticated IPC        │
              ┌─────────────────────────────┐     │
              ▼                             ▼     │
   ┌────────────────────────┐   ┌────────────────────────┐
   │ managed worker         │   │ attached worker        │
   │ pi --mode rpc (no TTY) │   │ operator TUI + extension│
   │ RPC channel + worker   │   │ IPC registration only   │
   │ extension over IPC      │   │                        │
   └────────────────────────┘   └────────────────────────┘
```

The daemon is a Node process that reuses the package's transport, journal, routing, rendering, and queue-policy modules. It does not import the Pi extension binding and does not require Pi.

## Identity Model

### Daemon identity

```text
daemon[profile] = {
  daemonId, pid, processBirthId, epoch, endpoint, startedAt
}
```

- One daemon per bot profile. `epoch` is minted at startup and fences route and binding mutations.
- The daemon acquires the same `owners.json` transport lock the extension leader uses. P0 already removed `cwd` from transport identity, so a separate daemon lease would add a mechanism without adding safety: at most one process owns transport per profile, and a second daemon fails closed on the existing contention path.
- A second daemon for the same profile fails closed with an explicit diagnostic instead of attempting election.

### Worker identity

```text
worker = {
  workerId, kind: "managed" | "attached",
  pid, processBirthId, runtimeGeneration,
  cwd, sessionId,            // mutable attributes
  state, lastSeen, protocol, capabilities
}
```

- `workerId` is minted by the daemon at registration and is stable for the process lifetime.
- `cwd` and `sessionId` are refreshed from the worker and never used as identity.
- A worker that changes session or project keeps its `workerId`, its thread target, and its route.

### Route identity

```text
route[target] = { workerId, updatedAt, epoch }
```

- A route is durable and mutable, CAS-fenced by daemon `epoch`.
- A route never encodes a session or a project. Thread targeting follows the worker, and the worker's current project is presentation.

### Invariants

- Transport ownership depends only on bot profile and daemon identity.
- Session/project change never invalidates transport ownership, route identity, or worker identity.
- A worker id is never re-used for a different process birth.
- A stale `epoch` may not publish routes, bindings, or dispatch.

## Transport Ownership

- The daemon is the permanent leader. Leader election, stale-heartbeat promotion, and follower-to-leader handoff are removed from the external topology.
- **Daemon-only leadership policy.** `telegram.json.cluster.leader: "daemon"` makes this a hard rule: Pi instances never acquire transport ownership and followers never promote, so a daemon restart cannot be raced by a Pi instance. Telegram is unavailable while no daemon runs, by design. The default `auto` preserves the historical multi-instance election.
- The daemon owns exactly one long-poll loop per profile and is the only caller of `getUpdates` and direct Bot API methods.
- Workers never hold the bot token and never call `getUpdates`. Attached workers stop polling when they register; the extension's polling start is refused while a daemon registration is live.
- **Standalone mode is the embedded daemon of one.** When no external daemon is present, the extension runs the same transport, journal, registry, and routing contracts in-process. Both shapes share one protocol so behavior and diagnostics stay aligned.

## Host Capability Baseline (P1 spike)

Read-only findings that the external-daemon phase depends on. Verify again against the pinned Pi host when implementing.

- **Headless control channel**: `pi --mode rpc` drives the agent over JSONL on stdin/stdout. It exposes `prompt`, `steer`, `follow_up`, `abort`, `clear_queue`, `new_session`, `switch_session`, `fork`, `clone`, `set_session_name`, `compact`, `set_model`, `cycle_model`, `set_thinking_level`, `get_state`, `get_session_stats`, `get_commands`, `bash`, and an event stream. No PTY or terminal is required for management.
- **Framing**: RPC mode is strict JSONL with `LF` as the only record delimiter. Clients must not use Node `readline`, which also splits on `U+2028`/`U+2029` inside JSON strings.
- **Extension interop**: user extensions still load, `get_commands` lists their commands, and `prompt` may invoke them as `/name`. Extension dialog methods (`select`, `confirm`, `input`, `editor`) become `extension_ui_request`/`extension_ui_response`; `notify`/`setStatus`/`setTitle` are fire-and-forget. `ctx.mode === "rpc"` and `ctx.hasUI === true`; TUI-only methods such as `custom()` degrade.
- **Trust**: non-interactive modes show no trust prompt and fall back to `defaultProjectTrust`; `--approve`/`-a` overrides it per run. Managed workers always start with `--approve`.
- **Shutdown**: the spike found no explicit shutdown RPC. Graceful stop therefore closes stdin and/or signals the child, and the exact behavior must be confirmed live before relying on it.
- **Existing guard audit**: the only `ctx.mode`/`hasUI` gates in this repository are in `lib/setup.ts`, where terminal pairing confirmation requires trusted UI. Managed RPC workers therefore cannot own Telegram pairing; owner configuration and pairing stay in the daemon.
- **Reusable identity primitive**: `lib/bus.ts` already provides `getTelegramProcessBirthIdentity`, so the daemon and worker can adopt process-birth identity without a new platform mechanism.

## Worker Kinds

### Managed worker

The daemon spawns and drives a headless Pi process:

```bash
pi --mode rpc --approve -n <name> [--session <id>] \
   --no-extensions -e <pi-telegram worker extension>
```

- `--mode rpc` provides a full JSONL control channel over stdin/stdout: `prompt`, `steer`, `follow_up`, `abort`, `clear_queue`, `new_session`, `switch_session`, `fork`, `clone`, `set_session_name`, `compact`, `set_model`, `cycle_model`, `set_thinking_level`, `get_state`, `get_session_stats`, `get_commands`, and event streaming.
- The daemon holds the RPC pipes, so it owns launch, liveness, event intake, and extension dialog answers.
- `--no-extensions -e <worker extension>` makes the loaded extension set explicit, so a worker never auto-loads a polling bridge.
- The worker extension supplies agent-facing Telegram capabilities (`telegram_attach`, `telegram_message`, `telegram_voice`, generative apps, sections) and implements the IPC control and queue ports.

### Attached worker

The operator starts `pi` in a terminal and runs `/telegram-connect`. The extension:

- registers over authenticated local IPC instead of acquiring transport ownership;
- stops any local polling and reports worker state, project, session, and queue depth;
- implements `WorkerControlPort` over IPC by calling its own `ctx` APIs;
- routes Telegram-originated dialogs to the daemon instead of waiting for terminal input.

### WorkerControlPort

One daemon-facing contract with two adapters:

| Operation | Managed adapter | Attached adapter |
| --- | --- | --- |
| `prompt` / `steer` / `follow_up` | RPC command | IPC request to extension, which calls the Pi user-message API |
| `abort` / `clear_queue` | RPC command | IPC request |
| `compact` | RPC command | IPC request |
| `set_model` / `set_thinking_level` | RPC command | IPC request |
| `new_session` / `switch_session` / `fork` / `clone` | RPC command | IPC request |
| `get_state` | RPC command | IPC request |
| dialog request/response | RPC `extension_ui_request` | IPC UI bridge |

Daemon routing, rendering, and command code is identical for both; only the adapter differs.

## Worker Lifecycle

### Managed worker = supervised follower

A managed worker is a `pi --mode rpc` process this daemon spawned, running the **same
bridge extension a terminal Pi runs**. The daemon presses `/telegram-connect` for the
operator once the worker's RPC channel answers, so the operator never opens a terminal;
the worker then registers with the leader as an ordinary follower and the leader
provisions its Thread exactly as it does for any follower.

**Resume after a daemon restart.** The persisted snapshot lists exactly the workers
that were live, so the daemon relaunches each of them by directory on startup, carrying
the worker's own recorded `sessionId`. Resuming that session re-keys the same Telegram
Thread (the Worker keeps its tab) and never picks up another instance's session for the
same directory. When Pi cannot find that session — typically a worker that was spawned
and never received a message, so no session file was written — the supervisor starts a
fresh session **once** instead of crash-looping. A worker the operator stopped is absent
from the snapshot and is never resurrected.

Restart attempts accumulate across respawns, so a worker that cannot start stays stopped
after the bounded attempts instead of looping.

Consequences that keep this honest:

- **No Telegram surface is reimplemented in the daemon.** Commands, menus, model and
  thinking pickers, streaming previews, queue controls, voice replies, rendering, and
  every callback namespace remain the existing bridge implementation, now running inside
  the worker. The daemon adds no second copy that could drift.
- The control plane lists only workers the daemon spawned: a follower whose pid is in
  the supervisor's managed set. An operator-started terminal Pi keeps its own Thread and
  stays outside the roster, routes, and persisted snapshot.
- Worker identity for persistence is the directory-derived spec name, so a restart of the
  daemon or of the worker keeps pointing at the same project.

### Inactive Thread cleanup

The daemon thread has no Pi Settings menu, so the leader's cleanup surface lives in the
panel: a switch for deleting a tab on graceful quit (`threads.automaticCleanup`) and a
**proof-only review** of provably inactive Workspace Threads.

Review is proof-only: it captures fresh protection evidence, plans candidates only when
durable inactivity exists and live-owner, accepted-work, and delivery authority are all
`clear` with no competing reservation, provision, or in-flight cleanup, and retains one
canonical 128-bit work set. A review never deletes, and a missing or unknown evidence
path returns no candidates rather than deleting speculatively.

Deletion is direct and proof-gated rather than fence-owned. The admission fence, permit,
and retained-work-set machinery could not resolve an interrupted deletion, and a leftover
fence blocked every profile admission — including the daemon's own startup — so the janitor
does not use it. Instead every pass re-plans eligibility from fresh evidence and deletes
exactly those candidates:

- `🗑 Delete reviewed` on the operator's tap, or the daemon's unattended janitor every five
  minutes when the operator has switched it on.
- The unattended janitor refuses anything inactive for less than 24 hours, and reports each
  pass (counts, blockers, deletions) into the daemon Thread.
- A deletion Telegram rejects with `TOPIC_ID_INVALID` means the topic is already gone
  server-side — a client-side ghost tab — so the local binding is cleared instead of being
  reported as a failure forever.
- On startup the daemon sweeps a legacy cleanup fence (with a timestamped backup) before
  acquiring transport, so a stuck fence can never brick the daemon again.
- The leader's periodic health tick also records dormancy: a Workspace binding whose recorded
  owner is neither the leader nor a registered follower, and whose target competes with no
  reservation, provision, or cleanup, is marked inactive from the moment that owner was last
  observed. Recording dormancy deletes nothing; it is what makes an orphaned tab visible to the
  proof-based cleanup, including tabs first seen while the cleanup switch was off. A returning
  owner clears it again on registration.

### RPC host

The daemon holds each managed worker's RPC channel and projects it with
`lib/rpc-host.ts` for **supervision**, not for rendering: readiness, drain, health, and
a live state (streaming, compacting, queued work, model, session) reduced from
`get_state` plus the worker's own transition events. Telegram answers still come from the
worker's own bridge, so this channel never formats user-facing output. Only transition events move the projection — token deltas and tool output
are renderer concerns — and an unchanged refresh publishes nothing, so state-driven
surfaces such as Thread titles stay debounced against Telegram's topic-title limits.

The control plane lists **only workers this daemon spawned** (`managed`). Attached
followers — operator-started Pi instances that registered over the bus — keep their
own Telegram thread and stay outside the daemon's roster, routes, and persistence.


### Launch

A managed worker is launched from an **absolute directory**: either the inline
picker (the default phone flow) or `/workers start </abs/path>`. The directory
must resolve through `realpath` and exist, which blocks typos without a separate
catalog file to maintain.

- The spawned command is `pi --mode rpc --approve`. Extensions stay enabled, so the
  worker loads the operator's normal provider packages and user configuration.
- Every launch declares `PI_TELEGRAM_DAEMON_WORKER=1`, so the worker is permanently
  non-leading and can never race or succeed the daemon for transport ownership.
- The daemon strips Pi session-descriptor variables (`PI_SESSION_ID`,
  `PI_SESSION_FILE`, `PI_PROVIDER`, `PI_MODEL`, `PI_REASONING_LEVEL`) before spawn.
  Those describe the *daemon's* session, not the worker's, so a managed worker always
  starts a clean session and resolves its own model, provider, and auth.
- `--approve` only settles Pi project trust for non-interactive startup.
- The worker name is derived from the directory basename; a second worker for the
  same name is rejected while the first runs.
- Every launch declares its own manual-follower identity
  (`PI_TELEGRAM_FOLLOWER_OWNER_ID=worker:<directory>`). Without it every worker would
  inherit the daemon's parent-derived identity, so the leader would treat each new
  worker as a successor of the others and hand the same Thread between them.
- URL placeholders, environment, and model selection come from the operator's own
  configuration (`settings.json`, `auth.json`, environment), never from Telegram.

### Run And Autostart

The daemon is a separate process the operator starts once per profile.

- `pi-telegram-daemon --cwd <abs-dir>` runs it in the foreground; it owns transport,
  `getUpdates`, the direct Bot API, the inbound journal, the registry, routing, and the
  supervisor, and shuts down gracefully on `SIGINT`/`SIGTERM`.
- From Pi, `/telegram-daemon start|stop|status` starts it detached (so it survives the
  Pi process), stops it, or reports truth from the durable transport-owner and daemon
  snapshots. `/telegram-daemon mode auto|daemon` switches transport leadership between
  the standalone embedded leader and the daemon-only policy.
- `/telegram-daemon install|uninstall` installs or removes a login autostart service:
  a macOS launchd LaunchAgent or a Linux systemd user unit with keep-alive/restart.
  Installation is an explicit, reversible operator action; nothing installs silently,
  and an unsupported platform fails closed.
- The daemon must run as the same user as the Pi instances so it shares `telegram.json`,
  `owners.json`, and the bus sockets. A custom `PI_CODING_AGENT_DIR` is written into the
  installed unit.

### Health

A worker is healthy when the process is alive, the process birth identity matches, the registration generation is current, and control probes settle within budget. Health is not inferred from heartbeat silence alone.

### Graceful stop

Default stop is **graceful drain**:

1. Publish a stop intent; refuse new routed work for that worker.
2. Wait for `get_state` to report idle (no streaming, no pending messages) within a bounded window.
3. If the window expires, `abort`, then wait again briefly.
4. Close the RPC stdin / send the worker shutdown request.
5. Escalate to `SIGTERM`, then `SIGKILL`, recording each phase.
6. Retire the route only after the worker is confirmed gone; retain routed-but-unacknowledged work per the admission contract.

### Restart

`on-failure` restarts only after an unexpected exit, reusing the worker's directory and remembered serve target. Restart never auto-replays an already-accepted prompt; it resumes the retained session and re-publishes the route.

## Telegram Control Surface

The daemon thread exposes **exactly one command**. Everything the operator does there
is a button, and the panel **never closes itself**: only the explicit ✖️ Close dismisses
it, every nested layer offers the way back, and a lifecycle action re-renders the roster
in place instead of replacing the panel with a result notice.

| Layer | Behavior |
| --- | --- |
| `/daemon` | Opens the panel: 👷 Workers, 📁 New worker…, ℹ️ Status, 🧹 Threads, ✖️ Close |
| 👷 Workers | Roster: one `📍 <project>` row per worker plus its `🛑 Stop` / `♻️ Restart` row, then 📁 New worker… / ↩️ Menu |
| 📍 locate | Posts a marker into that worker's own Thread so the operator can find the tab |
| 🛑 Stop | Confirmation layer (`🛑 Stop` / `↩️ Back`), then stops the worker and returns to the roster |
| ♻️ Restart | Relaunches the same project and returns to the roster |
| 📁 New worker… | Inline directory picker (⬆️ up / 📁 enter / ✅ start here / ↩️ Back) |
| ℹ️ Status | Profile, transport leader, worker/route counts, daemon epoch, and ↩️ Menu |
| 🧹 Threads | Inactive-Thread cleanup: a **proof-only** review, `🗑 Delete reviewed`, the delete-on-quit switch, the unattended janitor switch, then ↩️ Menu |
| ✖️ Close | The only action that dismisses the panel message |

The daemon thread also accepts `/attach <workerId>` and `/detach`. Attaching re-homes
that worker's Telegram Thread to the current thread so inbound delivery follows the
attachment; detaching moves it back to the Thread it served before. Both are
epoch-fenced, verify the worker, chat, and Thread before acting, and fail closed when
the move is not eligible. Any other `/command` in a daemon-owned thread is not handled
by the daemon: it falls through to normal routing, and Pi's own commands stay available
in each worker's thread. Worker-owned threads always pass through to their worker.

Session/project switching is dispatched only after the originating update is durably
settled, and only through `WorkerControlPort`.

A Pi-owned bridge (standalone topology, no daemon) still registers its leader-gated
roster; `/attach`, `/detach`, and managed-worker lifecycle require the daemon.

## Thread Model

**Thread = worker.** One Telegram thread per live worker, with a stable `threadId` and slot.

- The thread's **title and binding are projected from the worker's current project (`cwd`)** using the existing display modes (`letters`, `names`, `directory-snake`, `directory-title`, `state`). `state` prefixes the directory label with the worker's live marker (`⏳` busy, `🟢` ready), so a tab shows at a glance whether its Pi is working.
- **Cross-project switch keeps the same tab and re-aligns it** to the new project: the `threadId` and slot are preserved, the project binding and title are updated, and the previous project binding becomes a dormant restore hint.
- Concurrent workers in one project receive the existing deterministic suffix disambiguation.
- A dormant binding never authorizes routing; only a live, registered worker route does.
- **Operator attach** (`/attach`) re-homes a worker's Thread to another topic in the
  same chat; the worker's directory identity is unchanged and the previous Thread is
  retained for `/detach`. Delivery follows the worker's current Thread, so an
  attachment is a real binding move, never a projection-only route edit.
- The daemon owns all thread creation, title edits, and cleanup. Workers never call topic APIs directly.

## Session And Project Switching

- Switching is an **in-band transition of a mutable attribute**, not a transport event.
- Ordering: update durably admitted → update settled → daemon issues the control command → worker changes session/project → worker reports the new `{ cwd, sessionId }` → daemon re-aligns the thread and resumes routing.
- The daemon never writes Pi session files. Managed workers use the RPC session commands; attached workers use their own `ctx` APIs through IPC.
- A switch is refused while the worker is not idle for session-replacement semantics that require it, using the same explicit idle/pending gates the product already documents.
- Because transport ownership is daemon-scoped, a switch cannot produce the current "live owner with an unreachable bus endpoint" class of lockout.

## Queue Model

**The worker's Pi runtime queue is the execution truth.** The daemon is a controller and read-only projector, not a second queue owner.

| Product concept | Pi native equivalent | Handling |
| --- | --- | --- |
| Normal lane | follow-up queue | Delivered when the agent stops |
| Priority lane | steering queue | Delivered after current tool calls, before the next model call |
| `/next` | `steer` (with `abort` when needed) | Direct mapping |
| Skip | queue removal | `clear_queue`, then conditionally re-deliver retained text |
| Keep | none | Daemon-side policy over the projection |
| `+N` count | `pendingMessageCount` + projection | Display only |
| `set_steering_mode` / `set_follow_up_mode` | native | Rendered as worker/profile setting |

Accepted degradations:

- Cross-lane position preservation is not expressible; a moved prompt is enqueued at the destination tail.
- Keep/Skip cannot guarantee position preservation because Pi's queue does not expose stable per-item identity; Skip is best-effort removal before delivery.
- The `+N` count is a projection, never an independent authority.
- Reaction-driven priority maps to steering; reaction-driven skip maps to removal.

The daemon reconciles its projection from `get_state`, `clear_queue` results, and the worker event stream, and never dispatches a prompt it believes is already queued.

## Delivery And Rendering Ownership

- **Managed worker**: the worker runs the same bridge extension a terminal Pi runs, so its own bridge owns previews, activity, final rendering, files, voice, buttons, and queue views, and reaches Telegram through the daemon-owned transport (follower `callApi` proxy) and the daemon's forwarded updates. The daemon never re-renders worker output.
- **Attached worker**: identical. The extension delivers through the same follower bus, preserving one rendering implementation across both worker kinds.
- The daemon holds the RPC channel only for supervision (state projection, drain, dialogs, control), never for user-facing rendering, so there is no second surface that could drift.

## Durable Admission And Settlement

- The daemon owns the **inbound journal** because it owns `getUpdates`: validate and persist the complete response before one monotonic cursor commit, then signal dispatch.
- The worker owns **execution receipts**. A routed turn is retired only after an authenticated worker acknowledgement carrying the expected delivery, source, and recipient identity.
- Unacknowledged routed work stays durable and is retried or retained while a worker is offline.
- An offline or restarting worker does not lose accepted inbound work, and does not cause a duplicate dispatch without an explicit, fenced retry.

## Protocol

Worker control extends the existing authenticated, generation-fenced bus. The daemon is the bus leader; workers register as ordinary followers over local IPC and then use the existing follower protocol for delivery and control:

```text
follower.register / follower.heartbeat / follower.disconnect   # existing bus lifecycle
leader.forwardMessage | leader.forwardCallback | leader.forwardReaction   # inbound routing (journaled)
follower.callApi                                               # worker Bot API proxy through the daemon
leader.workerControl { recipientInstanceId, recipientRegistrationGeneration, command }
bus.ack              { ok, result | message }
```

- Managed workers additionally expose their own `pi --mode rpc` channel to the daemon for supervision (state projection, drain, dialogs, control), which is not part of the bus protocol.
- The daemon owns the inbound journal and the transport lock; a forwarded update is admitted and acknowledged through the existing follower durable-admission path before the worker executes it.
- The daemon holds the RPC channel only for supervision (state projection, drain, dialogs, control), never for user-facing rendering.
- Registration is the existing follower registration. A managed worker additionally receives a daemon-provisioned bot identity digest, and a tokenless attached worker reads the daemon-published identity, so neither holds the raw token; do not infer separate worker credentials from bus authentication alone.
- `daemon.route` and thread mutations are CAS-fenced by the daemon `epoch`.

### Worker control commands

`leader.workerControl` carries exactly one allowlisted command: `prompt`, `steer`, `abort`, `clear_queue`, `compact`, `set_model`, `set_thinking_level`, `new_session`, `switch_session`, or `get_state`. Arbitrary shell is rejected, and `prompt`/`steer` payloads beginning with a slash command are rejected rather than forwarded as Pi slash commands. The Pi `ExtensionContext` adapter implements `prompt`, `steer`, `abort`, `compact`, `set_model`, `set_thinking_level`, and `get_state`; `clear_queue`, `new_session`, and `switch_session` need command-context authority and currently return an explicit error instead of guessing.

## Extension UI Bridge

- Managed: the daemon answers `extension_ui_request` on the RPC channel and translates `select`, `confirm`, `input`, and `editor` dialogs into bounded one-shot Telegram prompts (`lib/worker-ui.ts`). Each dialog is capped (32 live dialogs, 60 options, 4,000 characters) and times out after two minutes; the callback is generation-fenced, so a replaced registration cancels instead of answering the new worker. `notify` is projected as a plain notice; `setStatus`, `setTitle`, `setWidget`, and `set_editor_text` have no safe generic phone-width equivalent and are dropped.
- Attached: the extension still forwards Telegram-originated dialogs to the daemon over IPC. This path is not implemented yet; the receiver only carries the allowlisted control envelope.
- Fire-and-forget UI (`notify`, `setStatus`, `setTitle`) may be shown, downgraded, or dropped; dialog methods always resolve to exactly one response or a cancellation. A malformed or over-capacity dialog resolves `cancelled` rather than stalling the worker.

## Credentials And Secrets

Two independent secrets with different scopes:

| | Bot token | Worker credential |
| --- | --- | --- |
| Meaning | Telegram Bot API secret; possession means being the bot | Local IPC shared secret proving a worker may register |
| Holder | Daemon only | One per worker, minted by the daemon |
| Leak impact | Full bot control | Registration of one local worker |
| Lifetime | Profile configuration | Minted at registration, rotated on re-registration, bound to `workerId` + generation |

- **Current limitation:** managed workers load the operator's shared Pi configuration and Telegram profile file; the bot token is not daemon-exclusive yet. The planned per-worker credential and tokenless startup boundary are not implemented.
- `/telegram-setup`, pairing, and `allowedUserId` therefore remain shared-config behavior for now; do not treat the aspirational table above as a shipped security guarantee.

## Security Boundaries

- **Launch allowlist**: Telegram can only select a named spec. No update supplies argv, cwd, env, or command text.
- **Path policy**: absolute, `realpath`-resolved cwd, constrained to configured roots, symlink escapes rejected.
- **Project trust**: approved default `approve`, explicit per spec, visible in `/workers`. Operators accept that a trusted project's settings, extensions, and skills execute with the worker's privileges.
- **No remote shell**: the RPC `bash` command and any equivalent are unreachable from Telegram.
- **Sender admission**: `allowedUserId` is enforced in the daemon before routing, pairing, or foreign-target handling.
- **Launch audit**: every spawn, stop, restart, and escalation is recorded redacted with directory, worker id, and outcome.

## Failure Modes And Fencing

- **Daemon exits**: workers keep running locally; Telegram is dark. On restart the daemon re-admits retained inbound work, and workers re-register, restoring routes.
- **Worker crashes**: daemon marks the worker offline, retains unacknowledged work, and applies the restart policy. A route is not silently retargeted to another worker.
- **Double daemon**: the profile transport lock admits one owner; a second daemon fails closed on the existing `owners.json` contention path.
- **Split brain**: structurally impossible because exactly one daemon calls `getUpdates`.
- **Stale generations**: late registrations, acks, dialogs, and route mutations from a replaced generation are rejected.

## Migration And Compatibility

The change is a control-plane generalization, not a rewrite:

- **Reuse**: local IPC transport and authenticated envelopes, target abstraction, journal, routing, rendering/markup/preview/replies, queue policy, thread store and display modes, generative apps and sections.
- **Repurpose**: the current leader becomes the daemon; the current follower becomes a worker. Leader election is removed from the external topology.
- **Change**: `owners.json` transport ownership is already `cwd`-free after P0 and is shared by the extension leader and the daemon; `cwd`/`sessionId` become mutable worker attributes; session switching becomes an in-band worker transition; queue truth moves to the Pi runtime queue.
- **Add**: `supervisor`, `worker registry`, directory-picker launch, the `/daemon` menu, `WorkerControlPort`, the RPC adapter, the extension UI bridge, and the `pi-telegram-daemon` entrypoint.
- **Package shape**: `@llblab/pi-telegram` keeps the extension plus shared core; `pi-telegram-daemon` ships as a bin in the same package so versions stay aligned.
- **Backward compatibility**: standalone mode runs the embedded daemon and keeps today's single-instance behavior. The external daemon is an opt-in upgrade, not a migration requirement.

## Phasing

- **P0 — Contract and ownership decoupling.** Publish this contract; remove `cwd` from transport ownership; keep standalone behavior working on the shared contracts. Resolves the self-conflict/lockout class.
- **P1 — External daemon and attached workers.** Landed: daemon transport ownership, registries/snapshots, RPC client, directory picker, control panel, supervisor, and a generation-fenced allowlisted control envelope over the existing follower bus. Remaining: standalone tokenless worker registration, complete daemon-delivery ownership validation, and end-to-end production wiring.
- **P2 — Managed workers and supervision.** Launch/readiness/resume/fallback/restart/drain/abort/escalation are unit-tested; a real local `pi --mode rpc` `get_state` smoke passed with network and extensions disabled. Remaining: live daemon + managed-worker + Telegram delivery smoke and outcome/receipt verification.
- **P3 — Unification and hardening.** Token isolation/relocation, attached-worker dialog forwarding, full session/queue control adapter parity, thread re-alignment polish, diagnostics, and redaction review. Managed-worker `select`/`confirm`/`input`/`editor` dialogs now render through the daemon's Telegram UI bridge with generation-fenced callbacks.

## Decisions Log

| # | Decision |
| --- | --- |
| 1 | Thread = worker, project-aligned title/binding; cross-project switch keeps the same tab and re-aligns it |
| 2 | Queue execution truth is the Pi native steering/follow-up queue; cross-lane position preservation and full Keep/Skip semantics are accepted degradations |
| 3 | Bot token stays daemon-only; workers receive a per-worker local IPC credential |
| 4 | Default stop is graceful drain to idle, then bounded escalation |
| 5 | Default restart policy is `on-failure` |
| 6 | Attached (terminal TUI) workers are in scope from the first external-daemon phase |
| 7 | Managed workers always start with project trust `approve` |
| 8 | The daemon entrypoint is `pi-telegram-daemon` |

## Related

- [Architecture](./architecture.md) — current runtime, ownership, queue, and lifecycle contracts.
- [Telegram Multi-Instance Bus](./multi-instance-bus.md) — current leader/follower bus, binding model, and thread targets.
- [Public API](./public-api.md) — stable commands, config, and package entrypoints.
- [Delivery API](./delivery.md) and [Activity API](./activity.md) — rendering and lifecycle surfaces the daemon reuses.
- [AGENTS.md](../AGENTS.md) — engineering boundaries; its companion-boundary rule is superseded only by implementation of this contract.
