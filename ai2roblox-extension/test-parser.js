// Quick Node smoke test for core/parser.js (run: node test-parser.js). Not shipped.
const fs = require("fs");
const AI2RobLoxParse = new Function(fs.readFileSync(__dirname + "/core/parser.js", "utf8") + "; return AI2RobLoxParse;")();

const ok = (name, cond) => { console.log((cond ? "PASS" : "FAIL") + "  " + name); if (!cond) process.exitCode = 1; };

const lua = AI2RobLoxParse.parseToolCalls("###LUA###\nreturn 1+1\n###END_LUA###");
ok("lua block", lua.length === 1 && lua[0].tool === "execute_luau" && lua[0].arguments.code === "return 1+1");
ok("lua defaults to Edit datamodel", lua[0].arguments.datamodel_type === "Edit");

const luaSpaced = AI2RobLoxParse.parseToolCalls("### LUA ###\nlocal s = 'x'\n### END_LUA ###");
ok("markdown-mangled lua markers", luaSpaced.length === 1 && luaSpaced[0].tool === "execute_luau");

const luaServer = AI2RobLoxParse.parseToolCalls("###LUA:Server###\nreturn workspace.Name\n###END_LUA###");
ok("lua :Server datamodel", luaServer.length === 1 && luaServer[0].arguments.datamodel_type === "Server" && luaServer[0].arguments.code === "return workspace.Name");

const luaClient = AI2RobLoxParse.parseToolCalls("### LUA : client ###\nreturn 1\n###END_LUA###");
ok("lua spaced :client datamodel", luaClient.length === 1 && luaClient[0].arguments.datamodel_type === "Client");

// Kimi bleeds its code-block "Copy" button caption into the block text right
// after a lowercase ###lua### marker: `###lua### Copy <code>`. The extracted
// code must NOT start with "Copy" (StudioMCP would reject `Copy task.wait(...)`
// as invalid Lua -> "Failed to parse command code").
const luaCopy = AI2RobLoxParse.parseToolCalls('###lua### Copy task.wait(4)\nreturn "dom test done"\n###END_LUA###');
ok("strips Copy chrome from bare lua block", luaCopy.length === 1 && luaCopy[0].arguments.code === 'task.wait(4)\nreturn "dom test done"');
// A genuine identifier called Copy (no trailing space eaten) must survive.
const luaCopyIdent = AI2RobLoxParse.parseToolCalls("###LUA###\nCopy(workspace)\n###END_LUA###");
ok("keeps legit Copy( identifier", luaCopyIdent[0].arguments.code === "Copy(workspace)");

const paramless = AI2RobLoxParse.parseToolCalls('{"command":"list_commands"}');
ok("paramless command", paramless.length === 1 && paramless[0].tool === "list_commands");

const braces = AI2RobLoxParse.parseToolCalls('{"command":"multi_edit","params":{"code":"if x then {y} end"}}');
ok("braces inside string value", braces.length === 1 && braces[0].arguments.code === "if x then {y} end");

const legacy = AI2RobLoxParse.parseToolCalls('{"tool":"script_read","arguments":{"path":"game.Workspace"}}');
ok("legacy tool/arguments schema", legacy.length === 1 && legacy[0].tool === "script_read");

const mcp = AI2RobLoxParse.parseToolCalls('###MCP_TOOL###\n{"command":"get_studio_state"}\n###END_MCP_TOOL###');
ok("mcp_tool wrapper", mcp.length === 1 && mcp[0].tool === "get_studio_state");

ok("open lua block detected", AI2RobLoxParse.hasOpenToolBlock("###LUA###\nlocal x=1") === true);
ok("closed lua block not open", AI2RobLoxParse.hasOpenToolBlock("###LUA###\nreturn 1\n###END_LUA###") === false);
ok("open json command detected", AI2RobLoxParse.hasOpenToolBlock('{"command":"multi_edit","params":{"a":1') === true);

ok("prose has no signature", AI2RobLoxParse.hasToolSignature("Here is how you could use a command in theory.") === false);
ok("command shape detected", AI2RobLoxParse.hasCommandShape('{"command":"x"}') === true);
ok("injected feedback detected", AI2RobLoxParse.isInjectedFeedback("Output of 'execute_luau':\n2") === true);
ok("parse-error note is feedback not command", AI2RobLoxParse.isInjectedFeedback('ERROR: bad JSON, write {"command": "name"}') === true);
ok("tool name mid-stream", AI2RobLoxParse.toolNameFromText('{"command":"multi_ed') === "multi_ed");

