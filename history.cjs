// Historique des tâches des agents (history.json, données locales de l'utilisateur).
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const FILE = path.join(__dirname, "history.json");
const MAX_RUNS = 300, MAX_STEPS = 80;

let runs = [];
try { runs = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { /* premier lancement */ }
let saveTimer = null;
const save = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => { try { fs.writeFileSync(FILE, JSON.stringify(runs, null, 1)); } catch { /* disque indisponible */ } }, 500); };

const short = v => { const s = typeof v === "string" ? v : JSON.stringify(v ?? ""); return s.length > 160 ? s.slice(0, 160) + "…" : s; };

// Démarre l'enregistrement d'une tâche ; renvoie un objet qui reçoit les événements de l'agent
function begin({ device, deviceName, provider, model, task, continued }) {
	const run = {
		id: crypto.randomUUID(), t: Date.now(), device, deviceName: deviceName || device,
		provider, model, task: String(task).slice(0, 2000), continued: !!continued,
		status: "run", result: "", cost: null, actions: 0, durationMs: 0, steps: [],
	};
	runs.unshift(run);
	if (runs.length > MAX_RUNS) runs.length = MAX_RUNS;
	save();
	return {
		event(ev) {
			if (ev.type === "tool") { run.actions++; if (run.steps.length < MAX_STEPS) run.steps.push({ tool: String(ev.name || "").replace(/^mobile_/, ""), args: short(ev.args) }); }
			else if (ev.type === "result" && run.steps.length && ev.isError) run.steps[run.steps.length - 1].error = short(ev.text);
			else if (ev.type === "confirm") { if (run.steps.length < MAX_STEPS) run.steps.push({ tool: "accord demandé", args: short(ev.action) }); }
			else if (ev.type === "done") { run.status = ev.isError ? "ko" : "ok"; run.result = String(ev.text || "").slice(0, 4000); run.cost = ev.cost ?? null; }
			else if (ev.type === "error") { run.status = "ko"; run.result = String(ev.text || "").slice(0, 1000); }
			else if (ev.type === "end") { if (run.status === "run") run.status = "ko"; if (!run.result) run.result = "Arrêté."; run.durationMs = Date.now() - run.t; save(); }
		},
	};
}

const list = () => runs;
const remove = id => { runs = runs.filter(r => r.id !== id); save(); };
const clear = () => { runs = []; save(); };

module.exports = { begin, list, remove, clear };
