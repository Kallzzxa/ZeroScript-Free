// SPDX-License-Identifier: GPL-3.0-or-later
// providers/muse.js - the Muse (muse.ai) provider.
// Exports the same AI2RobLoxProvider interface as providers/meta.js; the core
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
//  - 2026-10-28 (later still): mode_ready diag proved the real cause, and it
//    was NOT the selector shape at all: the core locks the composer with
//    readonly BEFORE the readiness gate (setInputLock(true) at main.js:1831,
//    ensureComposerReady at :1843), and the editor selector excluded readonly
//    textareas - so the locked composer vanished from getEditor() and every
//    Start failed identically (diag: editorCandidates 0) while the console
//    still counted 2 textareas. Fix in 1.5.9: no :not([readonly]) exclusion
//    (Meta's lock does the same readonly trick, and its comment notes the
//    native setter ignores readonly, so agent sends still work on a locked
//    editor). A full command turn still awaits a live test.
//  - 2026-10-28 (later still): 1.5.9 PASSED the mode gate (mode_ready
//    ready:true, editorCandidates 1, AI2RobLox-SYS sent, gen:true) but the bootstrap
//    fell back to Start: the extension never registered the model's replies
//    as turns (no tool result ever came back). User pasted a real assistant
//    bubble: outer <div data-hatch-assistant-message-body="true"> wrapping
//    .hatch-chat-groupable-bubble > .prose (data-hatch-markdown-streaming
//    false when settled - a possible future generating signal, not used yet).
//    Fix in 1.5.10: turn candidates start with the hatch message-body
//    markers; assistant classification checks them first. Watch items: the
//    user-side marker is inferred symmetric (unconfirmed); fenced code blocks
//    render as <pre> (handled) unless Muse uses a custom code viewer, which
//    would collapse multi-line Lua in textWithout.
//  - 2026-10-28 (later still): 1.5.10 DID run full command turns on Muse
//    and generated Studio models - so turn detection is no longer the
//    blocker. The new failure is prompt quality, not parsing: asked for a
//    "very realistic farmer character", Muse passed that 4-word request
//    verbatim as generate_mesh textPrompt and got an unclear model, while
//    DeepSeek's session expanded the same idea into a detailed prompt
//    (full body, A-pose, worn clothes, straw hat - visible in the long
//    Workspace model name it produced) and got a recognisable farmer.
//    Fix in 1.5.11: Muse's promptExtra now REQUIRES expanding short mesh /
//    procedural prompts into detailed visual prompts before calling
//    generate_mesh / generate_procedural_model. Command parsing itself
//    was verified working: Muse's commands executed and the Workspace
//    model names matched the prompts Muse sent exactly, so nothing here
//    was mangled by the extension.
//  - 2026-10-28 (later still): named-person case (user asked for a
//    Prabowo object, got a generic-looking one). Same root cause, one
//    level deeper: generate_mesh is Roblox's own AI text-to-mesh tool,
//    not this extension's code - it takes ONLY a text prompt, has NO
//    seed parameter and NO reference-image parameter, and has no
//    database of real people's faces. A bare name therefore makes the
//    generator invent a generic person, and Muse's 1.5.11 expansion
//    invents the missing face details too. Fix in 1.5.13: a named
//    person / specific character is a CONFIRM-FIRST case - Muse must
//    show the expanded description, ask the user to correct it or
//    attach a reference photo, generate only once after confirmation,
//    and report the result as approximate, never as an exact likeness.
//    With a photo, prefer generate_procedural_model with
//    attachedImageUri, the one generation command that accepts an
//    image, over generate_mesh, which does not.
//  - 2026-10-28 (later still): user sent DeepSeek screenshots showing
//    a generate diagnosis Muse did not do on its own: on an error,
//    DeepSeek first ran get_studio_state, found Play mode, stopped
//    Play with start_stop_play, then retried in Edit mode; on a
//    generate_mesh "Failed to fetch image" error it said the fetch
//    was usually transient and retried once, considering a
//    procedural fallback. The extension already renders each command
//    and result as a card in the chat, the same as on DeepSeek, so
//    the missing piece was model behaviour, not parsing. Fix in
//    1.5.14: PROMPT_EXTRA now carries that diagnosis loop for Muse
//    (check mode, stop Play, retry once, fallback or ask - never an
//    endless retry), explained in the user's language.
//  - 2026-10-28 (later still): user compared DeepSeek again -
//    DeepSeek tests itself in Play (keyboard / mouse input, console
//    check) and its UIs look finished, while Muse only told the user
//    to test and shipped a plain Frame UI. The tools for that test
//    already exist for every provider (user_keyboard_input,
//    user_mouse_input, character_navigation, get_console_output),
//    so again the missing piece was model behaviour, not parsing.
//    Fix in 1.5.15: PROMPT_EXTRA now carries a self-test loop
//    (Play, test with keyboard / mouse, read console, fix at most
//    twice, always stop Play and return to Edit) and a UI quality
//    rule (UICorner, UIStroke, UIPadding, contrast, working buttons
//    tested in Play, not just plain labels).
//  - 2026-10-28 (later still): user sent a DeepSeek screen_capture
//    popup (Studio viewport with a ghost and a MotorGojek) and said
//    just update the plugin so Muse can do that too. The reason
//    Muse did not have it: core blocks screen_capture and turns
//    image results into errors when supportsVision is false, so
//    Muse advertised 29 tools while DeepSeek advertised 30, and
//    Muse's attachImages was a stub returning false. Fix in
//    1.5.16: supportsVision is now true, attachImages maps the
//    composer's file input via DataTransfer (paste fallback, like
//    Gemini), typeAndSend now accepts images, and PROMPT_EXTRA
//    carries a screen capture rule. The upload path itself is
//    still best-effort until a live capture is confirmed on
//    muse.ai, because the file-input selector comes from the
//    pasted composer markup, not a live capture test.
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
const AI2RobLoxProvider = (() => {
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
    // Composer candidates (visible one wins). NOTE: do NOT exclude readonly
    // textareas (no :not([readonly])). The core LOCKS the composer with
    // readonly BEFORE the readiness gate (main.js: setInputLock(true) runs
    // before ensureComposerReady("startup")), and Meta's own lock does the
    // same - so excluding readonly made the locked composer invisible to
    // getEditor() and every Start failed with "mode not ready" while the
    // console still counted the textarea. The native setter ignores readonly
    // (Meta's own comment), so typeAndSend still writes to a locked editor.
    editor: 'textarea, [contenteditable]:not([contenteditable="false"]), [role="textbox"]',
    // Send / stop buttons (visible, enabled one wins).
    sendBtn: 'button[aria-label*="send" i], button[type="submit"]',
    stopBtn: 'button[aria-label*="stop" i]',
    // Turn candidates (topmost match wins; nested matches are dropped).
    // The assistant marker is CONFIRMED from live markup pasted by the user
    // (2026-10-28): an assistant reply is wrapped in
    // <div data-hatch-assistant-message-body="true"> containing a
    // .hatch-chat-groupable-bubble with the prose inside. The user-side
    // marker below is INFERRED symmetric (data-hatch-user-message-body) -
    // not yet confirmed from a user bubble - so the generic fallbacks after
    // it still matter for user turns.
    turn: '[data-hatch-assistant-message-body], [data-hatch-user-message-body], [data-testid*="message"], [data-message-author-role], [data-role*="message"], article, [class*="message-bubble"]',
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
  const _notOurs = (e) => !e.closest("#ai2roblox-root");
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
  // Excludes the extension's own UI (#ai2roblox-root) and empty nodes.
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
    // Confirmed live markers first: the hatch message-body attributes are
    // unambiguous (assistant body vs user body), so they outrank every
    // heuristic below.
    if (item.matches("[data-hatch-assistant-message-body]")) return true;
    if (item.matches("[data-hatch-user-message-body]")) return false;
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
    const skip = ".ai2roblox-chip, " + S.reasoning + (excludeSel ? ", " + excludeSel : "");
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
      if (b.closest("#ai2roblox-root")) continue;
      if (!isVisible(b)) continue;
      if (b.disabled || b.getAttribute("aria-disabled") === "true") continue;
      return b;
    }
    return null;
  };
  const stopButton = () => {
    for (const b of qAllDeep(S.stopBtn)) {
      if (b.closest("#ai2roblox-root")) continue;
      if (isVisible(b)) return b;
    }
    return null;
  };

  function streamText(item) {
    const it = item === undefined ? lastAssistant() : item;
    return it ? textWithout(it, ".ai2roblox-chip") : "";
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
    return { present: true, reply: textWithout(item, ".ai2roblox-chip").trim(), thinking: "", item };
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
  // 1.5.16: screen_capture is now enabled, like DeepSeek (30 tools, not
  // 29). The core blocks screen_capture and turns any image result into
  // an error when supportsVision is false, so Muse never even saw the
  // tool in list_commands. Muse's model CAN see user-uploaded images,
  // and the composer the user pasted from Inspect DOES contain a file
  // input in the same flex row as the textarea, so attachImages now
  // maps that input, mirroring DeepSeek/Meta: build a File from the
  // base64 capture, set it on the file input via DataTransfer, dispatch
  // change, and wait for a preview image to appear. If no file input
  // is found, fall back to a paste event on the editor, like Gemini.
  // This path is NOT yet validated live for a real screen_capture
  // upload on muse.ai (the file-input selector is from the pasted
  // composer markup, not a live capture test), so attachImages
  // returns false honestly when no preview appears, and typeAndSend
  // still sends the text feedback in that case - the user still sees
  // the capture in the extension's left-hand popup, but the model
  // may not see it in-chat until the upload path is confirmed live.
  function fileFromImage(img, i) {
    const mime = img.mimeType || "image/jpeg";
    const bin = atob(img.data);
    const arr = new Uint8Array(bin.length);
    for (let j = 0; j < bin.length; j++) arr[j] = bin.charCodeAt(j);
    const ext = mime.includes("png") ? "png" : mime.includes("webp") ? "webp" : "jpg";
    return new File([arr], `ai2roblox_${Date.now()}_${i}.${ext}`, { type: mime });
  }
  const attachPreview = () => {
    try {
      const ed = getEditor();
      const root = ed && ed.parentElement ? ed.parentElement : document;
      return !!(root.querySelector && root.querySelector("img"));
    } catch { return false; }
  };
  async function attachImages(images) {
    if (!images || !images.length) return false;
    if (attachPreview()) return true;
    const dt = new DataTransfer();
    images.forEach((img, i) => { try { dt.items.add(fileFromImage(img, i)); } catch {} });
    if (!dt.items.length) return false;
    const editor = getEditor();
    const fileInputs = qAllDeep('input[type="file"]');
    const fileInput = fileInputs[0] || null;
    try {
      if (fileInput) {
        fileInput.files = dt.files;
        fileInput.dispatchEvent(new Event("change", { bubbles: true }));
      } else if (editor) {
        editor.focus();
        editor.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
      } else {
        return false;
      }
    } catch { return false; }
    const ok = await waitFor(attachPreview, 15000);
    diag("muse.attach.preview", { ok });
    return ok;
  }
  function clearAttachments() {
    try {
      qAllDeep('input[type="file"]').forEach((inp) => { try { inp.value = ""; } catch {} });
    } catch {}
  }

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

  async function typeAndSend(text, images) {
    const editor = getEditor();
    if (!editor) throw new Error("Muse input box not found");
    if (images && images.length) {
      try {
        const ok = await attachImages(images);
        diag("muse.tas.attached", { ok });
      } catch (e) { diag("muse.tas.attachErr", { msg: String((e && e.message) || e) }); }
    }
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
    // not-ready, the [ai2roblox-diag] mode_ready line shows whether ANY composer
    // candidate exists at all (0 = selector still wrong / shadow DOM).
    diag("mode_ready", { reason, provider: "muse", ready: !!editor, editorCandidates: editorEls().length });
    return { ready: !!editor };
  }
  const modeWarning = () => "";
  const captchaPresent = () => false;
  function overlayBlocking() {
    for (const d of qAllDeep('[role="dialog"]')) {
      if (d.closest("#ai2roblox-root")) continue;
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
      if (cw.closest(".ai2roblox-chip")) return;
      if (CMD_SHAPE.test(cw.textContent || "")) {
        cw.classList.add("ai2roblox-tool-hide");
        b.classList.add("ai2roblox-cmd-mask");
        hidAny = hidAny || { parent: cw.parentElement, ref: cw };
      }
    });
    b.querySelectorAll("p, div").forEach((el) => {
      if (el.closest(".ai2roblox-chip, .ai2roblox-tool-hide, " + S.codeWrap)) return;
      if (el.querySelector(S.codeWrap)) return;
      const t = (el.textContent || "").trim();
      const t0 = t.replace(/^json\s*/i, "");
      const startsAsCmd = /^\{\s*"(?:command|tool)"\s*:/.test(t0) || /^###\s*(?:lua|mcp_tool)/i.test(t0);
      if ((startsAsCmd || t.length < 600) && CMD_SHAPE.test(t) && /^[{#]/.test(t0)) {
        el.classList.add("ai2roblox-tool-hide");
        hidAny = hidAny || { parent: el.parentElement, ref: el };
      }
    });
    return hidAny;
  }

  // Muse's web chat has no function-calling channel to the user's machine, so
  // Studio work must go through plain-text commands (same core rule, restated
  // for a model that may otherwise offer its own tools).
  //
  // Mesh-prompt expansion (1.5.11, verified live 2026-10-28): Muse used to
  // pass a user's short request verbatim as generate_mesh textPrompt
  // ("very realistic farmer character") and the generator returned an
  // unclear model, while DeepSeek expanded the same idea into a detailed
  // prompt (full body, A-pose, worn clothes, straw hat) and got a
  // recognisable farmer. The extension did NOT mangle Muse's command -
  // the Workspace model name matched Muse's prompt exactly - so the fix
  // belongs here, in what Muse is told to write, not in parsing.
  const PROMPT_EXTRA =
    "You have no function-calling or tool API in this chat that reaches the " +
    "user's computer - do NOT offer to call tools, and do NOT wrap commands " +
    "in any tool-call markup. Write every AI2RobLox command as plain text " +
    "inside a fenced code block, exactly as specified above. " +
    "For generate_mesh and generate_procedural_model, do NOT pass the user's " +
    "short request verbatim as textPrompt or prompt. First expand it into a " +
    "detailed, specific visual prompt: subject, full body or part, pose " +
    "(for a character: standing upright, A-pose, facing forward), clothing " +
    "and props, materials and texture, proportions, and style (realistic, " +
    "detailed). Keep the user's subject and style words, and add only " +
    "concrete visual details that make the subject recognisable. A 3-5 word " +
    "prompt is NOT enough and produces an unclear model. For example, " +
    "expand a farmer request into something like: a realistic 3D farmer " +
    "character, full body, standing upright in A-pose, wearing a worn shirt, " +
    "trousers, boots and a straw hat, detailed skin and fabric texture. " +
    "Adapt the details to what the user actually asked; do not copy that " +
    "example verbatim when the user asked for something else. " +
    "NAMED PERSON / SPECIFIC CHARACTER RULE: if the user names a real " +
    "person, a famous character, or any specific individual, NEVER send " +
    "the bare name as the prompt and NEVER invent a face and present it " +
    "as that person. The generator has no seed and no likeness database, " +
    "so a bare name always returns a generic invented person. First show " +
    "the expanded visual description in plain text and ask the user to " +
    "correct the traits (age, hair, glasses, clothing, pose) or attach a " +
    "reference photo, and generate only once after they confirm. If they " +
    "attach a photo, prefer generate_procedural_model with " +
    "attachedImageUri, which accepts an image, over generate_mesh, which " +
    "does not. After generation, verify with search_game_tree and report " +
    "honestly that the result is approximate or generic if it does not " +
    "match the confirmed traits, and offer ONE retry with corrected " +
    "traits instead of blindly repeating the same prompt, because " +
    "repeating a prompt with no seed gives a different random result " +
    "each time. " +
    "GENERATE DIAGNOSIS RULE (mirrors DeepSeek behaviour seen live " +
    "2026-10-28): when a generate_mesh, generate_procedural_model, or " +
    "Edit-mode execute_luau call fails, do NOT just retry it blindly " +
    "and do NOT claim success. First diagnose, in this order. " +
    "1) Run get_studio_state and report the mode in plain language. " +
    "If Studio is in Play mode, generate_mesh and Edit-mode calls " +
    "cannot run there: run start_stop_play with is_start false, wait " +
    "for Game Stopped, then retry the generate ONCE in Edit mode. " +
    "Never attempt a generate in Play mode. " +
    "2) Read the error's last segment and classify it. If it says " +
    "Failed to fetch image, fetch failed, or a similar network / " +
    "reference-image error, say plainly in the user's language that " +
    "it is usually transient, then retry the SAME generate ONCE only. " +
    "If that second attempt also fails, stop looping: check " +
    "search_game_tree first so you do not create a duplicate, then " +
    "offer generate_procedural_model as a fallback, or ask the user " +
    "what to do next. " +
    "3) For any other error, explain what the error actually says, " +
    "what you already checked, and what is still unknown, in the " +
    "user's language. One retry per generate at most, then a " +
    "fallback or a question, never an endless retry loop. " +
    "Tool cards: the extension already turns each command and its " +
    "result into a card in the chat, the same as on DeepSeek, so " +
    "keep your narration short and let the card carry the command " +
    "name and result; do not paste the raw command again in prose. " +
    "SELF-TEST RULE (mirrors DeepSeek: it tests itself, it does not " +
    "just tell the user to test): after you create or change a " +
    "script, model, or UI that is meant to be interactive, test it " +
    "yourself in Studio instead of only telling the user to test it. " +
    "For a static model, search_game_tree verification is enough. " +
    "For anything interactive, do this loop: 1) start Play with " +
    "start_stop_play is_start true, 2) test it with the tools made " +
    "for Play: user_keyboard_input and user_mouse_input need " +
    "datamodel_type Client and a running game, character_navigation " +
    "moves the character, and execute_luau with a Server or Client " +
    "marker can check live state, 3) read get_console_output for " +
    "errors, and inspect the result with search_game_tree or " +
    "inspect_instance, 4) fix what failed in Edit mode, then test " +
    "again, at most two fix-and-retest cycles, 5) always stop Play " +
    "with start_stop_play is_start false and return to Edit mode " +
    "before you finish, and report honestly what passed, what " +
    "failed, and what you could not test. Never leave the place " +
    "stuck in Play mode. " +
    "UI QUALITY RULE: when you make a UI, do not ship a bare Frame " +
    "with plain TextLabels only. Make it look finished: rounded " +
    "corners with UICorner, a subtle UIStroke, UIPadding, good " +
    "contrast and readable TextScaled text, a clear layout with " +
    "space between elements, and a visible state (speed, status, " +
    "controls) plus working buttons, not just labels. Test the " +
    "buttons with user_mouse_input in Play mode, not just by " +
    "reading the code. " +
    "SCREEN CAPTURE RULE: screen_capture is available on Muse, " +
    "like on DeepSeek, and it is how you verify what is actually " +
    "visible in Studio. Use it after creating or changing a model, " +
    "a UI, or a scene, and whenever text verification alone is " +
    "ambiguous, for example to check that a model really spawned, " +
    "that a UI is laid out correctly, or that a character is where " +
    "you expected. Describe in plain language what the captured " +
    "image actually shows, and do not claim a visual result you " +
    "did not see in a capture. One capture per verification is " +
    "enough; do not loop captures. If a capture returns an error " +
    "that the assistant cannot see images, do NOT call it again: " +
    "fall back to text verification with search_game_tree, " +
    "inspect_instance, and get_console_output, and tell the user " +
    "plainly that the capture path needs a live check on muse.ai.";

  return {
    id: "muse",
    displayName: "Muse",
    // Vision is ON in 1.5.16: the model can see user-uploaded images,
    // and attachImages now maps the composer's file input, so the
    // core no longer hides screen_capture (Muse goes from 29 tools
    // to 30, like DeepSeek). The upload path itself is still
    // best-effort until a live screen_capture is confirmed on muse.ai.
    supportsVision: true,
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
      "Muse support is experimental: turn detection is now validated live " +
      "on muse.ai, and mesh prompts are expanded to detailed prompts " +
      "before generation. Named people need a confirmed description or " +
      "a reference photo, and likeness is never guaranteed. Generate " +
      "failures are diagnosed like DeepSeek: Play mode is stopped " +
      "first, transient fetch errors get one retry. Interactive " +
      "work is self-tested in Play and UIs are made finished, not " +
      "plain. Screen capture is now enabled like DeepSeek. If turns " +
      "are not detected, reload the page and retry.",
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
