(function () {
  "use strict";
  var fields = [
    ["siteName","Official institute name","short"],["tagline","Tagline","short"],["address","Postal / physical address","short"],["phone","Public telephone","short"],["officeHours","Office hours","short"],["mapUrl","Map or location link","short"],
    ["heroEyebrow","Homepage label","short"],["heroTitle","Homepage heading","short"],["heroDescription","Homepage introduction","long"],
    ["announcementTitle","Announcement heading","short"],["announcementText","Announcement message","long"],
    ["aboutEyebrow","About label","short"],["aboutTitle","About heading","short"],["aboutTextOne","About paragraph 1","long"],["aboutTextTwo","About paragraph 2","long"],
    ["programmeEyebrow","Programmes label","short"],["programmeTitle","Programmes heading","short"],["programmeIntro","Programmes introduction","long"],
    ["campusTitle","Institute section heading","short"],["campusText","Institute section introduction","long"],
    ["campusNameOne","Institute information card 1 heading","short"],["campusTextOne","Institute information card 1 text","long"],["campusNameTwo","Institute information card 2 heading","short"],["campusTextTwo","Institute information card 2 text","long"],["campusNameThree","Institute information card 3 heading","short"],["campusTextThree","Institute information card 3 text","long"],
    ["admissionsTitle","Admissions heading","short"],["admissionsText","Admissions information","long"],["contactTitle","Contact heading","short"],["admissionsEmail","Admissions email","short"],["generalEmail","General enquiries email","short"],["portalTitle","Portal panel heading","short"],["footerInstituteName","Footer institute name","short"],["footerInstituteText","Footer introduction","long"],
    ["copyright","Copyright text","short"],["seoTitle","Search title","short"],["seoDescription","Search description","long"],["seoCanonicalUrl","Canonical URL","short"]
  ];
  var groups = [
    ["Identity, header and contact",[0,1,2,3,4,5,30,31]], ["Homepage and announcements",[6,7,8,9,10]], ["About IDMS",[11,12,13,14]],
    ["Academic and institute information",[15,16,17,18,19,20,21,22,23,24,25]], ["Admissions, portals and footer",[26,27,28,29,32,33,34]], ["Search settings",[35,36,37]]
  ];
  var images = [["logoUrl","Institute logo / crest"],["faviconUrl","Favicon"],["heroImage","Homepage fallback image"],["aboutImage","About section image"],["programmeImageOne","Programme 1 image (legacy card)"],["programmeImageTwo","Programme 2 image (legacy card)"],["campusImageOne","Institute card 1 image"],["campusImageTwo","Institute card 2 image"],["campusImageThree","Institute card 3 image"],["seoImage","Social sharing image"]];
  var collections = [
    ["navigation","Header navigation",[["label","Label"],["url","Route or link"],["subLabel1","Dropdown item 1"],["subUrl1","Dropdown link 1"],["subLabel2","Dropdown item 2"],["subUrl2","Dropdown link 2"],["visible","Visible"]]],
    ["slides","Hero slider",[["title","Slide title"],["description","Description"],["imageUrl","Image URL / upload"],["imageAlt","Image alt text"],["buttonLabel","Button label"],["buttonUrl","Button route / link"],["startsAt","Start date (ISO)"],["endsAt","End date (ISO)"],["enabled","Enabled"]]],
    ["quickLinks","Homepage quick links",[["label","Label"],["url","Route or secure URL"],["description","Description"],["icon","Icon / short label"],["group","Group"],["visible","Visible"]]],
    ["statistics","Manual statistics (include source and update date)",[["label","Statistic label"],["value","Value"],["source","Source"],["updatedAt","Updated date (YYYY-MM-DD)"],["visible","Visible"]]],
    ["resources","Useful resource links",[["label","Label"],["url","Route or secure URL"],["group","Category"],["visible","Visible"]]],
    ["media","Videos and media links",[["title","Title"],["description","Description"],["mediaUrl","HTTPS video / media link"],["coverUrl","Cover image URL / upload"],["mediaType","VIDEO or LINK"],["visible","Visible"]]],
    ["socialLinks","Social media",[["label","Platform"],["url","HTTPS URL"],["visible","Visible"]]],
    ["footerAbout","Footer: About IDMS",[["label","Label"],["url","Route or secure URL"],["visible","Visible"]]],
    ["footerAcademic","Footer: Academic",[["label","Label"],["url","Route or secure URL"],["visible","Visible"]]],
    ["footerStudentServices","Footer: Student Services",[["label","Label"],["url","Route or secure URL"],["visible","Visible"]]],
    ["footerQuickLinks","Footer: Quick Links",[["label","Label"],["url","Route or secure URL"],["visible","Visible"]]]
  ];
  var content = {}, publishedContent = {}, status = document.getElementById("contentStatus"), form = document.getElementById("contentForm"), itemForm = document.getElementById("siteItemForm"), editingId = "", api = window.IDMC_RBAC_API;
  function message(text, kind) { status.textContent = text; status.className = "notice" + (kind ? " " + kind : ""); }
  function inputControl(name, labelText, value, long, isBoolean, parent, imageField) {
    var label = document.createElement("label"); label.className = "field" + (long ? " wide" : ""); label.append(document.createTextNode(labelText));
    if (isBoolean) {
      label.classList.add("checkline"); var check = document.createElement("input"); check.type = "checkbox"; check.name = name; check.checked = value !== false; label.append(check); parent.append(label); return;
    }
    var control = long ? document.createElement("textarea") : document.createElement("input"); control.name = name; control.value = typeof value === "string" ? value : ""; control.maxLength = 1600;
    if (control.tagName === "INPUT") control.type = name.toLowerCase().includes("email") ? "email" : "text";
    label.append(control);
    if (imageField) {
      var picker = document.createElement("input"); picker.type = "file"; picker.accept = "image/png,image/jpeg,image/webp"; picker.setAttribute("aria-label", "Upload image for " + labelText);
      var hint = document.createElement("span"); hint.className = "file-hint"; hint.textContent = "PNG, JPEG or WebP · max 1 MB";
      picker.addEventListener("change", function () { var file = picker.files && picker.files[0]; if (!file) return; if (!["image/png","image/jpeg","image/webp"].includes(file.type) || file.size > 1000000) { picker.value = ""; message("Choose a PNG, JPEG or WebP image no larger than 1 MB.", "error"); return; } var reader = new FileReader(); reader.onload = function () { control.value = String(reader.result || ""); message("Image uploaded into the draft. Save draft to keep it."); }; reader.onerror = function () { message("The selected image could not be read.", "error"); }; reader.readAsDataURL(file); });
      label.append(picker, hint);
    }
    parent.append(label);
  }
  function addCollectionRow(host, definition, row) {
    var wrap = document.createElement("div"); wrap.className = "collection-row"; var grid = document.createElement("div"); grid.className = "field-grid";
    definition[2].forEach(function (field) { var key = field[0]; inputControl(key, field[1], row[key], ["description"].includes(key), key === "visible" || key === "enabled", grid, ["imageUrl","coverUrl"].includes(key)); });
    var remove = document.createElement("button"); remove.type = "button"; remove.className = "remove-row"; remove.textContent = "Remove"; remove.addEventListener("click", function () { wrap.remove(); });
    wrap.append(remove, grid); host.append(wrap);
  }
  function render() {
    var host = document.getElementById("contentFields");
    groups.forEach(function (group) { var section = document.createElement("fieldset"); section.className = "content-group"; var legend = document.createElement("legend"); legend.textContent = group[0]; section.append(legend); var grid = document.createElement("div"); grid.className = "field-grid"; group[1].forEach(function (index) { var item = fields[index]; inputControl(item[0], item[1], content[item[0]], item[2] === "long", false, grid); }); section.append(grid); host.append(section); });
    var imageSection = document.createElement("fieldset"); imageSection.className = "content-group"; var imageLegend = document.createElement("legend"); imageLegend.textContent = "Media Library · Homepage Images"; imageSection.append(imageLegend); var imageGrid = document.createElement("div"); imageGrid.className = "field-grid"; images.forEach(function (item) { inputControl(item[0], item[1], content[item[0]], false, false, imageGrid, true); }); imageSection.append(imageGrid); host.append(imageSection);
    var collectionHost = document.getElementById("collectionFields");
    collections.forEach(function (definition) { var section = document.createElement("fieldset"); section.className = "content-group"; var legend = document.createElement("legend"); legend.textContent = definition[1]; section.append(legend); var rows = document.createElement("div"); rows.dataset.collection = definition[0]; (Array.isArray(content[definition[0]]) ? content[definition[0]] : []).forEach(function (row) { addCollectionRow(rows, definition, row); }); var actions = document.createElement("div"); actions.className = "collection-actions"; var add = document.createElement("button"); add.type = "button"; add.className = "secondary-action"; add.textContent = "Add item"; add.addEventListener("click", function () { addCollectionRow(rows, definition, {}); }); actions.append(add); section.append(rows, actions); collectionHost.append(section); });
    form.hidden = false;
  }
  function collectContent() {
    fields.forEach(function (item) { var control = form.elements.namedItem(item[0]); if (control) content[item[0]] = control.value.trim(); });
    images.forEach(function (item) { var control = form.elements.namedItem(item[0]); if (control) content[item[0]] = control.value.trim(); });
    collections.forEach(function (definition) { var host = document.querySelector('[data-collection="' + definition[0] + '"]'); content[definition[0]] = Array.from(host.children).map(function (wrap) { var row = {}; definition[2].forEach(function (field) { var control = wrap.querySelector('[name="' + field[0] + '"]'); if (control) row[field[0]] = control.type === "checkbox" ? control.checked : control.value.trim(); }); return row; }); });
    return content;
  }
  function value(name) { var control = itemForm.elements.namedItem(name); if (!control) return ""; return control.type === "checkbox" ? control.checked : control.value.trim(); }
  function resetItem() { itemForm.reset(); itemForm.elements.namedItem("id").value = ""; editingId = ""; document.getElementById("saveSiteItem").textContent = "Save item"; itemForm.hidden = true; }
  function itemPayload() { return { itemType: value("itemType"), status: value("status"), slug: value("slug"), category: value("category"), title: value("title"), summary: value("summary"), body: value("body"), imageUrl: value("imageUrl"), attachmentUrl: value("attachmentUrl"), linkUrl: value("linkUrl"), featured: value("featured"), searchVisible: value("searchVisible") === "true", seoTitle: value("seoTitle"), seoDescription: value("seoDescription"), publishAt: value("publishAt") ? new Date(value("publishAt")).toISOString() : "", expireAt: value("expireAt") ? new Date(value("expireAt")).toISOString() : "" }; }
  async function loadItems() {
    var response = await api.request("/website/items"), rows = response.data || [], host = document.getElementById("siteItemsList"); host.replaceChildren();
    if (!rows.length) { var empty = document.createElement("p"); empty.className = "feed-state"; empty.textContent = "No pages, news or notices have been created yet."; host.append(empty); return; }
    rows.forEach(function (row) { var card = document.createElement("article"); card.className = "item-row"; var info = document.createElement("div"), heading = document.createElement("strong"), summary = document.createElement("p"); heading.textContent = "[" + row.item_type + "] " + row.title + " · " + row.status; summary.textContent = (row.category || "General") + (row.publish_at ? " · " + new Date(row.publish_at).toLocaleString() : "") + (row.item_type === "PAGE" && row.status === "PUBLISHED" ? " · /page.html?slug=" + row.slug : ""); info.append(heading, summary); var buttons = document.createElement("div"); buttons.className = "item-actions"; var edit = document.createElement("button"); edit.type = "button"; edit.className = "secondary-action"; edit.textContent = "Edit"; edit.addEventListener("click", function () { openItem(row); }); var archive = document.createElement("button"); archive.type = "button"; archive.className = "secondary-action danger-action"; archive.textContent = "Archive"; archive.disabled = row.status === "ARCHIVED"; archive.addEventListener("click", async function () { if (!window.confirm("Archive this item? It will be hidden from the public website while its history remains.")) return; try { await api.request("/website/items/" + encodeURIComponent(row.id), { method: "DELETE" }); await loadItems(); message("Item archived.", "success"); } catch (error) { message(error.message || "Could not archive item.", "error"); } }); buttons.append(edit, archive); card.append(info, buttons); host.append(card); });
  }
  function openItem(row) { resetItem(); itemForm.hidden = false; if (!row) return; editingId = row.id; itemForm.elements.namedItem("id").value = row.id; ["itemType","status","slug","title","summary","body","category","imageUrl","attachmentUrl","linkUrl","seoTitle","seoDescription"].forEach(function (key) { var map = { itemType: "item_type", imageUrl: "image_url", attachmentUrl: "attachment_url", linkUrl: "link_url", seoTitle: "seo_title", seoDescription: "seo_description" }; itemForm.elements.namedItem(key).value = row[map[key] || key] || ""; }); itemForm.elements.namedItem("searchVisible").value = String(row.search_visible !== false); itemForm.elements.namedItem("featured").checked = !!row.featured; ["publishAt","expireAt"].forEach(function (key) { var raw = key === "publishAt" ? row.publish_at : row.expire_at; itemForm.elements.namedItem(key).value = raw ? new Date(raw).toISOString().slice(0,16) : ""; }); document.getElementById("saveSiteItem").textContent = "Update item"; itemForm.scrollIntoView({ behavior: "smooth", block: "start" }); }
  async function init() {
    try {
      if (!await window.IDMCAuth.requireAuth()) return;
      var ready = await api.ensureRBACLoaded(); if (!ready || !api.hasPermission("website.content.manage")) { message("This page is for authorised website administrators.", "error"); return; }
      var response = await api.request("/website/content"); var row = response.data || {}; publishedContent = row.content || {}; content = row.draft_content || row.content || {};
      render(); document.getElementById("itemsSection").hidden = false; document.getElementById("revisionSection").hidden = false;
      await Promise.all([loadItems(), loadRevisions()]); message("Draft loaded. Public visitors see the published version until you publish changes.", "success");
    } catch (error) { message(error && error.message ? error.message : "Website content could not be loaded.", "error"); }
  }
  async function loadRevisions() { try { var response = await api.request("/website/revisions"), select = document.getElementById("revisionSelect"); select.replaceChildren(); (response.data || []).forEach(function (row) { var option = document.createElement("option"); option.value = row.id; option.textContent = new Date(row.changed_at).toLocaleString() + " · " + row.change_kind; select.append(option); }); } catch (_) {} }
  form.addEventListener("submit", async function (event) { event.preventDefault(); collectContent(); var button = document.getElementById("saveWebsiteContent"); button.disabled = true; try { await api.request("/website/content", { method: "PUT", body: JSON.stringify({ content: content }) }); message("Draft saved. It is not public until you publish it.", "success"); } catch (error) { message(error.message || "Website draft could not be saved.", "error"); } finally { button.disabled = false; } });
  document.getElementById("previewWebsiteContent").addEventListener("click", function () { collectContent(); try { localStorage.setItem("idmcWebsitePreviewDraft", JSON.stringify(content)); window.open("/index.html?websitePreview=1", "_blank", "noopener,noreferrer"); message("Draft preview opened in a new tab. This preview is visible only in this browser.", "success"); } catch (_) { message("The draft preview could not be opened.", "error"); } });
  document.getElementById("publishWebsiteContent").addEventListener("click", async function () { collectContent(); if (!window.confirm("Publish the saved website draft? Public visitors will see these changes.")) return; var button = document.getElementById("publishWebsiteContent"); button.disabled = true; try { await api.request("/website/content", { method: "PUT", body: JSON.stringify({ content: content }) }); await api.request("/website/content/publish", { method: "POST", body: "{}" }); publishedContent = content; await loadRevisions(); message("Homepage changes published.", "success"); } catch (error) { message(error.message || "The homepage draft could not be published.", "error"); } finally { button.disabled = false; } });
  document.getElementById("restoreRevision").addEventListener("click", async function () { var id = document.getElementById("revisionSelect").value; if (!id) return message("Choose a published version to restore.", "error"); if (!window.confirm("Restore this version to the draft editor? It will not publish until you confirm publication.")) return; try { await api.request("/website/revisions/" + encodeURIComponent(id) + "/restore", { method: "POST", body: "{}" }); window.location.reload(); } catch (error) { message(error.message || "The version could not be restored.", "error"); } });
  document.getElementById("newPageItem").addEventListener("click", function () { resetItem(); itemForm.hidden = false; itemForm.elements.namedItem("itemType").value = "PAGE"; itemForm.scrollIntoView({ behavior: "smooth" }); });
  document.getElementById("newNewsItem").addEventListener("click", function () { resetItem(); itemForm.hidden = false; itemForm.elements.namedItem("itemType").value = "NEWS"; itemForm.scrollIntoView({ behavior: "smooth" }); });
  document.getElementById("newNoticeItem").addEventListener("click", function () { resetItem(); itemForm.hidden = false; itemForm.elements.namedItem("itemType").value = "NOTICE"; itemForm.scrollIntoView({ behavior: "smooth" }); });
  document.getElementById("cancelSiteItem").addEventListener("click", resetItem);
  itemForm.addEventListener("submit", async function (event) { event.preventDefault(); var payload = itemPayload(); if (payload.status === "PUBLISHED" && !window.confirm("Publish this item to the public website now?")) return; var button = document.getElementById("saveSiteItem"); button.disabled = true; try { await api.request(editingId ? "/website/items/" + encodeURIComponent(editingId) : "/website/items", { method: editingId ? "PUT" : "POST", body: JSON.stringify(payload) }); resetItem(); await loadItems(); message("News or notice saved.", "success"); } catch (error) { message(error.message || "Content item could not be saved.", "error"); } finally { button.disabled = false; } });
  init();
})();
