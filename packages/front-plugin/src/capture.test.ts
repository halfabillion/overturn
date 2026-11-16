import { captureCreateSchema } from "@overturn-ai/shared";
import { describe, expect, it } from "vitest";
import {
  type ConversationSnapshot,
  contextFrom,
  createDraftDetector,
  DEFAULT_SETTINGS,
  decideOnSend,
  decisionFieldsFrom,
  findSentMessage,
  inScope,
  quickReasons,
  settingsFrom,
  settingsFromQuery,
  statusLine,
  stripHtml,
} from "./capture";

const draftText =
  "<p>Hi Dana,</p><p>Thanks for the photos. Storm damage to the roof is covered under your HO-3 policy. An adjuster will contact you within 5 business days.</p>";

const conversation: ConversationSnapshot = {
  id: "cnv_55c8c149",
  subject: "Roof leak after storm",
  recipientHandle: "dana@example.com",
  recipientName: "Dana",
  messages: [
    {
      id: "msg_1",
      status: "inbound",
      body: "<div>Water came through the ceiling.<br>Photos attached.</div>",
      fromHandle: "dana@example.com",
      date: "2026-10-01T10:00:00.000Z",
    },
    {
      id: "msg_2",
      status: "outbound",
      body: `${draftText}<div class="front-blockquote">On Oct 1, Dana wrote: Water came through…</div>`,
      fromHandle: "claims@carrier.com",
      date: "2026-10-01T10:30:00.000Z",
    },
  ],
  comments: [
    {
      id: "com_1",
      body: "HO-3, no prior claims.",
      authorName: "Ray",
      createdAt: "2026-10-01T10:10:00.000Z",
    },
  ],
  fields: {},
  url: "https://app.frontapp.com/open/cnv_55c8c149",
};

describe("settings", () => {
  it("parses the plugin URL's query string under the Zendesk app's parameter names", () => {
    const s = settingsFromQuery(
      "?overturn_base_url=https://ov.internal/&agent=claims-reply&require_reason=true&decision_fields=coverage,%20cf_2:reserve&min_draft_chars=120&overturn_api_key=ov_live_x",
    );
    expect(s.baseUrl).toBe("https://ov.internal");
    expect(s.agent).toBe("claims-reply");
    expect(s.apiKey).toBe("ov_live_x");
    expect(s.requireReason).toBe(true);
    expect(s.decisionFields).toEqual([
      { id: "coverage", label: "coverage" },
      { id: "cf_2", label: "reserve" },
    ]);
    expect(s.minDraftChars).toBe(120);
  });

  it("falls back to defaults, with require_reason on, the support pack and no key (Front's relay)", () => {
    expect(settingsFrom({})).toEqual(DEFAULT_SETTINGS);
    expect(settingsFromQuery("")).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS.apiKey).toBeNull();
    expect(settingsFromQuery("?require_reason=false").requireReason).toBe(false);
    expect(settingsFromQuery("?min_draft_chars=nope").minDraftChars).toBe(80);
  });

  it("a scope tag limits which conversations are watched at all", () => {
    expect(inScope(["billing"], DEFAULT_SETTINGS)).toBe(true);
    const scoped = settingsFromQuery("?scope_tag=ai_drafted");
    expect(inScope(["billing"], scoped)).toBe(false);
    expect(inScope(["billing", "ai_drafted"], scoped)).toBe(true);
  });

  it("reason_pack picks the chips: support by default, claims when a claims team opts in", () => {
    const support = quickReasons(DEFAULT_SETTINGS).map((r) => r.code);
    expect(support).toContain("wrong_answer");
    expect(support).toContain("should_escalate");
    expect(support).not.toContain("reserve_too_low");
    const claims = quickReasons(settingsFromQuery("?reason_pack=claims")).map((r) => r.code);
    expect(claims).toHaveLength(8);
    expect(claims).toContain("wrong_coverage_decision");
    expect(settingsFromQuery("?reason_pack=garbage").reasonPack).toBe("support");
  });
});

