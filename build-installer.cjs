// Fabrique Installer-Prigojine.exe : version portable à jour, intégrée dans l'installateur.
// Usage : node build-installer.cjs   (ou npm run installer)
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = __dirname;
const ZIP = path.resolve(ROOT, "..", "Prigojine-portable.zip");
const OUT = path.resolve(ROOT, "..", "Installer-Prigojine.exe");

console.log("• version portable…");
execFileSync(process.execPath, [path.join(ROOT, "build-portable.cjs")], { stdio: "inherit" });
if (!fs.existsSync(ZIP)) throw new Error("Prigojine-portable.zip introuvable");

console.log("• compilation de l'installateur…");
const csc = path.join(process.env.WINDIR || "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
fs.rmSync(OUT, { force: true });
execFileSync(csc, ["-nologo", "-target:winexe", "-optimize", `-out:${OUT}`,
	`-win32icon:${path.join(ROOT, "prigojine.ico")}`,
	`-resource:${ZIP},Prigojine-portable.zip`,
	"-r:System.Windows.Forms.dll", "-r:System.Drawing.dll", "-r:System.Xml.dll", "-r:System.Core.dll", "-r:Microsoft.CSharp.dll",
	"-r:System.IO.Compression.dll", "-r:System.IO.Compression.FileSystem.dll",
	path.join(ROOT, "installer", "Installer.cs")], { stdio: "inherit" });
console.log(`\nInstallateur prêt : ${OUT} (${(fs.statSync(OUT).size / 1048576).toFixed(0)} Mo)`);
