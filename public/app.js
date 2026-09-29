// Prigojine — logique de l'interface (plusieurs appareils en simultané)
const $ = s => document.querySelector(s);
{
	const nativeFetch = window.fetch.bind(window);
	let warned = false;
	window.fetch = async (...a) => {
		const r = await nativeFetch(...a);
		if (r.status === 401 && !warned) {
			warned = true;
			const box = document.createElement("div");
			box.className = "auth-lock";
			box.textContent = "Accès protégé : ouvre Prigojine avec Prigojine.exe ou Lancer-Prigojine.bat (la page reçoit alors sa clé d’accès).";
			document.body.append(box);
		}
		return r;
	};
}
const $$ = s => [...document.querySelectorAll(s)];

// Création d'éléments DOM sans HTML brut : h("div", {class: "x"}, "texte", enfant…)
function h(tag, attrs = {}, ...kids) {
	const svg = tag === "svg" || tag === "line";
	const el = svg ? document.createElementNS("http://www.w3.org/2000/svg", tag) : document.createElement(tag);
	for (const [k, v] of Object.entries(attrs || {})) {
		if (v == null || v === false) continue;
		if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
		else if (k === "style") el.style.cssText = v;
		else if (k === "dataset") Object.assign(el.dataset, v);
		else el.setAttribute(k, v === true ? "" : v);
	}
	for (const c of kids.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
	return el;
}
const fill = (sel, ...kids) => { const el = typeof sel === "string" ? $(sel) : sel; el.replaceChildren(...kids.flat()); return el; };
const sleep = ms => new Promise(ok => setTimeout(ok, ms));

const state = {
	devs: new Map(),   // id -> appareil (voir addDevice)
	focus: null,       // appareil actif (cible des panneaux)
	syncAll: false,
	live: true,
	busy: 0,
	journal: 0,
};
const D = id => state.devs.get(id);
const F = () => D(state.focus);
const shortName = id => (D(id)?.info.name || id || "").replace(/\s*API\s*[\d.]+/, "");

/* ---------------- Appels ---------------- */
// Actions répétées sur les appareils synchronisés (coordonnées mises à l'échelle)
const BROADCAST = new Set([
	"mobile_click_on_screen_at_coordinates", "mobile_double_tap_on_screen", "mobile_long_press_on_screen_at_coordinates",
	"mobile_swipe_on_screen", "mobile_press_button", "mobile_type_keys", "mobile_open_url", "mobile_launch_app",
	"mobile_terminate_app", "mobile_set_orientation", "mobile_set_location",
]);
const isSync = d => state.syncAll || d.sync;
function syncTargets(id) {
	const src = D(id);
	if (!src || !isSync(src)) return [];
	return [...state.devs.values()].filter(d => d.id !== id && isSync(d));
}
function scaleArgs(args, from, to) {
	const a = { ...args };
	const fw = from.screen.w || 1, fh = from.screen.h || 1, tw = to.screen.w || fw, th = to.screen.h || fh;
	if (a.ref) { if (!a._coords) return null; a.x = a._coords.x; a.y = a._coords.y; delete a.ref; }
	delete a._coords;
	if (typeof a.x === "number") a.x = Math.round(a.x * tw / fw);
	if (typeof a.y === "number") a.y = Math.round(a.y * th / fh);
	if (typeof a.distance === "number") a.distance = Math.round(a.distance * (["left", "right"].includes(a.direction) ? tw / fw : th / fh));
	return a;
}
async function rawCall(name, args) {
	try {
		const res = await fetch("/api/call", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, args }) });
		return await res.json();
	} catch (e) {
		return { isError: true, text: "Serveur injoignable : " + e.message };
	}
}
async function tool(name, args = {}, { quiet = false, device, withDevice = true, noSync = false, noRecord = false } = {}) {
	const id = device || state.focus;
	const t0 = performance.now();
	const primaryArgs = { ...args }; delete primaryArgs._coords;
	if (state.rec && !noRecord && withDevice && id === state.rec.device && BROADCAST.has(name)) recordStep(name, args);
	setBusy(+1);
	const others = withDevice && !noSync && BROADCAST.has(name) ? syncTargets(id) : [];
	const jobs = others.map(d => {
		const a = scaleArgs(args, D(id), d);
		return a ? rawCall(name, { device: d.id, ...a }).then(r => { journal(name, a, r, 0, d.id); if (!r.isError) afterAction(d.id); return r; }) : null;
	}).filter(Boolean);
	const r = await rawCall(name, withDevice ? { device: id, ...primaryArgs } : primaryArgs);
	setBusy(-1);
	journal(name, primaryArgs, r, performance.now() - t0, withDevice ? id : null);
	if (r.isError && !quiet) toast(r.text, true);
	if (jobs.length) Promise.all(jobs).then(rs => { const bad = rs.filter(x => x.isError).length; if (bad) toast(`Synchro : ${bad}/${rs.length} appareil(s) en échec`, true); });
	return r;
}
async function post(url, body) {
	setBusy(+1);
	try {
		const r = await (await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json();
		journal(url.replace("/api/", ""), body, r, 0, body.device);
		return r;
	} finally { setBusy(-1); }
}

function setBusy(d) {
	state.busy = Math.max(0, state.busy + d);
	$("#led").className = "led " + (state.busy > 0 ? "busy" : state.devs.size ? "ok" : "err");
}
function setStatus(text, kind) {
	$("#statusText").textContent = text;
	$("#led").className = "led " + kind;
}
function toast(msg, err = false) {
	const el = h("div", { class: "toast" + (err ? " err" : "") }, msg.length > 300 ? msg.slice(0, 300) + "…" : msg);
	$("#toasts").append(el);
	setTimeout(() => { el.classList.add("out"); setTimeout(() => el.remove(), 300); }, err ? 6000 : 2600);
}
function journal(name, args, r, ms, id) {
	const a = { ...args }; delete a.device; delete a._coords;
	const argStr = Object.keys(a).length ? JSON.stringify(a) : "";
	const li = h("li", { class: r.isError ? "err" : null },
		h("div", { class: "h" },
			h("span", {}, new Date().toLocaleTimeString()),
			id ? h("span", { class: "dev" }, shortName(id)) : null,
			h("b", {}, name.replace(/^mobile_/, "")),
			h("span", {}, argStr.slice(0, 70)),
			h("span", { class: "ms" }, ms ? Math.round(ms) + " ms" : "")),
		r.text ? h("div", { class: "r" }, r.text.slice(0, 500)) : null);
	$("#journal").prepend(li);
	while ($("#journal").children.length > 400) $("#journal").lastChild.remove();
	$("#jCount").textContent = ++state.journal;
}
const emptyItem = text => h("li", { class: "dim" }, text);

/* ---------------- Appareils ---------------- */
async function loadDevices(silent = false) {
	if (!silent) setStatus("recherche…", "busy");
	const r = silent ? await rawCall("mobile_list_available_devices", {}) : await tool("mobile_list_available_devices", {}, { withDevice: false });
	if (silent && r.isError) return;
	let list = [];
	try { list = JSON.parse(r.text).devices || []; } catch { /* texte inattendu */ }
	list = list.filter(d => !d.state || d.state === "online");
	const ids = new Set(list.map(d => d.id));
	for (const id of [...state.devs.keys()]) if (!ids.has(id)) removeDevice(id);
	for (const info of list) {
		if (state.devs.has(info.id)) D(info.id).info = info;
		else addDevice(info);
	}
	fill("#device", list.length ? list.map(d => h("option", { value: d.id }, `${d.name} · ${d.platform} ${d.version || ""}`)) : h("option", { value: "" }, "Aucun appareil"));
	$("#tiles > .empty").hidden = list.length > 0;
	setStatus(list.length ? `${list.length} appareil${list.length > 1 ? "s" : ""}` : "aucun appareil", list.length ? "ok" : "err");
	if (!state.focus || !state.devs.has(state.focus)) setFocus(pref("focus") && state.devs.has(pref("focus")) ? pref("focus") : list[0]?.id || null);
	else $("#device").value = state.focus;
	layoutTiles();
	markRunningAgents();
}

function addDevice(info) {
	const d = { id: info.id, info, screen: { w: 0, h: 0 }, aspect: 0, elements: [], sync: pref("sync." + info.id) === "1", agent: false };
	const line = h("line", { x1: 0, y1: 0, x2: 0, y2: 0 });
	d.img = h("img", { class: "shot", alt: "Écran de " + info.name, draggable: "false" });
	d.overlay = h("div", { class: "overlay" });
	d.ripples = h("div", { class: "ripple-layer" });
	d.trail = h("svg", { class: "trail" }, line); d.line = line;
	d.screenEl = h("div", { class: "screen" }, d.img, d.overlay, d.ripples, d.trail, h("div", { class: "empty mono" }, "connexion…"));
	d.ms = h("span", { class: "tile-ms" }, "");
	d.kind = h("span", { class: "tile-kind" }, { emulator: "émulateur", simulator: "simulateur", real: "réel" }[info.type] || info.type || "");
	const syncBox = h("input", { type: "checkbox", onchange: e => { d.sync = e.target.checked; pref("sync." + d.id, d.sync ? "1" : "0"); paintTile(d); updateAgentTargets(); } });
	syncBox.checked = d.sync; d.syncBox = syncBox;
	d.tile = h("div", { class: "tile", dataset: { id: d.id } },
		h("div", { class: "tile-head" },
			h("button", { class: "tile-name", title: "Rendre actif", onclick: () => setFocus(d.id) }, info.name),
			d.kind,
			h("span", { class: "tile-agent" }, "✦ agent"),
			h("span", { class: "tile-kbd", title: "Ton clavier tape sur cet appareil. Clique ailleurs pour arrêter." }, "⌨ clavier"),
			h("label", { class: "tile-sync", title: "Répéter les actions sur cet appareil" }, syncBox, "synchro"),
			d.ms),
		h("div", { class: "bezel" }, d.screenEl));
	d.tile.addEventListener("pointerdown", () => { if (state.focus !== d.id) setFocus(d.id); }, true);
	d.feed = h("ol", { class: "feed" }, h("li", { class: "feed-empty" }, `Aucune tâche lancée sur ${info.name}.`));
	$("#agentFeeds").append(d.feed);
	$("#tiles").append(d.tile);
	state.devs.set(d.id, d);
	bindGestures(d);
	bindDrop(d);
	bindKeyboard(d);
	paintTile(d);
	tool("mobile_get_screen_size", {}, { device: d.id, quiet: true }).then(r => {
		const m = (r.text || "").match(/(\d+)x(\d+)/);
		if (m) { d.screen = { w: +m[1], h: +m[2] }; if (!d.aspect) d.aspect = d.screen.w / d.screen.h; paintTile(d); layoutTiles(); }
	});
	refreshScreen(d.id, true);
}
function removeDevice(id) {
	const d = D(id); if (!d) return;
	clearTimeout(d.timer);
	d.streaming = false; d.img.removeAttribute("src");
	d.tile.remove(); d.feed.remove();
	state.devs.delete(id);
	if (state.focus === id) state.focus = null;
}
function paintTile(d) {
	d.tile.classList.toggle("focus", d.id === state.focus);
	d.tile.classList.toggle("sync", isSync(d));
	d.tile.classList.toggle("agent-on", d.agent);
	const ratio = d.screen.w && d.screen.h ? Math.min(d.screen.w, d.screen.h) / Math.max(d.screen.w, d.screen.h) : 0;
	const tablet = ratio > 0.6;
	d.tile.classList.toggle("tablet", tablet);
	if (d.info.type === "real") d.kind.textContent = tablet ? "tablette" : "téléphone";
	d.tile.hidden = $("#view").value === "focus" && d.id !== state.focus;
	if (state.streamOk) applyVideo(d);
}

function setFocus(id) {
	state.focus = id;
	if (id) pref("focus", id);
	$("#device").value = id || "";
	for (const d of state.devs.values()) { paintTile(d); d.feed.classList.toggle("on", d.id === id); }
	fill("#elList"); apps = []; renderApps();
	updateAgentButtons(); updateAgentTargets();
	layoutTiles();
	if (!id) return;
	const d = F();
	$("#tModel").textContent = d.info.model || d.info.name || "—";
	$("#tOs").textContent = `${d.info.platform || "?"} ${d.info.version || ""}`;
	$("#tType").textContent = d.kind.textContent || "—";
	refreshTelemetry();
	if ($("#tabs button.on")?.dataset.tab === "elements" || $("#overlay").checked) loadElements();
	$("#recStart").disabled = !!d.recUrl; $("#recStart").classList.toggle("on", !!d.recUrl);
}

async function refreshTelemetry(id = state.focus) {
	const d = D(id); if (!d) return;
	const [size, orient, fg] = await Promise.all([
		tool("mobile_get_screen_size", {}, { quiet: true, device: id }),
		tool("mobile_get_orientation", {}, { quiet: true, device: id }),
		tool("mobile_get_foreground_app", {}, { quiet: true, device: id }),
	]);
	const m = (size.text || "").match(/(\d+)x(\d+)/);
	if (m) d.screen = { w: +m[1], h: +m[2] };
	if (d.img.naturalWidth) fitScreen(d);
	if (id !== state.focus) return;
	$("#tSize").textContent = m ? `${m[1]} × ${m[2]}` : "—";
	const o = (orient.text || "").match(/(portrait|landscape)/);
	$("#tOrient").textContent = o ? (o[1] === "portrait" ? "portrait" : "paysage") : "—";
	$("#tFg").textContent = fg.isError ? "inconnue (verrouillé ?)" : (fg.text || "").replace(/^Foreground app:\s*/, "") || "—";
	$("#tFg").title = $("#tFg").textContent;
}

/* ---------------- Disposition des écrans ---------------- */
// Choisit le nombre de lignes qui donne les plus grands écrans possibles
function layoutTiles() {
	const box = $("#tiles").getBoundingClientRect();
	const tiles = [...state.devs.values()].filter(d => !d.tile.hidden);
	if (!tiles.length || !box.width) return;
	const GAP = 18, HEAD = 30, PAD = 20;
	const aspects = tiles.map(d => d.aspect || 9 / 20);
	let best = null;
	for (let rows = 1; rows <= tiles.length; rows++) {
		const cols = Math.ceil(tiles.length / rows);
		const cellW = (box.width - GAP * (cols - 1)) / cols - PAD;
		const cellH = (box.height - GAP * (rows - 1)) / rows - HEAD - PAD;
		if (cellW < 60 || cellH < 60) continue;
		const sizes = aspects.map(a => { const hgt = Math.min(cellH, cellW / a); return { w: hgt * a, h: hgt }; });
		const area = sizes.reduce((s, x) => s + x.w * x.h, 0);
		if (!best || area > best.area) best = { area, sizes };
	}
	if (!best) return;
	// la largeur de la tuile suit celle de l'écran : l'en-tête (badges) ne peut plus la pousser à la ligne
	tiles.forEach((d, i) => {
		d.screenEl.style.width = best.sizes[i].w + "px"; d.screenEl.style.height = best.sizes[i].h + "px";
		d.tile.style.width = (best.sizes[i].w + PAD) + "px";
	});
	for (const d of state.devs.values()) if (d.id === state.focus || $("#overlay").checked) renderOverlay(d);
}
new ResizeObserver(() => layoutTiles()).observe($("#tiles"));

/* ---------------- Écrans en direct ---------------- */
/* Mode vidéo (Android) : flux JPEG continu dans la balise <img>, sans captures répétées */
const videoMode = () => $("#rate").value === "video" && state.streamOk;
const canStream = d => d.info.platform === "android";
function applyVideo(d) {
	const want = videoMode() && canStream(d) && state.live && !d.tile.hidden && !document.hidden;
	if (want && !d.streaming) {
		clearTimeout(d.timer);
		d.streaming = true;
		// Android n'envoie une image vidéo qu'au premier changement d'écran : une capture sert d'affiche en attendant
		fetch(`/api/screen?device=${encodeURIComponent(d.id)}&max=900`).then(r => r.ok ? r.blob() : null).then(b => {
			if (!b || !d.streaming) return;
			if (d.posterUrl) URL.revokeObjectURL(d.posterUrl);
			d.posterUrl = URL.createObjectURL(b);
			d.screenEl.style.backgroundImage = `url(${d.posterUrl})`;
			d.screenEl.classList.add("has-img");
		}).catch(() => {});
		d.img.onload = () => { d.img.classList.add("ready"); d.screenEl.classList.add("has-img"); fitScreen(d); d.ms.textContent = "vidéo"; };
		d.img.onerror = () => { d.streaming = false; d.ms.textContent = "vidéo ✕"; setTimeout(() => refreshScreen(d.id, true), 1500); };
		d.img.src = `/api/stream?device=${encodeURIComponent(d.id)}&w=${state.devs.size > 2 ? 432 : 540}&t=${Date.now()}`;
	} else if (!want && d.streaming) {
		d.streaming = false;
		d.img.onerror = null;
		d.screenEl.style.backgroundImage = "";
		d.img.removeAttribute("src"); // ferme la connexion du flux
		refreshScreen(d.id, true);
	}
}
const applyVideoAll = () => { for (const d of state.devs.values()) applyVideo(d); };

async function refreshScreen(id, force = false) {
	const d = D(id); if (!d) return;
	clearTimeout(d.timer);
	if (d.streaming) return; // le flux vidéo se met à jour tout seul
	if (videoMode() && canStream(d) && state.live && !d.tile.hidden) return applyVideo(d);
	if (d.inFlight) { if (force) d.timer = setTimeout(() => refreshScreen(id, true), 150); return; }
	if (!force && (!state.live || document.hidden || d.tile.hidden)) return schedule(d);
	d.inFlight = true;
	const t0 = performance.now();
	try {
		const res = await fetch(`/api/screen?device=${encodeURIComponent(id)}&max=${state.devs.size > 2 ? 700 : 1000}&t=${Date.now()}`);
		if (!res.ok) throw new Error(await res.text());
		const url = URL.createObjectURL(await res.blob());
		await new Promise(ok => { d.img.onload = ok; d.img.onerror = ok; d.img.src = url; });
		if (d.prevUrl) URL.revokeObjectURL(d.prevUrl);
		d.prevUrl = url;
		d.img.classList.add("ready");
		d.screenEl.classList.add("has-img");
		fitScreen(d);
		d.ms.textContent = `${Math.round(performance.now() - t0)} ms`;
	} catch (e) {
		d.ms.textContent = "hors ligne";
		d.screenEl.querySelector(".empty").textContent = "écran indisponible (verrouillé ?)";
		d.screenEl.classList.remove("has-img");
	} finally {
		d.inFlight = false;
		if (state.devs.has(id)) schedule(d);
	}
}
function schedule(d) {
	clearTimeout(d.timer);
	if (d.streaming) return;
	const rate = $("#rate").value === "video" ? 900 : +$("#rate").value; // appareils sans vidéo (iOS)
	if (state.live) d.timer = setTimeout(() => refreshScreen(d.id), rate);
}
function fitScreen(d) {
	const w = d.img.naturalWidth, hh = d.img.naturalHeight;
	if (!w || !hh) return;
	const landscape = w > hh;
	// l'écran réel peut être annoncé en portrait alors que l'image est en paysage
	if (d.screen.w && (d.screen.w > d.screen.h) !== landscape) d.screen = { w: d.screen.h, h: d.screen.w };
	if (!d.screen.w) d.screen = { w, h: hh };
	const a = w / hh;
	if (Math.abs(a - d.aspect) > 0.01) { d.aspect = a; paintTile(d); layoutTiles(); }
}
function afterAction(id = state.focus, delay = 350) {
	const d = D(id); if (!d) return;
	d.elements = []; renderOverlay(d);
	setTimeout(() => refreshScreen(id, true), delay);
	if (id === state.focus && $("#overlay").checked) setTimeout(loadElements, delay + 250);
}
const afterActionAll = (delay) => { afterAction(state.focus, delay); for (const d of syncTargets(state.focus)) afterAction(d.id, delay); };

/* conversion écran affiché -> pixels de l'appareil */
function toDevice(d, clientX, clientY) {
	const r = d.screenEl.getBoundingClientRect();
	const x = Math.round(Math.min(Math.max((clientX - r.left) / r.width, 0), 1) * d.screen.w);
	const y = Math.round(Math.min(Math.max((clientY - r.top) / r.height, 0), 1) * d.screen.h);
	return { x, y, px: clientX - r.left, py: clientY - r.top };
}
function ripple(d, px, py, long = false) {
	const el = h("div", { class: "ripple" + (long ? " long" : ""), style: `left:${px}px;top:${py}px` });
	d.ripples.append(el);
	setTimeout(() => el.remove(), 1000);
}
// montre l'action répétée sur les écrans synchronisés
function mirrorRipple(d, x, y, long) {
	for (const o of syncTargets(d.id)) {
		const r = o.screenEl.getBoundingClientRect();
		ripple(o, x / d.screen.w * r.width, y / d.screen.h * r.height, long);
	}
}

/* gestes à la souris, pour chaque écran */
function bindGestures(d) {
	const scr = d.screenEl;
	let down = null, tapTimer = null, lastTap = 0;
	scr.addEventListener("pointermove", e => {
		const p = toDevice(d, e.clientX, e.clientY);
		$("#coords").textContent = `${shortName(d.id)} · x ${p.x} · y ${p.y}`;
		if (down) {
			d.line.setAttribute("x2", p.px); d.line.setAttribute("y2", p.py);
			if (Math.hypot(p.px - down.px, p.py - down.py) > 12) d.trail.classList.add("on");
		}
	});
	scr.addEventListener("pointerdown", e => {
		if (e.button !== 0 || e.target.classList.contains("ebox")) return;
		if (e.altKey) { const p = toDevice(d, e.clientX, e.clientY); $("#tapX").value = p.x; $("#tapY").value = p.y; return; }
		scr.setPointerCapture(e.pointerId);
		down = { ...toDevice(d, e.clientX, e.clientY), t: Date.now() };
		for (const k of ["x1", "x2"]) d.line.setAttribute(k, down.px);
		for (const k of ["y1", "y2"]) d.line.setAttribute(k, down.py);
	});
	scr.addEventListener("pointerup", async e => {
		if (!down) return;
		const up = toDevice(d, e.clientX, e.clientY);
		const start = down; down = null;
		d.trail.classList.remove("on");
		const dist = Math.hypot(up.px - start.px, up.py - start.py);
		const held = Date.now() - start.t;
		const opts = { device: d.id };
		if (dist > 12) {
			const dx = up.x - start.x, dy = up.y - start.y;
			const direction = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : (dy > 0 ? "down" : "up");
			const distance = Math.round(Math.max(Math.abs(dx), Math.abs(dy)));
			await tool("mobile_swipe_on_screen", { direction, x: start.x, y: start.y, distance }, opts);
			return afterAction(d.id, 600);
		}
		if (held > 550) {
			ripple(d, start.px, start.py, true); mirrorRipple(d, start.x, start.y, true);
			await tool("mobile_long_press_on_screen_at_coordinates", { x: start.x, y: start.y, duration: held }, opts);
			return afterAction(d.id);
		}
		const now = Date.now();
		if (now - lastTap < 280) {
			clearTimeout(tapTimer); lastTap = 0;
			await tool("mobile_double_tap_on_screen", { x: start.x, y: start.y }, opts);
			return afterAction(d.id);
		}
		lastTap = now;
		ripple(d, start.px, start.py); mirrorRipple(d, start.x, start.y);
		tapTimer = setTimeout(async () => {
			await tool("mobile_click_on_screen_at_coordinates", { x: start.x, y: start.y }, opts);
			afterAction(d.id);
		}, 280);
	});
	scr.addEventListener("pointerleave", () => { $("#coords").textContent = "x — · y —"; });
	scr.addEventListener("contextmenu", e => e.preventDefault());
}

/* ---------------- Clavier du PC sur l'écran ---------------- */
// Clic sur un écran = il prend le clavier. Les lettres sont regroupées (≈ 150 ms) pour être tapées
// d'un coup ; les touches spéciales passent par adb. Tout est répété sur les appareils synchro.
const SPECIAL = new Set(["Backspace", "Delete", "Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"]);
function bindKeyboard(d) {
	const scr = d.screenEl;
	scr.tabIndex = 0;
	let buf = "", timer = null, special = null;
	const flush = async () => {
		clearTimeout(timer); timer = null;
		if (buf) {
			// la saisie ignore les espaces finaux : ils partent en appuis sur la touche Espace
			const text = buf.replace(/ +$/, ""), spaces = buf.length - text.length; buf = "";
			if (text) await tool("mobile_type_keys", { text, submit: false }, { device: d.id, quiet: false });
			if (spaces) await sendKey(d, "Space", spaces);
			afterAction(d.id, 250);
		}
		if (special) { const s = special; special = null; await sendKey(d, s.key, s.n); }
	};
	scr.addEventListener("pointerdown", () => scr.focus({ preventScroll: true }));
	scr.addEventListener("focus", () => d.tile.classList.add("kbd"));
	scr.addEventListener("blur", () => { d.tile.classList.remove("kbd"); flush(); });
	scr.addEventListener("keydown", e => {
		if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v") return; // géré par l'événement « paste »
		if (e.ctrlKey || e.metaKey || e.altKey) return;
		e.stopPropagation();
		if (e.key.length === 1) {
			e.preventDefault();
			if (special) flush();
			buf += e.key;
			clearTimeout(timer); timer = setTimeout(flush, 150);
		} else if (e.key === "Enter") {
			e.preventDefault();
			flush().then(() => tool("mobile_press_button", { button: "ENTER" }, { device: d.id })).then(() => afterAction(d.id));
		} else if (e.key === "Escape") {
			e.preventDefault();
			flush().then(() => tool("mobile_press_button", { button: "BACK" }, { device: d.id })).then(() => afterAction(d.id));
		} else if (SPECIAL.has(e.key)) {
			e.preventDefault();
			if (buf) flush();
			if (special && special.key === e.key) special.n++; else { if (special) flush(); special = { key: e.key, n: 1 }; }
			clearTimeout(timer); timer = setTimeout(flush, 120);
		}
	});
	scr.addEventListener("paste", e => {
		const text = e.clipboardData?.getData("text");
		if (!text) return;
		e.preventDefault();
		buf += text; flush();
		toast(`Collé sur ${d.info.name} : ${text.length} caractère(s)`);
	});
}
async function sendKey(d, key, n = 1) {
	const list = [d, ...syncTargets(d.id)];
	const rs = await Promise.all(list.map(x => fetch("/api/key", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ device: x.id, key, times: n }) }).then(r => r.json()).catch(e => ({ isError: true, text: e.message }))));
	rs.forEach((r, i) => { if (r.isError) toast(`${list[i].info.name} : ${r.text}`, true); });
	journal("touche " + key + (n > 1 ? " ×" + n : ""), {}, rs[0], 0, d.id);
	for (const x of list) afterAction(x.id, 250);
}

