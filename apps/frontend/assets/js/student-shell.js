import { STUDENT_NAV, STUDENT_INSTITUTION } from "./student-nav.config.js?v=20261009-coursework";

const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pageUrl = href => new URL(href, location.href);

function isCurrent(href) {
  const target = pageUrl(href);
  const selectedPanel = new URL(location.href).searchParams.get("panel");
  if (selectedPanel) {
    const selected = new URL(selectedPanel, location.href);
    if (target.pathname !== selected.pathname) return false;
    for (const [key, value] of target.searchParams) if (selected.searchParams.get(key) !== value) return false;
    if (target.hash && target.hash !== selected.hash) return false;
    return true;
  }
  if (target.pathname !== location.pathname) return false;
  const currentParams = new URL(location.href).searchParams;
  for (const [key, value] of target.searchParams) if (currentParams.get(key) !== value) return false;
  if (target.hash && target.hash !== location.hash) return false;
  return true;
}

function installStudentContentRouter(nav) {
  const shell = document.querySelector(".student-shell");
  const main = document.getElementById("studentMain");
  if (!shell || !main || !nav || main.querySelector("#studentPageFrame")) return;
  const home = document.createElement("div");
  home.id = "studentHomeContent";
  const heading = main.querySelector(".page-heading");
  const homeNodes = [...main.children].filter(node => node !== heading && node.id !== "panelMessage");
  homeNodes.forEach(node => home.appendChild(node));
  main.appendChild(home);
  const message = document.getElementById("panelMessage");
  const frame = document.createElement("iframe");
  frame.id = "studentPageFrame";
  frame.className = "student-page-frame";
  frame.title = "Student service page";
  frame.hidden = true;
  frame.loading = "eager";
  main.appendChild(frame);
  const allowed = new Set();
  for (const item of STUDENT_NAV) for (const link of item.children || [item]) if (link.href) allowed.add(pageUrl(link.href).pathname);
  const originalTitle = heading?.querySelector("h1")?.textContent || "Student Panel";
  let currentUrl = null;

  const setCurrentLink = href => {
    nav.querySelectorAll("a").forEach(link => {
      const active = isCurrent(link.href);
      link.classList.toggle("is-active", active);
      if (active) link.setAttribute("aria-current", "page"); else link.removeAttribute("aria-current");
    });
  };
  const setPageHeading = title => {
    const h1 = heading?.querySelector("h1");
    if (h1) h1.textContent = title || originalTitle;
  };
  const showHome = updateHistory => {
    currentUrl = null;
    frame.hidden = true;
    frame.removeAttribute("src");
    home.hidden = false;
    if (message) message.hidden = true;
    setPageHeading(originalTitle);
    if (updateHistory) history.pushState({ studentPanel: "home" }, "", location.pathname + location.hash);
    setCurrentLink("student-portal.html");
  };
  const navigate = (href, updateHistory = true) => {
    const url = new URL(href, location.href);
    if (url.origin !== location.origin || !allowed.has(url.pathname)) return false;
    if (url.pathname.endsWith("/student-portal.html")) { showHome(updateHistory); return true; }
    url.searchParams.delete("panel");
    const relative = url.pathname.split("/").pop() + url.search + url.hash;
    currentUrl = url.href;
    home.hidden = true;
    frame.hidden = false;
    frame.title = `${url.pathname.split("/").pop().replace(".html", "")} student service`;
    frame.src = relative;
    if (message) message.hidden = true;
    const pageFile = url.pathname.split("/").pop();
    const pageTitle = pageFile === "student-application.html"
      ? "Student Registration Form"
      : pageFile.replace("student-", "").replace(".html", "").replaceAll("-", " ").replace(/\b\w/g, char => char.toUpperCase());
    setPageHeading(pageTitle);
    if (updateHistory) { const stateUrl = new URL(location.href); stateUrl.searchParams.set("panel", relative); history.pushState({ studentPanel: relative }, "", stateUrl); }
    setCurrentLink(url.href);
    if (window.matchMedia("(max-width: 820px)").matches) document.getElementById("studentSidebar")?.classList.remove("open");
    return true;
  };
  const intercept = (event, doc) => {
    const anchor = event.target.closest?.("a[href]");
    if (!anchor || anchor.target === "_blank" || anchor.hasAttribute("download")) return;
    const href = anchor.getAttribute("href");
    if (!href || href.startsWith("#")) return;
    if (navigate(new URL(href, doc.location.href).href)) event.preventDefault();
  };
  document.addEventListener("click", event => intercept(event, document));
  frame.addEventListener("load", () => {
    try {
      const doc = frame.contentDocument;
      if (!doc || !currentUrl) return;
      const style = doc.createElement("style");
      style.id = "idmc-single-panel-mode";
      style.textContent = `html,body{min-height:100%;background:#f6f3f4!important}body{margin:0!important}.portal-header,.portal-sidebar,.sidebar-brand,.student-profile-sidebar,.mast,.request-topbar,.student-shell>.topbar,.student-shell>.sidebar{display:none!important}.portal-shell,.portal-layout{display:block!important;min-height:0!important;width:100%!important}.portal-main,.main-content,.student-profile-main,.shell,.page{width:100%!important;max-width:none!important;min-height:0!important;margin:0!important;padding:18px clamp(12px,2vw,28px)!important;box-shadow:none!important}.student-profile-page .page{display:block!important}.student-footer{margin-left:0!important;margin-right:0!important}.idmc-student-tools,.idmc-account-menu{display:none!important}`;
      doc.head.appendChild(style);
      doc.addEventListener("click", event => intercept(event, doc));
      doc.querySelectorAll("a[href]").forEach(anchor => {
        const href = anchor.getAttribute("href");
        if (href && !href.startsWith("#") && !href.startsWith("mailto:") && !href.startsWith("tel:")) anchor.dataset.idmcPanelLink = "true";
      });
    } catch { /* Only same-origin student pages are embedded. */ }
  });
  window.addEventListener("popstate", event => {
    const selected = event.state?.studentPanel || new URL(location.href).searchParams.get("panel");
    if (selected) navigate(selected, false); else showHome(false);
  });
  const initialPanel = new URL(location.href).searchParams.get("panel");
  if (initialPanel) navigate(initialPanel, false); else showHome(false);
}