// ── salvageCutOff: auto-close a command whose trailing closers were cut ──
// The live Qwen case: a big multi_edit missing exactly ONE final "}".
const cut1 = AI2RobLoxParse.salvageCutOff('{"command": "multi_edit", "params": {"datamodel_type": "Edit", "file_path": "game.ServerScriptService.AdminHandler", "edits": [{"old_string": "a", "new_string": "b"}]}');
ok("salvage: one missing root brace", cut1 && cut1.tool === "multi_edit" && cut1.arguments.edits.length === 1);
// Two missing closers (params + root) still salvages.
const cut2 = AI2RobLoxParse.salvageCutOff('{"command": "get_studio_state", "params": {"verbose": true');
ok("salvage: two missing closers", cut2 && cut2.tool === "get_studio_state" && cut2.arguments.verbose === true);
// Cut MID-STRING = real content amputated -> refuse.
ok("salvage refuses mid-string cut", AI2RobLoxParse.salvageCutOff('{"command": "multi_edit", "params": {"edits": [{"old_string": "elseif command ==') === null);
// Deep deficit (cut between edits: ] } } missing = 3 closers) -> refuse.
ok("salvage refuses deep deficit", AI2RobLoxParse.salvageCutOff('{"command": "multi_edit", "params": {"edits": [{"old_string": "a", "new_string": "b"}') === null);
// A CLOSED command is not salvage's business.
ok("salvage ignores closed command", AI2RobLoxParse.salvageCutOff('{"command": "list_commands"}') === null);
// Dangling comma after the last complete value = incomplete next value -> refuse.
ok("salvage refuses trailing comma", AI2RobLoxParse.salvageCutOff('{"command": "multi_edit", "params": {"edits": [{"old_string": "a"},') === null);
// Escaped quotes inside values must not confuse the string tracking.
const cutEsc = AI2RobLoxParse.salvageCutOff('{"command": "execute_luau", "params": {"code": "print(\\"hi\\")", "datamodel_type": "Edit"}');
ok("salvage handles escaped quotes", cutEsc && cutEsc.tool === "execute_luau" && cutEsc.arguments.code === 'print("hi")');

// ── DeepSeek's native DSML tool-call markup ────────────────────────────────
// DeepSeek sometimes answers in its own agentic markup instead of an AI2RobLox
// command. It has no "command"/"tool" key and no ###...### markers, so the
// classify ladder used to miss it entirely and the turn died as plain text.
// DSML_RE is what fires the "dsml" parse_error that asks for a rewrite.
const dsmlFull = [
  '<|DSML|>tool_calls>',
  '<|DSML|>invoke name="script_read">',
  '<|DSML|>parameter name="target_file" string="true">game.ServerStorage.AI2RobLox.Memory</|DSML|>parameter>',
  '</|DSML|>invoke>',
  '</|DSML|>tool_calls>',
].join("\n");
ok("dsml full invoke block", AI2RobLoxParse.DSML_RE.test(dsmlFull));
// The degenerate form seen in the wild: a bare opener and NO tool name at all -
// which is why the guard must not be gated on a known command name.
ok("dsml bare opener + prose",
   AI2RobLoxParse.DSML_RE.test('<|DSML|>tool_calls>\n\n<section>Let me explore the remaining key services.</section>'));
// DeepSeek writes its special tokens with the FULL-WIDTH bar (U+FF5C).
ok("dsml full-width bar", AI2RobLoxParse.DSML_RE.test('<｜DSML｜>invoke name="script_read">'));
// The form as it appeared in user screenshots - doubled bars with spaces. The
// live capture (2026-08-22) showed DeepSeek actually emits plain ASCII bars and
// that this spacing is only the site's rendering, but the detector stays
// permissive so a build that really emits it is covered.
ok("dsml doubled bars with spaces", AI2RobLoxParse.DSML_RE.test('< |  | DSML |  | tool_calls>'));
ok("dsml doubled-bar closer", AI2RobLoxParse.DSML_RE.test('</ |  | DSML |  | parameter>'));
ok("dsml closing tag alone", AI2RobLoxParse.DSML_RE.test('</|DSML|>parameter>'));
// DSML is NOT an AI2RobLox command shape: it must reach the fallthrough guards.
ok("dsml is not a tool signature", !AI2RobLoxParse.hasToolSignature(dsmlFull));
// DSML must NOT be a tool signature (it has to fall through to the classify
// ladder so the "dsml" parse_error fires) but it MUST be a command shape, so the
// camouflage sweep masks the raw markup behind a chip instead of showing it.
ok("dsml IS a command shape (so it gets masked)", AI2RobLoxParse.hasCommandShape(dsmlFull));
ok("dsml bare opener is a command shape too", AI2RobLoxParse.hasCommandShape('<|DSML|>tool_calls>'));
// No false positives: ordinary prose, a real command, and - critically - OUR OWN
// error note, which names DSML in words. If the note matched, the model echoing
// it would re-fire the error forever.
ok("no dsml false positive on prose",
   !AI2RobLoxParse.DSML_RE.test("I considered the DSML invoke and parameter tags, but used JSON instead."));
ok("no dsml false positive on a real command",
   !AI2RobLoxParse.DSML_RE.test('{"command": "script_read", "params": {"target_file": "x"}}'));
