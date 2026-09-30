// Réparation en un clic des émulateurs qui ne démarrent pas (selon la cause diagnostiquée).
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { execFile, spawn } = require("child_process");
const android = require("./android.cjs");
const { download } = require("./download.cjs");

// dossier du catalogue Google : les images « default » sont rangées sous « android »
const IMG_REPO = tag => `https://dl.google.com/android/repository/sys-img/${tag === "default" ? "android" : tag}/`;
const REPO = "https://dl.google.com/android/repository/";

// Réparations proposées pour chaque type d'erreur (libellé du bouton)
const ACTIONS = {
	accel: "Activer l'hyperviseur Windows",
	image: "Télécharger l'image Android",
	lock: "Débloquer",
	memory: "Arrêter les autres émulateurs",
	gpu: "Passer en rendu logiciel",
	disk: "Ouvrir le stockage Windows",
	other: "Réessayer à froid",
};

const run = (file, args, timeout = 60000) => new Promise(resolve =>
	execFile(file, args, { timeout, windowsHide: true }, (e, out, err) => resolve({ ok: !e, code: e ? e.code : 0, out: String(out || "") + String(err || "") })));

/* ---------- Licence du SDK Android (texte officiel lu chez Google) ---------- */
let licenseCache = null;
async function androidLicense() {
	if (licenseCache) return licenseCache;
	const xml = await (await fetch(REPO + "repository2-3.xml")).text();
	const m = xml.match(/<license id="android-sdk-license" type="text">([\s\S]*?)<\/license>/);
	licenseCache = m ? m[1].replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").trim() : null;
	if (!licenseCache) throw new Error("Licence introuvable dans le catalogue de Google");
	return licenseCache;
}

/* ---------- Image Android manquante : téléchargement vérifié ---------- */
// sysdir = « system-images\android-36.1\google_apis_playstore\x86_64 »
async function downloadImage(sysdir, progress) {
	const parts = sysdir.split(/[\\/]+/);
	if (parts.length !== 4 || parts[0] !== "system-images" || !parts.slice(1).every(p => /^[\w.\-]+$/.test(p))) throw new Error("Image inconnue : " + sysdir);
	const [, api, tag, abi] = parts;
	const pkgPath = `system-images;${api};${tag};${abi}`;
	progress(0, "Lecture du catalogue de Google…");
	const xml = await (await fetch(IMG_REPO(tag) + "sys-img2-3.xml")).text();
	const channels = Object.fromEntries([...xml.matchAll(/<channel id="([^"]+)">([^<]+)<\/channel>/g)].map(m => [m[1], m[2]]));
	let best = null;
	for (const m of xml.matchAll(/<remotePackage path="([^"]+)">([\s\S]*?)<\/remotePackage>/g)) {
		if (m[1] !== pkgPath) continue;
		const ch = (m[2].match(/<channelRef ref="([^"]+)"/) || [])[1];
		if (ch && channels[ch] !== "stable") continue;
		const rev = +((m[2].match(/<revision>\s*<major>(\d+)/) || [])[1] || 0);
		for (const a of m[2].matchAll(/<archive>([\s\S]*?)<\/archive>/g)) {
			const os_ = (a[1].match(/<host-os>([^<]+)</) || [])[1];
			if (os_ && os_ !== "windows") continue;
			if (!best || rev > best.rev) best = { rev, url: a[1].match(/<url>([^<]+)</)[1], size: +a[1].match(/<size>(\d+)</)[1], sha1: a[1].match(/<checksum[^>]*>([^<]+)</)[1].toLowerCase() };
		}
	}
	if (!best) throw new Error(`Image ${api} (${tag}) introuvable dans le catalogue de Google.`);
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "prigojine-img-"));
	try {
		const zip = path.join(tmp, "image.zip");
		let last = -1;
		await download(IMG_REPO(tag) + best.url, zip, {
			size: best.size, algo: "sha1", expected: best.sha1,
			progress: (done, total) => { const pct = Math.floor(done * 100 / (total || best.size)); if (pct !== last) { last = pct; progress(pct, `Téléchargement : ${(done / 1048576).toFixed(0)} / ${(best.size / 1048576).toFixed(0)} Mo`); } },
		});
		progress(100, "Décompression…");
		const parent = path.join(android.SDK, "system-images", api, tag);
		fs.mkdirSync(parent, { recursive: true });
		// tar.exe (fourni avec Windows 10/11) sait décompresser les .zip
		const r = await run(path.join(process.env.WINDIR || "C:\\Windows", "System32", "tar.exe"), ["-xf", zip, "-C", parent], 30 * 60000);
		if (!r.ok || !fs.existsSync(path.join(android.SDK, sysdir, "system.img"))) throw new Error("Décompression impossible : " + r.out.slice(0, 200));
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
}

