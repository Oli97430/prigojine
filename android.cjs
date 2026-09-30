// Outils Android de Prigojine : correspondance appareil ↔ numéro adb, gestion des émulateurs,
// et flux vidéo de l'écran (screenrecord H.264 -> ffmpeg -> images JPEG en continu).
const path = require("path");
const fs = require("fs");
const { spawn, execFile } = require("child_process");

const SDK = process.env.ANDROID_HOME || path.join(process.env.LOCALAPPDATA || "", "Android", "Sdk");
const EXE = process.platform === "win32" ? ".exe" : "";
const ADB = path.join(SDK, "platform-tools", "adb" + EXE);
const EMULATOR = path.join(SDK, "emulator", "emulator" + EXE);

function run(file, args, timeout = 15000) {
	return new Promise(resolve => {
		execFile(file, args, { timeout, windowsHide: true }, (err, stdout) => resolve(err ? "" : String(stdout)));
	});
}
const adb = (...args) => run(ADB, args);

/* ---------- Appareils adb ---------- */
// Renvoie [{ serial, avd }] ; pour un émulateur, l'identifiant de l'appareil est le nom de l'AVD
async function adbDevices() {
	const out = await adb("devices");
	const serials = out.split("\n").slice(1).map(l => l.trim().split(/\s+/)).filter(p => p[1] === "device").map(p => p[0]);
	return Promise.all(serials.map(async serial => {
		let avd = null;
		if (serial.startsWith("emulator-")) avd = (await adb("-s", serial, "shell", "getprop", "ro.boot.qemu.avd_name")).trim() || null;
		return { serial, avd };
	}));
}

// Identifiant de l'appareil -> numéro adb (null si ce n'est pas un appareil Android)
async function serialFor(id) {
	const list = await adbDevices();
	const hit = list.find(d => d.serial === id || d.avd === id);
	return hit ? hit.serial : null;
}

/* ---------- Émulateurs ---------- */
async function listEmulators() {
	if (!fs.existsSync(EMULATOR)) return { available: false, emulators: [] };
	const names = (await run(EMULATOR, ["-list-avds"])).split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith("INFO"));
	const running = await adbDevices();
	return {
		available: true,
		emulators: names.map(name => {
			const r = running.find(d => d.avd === name);
			return { name, running: !!r, serial: r?.serial || null };
		}),
	};
}

// Démarre l'émulateur hors du processus de Prigojine (via WMI sous Windows) :
// il continue de tourner même si Prigojine ou la fenêtre qui l'a lancé se ferme.
// light (par défaut) : sans fenêtre, rendu graphique logiciel, sans son — environ 4 à 5 fois
// moins de processeur (mesuré : 3,4 % contre 15,4 % du PC). L'écran se voit dans Prigojine.
/* ---------- Diagnostic des émulateurs ---------- */
const os = require("os");
const LOG_DIR = path.join(os.homedir(), ".prigojine", "emulateurs");
const AVD_HOME = process.env.ANDROID_AVD_HOME || path.join(os.homedir(), ".android", "avd");
// un fichier par démarrage (l'ancien peut rester verrouillé quelques secondes après un arrêt) ;
// seuls les 3 plus récents sont gardés
const emuLogs = name => { try { return fs.readdirSync(LOG_DIR).filter(f => f.startsWith(name + "--") && f.endsWith(".log")).sort(); } catch { return []; } };
const emuLogPath = name => { const l = emuLogs(name); return l.length ? path.join(LOG_DIR, l[l.length - 1]) : path.join(LOG_DIR, `${name}--0.log`); };
function newEmuLog(name) {
	fs.mkdirSync(LOG_DIR, { recursive: true });
	for (const old of emuLogs(name).slice(0, -2)) { try { fs.rmSync(path.join(LOG_DIR, old)); } catch { /* encore ouvert */ } }
	const file = path.join(LOG_DIR, `${name}--${Date.now()}.log`);
	fs.writeFileSync(file, `[${new Date().toLocaleString()}] démarrage de ${name}\n`);
	return file;
}

// Dernières lignes utiles du journal de démarrage d'un émulateur
function readEmuLog(name, lines = 60) {
	try {
		const txt = fs.readFileSync(emuLogPath(name), "utf8").replace(/\r/g, "");
		return txt.split("\n").filter(l => l.trim()).slice(-lines).join("\n");
	} catch { return ""; }
}