/* ---------------- Fichiers du téléphone ---------------- */
const ROOTS = [["📷 Photos", "/sdcard/DCIM/Camera"], ["🖼 Captures", "/sdcard/Pictures/Screenshots"], ["⤓ Téléchargements", "/sdcard/Download"], ["📄 Documents", "/sdcard/Documents"], ["🎬 Films", "/sdcard/Movies"], ["🎵 Musique", "/sdcard/Music"], ["🗂 Tout", "/sdcard"]];
const files = { dir: null, entries: [], shown: 150 };
const ficon = e => e.dir ? "📁" : /\.(jpe?g|png|gif|webp|heic|bmp)$/i.test(e.name) ? "🖼" : /\.(mp4|mov|mkv|webm|3gp)$/i.test(e.name) ? "🎬" : /\.(mp3|m4a|ogg|wav|flac|aac)$/i.test(e.name) ? "🎵" : /\.pdf$/i.test(e.name) ? "📕" : /\.apk$/i.test(e.name) ? "📦" : "📄";
const canPreview = n => /\.(jpe?g|png|gif|webp|bmp|mp4|webm|pdf|txt|mp3|m4a|ogg|wav)$/i.test(n);
const human = b => b < 1024 ? b + " o" : b < 1048576 ? (b / 1024).toFixed(0) + " Ko" : b < 1073741824 ? (b / 1048576).toFixed(1) + " Mo" : (b / 1073741824).toFixed(2) + " Go";
fill("#fileRoots", ROOTS.map(([label, dir]) => h("button", { class: "chip", onclick: () => openDir(dir) }, label)));
async function openDir(dir) {
	const d = F(); if (!d) return;
	if (d.info.platform !== "android") return fill("#fileList", emptyItem("Parcourir les fichiers n'est possible que sur Android."));
	fill("#fileList", emptyItem("Lecture…"));
	const r = await fetch(`/api/files?device=${encodeURIComponent(d.id)}&dir=${encodeURIComponent(dir)}`).then(x => x.json()).catch(e => ({ error: e.message }));
	if (r.error) return fill("#fileList", emptyItem(r.error));
	files.dir = r.dir; files.entries = r.entries; files.shown = 150; files.device = d.id;
	renderCrumbs(); renderFiles();
}
function renderCrumbs() {
	const parts = files.dir.split("/").filter(Boolean); // ["sdcard", …]
	const nodes = [];
	parts.forEach((p, i) => {
		const target = "/" + parts.slice(0, i + 1).join("/");
		if (i) nodes.push(h("span", {}, "/"));
		nodes.push(h("button", { onclick: () => openDir(target) }, i === 0 ? "Stockage" : p));
	});
	fill("#fileCrumbs", nodes);
}
function renderFiles() {
	const q = $("#fileFilter").value.toLowerCase();
	const sort = $("#fileSort").value;
	const list = files.entries.filter(e => !q || e.name.toLowerCase().includes(q)).sort((a, b) =>
		(b.dir - a.dir) || (sort === "name" ? a.name.localeCompare(b.name) : sort === "size" ? b.size - a.size : b.date.localeCompare(a.date)));
	const url = (e, inline) => `/api/files/get?device=${encodeURIComponent(files.device)}&path=${encodeURIComponent(files.dir + "/" + e.name)}${inline ? "&inline=1" : ""}`;
	fill("#fileList", list.length ? list.slice(0, files.shown).map(e => h("li", { class: e.dir ? "folder" : null, onclick: e.dir ? () => openDir(files.dir + "/" + e.name) : null },
		h("span", { class: "ficon" }, ficon(e)),
		h("div", { class: "grow" }, h("div", { class: "name" }, e.name), h("div", { class: "sub" }, e.dir ? e.date : `${human(e.size)} · ${e.date}`)),
		e.dir ? null : h("div", { class: "acts" },
			canPreview(e.name) ? h("a", { class: "btn", href: url(e, true), target: "_blank", title: "Aperçu" }, "👁") : null,
			h("a", { class: "btn", href: url(e, false), title: "Copier sur le PC (Téléchargements)", onclick: () => toast(`Copie de ${e.name} (${human(e.size)})…`) }, "⤓")),
	)) : emptyItem(files.entries.length ? "Aucun résultat." : "Dossier vide."));
	$("#fileMore").hidden = list.length <= files.shown;
	$("#fileMore").textContent = `Afficher plus (${list.length - files.shown} restants)`;
}
$("#fileFilter").oninput = () => { files.shown = 150; renderFiles(); };
$("#fileSort").onchange = renderFiles;
$("#fileMore").onclick = () => { files.shown += 300; renderFiles(); };
$("#fileReload").onclick = () => files.dir && openDir(files.dir);

