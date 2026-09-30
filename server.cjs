// Prigojine — serveur local de l'interface web.
// Le moteur de pilotage exécute ses commandes de façon bloquante : chaque appareil a donc son
// propre processus moteur, ce qui permet de piloter plusieurs téléphones/tablettes en parallèle.
const path = require("path");
const fs = require("fs");
const os = require("os");
const express = require("express");

process.env.MOBILEMCP_DISABLE_TELEMETRY = "1";
if (!process.env.ANDROID_HOME && process.env.LOCALAPPDATA) {
	const sdk = path.join(process.env.LOCALAPPDATA, "Android", "Sdk");
	if (fs.existsSync(sdk)) process.env.ANDROID_HOME = sdk;
}

const { ROOT, ENGINE_ENTRY, ENGINE_SERVER } = require("./engine.cjs");
process.chdir(ROOT); // le moteur n'écrit que dans le dossier courant ou le dossier temporaire
const CAPTURES = path.join(__dirname, "captures");
fs.mkdirSync(CAPTURES, { recursive: true });

const { Client, InMemoryTransport } = require("@modelcontextprotocol/client");
const { StdioClientTransport, getDefaultEnvironment } = require("@modelcontextprotocol/client/stdio");
const { createMcpServer } = require(ENGINE_SERVER);

// Le moteur intégré écrit ses traces sur stdout : on les garde discrètes.
const verbose = process.argv.includes("--verbose");
const log = console.log.bind(console);
if (!verbose) console.log = () => {};

/* ---------- Clients MCP ---------- */
// Client principal (in-process) : liste des appareils, cloud.
let mainClient;
async function connectMain() {
	const server = createMcpServer();
	mainClient = new Client({ name: "prigojine", version: "1.0.0" });
	const [a, b] = InMemoryTransport.createLinkedPair();
	await server.connect(b);
	await mainClient.connect(a);
}

// Un processus moteur par appareil, créé à la demande.
const workers = new Map(); // id -> Promise<Client>
function workerFor(device) {
	if (!device) return Promise.resolve(mainClient);
	if (workers.has(device)) return workers.get(device);
	const p = (async () => {
		const transport = new StdioClientTransport({
			command: process.execPath,
			args: [ENGINE_ENTRY],
			cwd: ROOT,
			env: { ...getDefaultEnvironment(), ...process.env, MOBILEMCP_DISABLE_TELEMETRY: "1" },
			stderr: verbose ? "inherit" : "ignore",
		});
		const client = new Client({ name: `prigojine-${device}`, version: "1.0.0" });
		// ne retire l'entrée que si c'est encore la nôtre (un redémarrage a pu en créer une nouvelle)
		transport.onclose = () => { if (workers.get(device) === p) workers.delete(device); };
		await client.connect(transport);
		client.close2 = () => transport.close();
		return client;
	})();
	p.catch(() => { if (workers.get(device) === p) workers.delete(device); });
	workers.set(device, p);
	return p;
}

async function call(name, args = {}) {
	const client = await workerFor(args.device);
	const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 10 * 60 * 1000 });
	const text = r.content.filter(c => c.type === "text").map(c => c.text).join("\n");
	const img = r.content.find(c => c.type === "image");
	return { isError: !!r.isError, text, image: img ? { mime: img.mimeType, data: img.data } : null };
}
const safe = p => p.catch(e => ({ isError: true, text: String(e && e.message || e) }));
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");
const slug = s => String(s).replace(/[^\w.-]/g, "_").slice(0, 40);

