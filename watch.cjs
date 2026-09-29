// Notifications + surveillance des émulateurs (arrêt des inactifs, redémarrage des plantés/figés).
const fs = require("fs");
const path = require("path");
const android = require("./android.cjs");

/* ---------- Réglages (gui/settings.json) ---------- */
const SETTINGS = path.join(__dirname, "settings.json");
const DEFAULTS = { idleMinutes: 0, autoRestart: true, notifyDevices: true };
let settings = { ...DEFAULTS };
try { settings = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(SETTINGS, "utf8")) }; } catch { /* premier lancement */ }
const getSettings = () => ({ ...settings });
function setSettings(patch) {
	if ("idleMinutes" in patch) settings.idleMinutes = Math.max(0, Math.min(600, +patch.idleMinutes || 0));
	if ("autoRestart" in patch) settings.autoRestart = !!patch.autoRestart;
	if ("notifyDevices" in patch) settings.notifyDevices = !!patch.notifyDevices;
	fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2));
	return getSettings();
}

/* ---------- Notifications ---------- */
// Lues par l'icône de l'horloge (Prigojine.exe) et par la page (notifications du navigateur).
const notes = [];
let nextId = 1;
function notify(kind, title, text, device = null) {
	notes.push({ id: nextId++, t: Date.now(), kind, title, text: String(text || "").slice(0, 240), device });
	while (notes.length > 200) notes.shift();
}
const notesSince = id => notes.filter(n => n.id > (+id || 0));

/* ---------- Activité des appareils ---------- */
// Seules les vraies actions comptent (pas l'affichage en direct de l'écran).
const lastActive = new Map(); // id de l'appareil -> timestamp
const touch = id => { if (id) lastActive.set(id, Date.now()); };

/* ---------- Surveillance ---------- */
const state = new Map(); // nom AVD -> { booted, fails, restarting, stoppedByUser, restarts }
const st = name => { if (!state.has(name)) state.set(name, { booted: false, fails: 0, restarting: false, stoppedByUser: false, restarts: 0, managed: false, gone: 0 }); return state.get(name); };
const markStoppedByUser = name => { st(name).stoppedByUser = true; st(name).booted = false; };
const markStarted = name => { const s = st(name); s.stoppedByUser = false; s.fails = 0; s.managed = true; touch(name); };

let knownDevices = null;
let isBusy = () => false; // agent ou enregistrement en cours sur l'appareil (fourni par le serveur)
async function tick(onEmulatorGone) {
	let emus;
	try { emus = (await android.listEmulators()).emulators; } catch { return; }
	const now = Date.now();
	for (const e of emus) {
		const s = st(e.name);
		if (e.running && e.serial) {
			const ok = await android.bootCompleted(e.serial);
			if (ok) {
				if (!s.booted) { s.booted = true; if (s.restarting) notify("ok", "Émulateur redémarré", `${e.name} fonctionne de nouveau.`, e.name); s.restarting = false; }
				s.fails = 0; s.gone = 0;
				if (!lastActive.has(e.name) || isBusy(e.name)) touch(e.name);
				// arrêt automatique des émulateurs inactifs (seulement ceux démarrés par Prigojine)
				if (settings.idleMinutes > 0 && s.managed && now - lastActive.get(e.name) > settings.idleMinutes * 60000) {
					markStoppedByUser(e.name);
					await android.stopEmulator(e.name).catch(() => {});
					onEmulatorGone?.(e.name);
					notify("info", "Émulateur arrêté (inactif)", `${e.name} n'a pas servi depuis ${settings.idleMinutes} min : arrêté pour libérer le PC.`, e.name);
				}
			} else if (s.booted && s.managed && ++s.fails >= 3) {
				// démarré auparavant mais ne répond plus depuis ~1 min : figé
				await restart(e.name, "ne répond plus", onEmulatorGone);
			}
		} else if (!e.running && s.booted && !s.managed) {
			s.booted = false; // arrêté hors de Prigojine : on le laisse arrêté
		} else if (!e.running && s.booted && !s.stoppedByUser && s.managed) {
			// il tournait et a disparu sans qu'on l'arrête. Un simple « offline » passager d'adb ne suffit
			// pas : il faut 2 tours de suite ET que son processus ait vraiment disparu.
			if (++s.gone >= 2 && !(await android.emulatorProcessAlive(e.name))) await restart(e.name, "s'est arrêté brutalement", onEmulatorGone);
		}
	}
	// appareils branchés / débranchés
	if (settings.notifyDevices) {
		const list = (await android.adbDevices().catch(() => [])).filter(d => !d.serial.startsWith("emulator-")).map(d => d.serial);
		if (knownDevices) {
			for (const d of list) if (!knownDevices.includes(d)) notify("info", "Appareil connecté", d, d);
			for (const d of knownDevices) if (!list.includes(d)) notify("warn", "Appareil déconnecté", d, d);
		}
		knownDevices = list;
	}
}

async function restart(name, why, onEmulatorGone) {
	const s = st(name);
	s.booted = false; s.fails = 0; s.gone = 0;
	onEmulatorGone?.(name);
	if (!settings.autoRestart || s.restarts >= 3) {
		notify("error", "Émulateur en panne", `${name} ${why}.${s.restarts >= 3 ? " Trop de redémarrages : arrêt de la surveillance pour lui." : ""}`, name);
		return;
	}
	s.restarting = true; s.restarts++;
	notify("warn", "Émulateur relancé", `${name} ${why} : redémarrage automatique…`, name);
	await android.stopEmulator(name).catch(() => {});
	await android.killEmulator(name).catch(() => {});
	await new Promise(ok => setTimeout(ok, 3000));
	await android.startEmulator(name, { light: true }).catch(e => notify("error", "Redémarrage impossible", `${name} : ${e.message}`, name));
}

function start(onEmulatorGone, busyCheck) {
	if (busyCheck) isBusy = busyCheck;
	let busy = false;
	setInterval(async () => {
		if (busy) return; busy = true;
		try { await tick(onEmulatorGone); } catch { /* on réessaie au tour suivant */ } finally { busy = false; }
	}, 20000);
}

module.exports = { notify, notesSince, touch, lastActive, getSettings, setSettings, markStoppedByUser, markStarted, start };