function itemMarkup(item) {
  if (item.children) {
    const active = item.children.some(child => isCurrent(child.href));
    const id = `student-nav-${item.id}`;
    return `<section class="idmc-nav-group ${active ? "is-active" : ""}">
      <button class="idmc-nav-toggle" type="button" aria-expanded="${active}" aria-controls="${id}"><span class="idmc-nav-icon" aria-hidden="true">${item.icon}</span><span>${item.label}</span><span class="idmc-nav-chevron" aria-hidden="true">⌄</span></button>
      <div class="idmc-nav-children" id="${id}" ${active ? "" : "hidden"}>${item.children.map(child => `<a href="${child.href}" ${isCurrent(child.href) ? 'aria-current="page"' : ""}>${child.label}</a>`).join("")}</div>
    </section>`;
  }
  return `<a class="idmc-nav-link ${isCurrent(item.href) ? "is-active" : ""}" href="${item.href}" ${isCurrent(item.href) ? 'aria-current="page"' : ""}><span class="idmc-nav-icon" aria-hidden="true">${item.icon}</span><span>${item.label}</span></a>`;
}

function buildNav(nav) {
  if (!nav || nav.dataset.idmcShell === "true") return;
  nav.dataset.idmcShell = "true";
  nav.setAttribute("aria-label", "Student services");
  nav.innerHTML = STUDENT_NAV.map(itemMarkup).join("") + '<button class="idmc-nav-logout" id="studentShellLogout" type="button"><span class="idmc-nav-icon" aria-hidden="true">⇥</span>Log Out</button>';
  nav.querySelectorAll(".idmc-nav-toggle").forEach(button => button.addEventListener("click", () => {
    const open = button.getAttribute("aria-expanded") === "true";
    button.setAttribute("aria-expanded", String(!open));
    document.getElementById(button.getAttribute("aria-controls")).hidden = open;
  }));
  nav.querySelector("#studentShellLogout")?.addEventListener("click", () => window.IDMCAuth?.logout());
  nav.querySelectorAll("a[aria-current=page]").forEach(link => { link.setAttribute("aria-current", "page"); });
}

