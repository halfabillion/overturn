import type { CaptureResult } from "@overturn-ai/shared";
import {
  type AppSettings,
  type ConversationSnapshot,
  createDraftDetector,
  type DraftDetector,
  type DraftState,
  decideOnSend,
  decisionFieldsFrom,
  type FrontComment,
  type FrontMessage,
  findSentMessage,
  inScope,
  type PendingSend,
  statusLine,
} from "./capture";

/**
 * The slice of a Front `singleConversation` context this plugin uses. The real context from
 * `Front.contextUpdates` satisfies it; the tests hand in a fake.
 */
export interface FrontConversationContext {
  type: "singleConversation";
  teammate: { email: string };
  conversation: {
    id: string;
    subject: string | undefined;
    draftId: string | undefined;
    tags: ReadonlyArray<{ name: string }>;
    recipient: { handle: string; name: string | undefined } | undefined;
    customFieldAttributes: ReadonlyArray<{ id: string; name: string; value: unknown }>;
  };
  fetchDraft(draftId: string): Promise<{ content: { body: string } } | undefined>;
  listMessages(paginationToken?: string): Promise<{
    results: ReadonlyArray<{
      id: string;
      status: string;
      date: Date;
      content: { body: string } | undefined;
      from: { handle: string; name: string | undefined };
    }>;
    nextPageToken: string | undefined;
  }>;
  listComments(paginationToken?: string): Promise<{
    results: ReadonlyArray<{
      id: string;
      createdAt: Date;
      content: { body: string };
      author: { name: string; email: string };
    }>;
    nextPageToken: string | undefined;
  }>;
}

/** How the plugin reaches Overturn: straight with a key, or through Front's relay (see main.ts). */
export interface Transport {
  get<T>(url: string): Promise<T>;
  post<T>(url: string, body: unknown): Promise<T>;
}

export interface PanelState {
  /** False when the conversation is out of scope (or there is none): the panel shows only the status. */
  watching: boolean;
  status: string;
  /** What happened to the last capture (a case title, or why it failed). */
  message: string;
  reasonCode: string | null;
  /** The optional note; cleared after a capture is saved. */
  reason: string;
  held: boolean;
}

export interface CaptureController {
  /** Feed every context from `Front.contextUpdates`; anything but a single conversation idles the panel. */
  onContext(ctx: FrontConversationContext | null): Promise<void>;
  /** Re-read the draft. Front pushes no update while the teammate types, so main.ts calls this on a timer. */
  poll(): Promise<void>;
  /** "Use the current text as the draft". */
  markCurrentAsDraft(): Promise<void>;
  /** A reason chip was clicked (clicking the picked one again clears it). Posts a held capture. */
  pickReason(code: string): Promise<void>;
  setNote(text: string): void;
  state(): PanelState;
}

/**
 * How many polls (about 1.5s apart) to wait for the sent message to show up after the draft leaves
 * the composer: covers Front's undo-send delay. No outbound message by then means it was discarded.
 */
export const SEND_WAIT_POLLS = 20;
const MAX_PAGES = 20;

interface Watch {
  ctx: FrontConversationContext;
  watching: boolean;
  detector: DraftDetector;
  /** The composer draft being watched. */
  draftId: string | undefined;
  /** Outbound message ids already in the conversation when the draft appeared. */
  baseline: Set<string> | null;
  draftFields: Record<string, unknown>;
  /** Polls spent looking for the sent message since the draft left the composer; 0 when not looking. */
  awaiting: number;
  /** A changed reply waiting for its reason (require_reason). */
  held: {
    conversation: ConversationSnapshot;
    send: PendingSend;
    draft: DraftState;
    draftFields: Record<string, unknown>;
    at: number;
  } | null;
}