// Traduit les messages de l'émulateur en explication et solution
const KNOWN_ERRORS = [
	[/hardware acceleration|x86_64 emulation currently requires|\bHAXM\b|\bWHPX\b|\bAEHD\b|hypervisor|accel(eration)? .*(not|isn't|unavailable|disabled)|VT-x|AMD-V|SVM/i,
		"Accélération matérielle indisponible. Active la « Plateforme de l'hyperviseur Windows » (Paramètres → Système → Fonctionnalités facultatives → Plus de fonctionnalités Windows) et la virtualisation (VT-x / AMD-V / SVM) dans le BIOS, puis redémarre le PC."],
	[/(No initial system image|AVD system path|ANDROID_SDK_ROOT|Cannot find .*system image|system image .*(missing|not found)|kernel.*(not found|missing)|ramdisk.*not found|sysdir)/i,
		"Image Android manquante pour cet émulateur. Ouvre Android Studio → Device Manager et répare/télécharge l'image, ou relance l'installateur de Prigojine."],
	[/Unknown AVD name|Cannot find AVD(?! system)|No AVD/i, "Émulateur introuvable : il a peut-être été supprimé ou renommé dans Android Studio."],
	[/(not enough|insufficient|no) (disk )?space|ENOSPC|disk full/i, "Disque plein : libère au moins 5 Go puis réessaie."],
	[/(Could not|Failed to|cannot) (allocate|reserve).*(memory|RAM)|out of memory|not enough (memory|RAM)|insufficient (RAM|memory)|free up memory|backing store for guest RAM/i, "Pas assez de mémoire (RAM) libre : arrête d'autres émulateurs ou applications."],
	[/(another|already).*(running|instance)|multiinstance|\.lock|is already in use/i, "L'émulateur semble déjà utilisé (ou un verrou est resté après un plantage). Arrête-le, ou redémarre le PC."],
	[/vulkan|gfxstream|OpenGL|\bGPU\b|graphics driver|ANGLE|swiftshader/i, "Problème graphique au démarrage. Mets à jour le pilote de la carte graphique ; si ça continue, décoche « afficher la fenêtre » (rendu logiciel)."],
	[/license|licence/i, "Licence du SDK Android non acceptée : ouvre Android Studio une fois pour l'accepter."],
];
const ERROR_CODES = ["accel", "image", "unknown", "disk", "memory", "lock", "gpu", "license"];
const codedError = (code, message) => Object.assign(new Error(message), { code });

// Diagnostic : { code, message } (code = type d'erreur, pour proposer la bonne réparation)
function diagnoseEmuLog(log) {
	const benign = /Please update the emulator to one that supports the feature|Feature '.*' is overridden|Client not connected yet|Unknown XR viewport|retrieve Vulkan renderer details/i;
	const bad = log.split("\n").filter(l => !/^\s*(USER_)?INFO\b/.test(l) && !benign.test(l) && /FATAL|PANIC|ERROR|WARNING|error|failed|cannot|could not|not found|unable|insufficient/i.test(l)).join("\n");
	for (let i = 0; i < KNOWN_ERRORS.length; i++) if (KNOWN_ERRORS[i][0].test(bad)) return { code: ERROR_CODES[i], message: KNOWN_ERRORS[i][1] };
	return { code: "other", message: explainEmuLog(log) };
}

function explainEmuLog(log) {
	// seules les lignes d'erreur comptent (les messages INFO normaux citent aussi le GPU, etc.)
	const benign = /Please update the emulator to one that supports the feature|Feature '.*' is overridden|Client not connected yet|Unknown XR viewport|retrieve Vulkan renderer details/i; // avertissements normaux
	const bad = log.split("\n").filter(l => !/^\s*(USER_)?INFO\b/.test(l) && !benign.test(l) && /FATAL|PANIC|ERROR|WARNING|error|failed|cannot|could not|not found|unable|insufficient/i.test(l)).join("\n");
	for (const [re, msg] of KNOWN_ERRORS) if (re.test(bad)) return msg;
	const last = bad.split("\n").reverse().find(l => l.trim());
	return "L'émulateur s'est arrêté pendant le démarrage." + (last ? " Dernier message : " + last.replace(/^\s*(FATAL|PANIC|ERROR|WARNING|INFO)\s*\|\s*/i, "").slice(0, 200) : "");
}

// Accélération matérielle (résultat gardé 10 min : la commande prend quelques secondes)
let accelCache = null;
async function accelCheck() {
	if (accelCache && Date.now() - accelCache.t < 600000) return accelCache;
	const out = await new Promise(resolve => execFile(EMULATOR, ["-accel-check"], { timeout: 30000, windowsHide: true }, (e, so, se) => resolve({ code: e ? (e.code ?? 1) : 0, text: String(so || "") + String(se || "") })));
	accelCache = { t: Date.now(), ok: out.code === 0 && /usable|installed and usable|operational/i.test(out.text), text: out.text.trim() };
	return accelCache;
}

// Vérifications avant démarrage : erreurs claires au lieu d'un émulateur qui ne démarre jamais
// Configuration d'un émulateur : dossier, texte de config.ini et image système (image.sysdir.1)
function avdInfo(name) {
	const ini = fs.readFileSync(path.join(AVD_HOME, `${name}.ini`), "utf8");
	const dir = (ini.match(/^path=(.+)$/m) || [])[1]?.trim();
	if (!dir) throw new Error("Configuration de l'émulateur illisible");
	const configFile = path.join(dir, "config.ini");
	const config = fs.readFileSync(configFile, "utf8");
	const sysdir = (config.match(/^image\.sysdir\.1\s*=\s*(.+)$/m) || [])[1]?.trim().replace(/[\\/]+$/, "") || null;
	return { dir, configFile, config, sysdir };
}

async function preflight(name) {
	if (!fs.existsSync(EMULATOR)) throw codedError("noemu", "L'émulateur Android n'est pas installé (Android Studio → SDK Manager → « Android Emulator », ou installateur de Prigojine).");
	const a = await accelCheck();
	if (!a.ok) throw codedError("accel", KNOWN_ERRORS[0][1] + (a.text ? ` (Détail : ${a.text.split("\n").pop().slice(0, 160)})` : ""));
	// image système déclarée dans la configuration de l'émulateur
	try {
		const ini = fs.readFileSync(path.join(AVD_HOME, `${name}.ini`), "utf8");
		const dir = (ini.match(/^path=(.+)$/m) || [])[1]?.trim();
		const cfg = dir ? fs.readFileSync(path.join(dir, "config.ini"), "utf8") : "";
		const sys = (cfg.match(/^image\.sysdir\.1\s*=\s*(.+)$/m) || [])[1]?.trim();
		if (sys && !fs.existsSync(path.join(SDK, sys, "system.img")) && !fs.existsSync(path.join(sys, "system.img"))) {
			throw codedError("image", `Image Android manquante (${sys.replace(/\\$/, "")}). Ouvre Android Studio → Device Manager et répare cet émulateur, ou relance l'installateur de Prigojine.`);
		}
	} catch (e) { if (/Image Android manquante/.test(e.message)) throw e; /* configuration illisible : l'émulateur dira lui-même ce qui ne va pas */ }
}

async function startEmulator(name, { cold = false, light = true } = {}) {
	const { emulators } = await listEmulators();
	if (!emulators.some(e => e.name === name)) throw new Error(`Émulateur inconnu : ${name}`);
	if (!/^[\w.\-]+$/.test(name)) throw new Error("Nom d'émulateur invalide");
	await preflight(name);
	const logFile = newEmuLog(name);
	const args = ["-avd", name]
		.concat(cold ? ["-no-snapshot-load"] : [])
		.concat(light ? ["-no-window", "-gpu", "swiftshader_indirect", "-no-audio"] : []);
	if (process.platform === "win32") {
		// messages de l'émulateur enregistrés dans ~/.prigojine/emulateurs/<nom>.log (diagnostic)
		const cmd = `cmd.exe /s /c ""${EMULATOR}" ${args.join(" ")} >> "${logFile}" 2>&1"`;
		// ShowWindow = 0 : pas de fenêtre de console noire pour l'émulateur
		const ps = `$si = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }; ` +
			`Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${cmd.replace(/'/g, "''")}'; ProcessStartupInformation = $si } | Select-Object -ExpandProperty ReturnValue`;
		const out = (await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], 30000)).trim();
		if (out !== "0") throw new Error("Le lancement de l'émulateur a échoué (code " + (out || "?") + ")");
	} else {
		const out = fs.openSync(logFile, "a");
		spawn(EMULATOR, args, { detached: true, stdio: ["ignore", out, out] }).unref();
	}
}