function ensureControls(host) {
  if (!host || host.querySelector(".idmc-student-tools")) return;
  const tools = document.createElement("div");
  tools.className = "idmc-student-tools";
  const addLogout = !host.querySelector(".logout-button, #logoutTop");
  tools.innerHTML = `<a href="student-timetable.html">Timetable</a>
    <span class="idmc-student-level" id="studentShellLevel">Study level</span>
    <span class="idmc-student-campus" id="studentShellCampus">Campus</span>
    <div class="idmc-notification-wrap"><button class="idmc-bell" type="button" aria-label="Notifications" aria-expanded="false" aria-controls="studentNoticeMenu">🔔<span class="idmc-unread-count" id="studentUnreadCount" aria-live="polite" hidden></span></button><div class="idmc-notice-menu" id="studentNoticeMenu" hidden><strong>Notifications</strong><div id="studentNoticePreview"><p>Loading notifications…</p></div><a href="student-notifications.html">View all notifications</a></div></div>
    ${addLogout ? '<button class="idmc-student-logout" id="studentShellTopLogout" type="button">Log Out</button>' : ""}`;
  host.appendChild(tools);
  const bell = tools.querySelector(".idmc-bell"), menu = tools.querySelector("#studentNoticeMenu");
  bell.addEventListener("click", () => { menu.hidden = !menu.hidden; bell.setAttribute("aria-expanded", String(!menu.hidden)); });
  tools.querySelector("#studentShellTopLogout")?.addEventListener("click", () => window.IDMCAuth?.logout());
  document.addEventListener("click", event => { if (!tools.querySelector(".idmc-notification-wrap").contains(event.target)) { menu.hidden = true; bell.setAttribute("aria-expanded", "false"); } });
  document.addEventListener("keydown", event => { if (event.key === "Escape" && !menu.hidden) { menu.hidden = true; bell.setAttribute("aria-expanded", "false"); bell.focus(); } });
}

function installDrawer() {
  const sidebar = document.querySelector("#studentSidebar, .portal-sidebar");
  if (!sidebar) return;
  const header = document.querySelector(".topbar, .portal-header-inner");
  let button = document.querySelector("#menuButton, .idmc-shell-menu");
  if (!button && header) {
    button = document.createElement("button"); button.className = "idmc-shell-menu"; button.type = "button"; button.textContent = "☰"; button.setAttribute("aria-label", "Open student menu"); header.prepend(button);
  }
  if (!button) return;
  if (!sidebar.id) sidebar.id = "studentSidebar";
  button.setAttribute("aria-controls", sidebar.id); button.setAttribute("aria-expanded", "false");
  button.addEventListener("click", () => { const open = sidebar.classList.toggle("open"); button.setAttribute("aria-expanded", String(open)); });
  document.addEventListener("keydown", event => { if (event.key === "Escape" && sidebar.classList.contains("open")) { sidebar.classList.remove("open"); button.setAttribute("aria-expanded", "false"); button.focus(); } });
  document.addEventListener("click", event => { if (sidebar.classList.contains("open") && !sidebar.contains(event.target) && !button.contains(event.target)) { sidebar.classList.remove("open"); button.setAttribute("aria-expanded", "false"); } });
}

