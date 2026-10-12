(function () {
    "use strict";

    const injected = window.__IDMC_RUNTIME_CONFIG__ || {};
    const metaApi = document.querySelector('meta[name="idmc-api-base-url"]')?.content;
    const localFrontendPorts = new Set(["5500", "5501", "5502"]);

    function trimSlash(value) {
        return String(value || "").trim().replace(/\/+$/, "");
    }

    function defaultApiBase() {
        if (localFrontendPorts.has(window.location.port)) {
            return `${window.location.protocol}//${window.location.hostname}:4000/api/v1`;
        }
        return `${window.location.origin}/api/v1`;
    }

    const existing = window.IDMC_CONFIG || {};
    const apiBase = trimSlash(
        injected.API_BASE_URL ||
        metaApi ||
        existing.API_BASE_URL ||
        defaultApiBase()
    );

    if (!/^https?:\/\//i.test(apiBase) && !apiBase.startsWith("/")) {
        throw new Error("IDMS API_BASE_URL must be an absolute HTTP(S) URL or a same-origin path.");
    }

    window.IDMC_CONFIG = Object.freeze({
        ...existing,
        ...injected,
        API_BASE_URL: apiBase
    });

    if (window.navigator?.serviceWorker && (window.location.protocol === "https:" || ["localhost", "127.0.0.1"].includes(window.location.hostname))) {
        window.addEventListener("load", () => {
            window.navigator.serviceWorker.register("/service-worker.js", { scope: "/", updateViaCache: "none" })
                .catch(() => undefined);
        }, { once: true });
    }
})();
