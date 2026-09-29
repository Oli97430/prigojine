// Serveur MCP intermédiaire utilisé par la CLI Claude : il relaie les outils du moteur,
// mais demande d'abord l'accord de l'utilisateur (via Prigojine) pour les actions sensibles.
// Variables : PRIGOJINE_URL, PRIGOJINE_RUN (identifiant de l'agent), PRIGOJINE_GUARD ("1" = confirmer).
const path = require("path");
const { Client } = require("@modelcontextprotocol/client");
const { StdioClientTransport, getDefaultEnvironment } = require("@modelcontextprotocol/client/stdio");
const { Server } = require("@modelcontextprotocol/server");
const { StdioServerTransport } = require("@modelcontextprotocol/server/stdio");
const { sensitiveAction, needsScreen, parseElements } = require("./guard.cjs");

const { ROOT, ENGINE_ENTRY } = require("./engine.cjs");
const STUDIO = process.env.PRIGOJINE_URL || "http://127.0.0.1:4717";
const RUN = process.env.PRIGOJINE_RUN || "";
const GUARD = process.env.PRIGOJINE_GUARD === "1";
const TOKEN = process.env.PRIGOJINE_TOKEN || "";
const DEVICE = process.env.PRIGOJINE_DEVICE || ""; // l'agent ne pilote que son appareil

async function main() {
	const inner = new Client({ name: "prigojine-guard", version: "1.0.0" });
	await inner.connect(new StdioClientTransport({
		command: process.execPath,
		args: [ENGINE_ENTRY],
		cwd: ROOT,
		env: { ...getDefaultEnvironment(), ...process.env, MOBILEMCP_DISABLE_TELEMETRY: "1" },
		stderr: "ignore",
	}));

	const server = new Server({ name: "mobile", version: "1.0.0" }, { capabilities: { tools: {} } });
	server.setRequestHandler("tools/list", async () => inner.listTools());
	server.setRequestHandler("tools/call", async req => {
		const { name } = req.params;
		const args = { ...(req.params.arguments || {}) };
		if (DEVICE && "device" in args) args.device = DEVICE;
		if (name === "mobile_batch_commands") return { content: [{ type: "text", text: "Outil non disponible pour l'agent." }], isError: true };
		if (GUARD) {
			let elements = [];
			if (needsScreen(name) && args.device) {
				const r = await inner.callTool({ name: "mobile_list_elements_on_screen", arguments: { device: args.device, format: "json" } });
				elements = parseElements(r.content?.find(c => c.type === "text")?.text);
			}
			const what = sensitiveAction(name, args, elements);
			if (what) {
				let allowed = false;
				try {
					const res = await fetch(`${STUDIO}/api/guard/ask`, {
						method: "POST", headers: { "Content-Type": "application/json", "X-Prigojine-Token": TOKEN },
						body: JSON.stringify({ run: RUN, device: args.device, action: what }),
					});
					allowed = (await res.json()).allow === true;
				} catch { allowed = false; }
				if (!allowed) return { content: [{ type: "text", text: `Action refusée par l'utilisateur : ${what}. Ne la refais pas ; arrête-toi et explique ce qu'il faudrait faire.` }], isError: true };
			}
		}
		return inner.callTool({ name, arguments: args }, undefined, { timeout: 10 * 60 * 1000 });
	});
	await server.connect(new StdioServerTransport());
}

main().catch(e => { process.stderr.write(String(e && e.stack || e)); process.exit(1); });
