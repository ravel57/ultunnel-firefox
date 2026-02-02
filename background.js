// background.js (Firefox WebExtension, MV2)
// Modes:
// 1) tunnelAll=true  => SOCKS5 127.0.0.1:56130 for ALL traffic (except local/private)
// 2) tunnelAll=false => SOCKS5 only for domains in list, otherwise DIRECT
//
// Storage:
// - tunnelAll: boolean
// - domains: string[]  (rules; match host == rule OR host endsWith "."+rule)

const api = (typeof browser !== "undefined") ? browser : chrome;

const PROXY_HOST = "127.0.0.1";
const PROXY_PORT = 5613;

const STORAGE_KEYS = {
	tunnelAll: "tunnelAll",
	domains: "domains",
};

function normalizeDomain(d) {
	return String(d || "").trim().toLowerCase().replace(/^\.+|\.+$/g, "");
}

function stripWww(host) {
	const h = normalizeDomain(host);
	return h.startsWith("www.") ? h.substring(4) : h;
}

function uniqueSorted(arr) {
	return Array.from(new Set(arr)).sort((a, b) => a.localeCompare(b));
}

// Collapse rotating CDN hosts to base domains (YouTube)
function collapseHostnameForRules(hostname) {
	const h = normalizeDomain(hostname);
	if (!h) return "";
	if (h === "googlevideo.com" || h.endsWith(".googlevideo.com")) return "googlevideo.com";
	if (h === "ytimg.com" || h.endsWith(".ytimg.com")) return "ytimg.com";
	if (h === "youtube.com" || h.endsWith(".youtube.com")) return "youtube.com";
	return h;
}

function getHostFromUrl(url) {
	try {
		return new URL(url).hostname.toLowerCase();
	} catch {
		return "";
	}
}

function isHostCovered(host, rules) {
	const h = normalizeDomain(host);
	if (!h) return false;
	for (const r of rules) {
		const rr = normalizeDomain(r);
		if (!rr) continue;
		if (h === rr) return true;
		if (h.endsWith("." + rr)) return true;
	}
	return false;
}

function presetsForHost(host) {
	const h = normalizeDomain(host);

	// YouTube presets (covers googlevideo/ytimg/etc.)
	if (h === "youtube.com" || h.endsWith(".youtube.com") || h === "youtu.be" || h.endsWith(".youtu.be")) {
		return ["youtube.com", "ytimg.com", "googlevideo.com", "youtubei.googleapis.com", "ggpht.com"];
	}

	// Instagram presets (commonly required)
	if (h === "instagram.com" || h.endsWith(".instagram.com")) {
		return ["instagram.com", "cdninstagram.com", "fbcdn.net", "facebook.com", "graph.facebook.com"];
	}

	return [];
}

function isLocalOrPrivateHost(host) {
	const h = normalizeDomain(host);
	if (!h) return true;

	// plain hostnames (no dots) -> treat as local (intranet)
	if (!h.includes(".")) return true;

	if (h === "localhost" || h.endsWith(".localhost")) return true;

	// IPv6 loopback
	if (h === "::1") return true;

	// IPv4 checks
	const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
	if (m) {
		const a = Number(m[1]), b = Number(m[2]);
		if ([a, b].some((x) => Number.isNaN(x) || x < 0 || x > 255)) return false;

		// loopback 127.0.0.0/8
		if (a === 127) return true;
		// 10.0.0.0/8
		if (a === 10) return true;
		// 172.16.0.0/12
		if (a === 172 && b >= 16 && b <= 31) return true;
		// 192.168.0.0/16
		if (a === 192 && b === 168) return true;
		// link-local 169.254.0.0/16
		if (a === 169 && b === 254) return true;
	}

	return false;
}

// ---- State cache (fast path for proxy.onRequest) ----
let cachedTunnelAll = false;
let cachedDomains = [];

async function loadStateIntoCache() {
	const data = await api.storage.local.get([STORAGE_KEYS.tunnelAll, STORAGE_KEYS.domains]);
	cachedTunnelAll = !!data[STORAGE_KEYS.tunnelAll];
	const raw = Array.isArray(data[STORAGE_KEYS.domains]) ? data[STORAGE_KEYS.domains] : [];
	cachedDomains = uniqueSorted(raw.map(normalizeDomain).filter(Boolean));
}

