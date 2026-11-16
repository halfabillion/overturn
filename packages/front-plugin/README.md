# Overturn for Front

QA for AI-drafted replies, in the Front conversation sidebar. It is the Front counterpart of [`packages/zendesk-app`](../zendesk-app): it watches the reply box for the AI draft, diffs it against what the teammate actually sends, asks for a one-line reason, and posts the result to `POST /v1/capture` with `source: "front"` and `externalId: "fr:<conversation id>"`. The payload is the one documented in [docs/capture.md](../../docs/capture.md).

## What the teammate sees

A small panel in the sidebar:

- **Draft inserted · 112 words** once an AI assist, snippet or paste lands in the reply box (anything reply-sized inserted in one go). A reply already in the composer when the conversation opens shows as **found in the composer**. If the drafting agent recorded its run with the Overturn SDK (`externalId: "fr:<conversation id>"`), the draft is taken from that run instead. "Use the current text as the draft" marks it by hand.
- A **reason** picker with the installed pack's codes (`reason_pack`: `support` by default, or `claims`) and an optional note.
- On **send**: sent as drafted → an `approve` capture, no prompt; changed → an `edit` capture with the reason as the case's title and the judge's rubric.

Overturn failing never blocks the teammate's work; the panel says what happened.

## Where Front differs from Zendesk

Front's plugin SDK has no pre-send hook (Zendesk has `ticket.save`), so a plugin cannot hold Front's Send button. Two consequences, both handled in `src/front.ts`:

- **The send is observed, not intercepted.** When the draft leaves the composer, the plugin looks for the first outbound message that was not in the conversation when the draft appeared, and uses that message's body as `sent`. It keeps looking for about 30 seconds (Front's undo-send delay); a draft that was discarded records nothing. Matching on message ids, not timestamps, means an earlier reply is never mistaken for the send.
- **`require_reason` holds the capture, not the send.** A changed reply without a reason code is held in the panel ("Changed · pick why to record it") and posted the moment a chip is clicked, together with the note. A reason picked before sending rides along straight away.

Like the Zendesk app, nothing beyond the draft is read until a draft exists: only then is the thread listed (to know which replies were already there), and the comments are read only after the send. With `scope_tag` set, a conversation without the tag is never read at all.

## Install

1. In Overturn, create a project API key (Settings → API keys).
2. Build: `pnpm --filter @overturn-ai/front-plugin build` → `dist/overturn-front-plugin.zip` (and the same files in `dist/app`). Host them on any HTTPS static host.
3. In Front: Settings → Company → Developers → create an app → **Features** → **Add feature** → **Plugin** → **Sidebar plugin**, with the hosted `index.html` as the sidebar URL.
4. Settings go in the sidebar URL's query string (Front has no settings form for a plugin); the names are the Zendesk app's:

| Parameter | Default | |
| :-- | :-- | :-- |
| `overturn_api_key` | none | A project API key. Without it, requests go through Front's `relayHttp`, so the key can live with the Front app's server instead of in the URL. |
| `overturn_base_url` | `https://api.overturn.run` | Your Overturn API when self-hosting. |
| `agent` | `support-reply` | The workflow name, one regression suite per workflow. |
| `reason_pack` | `support` | `support` or `claims`: the one-click reasons. |
| `require_reason` | `true` | Hold a changed reply's capture until a reason code is picked. |
| `decision_fields` | none | Conversation custom fields that *are* the decision, by name or id, as `name:label` pairs, e.g. `coverage, cf_123:reserve`. Changes to these are scored exactly; the prose is scored by the judge. |
| `scope_tag` | none | Only conversations carrying this tag are watched. |
| `min_draft_chars` | `80` | Text inserted in one go, at least this long, counts as the draft. |

Example: `https://plugins.example.com/overturn/index.html?agent=claims-reply&reason_pack=claims&decision_fields=coverage,reserve`.

Front's quoted thread under a reply (`front-blockquote`) is stripped from both the draft and the sent text, so quoting the customer is not counted as an edit. Internal comments go into the captured context as notes.

## Replay what it captured

```bash
overturn cases list --agent support-reply
overturn replay --model openai/gpt-4.1-mini --agent support-reply
```

## Development

```bash
pnpm --filter @overturn-ai/front-plugin test       # payload builder, draft detection, the send flow against a fake Front
pnpm --filter @overturn-ai/front-plugin typecheck
pnpm --filter @overturn-ai/front-plugin build
```

`src/capture.ts` is the logic (pure, tested); `src/front.ts` follows the conversation through the plugin SDK and decides when to capture (tested with a fake Front context); `src/main.ts` is the panel and the SDK glue; `app/` is the page Front loads.