/* ---------------- Glisser-déposer de fichiers sur un écran ---------------- */
const APP_EXT = /\.(apk|ipa|app|zip)$/i;
function bindDrop(d) {
	const zone = h("div", { class: "drop" }, h("div", { class: "drop-in" }, h("b", {}, "Déposer ici"), h("span", {}, "APK → installer · autre fichier → Téléchargements")));
	const bar = h("div", { class: "upbar" }, h("i"));
	d.screenEl.append(zone, bar);
	let depth = 0;
	const hasFiles = e => [...(e.dataTransfer?.types || [])].includes("Files");
	d.tile.addEventListener("dragenter", e => { if (!hasFiles(e)) return; e.preventDefault(); depth++; d.tile.classList.add("dropping"); });
	d.tile.addEventListener("dragover", e => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } });
	d.tile.addEventListener("dragleave", () => { if (--depth <= 0) { depth = 0; d.tile.classList.remove("dropping"); } });
	d.tile.addEventListener("drop", async e => {
		if (!hasFiles(e)) return;
		e.preventDefault(); depth = 0; d.tile.classList.remove("dropping");
		const files = [...e.dataTransfer.files];
		for (const f of files) await sendFile(d, f, bar);
	});
}
function upload(url, file, onProgress) {
	return new Promise(resolve => {
		const x = new XMLHttpRequest();
		x.open("POST", url);
		x.upload.onprogress = ev => { if (ev.lengthComputable) onProgress(ev.loaded / ev.total); };
		x.onload = () => { try { resolve(JSON.parse(x.responseText)); } catch { resolve({ isError: true, text: "Réponse invalide du serveur" }); } };
		x.onerror = () => resolve({ isError: true, text: "Envoi interrompu" });
		x.send(file);
	});
}
async function sendFile(d, f, bar) {
	const isApp = APP_EXT.test(f.name);
	if (!isApp && d.info.platform !== "android") return toast(`${d.info.name} : l'envoi de fichiers n'est possible que sur Android.`, true);
	const q = `device=${encodeURIComponent(d.id)}&name=${encodeURIComponent(f.name)}`;
	const mb = (f.size / 1048576).toFixed(1);
	toast(`${d.info.name} : ${isApp ? "installation" : "envoi"} de ${f.name} (${mb} Mo)…`);
	d.tile.classList.add("uploading"); setBusy(+1);
	const r = await upload(isApp ? `/api/install?${q}` : `/api/push?${q}`, f, p => { bar.firstChild.style.width = Math.round(p * 100) + "%"; });
	d.tile.classList.remove("uploading"); bar.firstChild.style.width = "0"; setBusy(-1);
	journal(isApp ? "mobile_install_app" : "envoi fichier", { file: f.name }, r, 0, d.id);
	toast(`${d.info.name} : ${r.isError ? r.text : isApp ? `${f.name} installé` : r.text}`, r.isError);
	if (!r.isError && isApp && d.id === state.focus) { apps = []; if ($("#tabs button.on")?.dataset.tab === "apps") loadApps(); }
	afterAction(d.id, 500);
}
// évite que le navigateur ouvre le fichier si on le lâche à côté d'un écran
for (const ev of ["dragover", "drop"]) window.addEventListener(ev, e => { if ([...(e.dataTransfer?.types || [])].includes("Files")) e.preventDefault(); });