/* ---------- Sécurité de l'API locale ---------- */
// Le serveur pilote de vrais téléphones : sans protection, un site web (CSRF, « DNS rebinding »)
// ou une appli installée dans un émulateur (qui voit le PC en 10.0.2.2) pourrait tout contrôler.
// 1. Clé secrète tirée au hasard à chaque démarrage, écrite dans un fichier lisible par l'utilisateur seul.
// 2. La page la reçoit une fois via /?t=<clé> puis dans un cookie HttpOnly SameSite=Strict
//    (jamais envoyé par un autre site). Les outils locaux (guard-mcp, lanceur) l'envoient en en-tête.
// 3. L'en-tête Host doit être localhost/127.0.0.1 (contre le DNS rebinding).
const crypto = require("crypto");
const PORT = Number(process.env.PORT) || 4717;
const TOKEN = crypto.randomBytes(24).toString("hex");
const TOKEN_DIR = path.join(os.homedir(), ".prigojine");
const TOKEN_FILE = path.join(TOKEN_DIR, `token-${PORT}`);
fs.mkdirSync(TOKEN_DIR, { recursive: true });
fs.writeFileSync(TOKEN_FILE, TOKEN, { mode: 0o600 });
const sameToken = t => { const a = Buffer.from(String(t || "")), b = Buffer.from(TOKEN); return a.length === b.length && crypto.timingSafeEqual(a, b); };
const cookieToken = req => ((req.headers.cookie || "").match(/(?:^|;\s*)pg=([0-9a-f]+)/) || [])[1];
const HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`]);

const app = express();
app.disable("x-powered-by");
app.use((req, res, next) => {
	if (!HOSTS.has(String(req.headers.host || "").toLowerCase())) return res.status(403).type("text").send("Hôte non autorisé");
	const origin = req.headers.origin;
	if (origin && !HOSTS.has(origin.replace(/^https?:\/\//, "").toLowerCase())) return res.status(403).type("text").send("Origine non autorisée");
	next();
});
// ouverture de la page avec la clé : on la range dans le cookie puis on retire la clé de l'adresse
app.get("/", (req, res, next) => {
	if (!req.query.t) return next();
	if (!sameToken(req.query.t)) return res.status(403).type("text").send("Clé invalide : relance Prigojine.");
	res.set("Set-Cookie", `pg=${TOKEN}; HttpOnly; SameSite=Strict; Path=/`).redirect("/");
});
const requireToken = (req, res, next) => (sameToken(cookieToken(req)) || sameToken(req.headers["x-prigojine-token"]))
	? next() : res.status(401).json({ isError: true, text: "Accès refusé : ouvre Prigojine avec Prigojine.exe ou Lancer-Prigojine.bat.", auth: false });
app.use("/api", requireToken);
app.use("/captures", requireToken);
app.use(express.json({ limit: "2mb" }));
app.use((req, res, next) => { if (req.body === undefined) req.body = {}; next(); }); // Express 5 : pas de corps -> undefined
app.use(express.static(path.join(__dirname, "public")));
app.use("/captures", express.static(CAPTURES));

// Téléversement : le corps de la requête est écrit directement sur le disque (pas tout en mémoire)
function receiveFile(req, dest) {
	return new Promise((resolve, reject) => {
		const out = fs.createWriteStream(dest);
		req.pipe(out);
		out.on("finish", resolve);
		out.on("error", reject);
		req.on("error", reject);
	});
}

// Appel générique d'un outil mobile_*
app.post("/api/call", async (req, res) => {
	const { name, args } = req.body || {};
	if (typeof name !== "string" || !/^mobile_[a-z_]+$/.test(name)) return res.status(400).json({ isError: true, text: "Outil invalide" });
	// une vraie action (pas une simple lecture) garde l'appareil « actif » pour l'arrêt automatique
	if (!/^mobile_(list_|get_|take_screenshot)/.test(name)) watch.touch(args && args.device);
	res.json(await safe(call(name, args || {})));
});

// Capture d'écran brute (affichage en direct)
app.get("/api/screen", async (req, res) => {
	const r = await safe(call("mobile_take_screenshot", { device: String(req.query.device), maxSize: Number(req.query.max) || 900 }));
	if (!r.image) return res.status(500).type("text").send(r.text || "Pas d'image");
	res.set("Cache-Control", "no-store").type(r.image.mime).send(Buffer.from(r.image.data, "base64"));
});

// Capture en pleine résolution dans gui/captures
app.post("/api/save-screenshot", async (req, res) => {
	const name = `capture-${slug(req.body.device)}-${stamp()}.png`;
	const r = await safe(call("mobile_save_screenshot", { device: req.body.device, saveTo: path.join(CAPTURES, name) }));
	res.json({ ...r, url: r.isError ? null : `/captures/${name}` });
});

// Enregistrement vidéo
app.post("/api/record/start", async (req, res) => {
	const name = `video-${slug(req.body.device)}-${stamp()}.mp4`;
	const r = await safe(call("mobile_start_screen_recording", { device: req.body.device, output: path.join(CAPTURES, name) }));
	res.json({ ...r, url: `/captures/${name}` });
});

// Installation d'une appli envoyée depuis le navigateur
app.post("/api/install", async (req, res) => {
	const file = String(req.query.name || "app.apk").replace(/[^\w.\-]/g, "_").replace(/^\.+/, "") || "app.apk";
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prigojine-"));
	try {
		const target = path.join(dir, file);
		await receiveFile(req, target);
		res.json(await safe(call("mobile_install_app", { device: String(req.query.device), path: target })));
	} catch (e) {
		res.json({ isError: true, text: String(e.message || e) });
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

// Envoi d'un fichier déposé sur un écran vers le dossier Téléchargements de l'appareil
app.post("/api/push", async (req, res) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prigojine-"));
	const tmp = path.join(dir, "upload.bin");
	try {
		await receiveFile(req, tmp);
		const remote = await require("./android.cjs").pushFile(String(req.query.device), tmp, String(req.query.name || "fichier"));
		res.json({ isError: false, text: `Envoyé dans ${remote.replace("/sdcard/", "")}`, remote });
	} catch (e) {
		res.json({ isError: true, text: String(e.message || e) });
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

app.get("/api/captures", (req, res) => {
	const files = fs.readdirSync(CAPTURES).filter(f => /\.(png|jpg|mp4)$/i.test(f))
		.map(f => ({ name: f, url: `/captures/${f}`, size: fs.statSync(path.join(CAPTURES, f)).size, mtime: fs.statSync(path.join(CAPTURES, f)).mtimeMs }))
		.sort((a, b) => b.mtime - a.mtime);
	res.json(files);
});

/* ---------- Notifications, réglages, surveillance ---------- */
const watch = require("./watch.cjs");
app.get("/api/notes", (req, res) => res.json(watch.notesSince(req.query.since)));
app.get("/api/settings", (req, res) => res.json(watch.getSettings()));
app.post("/api/settings", (req, res) => res.json(watch.setSettings(req.body || {})));
// un émulateur planté ou arrêté : son processus moteur est fermé pour repartir proprement
watch.start(name => { workers.get(name)?.then(c => c.close2?.()).catch(() => {}); workers.delete(name); }, name => running.has(name));

/* ---------- Agents (un par appareil, en parallèle) ---------- */
const agent = require("./agent.cjs");
const memories = new Map(); // appareil -> contexte de la dernière conversation (pour « Continuer »)
const running = new Map(); // device -> contrôleur
const runs = new Map();    // runId -> { ask }
const confirms = new Map(); // id -> { device, resolve }

app.get("/api/agent/models", async (req, res) => res.json(await agent.listModels()));
app.get("/api/agent/running", (req, res) => res.json([...running.keys()]));
// Modèle local actuellement partagé par les agents en cours (null si aucun)
const sharedLocalModel = () => [...running.values()].find(c => c.provider === "local")?.model || null;
app.get("/api/agent/shared", (req, res) => res.json({ local: sharedLocalModel() }));

// Flux NDJSON : un événement par ligne tant que l'agent travaille
app.post("/api/agent/run", async (req, res) => {
	const { provider, device, task, advanced, think } = req.body || {};
	let { model } = req.body || {};
	if (!["claude", "local"].includes(provider) || !model || !device || !task) return res.status(400).json({ error: "Paramètres manquants." });
	if (running.has(device)) return res.status(409).json({ error: "Un agent travaille déjà sur cet appareil." });
	// Tous les agents locaux utilisent le même modèle : un seul modèle chargé sur la carte
	// graphique, qu'Ollama sert en parallèle au lieu de décharger/recharger à chaque tour.
	const shared = provider === "local" ? sharedLocalModel() : null;
	const aligned = shared && shared !== model ? model : null;
	if (shared) model = shared;
	running.set(device, { provider, model, stop() {} });
	const runId = crypto.randomUUID();
	let client;
	try { client = await workerFor(device); } catch (e) { running.delete(device); return res.status(500).json({ error: String(e.message || e) }); }
	res.set({ "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" });
	res.flushHeaders();
	const send = ev => { if (!res.writableEnded) res.write(JSON.stringify(ev) + "\n"); };
	if (aligned) send({ type: "status", text: `Modèle aligné sur ${model} (déjà utilisé par les autres agents) au lieu de ${aligned}.` });
	// Demande d'accord à l'utilisateur : l'événement part dans le flux, la réponse arrive par /api/agent/confirm
	const ask = action => new Promise(resolve => {
		const id = crypto.randomUUID();
		const timer = setTimeout(() => { confirms.delete(id); resolve(false); }, 5 * 60 * 1000);
		confirms.set(id, { device, action, resolve: allow => { clearTimeout(timer); confirms.delete(id); resolve(allow); } });
		send({ type: "confirm", id, action });
		watch.notify("ask", "Accord demandé", `${device} : ${action}`, device);
	});
	const { guard = true, maxActions = 40 } = req.body || {};
	// plafond vide ou nul : on garde 1 $ (pas de dépense illimitée par erreur)
	const budget = +req.body.budget > 0 ? Math.min(50, +req.body.budget) : 1;
	// « Continuer » : on reprend le contexte de la conversation précédente sur cet appareil
	const prev = memories.get(device);
	const memory = req.body.continue && prev && prev.provider === provider && prev.model === model ? prev : { provider, model };
	if (req.body.continue && memory !== prev) send({ type: "status", text: "Pas de conversation précédente avec ce modèle : nouvelle conversation." });
	else if (req.body.continue) send({ type: "status", text: "Suite de la conversation précédente." });
	memories.set(device, memory);
	watch.touch(device);
	const ctl = agent.runAgent({
		provider, model, device, task, advanced: !!advanced, think: !!think,
		guard: !!guard, maxActions: Math.max(1, Math.min(200, +maxActions || 40)), budget,
		runId, studioUrl: `http://127.0.0.1:${PORT}`, token: TOKEN, ask, memory,
	}, client, ev => {
		send(ev);
		if (ev.type === "tool") watch.touch(device);
		if (ev.type === "done") watch.notify(ev.isError ? "warn" : "ok", ev.isError ? "Agent interrompu" : "Agent terminé", `${device} : ${ev.text || ""}`, device);
		if (ev.type === "error") watch.notify("error", "Erreur de l'agent", `${device} : ${ev.text}`, device);
		if (ev.type === "end") {
			running.delete(device); runs.delete(runId); res.end();
			for (const [id, c] of confirms) if (c.device === device) c.resolve(false);
		}
	});
	Object.assign(ctl, { provider, model });
	runs.set(runId, { ask });
	running.set(device, ctl);
	// l'agent survit à un rechargement de la page : on arrête seulement d'écrire dans le flux fermé
});