describe("draft detection", () => {
  const long = "x".repeat(200);
  it("a reply-sized insert into an empty composer is the draft; typing is not", () => {
    const d = createDraftDetector({ minDraftChars: 80 });
    expect(d.onComposer("", 0)).toBeNull();
    let text = "";
    for (let i = 1; i <= 100; i++) {
      text += "ab";
      expect(d.onComposer(text, i * 100)).toBeNull();
    }
    expect(d.current()).toBeNull();
    const d2 = createDraftDetector({ minDraftChars: 80 });
    d2.onComposer("", 0);
    expect(d2.onComposer(long, 500)?.origin).toBe("inserted");
    expect(d2.onComposer(`${long} more`, 600)).toBeNull(); // only the first
  });
  it("a composer that already holds a reply on load is a preloaded draft", () => {
    const d = createDraftDetector({ minDraftChars: 80 });
    expect(d.onComposer(long, 10)?.origin).toBe("preloaded");
  });
  it("a paste after a pause while a short greeting was typed still counts", () => {
    const d = createDraftDetector({ minDraftChars: 80 });
    d.onComposer("", 0);
    d.onComposer("Hi Dana,", 1000);
    expect(d.onComposer(`Hi Dana,\n${long}`, 9000)?.origin).toBe("inserted");
  });
});

describe("context and html", () => {
  it("strips html, entities and Front's quoted thread", () => {
    expect(stripHtml("<p>a&nbsp;b</p><p>c<br>d</p>")).toBe("a b\nc\nd");
    expect(stripHtml("<p>Tom &amp; Jerry &lt;3</p>")).toBe("Tom & Jerry <3");
    expect(stripHtml("&amp;lt;")).toBe("&lt;"); // decoded once, not twice
    expect(stripHtml('<p>Yes.</p><div class="front-blockquote">On Monday you wrote: <p>old</p></div>')).toBe(
      "Yes.",
    );
    expect(stripHtml("<p>Yes.</p><blockquote>old</blockquote><p>Thanks</p>")).toBe("Yes.\nThanks");
  });

  it("interleaves messages and internal comments oldest first, with Front's roles", () => {
    expect(contextFrom(conversation)).toEqual([
      {
        role: "customer",
        author: "dana@example.com",
        content: "Water came through the ceiling.\nPhotos attached.",
        at: "2026-10-01T10:00:00.000Z",
      },
      { role: "note", author: "Ray", content: "HO-3, no prior claims.", at: "2026-10-01T10:10:00.000Z" },
      {
        role: "agent",
        author: "claims@carrier.com",
        content: stripHtml(draftText),
        at: "2026-10-01T10:30:00.000Z",
      },
    ]);
  });

  it("drops empty messages (attachments only, calls)", () => {
    const c = { ...conversation, messages: [{ id: "m", status: "inbound", body: "<p> </p>" }], comments: [] };
    expect(contextFrom(c)).toEqual([]);
  });
});

describe("findSentMessage", () => {
  const messages = conversation.messages;
  it("is the first outbound message that was not there when the draft appeared", () => {
    expect(findSentMessage(messages, new Set())?.id).toBe("msg_2");
    expect(findSentMessage(messages, new Set(["msg_2"]))).toBeNull();
  });
  it("never takes a customer's message as the send", () => {
    expect(findSentMessage([messages[0]!], new Set())).toBeNull();
  });
});

describe("decisionFieldsFrom", () => {
  const attributes = [
    { id: "cf_1", name: "coverage", value: "covered" },
    { id: "cf_2", name: "Reserve", value: 4000 },
    { id: "cf_3", name: "decided_at", value: new Date("2026-10-01T00:00:00.000Z") },
  ];
  it("reads the configured fields by name or id, under their labels", () => {
    const settings = settingsFromQuery("?decision_fields=coverage,cf_2:reserve,decided_at,missing");
    expect(decisionFieldsFrom(attributes, settings)).toEqual({
      coverage: "covered",
      reserve: 4000,
      decided_at: "2026-10-01T00:00:00.000Z",
      missing: null,
    });
  });
  it("reads nothing when no decision fields are configured", () => {
    expect(decisionFieldsFrom(attributes, DEFAULT_SETTINGS)).toEqual({});
  });
});