/* ---------------- Éléments (appareil actif) ---------------- */
async function loadElements() {
	const d = F(); if (!d) return;
	const r = await tool("mobile_list_elements_on_screen", { format: "json" }, { device: d.id });
	const i = (r.text || "").indexOf("[");
	try { d.elements = i >= 0 ? JSON.parse(r.text.slice(i)) : []; } catch { d.elements = []; }
	renderOverlay(d); renderElements();
}
const meaningful = el => (el.text || el.label || el.name || el.value);
const elTitle = el => el.text || el.label || el.name || el.value || el.identifier || "";
const pct = (v, total) => (v / total * 100) + "%";
function renderOverlay(d) {
	if (!d) return;
	const on = $("#overlay").checked && d.id === state.focus;
	d.overlay.classList.toggle("on", on);
	if (!on || !d.screen.w) return fill(d.overlay);
	fill(d.overlay, d.elements.filter(el => meaningful(el) && el.coordinates?.width && el.coordinates?.height).map(el => {
		const c = el.coordinates;
		return h("div", {
			class: "ebox", dataset: { ref: el.ref }, title: `${el.ref} · ${elTitle(el)}`,
			style: `left:${pct(c.x, d.screen.w)};top:${pct(c.y, d.screen.h)};width:${pct(c.width, d.screen.w)};height:${pct(c.height, d.screen.h)}`,
			onclick: e => { e.stopPropagation(); tapRef(el); },
		});
	}));
}
function renderElements() {
	const d = F(); const els = d ? d.elements : [];
	const q = $("#elFilter").value.toLowerCase();
	const all = $("#elAll").checked;
	const items = els.filter(el => (all || meaningful(el)) && (!q || JSON.stringify(el).toLowerCase().includes(q)));
	fill("#elList", items.length ? items.map(el => {
		const c = el.coordinates;
		return h("li", { onmouseenter: () => highlight(el.ref, true), onmouseleave: () => highlight(el.ref, false), onclick: () => tapRef(el) },
			h("span", { class: "type" }, (el.type || "").split(".").pop()),
			h("div", { class: "grow" },
				h("div", { class: "name" }, elTitle(el) || "(sans texte)"),
				h("div", { class: "sub" }, `${el.ref} · ${c ? `${c.x},${c.y} ${c.width}×${c.height}` : ""}${el.identifier ? " · " + el.identifier : ""}`)));
	}) : emptyItem(els.length ? "Aucun résultat." : "Clique sur « Lire l'écran »."));
}
function highlight(ref, on) {
	const d = F(); if (!d) return;
	if (!$("#overlay").checked) { $("#overlay").checked = true; renderOverlay(d); }
	d.overlay.querySelector(`.ebox[data-ref="${CSS.escape(ref)}"]`)?.classList.toggle("hl", on);
}
async function tapRef(el) {
	const d = F(); const c = el.coordinates;
	const center = c ? { x: Math.round(c.x + c.width / 2), y: Math.round(c.y + c.height / 2) } : null;
	if (center) {
		const r = d.screenEl.getBoundingClientRect();
		ripple(d, center.x / d.screen.w * r.width, center.y / d.screen.h * r.height);
		mirrorRipple(d, center.x, center.y);
	}
	const r = await tool("mobile_click_on_screen_at_coordinates", { ref: el.ref, _coords: center }, { quiet: !!center, device: d.id });
	if (r.isError && center) await tool("mobile_click_on_screen_at_coordinates", center, { device: d.id, noSync: true, noRecord: true });
	afterAction(d.id);
}

/* ---------------- Applis ---------------- */
let apps = [];
const hue = s => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7);
async function loadApps() {
	const r = await tool("mobile_list_apps");
	apps = [...(r.text || "").replace(/^[^:]*:\s*/, "").matchAll(/\s*([^,]+?) \(([\w.\-]+)\)/g)]
		.map(m => ({ name: m[1].trim(), pkg: m[2] }))
		.sort((a, b) => a.name.localeCompare(b.name));
	renderApps();
}
function renderApps() {
	const q = $("#appFilter").value.toLowerCase();
	const list = apps.filter(a => !q || (a.name + a.pkg).toLowerCase().includes(q));
	fill("#appList", list.length ? list.map(a => h("li", {},
		h("span", { class: "appicon", style: `background:hsl(${hue(a.pkg)} 70% 62%)` }, a.name[0] || "?"),
		h("div", { class: "grow" }, h("div", { class: "name" }, a.name), h("div", { class: "sub" }, a.pkg)),
		h("div", { class: "acts" },
			h("button", { class: "btn", title: "Lancer (+ appareils synchro)", onclick: () => appAction("launch", a) }, "▶"),
			h("button", { class: "btn", title: "Fermer (+ appareils synchro)", onclick: () => appAction("stop", a) }, "■"),
			h("button", { class: "btn danger", title: "Désinstaller de l'appareil actif", onclick: () => appAction("rm", a) }, "✕")),
	)) : emptyItem(apps.length ? "Aucun résultat." : "Aucune appli chargée."));
}
async function appAction(kind, a) {
	if (kind === "launch") { const r = await tool("mobile_launch_app", { packageName: a.pkg }); if (!r.isError) toast("Lancée : " + a.name); }
	if (kind === "stop") { const r = await tool("mobile_terminate_app", { packageName: a.pkg }); if (!r.isError) toast("Fermée : " + a.name); }
	if (kind === "rm") {
		if (!confirm(`Désinstaller « ${a.name} » (${a.pkg}) de ${F().info.name} ?\nSes données seront supprimées de l'appareil.`)) return;
		const r = await tool("mobile_uninstall_app", { bundle_id: a.pkg });
		if (!r.isError) { toast("Désinstallée : " + a.name); loadApps(); }
	}
	afterActionAll(900); setTimeout(refreshTelemetry, 900);
}

/* ---------------- Médias ---------------- */
const targets = () => [F(), ...syncTargets(state.focus)].filter(Boolean);
async function loadGallery() {
	const files = await (await fetch("/api/captures")).json();
	fill("#gallery", files.length ? files.map(f => {
		const video = f.name.endsWith(".mp4");
		return h("a", { href: f.url, target: "_blank", title: f.name },
			video ? h("video", { src: f.url, muted: true, preload: "metadata" }) : h("img", { src: f.url, loading: "lazy" }),
			h("span", {}, video ? "VIDÉO" : "PNG"));
	}) : h("p", { class: "hint" }, "Rien pour l'instant."));
}
let recTick = null;
function paintRecording() {
	const d = F(); const on = !!d?.recUrl;
	$("#recStart").classList.toggle("on", on); $("#recStart").disabled = on;
	clearInterval(recTick);
	if (!on) return void ($("#recTime").textContent = "");
	recTick = setInterval(() => {
		const s = Math.floor((Date.now() - d.recStart) / 1000);
		$("#recTime").textContent = `● ${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
	}, 500);
}

/* ---------------- Logs ---------------- */
const dimSpan = t => h("span", { class: "dim" }, t);
async function loadLogs() {
	const filter = $("#logFilter").value.split(",").map(s => s.trim()).filter(Boolean);
	const limit = Math.max(1, +$("#logLimit").value || 100);
	fill("#logOut", dimSpan(`Écoute des logs de ${F()?.info.name}… (jusqu'à ${limit} lignes, ou 30 s sans activité)`));
	const r = await tool("mobile_get_device_logs", { limit, filter });
	if (r.isError) return fill("#logOut", dimSpan(r.text));
	const rows = (r.text || "").split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return { message: l }; } });
	fill("#logOut", rows.length ? rows.map(x => {
		const lv = (x.level || "?")[0].toUpperCase();
		return h("div", { class: lv }, h("span", { class: "lv" }, lv), " ", dimSpan((x.timestamp || "").slice(11, 23)), " ", h("span", { class: "tg" }, x.tag || x.process || ""), " ", x.message ?? "");
	}) : dimSpan("Aucune ligne."));
}
async function loadCrashes() {
	const r = await tool("mobile_list_crashes");
	let list = []; try { list = JSON.parse(r.text); } catch { /* texte */ }
	fill("#crashList", list.length ? list.map(c => {
		const id = c.id || c.name || JSON.stringify(c);
		return h("li", {},
			h("div", { class: "grow" }, h("div", { class: "name" }, c.process || c.name || id), h("div", { class: "sub" }, c.timestamp || c.date || id)),
			h("div", { class: "acts" }, h("button", { class: "btn", onclick: async () => { const x = await tool("mobile_get_crash", { id }); $("#crashOut").hidden = false; $("#crashOut").textContent = x.text; } }, "Voir")));
	}) : emptyItem("Aucun plantage."));
}

