// Téléchargement robuste : reprise après coupure réseau (en-tête Range), vérification de la
// somme de contrôle sur le fichier complet.
const fs = require("fs");
const crypto = require("crypto");

// progress(done, total) ; algo = "sha1" | "sha256" ; expected = empreinte hexadécimale (ou null)
async function download(url, file, { size = 0, algo = null, expected = null, progress = () => {}, headers = {}, tries = 8 } = {}) {
	let done = 0, total = size;
	fs.writeFileSync(file, "");
	for (let attempt = 1; ; attempt++) {
		try {
			const h = { "User-Agent": "Prigojine", ...headers };
			if (done > 0) h.Range = `bytes=${done}-`;
			const res = await fetch(url, { headers: h, signal: AbortSignal.timeout(30 * 60000) });
			if (done > 0 && res.status !== 206) { done = 0; fs.writeFileSync(file, ""); } // le serveur ne sait pas reprendre
			else if (!res.ok) throw Object.assign(new Error("Téléchargement refusé (" + res.status + ")"), { fatal: res.status === 404 || res.status === 403 });
			if (!total) total = +(res.headers.get("content-length") || 0) + done;
			const out = fs.createWriteStream(file, { flags: "a" });
			try {
				for await (const chunk of res.body) {
					done += chunk.length;
					if (!out.write(chunk)) await new Promise(ok => out.once("drain", ok));
					progress(done, total);
				}
			} finally {
				await new Promise(ok => out.end(ok));
			}
			if (total && done < total) throw new Error("connexion interrompue");
			break;
		} catch (e) {
			if (e.fatal || attempt >= tries) throw new Error(`Téléchargement impossible après ${attempt} essai(s) : ${e.message}`);
			await new Promise(ok => setTimeout(ok, Math.min(30000, 2000 * attempt))); // puis reprise là où on en était
		}
	}
	if (algo && expected) {
		const hash = crypto.createHash(algo);
		await new Promise((ok, ko) => fs.createReadStream(file).on("data", d => hash.update(d)).on("end", ok).on("error", ko));
		if (hash.digest("hex") !== String(expected).toLowerCase().replace(/^sha\d+:/, "")) throw new Error("Fichier corrompu (somme de contrôle incorrecte) : réessaie.");
	}
	return done;
}

module.exports = { download };
