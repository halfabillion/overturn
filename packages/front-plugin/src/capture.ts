import type { CaptureAnswer, CaptureCreate, CaptureMessage } from "@overturn-ai/shared";
import {
  diffCaptureAnswers,
  normalizeCaptureText,
  REASON_PACKS,
  type ReasonCodeOption,
  type ReasonPack,
  reasonPackFrom,
} from "@overturn-ai/shared/capture";

/** One message of a Front conversation, as `listMessages` returns it. */
export interface FrontMessage {
  id: string;
  /** Front: `inbound` came from the customer, `outbound` was sent from Front. */
  status: "inbound" | "outbound" | string;
  body: string;
  fromHandle?: string | null;
  fromName?: string | null;
  date?: string | null;
}

/** One internal comment on the conversation, as `listComments` returns it. */
export interface FrontComment {
  id: string;
  body: string;
  authorName?: string | null;
  authorEmail?: string | null;
  createdAt?: string | null;
}

/** What the plugin knows about the conversation, read through the plugin SDK. */
export interface ConversationSnapshot {
  id: string;
  subject: string | null;
  recipientHandle: string | null;
  recipientName: string | null;
  /** Oldest first. */
  messages: FrontMessage[];
  comments: FrontComment[];
  /** Custom fields the admin chose as decision fields, by label. */
  fields: Record<string, unknown>;
  url: string | null;
}

export interface AppSettings {
  baseUrl: string;
  /**
   * A project API key in the plugin URL. Leave it out to post through Front's relay
   * (`relayHttp`), which attaches the key configured on the Front app server-side.
   */
  apiKey: string | null;
  agent: string;
  /** Hold a changed reply's capture until the teammate picks a reason. */
  requireReason: boolean;
  /** `coverage, cf_123:reserve` → conversation custom fields (by name or id) that are the decision, by label. */
  decisionFields: Array<{ id: string; label: string }>;
  /** Replies shorter than this never count as a draft (a typed greeting is not a draft). */
  minDraftChars: number;
  /** When set, the plugin watches only conversations carrying this tag; every other conversation is never read. */
  scopeTag: string | null;
  /** Which quick-pick reasons the teammate sees: the claims pack or the vendor-neutral support pack. */
  reasonPack: ReasonPack;
}

export const DEFAULT_SETTINGS: AppSettings = {
  baseUrl: "https://api.overturn.run",
  apiKey: null,
  agent: "support-reply",
  requireReason: true,
  decisionFields: [],
  minDraftChars: 80,
  scopeTag: null,
  reasonPack: "support",
};

/**
 * Parses the plugin settings. Front has no settings object for a sidebar plugin, so they ride in
 * the plugin URL's query string, under the same names as the Zendesk app's manifest parameters.
 */
export function settingsFrom(raw: Record<string, unknown>): AppSettings {
  const str = (k: string): string | null => {
    const v = raw[k];
    return typeof v === "string" && v.trim() ? v.trim() : null;
  };
  const bool = (k: string, d: boolean): boolean => {
    const v = raw[k];
    if (typeof v === "boolean") return v;
    if (typeof v === "string") return v === "true" || v === "1";
    return d;
  };
  const fields = (str("decision_fields") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [id, label] = s.split(":").map((x) => x.trim());
      return { id: id!, label: label || id! };
    });
  const min = Number(str("min_draft_chars") ?? "");
  return {
    baseUrl: (str("overturn_base_url") ?? DEFAULT_SETTINGS.baseUrl).replace(/\/+$/, ""),
    apiKey: str("overturn_api_key"),
    agent: str("agent") ?? DEFAULT_SETTINGS.agent,
    requireReason: bool("require_reason", DEFAULT_SETTINGS.requireReason),
    decisionFields: fields,
    minDraftChars: Number.isFinite(min) && min > 0 ? min : DEFAULT_SETTINGS.minDraftChars,
    scopeTag: str("scope_tag"),
    reasonPack: reasonPackFrom(str("reason_pack")),
  };
}

/** `?agent=claims-reply&require_reason=false` → settings. */
export function settingsFromQuery(search: string): AppSettings {
  const raw: Record<string, string> = {};
  new URLSearchParams(search).forEach((v, k) => {
    raw[k] = v;
  });
  return settingsFrom(raw);
}

/**
 * Whether the plugin should watch this conversation at all. With no scope tag every conversation is
 * watched, but nothing is read beyond the draft until a draft appears (see front.ts). With a scope
 * tag, conversations without it are never read, not even the draft.
 */