// Demandes de confirmation en attente (pour les retrouver après un rechargement de la page)
app.get("/api/agent/confirms", (req, res) => res.json([...confirms].map(([id, c]) => ({ id, device: c.device, action: c.action }))));

// Réponse de l'utilisateur à une demande de confirmation
app.post("/api/agent/confirm", (req, res) => {
	const c = confirms.get(req.body && req.body.id);
	if (c) c.resolve(req.body.allow === true);
	res.json({ ok: !!c });
});
// Appelé par guard-mcp.cjs (agent Claude) : attend la décision de l'utilisateur
app.post("/api/guard/ask", async (req, res) => {
	const r = runs.get(req.body && req.body.run);
	if (!r) return res.json({ allow: false });
	res.json({ allow: await r.ask(String(req.body.action || "action sensible")) });
});

app.post("/api/agent/stop", (req, res) => {
	const d = req.body && req.body.device;
	for (const [id, ctl] of running) if (!d || id === d) ctl.stop();
	res.json({ ok: true });
});

/* ---------- Émulateurs ---------- */
const android = require("./android.cjs");
app.get("/api/emulators", async (req, res) => {
	const r = await android.listEmulators();
	for (const e of r.emulators) { const err = watch.getEmuError(e.name); if (err && !e.running) e.error = { message: err.message, t: err.t }; }
	res.json(r);
});
// journal de démarrage d un émulateur (diagnostic)
app.get("/api/emulators/log", (req, res) => res.type("text").send(android.readEmuLog(String(req.query.name).replace(/[^\w.\-]/g, ""), 120) || "(journal vide)"));
// Démarrage par lot : lancés à 5 s d'intervalle (évite de saturer le PC d'un coup), sans attendre la fin
app.post("/api/emulators/start-many", async (req, res) => {
	const names = (Array.isArray(req.body.names) ? req.body.names : []).map(String).slice(0, 30);
	const { emulators } = await android.listEmulators();
	const todo = names.filter(n => emulators.some(e => e.name === n && !e.running));
	res.json({ ok: true, count: todo.length, text: todo.length ? `${todo.length} émulateur(s) en cours de lancement (un toutes les 5 s)` : "Rien à démarrer" });
	for (const n of todo) {
		watch.markStarted(n);
		await android.startEmulator(n, { light: req.body.light !== false }).then(() => { watch.monitorStart(n); }).catch(e => watch.setEmuError(n, e.message));
		await new Promise(ok => setTimeout(ok, 5000));
	}
	if (todo.length) watch.notify("info", "Démarrage par lot lancé", `${todo.length} émulateur(s) : ils apparaîtront dans la grille une fois prêts.`);
});
app.post("/api/emulators/stop-many", async (req, res) => {
	const names = (Array.isArray(req.body.names) ? req.body.names : []).map(String).slice(0, 30);
	for (const n of names) {
		watch.markStoppedByUser(n);
		workers.get(n)?.then(c => c.close2?.()).catch(() => {}); workers.delete(n);
		await android.stopEmulator(n).catch(() => android.killEmulator(n));
	}
	res.json({ ok: true, text: `${names.length} émulateur(s) arrêté(s)` });
});
app.post("/api/emulators/start", async (req, res) => {
	try {
		watch.markStarted(String(req.body.name));
		const name = String(req.body.name);
		await android.startEmulator(name, { cold: !!req.body.cold, light: req.body.light !== false });
		watch.monitorStart(name); // suit le démarrage et explique un éventuel échec
		// un premier démarrage peut prendre jusqu'à ~15 min : on n'attend qu'une minute,
		// l'appareil apparaîtra ensuite tout seul dans la grille
		const ok = await android.waitBoot(name, 60000);
		const err = !ok && watch.getEmuError(name);
		if (err) return res.json({ ok: false, text: err.message, log: true });
		res.json({ ok: true, booted: ok, text: ok ? "Émulateur démarré" : "Démarrage en cours : il apparaîtra dans la grille dès qu'il est prêt (1 à 3 min, jusqu'à 15 min la toute première fois)" });
	} catch (e) {
		watch.setEmuError(String(req.body.name), String(e.message || e));
		res.json({ ok: false, text: String(e.message || e) });
	}
});
app.post("/api/emulators/stop", async (req, res) => {
	try {
		const name = String(req.body.name);
		watch.markStoppedByUser(name);
		workers.get(name)?.then(c => c.close2?.()).catch(() => {});
		workers.delete(name);
		await android.stopEmulator(name).catch(() => android.killEmulator(name));
		res.json({ ok: true, text: "Émulateur arrêté" });
	} catch (e) { res.json({ ok: false, text: String(e.message || e) }); }
});