async function ensureDefaults() {
	const data = await api.storage.local.get([STORAGE_KEYS.tunnelAll, STORAGE_KEYS.domains]);
	const patch = {};
	if (typeof data[STORAGE_KEYS.tunnelAll] !== "boolean") patch[STORAGE_KEYS.tunnelAll] = false;
	if (!Array.isArray(data[STORAGE_KEYS.domains])) patch[STORAGE_KEYS.domains] = [];
	if (Object.keys(patch).length) await api.storage.local.set(patch);
}

// ---- Proxy decision for each request ----
function proxyDecisionForUrl(url) {
	const host = getHostFromUrl(url);
	if (!host) return {type: "direct"};

	// do not proxy local/private
	if (isLocalOrPrivateHost(host)) return {type: "direct"};

	if (cachedTunnelAll) {
		return {type: "socks", host: PROXY_HOST, port: PROXY_PORT, proxyDNS: true};
	}

	const ruleHost = collapseHostnameForRules(stripWww(host));
	if (isHostCovered(ruleHost, cachedDomains)) {
		return {type: "socks", host: PROXY_HOST, port: PROXY_PORT, proxyDNS: true};
	}

	return {type: "direct"};
}

// Firefox-specific proxy API
if (api.proxy && api.proxy.onRequest && api.proxy.onRequest.addListener) {
	api.proxy.onRequest.addListener(
		(requestInfo) => proxyDecisionForUrl(requestInfo.url),
		{urls: ["<all_urls>"]}
	);
}

// Init
api.runtime.onInstalled.addListener(async () => {
	await ensureDefaults();
	await loadStateIntoCache();
});

api.runtime.onStartup?.addListener(async () => {
	await loadStateIntoCache();
});

// keep cache up-to-date
api.storage.onChanged.addListener(async (changes, area) => {
	if (area !== "local") return;
	if (changes[STORAGE_KEYS.tunnelAll] || changes[STORAGE_KEYS.domains]) {
		await loadStateIntoCache();
	}
});

// Messages from popup
api.runtime.onMessage.addListener((msg, _sender) => (async () => {
	try {
		if (!msg?.type) return {ok: false};

		if (msg.type === "getPopupState") {
			const url = String(msg.url || "");
			const host = getHostFromUrl(url);
			const siteRule = collapseHostnameForRules(stripWww(host));
			const siteEnabled = isHostCovered(siteRule, cachedDomains);

			return {
				ok: true,
				tunnelAll: cachedTunnelAll,
				host,
				siteRule,
				siteEnabled,
				target: `${PROXY_HOST}:${PROXY_PORT}`,
			};
		}

		if (msg.type === "setTunnelAll") {
			await api.storage.local.set({[STORAGE_KEYS.tunnelAll]: !!msg.value});
			await loadStateIntoCache();
			return {ok: true};
		}

		if (msg.type === "setSiteEnabled") {
			if (cachedTunnelAll) return {ok: true, ignored: true};

			const host = normalizeDomain(msg.host || "");
			if (!host) return {ok: false, error: "empty_host"};

			const base = collapseHostnameForRules(stripWww(host));
			const enable = !!msg.value;

			let next = cachedDomains.slice();

			if (enable) {
				const preset = presetsForHost(base);
				if (preset.length) next = next.concat(preset);
				else next.push(base);
			} else {
				const preset = presetsForHost(base);
				const toRemove = new Set([base, ...preset].map(normalizeDomain));
				next = next.filter((d) => !toRemove.has(normalizeDomain(d)));
			}

			next = uniqueSorted(next.map(normalizeDomain).filter(Boolean));

			await api.storage.local.set({[STORAGE_KEYS.domains]: next});
			await loadStateIntoCache();

			return {ok: true, domains: next, siteEnabled: enable, siteRule: base};
		}

		return {ok: false, error: "unknown_type"};
	} catch (e) {
		return {ok: false, error: String(e?.message || e)};
	}
})());