function ensurePortalSidebarChrome(sidebar) {
  if (!sidebar?.classList.contains("portal-sidebar")) return;
  if (!sidebar.querySelector(".sidebar-brand")) {
    const brand = document.createElement("a");
    brand.className = "sidebar-brand";
    brand.href = "student-portal.html";
    brand.setAttribute("aria-label", "IDMC Student Panel home");
    brand.innerHTML = '<span class="institution-mark">IDMC</span><span><strong>Institute of Development and Medical Sciences</strong><small>Student Information System</small></span>';
    sidebar.prepend(brand);
  }
  if (!sidebar.querySelector("#sidebarCollapseButton")) {
    const control = document.createElement("div");
    control.className = "sidebar-collapse-control";
    control.innerHTML = '<button id="sidebarCollapseButton" type="button" aria-label="Collapse sidebar" aria-pressed="false">⇤</button>';
    const account = sidebar.querySelector(".idmc-account-menu");
    const card = sidebar.querySelector(".portal-student-card");
    (account || card || sidebar.querySelector(".sidebar-brand"))?.insertAdjacentElement("afterend", control);
  }
}

function installAccountMenuDismissal() {
  document.addEventListener("click", event => {
    document.querySelectorAll(".idmc-account-menu[open]").forEach(menu => { if (!menu.contains(event.target)) menu.open = false; });
  });
  document.addEventListener("keydown", event => {
    if (event.key !== "Escape") return;
    const menu = document.querySelector(".idmc-account-menu[open]");
    if (menu) { menu.open = false; menu.querySelector("summary")?.focus(); }
  });
}

function ensureStudentFooter() {
  const main = document.querySelector(".portal-main, .main-content, .student-profile-main");
  if (!main || main.querySelector(".student-footer")) return;
  const footer = document.createElement("footer");
  footer.className = "student-footer";
  footer.innerHTML = `<p><strong>${escapeHtml(STUDENT_INSTITUTION.name)}</strong></p><p>Copyright © ${new Date().getFullYear()} ${escapeHtml(STUDENT_INSTITUTION.acronym)}. All rights reserved.</p><a href="${escapeHtml(STUDENT_INSTITUTION.website)}" target="_blank" rel="noopener">Institute Website</a>`;
  main.appendChild(footer);
}

function installSidebarCollapse() {
  const shell = document.querySelector(".student-shell, .portal-shell"), button = document.getElementById("sidebarCollapseButton");
  if (!shell || !button) return;
  const storageKey = "idmc-student-sidebar-collapsed";
  try { shell.classList.toggle("sidebar-collapsed", localStorage.getItem(storageKey) === "true"); } catch { /* Browser storage can be unavailable. */ }
  const sync = () => { const collapsed = shell.classList.contains("sidebar-collapsed"); button.setAttribute("aria-pressed", String(collapsed)); button.setAttribute("aria-label", collapsed ? "Expand sidebar" : "Collapse sidebar"); button.textContent = collapsed ? "⇥" : "⇤"; };
  button.addEventListener("click", () => { shell.classList.toggle("sidebar-collapsed"); sync(); try { localStorage.setItem(storageKey, String(shell.classList.contains("sidebar-collapsed"))); } catch { /* The current session still works without persistence. */ } });
  sync();
}

function ensureAccountMenu(sidebar) {
  if (!sidebar || sidebar.querySelector(".idmc-account-menu")) return;
  const card = sidebar.querySelector(".portal-student-card");
  if (!card) return;
  const menu = document.createElement("details");
  menu.className = "idmc-account-menu idmc-account-menu--portal";
  menu.innerHTML = '<summary>Student account</summary><div><a href="student-profile.html">Profile</a><a href="student-security.html">Password and security</a><button type="button">Log Out</button></div>';
  menu.querySelector("button").addEventListener("click", () => window.IDMCAuth?.logout());
  card.insertAdjacentElement("afterend", menu);
}

function formatDate(value, includeTime = false) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "—";
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Dar_es_Salaam", ...(includeTime ? { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" } : { weekday: "long", day: "2-digit", month: "short", year: "numeric" }) }).format(date);
}

function initials(student) { return [student.first_name, student.last_name].filter(Boolean).map(name => name.trim()[0]).join("").toUpperCase() || "ST"; }

