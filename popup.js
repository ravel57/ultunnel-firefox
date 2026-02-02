const api = (typeof browser !== "undefined") ? browser : chrome;

function $(id) {
	return document.getElementById(id);
}

function tabsQuery(query) {
	// browser.* returns a Promise, chrome.* uses callback
	try {
		const res = api.tabs.query(query);
		if (res && typeof res.then === "function") return res;
	} catch (_) {
	}
	return new Promise((resolve) => api.tabs.query(query, resolve));
}

function sendMessage(msg) {
	try {
		const res = api.runtime.sendMessage(msg);
		if (res && typeof res.then === "function") return res;
	} catch (_) {
	}
	return new Promise((resolve) => api.runtime.sendMessage(msg, resolve));
}

async function getActiveTab() {
	const tabs = await tabsQuery({active: true, currentWindow: true});
	return tabs && tabs[0];
}

document.addEventListener("DOMContentLoaded", async () => {
	const allToggle = $("allToggle");
	const siteToggle = $("siteToggle");
	const allInfo = $("allInfo");
	const siteInfo = $("siteInfo");
	const siteBlock = $("siteBlock");
	const hint = $("hint");

	const tab = await getActiveTab();
	const url = tab?.url || "";

	const st = await sendMessage({type: "getPopupState", url});
	if (!st?.ok) {
		hint.textContent = "Не удалось получить состояние.";
		allToggle.disabled = true;
		siteToggle.disabled = true;
		return;
	}

	allToggle.checked = !!st.tunnelAll;
	allInfo.textContent = `SOCKS5 ${st.target}`;

	if (!st.host) {
		siteToggle.disabled = true;
		siteInfo.textContent = "Сайт: неизвестно (about: / moz-extension: и т.п.)";
	} else {
		siteInfo.textContent = `Сайт: ${st.host}`;
	}

	function refreshUiGlobalMode() {
		if (allToggle.checked) {
			siteBlock.classList.add("disabled");
			hint.textContent = "Глобальный режим: туннелируется весь трафик браузера.";
		} else {
			siteBlock.classList.remove("disabled");
			hint.textContent = "";
		}
	}

	siteToggle.checked = !!st.siteEnabled;
	refreshUiGlobalMode();

	allToggle.addEventListener("change", async () => {
		const res = await sendMessage({type: "setTunnelAll", value: allToggle.checked});
		if (!res?.ok) {
			allToggle.checked = !allToggle.checked;
			hint.textContent = "Не удалось переключить режим.";
			return;
		}
		refreshUiGlobalMode();
	});

	siteToggle.addEventListener("change", async () => {
		if (!st.host) return;

		const res = await sendMessage({
			type: "setSiteEnabled",
			host: st.host,
			value: siteToggle.checked
		});

		if (!res?.ok) {
			siteToggle.checked = !siteToggle.checked;
			hint.textContent = res?.error ? `Ошибка: ${res.error}` : "Не удалось переключить сайт.";
			return;
		}

		hint.textContent = "";
	});
});