export function inScope(tags: readonly string[], settings: AppSettings): boolean {
  if (!settings.scopeTag) return true;
  return tags.includes(settings.scopeTag);
}

/**
 * Where the draft came from. The composer is watched: the first time it goes from (nearly)
 * empty to a reply-sized text in one change, that text was inserted (an AI assist, a snippet,
 * a paste), not typed, and it is the draft. The teammate can also mark the current text as the
 * draft by hand, and a drafting agent that recorded its run with the SDK is found by conversation id.
 */
export type DraftOrigin = "inserted" | "manual" | "recorded" | "preloaded";

export interface DraftState {
  text: string;
  origin: DraftOrigin;
  runId?: string;
  model?: string | null;
  at: number;
}

export interface DraftDetector {
  /** Feed every composer value; returns a draft the first time one appears. */
  onComposer(text: string, now?: number): DraftState | null;
  current(): DraftState | null;
  set(d: DraftState | null): void;
}

export function createDraftDetector(opts: { minDraftChars: number; typingWindowMs?: number }): DraftDetector {
  const window = opts.typingWindowMs ?? 1500;
  let draft: DraftState | null = null;
  let last = { text: "", at: 0 };
  let seen = false;
  return {
    onComposer(text, now = Date.now()) {
      const prev = last;
      const firstSight = !seen;
      seen = true;
      last = { text, at: now };
      if (draft) return null;
      const grew = text.length - prev.text.length;
      // A jump of reply size in one change (or a reply-sized composer on first sight).
      const jump =
        grew >= opts.minDraftChars && (prev.text.length < opts.minDraftChars / 2 || now - prev.at > window);
      const first = firstSight && text.length >= opts.minDraftChars;
      if (jump || first) {
        draft = { text, origin: first ? "preloaded" : "inserted", at: now };
        return draft;
      }
      return null;
    },
    current: () => draft,
    set: (d) => {
      draft = d;
    },
  };
}

/**
 * Front hands back message and draft bodies as HTML, with the quoted thread under a reply.
 * The case wants the text the human wrote, so the quote goes and the rest becomes plain text.
 */
export function stripHtml(html: string): string {
  return normalizeCaptureText(
    html
      .replace(/<div[^>]*class="[^"]*front-blockquote[^"]*"[^>]*>[\s\S]*$/i, "")
      .replace(/<blockquote[\s\S]*?<\/blockquote>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, "&"),
  );
}

const time = (s: string | null | undefined): number => {
  const t = s ? Date.parse(s) : Number.NaN;
  return Number.isFinite(t) ? t : 0;
};

/** The thread the teammate saw, oldest first, as capture context: messages and internal comments interleaved. */
export function contextFrom(conversation: ConversationSnapshot): CaptureMessage[] {
  const messages = conversation.messages.map((m) => ({
    at: m.date ?? null,
    msg: {
      role: m.status === "inbound" ? ("customer" as const) : ("agent" as const),
      author: m.fromHandle ?? m.fromName ?? null,
      content: stripHtml(m.body),
      at: m.date ?? null,
    },
  }));
  const comments = conversation.comments.map((c) => ({
    at: c.createdAt ?? null,
    msg: {
      role: "note" as const,
      author: c.authorEmail ?? c.authorName ?? null,
      content: stripHtml(c.body),
      at: c.createdAt ?? null,
    },
  }));
  // A stable sort: entries without a time keep their place relative to their own list.
  return [...messages, ...comments]
    .map((e, i) => ({ ...e, i }))
    .sort((a, b) => time(a.at) - time(b.at) || a.i - b.i)
    .map((e) => e.msg)
    .filter((m) => m.content);
}

/**
 * Front's plugin SDK has no send hook. The send is the first outbound message that was not in
 * the conversation when the draft appeared: ids known then are the baseline, so the match never
 * depends on the browser's clock agreeing with Front's.
 */
export function findSentMessage(
  messages: readonly FrontMessage[],
  baseline: ReadonlySet<string>,
): FrontMessage | null {
  return messages.find((m) => m.status === "outbound" && !baseline.has(m.id)) ?? null;
}

