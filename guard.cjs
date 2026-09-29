// Garde-fous : repère les actions sensibles d'un agent (envoyer, payer, supprimer…)
// pour qu'elles soient confirmées par l'utilisateur avant d'être exécutées.

const SENSITIVE = /\b(envoyer|envoi|send|payer|paiement|pay|acheter|achat|buy|purchase|commander|order|checkout|supprimer|suppression|delete|remove|effacer|erase|vider|publier|publish|post|poster|partager|share|confirmer|confirm|valider|transf[ée]rer|transfer|virement|appeler|call|d[ée]sinstaller|uninstall|r[ée]initialiser|reset|formater|format|souscrire|subscribe|abonner|s'abonner|accepter|accept|autoriser|allow|signer|sign)\b/i;

const CLICKS = new Set(["mobile_click_on_screen_at_coordinates", "mobile_double_tap_on_screen", "mobile_long_press_on_screen_at_coordinates"]);

const label = el => el ? (el.text || el.label || el.name || el.value || "").trim() : "";

// Élément visé : par ref, sinon le plus petit élément avec du texte qui contient le point
function targetElement(args, elements) {
	if (args.ref) return elements.find(e => e.ref === args.ref) || null;
	if (typeof args.x !== "number" || typeof args.y !== "number") return null;
	const hits = elements.filter(e => {
		const c = e.coordinates;
		return c && label(e) && args.x >= c.x && args.x <= c.x + c.width && args.y >= c.y && args.y <= c.y + c.height;
	});
	hits.sort((a, b) => a.coordinates.width * a.coordinates.height - b.coordinates.width * b.coordinates.height);
	return hits[0] || null;
}

// Faut-il lire l'écran avant cet appel ? (évite une lecture inutile pour les autres outils)
const needsScreen = name => CLICKS.has(name);

// Renvoie une description lisible si l'action doit être confirmée, sinon null
function sensitiveAction(name, args, elements = []) {
	if (CLICKS.has(name)) {
		const el = targetElement(args, elements);
		const t = label(el);
		if (t && SENSITIVE.test(t)) return `Toucher « ${t.slice(0, 80)} »`;
		return null;
	}
	if (name === "mobile_type_keys" && args.submit) return `Taper « ${String(args.text || "").slice(0, 80)} » puis valider (Entrée)`;
	if (name === "mobile_press_button" && String(args.button).toUpperCase() === "ENTER") return "Appuyer sur Entrée (valider)";
	if (name === "mobile_batch_commands") return "Enchaîner plusieurs actions d'un coup";
	if (name === "mobile_uninstall_app") return `Désinstaller ${args.bundle_id}`;
	if (name === "mobile_install_app") return `Installer ${args.path}`;
	return null;
}

function parseElements(text) {
	const i = (text || "").indexOf("[");
	try { return i >= 0 ? JSON.parse(text.slice(i)) : []; } catch { return []; }
}

module.exports = { sensitiveAction, needsScreen, parseElements };