/* ---------- Fichiers du téléphone (lecture seule) ---------- */
app.get("/api/files", async (req, res) => {
	try { res.json(await android.listDir(String(req.query.device), String(req.query.dir || "/sdcard"))); }
	catch (e) { res.json({ error: String(e.message || e) }); }
});
// ?inline=1 : aperçu dans le navigateur ; sinon téléchargement
app.get("/api/files/get", async (req, res) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prigojine-pull-"));
	try {
		const local = await android.pullFile(String(req.query.device), String(req.query.path), dir);
		const name = path.basename(local);
		if (req.query.inline) res.set("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(name)}`);
		else res.attachment(name);
		res.sendFile(local, err => { fs.rmSync(dir, { recursive: true, force: true }); if (err && !res.headersSent) res.status(500).end(); });
	} catch (e) {
		fs.rmSync(dir, { recursive: true, force: true });
		res.status(500).type("text").send(String(e.message || e));
	}
});

/* ---------- Touches spéciales ---------- */
app.post("/api/key", async (req, res) => {
	try { await android.pressKey(String(req.body.device), String(req.body.key), req.body.times); res.json({ isError: false, text: "ok" }); }
	catch (e) { res.json({ isError: true, text: String(e.message || e) }); }
});

/* ---------- Wi-Fi ---------- */
const wifiRoute = fn => async (req, res) => {
	try { res.json({ ok: true, ...(await fn(req.body || {})) }); }
	catch (e) { res.json({ ok: false, text: String(e.message || e) }); }
};
app.get("/api/wifi", async (req, res) => res.json(await android.wifiDevices()));
app.post("/api/wifi/usb", wifiRoute(async b => ({ text: `Connecté en Wi-Fi (${await android.usbToWifi(String(b.device))}). Tu peux débrancher le câble.` })));
app.post("/api/wifi/pair", wifiRoute(async b => {
	const r = await android.pairWifi(String(b.hostport || "").trim(), String(b.code || "").trim());
	return { text: r.connected ? "Associé et connecté en Wi-Fi." : "Associé. Entre maintenant l'adresse et le port affichés sous « Débogage sans fil » pour te connecter.", connected: r.connected };
}));
app.post("/api/wifi/connect", wifiRoute(async b => ({ text: `Connecté (${await android.connectWifi(String(b.hostport || "").trim())}).` })));
app.post("/api/wifi/disconnect", wifiRoute(async b => { await android.disconnectWifi(String(b.serial)); return { text: "Déconnecté." }; }));