/* ---------------- Macros ---------------- */
// Les positions sont enregistrées en fraction de l'écran (0–1) : elles s'adaptent à chaque appareil.
function recordStep(name, args) {
	const src = D(state.rec.device);
	const a = { ...args };
	if (a.ref) { if (!a._coords) return; a.x = a._coords.x; a.y = a._coords.y; delete a.ref; }
	delete a._coords;
	const w = src.screen.w || 1, hgt = src.screen.h || 1;
	if (typeof a.x === "number") a.x = +(a.x / w).toFixed(4);
	if (typeof a.y === "number") a.y = +(a.y / hgt).toFixed(4);
	if (typeof a.distance === "number") a.distance = +(a.distance / (["left", "right"].includes(a.direction) ? w : hgt)).toFixed(4);
	const now = Date.now();
	state.rec.steps.push({ name, args: a, wait: state.rec.last ? Math.min(now - state.rec.last, 5000) : 0 });
	state.rec.last = now;
	$("#macroStatus").textContent = `● enregistrement sur ${shortName(src.id)} — ${state.rec.steps.length} étape(s)`;
}
function stepFor(step, d) {
	const a = { ...step.args };
	const w = d.screen.w || 1080, hgt = d.screen.h || 2400;
	if (typeof a.x === "number") a.x = Math.round(a.x * w);
	if (typeof a.y === "number") a.y = Math.round(a.y * hgt);
	if (typeof a.distance === "number") a.distance = Math.round(a.distance * (["left", "right"].includes(a.direction) ? w : hgt));
	return a;
}
const stepLabel = s => s.name.replace(/^mobile_/, "").replace(/_on_screen.*|_at_coordinates/, "") + (s.args.button ? " " + s.args.button : s.args.text ? ` « ${s.args.text} »` : s.args.url ? " " + s.args.url : s.args.packageName ? " " + s.args.packageName : s.args.direction ? " " + s.args.direction : "");
let macros = [];
async function loadMacros() {
	macros = await (await fetch("/api/macros")).json().catch(() => []);
	fill("#macroList", macros.length ? macros.map(m => h("li", {},
		h("div", { class: "grow" }, h("div", { class: "name" }, m.name), h("div", { class: "macro-steps" }, `${m.steps.length} étapes · ` + m.steps.slice(0, 4).map(stepLabel).join(" → ") + (m.steps.length > 4 ? " …" : ""))),
		h("div", { class: "acts" },
			h("button", { class: "btn", title: "Rejouer sur l'appareil actif + synchro", onclick: () => playMacro(m) }, "▶"),
			h("button", { class: "btn", title: "Copier dans l'onglet Script (appareil actif)", onclick: () => macroToScript(m) }, "{ }"),
			h("button", { class: "btn danger", title: "Supprimer", onclick: async () => { if (!confirm(`Supprimer la macro « ${m.name} » ?`)) return; await fetch("/api/macros/" + m.id, { method: "DELETE" }); loadMacros(); } }, "✕")),
	)) : emptyItem("Aucune macro. Clique sur « Enregistrer », puis agis sur l'écran actif."));
}
async function playMacro(m) {
	const list = targets();
	const speed = +$("#macroSpeed").value || 1;
	const times = Math.max(1, +$("#macroRepeat").value || 1);
	toast(`« ${m.name} » sur ${list.length} appareil(s)${times > 1 ? `, ${times} fois` : ""}`);
	await Promise.all(list.map(async d => {
		for (let n = 0; n < times; n++) {
			for (const s of m.steps) {
				if (s.wait) await sleep(Math.max(150, s.wait / speed));
				const a = stepFor(s, d);
				const r = await rawCall(s.name, { device: d.id, ...a });
				journal("macro · " + s.name, a, r, 0, d.id);
				if (r.isError) { toast(`${d.info.name} : étape « ${stepLabel(s)} » en échec`, true); return; }
				afterAction(d.id, 250);
			}
		}
	}));
	toast(`Macro « ${m.name} » terminée`);
}
function macroToScript(m) {
	const d = F(); if (!d) return;
	$("#script").value = JSON.stringify(m.steps.map(s => ({ name: s.name, arguments: stepFor(s, d) })), null, 2);
	$$("#tabs button").find(b => b.dataset.tab === "script").click();
	toast("Macro copiée dans l'onglet Script (sans les pauses)");
}
$("#macroRec").onclick = () => {
	if (!state.focus) return toast("Aucun appareil actif.", true);
	state.rec = { device: state.focus, steps: [], last: 0 };
	$("#macroRec").hidden = true; $("#macroStop").hidden = false;
	$("#macroStatus").classList.add("on");
	$("#macroStatus").textContent = `● enregistrement sur ${shortName(state.focus)} — agis sur son écran`;
};
$("#macroStop").onclick = async () => {
	const rec = state.rec; state.rec = null;
	$("#macroRec").hidden = false; $("#macroStop").hidden = true;
	$("#macroStatus").classList.remove("on");
	if (!rec?.steps.length) return void ($("#macroStatus").textContent = "Rien d'enregistré.");
	const name = $("#macroName").value.trim() || `Macro du ${new Date().toLocaleString()}`;
	await fetch("/api/macros", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, steps: rec.steps }) });
	$("#macroStatus").textContent = `Macro « ${name} » enregistrée (${rec.steps.length} étapes).`;
	$("#macroName").value = "";
	loadMacros();
};

/* ---------------- Émulateurs ---------------- */
const emuSel = new Set();
let emuAll = [];
const EMU_CAP = 10; // capacité estimée du PC en mode léger
function paintEmuCount() {
	const on = emuAll.filter(e => e.running).length;
	const toStart = [...emuSel].filter(n => emuAll.some(e => e.name === n && !e.running)).length;
	$("#emuCount").textContent = `${on} allumé(s) · ${emuSel.size} coché(s)` + (on + toStart > EMU_CAP ? ` · ⚠ au-delà de ~${EMU_CAP}, le PC va saturer` : "");
	$("#emuCount").style.color = on + toStart > EMU_CAP ? "var(--red)" : "";
}
async function loadEmulators() {
	const r = await fetch("/api/emulators").then(x => x.json()).catch(() => ({ available: false, emulators: [] }));
	if (!r.available) return fill("#emuList", emptyItem("Android Studio (émulateur) introuvable."));
	emuAll = r.emulators;
	for (const n of [...emuSel]) if (!emuAll.some(e => e.name === n)) emuSel.delete(n);
	paintEmuCount();
	fill("#emuList", r.emulators.length ? r.emulators.map(e => h("li", {},
		(() => { const c = h("input", { type: "checkbox", title: "Sélectionner", onchange: ev => { ev.target.checked ? emuSel.add(e.name) : emuSel.delete(e.name); paintEmuCount(); } }); c.checked = emuSel.has(e.name); return c; })(),
		h("span", { class: "led " + (e.running ? "ok" : "") }),
		h("div", { class: "grow" }, h("div", { class: "name" }, e.name.replace(/_/g, " ")), h("div", { class: "sub" }, e.running ? `allumé · ${e.serial}` : "éteint")),
		h("div", { class: "acts" }, e.running
			? h("button", { class: "btn danger", onclick: () => emuAction("stop", e.name) }, "■ Arrêter")
			: [h("button", { class: "btn", onclick: () => emuAction("start", e.name) }, "▶ Démarrer"),
				h("button", { class: "btn ghost", title: "Démarrage complet, sans reprendre l'état sauvegardé", onclick: () => emuAction("start", e.name, true) }, "à froid")]),
	)) : emptyItem("Aucun émulateur créé (Android Studio → Device Manager)."));
}
$("#emuPick").onclick = e => {
	const b = e.target.closest("[data-pick]"); if (!b) return;
	const k = b.dataset.pick;
	if (k === "none") emuSel.clear();
	else for (const em of emuAll) if (k === "all" || em.name.startsWith(k)) emuSel.add(em.name);
	loadEmulators();
};
$("#emuStartSel").onclick = async () => {
	const names = [...emuSel].filter(n => emuAll.some(e => e.name === n && !e.running));
	if (!names.length) return toast("Coche des émulateurs éteints à démarrer.", true);
	const on = emuAll.filter(e => e.running).length;
	if (on + names.length > EMU_CAP && !confirm(`${on + names.length} émulateurs allumés en même temps : au-delà de ~${EMU_CAP}, ton PC risque de saturer.\nDémarrer quand même ?`)) return;
	const r = await post("/api/emulators/start-many", { names, light: !$("#emuWindow").checked });
	toast(r.text || "Démarrage lancé");
	setTimeout(loadEmulators, 6000);
};
$("#emuStopSel").onclick = async () => {
	const names = [...emuSel].filter(n => emuAll.some(e => e.name === n && e.running));
	if (!names.length) return toast("Coche des émulateurs allumés à arrêter.", true);
	if (!confirm(`Arrêter ${names.length} émulateur(s) ?`)) return;
	const r = await post("/api/emulators/stop-many", { names });
	toast(r.text); await loadEmulators(); await loadDevices();
};

/* ----- Réglages de surveillance ----- */
async function loadSettings() {
	const s = await fetch("/api/settings").then(r => r.json()).catch(() => null);
	if (!s) return;
	$("#setIdle").value = String(s.idleMinutes); $("#setRestart").checked = s.autoRestart; $("#setNotifyDev").checked = s.notifyDevices;
}
const saveSettings = () => post("/api/settings", { idleMinutes: +$("#setIdle").value, autoRestart: $("#setRestart").checked, notifyDevices: $("#setNotifyDev").checked }).then(() => toast("Réglage enregistré"));
for (const id of ["#setIdle", "#setRestart", "#setNotifyDev"]) $(id).onchange = saveSettings;

