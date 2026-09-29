// Emplacement du moteur de pilotage des appareils (dépendance npm, voir package.json).
const path = require("path");

const ENGINE_DIR = path.dirname(require.resolve("@mobilenext/mobile-mcp/package.json"));

module.exports = {
	ROOT: __dirname,                                    // dossier de Prigojine
	ENGINE_ENTRY: path.join(ENGINE_DIR, "lib", "index.js"),  // serveur en processus séparé (stdio)
	ENGINE_SERVER: path.join(ENGINE_DIR, "lib", "server.js"), // serveur intégré (in-process)
};