function updateIdentity(data) {
  const student = data.student || {}, panel = data.panel || {};
  const name = student.full_name || [student.first_name, student.middle_name, student.last_name].filter(Boolean).join(" ") || "Student";
  const number = student.student_number || student.registration_number || "—";
  document.querySelectorAll("#sidebarName, #studentName, #currentUser, #profileSidebarName").forEach(node => { if (node.textContent.trim() === "Student" || node.id !== "studentName") node.textContent = name; });
  document.querySelectorAll("#sidebarNumber, #studentNumber, #profileSidebarNumber").forEach(node => { node.textContent = number; });
  const level = panel.level || panel.award || student.award_level || student.level || "Level not recorded";
  const campus = panel.campus || student.campus_name || student.campus || "Not recorded";
  const levelNode = document.getElementById("studentShellLevel"), campusNode = document.getElementById("studentShellCampus");
  if (levelNode) levelNode.textContent = level;
  if (campusNode) campusNode.textContent = campus;
  const fallback = document.getElementById("photoFallback"); if (fallback) fallback.textContent = initials(student);
  if (student.profile_photo_url) {
    const photo = document.getElementById("studentPhoto");
    if (photo) { photo.src = student.profile_photo_url; photo.hidden = false; if (fallback) fallback.hidden = true; }
  }
}

async function loadIdentityAndNotices() {
  if (!window.IDMCAPI) return;
  try {
    const response = await window.IDMCAPI.get("/students/me/summary");
    updateIdentity(response.data || response);
  } catch { /* The page-specific loader shows its own authentication/API error. */ }
  await loadNotifications();
}

async function loadNotifications() {
  if (!window.IDMCAPI) return;
  try {
    const response = await window.IDMCAPI.get("/students/me/notifications");
    const data = response.data || response, notifications = data.notifications || [];
    const unread = notifications.filter(row => !row.read_at && String(row.status || "").toUpperCase() !== "READ");
    const badge = document.getElementById("studentUnreadCount");
    if (badge && unread.length) { badge.textContent = unread.length > 99 ? "99+" : String(unread.length); badge.hidden = false; }
    const preview = document.getElementById("studentNoticePreview");
    if (preview) preview.innerHTML = notifications.slice(0, 5).map(row => `<a class="idmc-notice-item" href="student-notifications.html"><strong>${escapeHtml(row.title || "Notification")}</strong><span>${escapeHtml(row.body || row.message || "")}</span></a>`).join("") || "<p>No notifications.</p>";
  } catch {
    const preview = document.getElementById("studentNoticePreview");
    if (preview) preview.innerHTML = '<p class="idmc-notice-unavailable">Notifications are unavailable right now.</p>';
  }
}

function initStudentShell() {
  const sidebar = document.querySelector("#studentSidebar, .portal-sidebar, .student-profile-sidebar");
  const nav = sidebar?.querySelector(".student-nav, .portal-nav, .idmc-student-nav");
  buildNav(nav);
  installStudentContentRouter(nav);
  ensureAccountMenu(sidebar);
  ensurePortalSidebarChrome(sidebar);
  const header = document.querySelector(".topbar-actions, .portal-header-inner");
  ensureControls(header);
  installDrawer();
  installAccountMenuDismissal();
  installSidebarCollapse();
  const profileToggle = document.getElementById("toggleProfilePanel"), profilePanel = document.getElementById("profilePanelContent");
  profileToggle?.addEventListener("click", () => { const open = profileToggle.getAttribute("aria-expanded") === "true"; profileToggle.setAttribute("aria-expanded", String(!open)); profileToggle.setAttribute("aria-label", open ? "Expand profile panel" : "Collapse profile panel"); profileToggle.textContent = open ? "⌃" : "⌄"; profilePanel.hidden = open; });
  document.querySelectorAll(".student-footer a").forEach(link => { link.href = STUDENT_INSTITUTION.website; });
  ensureStudentFooter();
  if (document.getElementById("currentYear")) loadNotifications();
  else if (document.querySelector(".idmc-student-tools")) loadIdentityAndNotices();
  if (document.querySelector(".idmc-bell")) window.setInterval(loadNotifications, 120000);
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initStudentShell, { once: true });
else initStudentShell();