/* ----- Notifications (serveur → page ; l'icône près de l'horloge les affiche aussi) ----- */
let noteSince = null;
async function pollNotes() {
	try {
		const list = await fetch(`/api/notes?since=${noteSince ?? 0}`).then(r => r.json());
		if (noteSince === null) { noteSince = list.length ? list[list.length - 1].id : 0; return; } // on ignore l'historique au chargement
		for (const n of list) {
			noteSince = n.id;
			if (n.kind === "ask") continue; // déjà affiché par la carte de confirmation
			toast(`${n.title} — ${n.text}`, n.kind === "error" || n.kind === "warn");
			if (document.hidden && pref("browserNotif") === "1" && "Notification" in window && Notification.permission === "granted") new Notification(`Prigojine · ${n.title}`, { body: n.text, tag: "prigojine-" + n.id });
			if (/Émulateur|Appareil/.test(n.title)) { loadDevices(true); if ($("#tabs button.on")?.dataset.tab === "device") loadEmulators(); }
		}
	} catch { /* serveur indisponible */ }
}
setInterval(pollNotes, 3000); pollNotes();
$("#notifPerm").onclick = async () => {
	if (!("Notification" in window)) return toast("Ce navigateur ne gère pas les notifications.", true);
	const p = await Notification.requestPermission();
	pref("browserNotif", p === "granted" ? "1" : "0");
	toast(p === "granted" ? "Notifications activées pour quand la page est en arrière-plan" : "Notifications refusées par le navigateur", p !== "granted");
};

async function emuAction(kind, name, cold = false) {
	if (kind === "stop" && !confirm(`Arrêter l'émulateur ${name} ?`)) return;
	toast(kind === "start" ? `Démarrage de ${name}…` : `Arrêt de ${name}…`);
	const r = await post(`/api/emulators/${kind}`, { name, cold, light: !$("#emuWindow").checked });
	toast(r.text || (r.ok ? "OK" : "Échec"), !r.ok);
	await loadEmulators();
	await loadDevices();
}

/* ---------------- Wi-Fi ---------------- */
async function loadWifi() {
	const list = await fetch("/api/wifi").then(r => r.json()).catch(() => []);
	fill("#wifiList", list.map(w => h("li", {},
		h("span", { class: "led " + (w.state === "device" ? "ok" : "err") }),
		h("div", { class: "grow" }, h("div", { class: "name" }, (w.model || "Appareil").replace(/_/g, " ") + " · Wi-Fi"), h("div", { class: "sub" }, `${w.serial} · ${w.state === "device" ? "connecté" : w.state}`)),
		h("div", { class: "acts" }, h("button", { class: "btn danger", onclick: () => wifiAction("disconnect", { serial: w.serial }) }, "Déconnecter")))));
}
async function wifiAction(kind, body, btn) {
	if (btn) btn.disabled = true;
	toast({ usb: "Passage en Wi-Fi… (quelques secondes)", pair: "Association…", connect: "Connexion…", disconnect: "Déconnexion…" }[kind]);
	const r = await post(`/api/wifi/${kind}`, body);
	if (btn) btn.disabled = false;
	toast(r.text || (r.ok ? "OK" : "Échec"), !r.ok);
	if (r.ok && kind === "pair") $("#pairCode").value = "";
	await loadWifi();
	await loadDevices();
}
$("#wifiUsb").onclick = e => {
	const d = F();
	if (!d || d.info.platform !== "android" || d.info.type !== "real") return toast("Choisis d'abord un téléphone Android branché en USB comme appareil actif.", true);
	wifiAction("usb", { device: d.id }, e.currentTarget);
};
$("#pairBtn").onclick = e => wifiAction("pair", { hostport: $("#pairHost").value, code: $("#pairCode").value }, e.currentTarget);
$("#connectBtn").onclick = e => wifiAction("connect", { hostport: $("#connectHost").value }, e.currentTarget);

/* ---------------- Préférences ---------------- */
function pref(k, v) {
	try { if (v === undefined) return localStorage.getItem("studio." + k); localStorage.setItem("studio." + k, v); } catch { return null; }
	return null;
}

/* ---------------- Liaisons ---------------- */
$("#device").onchange = e => setFocus(e.target.value);
$("#refreshDevices").onclick = () => loadDevices();
$("#refreshTele").onclick = () => refreshTelemetry();
$("#syncAll").onchange = e => { state.syncAll = e.target.checked; for (const d of state.devs.values()) paintTile(d); updateAgentTargets(); };
$("#live").onchange = e => { state.live = e.target.checked; applyVideoAll(); if (state.live) for (const d of state.devs.values()) refreshScreen(d.id, true); };
$("#rate").onchange = () => {
	pref("rate", $("#rate").value);
	if ($("#rate").value === "video" && !state.streamOk) toast("Vidéo indisponible : ffmpeg introuvable. Retour aux captures.", true);
	applyVideoAll(); for (const d of state.devs.values()) if (!d.streaming) schedule(d);
};
$("#view").onchange = () => { pref("view", $("#view").value); for (const d of state.devs.values()) paintTile(d); layoutTiles(); applyVideoAll(); for (const d of state.devs.values()) refreshScreen(d.id, true); };
$("#overlay").onchange = () => { const d = F(); renderOverlay(d); if ($("#overlay").checked && d && !d.elements.length) loadElements(); };
$("#snap").onclick = () => { for (const d of state.devs.values()) refreshScreen(d.id, true); };
document.addEventListener("visibilitychange", () => { applyVideoAll(); if (!document.hidden) for (const d of state.devs.values()) refreshScreen(d.id, true); });

$$("[data-btn]").forEach(b => b.onclick = async () => { await tool("mobile_press_button", { button: b.dataset.btn }); afterActionAll(); setTimeout(refreshTelemetry, 600); });
$$("[data-swipe]").forEach(b => b.onclick = async () => { await tool("mobile_swipe_on_screen", { direction: b.dataset.swipe }); afterActionAll(600); });

$("#tabs").onclick = e => {
	const b = e.target.closest("button[data-tab]"); if (!b) return;
	$$("#tabs button").forEach(x => x.classList.toggle("on", x === b));
	$$(".pane").forEach(p => p.classList.toggle("on", p.dataset.pane === b.dataset.tab));
	if (b.dataset.tab === "apps" && !apps.length) loadApps();
	if (b.dataset.tab === "elements" && !F()?.elements.length) loadElements();
	if (b.dataset.tab === "media") loadGallery();
	if (b.dataset.tab === "macros") loadMacros();
	if (b.dataset.tab === "files" && (!files.dir || files.device !== state.focus)) openDir("/sdcard/DCIM/Camera");
	if (b.dataset.tab === "device") { loadEmulators(); loadWifi(); loadSettings(); }
};

// Piloter
$("#typeBtn").onclick = async () => {
	const text = $("#typeText").value; if (!text) return toast("Rien à taper.", true);
	const r = await tool("mobile_type_keys", { text, submit: $("#typeSubmit").checked });
	if (!r.isError) { toast("Texte envoyé"); afterActionAll(); }
};
$("#typeText").onkeydown = e => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) $("#typeBtn").click(); };
$("#urlBtn").onclick = async () => {
	const url = $("#url").value.trim(); if (!url || url === "https://") return;
	const r = await tool("mobile_open_url", { url });
	if (!r.isError) { toast("Ouvert : " + url); afterActionAll(1200); setTimeout(refreshTelemetry, 1500); }
};
$("#url").onkeydown = e => { if (e.key === "Enter") $("#urlBtn").click(); };
$("#clipRead").onclick = async () => { const r = await tool("mobile_clipboard"); if (!r.isError) $("#clip").value = r.text; };
$("#clipWrite").onclick = async () => {
	for (const d of targets()) await tool("mobile_clipboard", { text: $("#clip").value }, { device: d.id });
	toast("Presse-papiers remplacé");
};
const xy = () => ({ x: +$("#tapX").value || 0, y: +$("#tapY").value || 0 });
$("#tapBtn").onclick = async () => { await tool("mobile_click_on_screen_at_coordinates", xy()); afterActionAll(); };
$("#dtapBtn").onclick = async () => { await tool("mobile_double_tap_on_screen", xy()); afterActionAll(); };
$("#lpBtn").onclick = async () => { await tool("mobile_long_press_on_screen_at_coordinates", xy()); afterActionAll(); };

// Applis
$("#appsLoad").onclick = loadApps;
$("#appFilter").oninput = renderApps;
$("#pkgLaunch").onclick = async () => {
	const p = $("#pkg").value.trim(); if (!p) return;
	const args = { packageName: p }; if ($("#locale").value.trim()) args.locale = $("#locale").value.trim();
	const r = await tool("mobile_launch_app", args); if (!r.isError) { toast("Lancée : " + p); afterActionAll(900); }
};
$("#installBtn").onclick = async () => {
	const f = $("#installFile").files[0]; if (!f) return toast("Choisis un fichier.", true);
	const list = targets();
	toast(`Installation de ${f.name} sur ${list.length} appareil(s)…`);
	setBusy(+1);
	try {
		await Promise.all(list.map(async d => {
			const r = await (await fetch(`/api/install?device=${encodeURIComponent(d.id)}&name=${encodeURIComponent(f.name)}`, { method: "POST", body: f })).json();
			journal("mobile_install_app", { file: f.name }, r, 0, d.id);
			toast(`${d.info.name} : ${r.text || "terminé"}`, r.isError);
		}));
		loadApps();
	} finally { setBusy(-1); }
};

// Éléments
$("#elLoad").onclick = loadElements;
$("#elFilter").oninput = renderElements;
$("#elAll").onchange = renderElements;

// Appareil
$$("[data-orient]").forEach(b => b.onclick = async () => {
	const r = await tool("mobile_set_orientation", { orientation: b.dataset.orient });
	if (!r.isError) { await refreshTelemetry(); afterActionAll(900); }
});
const PLACES = [["Paris", 48.8566, 2.3522], ["Londres", 51.5074, -0.1278], ["New York", 40.7128, -74.006], ["Tokyo", 35.6762, 139.6503], ["Sydney", -33.8688, 151.2093], ["Le Cap", -33.9249, 18.4241]];
fill("#places", PLACES.map(([n, la, lo]) => h("button", { class: "chip", onclick: () => { $("#lat").value = la; $("#lon").value = lo; $("#locSet").click(); } }, n)));
$("#locSet").onclick = async () => {
	const latitude = parseFloat($("#lat").value), longitude = parseFloat($("#lon").value);
	if (isNaN(latitude) || isNaN(longitude)) return toast("Latitude et longitude requises.", true);
	const r = await tool("mobile_set_location", { latitude, longitude }); if (!r.isError) toast(`Position : ${latitude}, ${longitude}`);
};
$("#locClear").onclick = async () => { const r = await tool("mobile_set_location", {}); if (!r.isError) toast("Position réelle restaurée"); };
const cloudText = t => fill("#cloudOut", h("li", {}, h("div", { class: "grow sub", style: "white-space:pre-wrap" }, t)));
$("#cloudLogin").onclick = async () => cloudText((await tool("mobile_login_to_cloud_provider", {}, { withDevice: false })).text);
$("#cloudList").onclick = async () => cloudText((await tool("mobile_list_remote_devices", {}, { withDevice: false })).text);

