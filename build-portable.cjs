// Regénère la version portable de Prigojine (dossier + zip) à partir de la version actuelle.
// Usage : node build-portable.cjs   (ou double-clic sur Construire-portable.bat)
// Les données de l'utilisateur du dossier portable (journal, captures, macros, réglages) sont conservées
// et ne sont jamais mises dans le zip.
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

const ROOT = __dirname;                                            // projet Prigojine
const OUT = path.resolve(ROOT, "..", "Prigojine-portable");        // dossier portable
const ZIP = OUT + ".zip";
const USER_DATA = ["prigojine.log", "app/captures", "app/macros.json", "app/settings.json"];
const APP_FILES = ["server.cjs", "agent.cjs", "android.cjs", "engine.cjs", "guard.cjs", "guard-mcp.cjs", "watch.cjs", "prigojine.ico", "package.json", "LICENSE"];
const step = t => console.log("• " + t);

// 1. Le portable ne doit pas tourner (fichiers verrouillés sous Windows)
try {
	const out = execFileSync("powershell.exe", ["-NoProfile", "-Command",
		`Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like '${OUT.replace(/'/g, "''")}\\*' } | Select-Object -ExpandProperty Name`], { encoding: "utf8" }).trim();
	if (out) { console.error(`Arrête d'abord la version portable (icône près de l'horloge → Quitter). En cours : ${out.split(/\r?\n/).join(", ")}`); process.exit(1); }
} catch { /* vérification impossible : on continue */ }

// 2. Mise de côté des données de l'utilisateur (remises en place quoi qu'il arrive)
const keep = fs.mkdtempSync(path.join(os.tmpdir(), "prigojine-keep-"));
for (const rel of USER_DATA) {
	const src = path.join(OUT, rel);
	if (fs.existsSync(src)) fs.cpSync(src, path.join(keep, rel), { recursive: true });
}
step("données utilisateur mises de côté");

let ok = false;
try {
	// 3. Dossier neuf
	fs.rmSync(OUT, { recursive: true, force: true });
	fs.mkdirSync(path.join(OUT, "app", "captures"), { recursive: true });
	fs.mkdirSync(path.join(OUT, "runtime"), { recursive: true });
	fs.mkdirSync(path.join(OUT, "android", "platform-tools"), { recursive: true });
	for (const f of APP_FILES) fs.copyFileSync(path.join(ROOT, f), path.join(OUT, "app", f));
	fs.cpSync(path.join(ROOT, "public"), path.join(OUT, "app", "public"), { recursive: true });
	fs.copyFileSync(path.join(ROOT, "portable", "LISEZ-MOI.txt"), path.join(OUT, "LISEZ-MOI.txt"));
	step("application copiée");

	// 4. Modules (copie des dépendances déjà installées, sans téléchargement)
	if (!fs.existsSync(path.join(ROOT, "node_modules"))) throw new Error("Lance d'abord « npm install » dans le dossier de Prigojine.");
	step("copie des modules…");
	fs.cpSync(path.join(ROOT, "node_modules"), path.join(OUT, "app", "node_modules"), { recursive: true });
	execFileSync(process.execPath, ["-e", "require('./engine.cjs');require('@modelcontextprotocol/client');require('@modelcontextprotocol/client/stdio');require('@modelcontextprotocol/server/stdio');require('express');for (const f of ['guard','android','agent','watch']) require('./'+f+'.cjs')"], { cwd: path.join(OUT, "app") });
	step("modules vérifiés");

	// 5. Node.js et adb embarqués
	fs.copyFileSync(process.execPath, path.join(OUT, "runtime", "node.exe"));
	const pt = path.join(process.env.ANDROID_HOME || path.join(process.env.LOCALAPPDATA || "", "Android", "Sdk"), "platform-tools");
	for (const f of ["adb.exe", "AdbWinApi.dll", "AdbWinUsbApi.dll", "libwinpthread-1.dll", "NOTICE.txt"]) {
		if (fs.existsSync(path.join(pt, f))) fs.copyFileSync(path.join(pt, f), path.join(OUT, "android", "platform-tools", f));
	}
	step("Node.js et adb ajoutés");

	// 6. Lanceur Prigojine.exe (compilateur C# fourni avec Windows)
	const csc = path.join(process.env.WINDIR || "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
	execFileSync(csc, ["-nologo", "-target:winexe", "-optimize", `-out:${path.join(OUT, "Prigojine.exe")}`,
		`-win32icon:${path.join(ROOT, "prigojine.ico")}`, "-r:System.Windows.Forms.dll", "-r:System.Drawing.dll", "-r:System.Web.Extensions.dll",
		path.join(ROOT, "launcher", "Prigojine.cs")], { stdio: "inherit" });
	step("Prigojine.exe compilé");

	// 7. Zip à partager (sans données utilisateur)
	fs.rmSync(ZIP, { force: true });
	const stage = fs.mkdtempSync(path.join(os.tmpdir(), "prigojine-zip-"));
	try {
		fs.cpSync(OUT, path.join(stage, "Prigojine"), { recursive: true });
		execFileSync("powershell.exe", ["-NoProfile", "-Command",
			`Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory('${stage.replace(/'/g, "''")}', '${ZIP.replace(/'/g, "''")}', [System.IO.Compression.CompressionLevel]::Optimal, $false)`]);
	} finally {
		fs.rmSync(stage, { recursive: true, force: true });
	}
	step(`zip créé : ${ZIP} (${(fs.statSync(ZIP).size / 1048576).toFixed(0)} Mo)`);
	ok = true;
} finally {
	// 8. Retour des données de l'utilisateur, même si une étape a échoué
	for (const rel of USER_DATA) {
		const src = path.join(keep, rel);
		if (fs.existsSync(src)) fs.cpSync(src, path.join(OUT, rel), { recursive: true });
	}
	fs.rmSync(keep, { recursive: true, force: true });
	step("données utilisateur remises en place");
}
if (ok) console.log(`\nVersion portable prête : ${OUT}`);
