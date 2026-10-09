(function () {
    "use strict";
    if (/[?&]ws=cards\b/.test(location.search)) return;

    var RAIL = 72;
    var MIN_WIDTH = 900;
    var HIDDEN = "data-idmc-ws-hidden";
    var built = null;
    var shifted = [];
    var hiddenList = [];
    var lastFound = null;

    function text(el) {
        return (el.textContent || "").replace(/\s+/g, " ").trim();
    }

    function mark(el) {
        if (!el || el === document.body || el === document.documentElement) return;
        hiddenList.push({ el: el, value: el.style.getPropertyValue("display"), priority: el.style.getPropertyPriority("display") });
        el.setAttribute(HIDDEN, "1");
        el.style.setProperty("display", "none", "important");
    }

    function showOriginal() {
        hiddenList.forEach(function (h) {
            h.el.removeAttribute(HIDDEN);
            if (h.value) h.el.style.setProperty("display", h.value, h.priority);
            else h.el.style.removeProperty("display");
        });
        hiddenList = [];
    }

    function findHeading() {
        var list = document.querySelectorAll("h1,h2,h3,h4,h5");
        for (var i = 0; i < list.length; i++) {
            var el = list[i];
            if (/your institutional workspace/i.test(text(el)) && !el.closest("[" + HIDDEN + "]") && !el.closest(".idmc-ws-rail")) return el;
        }
        return null;
    }

    function cardsIn(root, heading) {
        var anchors = [].filter.call(root.querySelectorAll("a[href]"), function (a) {
            var href = a.getAttribute("href") || "";
            return href && href.charAt(0) !== "#" && !/^javascript:/i.test(href) &&
                !a.closest("aside,nav,header") && !a.contains(heading) && text(a).length > 1;
        });
        if (anchors.length >= 3) return anchors;

        var best = [];
        [].forEach.call(root.querySelectorAll("div,ul,section"), function (box) {
            if (box.closest("aside,nav,header") || box.contains(heading)) return;
            var kids = [].filter.call(box.children, function (k) { return text(k).length > 1; });
            if (kids.length >= 3 && kids.length > best.length) {
                var tag = kids[0].tagName;
                var same = kids.every(function (k) { return k.tagName === tag; });
                if (same) best = kids;
            }
        });
        return best;
    }

    function locate() {
        var heading = findHeading();
        if (!heading) return null;
        var root = heading.parentElement;
        var cards = [];
        var level = 0;
        while (root && level < 6) {
            cards = cardsIn(root, heading);
            if (cards.length >= 3) break;
            root = root.parentElement;
            level += 1;
        }
        if (cards.length < 3) return null;
        return { heading: heading, cards: cards };
    }

    function shortLabel(title) {
        var label = title.replace(/\s+portal$/i, "").trim();
        if (/^administration$/i.test(label)) return "Admin";
        return label || title;
    }

    function describe(card) {
        var leaves = [];
        var all = card.querySelectorAll("*");
        for (var i = 0; i < all.length; i++) {
            if (!all[i].children.length && text(all[i])) leaves.push(all[i]);
        }
        if (!leaves.length) leaves = [card];

        var title = null;
        var bestScore = -1;
        leaves.forEach(function (node) {
            if (text(node).length <= 3) return;
            var style = window.getComputedStyle(node);
            var score = (parseFloat(style.fontSize) || 0) * 10 + (parseInt(style.fontWeight, 10) || 400) / 100;
            if (score > bestScore) {
                bestScore = score;
                title = node;
            }
        });
        var name = title ? text(title) : text(card);
        var more = "";
        leaves.forEach(function (node) {
            var t = text(node);
            if (node !== title && t.length > more.length) more = t;
        });

        var link = card.tagName === "A" ? card : card.querySelector("a[href]");
        return {
            name: name,
            label: shortLabel(name),
            tip: more && more.length > 3 ? name + " - " + more : name,
            href: link ? link.getAttribute("href") : "",
            node: card
        };
    }

    function isCurrent(href) {
        try {
            return new URL(href, location.href).pathname.replace(/\/+$/, "") === location.pathname.replace(/\/+$/, "");
        } catch (ignored) {
            return false;
        }
    }

    function makeItem(item, active) {
        var el;
        if (item.href) {
            el = document.createElement("a");
            el.setAttribute("href", item.href);
        } else {
            el = document.createElement("button");
            el.type = "button";
            el.addEventListener("click", function () { item.node.click(); });
        }
        el.className = "idmc-ws-item" + (active ? " is-active" : "");
        el.title = item.tip;
        el.setAttribute("aria-label", item.name);
        if (active) el.setAttribute("aria-current", "page");

        var badge = document.createElement("span");
        badge.className = "idmc-ws-badge";
        badge.textContent = item.label.charAt(0).toUpperCase();
        var label = document.createElement("span");
        label.className = "idmc-ws-label";
        label.textContent = item.label;
        el.appendChild(badge);
        el.appendChild(label);
        return el;
    }

    function buildRail(items) {
        var rail = document.createElement("nav");
        rail.className = "idmc-ws-rail";
        rail.setAttribute("aria-label", "Workspaces");
        rail.appendChild(makeItem({ name: "Dashboard home", label: "Home", tip: "Dashboard home", href: location.pathname, node: null }, true));
        var sep = document.createElement("div");
        sep.className = "idmc-ws-sep";
        rail.appendChild(sep);
        items.forEach(function (item) {
            rail.appendChild(makeItem(item, !!item.href && isCurrent(item.href)));
        });
        return rail;
    }

    function hideSection(found) {
        var common = found.heading;
        while (common && !common.contains(found.cards[0])) common = common.parentElement;
        var safe = common && common !== document.body && common !== document.documentElement &&
            !/^(MAIN|ASIDE|NAV|BODY)$/.test(common.tagName) &&
            !common.querySelector("input,textarea,select,aside,nav");
        if (safe) {
            mark(common);
            return;
        }
        var grid = found.cards[0].parentElement;
        if (grid && !grid.querySelector("input,textarea,select")) mark(grid);
        var box = found.heading.parentElement;
        if (box && !box.contains(found.cards[0]) && !box.querySelector("input,textarea,select,a[href]") && box.children.length <= 4) {
            mark(box);
        } else {
            mark(found.heading);
            var before = found.heading.previousElementSibling;
            if (before && /workspace/i.test(text(before))) mark(before);
            var after = found.heading.nextElementSibling;
            if (after && after.tagName === "P") mark(after);
        }
    }

    function revert() {
        shifted.forEach(function (s) {
            s.el.style.left = s.left;
            s.el.style.width = s.width;
        });
        shifted = [];
        document.documentElement.classList.remove("idmc-ws-on");
    }

    function apply() {
        if (!built) return;
        if (window.innerWidth < MIN_WIDTH) {
            revert();
            showOriginal();
            built.style.display = "none";
            return;
        }
        built.style.display = "";
        if (!hiddenList.length && lastFound) hideSection(lastFound);
        if (document.documentElement.classList.contains("idmc-ws-on")) return;
        document.documentElement.classList.add("idmc-ws-on");
        var all = document.body.querySelectorAll("*");
        for (var i = 0; i < all.length; i++) {
            var el = all[i];
            if (el === built || built.contains(el)) continue;
            var style = window.getComputedStyle(el);
            if (style.position !== "fixed") continue;
            var rect = el.getBoundingClientRect();
            if (rect.left > 1) continue;
            shifted.push({ el: el, left: el.style.left, width: el.style.width });
            el.style.left = ((parseFloat(style.left) || 0) + RAIL) + "px";
            if (rect.width >= window.innerWidth - 2) el.style.width = "calc(100% - " + RAIL + "px)";
        }
    }

    function tryBuild() {
        if (built) return true;
        var found = locate();
        if (!found) return false;
        built = buildRail(found.cards.map(describe));
        document.body.appendChild(built);
        lastFound = found;
        if (window.innerWidth >= MIN_WIDTH) hideSection(found);
        apply();
        return true;
    }

    function keepHidden() {
        var timer = null;
        var runs = 0;
        var observer = new MutationObserver(function () {
            if (timer) return;
            timer = setTimeout(function () {
                timer = null;
                runs += 1;
                if (runs > 60) {
                    observer.disconnect();
                    return;
                }
                if (window.innerWidth < MIN_WIDTH) return;
                var again = locate();
                if (again) {
                    lastFound = again;
                    hideSection(again);
                }
            }, 250);
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }

    function start() {
        try {
            if (tryBuild()) {
                keepHidden();
                return;
            }
            var observer = new MutationObserver(function () {
                try {
                    if (tryBuild()) {
                        observer.disconnect();
                        keepHidden();
                    }
                } catch (ignored) { observer.disconnect(); }
            });
            observer.observe(document.body, { childList: true, subtree: true });
            setTimeout(function () { observer.disconnect(); }, 15000);
        } catch (ignored) { /* never break the dashboard */ }
    }

    var resizeTimer = null;
    window.addEventListener("resize", function () {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(apply, 150);
    });

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
    else start();
})();