// Médias (appareil actif + appareils synchro)
$("#saveShot").onclick = async () => {
	const rs = await Promise.all(targets().map(d => post("/api/save-screenshot", { device: d.id })));
	const ok = rs.filter(r => !r.isError).length;
	toast(`${ok} capture${ok > 1 ? "s" : ""} enregistrée${ok > 1 ? "s" : ""}`, ok < rs.length); loadGallery();
};
$("#recStart").onclick = async () => {
	for (const d of targets()) {
		if (d.recUrl) continue;
		const r = await post("/api/record/start", { device: d.id });
		if (r.isError) { toast(`${d.info.name} : ${r.text}`, true); continue; }
		d.recUrl = r.url; d.recStart = Date.now();
	}
	paintRecording(); toast("Enregistrement démarré");
};
$("#recStop").onclick = async () => {
	const list = targets().filter(d => d.recUrl);
	if (!list.length) return toast("Aucun enregistrement en cours sur cet appareil.", true);
	const names = [];
	await Promise.all(list.map(async d => {
		await tool("mobile_stop_screen_recording", {}, { quiet: true, device: d.id });
		names.push(d.recUrl.split("/").pop()); d.recUrl = null;
	}));
	paintRecording();
	// sous Windows la vidéo est écrite quelques secondes après l'arrêt : on l'attend
	toast("Finalisation de la vidéo…");
	for (let i = 0; i < 30; i++) {
		const files = (await (await fetch("/api/captures")).json()).map(f => f.name);
		if (names.every(n => files.includes(n))) { toast(`${names.length} vidéo(s) enregistrée(s)`); return loadGallery(); }
		await sleep(1000);
	}
	toast("Une vidéo n'est pas apparue dans gui/captures.", true); loadGallery();
};

// Logs
$("#logLoad").onclick = loadLogs;
$("#logFilter").placeholder = "filtres : tag=ActivityManager, level=Error, process!=system";
$("#crashLoad").onclick = loadCrashes;

// Script
$("#script").value = JSON.stringify([
	{ name: "mobile_press_button", arguments: { button: "HOME" } },
	{ name: "mobile_open_url", arguments: { url: "https://www.google.com" } },
	{ name: "mobile_get_foreground_app", arguments: {} },
], null, 2);
$("#scriptRun").onclick = async () => {
	let steps;
	try { steps = JSON.parse($("#script").value); } catch (e) { return toast("JSON invalide : " + e.message, true); }
	const args = { steps, stopOnError: $("#scriptStop").checked, listElementsAtEnd: $("#scriptEls").checked };
	const list = targets();
	const rs = await Promise.all(list.map(d => tool("mobile_batch_commands", args, { device: d.id })));
	$("#scriptOut").hidden = false;
	$("#scriptOut").textContent = rs.map((r, i) => (list.length > 1 ? `══ ${list[i].info.name}\n` : "") + r.text).join("\n\n");
	for (const d of list) afterAction(d.id, 600);
};

// Journal
$("#jClear").onclick = () => { fill("#journal"); state.journal = 0; $("#jCount").textContent = 0; };

// Raccourcis clavier (hors champs de saisie)
document.addEventListener("keydown", e => {
	if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) || document.activeElement.classList?.contains("screen")) return;
	const map = { Escape: "BACK", Backspace: "BACK", h: "HOME", Enter: "ENTER" };
	if (map[e.key]) { e.preventDefault(); tool("mobile_press_button", { button: map[e.key] }).then(() => afterActionAll()); }
	if (e.key === "r") $("#snap").click();
	if (e.key === "e") { $("#overlay").checked = !$("#overlay").checked; $("#overlay").onchange(); }
	if (e.key === "Tab" && state.devs.size > 1) { // appareil suivant
		e.preventDefault();
		const ids = [...state.devs.keys()];
		setFocus(ids[(ids.indexOf(state.focus) + (e.shiftKey ? ids.length - 1 : 1)) % ids.length]);
	}
});

/* ---------------- Agents (un par appareil, en parallèle) ---------------- */
const agent = { provider: "claude", models: { claude: [], local: [] }, errors: {} };

async function loadAgentModels() {
	fill("#agentModel", h("option", {}, "chargement…"));
	try {
		const m = await (await fetch("/api/agent/models")).json();
		agent.models = m; agent.errors = m.errors || {};
	} catch { agent.errors = { claude: "serveur injoignable", local: "serveur injoignable" }; }
	renderAgentModels();
}
function renderAgentModels() {
	$$("#provider button").forEach(b => b.classList.toggle("on", b.dataset.p === agent.provider));
	const list = agent.models[agent.provider] || [];
	fill("#agentModel", list.length ? list.map(m => h("option", { value: m.id }, m.name + (m.vision ? " · 👁 vision" : ""))) : h("option", { value: "" }, agent.errors[agent.provider] || "Aucun modèle"));
	const saved = pref("model." + agent.provider);
	if (saved && list.some(m => m.id === saved)) $("#agentModel").value = saved;
	updateAgentHint();
}
function updateAgentHint() {
	$("#budgetWrap").hidden = agent.provider !== "claude";
	const m = (agent.models[agent.provider] || []).find(x => x.id === $("#agentModel").value);
	$("#thinkWrap").hidden = !(agent.provider === "local" && m?.thinking);
	$("#agentModelHint").style.color = agent.errors[agent.provider] ? "var(--red)" : "";
	$("#agentModelHint").textContent = agent.provider === "claude"
		? agent.errors.claude || "Passe par la CLI Claude Code connectée : aucune clé à saisir."
		: m ? (agent.shared ? `🔒 ${agent.shared} est utilisé par les agents en cours : les nouveaux agents prennent le même modèle (chargé une seule fois, servi en parallèle).` : `Tourne sur ta carte graphique via Ollama.${m.vision ? " Voit l'écran (vision)." : " Lit l'écran sous forme de texte (pas de vision)."} Tous les agents locaux utilisent ce même modèle.`) : (agent.errors.local || "");
}
function updateAgentTargets() {
	const list = targets();
	$("#agentTargets").textContent = list.length > 1 ? `Synchro : ${list.map(d => shortName(d.id)).join(", ")}` : "Coche « synchro » sur plusieurs écrans pour lancer la même tâche en parallèle.";
	$("#agentRunAll").disabled = list.length < 2;
}
function updateAgentButtons() {
	const d = F(); const on = !!d?.agent;
	$("#agentRun").hidden = on; $("#agentStop").hidden = !on; $("#agentContinue").hidden = on;
	$("#agentStopAll").hidden = ![...state.devs.values()].some(x => x.agent);
	syncSharedModel();
}
// Tant qu'un agent local tourne, tous les agents locaux utilisent son modèle
async function syncSharedModel() {
	let shared = null;
	try { shared = (await (await fetch("/api/agent/shared")).json()).local; } catch { /* serveur indisponible */ }
	agent.shared = shared;
	const lock = agent.provider === "local" && !!shared;
	$("#agentModel").disabled = lock;
	if (lock) { $("#agentModel").value = shared; updateAgentHint(); }
}
$("#provider").onclick = e => {
	const b = e.target.closest("button[data-p]"); if (!b) return;
	agent.provider = b.dataset.p; pref("provider", agent.provider); renderAgentModels(); syncSharedModel();
};
$("#agentModel").onchange = () => { pref("model." + agent.provider, $("#agentModel").value); updateAgentHint(); };
$("#agentModelsReload").onclick = loadAgentModels;
$("#agentTask").onkeydown = e => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) $("#agentRun").click(); };

function feed(d, ev) {
	const f = d.feed;
	f.querySelector(".feed-empty")?.remove();
	const short = o => { const s = JSON.stringify(o || {}); return s === "{}" ? "" : s; };
	let li;
	if (ev.type === "status") li = h("li", { class: "ev-status" }, "› " + ev.text);
	if (ev.type === "text") li = h("li", { class: "ev-text" }, ev.text);
	if (ev.type === "thinking") { const t = (ev.text || "").replace(/<\/?think>/g, "").trim(); if (t) li = h("li", { class: "ev-thinking" }, t); }
	if (ev.type === "tool") {
		li = h("li", { class: "ev-tool" }, h("div", { class: "t" }, h("span", { class: "spin" }), h("b", {}, ev.name.replace(/^mobile_/, "")), h("span", { class: "a" }, short(ev.args))));
		d.pending = li;
		clearTimeout(d.soon); d.soon = setTimeout(() => { refreshScreen(d.id, true); if (d.id === state.focus) refreshTelemetry(); }, 900);
	}
	if (ev.type === "result") {
		const target = d.pending || h("li", { class: "ev-tool" });
		d.pending = null;
		target.querySelector(".spin")?.remove();
		if (ev.isError) target.classList.add("err");
		if (ev.text) target.append(h("div", { class: "res" }, ev.text.slice(0, 400)));
		if (ev.image?.data) target.append(h("img", { src: `data:${ev.image.mime || "image/jpeg"};base64,${ev.image.data}` }));
		if (!target.isConnected) li = target;
	}
	if (ev.type === "done") li = h("li", { class: "ev-done" }, h("span", { class: "k" }, ev.isError ? "INTERROMPU" : "TERMINÉ" + (ev.turns ? ` · ${ev.turns} tours` : "") + (ev.cost ? ` · ${ev.cost.toFixed(3)} $` : "")), ev.text || "(pas de résumé)");
	if (ev.type === "error") li = h("li", { class: "ev-error" }, "Erreur : " + ev.text);
	if (li) f.append(li);
	f.scrollTop = f.scrollHeight;
}
function setAgent(d, on) {
	d.agent = on; paintTile(d); updateAgentButtons();
}
/* ----- Tableau de résultats (une ligne par appareil pour la dernière tâche lancée) ----- */
const results = { task: "", rows: new Map() };
function newResults(task, list) {
	results.task = task; results.rows = new Map();
	for (const d of list) results.rows.set(d.id, { d, status: "run", text: "", actions: 0, cost: null, t0: Date.now(), t1: null, shot: null });
	$("#results").hidden = false;
	renderResults();
}
function updateResult(d, ev) {
	const r = results.rows.get(d.id); if (!r) return;
	if (ev.type === "tool") r.actions++;
	if (ev.type === "confirm") r.status = "wait";
	if (ev.type === "result" && r.status === "wait") r.status = "run";
	if (ev.type === "done") { r.status = ev.isError ? "ko" : "ok"; r.text = ev.text || ""; r.cost = ev.cost ?? null; }
	if (ev.type === "error") { r.status = "ko"; r.text = ev.text; }
	renderResults();
}
async function finishResult(d) {
	const r = results.rows.get(d.id); if (!r) return;
	r.t1 = Date.now();
	if (r.status === "run" || r.status === "wait") { r.status = "ko"; r.text ||= "Arrêté."; }
	renderResults();
	// capture finale pour le rapport
	try { const b = await (await fetch(`/api/screen?device=${encodeURIComponent(d.id)}&max=600`)).blob(); r.shot = await new Promise(ok => { const fr = new FileReader(); fr.onload = () => ok(fr.result); fr.readAsDataURL(b); }); } catch { /* pas de capture */ }
}
const ST = { run: "en cours", wait: "à confirmer", ok: "terminé", ko: "échec" };
const secs = r => Math.round(((r.t1 || Date.now()) - r.t0) / 1000) + " s";
function renderResults() {
	const rows = [...results.rows.values()];
	$("#resultsTitle").textContent = `Résultats — ${results.task.slice(0, 60)}${results.task.length > 60 ? "…" : ""}`;
	fill("#resultsBody", rows.map(r => h("tr", { onclick: () => setFocus(r.d.id), title: r.text },
		h("td", {}, shortName(r.d.id)),
		h("td", {}, h("span", { class: "st " + r.status }, ST[r.status])),
		h("td", { class: "res" }, r.text ? r.text.replace(/\*\*/g, "").slice(0, 160) : "…"),
		h("td", {}, r.actions),
		h("td", {}, r.cost != null ? r.cost.toFixed(2) + " $" : "—"),
		h("td", {}, secs(r)))));
	$("#resultsExport").disabled = rows.some(r => r.status === "run" || r.status === "wait");
}
setInterval(() => { if ([...results.rows.values()].some(r => !r.t1)) renderResults(); }, 1000);