async function stopEmulator(name) {
	const { emulators } = await listEmulators();
	const e = emulators.find(x => x.name === name);
	if (!e || !e.serial) throw new Error("Cet émulateur ne tourne pas.");
	await adb("-s", e.serial, "emu", "kill");
	// un émulateur figé ignore « emu kill » : on vérifie, puis on force l'arrêt
	for (let i = 0; i < 6 && await emulatorProcessAlive(name); i++) await new Promise(ok => setTimeout(ok, 1000));
	if (await emulatorProcessAlive(name)) await killEmulator(name);
}

// Le processus de l'émulateur existe-t-il encore ?
async function emulatorProcessAlive(name) {
	if (process.platform !== "win32" || !/^[\w.\-]+$/.test(name)) return false;
	const ps = `@(Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'qemu-system*' -and $_.CommandLine -match '-avd\\s+"?${name}(\\s|"|$)' }).Count`;
	return +(await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], 20000)).trim() > 0;
}

// L'émulateur répond-il ? (8 s max : un émulateur figé fait attendre adb indéfiniment)
async function bootCompleted(serial) {
	return (await run(ADB, ["-s", serial, "shell", "getprop", "sys.boot_completed"], 8000)).trim() === "1";
}

// Arrêt forcé d'un émulateur figé (quand « adb emu kill » ne répond plus)
async function killEmulator(name) {
	if (!/^[\w.\-]+$/.test(name)) return;
	if (process.platform === "win32") {
		const ps = `Get-CimInstance Win32_Process | Where-Object { ($_.Name -like 'qemu-system*' -or $_.Name -eq 'emulator.exe') -and $_.CommandLine -match '-avd\\s+"?${name}(\\s|"|$)' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
		await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], 30000);
	}
	const avdDir = path.join(process.env.USERPROFILE || process.env.HOME || "", ".android", "avd", `${name}.avd`);
	for (const f of ["multiinstance.lock", "hardware-qemu.ini.lock"]) fs.rmSync(path.join(avdDir, f), { recursive: true, force: true });
}

// Attend la fin du démarrage (sys.boot_completed = 1)
async function waitBoot(name, timeoutMs = 180000) {
	const t0 = Date.now();
	while (Date.now() - t0 < timeoutMs) {
		const { emulators } = await listEmulators();
		const e = emulators.find(x => x.name === name);
		if (e?.serial && (await adb("-s", e.serial, "shell", "getprop", "sys.boot_completed")).trim() === "1") return true;
		await new Promise(ok => setTimeout(ok, 2500));
	}
	return false;
}

/* ---------- Flux vidéo ---------- */
function findFfmpeg() {
	for (const d of (process.env.PATH || "").split(path.delimiter)) {
		const p = path.join(d, "ffmpeg" + EXE);
		if (fs.existsSync(p)) return p;
	}
	return null;
}
const FFMPEG = findFfmpeg();

// Envoie un flux multipart JPEG (lisible directement par une balise <img>).
// screenrecord s'arrête au bout de 3 min sur beaucoup d'appareils : on le relance tant que le client écoute.
async function streamScreen(id, res, { width = 540 } = {}) {
	if (!FFMPEG) throw new Error("ffmpeg introuvable");
	// écouteur posé tout de suite : si la page abandonne le flux pendant les préparatifs, on s'arrête
	let closed = false, rec = null, ff = null;
	const stop = () => { closed = true; rec?.kill(); ff?.kill(); };
	res.on("close", stop);
	width = Math.max(144, Math.min(1080, Math.round(+width) || 540));
	const serial = await serialFor(id);
	if (!serial) throw new Error("Flux vidéo disponible uniquement pour Android");
	const size = (await adb("-s", serial, "shell", "wm", "size")).match(/(\d+)x(\d+)\s*$/m);
	let w = width, h = Math.round(width * 2);
	if (size) {
		const [W, H] = [+size[1], +size[2]];
		w = Math.min(width, W); h = Math.round(w * H / W);
	}
	w -= w % 2; h -= h % 2; // l'encodeur exige des dimensions paires
	if (closed || res.destroyed) return;
	res.writeHead(200, { "Content-Type": "multipart/x-mixed-replace; boundary=ffmpeg", "Cache-Control": "no-store", Connection: "close" });
	res.flushHeaders();

	while (!closed && !res.destroyed) {
		rec = spawn(ADB, ["-s", serial, "exec-out", "screenrecord", "--output-format=h264", "--size", `${w}x${h}`, "--bit-rate", "4000000", "-"], { windowsHide: true });
		ff = spawn(FFMPEG, ["-loglevel", "error", "-probesize", "32", "-analyzeduration", "0", "-flags", "low_delay", "-f", "h264", "-i", "pipe:0",
			// -flush_packets 1 : chaque image part tout de suite (sinon un écran immobile reste bloqué dans le tampon)
			"-vf", "format=yuvj420p", "-q:v", "7", "-flush_packets", "1", "-f", "mpjpeg", "pipe:1"], { windowsHide: true });
		rec.on("error", () => {}); ff.on("error", () => {}); rec.stdout.on("error", () => {}); ff.stdout.on("error", () => {});
		// Le décodeur de ffmpeg garde chaque image tant que la suivante n'a pas commencé : un écran
		// immobile resterait figé sur l'image d'avant. Dès que l'appareil n'envoie plus rien pendant
		// 40 ms, l'image est complète : on ajoute un « délimiteur d'image » H.264 (sans effet visuel).
		const AUD = Buffer.from([0, 0, 0, 1, 9, 0xf0]);
		let idle = null;
		rec.stdout.on("data", chunk => {
			// contre-pression : si ffmpeg n'absorbe plus, on met l'appareil en pause
			if (!ff.stdin.write(chunk)) { rec.stdout.pause(); ff.stdin.once("drain", () => rec.stdout.resume()); }
			clearTimeout(idle);
			idle = setTimeout(() => { if (!ff.stdin.destroyed) ff.stdin.write(AUD); }, 40);
		});
		rec.stdout.on("end", () => { clearTimeout(idle); ff.stdin.end(); });
		ff.stdin.on("error", () => {});
		let bytes = 0;
		ff.stdout.on("data", chunk => { bytes += chunk.length; if (!closed && !res.destroyed) res.write(chunk); });
		await new Promise(ok => { ff.on("close", ok); ff.on("error", ok); });
		rec.kill();
		// relance rapide après la limite de 3 min ; plus lente si l'appareil ne répond plus
		if (!closed) await new Promise(ok => setTimeout(ok, bytes ? 300 : 3000));
	}
}

/* ---------- Envoi de fichiers ---------- */
// Copie un fichier dans /sdcard/Download sans écraser l'existant, puis le fait indexer
// pour qu'il apparaisse tout de suite dans Photos / Fichiers.
async function pushFile(id, localPath, name) {
	const serial = await serialFor(id);
	if (!serial) throw new Error("Envoi de fichiers disponible uniquement pour Android");
	const clean = String(name).normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\w.\-]+/g, "_").replace(/^\.+/, "").slice(0, 120) || "fichier";
	const dot = clean.lastIndexOf(".");
	const base = dot > 0 ? clean.slice(0, dot) : clean, ext = dot > 0 ? clean.slice(dot) : "";
	let remote = `/sdcard/Download/${clean}`;
	for (let n = 1; n < 100; n++) {
		const exists = (await adb("-s", serial, "shell", "ls", remote)).trim() === remote;
		if (!exists) break;
		remote = `/sdcard/Download/${base}-${n}${ext}`;
	}
	// adb push écrit son bilan sur stderr : on juge sur le code de sortie
	const err = await new Promise(resolve => execFile(ADB, ["-s", serial, "push", localPath, remote], { timeout: 10 * 60 * 1000, windowsHide: true },
		(e, stdout, stderr) => resolve(e ? String(stderr || stdout || e.message).trim() : null)));
	if (err) throw new Error("La copie vers l'appareil a échoué : " + err.slice(0, 200));
	await adb("-s", serial, "shell", "am", "broadcast", "-a", "android.intent.action.MEDIA_SCANNER_SCAN_FILE", "-d", `file://${remote}`);
	return remote;
}

/* ---------- Parcourir / récupérer des fichiers ---------- */
// Seul le stockage partagé (/sdcard) est accessible, en lecture seule.
function safeRemote(p) {
	const clean = path.posix.normalize(String(p || "/sdcard"));
	if (!(clean === "/sdcard" || clean.startsWith("/sdcard/")) || clean.includes("\0") || /[\r\n]/.test(clean)) throw new Error("Dossier non autorisé");
	return clean;
}
const shQuote = s => "'" + s.replace(/'/g, "'\\''") + "'"; // pour le shell du téléphone

async function listDir(id, dir) {
	const serial = await serialFor(id);
	if (!serial) throw new Error("Parcourir les fichiers : Android uniquement");
	const d = safeRemote(dir);
	const out = await run(ADB, ["-s", serial, "shell", `ls -la ${shQuote(d + "/")}`], 30000);
	const entries = [];
	for (const line of out.split(/\r?\n/)) {
		const m = line.match(/^([dl-])\S*\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(\d{4}-\d\d-\d\d)\s+(\d\d:\d\d)\s+(.+)$/);
		if (!m) continue;
		let name = m[5];
		if (m[1] === "l") name = name.split(" -> ")[0];
		if (name === "." || name === ".." || name.startsWith(".")) continue;
		entries.push({ name, dir: m[1] === "d" || m[1] === "l", size: +m[2], date: `${m[3]} ${m[4]}` });
	}
	return { dir: d, entries };
}

// Copie un fichier du téléphone dans un dossier temporaire du PC ; renvoie le chemin local
async function pullFile(id, remote, localDir) {
	const serial = await serialFor(id);
	if (!serial) throw new Error("Android uniquement");
	const r = safeRemote(remote);
	// un dossier (voire tout le stockage) remplirait le disque du PC : fichiers seulement
	const kind = (await run(ADB, ["-s", serial, "shell", `stat -c %F ${shQuote(r)}`], 15000)).trim();
	if (!/regular/.test(kind)) throw new Error("Seuls les fichiers peuvent être copiés, pas les dossiers.");
	const local = path.join(localDir, path.posix.basename(r).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_") || "fichier");
	const err = await new Promise(resolve => execFile(ADB, ["-s", serial, "pull", r, local], { timeout: 10 * 60 * 1000, windowsHide: true },
		(e, stdout, stderr) => resolve(e ? String(stderr || stdout || e.message).trim() : null)));
	if (err) throw new Error("Récupération impossible : " + err.slice(0, 200));
	return local;
}

/* ---------- Touches spéciales (clavier du PC) ---------- */
const KEYCODES = {
	Backspace: 67, Delete: 112, Tab: 61, Enter: 66, Escape: 4, Space: 62,
	ArrowUp: 19, ArrowDown: 20, ArrowLeft: 21, ArrowRight: 22, Home: 122, End: 123, PageUp: 92, PageDown: 93,
};
async function pressKey(id, key, times = 1) {
	const code = KEYCODES[key];
	if (!code) throw new Error("Touche non gérée");
	const serial = await serialFor(id);
	if (!serial) throw new Error("Android uniquement");
	const n = Math.max(1, Math.min(50, times | 0));
	// plusieurs appuis en une seule commande (effacer un mot rapidement)
	await adb("-s", serial, "shell", "input", "keyevent", ...Array(n).fill(String(code)));
}

/* ---------- Wi-Fi (débogage sans fil) ---------- */
const HOSTPORT = /^\d{1,3}(\.\d{1,3}){3}:\d{2,5}$/;
const isNetwork = serial => serial.includes(":") || serial.includes("._adb-tls-connect.");

// Appareils connectés en Wi-Fi
async function wifiDevices() {
	const out = await adb("devices", "-l");
	return out.split("\n").slice(1).map(l => l.trim()).filter(Boolean).map(l => {
		const [serial, stateStr] = l.split(/\s+/);
		return { serial, state: stateStr, model: (l.match(/model:(\S+)/) || [])[1] || "" };
	}).filter(d => isNetwork(d.serial));
}

// Adresse Wi-Fi d'un appareil branché en USB
async function wifiIp(serial) {
	const out = await adb("-s", serial, "shell", "ip", "-f", "inet", "addr", "show", "wlan0");
	return (out.match(/inet (\d+\.\d+\.\d+\.\d+)/) || [])[1] || null;
}

// Méthode 1 : l'appareil est branché en USB -> on passe adb en TCP, puis on s'y connecte en Wi-Fi
async function usbToWifi(id) {
	const serial = await serialFor(id);
	if (!serial) throw new Error("Appareil Android introuvable");
	if (isNetwork(serial)) throw new Error("Cet appareil est déjà connecté en Wi-Fi");
	if (serial.startsWith("emulator-")) throw new Error("Inutile pour un émulateur");
	const ip = await wifiIp(serial);
	if (!ip) throw new Error("Le téléphone n'est pas connecté au Wi-Fi");
	await adb("-s", serial, "tcpip", "5555");
	await new Promise(ok => setTimeout(ok, 2500)); // adb redémarre sur le téléphone
	const out = await adb("connect", `${ip}:5555`);
	if (!/connected to/.test(out)) throw new Error("Connexion Wi-Fi impossible : " + out.trim());
	return `${ip}:5555`;
}

// Méthode 2 (Android 11+, sans câble) : appairage avec le code affiché par le téléphone
async function pairWifi(hostport, code) {
	if (!HOSTPORT.test(hostport)) throw new Error("Adresse attendue sous la forme 192.168.x.x:port");
	if (!/^\d{6}$/.test(code)) throw new Error("Le code d'association fait 6 chiffres");
	const out = await run(ADB, ["pair", hostport, code], 30000);
	if (!/Successfully paired/i.test(out)) throw new Error("Association refusée : " + (out.trim() || "vérifie l'adresse et le code (ils changent à chaque ouverture)"));
	// après l'association, le téléphone s'annonce sur le réseau : on cherche son port de connexion
	const ip = hostport.split(":")[0];
	for (let i = 0; i < 8; i++) {
		if ((await wifiDevices()).some(d => d.serial.startsWith(ip + ":") && d.state === "device")) return { paired: true, connected: true };
		const m = (await adb("mdns", "services")).split("\n").find(l => l.includes("_adb-tls-connect") && l.includes(ip + ":"));
		const target = m && (m.match(/(\d+\.\d+\.\d+\.\d+:\d+)/) || [])[1];
		if (target && /connected to/.test(await adb("connect", target))) return { paired: true, connected: true, target };
		await new Promise(ok => setTimeout(ok, 1500));
	}
	return { paired: true, connected: false };
}

async function connectWifi(hostport) {
	if (!HOSTPORT.test(hostport)) throw new Error("Adresse attendue sous la forme 192.168.x.x:port");
	const out = await adb("connect", hostport);
	if (!/connected to/.test(out)) throw new Error("Connexion impossible : " + (out.trim() || "le téléphone est-il sur le même Wi-Fi ?"));
	return hostport;
}

async function disconnectWifi(serial) {
	if (!isNetwork(serial)) throw new Error("Ce n'est pas une connexion Wi-Fi");
	// mode « adb tcpip 5555 » (passage USB → Wi-Fi) : on remet le téléphone en mode USB,
	// sinon son port de débogage reste ouvert sur le réseau jusqu'au redémarrage
	if (/:5555$/.test(serial)) await adb("-s", serial, "usb");
	await adb("disconnect", serial);
}

module.exports = { SDK, AVD_HOME, avdInfo, diagnoseEmuLog, readEmuLog, explainEmuLog, emuLogPath, accelCheck, bootCompleted, killEmulator, emulatorProcessAlive, listDir, pullFile, pressKey, KEYS: Object.keys(KEYCODES), pushFile, wifiDevices, usbToWifi, pairWifi, connectWifi, disconnectWifi, adbDevices, serialFor, listEmulators, startEmulator, stopEmulator, waitBoot, streamScreen, hasFfmpeg: !!FFMPEG };
