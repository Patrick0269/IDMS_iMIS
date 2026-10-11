(function () {
    "use strict";

    const CONFIG = window.IDMC_CONFIG || {};

    const API_BASE_URL =
        CONFIG.API_BASE_URL ||
        "/api/v1";

    const progressScriptUrl = new URL("action-progress.js?v=20261011-form-progress", document.currentScript && document.currentScript.src || location.href).href;
    let progressReady;
    function ensureProgress(){
        // Standalone forms can own their progress UI instead of showing the
        // site-wide overlay. Set this flag before api.js is loaded.
        if(window.IDMC_DISABLE_GLOBAL_PROGRESS === true)return Promise.resolve();
        if(window.IDMCProgress && window.IDMCProgress.version === "20261011-form-progress")return Promise.resolve();
        if(progressReady)return progressReady;
        progressReady=new Promise(resolve=>{const script=document.createElement("script"),fallback=setTimeout(resolve,8000);script.src=progressScriptUrl;script.onload=script.onerror=()=>{clearTimeout(fallback);resolve();};document.head.appendChild(script);});
        return progressReady;
    }
    function binaryBody(value){return value instanceof Blob || value instanceof ArrayBuffer || ArrayBuffer.isView(value) || value instanceof URLSearchParams;}
    const DEFAULT_TIMEOUT_MS = 25000;
    const GET_CACHE_MS = 8000;
    const MAX_GET_ATTEMPTS = 3;
    const responseCache = new Map();
    const inFlightGets = new Map();

    function requestId() {
        if (window.crypto?.randomUUID) return window.crypto.randomUUID();
        return `web-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    }

    function normalizePath(path) {
        if (!path) {
            return "";
        }

        return path.startsWith("/")
            ? path
            : `/${path}`;
    }

    function getAccessToken() {
        if (
            window.IDMCAuth &&
            typeof window.IDMCAuth.getAccessToken === "function"
        ) {
            return window.IDMCAuth.getAccessToken();
        }

        return null;
    }

    function buildHeaders(options, token) {
        const headers = new Headers(options.headers || {});

        if (!headers.has("Accept")) {
            headers.set("Accept", "application/json");
        }

        if (
            options.body !== undefined &&
            options.body !== null &&
            !(options.body instanceof FormData) &&
            !headers.has("Content-Type")
        ) {
            headers.set(
                "Content-Type",
                options.body instanceof URLSearchParams ? "application/x-www-form-urlencoded;charset=UTF-8" : binaryBody(options.body) ? "application/octet-stream" : "application/json"
            );
        }

        if (
            token &&
            !headers.has("Authorization")
        ) {
            headers.set(
                "Authorization",
                `Bearer ${token}`
            );
        }

        const activeRoleId = window.IDMCAuth?.getActiveRoleId?.();
        if (activeRoleId && !headers.has("X-IDMS-Active-Role")) {
            headers.set("X-IDMS-Active-Role", activeRoleId);
        }

        if (!headers.has("X-Request-Id")) {
            headers.set("X-Request-Id", requestId());
        }

        return headers;
    }

    async function parseResponse(response) {
        if (response.status === 204) {
            return null;
        }

        const contentType =
            response.headers.get("content-type") || "";

        if (contentType.includes("application/json")) {
            return await response.json();
        }

        const text = await response.text();

        return text || null;
    }

    function extractMessage(payload, response) {
        if (
            payload &&
            typeof payload === "object" &&
            payload.message
        ) {
            return payload.message;
        }

        if (typeof payload === "string" && payload) {
            return payload;
        }

        return (
            `Request failed with HTTP ${response.status}`
        );
    }

    function friendlyMessage(message, status, requestId) {
        const raw = String(message || "").trim();
        const generic = /^(internal server error|something went wrong)$/i.test(raw);

        if (status === 401) return "Your sign-in details may be incorrect or your session may have expired. Check them and try again.";
        if (status === 403) {
            if (/^Four-eyes control:/i.test(raw)) return "Another Admissions officer with the required permission must verify this student. The account that confirmed the import cannot perform Verify & Link.";
            if (/^Permission denied:/i.test(raw)) return "Missing permission: " + raw.replace(/^Permission denied:\s*/i, "") + ". Contact your system administrator.";
            return "Your account is not permitted to complete this action.";
        }
        if (status === 404) return raw && !generic ? raw : "The requested information was not found.";
        if (status === 409) return raw && !generic ? raw : "This action conflicts with an existing record.";
        if (status === 429) return "Too many attempts were made. Please wait a moment and try again.";
        if (status >= 500) {
            return `We couldn't complete this request right now. Please try again.${requestId ? ` Reference: ${requestId}` : ""}`;
        }
        return raw || `Request failed with HTTP ${status}`;
    }

    function connectionMessage(error) {
        if (error?.code === "REQUEST_CANCELLED") return "This request was cancelled. You can try again.";
        if (error?.code === "REQUEST_TIMEOUT" || error?.name === "AbortError") return "This is taking longer than expected. Check your connection and try again.";
        if (navigator.onLine === false) return "You appear to be offline. Check your internet connection and try again.";
        return "We couldn't reach the service right now. Check your connection and try again in a moment.";
    }

    function toUserMessage(error) {
        if (window.IDMCAuth?.toUserMessage && (error?.status === 0 || error?.status >= 500 || error?.status === 429 || error?.code === "REQUEST_TIMEOUT" || error?.code === "REQUEST_CANCELLED" || error?.name === "AbortError" || /backend|failed to fetch|networkerror|load failed/i.test(String(error?.message || "")))) return window.IDMCAuth.toUserMessage(error);
        if (!error) return "Something went wrong. Please try again.";
        if (error.status === 0 || error.code === "REQUEST_TIMEOUT" || error.code === "REQUEST_CANCELLED" || error.name === "AbortError") return connectionMessage(error);
        if (error.status >= 500) return friendlyMessage(error.message, error.status, error.requestId);
        const raw = String(error.message || "");
        if (/backend|failed to fetch|networkerror|load failed/i.test(raw)) return connectionMessage(error);
        return raw || "Something went wrong. Please try again.";
    }

    function cacheKey(url, token) {
        return `${url}|${token ? token.slice(-18) : "public"}`;
    }

    function wait(ms) {
        return new Promise(resolve => window.setTimeout(resolve, ms));
    }

    function clearGetCache() {
        responseCache.clear();
    }

    async function performRequest(url, requestOptions, callerSignal, timeoutMs, attempt) {
        await ensureProgress();
        const controller = new AbortController();
        const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
        const relayAbort=()=>controller.abort(callerSignal && callerSignal.reason);
        if(callerSignal){if(callerSignal.aborted)relayAbort();else callerSignal.addEventListener("abort",relayAbort,{once:true});}

        let response;
        try {
            response = await fetch(url, { ...requestOptions, signal: controller.signal });
        } catch (networkError) {
            const retryable = !callerSignal?.aborted && requestOptions.method === "GET" && attempt < MAX_GET_ATTEMPTS;
            if (retryable) {
                await wait(350 * attempt);
                return performRequest(url, requestOptions, callerSignal, timeoutMs, attempt + 1);
            }

            const cancelled = callerSignal?.aborted;
            const error = new Error(connectionMessage({
                name: networkError?.name,
                code: cancelled ? "REQUEST_CANCELLED" : networkError?.name === "AbortError" ? "REQUEST_TIMEOUT" : undefined
            }));
            error.cause = networkError;
            error.status = 0;
            error.code = cancelled ? "REQUEST_CANCELLED" : networkError?.name === "AbortError" ? "REQUEST_TIMEOUT" : "NETWORK_UNAVAILABLE";
            error.url = url;
            throw error;
        } finally {
            window.clearTimeout(timeout);
            if(callerSignal)callerSignal.removeEventListener("abort",relayAbort);
        }

        if (requestOptions.method === "GET" && [502, 503, 504].includes(response.status) && attempt < MAX_GET_ATTEMPTS) {
            await wait(350 * attempt);
            return performRequest(url, requestOptions, callerSignal, timeoutMs, attempt + 1);
        }

        let payload = null;
        try {
            payload = await parseResponse(response);
        } catch (parseError) {
            if (response.ok) throw new Error("The server returned an unreadable response.");
        }

        if (!response.ok) {
            const responseRequestId = response.headers.get("x-request-id") || payload?.requestId || null;
            const error = new Error(friendlyMessage(extractMessage(payload, response), response.status, responseRequestId));
            if (payload?.code === "PASSWORD_CHANGE_REQUIRED") { window.location.replace("student-first-password.html"); }
            error.status = response.status;
            error.payload = payload;
            error.url = url;
            error.requestId = responseRequestId;
            throw error;
        }

        return payload;
    }

    async function request(path, options = {}) {
        const token = getAccessToken();

        const requestOptions = {
            ...options
        };

        const timeoutMs = Number(requestOptions.timeoutMs || DEFAULT_TIMEOUT_MS);
        const callerSignal = requestOptions.signal;
        delete requestOptions.timeoutMs;
        delete requestOptions.signal;

        requestOptions.method =
            requestOptions.method || "GET";

        requestOptions.headers =
            buildHeaders(requestOptions, token);

        if (
            requestOptions.body !== undefined &&
            requestOptions.body !== null &&
            !(requestOptions.body instanceof FormData) &&
            !binaryBody(requestOptions.body) &&
            typeof requestOptions.body !== "string"
        ) {
            requestOptions.body =
                JSON.stringify(requestOptions.body);
        }

        const url =
            `${API_BASE_URL}${normalizePath(path)}`;
        const isGet = requestOptions.method === "GET";
        const key = cacheKey(url, token);

        if (!isGet) clearGetCache();
        if (isGet && requestOptions.cache !== "no-store") {
            const cached = responseCache.get(key);
            if (cached && cached.expiresAt > Date.now()) return cached.payload;
            if (inFlightGets.has(key)) return inFlightGets.get(key);
        }

        delete requestOptions.cache;
        const operation = performRequest(url, requestOptions, callerSignal, timeoutMs, 1)
            .then(payload => {
                if (isGet) responseCache.set(key, { payload, expiresAt: Date.now() + GET_CACHE_MS });
                return payload;
            })
            .finally(() => {
                if (isGet) inFlightGets.delete(key);
            });

        if (isGet) inFlightGets.set(key, operation);
        return operation;
    }

    function get(path, options = {}) {
        return request(path, {
            ...options,
            method: "GET"
        });
    }

    function post(path, body, options = {}) {
        return request(path, {
            ...options,
            method: "POST",
            body
        });
    }

    function patch(path, body, options = {}) {
        return request(path, {
            ...options,
            method: "PATCH",
            body
        });
    }

    function put(path, body, options = {}) {
        return request(path, {
            ...options,
            method: "PUT",
            body
        });
    }

    function remove(path, options = {}) {
        return request(path, {
            ...options,
            method: "DELETE"
        });
    }

    window.IDMCAPI = {
        baseUrl: API_BASE_URL,
        toUserMessage,
        getAccessToken,
        request,
        clearCache: clearGetCache,
        get,
        post,
        patch,
        put,
        delete: remove
    };
})();
