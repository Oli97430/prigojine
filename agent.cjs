// Agent : fait piloter l'appareil par Claude (via la CLI Claude Code) ou par un modèle local Ollama.
const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawn } = require("child_process");
const { sensitiveAction, needsScreen, parseElements } = require("./guard.cjs");

// OLLAMA_HOST peut valoir « 0.0.0.0 » (écoute côté serveur) ou être sans port
const OLLAMA = (() => {
	let h = (process.env.OLLAMA_HOST || "127.0.0.1:11434").replace(/^https?:\/\//, "").replace(/\/+$/, "");
	if (!/:\d+$/.test(h)) h += ":11434";
	return "http://" + h.replace(/^0\.0\.0\.0(?=:)/, "127.0.0.1");
})();
const { ENGINE_ENTRY } = require("./engine.cjs");

// Outils jamais confiés à l'agent sans le mode avancé (actions lourdes ou payantes)
const SENSITIVE = ["mobile_batch_commands", "mobile_uninstall_app", "mobile_install_app", "mobile_allocate_remote_device", "mobile_release_remote_device", "mobile_login_to_cloud_provider", "mobile_list_remote_devices"];
const BUILTIN_TOOLS = ["Bash", "Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "Glob", "Grep", "LS", "WebFetch", "WebSearch", "Task", "Agent", "TodoWrite"];
const CLAUDE_MODELS = [
	{ id: "sonnet", name: "Claude Sonnet (équilibré)" },
	{ id: "opus", name: "Claude Opus (le plus capable)" },
	{ id: "haiku", name: "Claude Haiku (rapide)" },
];

function systemPrompt(device, advanced) {
	return [
		"Tu pilotes un téléphone via les outils mobile_*. Réponds en français.",
		`L'appareil à utiliser est « ${device} ». Il est déjà sélectionné : n'appelle pas mobile_list_available_devices.`,
		"Méthode : lis l'écran avec mobile_list_elements_on_screen (fiable, donne des refs), touche les éléments par leur ref, et n'utilise la capture d'écran que si un élément manque.",
		"Préfère mobile_open_url ou mobile_launch_app pour aller directement quelque part. Après chaque action, vérifie le résultat.",
		"Une appli déjà ouverte reprend là où elle était : pour repartir de son écran principal, ferme-la avec mobile_terminate_app puis relance-la. Dans un sous-menu, le bouton BACK ramène en arrière.",
		"Si ce que tu cherches n'est pas visible, fais défiler avec mobile_swipe_on_screen (direction « up » pour descendre dans la page) puis relis l'écran. Ne t'arrête pas pour annoncer ce que tu vas faire : fais-le.",
		"N'utilise jamais le paramètre « locale » de mobile_launch_app : il change durablement la langue de l'appli.",
		"Règles de sécurité : c'est peut-être le vrai téléphone de l'utilisateur. N'envoie aucun message, n'effectue aucun achat ou paiement, n'accepte aucune condition d'utilisation, ne saisis aucun mot de passe et ne supprime rien : arrête-toi et explique ce qu'il faudrait faire.",
		advanced ? "" : "Tu n'as pas accès à l'installation ni à la désinstallation d'applis.",
		"Quand la tâche est terminée (ou vraiment impossible), réponds par un message qui commence par « RÉSULTAT : » suivi d'un court résumé.",
	].filter(Boolean).join("\n");
}

/* ---------------- Modèles disponibles ---------------- */
async function listModels() {
	const out = { claude: [], local: [], errors: {} };
	// Claude : via la CLI installée (utilise l'abonnement déjà connecté)
	const auth = await claudeAuth();
	if (findClaude()) out.claude = CLAUDE_MODELS;
	if (!auth.ok) out.errors.claude = auth.why;
	// Ollama : seulement les modèles capables d'appeler des outils
	try {
		const tags = await (await fetch(`${OLLAMA}/api/tags`)).json();
		const infos = await Promise.all(tags.models.map(async m => {
			const s = await (await fetch(`${OLLAMA}/api/show`, { method: "POST", body: JSON.stringify({ model: m.name }) })).json();
			return { id: m.name, caps: s.capabilities || [], size: s.details?.parameter_size || "", bytes: m.size };
		}));
		out.local = infos.filter(m => m.caps.includes("tools"))
			.map(m => ({ id: m.id, name: `${m.id} · ${m.size}`, vision: m.caps.includes("vision"), thinking: m.caps.includes("thinking") }))
			.sort((a, b) => a.id.localeCompare(b.id));
	} catch (e) {
		out.errors.local = "Ollama injoignable sur " + OLLAMA;
	}
	return out;
}

// Environnement propre : si Prigojine est lancé depuis l'appli Claude Desktop, ses variables
// (ANTHROPIC_BASE_URL, CLAUDE_CODE_*) empêcheraient la CLI d'utiliser sa propre connexion.
function cleanEnv() {
	const env = { ...process.env };
	for (const k of Object.keys(env)) if (k === "ANTHROPIC_BASE_URL" || k === "CLAUDECODE" || k.startsWith("CLAUDE_")) delete env[k];
	return env;
}

function claudeAuth() {
	const bin = findClaude();
	if (!bin) return Promise.resolve({ ok: false, why: "CLI « claude » introuvable" });
	if (process.env.ANTHROPIC_API_KEY) return Promise.resolve({ ok: true });
	return new Promise(resolve => {
		const child = spawn(bin, ["auth", "status"], { env: cleanEnv(), cwd: os.tmpdir(), windowsHide: true });
		let out = "";
		child.stdout.on("data", d => { out += d; });
		child.on("error", () => resolve({ ok: false, why: "CLI « claude » impossible à lancer" }));
		child.on("close", () => {
			try { if (JSON.parse(out).loggedIn) return resolve({ ok: true }); } catch { /* sortie inattendue */ }
			resolve({ ok: false, why: "CLI « claude » non connectée : ouvre un terminal, tape « claude » puis « /login » (une seule fois)." });
		});
	});
}

function findClaude() {
	const candidates = [
		process.env.CLAUDE_BIN,
		path.join(os.homedir(), ".local", "bin", process.platform === "win32" ? "claude.exe" : "claude"),
	].filter(Boolean);
	for (const c of candidates) if (fs.existsSync(c)) return c;
	const dirs = (process.env.PATH || "").split(path.delimiter);
	for (const d of dirs) {
		for (const n of process.platform === "win32" ? ["claude.exe"] : ["claude"]) {
			const p = path.join(d, n);
			if (fs.existsSync(p)) return p;
		}
	}
	return null;
}

/* ---------------- Exécution ---------------- */
// emit(event) : { type: "status"|"text"|"thinking"|"tool"|"result"|"done"|"error", ... }
// guard : confirmer les actions sensibles ; maxActions : nombre maximal d'appels d'outils ;
// budget : plafond en $ (Claude) ; ask(action) -> Promise<boolean> : demande à l'utilisateur.
function runAgent({ provider, model, device, task, advanced, think, guard = true, maxActions = 40, budget = 1, runId, studioUrl, token, ask, memory = {} }, mcpClient, emit) {
	const ctl = { stopped: false, stop: () => {} };
	const job = provider === "claude"
		? runClaude({ model, device, task, advanced, guard, maxActions, budget, runId, studioUrl, token, memory }, emit, ctl)
		: runOllama({ model, device, task, advanced, think, guard, maxActions, ask, memory }, mcpClient, emit, ctl);
	job.catch(e => emit({ type: "error", text: String(e && e.message || e) })).finally(() => emit({ type: "end" }));
	return ctl;
}

/* ----- Claude via la CLI Claude Code ----- */
async function runClaude({ model, device, task, advanced, guard, maxActions, budget, runId, studioUrl, token, memory }, emit, ctl) {
	const bin = findClaude();
	const auth = await claudeAuth();
	if (!auth.ok) throw new Error(auth.why);
	const cfgFile = path.join(os.tmpdir(), `prigojine-${process.pid}-${String(device).replace(/[^\w.-]/g, "_")}-${Date.now()}.json`);
	// le moteur passe par guard-mcp.cjs, qui demande confirmation à Prigojine pour les actions sensibles
	fs.writeFileSync(cfgFile, JSON.stringify({
		mcpServers: { mobile: { command: process.execPath, args: [path.join(__dirname, "guard-mcp.cjs")], env: {
			ANDROID_HOME: process.env.ANDROID_HOME || "", MOBILEMCP_DISABLE_TELEMETRY: "1",
			PRIGOJINE_URL: studioUrl || "", PRIGOJINE_RUN: runId || "", PRIGOJINE_GUARD: guard ? "1" : "0",
			PRIGOJINE_TOKEN: token || "", PRIGOJINE_DEVICE: device,
		} } },
	}));
	const deny = advanced ? SENSITIVE.filter(n => n.includes("remote") || n.includes("cloud") || n.includes("batch")) : SENSITIVE;
	const args = [
		"-p", task,
		"--output-format", "stream-json", "--verbose",
		"--model", model || "sonnet",
		"--mcp-config", cfgFile, "--strict-mcp-config",
		"--allowedTools", "mcp__mobile",
		// outils intégrés de Claude Code interdits : l'agent ne touche qu'au téléphone, jamais aux fichiers du PC
		"--disallowedTools", ...deny.map(n => `mcp__mobile__${n}`), ...BUILTIN_TOOLS,
		"--append-system-prompt", systemPrompt(device, advanced),
	];
	// « Continuer » : reprise de la session Claude précédente (même contexte, mêmes échanges)
	if (memory.sessionId) args.push("--resume", memory.sessionId);
	if (budget > 0) args.push("--max-budget-usd", String(budget));
	emit({ type: "status", text: `Claude (${model}) démarre… plafond ${budget > 0 ? budget + " $" : "aucun"}, ${maxActions} actions max${guard ? ", confirmation des actions sensibles" : ""}` });
	let actions = 0;
	// dossier de travail vide, propre à cet agent
	const work = fs.mkdtempSync(path.join(os.tmpdir(), "prigojine-agent-"));
	const child = spawn(bin, args, { env: cleanEnv(), cwd: work, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
	ctl.stop = () => { ctl.stopped = true; child.kill(); };
	let buf = "", err = "";
	const names = {};
	child.stderr.on("data", d => { err += d; });
	child.stdout.on("data", d => {
		buf += d;
		let i;
		while ((i = buf.indexOf("\n")) >= 0) {
			const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
			if (!line) continue;
			let ev; try { ev = JSON.parse(line); } catch { continue; }
			if (ev.session_id) memory.sessionId = ev.session_id;
			if (ev.type === "assistant") {
				for (const c of ev.message?.content || []) {
					if (c.type === "text" && c.text.trim()) emit({ type: "text", text: c.text });
					if (c.type === "thinking" && c.thinking) emit({ type: "thinking", text: c.thinking });
					if (c.type === "tool_use") {
						names[c.id] = c.name;
						emit({ type: "tool", name: c.name.replace(/^mcp__mobile__/, ""), args: c.input });
						if (c.name.startsWith("mcp__mobile__") && ++actions > maxActions && !ctl.stopped) {
							ctl.limit = true; ctl.stop();
						}
					}
				}
			} else if (ev.type === "user") {
				for (const c of ev.message?.content || []) {
					if (c.type !== "tool_result") continue;
					const parts = Array.isArray(c.content) ? c.content : [{ type: "text", text: String(c.content ?? "") }];
					const text = parts.filter(p => p.type === "text").map(p => p.text).join("\n");
					const img = parts.find(p => p.type === "image");
					emit({ type: "result", name: (names[c.tool_use_id] || "").replace(/^mcp__mobile__/, ""), isError: !!c.is_error, text, image: img ? { mime: img.source?.media_type, data: img.source?.data } : null });
				}
			} else if (ev.type === "result") {
				emit({ type: "done", text: ev.result || "", cost: ev.total_cost_usd, turns: ev.num_turns, isError: ev.is_error });
			}
		}
	});
	await new Promise(resolve => child.on("close", resolve));
	fs.rmSync(cfgFile, { force: true });
	fs.rmSync(work, { recursive: true, force: true });
	if (ctl.limit) emit({ type: "done", text: `Limite de ${maxActions} actions atteinte : agent arrêté.`, isError: true });
	else if (ctl.stopped) emit({ type: "status", text: "Arrêté." });
	else if (err.trim() && !buf.includes("result")) emit({ type: "status", text: err.trim().slice(0, 600) });
}

/* ----- Modèle local via Ollama ----- */
const CORE_LOCAL = [
	"mobile_list_elements_on_screen", "mobile_click_on_screen_at_coordinates", "mobile_type_keys", "mobile_press_button",
	"mobile_swipe_on_screen", "mobile_open_url", "mobile_launch_app", "mobile_list_apps", "mobile_get_foreground_app",
	"mobile_take_screenshot", "mobile_long_press_on_screen_at_coordinates", "mobile_terminate_app",
];
const MAX_RESULT = 6000;

// Les lectures d'écran pèsent ~2000 tokens chacune : sans ménage, le contexte déborde en quelques
// tours et Ollama coupe le début (consignes + tâche). On ne garde en entier que les 2 derniers
// résultats d'outil ; les plus anciens sont réduits à leur première ligne.
const compacted = new WeakSet();
function compactHistory(messages) {
	const toolIdx = messages.map((m, i) => (m.role === "tool" ? i : -1)).filter(i => i >= 0);
	for (const i of toolIdx.slice(0, -2)) {
		const m = messages[i];
		if (compacted.has(m)) continue;
		const first = String(m.content).split("\n").find(l => l.trim() && !l.startsWith("One element per line")) || "";
		m.content = m.tool_name === "mobile_list_elements_on_screen"
			? "(ancienne lecture de l'écran, périmée)"
			: first.slice(0, 200);
		compacted.add(m);
	}
}

async function runOllama({ model, device, task, advanced, think, guard, maxActions, ask, memory }, client, emit, ctl) {
	let actions = 0;
	const show = await (await fetch(`${OLLAMA}/api/show`, { method: "POST", body: JSON.stringify({ model }) })).json();
	const caps = show.capabilities || [];
	const vision = caps.includes("vision");
	const { tools } = await client.listTools();
	// les modèles locaux s'en sortent mieux avec peu d'outils : jeu réduit, sauf en mode avancé
	const allowed = tools.filter(t => (advanced ? !SENSITIVE.filter(n => n.includes("remote") || n.includes("cloud") || n.includes("batch")).includes(t.name) : CORE_LOCAL.includes(t.name))
		&& t.name !== "mobile_list_available_devices" && (vision || t.name !== "mobile_take_screenshot"));
	const ollamaTools = allowed.map(t => {
		const schema = JSON.parse(JSON.stringify(t.inputSchema || { type: "object", properties: {} }));
		if (schema.properties) delete schema.properties.device;
		// « locale » modifie durablement la langue de l'appli sur l'appareil : jamais pour l'agent
		if (schema.properties) delete schema.properties.locale;
		if (schema.required) schema.required = schema.required.filter(r => r !== "device");
		delete schema.$schema;
		let description = (t.description || "").slice(0, 700);
		// les petits modèles confondent le sens du geste et le sens du défilement
		if (t.name === "mobile_swipe_on_screen") {
			description = "Fait glisser le doigt sur l'écran. direction=\"up\" : le doigt monte, la page DESCEND (pour voir la suite, ce qui est plus bas). direction=\"down\" : le doigt descend, la page REMONTE vers le haut. left/right : pages ou onglets voisins.";
			if (schema.properties?.direction) schema.properties.direction.description = "up = voir la suite plus bas dans la page ; down = revenir vers le haut";
		}
		return { type: "function", function: { name: t.name, description, parameters: schema } };
	});

	// « Continuer » : on repart de l'historique de la conversation précédente (sans ses images)
	const messages = memory.messages
		? memory.messages.map(m => { const c = { ...m }; delete c.images; return c; }).concat({ role: "user", content: task })
		: [
			{ role: "system", content: systemPrompt(device, advanced) + (vision ? "" : "\nTu ne vois pas les images : utilise uniquement mobile_list_elements_on_screen pour lire l'écran.") },
			{ role: "user", content: task },
		];
	memory.messages = messages; // mis à jour au fil des tours (même tableau)
	emit({ type: "status", text: `${model} chargé${vision ? " (vision)" : ""} — ${ollamaTools.length} outils` });

	let nudges = 0;
	for (let step = 1; step <= maxActions * 2; step++) {
		if (ctl.stopped) return emit({ type: "status", text: "Arrêté." });
		const ac = new AbortController();
		ctl.stop = () => { ctl.stopped = true; ac.abort(); };
		compactHistory(messages);
		// keep_alive : le modèle reste chargé entre les tours et entre les agents
		const body = { model, messages, tools: ollamaTools, stream: false, keep_alive: "30m", options: { num_ctx: 16384, temperature: 0.2 } };
		if (caps.includes("thinking")) body.think = !!think;
		let res;
		try {
			res = await (await fetch(`${OLLAMA}/api/chat`, { method: "POST", body: JSON.stringify(body), signal: ac.signal })).json();
		} catch (e) {
			if (ctl.stopped) return emit({ type: "status", text: "Arrêté." });
			throw e;
		}
		if (res.error) throw new Error(res.error);
		const msg = res.message || {};
		if (msg.thinking) emit({ type: "thinking", text: msg.thinking });
		if (msg.content && msg.content.trim()) emit({ type: "text", text: msg.content });
		messages.push({ role: "assistant", content: msg.content || "", tool_calls: msg.tool_calls });

		const calls = msg.tool_calls || [];
		if (!calls.length) {
			const content = (msg.content || "").trim();
			if (/R[ÉE]SULTAT\s*:/i.test(content)) return emit({ type: "done", text: content.replace(/^[\s\S]*?R[ÉE]SULTAT\s*:\s*/i, ""), turns: step });
			// les petits modèles annoncent souvent une action sans la faire : on les relance
			if (nudges++ < 4) {
				messages.push({ role: "user", content: "Tu n'as pas terminé : appelle maintenant l'outil adapté (fais défiler l'écran si besoin). Si la tâche est finie, réponds « RÉSULTAT : » suivi du résumé." });
				continue;
			}
			return emit({ type: "done", text: content, turns: step, isError: true });
		}

		for (const call of calls) {
			if (ctl.stopped) return emit({ type: "status", text: "Arrêté." });
			const name = call.function?.name;
			let args = call.function?.arguments || {};
			if (typeof args === "string") { try { args = JSON.parse(args); } catch { args = {}; } }
			emit({ type: "tool", name: String(name).replace(/^mobile_/, "mobile_"), args });
			let text, image = null, isError = false;
			if (!allowed.some(t => t.name === name)) {
				text = `Outil inconnu ou non autorisé : ${name}`; isError = true;
			} else {
				if (name === "mobile_list_elements_on_screen") args.format = "text";
				delete args.locale;
				try {
					if (++actions > maxActions) { emit({ type: "result", name, isError: true, text: "Limite d'actions atteinte." }); return emit({ type: "done", text: `Limite de ${maxActions} actions atteinte : agent arrêté.`, isError: true }); }
					if (guard) {
						let elements = [];
						if (needsScreen(name)) {
							const s = await client.callTool({ name: "mobile_list_elements_on_screen", arguments: { device, format: "json" } });
							elements = parseElements(s.content?.find(c => c.type === "text")?.text);
						}
						const what = sensitiveAction(name, args, elements);
						if (what && !(await ask(what))) throw new Error(`Action refusée par l'utilisateur : ${what}. Ne la refais pas ; arrête-toi et explique ce qu'il faudrait faire.`);
					}
					const r = await client.callTool({ name, arguments: { ...args, device } });
					isError = !!r.isError;
					text = r.content.filter(c => c.type === "text").map(c => c.text).join("\n");
					const img = r.content.find(c => c.type === "image");
					if (img) image = { mime: img.mimeType, data: img.data };
				} catch (e) { text = String(e.message || e); isError = true; }
			}
			emit({ type: "result", name, isError, text, image });
			messages.push({ role: "tool", tool_name: name, content: (text || "(vide)").slice(0, MAX_RESULT) });
			if (image && vision) {
				// une seule capture gardée dans l'historique pour ménager le contexte
				for (const m of messages) delete m.images;
				messages.push({ role: "user", content: "Capture d'écran actuelle :", images: [image.data] });
			}
		}
	}
	emit({ type: "done", text: `Arrêt après ${maxActions} étapes sans conclusion.`, isError: true });
}

module.exports = { listModels, runAgent };
