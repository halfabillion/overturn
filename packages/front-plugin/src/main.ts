import Front, { HttpVerbsEnum } from "@frontapp/plugin-sdk";
import { quickReasons, settingsFromQuery } from "./capture";
import { createCaptureController, type Transport } from "./front";

class HttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

const parse = (body: unknown): unknown => {
  if (typeof body !== "string") return body;
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
};

/**
 * With `overturn_api_key` in the plugin URL the plugin calls Overturn directly. Without it, requests
 * go through Front's relay, which adds the bearer token configured on the Front app server-side,
 * so no key ever reaches the browser.
 */
function transportFor(baseKey: string | null): Transport {
  if (baseKey) {
    const call = async <T>(url: string, init: RequestInit): Promise<T> => {
      const r = await fetch(url, {
        ...init,
        headers: { Authorization: `Bearer ${baseKey}`, "Content-Type": "application/json" },
      });
      if (!r.ok) throw new HttpError(r.status);
      return (await r.json()) as T;
    };
    return {
      get: (url) => call(url, { method: "GET" }),
      post: (url, body) => call(url, { method: "POST", body: JSON.stringify(body) }),
    };
  }
  const relay = async <T>(verb: HttpVerbsEnum, url: string, body?: unknown): Promise<T> => {
    const r = await Front.relayHttp({
      verb,
      url,
      headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body }),
    });
    if (r.status < 200 || r.status >= 300) throw new HttpError(r.status);
    return parse(r.body) as T;
  };
  return {
    get: (url) => relay(HttpVerbsEnum.GET, url),
    post: (url, body) => relay(HttpVerbsEnum.POST, url, body),
  };
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text !== undefined) e.textContent = text;
  return e;
}

function main(): void {
  const settings = settingsFromQuery(location.search);
  const root = document.getElementById("app")!;
  const status = el("div", { class: "status", role: "status" }, "Open a conversation");
  // One click picks the reason (what the scorecard counts); the note is optional detail.
  const quick = el("div", { class: "quick", role: "radiogroup", "aria-label": "Why did you change it?" });
  const chips: HTMLButtonElement[] = [];
  const reason = el("textarea", { class: "reason", rows: "2", placeholder: "Anything else? Optional." });
  const mark = el("button", { type: "button", class: "link" }, "Use the current text as the draft");
  const note = el("div", { class: "note" }, "");
  const controls = el("div");
  controls.append(quick, reason, mark);
  root.append(status, controls, note);

  const controller = createCaptureController({
    settings,
    transport: transportFor(settings.apiKey),
    onChange: () => render(),
  });

  for (const q of quickReasons(settings)) {
    const b = el("button", { type: "button", class: "chip", "data-code": q.code }, q.label);
    b.addEventListener("click", () => void controller.pickReason(q.code));
    chips.push(b);
    quick.appendChild(b);
  }
  reason.addEventListener("input", () => controller.setNote(reason.value));
  mark.addEventListener("click", () => void controller.markCurrentAsDraft());

  function render(): void {
    const s = controller.state();
    status.textContent = s.status;
    controls.hidden = !s.watching;
    note.textContent = s.message;
    for (const c of chips) c.classList.toggle("on", c.dataset.code === s.reasonCode);
    if (reason.value !== s.reason && document.activeElement !== reason) reason.value = s.reason;
    if (s.held) chips[0]?.focus();
  }
  render();

  Front.contextUpdates.subscribe((ctx) => {
    void controller.onContext(ctx.type === "singleConversation" ? ctx : null);
  });
  // Front sends no context update while the teammate types, so the draft is re-read on a timer.
  setInterval(() => void controller.poll(), 1500);
}

main();
