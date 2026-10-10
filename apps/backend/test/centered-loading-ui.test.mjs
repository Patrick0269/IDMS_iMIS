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

test("shared operation loading uses one centered overlay for the main workspace and removes duplicate completions", async () => {
  const body = new Element("body"), head = new Element("head"), main = new Element("main"), header = new Element("header");
  main.rect = { top: 50, bottom: 1200, left: 280, right: 1600 };
  header.rect = { top: 0, bottom: 68, left: 280, right: 1600 };
  const elementsById = new Map();
  const document = {
    body, head, documentElement: { clientHeight: 900 },
    createElement: tag => new Element(tag),
    getElementById: id => elementsById.get(id) || null,
    querySelector: selector => selector.includes("portalContent") || selector === "main" ? main : selector.includes("portal-header") ? header : null,
    addEventListener() {}
  };
  const window = { innerHeight: 900, innerWidth: 1600, fetch: async () => ({}), addEventListener() {} };
  class XMLHttpRequest { constructor() { this.upload = { addEventListener() {} }; } addEventListener() {} }
  class FileReader { addEventListener() {} readAsDataURL() {} readAsArrayBuffer() {} readAsText() {} readAsBinaryString() {} }
  class Blob { text() {} arrayBuffer() {} }
  const context = { window, document, XMLHttpRequest, FileReader, Blob, FormData: class {}, URL, URLSearchParams, Headers, Response, setTimeout, clearTimeout, setInterval() {} };
  vm.runInNewContext(await read("assets/js/action-progress.js"), context);

  const first = window.IDMCProgress.start("Loading Course Registration", { kind: "request", stage: "Waiting for server response" });
  const second = window.IDMCProgress.start("Loading information", { kind: "request", stage: "Waiting for server response" });
  await new Promise(resolve => setTimeout(resolve, 180));
  assert.equal(body.children.filter(child => child.className === "idmc-progress-layer").length, 1);
  const layer = body.children.find(child => child.className === "idmc-progress-layer");
  assert.equal(layer.style.left, "280px", "loading should be positioned over the content, clear of the left sidebar");
  assert.equal(layer.style.top, "76px", "loading should be centered below the portal header");
  assert.match(layer.textContent, /Loading information/);

  window.IDMCProgress.finish(first, true, "Completed.");
  await new Promise(resolve => setTimeout(resolve, 180));
  assert.equal(body.children.filter(child => child.className === "idmc-progress-layer").length, 1, "one remaining request keeps the same overlay visible");
  assert.doesNotMatch(layer.textContent, /Completed\./, "individual successful requests must not stack completion banners");
  window.IDMCProgress.finish(second, true, "Completed.");
  assert.equal(body.children.filter(child => child.className === "idmc-progress-layer").length, 0, "the shared overlay closes when all work is finished");
});

test("API loader version and service worker cache advance together", async () => {
  const [api, worker] = await Promise.all([read("assets/js/api.js"), read("service-worker.js")]);
  assert.match(api, /20261010-centered-progress/);
  assert.match(worker, /idmc-shell-v9-centered-progress-20261010/);
});