/** Decision fields by label from the conversation's custom fields (matched by id or name). */
export function decisionFieldsFrom(
  attributes: ReadonlyArray<{ id: string; name: string; value: unknown }>,
  settings: AppSettings,
): Record<string, unknown> {
  if (settings.decisionFields.length === 0) return {};
  return Object.fromEntries(
    settings.decisionFields.map((f) => {
      const a = attributes.find((x) => x.id === f.id || x.name === f.id);
      const v = a?.value instanceof Date ? a.value.toISOString() : (a?.value ?? null);
      return [f.label, v];
    }),
  );
}

const MAX_SECONDS_TO_SEND = 86_400 * 30;

export interface PendingSend {
  /** The sent message's body (HTML or text). */
  text: string;
  /** The sent message's id; it is left out of the context, which is what the teammate saw. */
  messageId: string | null;
  fields: Record<string, unknown>;
}

export type SendDecision =
  | { action: "skip"; why: "no-draft" | "empty" }
  | { action: "capture"; body: CaptureCreate; changed: boolean; changedFields: string[] }
  | { action: "need-reason"; changedFields: string[] };

/** What to do once the teammate's reply has gone out. Pure: the Front glue only forwards the answer. */
export function decideOnSend(input: {
  conversation: ConversationSnapshot;
  draft: DraftState | null;
  draftFields: Record<string, unknown>;
  send: PendingSend;
  /** The picked reason code, required for a changed send when requireReason is on. */
  reasonCode: string | null;
  /** Optional free-text note. */
  reason: string;
  actor: string | null;
  settings: AppSettings;
  /** When the send was seen; with the draft's `at`, gives how long it sat in front of the reviewer. */
  now?: number;
}): SendDecision {
  const { conversation, draft, send, settings } = input;
  const sentText = stripHtml(send.text);
  if (!sentText) return { action: "skip", why: "empty" };
  if (!draft) return { action: "skip", why: "no-draft" };

  const hasFields = settings.decisionFields.length > 0;
  const draftAnswer: CaptureAnswer = {
    text: stripHtml(draft.text),
    ...(hasFields ? { fields: input.draftFields } : {}),
  };
  const sentAnswer: CaptureAnswer = { text: sentText, ...(hasFields ? { fields: send.fields } : {}) };
  const diff = diffCaptureAnswers(draftAnswer, sentAnswer);
  const reason = input.reason.trim();
  const reasonCode = input.reasonCode?.trim() || null;
  if (diff.changed && settings.requireReason && !reasonCode) {
    return { action: "need-reason", changedFields: diff.changedFields };
  }

  const seen: ConversationSnapshot = {
    ...conversation,
    messages: conversation.messages.filter((m) => m.id !== send.messageId),
  };
  const body: CaptureCreate = {
    source: "front",
    externalId: `fr:${conversation.id}`,
    agent: settings.agent,
    actor: input.actor,
    subject: conversation.subject,
    context: contextFrom(seen),
    draft: draftAnswer,
    sent: sentAnswer,
    reason: reason || null,
    reasonCode: diff.changed ? reasonCode : null,
    // The API caps this at 30 days; a Front draft can outlive that.
    secondsToSend: Math.min(
      MAX_SECONDS_TO_SEND,
      Math.max(0, Math.round(((input.now ?? Date.now()) - draft.at) / 100) / 10),
    ),
    draftRunId: draft.runId ?? null,
    draftModel: draft.model ?? null,
    url: conversation.url,
    tags: [`draft:${draft.origin}`, "public-reply"],
    metadata: { requester: conversation.recipientHandle ?? conversation.recipientName ?? null },
  };
  return { action: "capture", body, changed: diff.changed, changedFields: diff.changedFields };
}

/** Short status line for the sidebar. */
export function statusLine(
  d: DraftState | null,
  lastResult: { kind: string; changed: boolean; dedup: boolean } | null,
  held = false,
): string {
  if (held) return "Changed · pick why to record it";
  if (lastResult) {
    if (!lastResult.changed) return "Sent as drafted · approved";
    return lastResult.dedup ? "Captured · already in the suite" : "Captured · edit saved as a case";
  }
  if (!d) return "Waiting for a draft";
  const text = stripHtml(d.text);
  const words = text ? text.split(/\s+/).length : 0;
  const from = {
    inserted: "inserted",
    manual: "marked by you",
    recorded: "recorded by your agent",
    preloaded: "found in the composer",
  }[d.origin];
  return `Draft ${from} · ${words} words`;
}

/** The chips the teammate clicks, for the installed pack. */
export function quickReasons(settings: AppSettings): readonly ReasonCodeOption[] {
  return REASON_PACKS[settings.reasonPack];
}
