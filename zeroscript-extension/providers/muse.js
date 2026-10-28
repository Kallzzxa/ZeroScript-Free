// SPDX-License-Identifier: GPL-3.0-or-later
// providers/muse.js - the Muse (muse.ai) provider.
// Exports the same ZSProvider interface as providers/meta.js; the core
// (core/main.js) is provider-agnostic. To DISABLE Muse support, remove this
// file from manifest.json (and its URL from background.js PROVIDER_URLS).
//
// ── VALIDATION STATUS (read this before trusting the selectors) ──────────
// This adapter was written WITHOUT a live look at muse.ai's chat DOM: the
// inspection browser refused the whole muse.ai domain (enterprise policy
// block), so no composer, send button, or message markup could be captured.
// Every selector below is therefore a LAYERED FALLBACK, tried in order, over
// the shapes modern React chat apps normally use (real <textarea> first, then
// contenteditable / role=textbox editors; aria-labelled Send/Stop buttons;
// data-testid / data-role message markers, then alignment). It is NOT yet
// validated live on muse.ai. Live-test history (user's own browser):
//  - 2026-10-28: bar v1.5.6 DID mount on muse.ai/thread/new, but Start failed
//    with the core's "Muse mode not ready" banner, because getEditor() was
//    null at Start time: the composer selector required
//    [contenteditable="true"] and missed other contenteditable spellings.
//    Fix in 1.5.7: contenteditable matched without a value (covers "true",
//    "plaintext-only", empty) + a retry loop in ensureComposerReady for late
//    hydration. A full command turn has still not succeeded.
//  - 2026-10-28 (later): user pasted the REAL composer markup from Inspect.
//    The composer IS a plain <textarea> (aria-label="Message",
//    placeholder="Message", data-hatch-composer-prehydration-input, inside a
//    relative flex row with a file input and a placeholder overlay span) -
//    which BOTH the 1.5.6 and 1.5.7 selectors should have matched. Since
//    getEditor() still returned null, that textarea is NOT in the top-level
//    document: the chat UI must render inside a shadow root or an iframe.
//    Fix in 1.5.8: qAllDeep() searches shadow roots and same-origin iframe
//    documents whenever the top document has no match.
//
// Muse DOM notes (assumed, NOT validated live):
//  - React app. The composer is expected to be a <textarea> or a
//    contenteditable element; the send control an aria-labelled button that
//    becomes a Stop control while generating.
//  - Assistant/user turns are told apart by, in order: an explicit author-role
//    attribute, assistant/user markers in testid/class, the text of a message
//    the extension itself sent (user turns), and bubble alignment (user right,
//    assistant left - the usual chat layout).
//  - Code blocks are expected to be <pre><code>; <pre> is special-cased so
//    per-line spans without newline text nodes do not collapse multi-line Lua
//    (same fix class as Meta's <pre> handling and GLM's .cm-line).
// eslint-disable-next-line no-unused-vars
const ZSProvider = (() => {
  "use strict";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let diag = () => {}; // injected by core via init()
  // Texts the extension itself sent (normalised). A turn whose text equals one
  // of these is a USER turn even when the DOM carries no author marker.
  const _sentTexts = [];
  const _norm = (t) => (t || "").replace(/\s+/g, " ").trim();
  const _rememberSent = (t) => {
    const n = _norm(t);
    if (n) { _sentTexts.push(n); if (_sentTexts.length > 40) _sentTexts.shift(); }
  };
  // Whether the composer is locked (agent working). Re-asserted every sweep
  // (enforceComposer) because React re-renders the composer subtree.
  let _locked = false;

  // Candidate selectors, tried in order. Nothing here is Muse-confirmed markup
  // (see header) - each list degrades gracefully to the next candidate.
  const S = {
    // Composer candidates (visible one wins). contenteditable is matched
    // WITHOUT a value on purpose: besides "true", modern chat composers use
    // "plaintext-only" or an empty attribute, all of which the old
    // [contenteditable="true"] selector missed (that miss is exactly what made
    // Start fail with "Muse mode not ready" on 2026-10-28: the bar mounted,
    // but getEditor() was null, so ensureComposerReady reported not-ready).
    editor: 'textarea:not([readonly]), [contenteditable]:not([contenteditable="false"]), [role="textbox"]',
    // Send / stop buttons (visible, enabled one wins).
    sendBtn: 'button[aria-label*="send" i], button[type="submit"]',
    stopBtn: 'button[aria-label*="stop" i]',
    // Turn candidates (topmost match wins; nested matches are dropped).
    turn: '[data-testid*="message"], [data-message-author-role], [data-role*="message"], article, [class*="message-bubble"]',
    // Assistant markers inside a turn's own testid/class.
    asstMark: /assistant|ai-response|ai-message|model-response|bot-response/i,
    userMark: /user-message|user-response|human-message/i,
    // Alignment markers (chat layout: user right, assistant left).
    userAlign: /ml-auto|ms-auto|self-end|justify-end|items-end/i,
    asstAlign: /mr-auto|me-auto|self-start|justify-start|items-start/i,
    // Reasoning blocks inside an assistant reply: excluded from read text.
    reasoning: '[data-testid*="thinking"], [class*="thinking"], [class*="reasoning"], [class*="thought"]',
    // Code wrappers (for camouflage masking of command blocks).
    codeWrap: "pre, [class*=\"code-block\"], [class*=\"codeblock\"]",
    errorSurfaces:
      '[role="alert"],[class*="toast"],[class*="error"],[class*="alert"]',
  };

  const RE = {
    contextLimit: new RegExp(
      [
        "conversation.{0,20}(too long)",
        "context.{0,20}(limit|exceeded)",
        "please.{0,30}(start).{0,20}(new).{0,20}(chat|conversation)",
        "(token|context).{0,10}limit",
        "maximum.{0,20}context",
        "this conversation has reached",
      ].join("|"),
      "i"
    ),
    tooLong: /conversation .{0,20}(too long|getting too long)/i,
    busy: /something went wrong|try again later|rate limit|too many requests/i,
  };

  // No stop-button signal can be relied on before live validation, so the
  // idle windows are a little looser than Meta's tight ones.
  const timings = {
    GEN_IDLE_MS: 2500,
    REASON_IDLE_MS: 12000,
    WARMUP_MS: 45000,
    REASON_NOREPLY_MS: 90000,
    STABLE_MS: 9000,
    RESPONSE_TIMEOUT_MS: 300000,
  };

  // ── Deep query (shadow DOM + iframes) ─────────────────────────────────────
  // The composer the user pasted from Inspect is a plain <textarea> that the
  // top-level document query could NOT see, so the chat UI must live inside a
  // shadow root or an iframe. qAllDeep() therefore tries the top document
  // first (fast path, same as before) and only falls back to a recursive
  // scan of shadow roots and same-origin iframe documents when the top
  // document has no match at all. The discovered roots are cached (the set of
  // shadow hosts / frames rarely changes) and rescanned only after a deep
  // query comes up empty, so a late-mounted chat tree is still picked up.
  let _deepRoots = null;
  function deepRoots() {
    if (_deepRoots) return _deepRoots;
    const roots = [];
    const seen = new Set([document]);
    const walk = (root) => {
      for (const el of root.querySelectorAll("*")) {
        if (el.shadowRoot && !seen.has(el.shadowRoot)) {
          seen.add(el.shadowRoot);
          roots.push(el.shadowRoot);
          walk(el.shadowRoot);
        }
      }
      for (const fr of root.querySelectorAll("iframe")) {
        try {
          const d = fr.contentDocument;
          if (d && !seen.has(d)) { seen.add(d); roots.push(d); walk(d); }
        } catch {}
      }
    };
    walk(document);
    _deepRoots = roots;
    return roots;
  }
  const _notOurs = (e) => !e.closest("#zs-root");
  function qAllDeep(selector) {
    const top = [...document.querySelectorAll(selector)].filter(_notOurs);
    if (top.length) return top;
    const out = [];
    for (const r of deepRoots()) {
      try { for (const el of r.querySelectorAll(selector)) if (_notOurs(el)) out.push(el); } catch {}
    }
    if (!out.length) _deepRoots = null; // rescan next time (late mount)
    return out;
  }

  // ── Turn list ──────────────────────────────────────────────────────────────
  // Collect candidate turns, then keep only the TOPMOST ones: a candidate
  // contained in another candidate is part of that turn, not a turn itself.
  // Excludes the extension's own UI (#zs-root) and empty nodes.
  function domTurns() {
    const all = qAllDeep(S.turn).filter((e) => (e.textContent || "").trim().length > 0);
    const top = all.filter((e) => !all.some((o) => o !== e && o.contains(e)));
    // A turn list must read in document order; querySelectorAll already does.
    return top;
  }

  function turnMarkers(item) {
    const cls = typeof item.className === "string" ? item.className : "";
    const t = (item.getAttribute("data-testid") || "") + " " + cls;
    const role = (item.getAttribute("data-message-author-role") || item.getAttribute("data-role") || "").toLowerCase();
    return { t, role };
  }
  function isAssistantItem(item) {
    if (!item) return false;
    const { t, role } = turnMarkers(item);
    if (role === "assistant" || role === "model" || role === "ai") return true;
    if (role === "user" || role === "human") return false;
    if (S.userMark.test(t)) return false;
    if (S.asstMark.test(t)) return true;
    // Sent-text match: this turn is one the extension sent -> user turn.
    if (_sentTexts.includes(_norm(item.textContent))) return false;
    // Alignment fallback: right-aligned bubble = user, left = assistant.
    if (S.userAlign.test(t)) return false;
    if (S.asstAlign.test(t)) return true;
    // Unmarked, unaligned, unsent: default to assistant so the loop still
    // reads the latest reply (the common case right after a send).
    return true;
  }
  const isUserItem = (item) => !!item && !isAssistantItem(item);

  const allItems = () => domTurns();
  const assistantItems = () => allItems().filter(isAssistantItem);
  const assistantCount = () => assistantItems().length;
  const userCount = () => allItems().filter(isUserItem).length;
  const lastAssistant = () => {
    const it = assistantItems();
    return it.length ? it[it.length - 1] : null;
  };

  // Stable per-NODE id for the latest assistant turn (the core prefers this
  // over count-based detection when reliableCounts is false).
  const _idMap = new WeakMap();
  let _idSeq = 0;
  function lastAssistantId() {
    const it = lastAssistant();
    if (!it) return null;
    let id = _idMap.get(it);
    if (!id) { id = ++_idSeq; _idMap.set(it, id); }
    return id;
  }

  const chatIsEmpty = () => allItems().length === 0;

  // ── Text extraction ─────────────────────────────────────────────────────────
  // Walk the tree skipping the core's chip and reasoning blocks. A <pre> is
  // special-cased: code lines rendered as separate block spans with NO newline
  // text nodes collapse onto one line under plain textContent (breaks
  // multi-line Lua), so rebuild by joining the code element's line children.
  function textWithout(root, excludeSel) {
    if (!root) return "";
    const skip = ".zs-chip, " + S.reasoning + (excludeSel ? ", " + excludeSel : "");
    let t = "";
    const walk = (n) => {
      if (n.nodeType === 3) { t += n.nodeValue; return; }
      if (n.nodeType !== 1) return;
      if (n.matches && n.matches(skip)) return;
      if (n.tagName === "PRE") { t += preText(n); return; }
      for (const c of n.childNodes) walk(c);
    };
    walk(root);
    return t;
  }
  function preText(pre) {
    const code = pre.querySelector("code") || pre;
    const lines = [...code.children].filter((c) => c.nodeType === 1);
    if (lines.length) return lines.map((l) => l.textContent).join("\n");
    return code.textContent || "";
  }

  function bodyOf(item) { return item || null; }
  function itemText(item) {
    return item ? textWithout(item) : "";
  }
  function classifyText(item, excludeSel) {
    return item ? textWithout(item, excludeSel) : "";
  }

  // ── Chip anchor ─────────────────────────────────────────────────────────────
  // Anchor at the turn element itself: React reconciles inner content on
  // stream updates, and the turn element's identity survives (same reasoning
  // as Meta's chipAtItemLevel).
  function chipAnchor(item) { return item || null; }

  // ── Composer ────────────────────────────────────────────────────────────────
  const isVisible = (e) => !!e && e.offsetParent !== null && e.getClientRects().length > 0;
  const editorEls = () => qAllDeep(S.editor);
  // getEditor() = the ON-SCREEN editor (visible candidate wins; first match
  // otherwise). The core anchors covers/bars to this node, so it must be the
  // visible one, never a hidden mirror.
  const getEditor = () => editorEls().find(isVisible) || editorEls()[0] || null;
  const visibleEditor = getEditor; // alias (kept for call-site clarity)
  const isTextareaEditor = (e) => !!e && e.tagName === "TEXTAREA";
  const editorText = () => {
    const e = getEditor();
    if (!e) return "";
    return isTextareaEditor(e) ? (e.value || "") : (e.textContent || "");
  };
  // The rounded/bordered card around the composer; the core hugs the bar to it.
  function barAnchor() {
    const ed = visibleEditor();
    if (!ed) return null;
    let n = ed;
    for (let i = 0; i < 10 && n; i++, n = n.parentElement) {
      const c = typeof n.className === "string" ? n.className : "";
      if (/rounded|border/.test(c)) return n;
    }
    return (ed && ed.parentElement) || null;
  }
  const composerFrame = () => barAnchor() || (visibleEditor() && visibleEditor().parentElement) || null;

  // A fresh chat: no turns, composer present, root-ish path.
  const isFreshChat = () =>
    chatIsEmpty() && !!getEditor() &&
    (location.pathname === "/" || location.pathname === "/chat" || location.pathname.endsWith("/new"));

  // ── Input lock ──────────────────────────────────────────────────────────────
  function setInputLock(on) {
    _locked = on;
    applyLock();
  }
  function applyLock() {
    const ed = getEditor();
    if (!ed) return;
    if (isTextareaEditor(ed)) {
      if (_locked) ed.setAttribute("readonly", "");
      else ed.removeAttribute("readonly");
    } else {
      ed.setAttribute("contenteditable", _locked ? "false" : "true");
    }
  }

  // ── Buttons / generation detection ──────────────────────────────────────────
  const sendButton = () => {
    for (const b of qAllDeep(S.sendBtn)) {
      if (b.closest("#zs-root")) continue;
      if (!isVisible(b)) continue;
      if (b.disabled || b.getAttribute("aria-disabled") === "true") continue;
      return b;
    }
    return null;
  };
  const stopButton = () => {
    for (const b of qAllDeep(S.stopBtn)) {
      if (b.closest("#zs-root")) continue;
      if (isVisible(b)) return b;
    }
    return null;
  };

  function streamText(item) {
    const it = item === undefined ? lastAssistant() : item;
    return it ? textWithout(it, ".zs-chip") : "";
  }
  const streamLen = (item) => streamText(item).length;

  let _streamMax = -1, _streamAt = 0, _streamItem = null;
  function sampleStream() {
    const item = lastAssistant();
    const len = streamText(item).length;
    const now = Date.now();
    if (item !== _streamItem || len < _streamMax - 400) {
      _streamItem = item; _streamMax = len; _streamAt = now; return;
    }
    if (len > _streamMax) { _streamMax = len; _streamAt = now; }
  }
  const grewWithin = (ms) => _streamMax > 1 && Date.now() - _streamAt < ms;

  function genActive() {
    sampleStream();
    // Stop button present = generating (authoritative when it exists).
    if (stopButton()) return true;
    return grewWithin(timings.GEN_IDLE_MS);
  }
  const isGenerating = genActive;
  const isBusyNow = genActive;
  const isHardGenerating = () => !!stopButton();

  // Muse exposes no per-turn "stopped"/"continue" markers known to us.
  const turnHalted = () => false;
  const findContinueBtn = () => null;
  const clickContinueBtn = () => false;

  function snapshot() {
    try {
      const b = lastAssistant();
      return { th: 0, rp: b ? textWithout(b).length : 0 };
    } catch { return {}; }
  }

  function readAssistant() {
    const item = lastAssistant();
    if (!item) return { present: false, reply: "", thinking: "", item: null };
    return { present: true, reply: textWithout(item, ".zs-chip").trim(), thinking: "", item };
  }

  async function waitFor(pred, timeout) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (pred()) return true;
      await sleep(120);
    }
    return false;
  }

  // ── Image attachment ────────────────────────────────────────────────────────
  // NOT supported yet: Muse's attachment UI has not been mapped (see header),
  // so supportsVision is false and the core never offers screen_capture here.
  // These stubs keep the interface complete if the core ever calls them.
  async function attachImages() { return false; }
  function clearAttachments() {}

  // ── Sending ─────────────────────────────────────────────────────────────────
  function setTextareaValue(el, v) {
    const proto = window.HTMLTextAreaElement && window.HTMLTextAreaElement.prototype;
    const setter = proto && Object.getOwnPropertyDescriptor(proto, "value");
    if (setter && setter.set) setter.set.call(el, v);
    else el.value = v;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }
  function setEditableValue(el, v) {
    el.focus();
    try {
      // Preferred: insertText keeps React/contenteditable state consistent.
      const sel = window.getSelection();
      sel.selectAllChildren(el);
      if (!document.execCommand("insertText", false, v)) throw new Error("insertText failed");
    } catch {
      el.textContent = v;
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }
  function setEditorValue(el, v) {
    if (isTextareaEditor(el)) setTextareaValue(el, v);
    else setEditableValue(el, v);
  }

  async function typeAndSend(text) {
    const editor = getEditor();
    if (!editor) throw new Error("Muse input box not found");
    _rememberSent(text);
    setEditorValue(editor, text);
    const sendReady = () => !!sendButton();
    await waitFor(sendReady, 10000);
    // Click and CONFIRM the send took (the composer clears the instant Muse
    // accepts it). Fall back to Enter until it clears so a swallowed click
    // can't strand the message.
    let sent = false;
    for (let i = 0; i < 6 && !sent; i++) {
      const btn = sendButton();
      if (btn) {
        try { btn.click(); } catch {}
      } else {
        const o = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
        editor.dispatchEvent(new KeyboardEvent("keydown", o));
        editor.dispatchEvent(new KeyboardEvent("keyup", o));
      }
      sent = await waitFor(() => editorText().trim() === "", 700);
    }
    diag("muse.tas.sent", { sent, editorLen: editorText().length });
  }

  function stopGeneration() {
    const b = stopButton();
    if (b) { try { b.click(); } catch {} }
  }

  // ── Composer readiness ──────────────────────────────────────────────────────
  function enforceComposer() { if (_locked) applyLock(); return { ready: true }; }
  async function ensureComposerReady(reason) {
    // The core gates session start on .ready (main.js: the "mode not ready"
    // banner). Retry briefly: on a fresh /thread/new page the composer may
    // still be hydrating when Start is clicked, and a single instant check
    // would report not-ready even though the editor appears a moment later
    // (same retry shape as DeepSeek's ensureComposerReady).
    let editor = getEditor();
    for (let i = 0; i < 12 && !editor; i++) {
      await sleep(150);
      editor = getEditor();
    }
    // editorCandidates is remote-debugging aid: if Start still reports
    // not-ready, the [zs-diag] mode_ready line shows whether ANY composer
    // candidate exists at all (0 = selector still wrong / shadow DOM).
    diag("mode_ready", { reason, provider: "muse", ready: !!editor, editorCandidates: editorEls().length });
    return { ready: !!editor };
  }
  const modeWarning = () => "";
  const captchaPresent = () => false;
  function overlayBlocking() {
    for (const d of qAllDeep('[role="dialog"]')) {
      if (d.closest("#zs-root")) continue;
      const r = d.getBoundingClientRect();
      if (r.width > 40 && r.height > 40 && r.top < innerHeight && r.bottom > 0) return true;
    }
    return false;
  }

  // ── Error / limit detection (site chrome only, never model output) ───────────
  function scanError() {
    try {
      const turns = domTurns();
      for (const el of qAllDeep(S.errorSurfaces)) {
        if (el.offsetParent === null) continue;
        if (turns.some((t) => t.contains(el))) continue; // inside a chat turn => model content
        const t = (el.innerText || "").trim();
        if (t.length > 8 && t.length < 600 && RE.contextLimit.test(t)) return t.slice(0, 240);
      }
    } catch {}
    if (!getEditor()) return "The input box disappeared (session ended?).";
    return null;
  }
  const isTooLongMsg = (text) => RE.tooLong.test(text);
  const isBusyMsg = (text) => RE.busy.test(text);

  // / or /chat = a fresh chat with no conversation id yet -> "" (never
  // persisted as "started"). A real conversation keeps its path.
  const conversationKey = () =>
    (location.pathname === "/" || location.pathname === "/chat" ? "" : location.pathname);

  // ── User-send interception ──────────────────────────────────────────────────
  function installSendHooks(handlers) {
    document.addEventListener(
      "keydown",
      (e) => {
        if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
        const editor = visibleEditor();
        if (!editor || !editor.contains(e.target)) return;
        if (editorText().trim() === "") return;
        if (handlers.isBlocked()) return;
        if (!handlers.isStarted()) {
          if (!chatIsEmpty()) return; // existing conversation -> not ours to gate
          handlers.onBlockedAttempt();
          return;
        }
        handlers.onUserMessage(assistantCount());
      },
      true
    );

    document.addEventListener(
      "click",
      (e) => {
        if (!getEditor()) return;
        const btn = e.target && e.target.closest && e.target.closest("button");
        if (!btn) return;
        if (btn.closest(S.stopBtn) || btn.matches(S.stopBtn)) { handlers.onNativeStop(); return; }
        if (!(btn.closest(S.sendBtn) || btn.matches(S.sendBtn))) return;
        if (btn.disabled || btn.getAttribute("aria-disabled") === "true") return;
        if (handlers.isBlocked()) return;
        if (!handlers.isStarted()) {
          if (!chatIsEmpty()) return;
          handlers.onBlockedAttempt();
          return;
        }
        handlers.onUserMessage(assistantCount());
      },
      true
    );
  }

  // ── Tool-block location for camouflage ───────────────────────────────────────
  // Hide every code wrapper carrying a command shape, plus any bare top-level
  // block holding an inline command (mirrors Meta's two-part logic with
  // generic wrapper selectors).
  const CMD_SHAPE = /"(?:command|tool)"\s*:\s*"|###\s*lua|###mcp_tool###/i;
  function findToolBlockSpot(item /*, chip */) {
    const b = bodyOf(item);
    if (!b) return null;
    let hidAny = null;
    b.querySelectorAll(S.codeWrap).forEach((cw) => {
      if (cw.closest(".zs-chip")) return;
      if (CMD_SHAPE.test(cw.textContent || "")) {
        cw.classList.add("zs-tool-hide");
        b.classList.add("zs-cmd-mask");
        hidAny = hidAny || { parent: cw.parentElement, ref: cw };
      }
    });
    b.querySelectorAll("p, div").forEach((el) => {
      if (el.closest(".zs-chip, .zs-tool-hide, " + S.codeWrap)) return;
      if (el.querySelector(S.codeWrap)) return;
      const t = (el.textContent || "").trim();
      const t0 = t.replace(/^json\s*/i, "");
      const startsAsCmd = /^\{\s*"(?:command|tool)"\s*:/.test(t0) || /^###\s*(?:lua|mcp_tool)/i.test(t0);
      if ((startsAsCmd || t.length < 600) && CMD_SHAPE.test(t) && /^[{#]/.test(t0)) {
        el.classList.add("zs-tool-hide");
        hidAny = hidAny || { parent: el.parentElement, ref: el };
      }
    });
    return hidAny;
  }

  // Muse's web chat has no function-calling channel to the user's machine, so
  // Studio work must go through plain-text commands (same core rule, restated
  // for a model that may otherwise offer its own tools).
  const PROMPT_EXTRA =
    "You have no function-calling or tool API in this chat that reaches the " +
    "user's computer - do NOT offer to call tools, and do NOT wrap commands " +
    "in any tool-call markup. Write every ZeroScript command as plain text " +
    "inside a fenced code block, exactly as specified above.";

  return {
    id: "muse",
    displayName: "Muse",
    // Vision is OFF until Muse's attachment UI is mapped live (see header):
    // the core then hides screen_capture instead of offering a broken path.
    supportsVision: false,
    timings,
    // React reconciles a turn's content subtree on every update, wiping a chip
    // placed inside it. Anchor chips at the turn-element level instead.
    chipAtItemLevel: true,
    chipAnchor,
    chipAppend: true,
    // Turn detection is heuristic (see header), so counts are not trusted the
    // way Meta's are - the core falls back to lastAssistantId tracking.
    reliableCounts: false,
    // Shown in the bar while this provider is active: honest about the state.
    unstableWarning:
      "Muse support is experimental: its selectors are fallbacks and have not " +
      "been validated live on muse.ai yet. If turns are not detected, reload " +
      "the page and retry.",
    init({ diag: d } = {}) { if (d) diag = d; },
    // turns
    allItems, isUserItem, isAssistantItem, itemText, classifyText,
    assistantCount, userCount, lastAssistant, lastAssistantId, readAssistant,
    streamLen, snapshot,
    // Reasoning blocks inside a reply: the core excludes these from chips and
    // from the camouflage scan, like it does for the other providers.
    thinkingSel: S.reasoning,
    // composer / state
    getEditor, editorText, chatIsEmpty, isFreshChat, composerFrame, barAnchor,
    coverTarget: getEditor,
    coverMaxH: 260,
    setInputLock, typeAndSend, stopGeneration,
    isGenerating, isBusyNow, isHardGenerating,
    enforceComposer, ensureComposerReady, modeWarning, captchaPresent, overlayBlocking,
    turnHalted, findContinueBtn, clickContinueBtn,
    scanError, isTooLongMsg, isBusyMsg,
    // actions
    attachImages, clearAttachments, conversationKey, installSendHooks, findToolBlockSpot,
    promptExtra: PROMPT_EXTRA,
  };
})();
