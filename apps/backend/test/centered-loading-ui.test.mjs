import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const frontend = new URL("../../frontend/", import.meta.url);
const read = path => readFile(new URL(path, frontend), "utf8");

class Element {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.style = { setProperty() {} };
    this.attributes = {};
    this.isConnected = true;
  }
  append(...nodes) { for (const node of nodes) { node.parentNode = this; this.children.push(node); } }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener() {}
  remove() { this.parentNode?.children.splice(this.parentNode.children.indexOf(this), 1); this.isConnected = false; }
  get textContent() { return (this._text || "") + this.children.map(child => child.textContent || "").join(""); }
  set textContent(value) { this._text = String(value); this.children = []; }
  getBoundingClientRect() { return this.rect || { top: 74, bottom: 1000, left: 280, right: 1500 }; }
}

test("shared operation loading appears inside the active form and clears after its requests finish", async () => {
  const body = new Element("body"), head = new Element("head"), main = new Element("main"), form = new Element("form");
  main.append(form);
  const elementsById = new Map();
  const document = {
    body, head, documentElement: { clientHeight: 900 },
    createElement: tag => new Element(tag),
    getElementById: id => elementsById.get(id) || null,
    querySelector: selector => selector.includes("portalContent") || selector === "main" ? main : null,
    addEventListener() {}
  };
  const window = { innerHeight: 900, innerWidth: 1600, fetch: async () => ({}), addEventListener() {} };
  class XMLHttpRequest { constructor() { this.upload = { addEventListener() {} }; } addEventListener() {} }
  class FileReader { addEventListener() {} readAsDataURL() {} readAsArrayBuffer() {} readAsText() {} readAsBinaryString() {} }
  class Blob { text() {} arrayBuffer() {} }
  const context = { window, document, XMLHttpRequest, FileReader, Blob, FormData: class {}, URL, URLSearchParams, Headers, Response, setTimeout, clearTimeout, setInterval() {} };
  vm.runInNewContext(await read("assets/js/action-progress.js"), context);

  const first = window.IDMCProgress.start("Loading Course Registration", { kind: "request", stage: "Waiting for server response", container: form });
  const second = window.IDMCProgress.start("Loading information", { kind: "request", stage: "Waiting for server response", container: form });
  await new Promise(resolve => setTimeout(resolve, 180));
  assert.equal(body.children.filter(child => child.className === "idmc-progress-layer").length, 0, "the global page overlay is not used");
  assert.equal(form.children.filter(child => child.className === "idmc-operation-progress").length, 1);
  const indicator = form.children.find(child => child.className === "idmc-operation-progress");
  assert.match(indicator.textContent, /Loading information/);
  assert.match(indicator.textContent, /2 shughuli zinaendelea/);

  window.IDMCProgress.finish(first, true, "Completed.");
  await new Promise(resolve => setTimeout(resolve, 180));
  assert.equal(form.children.filter(child => child.className === "idmc-operation-progress").length, 1, "one remaining request keeps its form indicator visible");
  assert.doesNotMatch(indicator.textContent, /Completed\./, "individual successful requests must not stack completion banners");
  window.IDMCProgress.finish(second, true, "Completed.");
  assert.equal(form.children.filter(child => child.className === "idmc-operation-progress").length, 0, "the form indicator clears when its requests finish");
});

test("API loader version and service worker cache advance together", async () => {
  const [api, worker] = await Promise.all([read("assets/js/api.js"), read("service-worker.js")]);
  assert.match(api, /20261011-form-progress/);
  assert.match(worker, /idmc-shell-v15-intake-password-fixes-20261011/);
});