export function createCaptureController(opts: {
  settings: AppSettings;
  transport: Transport;
  now?: () => number;
  onChange?: () => void;
  log?: (message: string, error?: unknown) => void;
}): CaptureController {
  const { settings, transport } = opts;
  const now = opts.now ?? Date.now;
  const log = opts.log ?? ((m: string, e?: unknown) => console.warn(`[overturn] ${m}`, e ?? ""));
  const changed = (): void => opts.onChange?.();

  let cur: Watch | null = null;
  let busy = false;
  let reasonCode: string | null = null;
  let note = "";
  let message = "";
  let lastResult: { kind: string; changed: boolean; dedup: boolean } | null = null;

  const resetDraft = (w: Watch): void => {
    w.detector.set(null);
    w.baseline = null;
    w.draftFields = {};
    w.awaiting = 0;
  };

  const readMessages = async (ctx: FrontConversationContext): Promise<FrontMessage[]> => {
    const out: FrontMessage[] = [];
    let token: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const r = await ctx.listMessages(token);
      for (const m of r.results) {
        out.push({
          id: m.id,
          status: m.status,
          body: m.content?.body ?? "",
          fromHandle: m.from?.handle ?? null,
          fromName: m.from?.name ?? null,
          date: m.date instanceof Date ? m.date.toISOString() : null,
        });
      }
      token = r.nextPageToken;
      if (!token) break;
    }
    // Oldest first, so the first new outbound message is the one that followed the draft.
    const t = (m: FrontMessage): number => (m.date ? Date.parse(m.date) : 0) || 0;
    return out
      .map((m, i) => ({ m, i }))
      .sort((a, b) => t(a.m) - t(b.m) || a.i - b.i)
      .map((x) => x.m);
  };

  const readComments = async (ctx: FrontConversationContext): Promise<FrontComment[]> => {
    const out: FrontComment[] = [];
    let token: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const r = await ctx.listComments(token);
      for (const c of r.results) {
        out.push({
          id: c.id,
          body: c.content.body,
          authorName: c.author?.name ?? null,
          authorEmail: c.author?.email ?? null,
          createdAt: c.createdAt instanceof Date ? c.createdAt.toISOString() : null,
        });
      }
      token = r.nextPageToken;
      if (!token) break;
    }
    return out;
  };

  /** The draft exists: only now is the thread read, to know which outbound messages were already there. */
  const arm = async (w: Watch): Promise<void> => {
    try {
      const messages = await readMessages(w.ctx);
      w.baseline = new Set(messages.filter((m) => m.status === "outbound").map((m) => m.id));
      w.draftFields = decisionFieldsFrom(w.ctx.conversation.customFieldAttributes, settings);
    } catch (e) {
      // Tried again on the next poll while the draft is still there.
      log("could not read the conversation", e);
    }
  };

  const post = async (body: unknown): Promise<void> => {
    try {
      const r = await transport.post<CaptureResult>(`${settings.baseUrl}/v1/capture`, body);
      lastResult = { kind: r.kind, changed: r.changed, dedup: r.deduplicated };
      message = r.changed && r.case ? `Case: ${r.case.title}` : "";
      note = "";
      reasonCode = null;
    } catch (e) {
      // Never in the teammate's way: the reply is already sent; say so in the panel and move on.
      log("capture failed", e);
      const status = (e as { status?: number } | null)?.status;
      message = `Overturn could not save this correction (${status ?? "network"}).`;
    }
  };

  const decideHeld = async (w: Watch): Promise<void> => {
    const h = w.held;
    if (!h) return;
    const decision = decideOnSend({
      conversation: h.conversation,
      draft: h.draft,
      draftFields: h.draftFields,
      send: h.send,
      reasonCode,
      reason: note,
      actor: w.ctx.teammate.email ?? null,
      settings,
      now: h.at,
    });
    if (decision.action === "need-reason") {
      changed();
      return;
    }
    w.held = null;
    if (decision.action === "capture") await post(decision.body);
    changed();
  };

  const onSent = async (w: Watch, sent: FrontMessage, messages: FrontMessage[]): Promise<void> => {
    const draft = w.detector.current();
    if (!draft) return;
    let comments: FrontComment[] = [];
    try {
      comments = await readComments(w.ctx);
    } catch (e) {
      log("could not read comments", e);
    }
    const c = w.ctx.conversation;
    const fields = decisionFieldsFrom(c.customFieldAttributes, settings);
    w.held = {
      draft,
      draftFields: w.draftFields,
      at: now(),
      send: { text: sent.body, messageId: sent.id, fields },
      conversation: {
        id: c.id,
        subject: c.subject ?? null,
        recipientHandle: c.recipient?.handle ?? null,
        recipientName: c.recipient?.name ?? null,
        messages,
        comments,
        fields,
        url: `https://app.frontapp.com/open/${c.id}`,
      },
    };
    resetDraft(w);
    lastResult = null;
    await decideHeld(w);
  };

  const pollOnce = async (w: Watch): Promise<void> => {
    if (!w.watching) return;
    const draftId = w.ctx.conversation.draftId;

    // 1. The draft left the composer earlier: look for the message it became.
    if (w.awaiting > 0 && w.baseline) {
      const messages = await readMessages(w.ctx);
      const sent = findSentMessage(messages, w.baseline);
      if (sent) {
        await onSent(w, sent, messages);
      } else if (draftId || ++w.awaiting > SEND_WAIT_POLLS) {
        // Closed without sending (or replaced by a new draft): nothing to record.
        resetDraft(w);
        changed();
      }
    }

    // 2. Read the composer.
    let text: string | null = null;
    if (draftId) {
      const d = await w.ctx.fetchDraft(draftId);
      text = d ? d.content.body : null;
    }
    if (text === null) {
      if (w.draftId && w.detector.current() && w.baseline && w.awaiting === 0) w.awaiting = 1;
      else if (w.draftId && w.awaiting === 0) resetDraft(w);
      w.draftId = undefined;
      return;
    }
    if (draftId !== w.draftId && !w.detector.current()) {
      // A new composer: judge its text on its own, not as a change from the last reply's text.
      w.detector = createDraftDetector({ minDraftChars: settings.minDraftChars });
    }
    w.draftId = draftId;
    if (w.detector.onComposer(text, now())) {
      lastResult = null;
      message = "";
      changed();
    }
    if (w.detector.current() && !w.baseline) await arm(w);
  };

  const run = async (fn: () => Promise<void>): Promise<void> => {
    if (busy) return;
    busy = true;
    try {
      await fn();
    } catch (e) {
      log("poll failed", e);
    } finally {
      busy = false;
    }
  };

  const lookupRecordedDraft = async (w: Watch): Promise<void> => {
    try {
      const externalId = encodeURIComponent(`fr:${w.ctx.conversation.id}`);
      const found = await transport.get<{
        items: Array<{ id: string; output: unknown; model?: string | null }>;
      }>(
        `${settings.baseUrl}/v1/runs?externalId=${externalId}&agent=${encodeURIComponent(settings.agent)}&limit=1`,
      );
      const r = found.items[0];
      if (cur === w && r && typeof r.output === "string" && r.output.trim() && !w.detector.current()) {
        w.detector.set({
          text: r.output,
          origin: "recorded",
          runId: r.id,
          model: r.model ?? null,
          at: now(),
        });
        changed();
      }
    } catch {
      // no recorded draft; the composer is watched instead
    }
  };

  return {
    async onContext(ctx) {
      if (!ctx) {
        cur = null;
        changed();
        return;
      }
      if (cur && cur.ctx.conversation.id === ctx.conversation.id) {
        cur.ctx = ctx;
        await run(() => pollOnce(cur!));
        changed();
        return;
      }
      if (cur?.held) log("conversation changed before a reason was picked; that capture is dropped");
      const w: Watch = {
        ctx,
        // Scope: with a tag configured, a conversation without it is never read, not even the draft.
        watching: inScope(
          ctx.conversation.tags.map((t) => t.name),
          settings,
        ),
        detector: createDraftDetector({ minDraftChars: settings.minDraftChars }),
        draftId: undefined,
        baseline: null,
        draftFields: {},
        awaiting: 0,
        held: null,
      };
      cur = w;
      reasonCode = null;
      note = "";
      message = "";
      lastResult = null;
      changed();
      if (!w.watching) return;
      await lookupRecordedDraft(w);
      await run(() => pollOnce(w));
      changed();
    },
    poll: () => (cur ? run(() => pollOnce(cur!)) : Promise.resolve()),
    async markCurrentAsDraft() {
      const w = cur;
      if (!w?.watching || !w.ctx.conversation.draftId) return;
      await run(async () => {
        const d = await w.ctx.fetchDraft(w.ctx.conversation.draftId!);
        const text = d?.content.body ?? "";
        if (!text.trim()) return;
        w.detector.set({ text, origin: "manual", at: now() });
        w.draftId = w.ctx.conversation.draftId;
        w.baseline = null;
        lastResult = null;
        message = "";
        await arm(w);
      });
      changed();
    },
    async pickReason(code) {
      reasonCode = reasonCode === code ? null : code;
      changed();
      if (cur?.held && reasonCode) await decideHeld(cur);
    },
    setNote(text) {
      note = text;
    },
    state() {
      const idle = { watching: false, message: "", reasonCode: null, reason: "", held: false };
      if (!cur) return { ...idle, status: "Open a conversation" };
      if (!cur.watching) return { ...idle, status: `Not watching: no "${settings.scopeTag}" tag` };
      return {
        watching: true,
        status: statusLine(cur.detector.current(), lastResult, cur.held !== null),
        message,
        reasonCode,
        reason: note,
        held: cur.held !== null,
      };
    },
  };
}
