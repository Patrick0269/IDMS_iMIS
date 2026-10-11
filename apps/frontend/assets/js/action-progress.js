(function () {
  "use strict";

  var VERSION = "20261011-form-progress";
  if (window.IDMCProgress && window.IDMCProgress.version === VERSION) return;

  var jobs = new Map();
  var indicators = new Map();
  var counter = 0;
  var renderTimer = null;
  var lastSource = null;
  var nativeFetch = window.fetch;
  var nativeOpen = XMLHttpRequest.prototype.open;
  var nativeSend = XMLHttpRequest.prototype.send;

  ["click", "submit", "change"].forEach(function (eventName) {
    document.addEventListener(eventName, function (event) {
      lastSource = event.target;
    }, true);
  });

  function addStyles() {
    if (document.getElementById("idmc-progress-style")) return;
    var style = document.createElement("style");
    style.id = "idmc-progress-style";
    style.textContent = [
      ".idmc-operation-progress{box-sizing:border-box;display:flex;align-items:center;gap:10px;width:100%;margin:12px 0 0;padding:10px 13px;border:1px solid #eadce1;border-radius:10px;background:#fbf5f7;color:#5f152b;font:14px/1.4 system-ui,-apple-system,'Segoe UI',sans-serif}",
      ".idmc-operation-progress strong{display:block;color:#5f152b;font-size:14px;font-weight:700}",
      ".idmc-operation-progress small{display:block;margin-top:2px;color:#75666b;font-size:12px}",
      ".idmc-progress-ring{width:22px;height:22px;flex:0 0 22px;border:3px solid #d6e4ed;border-top-color:#68152c;border-radius:50%;animation:idmc-progress-spin .8s linear infinite}",
      ".idmc-progress-ring.measured{display:grid;place-items:center;border-color:#d6e4ed;border-top-color:#68152c;font-size:8px;font-weight:700;animation:none}",
      "@keyframes idmc-progress-spin{to{transform:rotate(360deg)}}",
      "@media(prefers-reduced-motion:reduce){.idmc-progress-ring{animation-duration:1.8s}}"
    ].join("");
    document.head.append(style);
  }

  function textNode(tag, text) {
    var node = document.createElement(tag);
    node.textContent = text;
    return node;
  }

  function english(text) {
    return String(text || "Processing")
      .replace(/Kuandaa/g, "Preparing")
      .replace(/inasubiri|Inasubiri/g, "Waiting")
      .replace(/inaendelea/g, "Processing");
  }

  function bytes(value) {
    if (value >= 1048576) return (value / 1048576).toFixed(1) + " MB";
    if (value >= 1024) return (value / 1024).toFixed(1) + " KB";
    return Math.floor(value) + " B";
  }

  function getContainer(options) {
    if (options && options.container && options.container.append) return options.container;
    var source = lastSource && lastSource.closest && lastSource.closest("form");
    if (!source && lastSource && lastSource.closest) {
      source = lastSource.closest("[data-progress-container],.workspace-card,.card,.panel,section");
    }
    return source || document.querySelector("#portalContent,.portal-main,.main-content,main") || document.body;
  }

  function ensureIndicator(container) {
    var indicator = indicators.get(container);
    if (indicator) return indicator;
    indicator = document.createElement("div");
    indicator.className = "idmc-operation-progress";
    indicator.setAttribute("role", "status");
    indicator.setAttribute("aria-live", "polite");
    indicator.setAttribute("data-idmc-operation-progress", "true");
    container.append(indicator);
    indicators.set(container, indicator);
    return indicator;
  }

  function render() {
    renderTimer = null;
    if (!document.body) return;
    addStyles();

    var groups = new Map();
    jobs.forEach(function (job) {
      var group = groups.get(job.container) || [];
      group.push(job);
      groups.set(job.container, group);
    });

    indicators.forEach(function (indicator, container) {
      if (!groups.has(container)) {
        indicator.remove();
        indicators.delete(container);
      }
    });

    groups.forEach(function (active, container) {
      var tasks = active.filter(function (job) { return job.kind === "task"; });
      var job = (tasks.length ? tasks : active)[(tasks.length ? tasks : active).length - 1];
      var indicator = ensureIndicator(container);
      var measured = job.total > 0 && Number.isFinite(job.done);
      var percent = measured ? Math.min(100, Math.floor(job.done / job.total * 100)) : null;
      var ring = textNode("span", measured ? percent + "%" : "");
      ring.className = "idmc-progress-ring" + (measured ? " measured" : "");
      var details = document.createElement("span");
      details.append(
        textNode("strong", english(job.label)),
        textNode("small", english(job.stage) + " · " + Math.floor((Date.now() - job.started) / 1000) + "s")
      );
      if (active.length > 1) details.append(textNode("small", active.length + " shughuli zinaendelea"));
      if (measured) details.append(textNode("small", job.unit === "bytes" ? bytes(job.done) + " / " + bytes(job.total) : job.done + " / " + job.total + " records"));
      indicator.replaceChildren(ring, details);
    });
  }

  function paint() {
    if (!jobs.size) {
      if (renderTimer) clearTimeout(renderTimer);
      renderTimer = null;
      render();
      return;
    }
    if (!renderTimer) renderTimer = setTimeout(render, 120);
  }

  function start(label, options) {
    options = options || {};
    var id = ++counter;
    jobs.set(id, {
      label: label || "Processing",
      stage: options.stage || "Preparing",
      kind: options.kind || "task",
      started: Date.now(),
      done: null,
      total: null,
      unit: options.unit || "records",
      container: getContainer(options)
    });
    paint();
    return id;
  }

  function update(id, label, done, total, options) {
    var job = jobs.get(id);
    if (!job) return;
    options = options || {};
    if (label) job.label = label;
    if (options.stage) job.stage = options.stage;
    if (options.unit) job.unit = options.unit;
    job.done = Number.isFinite(done) ? Math.max(0, done) : null;
    job.total = Number.isFinite(total) && total > 0 ? total : null;
    paint();
  }

  function finish(id, ok, message) {
    var job = jobs.get(id);
    if (!job) return;
    jobs.delete(id);
    if (!ok && message) job.failure = message;
    paint();
  }

  function requestLabel(url, method) {
    var pathname = "";
    try { pathname = new URL(url, location.href).pathname; } catch (_) { /* ignore invalid URL */ }
    var areas = [
      [/historical-students/, "Historical Students"],
      [/historical-academics/, "Historical Academics"],
      [/curriculum|mappings/, "Curriculum Mapping"],
      [/courses/, "Course Master"],
      [/result/, "Results"],
      [/document|upload|files/, "Files / Documents"],
      [/staff/, "Staff"],
      [/admission|applicant/, "Admissions"],
      [/registration/, "Registration"],
      [/timetable/, "Timetable"]
    ];
    var area = areas.find(function (entry) { return entry[0].test(pathname); });
    var action = /^(GET|HEAD)$/i.test(method) ? "Loading " : method === "DELETE" ? "Deleting " : "Sending / saving ";
    return action + (area ? area[1] : "information");
  }

  function attachXHR(xhr) {
    var id = start(xhr.__idmcLabel || "Sending information", { kind: "request", stage: "Connecting / sending", unit: "bytes" });
    xhr.upload.addEventListener("progress", function (event) {
      update(id, null, event.lengthComputable ? event.loaded : null, event.lengthComputable ? event.total : null, { stage: "Uploading to server", unit: "bytes" });
    });
    xhr.upload.addEventListener("load", function () {
      update(id, null, null, null, { stage: xhr.__idmcServerStage });
    });
    xhr.addEventListener("progress", function (event) {
      update(id, null, event.lengthComputable ? event.loaded : null, event.lengthComputable ? event.total : null, { stage: "Receiving server response", unit: "bytes" });
    });
    xhr.addEventListener("loadend", function () {
      finish(id, xhr.status >= 200 && xhr.status < 300, xhr.status >= 200 && xhr.status < 300 ? "Request completed." : "Request failed. Review the error shown in this form.");
    }, { once: true });
    return id;
  }

  XMLHttpRequest.prototype.open = function (method, url) {
    var urlText = String(url);
    this.__idmcLabel = requestLabel(urlText, String(method).toUpperCase());
    this.__idmcServerStage = /\/validate(?:$|\?)/.test(urlText) ? "Server validation; waiting for response" : /\/confirm(?:$|\?)/.test(urlText) ? "Server import / transaction; waiting for confirmation" : "Upload sent; server is processing / saving. Waiting for confirmation";
    return nativeOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function () {
    var id = attachXHR(this);
    try { return nativeSend.apply(this, arguments); }
    catch (error) { finish(id, false, error.message); throw error; }
  };

  function canTrackFetch(input, init) {
    if (typeof input !== "string" && !(input instanceof URL)) return false;
    if (!init || !["POST", "PUT", "PATCH", "DELETE"].includes(String(init.method || "GET").toUpperCase())) return false;
    if (init.mode === "no-cors" || init.credentials === "omit" || (init.redirect && init.redirect !== "follow") || init.integrity || init.keepalive) return false;
    var body = init.body;
    return body == null || typeof body === "string" || body instanceof Blob || body instanceof FormData || body instanceof ArrayBuffer || ArrayBuffer.isView(body) || body instanceof URLSearchParams;
  }

  function fetchWithXHR(input, init) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      var signal = init.signal;
      var settled = false;
      function cleanup() { if (signal) signal.removeEventListener("abort", onAbort); }
      function fail(error) { if (settled) return; settled = true; cleanup(); reject(error); }
      function onAbort() { xhr.abort(); fail(signal && signal.reason || new DOMException("Request aborted", "AbortError")); }
      if (signal && signal.aborted) { fail(signal.reason || new DOMException("Request aborted", "AbortError")); return; }
      xhr.open(String(init.method || "GET").toUpperCase(), String(input), true);
      xhr.responseType = "blob";
      xhr.withCredentials = init.credentials === "include";
      new Headers(init.headers || {}).forEach(function (value, key) { xhr.setRequestHeader(key, value); });
      xhr.onload = function () {
        if (settled) return;
        try {
          var headers = new Headers();
          xhr.getAllResponseHeaders().trim().split(/[\r\n]+/).forEach(function (line) {
            var at = line.indexOf(":");
            if (at > 0) headers.append(line.slice(0, at), line.slice(at + 1).trim());
          });
          var response = new Response([204, 205, 304].includes(xhr.status) ? null : xhr.response, { status: xhr.status, statusText: xhr.statusText, headers: headers });
          Object.defineProperty(response, "url", { value: xhr.responseURL || new URL(String(input), location.href).href });
          Object.defineProperty(response, "redirected", { value: !!xhr.responseURL && xhr.responseURL !== new URL(String(input), location.href).href });
          settled = true; cleanup(); resolve(response);
        } catch (error) { fail(error); }
      };
      xhr.onerror = function () { fail(new TypeError("Network request failed")); };
      xhr.onabort = function () { fail(signal && signal.reason || new DOMException("Request aborted", "AbortError")); };
      xhr.ontimeout = function () { fail(new DOMException("Request timed out", "TimeoutError")); };
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
      try { xhr.send(init.body == null ? null : init.body); } catch (error) { fail(error); }
    });
  }

  window.fetch = async function (input, init) {
    if (canTrackFetch(input, init)) return fetchWithXHR(String(input), init);
    var url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
    var method = String(init && init.method || input && input.method || "GET").toUpperCase();
    var id = start(requestLabel(url, method), { kind: "request", stage: "Waiting for server response" });
    try {
      var response = await nativeFetch.apply(this, arguments);
      finish(id, response.ok);
      return response;
    } catch (error) {
      finish(id, false);
      throw error;
    }
  };

  ["readAsDataURL", "readAsArrayBuffer", "readAsText", "readAsBinaryString"].forEach(function (method) {
    var original = FileReader.prototype[method];
    if (!original) return;
    FileReader.prototype[method] = function (file) {
      var reader = this;
      var id = start("Reading file " + (file && file.name || ""), { kind: "request", stage: "Reading on this computer", unit: "bytes" });
      var aborted = false;
      function onProgress(event) { update(id, null, event.lengthComputable ? event.loaded : null, event.lengthComputable ? event.total : null, { stage: "Reading file", unit: "bytes" }); }
      function onAbort() { aborted = true; }
      reader.addEventListener("progress", onProgress);
      reader.addEventListener("abort", onAbort, { once: true });
      reader.addEventListener("loadend", function () {
        reader.removeEventListener("progress", onProgress);
        reader.removeEventListener("abort", onAbort);
        finish(id, !reader.error && !aborted, aborted ? "File reading cancelled." : reader.error ? "File reading failed." : "File read; preparing upload.");
      }, { once: true });
      try { return original.apply(reader, arguments); }
      catch (error) { finish(id, false); throw error; }
    };
  });

  ["text", "arrayBuffer"].forEach(function (method) {
    if (!Blob.prototype[method]) return;
    Blob.prototype[method] = function () {
      var blob = this;
      return new Promise(function (resolve, reject) {
        var reader = new FileReader();
        reader.onload = function () { resolve(reader.result); };
        reader.onerror = function () { reject(reader.error || new Error("Unable to read file")); };
        reader.onabort = function () { reject(new DOMException("File read aborted", "AbortError")); };
        if (method === "text") reader.readAsText(blob, "UTF-8");
        else reader.readAsArrayBuffer(blob);
      });
    };
  });

  async function mapLimited(items, limit, worker, onProgress) {
    limit = Math.max(1, Math.min(4, Number(limit) || 1));
    var next = 0, done = 0, results = new Array(items.length), stop = false;
    async function run() {
      while (!stop) {
        var index = next++;
        if (index >= items.length) return;
        try { results[index] = { ok: true, value: await worker(items[index], index) }; }
        catch (error) { results[index] = { ok: false, error: error }; if (error.status === 401 || error.status === 403) stop = true; }
        done++;
        if (onProgress) onProgress(done, items.length, results[index], index);
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
    for (var index = 0; index < items.length; index++) {
      if (!results[index]) results[index] = { ok: false, notAttempted: true, error: new Error("Stopped after access/session error; this row was not sent") };
    }
    return results;
  }

  window.IDMCProgress = { version: VERSION, start: start, update: update, finish: finish, mapLimited: mapLimited };
})();
