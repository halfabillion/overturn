import type { CaptureCreate } from "@overturn-ai/shared";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, settingsFromQuery } from "./capture";
import {
  createCaptureController,
  type FrontConversationContext,
  SEND_WAIT_POLLS,
  type Transport,
} from "./front";

// The Front plugin SDK surface, faked the way the Zendesk tests fake the ZAF client.
type Message = Awaited<ReturnType<FrontConversationContext["listMessages"]>>["results"][number];

const AI_DRAFT =
  "<p>Hi Dana,</p><p>Thanks for the photos. Storm damage to the roof is covered under your HO-3 policy. An adjuster will contact you within 5 business days.</p>";

function fakeFront(opts: { tags?: string[]; pageSize?: number } = {}) {
  const front = {
    draftBody: null as string | null,
    messages: [
      {
        id: "msg_in",
        status: "inbound",
        date: new Date("2026-10-01T10:00:00Z"),
        content: { body: "<p>Water came through the ceiling.</p>" },
        from: { handle: "dana@example.com", name: "Dana" },
      },
      {
        id: "msg_old",
        status: "outbound",
        date: new Date("2026-10-01T10:05:00Z"),
        content: { body: "<p>We got your claim.</p>" },
        from: { handle: "claims@carrier.com", name: undefined },
      },
    ] as Message[],
    reads: { fetchDraft: 0, listMessages: 0, listComments: 0 },
    coverage: "covered" as string,
  };
  const pageSize = opts.pageSize ?? 50;
  const ctx = (conversationId = "cnv_1"): FrontConversationContext => ({
    type: "singleConversation",
    teammate: { email: "ray@carrier.com" },
    conversation: {
      id: conversationId,
      subject: "Roof leak after storm",
      draftId: front.draftBody === null ? undefined : "dra_1",
      tags: (opts.tags ?? []).map((name) => ({ name })),
      recipient: { handle: "dana@example.com", name: "Dana" },
      customFieldAttributes: [{ id: "cf_1", name: "coverage", value: front.coverage }],
    },
    async fetchDraft() {
      front.reads.fetchDraft++;
      return front.draftBody === null ? undefined : { content: { body: front.draftBody } };
    },
    async listMessages(token) {
      front.reads.listMessages++;
      const start = token ? Number(token) : 0;
      const end = start + pageSize;
      return {
        results: front.messages.slice(start, end),
        nextPageToken: end < front.messages.length ? String(end) : undefined,
      };
    },
    async listComments() {
      front.reads.listComments++;
      return {
        results: [
          {
            id: "com_1",
            createdAt: new Date("2026-10-01T10:02:00Z"),
            content: { body: "HO-3, no prior claims." },
            author: { name: "Ray", email: "ray@carrier.com" },
          },
        ],
        nextPageToken: undefined,
      };
    },
  });
  const send = (body: string, id = "msg_sent"): void => {
    front.draftBody = null;
    front.messages.push({
      id,
      status: "outbound",
      date: new Date("2026-10-01T11:00:00Z"),
      content: { body },
      from: { handle: "claims@carrier.com", name: undefined },
    });
  };
  return { front, ctx, send };
}

function fakeOverturn(
  opts: { fail?: number; recorded?: { id: string; output: string; model: string } } = {},
) {
  const posts: Array<{ url: string; body: CaptureCreate }> = [];
  const gets: string[] = [];
  const transport: Transport = {
    async get<T>(url: string) {
      gets.push(url);
      return { items: opts.recorded ? [opts.recorded] : [] } as T;
    },
    async post<T>(url: string, body: unknown) {
      posts.push({ url, body: body as CaptureCreate });
      if (opts.fail) throw Object.assign(new Error("boom"), { status: opts.fail });
      const changed = (body as CaptureCreate).draft.text !== (body as CaptureCreate).sent.text;
      return {
        kind: changed ? "edit" : "approve",
        changed,
        deduplicated: false,
        case: changed ? { title: "Storm SLA is 2 days" } : null,
      } as T;
    },
  };
  return { transport, posts, gets };
}

function setup(
  o: {
    query?: string;
    tags?: string[];
    fail?: number;
    recorded?: { id: string; output: string; model: string };
  } = {},
) {
  const f = fakeFront({ tags: o.tags });
  const api = fakeOverturn({ fail: o.fail, recorded: o.recorded });
  let t = 1_000;
  const log = vi.fn();
  const c = createCaptureController({
    settings: o.query ? settingsFromQuery(o.query) : DEFAULT_SETTINGS,
    transport: api.transport,
    now: () => t,
    log,
  });
  const tick = async (ms = 1500) => {
    t += ms;
    await c.poll();
  };
  return { ...f, ...api, c, log, tick };
}

