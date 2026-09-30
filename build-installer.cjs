// Fabrique Installer-Prigojine.exe : version portable à jour, intégrée dans l'installateur.
// Usage : node build-installer.cjs   (ou npm run installer)
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = __dirname;
const ZIP = path.resolve(ROOT, "..", "Prigojine-portable.zip");
const OUT = path.resolve(ROOT, "..", "Installer-Prigojine.exe");
const VERSION = require("./package.json").version;

console.log("• version portable…");
execFileSync(process.execPath, [path.join(ROOT, "build-portable.cjs")], { stdio: "inherit" });
if (!fs.existsSync(ZIP)) throw new Error("Prigojine-portable.zip introuvable");

console.log(`• compilation de l'installateur (version ${VERSION})…`);
// le numéro de version vient de package.json (une seule source de vérité)
const src = fs.readFileSync(path.join(ROOT, "installer", "Installer.cs"), "utf8").replace(/const string Version = "[^"]*";/, `const string Version = "${VERSION}";`);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "prigojine-installer-"));
const srcFile = path.join(tmp, "Installer.cs");
fs.writeFileSync(srcFile, src);
const csc = path.join(process.env.WINDIR || "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
fs.rmSync(OUT, { force: true });
try {
	execFileSync(csc, ["-nologo", "-target:winexe", "-optimize", `-out:${OUT}`,
		`-win32icon:${path.join(ROOT, "prigojine.ico")}`,
		`-resource:${ZIP},Prigojine-portable.zip`,
		"-r:System.Windows.Forms.dll", "-r:System.Drawing.dll", "-r:System.Xml.dll", "-r:System.Core.dll", "-r:Microsoft.CSharp.dll",
		"-r:System.IO.Compression.dll", "-r:System.IO.Compression.FileSystem.dll",
		srcFile], { stdio: "inherit" });
} finally {
	fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`\nInstallateur prêt : ${OUT} (${(fs.statSync(OUT).size / 1048576).toFixed(0)} Mo)`);