/* ---------- Flux vidéo (Android) ---------- */
app.get("/api/stream-info", (req, res) => res.json({ available: android.hasFfmpeg }));
app.get("/api/stream", async (req, res) => {
	try { await android.streamScreen(String(req.query.device), res, { width: Math.min(1080, +req.query.w || 540) }); }
	catch (e) { if (!res.headersSent) res.status(500).type("text").send(String(e.message || e)); else res.end(); }
});

/* ---------- Macros (enregistrées dans gui/macros.json) ---------- */
const MACROS = path.join(__dirname, "macros.json");
const readMacros = () => { try { return JSON.parse(fs.readFileSync(MACROS, "utf8")); } catch { return []; } };
const writeMacros = list => fs.writeFileSync(MACROS, JSON.stringify(list, null, 2));
app.get("/api/macros", (req, res) => res.json(readMacros()));
app.post("/api/macros", (req, res) => {
	const m = req.body || {};
	if (!m.name || !Array.isArray(m.steps)) return res.status(400).json({ error: "Macro invalide" });
	const list = readMacros().filter(x => x.id !== m.id);
	const macro = { id: m.id || crypto.randomUUID(), name: String(m.name).slice(0, 80), steps: m.steps.slice(0, 500), created: m.created || Date.now() };
	list.unshift(macro); writeMacros(list); res.json(macro);
});
app.delete("/api/macros/:id", (req, res) => { writeMacros(readMacros().filter(x => x.id !== req.params.id)); res.json({ ok: true }); });

// erreurs inattendues : message court, sans chemin local ni pile d'appels
app.use((err, req, res, next) => { res.status(500).json({ isError: true, text: "Erreur interne : " + String(err && err.message || err).slice(0, 200) }); });

connectMain().then(() => {
	app.listen(PORT, "127.0.0.1", () => {
		const url = `http://localhost:${PORT}/?t=${TOKEN}`;
		log(`Prigojine : http://localhost:${PORT}`);
		// --open : ouvre la page avec la clé (Lancer-Prigojine.bat)
		if (process.argv.includes("--open")) require("child_process").spawn("rundll32", ["url.dll,FileProtocolHandler", url], { detached: true, stdio: "ignore" }).unref();
	});
}).catch(e => { console.error(e); process.exit(1); });
process.on("exit", () => { try { fs.rmSync(TOKEN_FILE, { force: true }); } catch { /* déjà supprimé */ } });

const shutdown = async () => { for (const p of workers.values()) (await p.catch(() => null))?.close2?.(); process.exit(0); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