describe("Front capture flow", () => {
  it("reads nothing but the composer before a draft appears", async () => {
    const s = setup();
    await s.c.onContext(s.ctx());
    s.front.draftBody = "<p>Hi</p>";
    await s.c.onContext(s.ctx());
    await s.tick();
    expect(s.front.reads.fetchDraft).toBeGreaterThan(0);
    expect(s.front.reads.listMessages).toBe(0);
    expect(s.front.reads.listComments).toBe(0);
    expect(s.c.state().status).toBe("Waiting for a draft");
  });

  it("a draft landing in the reply box shows 'Draft inserted · N words'", async () => {
    const s = setup();
    s.front.draftBody = "";
    await s.c.onContext(s.ctx());
    s.front.draftBody = AI_DRAFT;
    await s.tick();
    expect(s.c.state()).toMatchObject({ watching: true, status: "Draft inserted · 26 words", held: false });
    expect(s.front.reads.listMessages).toBe(1); // the baseline, read once the draft exists
  });

  it("a draft already in the composer when the conversation opens is found", async () => {
    const s = setup();
    s.front.draftBody = AI_DRAFT;
    await s.c.onContext(s.ctx());
    expect(s.c.state().status).toBe("Draft found in the composer · 26 words");
  });

  it("sent as drafted: one approve capture with source front and fr:<conversation id>", async () => {
    const s = setup();
    s.front.draftBody = "";
    await s.c.onContext(s.ctx());
    s.front.draftBody = AI_DRAFT;
    await s.tick();
    s.send(`${AI_DRAFT}<div class="front-blockquote">On Oct 1 Dana wrote…</div>`);
    await s.c.onContext(s.ctx()); // Front drops draftId once the reply goes out
    await s.tick();
    expect(s.posts).toHaveLength(1);
    const { url, body } = s.posts[0]!;
    expect(url).toBe("https://api.overturn.run/v1/capture");
    expect(body).toMatchObject({
      source: "front",
      externalId: "fr:cnv_1",
      agent: "support-reply",
      actor: "ray@carrier.com",
      subject: "Roof leak after storm",
      reasonCode: null,
      url: "https://app.frontapp.com/open/cnv_1",
      tags: ["draft:inserted", "public-reply"],
    });
    expect(body.draft.text).toBe(body.sent.text);
    // the thread the teammate saw: customer, note, earlier reply; not the sent reply itself
    expect(body.context.map((m) => m.role)).toEqual(["customer", "note", "agent"]);
    expect(body.context.map((m) => m.content)).not.toContain(body.sent.text);
    expect(body.secondsToSend).toBe(1.5);
    expect(s.c.state().status).toBe("Sent as drafted · approved");
    // nothing more is posted on later polls
    await s.tick();
    await s.tick();
    expect(s.posts).toHaveLength(1);
  });

  it("require_reason: a changed reply is held, never posted without a code, then posted with code and note", async () => {
    const s = setup();
    s.front.draftBody = "";
    await s.c.onContext(s.ctx());
    s.front.draftBody = AI_DRAFT;
    await s.tick();
    s.send(AI_DRAFT.replace("5 business days", "2 business days"));
    await s.c.onContext(s.ctx());
    await s.tick();
    expect(s.posts).toHaveLength(0);
    expect(s.c.state()).toMatchObject({ held: true, status: "Changed · pick why to record it" });
    s.c.setNote("Storm SLA is 2 days");
    await s.tick();
    expect(s.posts).toHaveLength(0); // a note alone is not a reason
    await s.c.pickReason("wrong_answer");
    expect(s.posts).toHaveLength(1);
    expect(s.posts[0]!.body).toMatchObject({ reasonCode: "wrong_answer", reason: "Storm SLA is 2 days" });
    expect(s.posts[0]!.body.sent.text).toContain("2 business days");
    expect(s.c.state()).toMatchObject({
      held: false,
      status: "Captured · edit saved as a case",
      message: "Case: Storm SLA is 2 days",
      reasonCode: null,
      reason: "",
    });
  });

  it("with require_reason off, a changed reply is captured straight away", async () => {
    const s = setup({ query: "?require_reason=false" });
    s.front.draftBody = "";
    await s.c.onContext(s.ctx());
    s.front.draftBody = AI_DRAFT;
    await s.tick();
    s.send(AI_DRAFT.replace("covered", "not covered"));
    await s.c.onContext(s.ctx());
    await s.tick();
    expect(s.posts).toHaveLength(1);
    expect(s.posts[0]!.body.reasonCode).toBeNull();
  });

  it("a reason picked before the send rides along", async () => {
    const s = setup();
    s.front.draftBody = "";
    await s.c.onContext(s.ctx());
    s.front.draftBody = AI_DRAFT;
    await s.tick();
    await s.c.pickReason("should_escalate");
    s.send(AI_DRAFT.replace("covered", "escalated to a senior adjuster"));
    await s.c.onContext(s.ctx());
    await s.tick();
    expect(s.posts).toHaveLength(1);
    expect(s.posts[0]!.body.reasonCode).toBe("should_escalate");
  });

  it("a failed capture never gets in the way: it logs, says so in the panel and moves on", async () => {
    const s = setup({ query: "?require_reason=false", fail: 503 });
    s.front.draftBody = "";
    await s.c.onContext(s.ctx());
    s.front.draftBody = AI_DRAFT;
    await s.tick();
    s.send(AI_DRAFT);
    await expect(s.c.onContext(s.ctx())).resolves.toBeUndefined();
    await expect(s.tick()).resolves.toBeUndefined();
    expect(s.posts).toHaveLength(1);
    expect(s.log).toHaveBeenCalledWith("capture failed", expect.anything());
    expect(s.c.state().message).toBe("Overturn could not save this correction (503).");
    // the next draft on the same conversation is watched as usual
    s.front.draftBody = "";
    await s.c.onContext(s.ctx());
    await s.tick();
    s.front.draftBody = AI_DRAFT;
    await s.tick();
    expect(s.c.state().status).toBe("Draft inserted · 26 words");
  });

  it("the send is found when the message lands a few seconds after the draft leaves (undo send)", async () => {
    const s = setup({ query: "?require_reason=false" });
    s.front.draftBody = "";
    await s.c.onContext(s.ctx());
    s.front.draftBody = AI_DRAFT;
    await s.tick();
    s.front.draftBody = null;
    await s.c.onContext(s.ctx());
    await s.tick();
    await s.tick();
    expect(s.posts).toHaveLength(0);
    s.send(AI_DRAFT);
    await s.tick();
    expect(s.posts).toHaveLength(1);
  });

  it("the next reply on the same conversation is judged on its own composer", async () => {
    const s = setup({ query: "?require_reason=false" });
    s.front.draftBody = "";
    await s.c.onContext(s.ctx());
    s.front.draftBody = AI_DRAFT;
    await s.tick();
    s.send(AI_DRAFT);
    await s.c.onContext(s.ctx());
    await s.tick();
    expect(s.posts).toHaveLength(1);
    // a second AI reply opens straight into a new composer, already filled
    s.front.draftBody = AI_DRAFT.replace("Hi Dana", "Hi again Dana");
    await s.c.onContext(s.ctx());
    expect(s.c.state().status).toBe("Draft found in the composer · 27 words");
    s.send(AI_DRAFT.replace("Hi Dana", "Hi again Dana"), "msg_sent_2");
    await s.c.onContext(s.ctx());
    await s.tick();
    expect(s.posts).toHaveLength(2);
    expect(s.posts[1]!.body.sent.text).toContain("Hi again Dana");
  });

  it("a discarded draft records nothing, and an earlier reply is never taken as the send", async () => {
    const s = setup({ query: "?require_reason=false" });
    s.front.draftBody = "";
    await s.c.onContext(s.ctx());
    s.front.draftBody = AI_DRAFT;
    await s.tick();
    s.front.draftBody = null; // discarded: no new outbound message
    await s.c.onContext(s.ctx());
    for (let i = 0; i <= SEND_WAIT_POLLS + 1; i++) await s.tick();
    expect(s.posts).toHaveLength(0);
    expect(s.c.state().status).toBe("Waiting for a draft");
    // a reply sent later, with no draft in front of the teammate, is not captured
    s.send("<p>Typed by hand.</p>", "msg_later");
    await s.tick();
    expect(s.posts).toHaveLength(0);
  });

  it("reads every page of a long thread", async () => {
    const s = setup({ query: "?require_reason=false" });
    for (let i = 0; i < 120; i++) {
      s.front.messages.push({
        id: `msg_${i}`,
        status: i % 2 ? "outbound" : "inbound",
        date: new Date(Date.UTC(2026, 9, 1, 10, 6, i)),
        content: { body: `<p>message ${i}</p>` },
        from: { handle: "x@example.com", name: undefined },
      });
    }
    s.front.draftBody = "";
    await s.c.onContext(s.ctx());
    s.front.draftBody = AI_DRAFT;
    await s.tick();
    s.send(AI_DRAFT);
    await s.c.onContext(s.ctx());
    await s.tick();
    expect(s.posts).toHaveLength(1);
    expect(s.posts[0]!.body.context).toHaveLength(123);
  });

  it("decision fields: read when the draft appears and again after the send", async () => {
    const s = setup({ query: "?decision_fields=coverage&require_reason=false" });
    s.front.draftBody = "";
    await s.c.onContext(s.ctx());
    s.front.draftBody = AI_DRAFT;
    await s.tick();
    s.front.coverage = "denied";
    s.send(AI_DRAFT);
    await s.c.onContext(s.ctx());
    await s.tick();
    expect(s.posts[0]!.body.draft.fields).toEqual({ coverage: "covered" });
    expect(s.posts[0]!.body.sent.fields).toEqual({ coverage: "denied" });
  });

  it("a scope tag: a conversation without it is never read, not even the draft", async () => {
    const s = setup({ query: "?scope_tag=ai_drafted" });
    s.front.draftBody = AI_DRAFT;
    await s.c.onContext(s.ctx());
    await s.tick();
    expect(s.front.reads).toEqual({ fetchDraft: 0, listMessages: 0, listComments: 0 });
    expect(s.gets).toHaveLength(0);
    expect(s.c.state()).toMatchObject({ watching: false, status: 'Not watching: no "ai_drafted" tag' });

    const tagged = setup({ query: "?scope_tag=ai_drafted", tags: ["ai_drafted"] });
    tagged.front.draftBody = AI_DRAFT;
    await tagged.c.onContext(tagged.ctx());
    expect(tagged.c.state().watching).toBe(true);
  });

  it("a draft recorded with the SDK is found by fr:<conversation id> and attaches to its run", async () => {
    const recorded = {
      id: "0199a0d0-0000-7000-8000-000000000000",
      output: "Recorded reply.",
      model: "gpt-4.1-mini",
    };
    const s = setup({ recorded, query: "?require_reason=false" });
    await s.c.onContext(s.ctx());
    expect(s.gets[0]).toBe(
      "https://api.overturn.run/v1/runs?externalId=fr%3Acnv_1&agent=support-reply&limit=1",
    );
    expect(s.c.state().status).toBe("Draft recorded by your agent · 2 words");
    s.front.draftBody = "Recorded reply.";
    await s.c.onContext(s.ctx());
    s.send("Recorded reply.");
    await s.c.onContext(s.ctx());
    await s.tick();
    expect(s.posts[0]!.body).toMatchObject({ draftRunId: recorded.id, draftModel: "gpt-4.1-mini" });
  });

  it("'Use the current text as the draft' marks a typed reply by hand", async () => {
    const s = setup({ query: "?require_reason=false" });
    s.front.draftBody = "";
    await s.c.onContext(s.ctx());
    s.front.draftBody = "Short typed answer.";
    await s.tick();
    expect(s.c.state().status).toBe("Waiting for a draft");
    await s.c.markCurrentAsDraft();
    expect(s.c.state().status).toBe("Draft marked by you · 3 words");
    s.send("Short typed answer.");
    await s.c.onContext(s.ctx());
    await s.tick();
    expect(s.posts[0]!.body.tags).toEqual(["draft:manual", "public-reply"]);
  });

  it("switching conversation starts fresh and drops a held capture", async () => {
    const s = setup();
    s.front.draftBody = "";
    await s.c.onContext(s.ctx());
    s.front.draftBody = AI_DRAFT;
    await s.tick();
    s.send(AI_DRAFT.replace("covered", "not covered"));
    await s.c.onContext(s.ctx());
    await s.tick();
    expect(s.c.state().held).toBe(true);
    await s.c.onContext(s.ctx("cnv_2"));
    expect(s.c.state()).toMatchObject({ held: false, status: "Waiting for a draft" });
    await s.c.pickReason("wrong_answer");
    expect(s.posts).toHaveLength(0);
    await s.c.onContext(null);
    expect(s.c.state()).toMatchObject({ watching: false, status: "Open a conversation" });
  });

  it("a Front read failing is logged, not thrown", async () => {
    const s = setup();
    const ctx = s.ctx();
    ctx.fetchDraft = () => Promise.reject(new Error("bridge closed"));
    s.front.draftBody = AI_DRAFT;
    await expect(
      s.c.onContext({ ...ctx, conversation: { ...ctx.conversation, draftId: "dra_1" } }),
    ).resolves.toBeUndefined();
    expect(s.log).toHaveBeenCalledWith("poll failed", expect.anything());
  });
});