/* ---------- Exécution d'une réparation ---------- */
// Renvoie { text, restart } ; restart = relancer l'émulateur ensuite
async function repair(name, code, { accepted = false, progress = () => {}, others = [] } = {}) {
	if (!/^[\w.\-]+$/.test(name)) throw new Error("Nom d'émulateur invalide");
	switch (code) {
		case "accel": {
			// Windows affiche lui-même la demande d'autorisation (droits administrateur)
			const ps = "Start-Process -FilePath dism.exe -ArgumentList '/online','/enable-feature','/featurename:HypervisorPlatform','/all','/norestart' -Verb RunAs -Wait -WindowStyle Hidden -PassThru | Select-Object -ExpandProperty ExitCode";
			const r = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], 10 * 60000);
			const exit = parseInt(r.out.trim().split(/\s+/).pop(), 10);
			if (!r.ok || !(exit === 0 || exit === 3010)) throw new Error(/annul|cancel/i.test(r.out) ? "Autorisation refusée : rien n'a été modifié." : "Activation impossible (code " + (isNaN(exit) ? "?" : exit) + "). Vérifie aussi que la virtualisation est activée dans le BIOS.");
			return { text: "Hyperviseur Windows activé. Redémarre le PC, puis relance l'émulateur. (Si ça ne suffit pas : active la virtualisation VT-x / AMD-V / SVM dans le BIOS.)", restart: false };
		}
		case "image": {
			if (!accepted) throw new Error("Il faut accepter la licence du SDK Android.");
			const { sysdir } = android.avdInfo(name);
			if (!sysdir) throw new Error("Cet émulateur n'indique pas son image Android.");
			await downloadImage(sysdir, progress);
			return { text: "Image Android installée.", restart: true };
		}
		case "lock": {
			await android.killEmulator(name);
			const { dir } = android.avdInfo(name);
			for (const f of fs.readdirSync(dir)) if (f.endsWith(".lock")) fs.rmSync(path.join(dir, f), { recursive: true, force: true });
			return { text: "Verrous supprimés.", restart: true };
		}
		case "memory": {
			for (const o of others) await android.stopEmulator(o).catch(() => android.killEmulator(o));
			return { text: others.length ? `${others.length} autre(s) émulateur(s) arrêté(s) pour libérer la mémoire.` : "Aucun autre émulateur à arrêter : ferme des applications gourmandes.", restart: true };
		}
		case "gpu": {
			const info = android.avdInfo(name);
			const cfg = /^hw\.gpu\.mode\s*=/m.test(info.config) ? info.config.replace(/^hw\.gpu\.mode\s*=.*$/m, "hw.gpu.mode = swiftshader_indirect") : info.config.trimEnd() + "\nhw.gpu.mode = swiftshader_indirect\n";
			fs.writeFileSync(info.configFile, cfg);
			return { text: "Rendu logiciel activé pour cet émulateur (plus lent, mais sans dépendre du pilote graphique).", restart: true };
		}
		case "disk": {
			spawn("explorer.exe", ["ms-settings:storagesense"], { detached: true, stdio: "ignore" }).unref();
			return { text: "Paramètres de stockage ouverts : libère au moins 5 Go puis relance l'émulateur.", restart: false };
		}
		default:
			return { text: "Nouvel essai avec un démarrage complet.", restart: true, cold: true };
	}
}

module.exports = { ACTIONS, repair, androidLicense };
