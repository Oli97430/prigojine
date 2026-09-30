// Mise à jour : vérifie la dernière version publiée sur GitHub et installe l'installateur à jour.
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { download } = require("./download.cjs");

const REPO = "Oli97430/prigojine";
const CURRENT = require("./package.json").version;
const ROOT = __dirname;
const INSTALL_DIR = path.resolve(ROOT, "..");

// installé (installateur) / portable (Prigojine.exe sans installateur) / sources (développement)
const mode = () => fs.existsSync(path.join(INSTALL_DIR, "Desinstaller.cmd")) ? "installed"
	: fs.existsSync(path.join(INSTALL_DIR, "Prigojine.exe")) ? "portable" : "source";

const newer = (a, b) => { // a plus récent que b ?
	const pa = String(a).replace(/^v/, "").split(".").map(n => parseInt(n, 10) || 0), pb = String(b).replace(/^v/, "").split(".").map(n => parseInt(n, 10) || 0);
	for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
	return false;
};

let cache = null;
async function check(force = false) {
	if (!force && cache && Date.now() - cache.t < 6 * 3600000) return cache.info;
	const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { "User-Agent": "Prigojine/" + CURRENT, Accept: "application/vnd.github+json" } });
	if (!res.ok) throw new Error("GitHub ne répond pas (" + res.status + ")");
	const r = await res.json();
	const latest = String(r.tag_name || "").replace(/^v/, "");
	const asset = (r.assets || []).find(a => a.name === "Installer-Prigojine.exe");
	const info = {
		current: CURRENT, latest, newer: newer(latest, CURRENT), mode: mode(),
		url: r.html_url, notes: String(r.body || "").slice(0, 2000), title: r.name || ("Prigojine " + latest),
		installer: asset ? { url: asset.browser_download_url, size: asset.size, digest: asset.digest || null } : null,
	};
	cache = { t: Date.now(), info };
	return info;
}

// Télécharge l'installateur (somme de contrôle vérifiée si GitHub la fournit) puis le lance en mode mise à jour
const state = { state: "idle", pct: 0, text: "" };
async function install() {
	if (state.state === "run") throw new Error("Mise à jour déjà en cours.");
	const info = await check(true);
	if (!info.newer) throw new Error("Prigojine est déjà à jour.");
	if (info.mode !== "installed") throw new Error("Mise à jour automatique disponible seulement pour la version installée.");
	if (!info.installer) throw new Error("Installateur introuvable dans la dernière version.");
	Object.assign(state, { state: "run", pct: 0, text: "Téléchargement de la mise à jour…" });
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prigojine-maj-"));
	const exe = path.join(dir, "Installer-Prigojine.exe");
	try {
		// sans empreinte fournie par GitHub, on refuse : on n'exécute pas un fichier non vérifié
		if (!info.installer.digest) throw new Error("GitHub ne fournit pas l'empreinte de l'installateur : télécharge-le depuis la page des versions.");
		await download(info.installer.url, exe, {
			size: info.installer.size, algo: "sha256", expected: info.installer.digest, headers: { "User-Agent": "Prigojine/" + CURRENT },
			progress: (done, total) => {
				state.pct = total ? Math.floor(done * 100 / total) : 0;
				state.text = `Téléchargement : ${(done / 1048576).toFixed(0)} / ${(total / 1048576).toFixed(0)} Mo`;
			},
		});
		Object.assign(state, { pct: 100, text: "Installation… Prigojine va redémarrer." });
		// l'installateur ferme Prigojine, remplace l'application (données conservées) et le relance
		spawn(exe, ["/update", `/dir=${INSTALL_DIR}`], { detached: true, stdio: "ignore", windowsHide: false }).unref();
	} catch (e) {
		Object.assign(state, { state: "ko", text: String(e.message || e) });
		fs.rmSync(dir, { recursive: true, force: true });
		throw e;
	}
}

module.exports = { check, install, state, CURRENT, mode };