function exportReport() {
	const rows = [...results.rows.values()];
	const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
	const total = rows.reduce((s, r) => s + (r.cost || 0), 0);
	const html = `<!doctype html><html lang="fr"><meta charset="utf-8"><title>Rapport Prigojine</title>
<style>body{font:14px system-ui,sans-serif;margin:32px;color:#1d1d1f;background:#fafaf7}h1{font-size:20px}table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid #ddd;padding:10px;text-align:left;vertical-align:top}th{color:#666;font-weight:500}.ok{color:#15803d}.ko{color:#b91c1c}img{max-width:180px;border-radius:12px;border:1px solid #ccc}</style>
<h1>Rapport — ${esc(results.task)}</h1><p>${new Date().toLocaleString()} · ${rows.length} appareil(s) · modèle ${esc($("#agentModel").value)} · coût total ${total.toFixed(2)} $</p>
<table><tr><th>Appareil</th><th>État</th><th>Résultat</th><th>Actions</th><th>Coût</th><th>Durée</th><th>Écran final</th></tr>
${rows.map(r => `<tr><td>${esc(r.d.info.name)}<br><small>${esc(r.d.info.platform)} ${esc(r.d.info.version)}</small></td><td class="${r.status}">${ST[r.status]}</td><td>${esc(r.text).replace(/\n/g, "<br>")}</td><td>${r.actions}</td><td>${r.cost != null ? r.cost.toFixed(2) + " $" : "—"}</td><td>${secs(r)}</td><td>${r.shot ? `<img src="${r.shot}">` : "—"}</td></tr>`).join("")}
</table></html>`;
	const a = h("a", { href: URL.createObjectURL(new Blob([html], { type: "text/html" })), download: `rapport-${new Date().toLocaleString("sv").slice(0, 16).replace(/[: ]/g, "-")}.html` });
	document.body.append(a); a.click(); a.remove();
}
$("#resultsExport").onclick = exportReport;

/* ----- Demandes de confirmation des agents ----- */
// cartes repérées par identifiant et appareil (et non par le nom affiché, « Pixel » ≠ « Pixel 7 »)
const confirmCards = d => $$("#confirms .confirm").filter(c => c.dataset.device === d.id);
function showConfirm(d, ev) {
	if ($$("#confirms .confirm").some(c => c.dataset.id === ev.id)) return; // déjà affichée
	d.tile.classList.add("ask");
	const card = h("div", { class: "confirm", dataset: { id: ev.id, device: d.id } },
		h("div", { class: "k" }, `✦ AGENT SUR ${d.info.name.toUpperCase()} DEMANDE TON ACCORD`),
		h("div", { class: "what" }, ev.action),
		h("div", { class: "row" },
			h("button", { class: "btn", onclick: () => answer(false) }, "Refuser"),
			h("button", { class: "btn accent", onclick: () => answer(true) }, "Autoriser")));
	const answer = allow => {
		card.remove();
		if (!confirmCards(d).length) d.tile.classList.remove("ask");
		fetch("/api/agent/confirm", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: ev.id, allow }) });
		feed(d, { type: "status", text: `${allow ? "✔ Autorisé" : "✕ Refusé"} : ${ev.action}` });
	};
	$("#confirms").append(card);
	setFocus(d.id);
}
// après un rechargement : les agents continuent côté serveur, on récupère leurs demandes en attente
async function loadPendingConfirms() {
	const list = await fetch("/api/agent/confirms").then(r => r.json()).catch(() => []);
	for (const c of list) { const d = D(c.device); if (d) showConfirm(d, { id: c.id, action: c.action }); }
}
setInterval(() => { if ([...state.devs.values()].some(d => d.agent)) loadPendingConfirms(); }, 4000);

async function runAgentOn(d, task, model, cont = false) {
	if (cont) d.feed.querySelector(".feed-empty")?.remove(), d.feed.append(h("li", { class: "ev-text", style: "border-left-color:var(--blue)" }, `Toi → ${d.info.name} (suite) : ${task}`));
	else fill(d.feed, h("li", { class: "ev-text", style: "border-left-color:var(--blue)" }, `Toi → ${d.info.name} : ${task}`));
	setAgent(d, true);
	try {
		const res = await fetch("/api/agent/run", {
			method: "POST", headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				provider: agent.provider, model, device: d.id, task, continue: cont, advanced: $("#agentAdvanced").checked, think: $("#agentThink").checked,
				guard: $("#agentGuard").checked, maxActions: +$("#agentMax").value || 40, budget: +$("#agentBudget").value || 0,
			}),
		});
		if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || res.statusText); }
		const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = "";
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			buf += dec.decode(value, { stream: true });
			let i;
			while ((i = buf.indexOf("\n")) >= 0) {
				const line = buf.slice(0, i); buf = buf.slice(i + 1);
				if (!line.trim()) continue;
				let ev; try { ev = JSON.parse(line); } catch { continue; }
				if (ev.type === "confirm") showConfirm(d, ev); else feed(d, ev);
				updateResult(d, ev);
				if (["tool", "done", "error"].includes(ev.type)) journal("agent · " + (ev.name || ev.type).replace(/^mobile_/, ""), ev.args || {}, { text: ev.text || "", isError: ev.isError || ev.type === "error" }, 0, d.id);
				if (ev.type === "done" && d.id !== state.focus) toast(`${d.info.name} : agent terminé`);
			}
		}
	} catch (e) {
		feed(d, { type: "error", text: e.message });
		updateResult(d, { type: "error", text: e.message });
	} finally {
		setAgent(d, false);
		d.tile.classList.remove("ask");
		confirmCards(d).forEach(c => c.remove());
		refreshScreen(d.id, true); if (d.id === state.focus) refreshTelemetry();
		finishResult(d);
	}
}
function checkAgentInputs() {
	const task = $("#agentTask").value.trim(), model = $("#agentModel").value;
	if (!state.focus) return toast("Aucun appareil.", true);
	if (!model) return toast("Choisis un modèle.", true);
	if (!task) return toast("Décris la tâche.", true);
	return { task, model };
}
$("#agentRun").onclick = () => { const x = checkAgentInputs(); if (!x) return; newResults(x.task, [F()]); runAgentOn(F(), x.task, x.model); };
$("#agentContinue").onclick = () => { const x = checkAgentInputs(); if (!x) return; newResults(x.task, [F()]); runAgentOn(F(), x.task, x.model, true); $("#agentTask").value = ""; };
$("#agentRunAll").onclick = () => {
	const x = checkAgentInputs(); if (!x) return;
	const list = targets().filter(d => !d.agent);
	if (!list.length) return toast("Tous les appareils synchro ont déjà un agent.", true);
	toast(`Tâche lancée sur ${list.length} appareil(s) en parallèle`);
	newResults(x.task, list);
	list.forEach(d => runAgentOn(d, x.task, x.model));
};
$("#agentStop").onclick = () => fetch("/api/agent/stop", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ device: state.focus }) });
$("#agentStopAll").onclick = () => fetch("/api/agent/stop", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });

// Agents déjà en cours côté serveur (après un rechargement de la page)
async function markRunningAgents() {
	try {
		const ids = await (await fetch("/api/agent/running")).json();
		for (const id of ids) { const d = D(id); if (d && !d.agent) { setAgent(d, true); feed(d, { type: "status", text: "Agent en cours (lancé avant le rechargement de la page)." }); pollAgentEnd(d); } }
		if (ids.length) loadPendingConfirms();
	} catch { /* serveur indisponible */ }
}
async function pollAgentEnd(d) {
	while (d.agent) {
		await sleep(3000);
		const ids = await fetch("/api/agent/running").then(r => r.json()).catch(() => [d.id]);
		if (!ids.includes(d.id)) { setAgent(d, false); feed(d, { type: "status", text: "Agent terminé." }); }
	}
}

/* ---------------- Démarrage ---------------- */
$("#view").value = pref("view") || "grid";
$("#rate").value = pref("rate") || "video";
agent.provider = pref("provider") === "local" ? "local" : "claude";
for (const k of ["agentMax", "agentBudget"]) { const v = pref(k); if (v) $("#" + k).value = v; $("#" + k).onchange = e => pref(k, e.target.value); }
$("#agentGuard").checked = pref("agentGuard") !== "0";
$("#agentGuard").onchange = e => { pref("agentGuard", e.target.checked ? "1" : "0"); if (!e.target.checked) toast("Attention : les agents pourront envoyer, payer ou supprimer sans te demander.", true); };
loadAgentModels();
fetch("/api/stream-info").then(r => r.json()).then(i => { state.streamOk = !!i.available; applyVideoAll(); }).catch(() => {});
loadDevices();
setInterval(() => { if (!document.hidden) loadDevices(true); }, 15000); // détecte les appareils branchés/débranchés
