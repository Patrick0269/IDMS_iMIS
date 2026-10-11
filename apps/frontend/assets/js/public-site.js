(function () {
  "use strict";
  var base = window.IDMC_CONFIG && window.IDMC_CONFIG.API_BASE_URL;
  var currentContent = {}, statisticsData = null;
  var programmeRows = [];
  var textMap = {
    siteName: "siteName", tagline: "siteTagline", address: "siteAddress", phone: "siteHeaderPhone", officeHours: "siteOfficeHours",
    heroEyebrow: "siteHeroEyebrow", heroTitle: "siteHeroTitle", heroDescription: "siteHeroDescription", announcementTitle: "siteAnnouncementTitle", announcementText: "siteAnnouncementText",
    aboutEyebrow: "siteAboutEyebrow", aboutTitle: "siteAboutTitle", aboutTextOne: "siteAboutTextOne", aboutTextTwo: "siteAboutTextTwo",
    programmeEyebrow: "siteProgrammeEyebrow", programmeTitle: "siteProgrammeTitle", programmeIntro: "siteProgrammeIntro",
    campusTitle: "siteCampusTitle", campusText: "siteCampusText", campusNameOne: "siteCampusNameOne", campusTextOne: "siteCampusTextOne",
    campusNameTwo: "siteCampusNameTwo", campusTextTwo: "siteCampusTextTwo", campusNameThree: "siteCampusNameThree", campusTextThree: "siteCampusTextThree",
    admissionsTitle: "siteAdmissionsTitle", admissionsText: "siteAdmissionsText", contactTitle: "siteContactTitle", admissionsEmail: "siteAdmissionsEmail", generalEmail: "siteGeneralEmail",
    portalTitle: "sitePortalTitle", footerInstituteName: "siteFooterInstituteName", footerInstituteText: "siteFooterInstituteText", copyright: "siteCopyright"
  };
  var imageMap = { logoUrl: "siteLogoImage", heroImage: "siteHeroImage", aboutImage: "siteAboutImage", programmeImageOne: "siteProgrammeImageOne", programmeImageTwo: "siteProgrammeImageTwo", campusImageOne: "siteCampusImageOne", campusImageTwo: "siteCampusImageTwo", campusImageThree: "siteCampusImageThree" };
  function node(id) { return document.getElementById(id); }
  function safeUrl(value, allowMail) {
    if (!value) return "";
    value = String(value).trim();
    if (value.charAt(0) === "/" && value.slice(0, 2) !== "//" || value.charAt(0) === "#") return value;
    try { var parsed = new URL(value, window.location.href); if (parsed.protocol === "https:" || parsed.origin === window.location.origin || allowMail && (parsed.protocol === "mailto:" || parsed.protocol === "tel:")) return value; } catch (_) {}
    return "";
  }
  function setImage(id, value) {
    var image = node(id); if (!image) return;
    if (value && (safeUrl(value) || /^data:image\/(?:png|jpeg|webp|x-icon);base64,/.test(value))) { image.src = value; image.hidden = false; }
    else { image.removeAttribute("src"); image.hidden = true; }
  }
  function setText(content) {
    Object.keys(textMap).forEach(function (key) { var element = node(textMap[key]), value = content[key]; if (!element || typeof value !== "string" || !value.trim()) return; element.textContent = value; });
    Object.keys(imageMap).forEach(function (key) { setImage(imageMap[key], content[key]); });
    var brandMark = node("siteBrandMark"); if (brandMark) brandMark.hidden = !!(content.logoUrl && safeUrl(content.logoUrl));
    if (content.faviconUrl) { var favicon = node("siteFavicon"), iconUrl = safeUrl(content.faviconUrl); if (favicon && iconUrl) favicon.href = iconUrl; }
    ["admissionsEmail", "generalEmail"].forEach(function (key) { var link = node(key === "admissionsEmail" ? "siteAdmissionsEmailLink" : "siteGeneralEmailLink"), address = content[key]; if (link && typeof address === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) link.href = "mailto:" + address; });
    if (content.phone) { var phone = node("siteHeaderPhone"); if (phone) phone.href = "tel:" + content.phone.replace(/[^+\d]/g, ""); }
    if (content.mapUrl && safeUrl(content.mapUrl)) { var addressNode = node("siteAddress"); if (addressNode) { var a = document.createElement("a"); a.href = safeUrl(content.mapUrl); a.textContent = content.address || "View institute location"; a.rel = "noopener"; addressNode.replaceChildren(a); } }
    var seoTitle = String(content.seoTitle || content.siteName || "").trim(); if (seoTitle) document.title = seoTitle + " | IDMS";
    if (content.seoDescription) { var description = document.querySelector('meta[name="description"]'); if (description) description.content = content.seoDescription; }
  }
  function makeLink(label, href, className) { var a = document.createElement("a"); a.textContent = label; a.href = safeUrl(href) || "#"; if (className) a.className = className; return a; }
  function renderLinks(containerId, items, fallback) {
    var container = node(containerId); if (!container) return;
    var active = Array.isArray(items) ? items.filter(function (item) { return item && item.visible !== false && item.label && safeUrl(item.url); }) : [];
    if (!active.length) return;
    container.replaceChildren();
    active.forEach(function (item) { var a = makeLink(item.label, item.url); if (containerId === "siteSocialLinks") { a.target = "_blank"; a.rel = "noopener noreferrer"; } if (item.description) { var small = document.createElement("small"); small.textContent = item.description; a.append(small); } container.append(a); });
  }
  function renderNavigation(items) {
    var nav = node("mainNavigation"); if (!nav || !Array.isArray(items) || !items.length) return;
    var active = items.filter(function (item) { return item && item.visible !== false && item.label && safeUrl(item.url); });
    if (!active.length) return;
    nav.replaceChildren();
    active.forEach(function (item) {
      var children = [1, 2].filter(function (index) { return item["subLabel" + index] && safeUrl(item["subUrl" + index]); });
      if (!children.length) { nav.append(makeLink(item.label, item.url)); return; }
      var details = document.createElement("details"), summary = document.createElement("summary"); details.className = "nav-dropdown"; summary.textContent = item.label; details.append(summary);
      var menu = document.createElement("div"); menu.className = "nav-dropdown-menu"; menu.append(makeLink(item.label + " overview", item.url));
      children.forEach(function (index) { menu.append(makeLink(item["subLabel" + index], item["subUrl" + index])); });
      details.append(menu); nav.append(details);
    });
    var applicant = makeLink("Applicant Sign In", "/applicant-access.html", "login-button");
    var staff = makeLink("Staff / Student Login", "/login.html", "staff-login-link"); nav.append(applicant, staff);
  }
  function renderSlides(items) {
    var slides = Array.isArray(items) ? items.filter(function (slide) {
      if (!slide || slide.enabled === false || !slide.title) return false;
      var now = Date.now(), start = slide.startsAt ? Date.parse(slide.startsAt) : 0, end = slide.endsAt ? Date.parse(slide.endsAt) : Infinity;
      return (!start || start <= now) && (!end || end >= now);
    }) : [];
    var hero = node("home"); if (!hero) return;
    var title = node("siteHeroTitle"), description = node("siteHeroDescription"), eyebrow = node("siteHeroEyebrow"), primary = hero.querySelector(".hero-actions .primary-button"), secondary = node("siteHeroSecondaryLink"), status = node("heroSlideStatus"), background = node("siteHeroImage");
    var previous = node("heroPrevious"), next = node("heroNext"), pause = node("heroPause"), index = 0, timer = null, paused = false;
    if (!slides.length) { if (previous) previous.hidden = true; if (next) next.hidden = true; if (pause) pause.hidden = true; return; }
    function paint() {
      var slide = slides[index]; title.textContent = slide.title; description.textContent = slide.description || ""; eyebrow.textContent = "IDMS · INSTITUTIONAL UPDATE"; status.textContent = "" + (index + 1) + " / " + slides.length + " · " + slide.title;
      if (slide.imageUrl) setImage("siteHeroImage", slide.imageUrl); else if (background) background.hidden = true;
      if (primary) { primary.textContent = slide.buttonLabel || "Learn More"; primary.href = safeUrl(slide.buttonUrl) || "/applicant-access.html"; }
      if (secondary) secondary.hidden = false;
      hero.setAttribute("aria-label", "Announcement " + (index + 1) + " of " + slides.length + ": " + slide.title);
    }
    function stop() { if (timer) window.clearInterval(timer); timer = null; }
    function start() { stop(); if (!paused && slides.length > 1 && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) timer = window.setInterval(function () { index = (index + 1) % slides.length; paint(); }, 6500); }
    previous.hidden = next.hidden = slides.length < 2;
    previous.addEventListener("click", function () { index = (index - 1 + slides.length) % slides.length; paint(); start(); });
    next.addEventListener("click", function () { index = (index + 1) % slides.length; paint(); start(); });
    pause.hidden = slides.length < 2;
    pause.addEventListener("click", function () { paused = !paused; pause.textContent = paused ? "Resume rotation" : "Pause rotation"; pause.setAttribute("aria-pressed", String(paused)); if (paused) stop(); else start(); });
    hero.addEventListener("mouseenter", stop); hero.addEventListener("mouseleave", start); hero.addEventListener("focusin", stop); hero.addEventListener("focusout", start);
    paint(); start();
  }
  function renderNews(items, containerId, type) {
    var container = node(containerId); if (!container) return;
    container.replaceChildren();
    if (!items || !items.length) { var empty = document.createElement("p"); empty.className = "feed-state"; empty.textContent = type === "NEWS" ? "No news has been published yet." : "There are no current public notices."; container.append(empty); return; }
    items.forEach(function (item) {
      var article = document.createElement("article"); article.className = type === "NOTICE" ? "notice-card" : "site-feed-card";
      if (item.image_url && type === "NEWS") { var image = document.createElement("img"); image.src = safeUrl(item.image_url) || ""; image.alt = item.title || "IDMS news"; image.loading = "lazy"; if (!image.src) image.hidden = true; article.append(image); }
      var body = document.createElement("div"); body.className = "site-feed-card-content";
      var meta = document.createElement("small"), date = item.published_at || item.publish_at; meta.textContent = (item.category || (type === "NOTICE" ? "Official Notice" : "News")) + (date ? " · " + new Date(date).toLocaleDateString() : "");
      var title = document.createElement("h4"); title.textContent = item.title || "";
      var summary = document.createElement("p"); summary.textContent = item.summary || "";
      body.append(meta, title, summary);
      var url = safeUrl(item.link_url) || (type === "NEWS" ? "/news.html?slug=" + encodeURIComponent(item.slug || "") : "#announcements");
      if (item.attachment_url && type === "NOTICE") body.append(makeLink("Open attachment", item.attachment_url));
      if (url !== "#announcements") body.append(makeLink(type === "NEWS" ? "Read more" : "View notice", url));
      article.append(body); container.append(article);
    });
  }
  function renderProgrammes(items) {
    var host = node("siteProgrammeList"); if (!host) return;
    host.querySelectorAll("[data-live-programme]").forEach(function (item) { item.remove(); });
    programmeRows = Array.isArray(items) ? items : [];
    var filter = node("programmeFilter"), filterValue = filter ? filter.value : "ALL";
    var rows = programmeRows.filter(function (row) { var level = String(row.award_level || row.programme_type || "").toUpperCase(); return filterValue === "ALL" || level.includes(filterValue); });
    rows.forEach(function (item) {
      var card = document.createElement("article"); card.className = "programme-card"; card.dataset.liveProgramme = "true";
      var inner = document.createElement("div"); inner.className = "programme-content";
      var code = document.createElement("small"); code.textContent = item.programme_code || item.award_level || "PROGRAMME";
      var heading = document.createElement("h3"); heading.textContent = item.programme_name || "";
      var details = document.createElement("p"); details.textContent = item.description || item.specialization || item.direct_entry_requirements || "Contact IDMS Admissions for current programme information.";
      var meta = document.createElement("div"); meta.className = "programme-meta"; meta.textContent = [item.award_level, item.duration_years ? item.duration_years + " years" : "", item.mode_of_study, item.departments && item.departments.department_name].filter(Boolean).join(" · ");
      var requirements = document.createElement("p"); requirements.className = "programme-requirements"; requirements.textContent = item.direct_entry_requirements ? "Entry requirements: " + item.direct_entry_requirements : "";
      var apply = makeLink("Apply for this programme", "/applicant-access.html"); inner.append(code, heading, details, meta); if (requirements.textContent) inner.append(requirements); inner.append(apply); card.append(inner); host.prepend(card);
    });
    var placeholder = node("programmeEmpty");
    if (!rows.length) { if (!placeholder) { placeholder = document.createElement("p"); placeholder.id = "programmeEmpty"; placeholder.className = "feed-state"; host.prepend(placeholder); } placeholder.textContent = programmeRows.length ? "No active programmes match this qualification filter." : "Current programme information is not available. Contact Admissions for an approved programme list."; }
    else if (placeholder) placeholder.remove();
  }
  function renderStatistics(data, manual) {
    var section = node("statistics"), host = node("siteStatistics"); if (!section || !host) return;
    host.replaceChildren(); var values = [];
    if (data) values = [["Academic Programmes", data.programmes, "IDMS iMIS", data.updatedAt], ["Departments", data.departments, "IDMS iMIS", data.updatedAt], ["Campuses", data.campuses, "IDMS iMIS", data.updatedAt]];
    (Array.isArray(manual) ? manual : []).filter(function (item) { if (item.visible === false || !item.label || !item.value || !item.source) return false; if (!item.updatedAt) return false; var age = Date.now() - Date.parse(item.updatedAt); return Number.isFinite(age) && age >= 0 && age <= 365 * 86400000; }).forEach(function (item) { values.push([item.label, item.value, item.source, item.updatedAt]); });
    if (!values.length) { section.hidden = true; return; }
    section.hidden = false;
    values.forEach(function (item) { var card = document.createElement("article"); card.className = "stat-card"; var value = document.createElement("strong"); value.textContent = String(item[1]); var label = document.createElement("span"); label.textContent = item[0]; var source = document.createElement("small"); source.textContent = "Source: " + item[2] + (item[3] ? " · Updated " + new Date(item[3]).toLocaleDateString() : ""); card.append(value, label, source); host.append(card); });
    var note = node("siteStatisticsUpdated"); if (note) note.textContent = "Statistics include their source and last updated date.";
  }
  function renderMedia(items) {
    var section = node("media"), host = node("siteMediaList"), visible = Array.isArray(items) ? items.filter(function (item) { return item.visible !== false && item.title && safeUrl(item.mediaUrl); }) : [];
    if (!section || !host) return; host.replaceChildren(); section.hidden = !visible.length;
    visible.forEach(function (item) { var card = document.createElement("article"); card.className = "site-feed-card media-card"; if (item.coverUrl && safeUrl(item.coverUrl)) { var img = document.createElement("img"); img.src = item.coverUrl; img.alt = item.title; img.loading = "lazy"; card.append(img); } var content = document.createElement("div"); content.className = "site-feed-card-content"; var title = document.createElement("h4"); title.textContent = item.title; var description = document.createElement("p"); description.textContent = item.description || ""; var link = makeLink(item.mediaType === "VIDEO" ? "Watch video" : "Open resource", item.mediaUrl); link.target = "_blank"; link.rel = "noopener noreferrer"; content.append(title, description, link); card.append(content); host.append(card); });
  }
  function apply(content) {
    setText(content); renderNavigation(content.navigation); renderLinks("siteQuickLinks", content.quickLinks); renderLinks("siteResources", content.resources);
    renderLinks("siteFooterAbout", content.footerAbout); renderLinks("siteFooterAcademic", content.footerAcademic); renderLinks("siteFooterStudentServices", content.footerStudentServices); renderLinks("siteFooterQuickLinks", content.footerQuickLinks); renderLinks("siteSocialLinks", content.socialLinks);
    renderSlides(content.slides); renderMedia(content.media);
    currentContent = content;
    if (statisticsData) renderStatistics(statisticsData, currentContent.statistics);
    var copyright = node("siteCopyright"); if (copyright && content.copyright) { copyright.replaceChildren(document.createTextNode(content.copyright + " ")); var year = document.createElement("span"); year.textContent = String(new Date().getFullYear()); copyright.append(year); }
  }
  function getJson(url) { return fetch(url, { headers: { Accept: "application/json" }, cache: "no-store" }).then(function (response) { if (!response.ok) throw new Error("Unavailable"); return response.json(); }).then(function (payload) { return payload && payload.success ? payload.data : null; }); }
  function init() {
    if (!base) return;
    var programmeFilter = node("programmeFilter"); if (programmeFilter) programmeFilter.addEventListener("change", function () { renderProgrammes(programmeRows); });
    var contentUrl = base.replace(/\/+$/, "") + "/public/site-content";
    var preview = new URLSearchParams(window.location.search).get("websitePreview") === "1";
    var previewContent = null;
    if (preview) { try { previewContent = JSON.parse(localStorage.getItem("idmcWebsitePreviewDraft") || "null"); } catch (_) {} }
    var initial = previewContent ? Promise.resolve(previewContent) : getJson(contentUrl);
    initial.then(apply).catch(function () { renderSlides([]); });
    getJson(base.replace(/\/+$/, "") + "/public/site-items?type=NEWS").then(function (data) { renderNews(data || [], "siteNewsList", "NEWS"); }).catch(function () { renderNews([], "siteNewsList", "NEWS"); });
    getJson(base.replace(/\/+$/, "") + "/public/site-items?type=NOTICE").then(function (data) { renderNews(data || [], "siteNoticeList", "NOTICE"); }).catch(function () { renderNews([], "siteNoticeList", "NOTICE"); });
    getJson(base.replace(/\/+$/, "") + "/public/programmes").then(function (data) { renderProgrammes(data || []); }).catch(function () { renderProgrammes([]); });
    getJson(base.replace(/\/+$/, "") + "/public/statistics").then(function (data) { statisticsData = data; renderStatistics(data, currentContent.statistics); }).catch(function () { statisticsData = null; renderStatistics(null, currentContent.statistics); });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