describe("decideOnSend", () => {
  const draft = { text: draftText, origin: "inserted" as const, at: 1 };
  const before = { ...conversation, messages: conversation.messages.slice(0, 1) };
  const base = {
    conversation: before,
    draft,
    draftFields: {},
    reasonCode: null as string | null,
    reason: "",
    actor: "ray@carrier.com",
    now: 60_001,
    // require_reason is on by default; most cases here test the capture shape, so relax it.
    settings: { ...DEFAULT_SETTINGS, requireReason: false },
  };

  it("skips without a draft and on empty sends", () => {
    expect(decideOnSend({ ...base, draft: null, send: { text: "x", messageId: null, fields: {} } })).toEqual({
      action: "skip",
      why: "no-draft",
    });
    expect(decideOnSend({ ...base, send: { text: "<p></p>", messageId: null, fields: {} } })).toEqual({
      action: "skip",
      why: "empty",
    });
  });

  it("sending the draft unchanged is an approve capture with source front and an fr: externalId", () => {
    const d = decideOnSend({ ...base, send: { text: draftText, messageId: null, fields: {} } });
    expect(d.action).toBe("capture");
    if (d.action !== "capture") return;
    expect(d.changed).toBe(false);
    expect(d.body.source).toBe("front");
    expect(d.body.externalId).toBe("fr:cnv_55c8c149");
    expect(d.body.agent).toBe("support-reply");
    expect(d.body.actor).toBe("ray@carrier.com");
    expect(d.body.subject).toBe("Roof leak after storm");
    expect(d.body.url).toBe("https://app.frontapp.com/open/cnv_55c8c149");
    expect(d.body.draft.text).toBe(d.body.sent.text);
    expect(d.body.reasonCode).toBeNull();
    expect(d.body.tags).toEqual(["draft:inserted", "public-reply"]);
    expect(d.body.metadata).toEqual({ requester: "dana@example.com" });
    expect(d.body.context).toHaveLength(2);
    // the body is exactly what POST /v1/capture accepts
    expect(captureCreateSchema.parse(d.body)).toMatchObject({
      source: "front",
      externalId: "fr:cnv_55c8c149",
    });
  });

  it("the sent message itself is not part of the context the teammate saw", () => {
    const d = decideOnSend({
      ...base,
      conversation,
      send: { text: conversation.messages[1]!.body, messageId: "msg_2", fields: {} },
    });
    if (d.action !== "capture") throw new Error(d.action);
    expect(d.body.context.map((m) => m.role)).toEqual(["customer", "note"]);
    // the quoted thread under the sent reply does not count as a change
    expect(d.changed).toBe(false);
  });

  it("a changed reply is an edit capture carrying the reason", () => {
    const sent = draftText.replace("5 business days", "2 business days");
    const d = decideOnSend({
      ...base,
      reasonCode: "wrong_answer",
      reason: "  Storm SLA is 2 days ",
      send: { text: sent, messageId: null, fields: {} },
    });
    expect(d.action).toBe("capture");
    if (d.action !== "capture") return;
    expect(d.changed).toBe(true);
    expect(d.body.reason).toBe("Storm SLA is 2 days");
    expect(d.body.reasonCode).toBe("wrong_answer");
    expect(d.body.sent.text).toContain("2 business days");
    expect(d.body.sent.fields).toBeUndefined();
    expect(captureCreateSchema.safeParse(d.body).success).toBe(true);
  });

  it("require_reason (the default) holds a changed send until a reason code is picked; a note alone is not enough", () => {
    expect(DEFAULT_SETTINGS.requireReason).toBe(true);
    const settings = DEFAULT_SETTINGS;
    const sent = draftText.replace("covered", "not covered");
    const send = { text: sent, messageId: null, fields: {} };
    expect(decideOnSend({ ...base, settings, send })).toEqual({ action: "need-reason", changedFields: [] });
    expect(decideOnSend({ ...base, settings, reason: "exclusion", send }).action).toBe("need-reason");
    expect(decideOnSend({ ...base, settings, reasonCode: "  ", send }).action).toBe("need-reason");
    const ok = decideOnSend({ ...base, settings, reasonCode: "wrong_answer", send });
    expect(ok.action).toBe("capture");
    if (ok.action === "capture") expect(ok.body.reasonCode).toBe("wrong_answer");
    const unchanged = decideOnSend({
      ...base,
      settings,
      send: { text: draftText, messageId: null, fields: {} },
    });
    expect(unchanged.action).toBe("capture");
  });

  it("a reason code picked for an unchanged reply is not sent", () => {
    const d = decideOnSend({
      ...base,
      reasonCode: "wrong_answer",
      send: { text: draftText, messageId: null, fields: {} },
    });
    if (d.action !== "capture") throw new Error(d.action);
    expect(d.body.reasonCode).toBeNull();
  });

  it("decision fields ride along and a changed field is a change", () => {
    const settings = { ...DEFAULT_SETTINGS, decisionFields: [{ id: "cf_1", label: "coverage" }] };
    const d = decideOnSend({
      ...base,
      settings,
      reasonCode: "wrong_answer",
      draftFields: { coverage: "covered" },
      send: { text: draftText, messageId: null, fields: { coverage: "denied" } },
    });
    expect(d.action).toBe("capture");
    if (d.action !== "capture") return;
    expect(d.changed).toBe(true);
    expect(d.changedFields).toEqual(["coverage"]);
    expect(d.body.draft.fields).toEqual({ coverage: "covered" });
    expect(d.body.sent.fields).toEqual({ coverage: "denied" });
  });

  it("records how long the draft sat in front of the expert", () => {
    const d = decideOnSend({
      ...base,
      draft: { text: draftText, origin: "inserted", at: 10_000 },
      now: 14_250,
      send: { text: draftText, messageId: null, fields: {} },
    });
    if (d.action !== "capture") throw new Error(d.action);
    expect(d.body.secondsToSend).toBe(4.3);
  });

  it("a draft left in the composer for weeks stays within the API's 30-day cap", () => {
    const d = decideOnSend({
      ...base,
      now: 1 + 86_400_000 * 45,
      send: { text: draftText, messageId: null, fields: {} },
    });
    if (d.action !== "capture") throw new Error(d.action);
    expect(d.body.secondsToSend).toBe(86_400 * 30);
    expect(captureCreateSchema.safeParse(d.body).success).toBe(true);
  });

  it("a recorded draft attaches to its run", () => {
    const d = decideOnSend({
      ...base,
      draft: {
        text: draftText,
        origin: "recorded",
        runId: "0199a0d0-0000-7000-8000-000000000000",
        model: "gpt-4.1-mini",
        at: 1,
      },
      send: { text: draftText, messageId: null, fields: {} },
    });
    if (d.action !== "capture") throw new Error(d.action);
    expect(d.body.draftRunId).toBe("0199a0d0-0000-7000-8000-000000000000");
    expect(d.body.draftModel).toBe("gpt-4.1-mini");
    expect(d.body.tags).toEqual(["draft:recorded", "public-reply"]);
  });
});

describe("statusLine", () => {
  it("describes the state", () => {
    expect(statusLine(null, null)).toBe("Waiting for a draft");
    expect(statusLine({ text: "<p>one two</p><p>three</p>", origin: "inserted", at: 1 }, null)).toBe(
      "Draft inserted · 3 words",
    );
    expect(statusLine({ text: "one two three", origin: "manual", at: 1 }, null)).toBe(
      "Draft marked by you · 3 words",
    );
    expect(statusLine(null, { kind: "approve", changed: false, dedup: false })).toBe(
      "Sent as drafted · approved",
    );
    expect(statusLine(null, { kind: "edit", changed: true, dedup: true })).toBe(
      "Captured · already in the suite",
    );
    expect(statusLine(null, null, true)).toBe("Changed · pick why to record it");
  });
});
