import { eligibleOfferingCourses } from "./offering-selection.js?v=20261008-offering-hr";
import { runAcademicImport } from "./academic-import-runner.js?v=20261008-offering-hr";
import { csvFields, csvHeader, validateNamedRow, parseNamedCsv } from "./academic-named-csv.js?v=20261008-offering-hr";
import { createAcademicState } from "./academic-management-state.js";
import { SECTION_CONFIG, ACADEMIC_REGISTRY } from "./academic-management-config.js";
import { FORM_DEFINITIONS } from "./academic-management-forms.js?v=20261008-offering-hr";
import { fetchAllAcademicRecords, fetchAcademicPage } from "./academic-management-api.js";
import { renderAcademicTable } from "./academic-management-render.js";

(function () {
  "use strict";

  if (document.body.dataset.workspace !== "academics") return;

  var api = window.IDMCAPI;
  var auth = window.IDMCAuth;
  var state = createAcademicState();
  var sectionConfig = SECTION_CONFIG;
  var searchTimer = null, modalTrigger = null, serverRequestId = 0, bulkBusy = false, importBusy = false;

  function esc(value) {
    return String(value == null || value === "" ? "—" : value).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function unwrap(response) {
    var payload = response && Object.prototype.hasOwnProperty.call(response, "data") ? response.data : response;
    if (Array.isArray(payload)) return payload;
    if (payload && Array.isArray(payload.items)) return payload.items;
    return payload || {};
  }
  function human(value) {
    return String(value || "").replace(/_/g, " ").replace(/\b\w/g, function (x) { return x.toUpperCase(); });
  }
  function byId(key, id) {
    return (state.lookups[key] || []).find(function (row) { return row.id === id; }) || {};
  }
  function courseLabel(row) { return [row.course_code, row.course_name].filter(Boolean).join(" - ") || row.id; }
  function programmeLabel(row) { return [row.programme_code, row.programme_name].filter(Boolean).join(" - ") || row.id; }
  function versionLabel(row) {
    var programme = byId("programmes", row.programme_id);
    return [programme.programme_code, row.version_code, row.version_name].filter(Boolean).join(" · ") || row.id;
  }
  function curriculumLabel(row) { return [row.curriculum_code, row.curriculum_name].filter(Boolean).join(" - ") || row.id; }
  function yearLabel(row) { return row.year_name || row.year_code || row.id; }
  function semesterLabel(row) { return row.semester_name || row.semester_code || row.id; }
  function labelFor(key, row) {
    var labels = { years: yearLabel, semesters: semesterLabel, programmes: programmeLabel, versions: versionLabel, courses: courseLabel, curricula: curriculumLabel };
    return labels[key] ? labels[key](row) : (row.department_name || row.school_name || row.name || row.id);
  }

  var offeringFilters={level:'',academicYearId:'',semesterId:'',yearNumber:''};
  var forms = FORM_DEFINITIONS;

  var registry = ACADEMIC_REGISTRY;

  function installUi() {
    var host = document.getElementById("amxPanelHost");
    if (!host || document.getElementById("amxPanel")) return;
    var panel = document.createElement("section");
    panel.id = "amxPanel";
    panel.className = "amx-panel";
    panel.innerHTML = '<header class="amx-head"><div><span class="eyebrow">Academic workspace</span><h2 id="amxSectionTitle">Course Master</h2><p id="amxSectionHelp">Maintain the academic records used across IDMS.</p></div><button class="amx-btn primary" id="amxReload" type="button">Refresh</button></header>' +
      '<p class="amx-note" id="amxNote" role="status">Loading academic structure…</p>' +
      '<nav class="amx-course-views" id="amxCourseViews" aria-label="Department filters"><button type="button" data-course-view="all" aria-pressed="false">All</button><button type="button" data-course-view="social" aria-pressed="false">Social</button><button type="button" data-course-view="project" aria-pressed="false">Project</button><button type="button" data-course-view="cross" aria-pressed="false">Cross-cutting</button></nav>' +
      '<div class="amx-section-head"><div><h3 id="amxSectionSubhead">Records</h3><p id="amxSectionDescription">Create and maintain academic records.</p></div><div class="amx-buttons" id="amxButtons"></div></div>' +
      '<div class="amx-toolbar"><label>Search<input id="amxSearch" type="search" placeholder="Code, programme or name" autocomplete="off"></label><button class="amx-btn" id="amxExport" type="button">Download CSV</button></div><div class="amx-selection"><span id="amxSelectionCount">0 selected</span><button class="amx-btn" id="amxBulkUnuse" type="button">Unuse selected</button><button class="amx-btn amx-danger" id="amxBulkDelete" type="button">Delete selected</button><button class="amx-btn" id="amxBulkArchive" type="button">Archive selected</button></div>' +
      '<div id="amxOfferingFilters" class="amx-toolbar" hidden><label>Level<select data-offering-filter="level"><option value="">All levels</option><option>4</option><option>5</option><option>6</option></select></label><label>Academic year<select data-offering-filter="academicYearId"></select></label><label>Semester<select data-offering-filter="semesterId"></select></label><label>Study year<input type="number" min="1" step="1" data-offering-filter="yearNumber" placeholder="All"></label></div><div id="amxUsagePreview" class="amx-usage" hidden></div><div class="amx-table-wrap"><table class="amx-table" id="amxTable"></table><template id="amxRowTemplate"><tr></tr></template></div><div id="amxPager" class="amx-pager"></div>' +
      '<details class="amx-secondary"><summary>Import records from CSV</summary><div class="amx-import"><label><span>Import Section</span><select id="amxImportType"></select></label><label><span>CSV file</span><input id="amxImportFile" type="file" accept=".csv,text/csv"></label><button class="amx-btn" id="amxTemplate" type="button">Download Template</button><button class="amx-btn" id="amxValidate" type="button">Validate & Preview</button><button class="amx-btn primary" id="amxConfirmImport" type="button" disabled>Confirm Import</button><p class="amx-import-status" id="amxImportStatus">Templates use names/codes, not database IDs. Save as CSV UTF-8. Course Master auto-maps when programme/curriculum is unique; enter study year and semester.</p><div class="amx-preview" id="amxPreview" hidden></div></div></details>' +
      '<details class="amx-secondary"><summary>How the workflow works</summary><p>Course Master defines the course. Curriculum Mapping assigns approved credits, study year and semester to a programme curriculum. Course Offering opens the course in an academic period. Course Registration links an eligible student to that offering. Cross-cutting can share one course across target curricula with different credits. Existing registrations keep their saved credits.</p></details>';
    host.appendChild(panel);
    panel.querySelectorAll('[data-offering-filter]').forEach(function(input){input.onchange=function(){offeringFilters[this.dataset.offeringFilter]=this.value;if(this.dataset.offeringFilter==='academicYearId')offeringFilters.semesterId='';state.page=1;renderRegistry();};});
    document.body.insertAdjacentHTML("beforeend", '<div class="amx-modal" id="amxModal" role="dialog" aria-modal="true" aria-labelledby="amxTitle"><section class="amx-dialog"><header class="amx-dialog-head"><h3 id="amxTitle">New Academic Record</h3><button class="amx-btn" id="amxClose" type="button">Close</button></header><form class="amx-form" id="amxForm"><div class="amx-form-message wide" id="amxFormMessage" role="alert"></div></form></section></div>');
    panel.addEventListener("click", function (event) {
      var button = event.target.closest("button"); if (!button) return;
      if (button.matches("[data-amx-form]")) { openForm(button.dataset.amxForm, null, button); return; }
      if (button.id === "amxReload") { load().then(function(){document.dispatchEvent(new Event("academic:refresh-requirements"));}); return; }
      if (button.id === "amxExport") { exportVisible(); return; }
      if (button.id === "amxBulkUnuse") { bulkAction("UNUSE"); return; }
      if (button.matches("[data-force-job]")) { retryCourseDelete(button.dataset.forceJob); return; }
      if (button.matches("[data-force-course-delete]")) { bulkAction("FORCE_DELETE"); return; }
      if (button.id === "amxBulkDelete") { bulkAction("DELETE"); return; }
      if (button.id === "amxBulkArchive") { bulkAction("ARCHIVE"); return; }
      if (button.matches("[data-edit]")) { openForm(registry[state.active].form, byId(state.active, button.dataset.edit), button); return; }
      if (button.matches("[data-amx-delete]")) { state.selected = new Set([button.dataset.amxDelete]); bulkAction("DELETE"); return; }
      if (button.id === "amxPrev" || button.id === "amxNext") { state.page += button.id === "amxPrev" ? -1 : 1; syncUrl(true); renderRegistry(); return; }
    });
    panel.addEventListener("change", function(event){var input=event.target;if(input.matches("[data-select-course]")){if(input.checked)state.selected.add(input.dataset.selectCourse);else state.selected.delete(input.dataset.selectCourse);selectionStatus();}else if(input.id==="amxSelectPage"){state.visibleRows.forEach(function(row){if(input.checked)state.selected.add(row.id);else state.selected.delete(row.id);});renderRegistry();}});
    document.getElementById("amxImportType").innerHTML = Object.keys(registry).map(function (key) { return '<option value="' + key + '">' + registry[key].label + '</option>'; }).join("");
    document.getElementById("amxImportType").onchange=function(){state.importValid=false;state.importRows=[];document.getElementById("amxConfirmImport").disabled=true;};
    document.getElementById("amxImportFile").onchange=function(){state.importValid=false;state.importRows=[];document.getElementById("amxConfirmImport").disabled=true;document.getElementById("amxPreview").hidden=true;};
    document.getElementById("amxTemplate").onclick = downloadTemplate;
    document.getElementById("amxValidate").onclick = validateImport;
    document.getElementById("amxConfirmImport").onclick = confirmImport;
    document.getElementById("amxClose").onclick = closeForm;
    document.getElementById("amxModal").onclick = function (event) { if (event.target === this) closeForm(); };
    document.getElementById("amxForm").onsubmit = submitForm;
    document.getElementById("academicSidebar").addEventListener("click", function(event){var sectionButton=event.target.closest("[data-amx-stage]");if(!sectionButton)return;setState({active:sectionButton.dataset.amxStage,page:1,selected:new Set()},true);closeSidebar();});
    document.getElementById("amxCourseViews").addEventListener("click", function(event){var filter=event.target.closest("[data-course-view]");if(!filter)return;setState({courseView:filter.dataset.courseView,page:1,selected:new Set()},true);});
    document.getElementById("amxSearch").addEventListener("input", function(){state.search=this.value.trim();state.page=1;state.selected.clear();clearTimeout(searchTimer);searchTimer=setTimeout(function(){syncUrl(true);renderRegistry();},300);});
    document.getElementById("logoutButton").onclick=function(){auth.logout();};
    var toggle=document.getElementById('academicSidebarToggle'),backdrop=document.getElementById('academicSidebarBackdrop');
    if(toggle)toggle.onclick=function(){var open=document.body.classList.toggle('academics-nav-open');toggle.setAttribute('aria-expanded',String(open));toggle.setAttribute('aria-label',open?'Close academic navigation':'Open academic navigation');if(open){var first=document.querySelector('#academicSidebar button[data-amx-stage]');if(first)first.focus();}};
    if(backdrop)backdrop.onclick=closeSidebar;
    document.addEventListener('keydown',function(e){if(e.key==='Escape'&&document.body.classList.contains('academics-nav-open')){closeSidebar();if(toggle)toggle.focus();}if(e.key==='Tab'&&document.body.classList.contains('academics-nav-open')){var drawer=document.getElementById('academicSidebar'),nodes=Array.from(drawer.querySelectorAll('button:not([disabled]),a[href],summary')).filter(function(n){return n.offsetParent!==null;});if(!nodes.length)return;var first=nodes[0],last=nodes[nodes.length-1];if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}}});
    document.querySelectorAll('.iw-academic-sidebar a').forEach(function(a){a.addEventListener('click',closeSidebar);});
    readUrl();
    syncUrl(false);
    renderRegistry();
    window.addEventListener("popstate", function(){readUrl();renderRegistry();});
  }
  function readUrl(){var params=new URLSearchParams(location.search),section=params.get("section")||params.get("resource")||"courses",department=params.get("dept")||params.get("department")||"all";state.active=registry[section]?section:"courses";state.courseView=["all","social","project","cross"].includes(department)?department:"all";state.search=params.get("q")||"";state.page=Math.max(1,parseInt(params.get("page")||"1",10)||1);}
  function syncUrl(push){var params=new URLSearchParams(location.search);params.set("section",state.active);params.set("dept",state.courseView);if(state.search)params.set("q",state.search);else params.delete("q");if(state.page>1)params.set("page",String(state.page));else params.delete("page");params.delete("resource");params.delete("department");var url=location.pathname+"?"+params.toString()+location.hash;history[push?"pushState":"replaceState"]({section:state.active},"",url);}
  function setState(next,push){Object.assign(state,next);syncUrl(!!push);renderRegistry();}
  function closeSidebar(){document.body.classList.remove('academics-nav-open');var toggle=document.getElementById('academicSidebarToggle');if(toggle){toggle.setAttribute('aria-expanded','false');toggle.setAttribute('aria-label','Open academic navigation');}}

  function canManage() { return ((state.user || {}).permissions || []).includes("academics.manage"); }
  async function load() {
    var note=document.getElementById("amxNote");state.ready=false;state.serverQueryKey="";state.serverRequestKey="";state.serverRows=[];state.serverTotal=0;serverRequestId+=1;
    if(note){note.classList.remove("error");note.textContent="Loading academic records…";}
    try {
      var keys=Object.keys(registry);
      var responses=await Promise.all(keys.map(function(k){return fetchAllAcademicRecords(api,registry[k].endpoint);}).concat([api.get("/academic-core/workspace/context",{cache:"no-store"})]));
      keys.forEach(function(k,i){state.lookups[k]=responses[i];});
      var context=unwrap(responses[keys.length]);state.lookups.institution=context.institution;state.lookups.departments=context.departments||[];state.lookups.schools=context.schools||[];
      state.ready=true;state.selected.clear();renderRegistry();
      document.querySelectorAll("[data-amx-form]").forEach(function(b){b.hidden=!canManage();b.disabled=!state.ready;});
      if(note)note.textContent="Course Master feeds department and programme setup. CSV uses names/codes. Programme credits and CORE/ELECTIVE belong to Curriculum Mapping; saved student credits are preserved.";
    }catch(error){
      var message=error.message||"Academic setup failed to load.";
      if(note){note.classList.add('error');note.textContent=/Route not found|404/i.test(message)?'Academic setup is temporarily unavailable. Refresh this page and try again. If the issue continues, contact your system administrator.':(window.IDMCAPI?.toUserMessage ? window.IDMCAPI.toUserMessage(error) : message);}
      renderRegistry();
    }
  }
  function departmentFor(key,row) {
    if(key==="courses"||key==="programmes")return byId("departments",row.department_id);
    if(key==="versions")return departmentFor("programmes",byId("programmes",row.programme_id));
    if(key==="curricula")return departmentFor("versions",byId("versions",row.programme_version_id));
    if(key==="curriculumCourses")return departmentFor("curricula",byId("curricula",row.curriculum_id));
    if(key==="offerings")return departmentFor("programmes",byId("programmes",row.programme_id));
    if(key==="prerequisites")return departmentFor("courses",byId("courses",row.course_id));
    return {};
  }
  function inSection(key,row) {
    if(state.courseView==="all" || ["years","semesters"].includes(key))return true;
    if(state.courseView==="cross") {
      if(key==="courses")return row.cross_cutting===true;
      if(row.course_id)return byId("courses",row.course_id).cross_cutting===true;
      if(key==="curricula"||key==="versions"||key==="programmes")return (state.lookups.curriculumCourses||[]).some(function(m){
        var curriculum=byId("curricula",m.curriculum_id),version=byId("versions",curriculum.programme_version_id);
        return byId("courses",m.course_id).cross_cutting===true && (key==="curricula"?row.id===curriculum.id:key==="versions"?row.id===version.id:row.id===version.programme_id);
      });
      return false;
    }
    return departmentFor(key,row).academic_group===(state.courseView==="social"?"SOCIAL":"PROJECT");
  }
  function offeringMatches(row){
    if(offeringFilters.level&&String(byId('courses',row.course_id).level)!==offeringFilters.level)return false;
    if(offeringFilters.academicYearId&&row.academic_year_id!==offeringFilters.academicYearId)return false;
    if(offeringFilters.semesterId&&row.semester_id!==offeringFilters.semesterId)return false;
    if(offeringFilters.yearNumber){var semester=byId('semesters',row.semester_id),curricula=new Set((state.lookups.curricula||[]).filter(c=>c.programme_version_id===row.programme_version_id).map(c=>c.id));if(!(state.lookups.curriculumCourses||[]).some(m=>curricula.has(m.curriculum_id)&&m.course_id===row.course_id&&Number(m.year_number)===Number(offeringFilters.yearNumber)&&Number(m.semester_number)===Number(semester.semester_number)))return false;}return true;
  }
  function filteredRows() {
    return (state.lookups[state.active]||[]).filter(function(row){return inSection(state.active,row) && (state.active!=='offerings'||offeringMatches(row)) && (!state.search || JSON.stringify(row).toLowerCase().includes(state.search.toLowerCase()) || registry[state.active].columns.some(function(col){return display(row[col[1]],col[2]).toLowerCase().includes(state.search.toLowerCase());}));});
  }
  async function loadServerPage(key) {
    if(state.serverRequestKey===key)return;
    state.serverRequestKey=key;var requestId=++serverRequestId;
    try {
      var result=await fetchAcademicPage(api,registry[state.active].endpoint,state.page,state.search,25);
      if(requestId!==serverRequestId||key!==state.active+"|"+state.page+"|"+state.search+"|"+state.courseView)return;
      state.serverRows=result.rows;state.serverTotal=result.total;state.serverQueryKey=key;
      var pages=Math.max(1,Math.ceil(state.serverTotal/25));if(state.page>pages){state.page=pages;syncUrl(false);state.serverQueryKey="";}
      renderRegistry();
    } catch(error) {
      if(requestId!==serverRequestId||key!==state.active+"|"+state.page+"|"+state.search+"|"+state.courseView)return;
      state.serverRows=[];state.serverTotal=0;state.serverQueryKey=key;var note=document.getElementById("amxNote");if(note){note.classList.add("error");note.textContent=error.message||"Could not load this page of records.";}renderRegistry();
    } finally {if(requestId===serverRequestId&&state.serverRequestKey===key)state.serverRequestKey="";}
  }
  function renderRegistry() {
    var table=document.getElementById("amxTable");if(!table)return;
    var offeringPanel=document.getElementById('amxOfferingFilters');offeringPanel.hidden=state.active!=='offerings';['academicYearId','semesterId'].forEach(function(k){var input=offeringPanel.querySelector('[data-offering-filter="'+k+'"]'),source=k==='academicYearId'?'years':'semesters';input.innerHTML='<option value="">All '+source+'</option>'+(state.lookups[source]||[]).filter(r=>source!=='semesters'||!offeringFilters.academicYearId||r.academic_year_id===offeringFilters.academicYearId).map(r=>'<option value="'+esc(r.id)+'">'+esc(labelFor(source,r))+'</option>').join('');input.value=offeringFilters[k];});
    document.getElementById('amxSectionTitle').textContent=registry[state.active].label;
    var help={courses:'Create the course identity and owning department.',curriculumCourses:'Map courses to an active curriculum with approved credits and semester.',offerings:'Open a mapped course in the selected year and semester.'};
    document.getElementById('amxSectionHelp').textContent=help[state.active]||'Maintain authoritative '+registry[state.active].label.toLowerCase()+'.';
    document.querySelectorAll('[data-amx-stage]').forEach(function(b){var active=b.dataset.amxStage===state.active;b.classList.toggle('active',active);if(active)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');});
    var actionForms=sectionConfig[state.active].actions;
    document.getElementById('amxButtons').innerHTML=canManage()?actionForms.map(function(code){return '<button class="amx-btn '+(code===actionForms[0]?'primary':'')+'" type="button" data-amx-form="'+code+'" '+(state.ready?'':'disabled')+'>'+esc(forms[code].title)+'</button>';}).join(''):'';
    document.querySelectorAll('#amxButtons [data-amx-form]').forEach(function(b){b.hidden=!canManage();b.disabled=!state.ready;});
    document.getElementById('amxExport').disabled=!state.ready;
    document.getElementById("amxCourseViews").hidden=["years","semesters"].includes(state.active);
    document.querySelectorAll("[data-course-view]").forEach(function(b){var active=b.dataset.courseView===state.courseView;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));});
    var search=document.getElementById("amxSearch");if(search&&search.value!==state.search)search.value=state.search;
    var def=registry[state.active],serverMode=state.courseView==="all" && !(state.active==="offerings"&&Object.values(offeringFilters).some(Boolean)),queryKey=state.active+"|"+state.page+"|"+state.search+"|"+state.courseView,all=serverMode?[]:filteredRows(),total=all.length,pages,rows;
    if(serverMode){total=state.serverQueryKey===queryKey?state.serverTotal:0;pages=Math.max(1,Math.ceil(total/25));rows=state.serverQueryKey===queryKey?state.serverRows:[];if(state.serverQueryKey!==queryKey){var note=document.getElementById("amxNote");if(note&&!note.classList.contains("error"))note.textContent="Loading page of records…";loadServerPage(queryKey);}}
    else{pages=Math.max(1,Math.ceil(all.length/25));state.page=Math.min(state.page,pages);rows=all.slice((state.page-1)*25,state.page*25);}
    if(state.serverQueryKey===queryKey&&serverMode){var pageCount=Math.max(1,Math.ceil(total/25));pages=pageCount;}
    state.visibleRows=rows;
    var selectable=state.active==='courses'&&canManage()&&state.ready;
    renderAcademicTable(table,document.getElementById("amxRowTemplate"),{rows:rows,columns:def.columns,selectable:selectable,state:state,section:state.active,canManage:canManage,departmentFor:departmentFor,appendCellValue:appendCellValue,emptyMessage:state.serverQueryKey!==queryKey&&serverMode?"Loading records…":state.ready?"No matching records. Assign unclassified departments or add records.":"Academic records have not loaded. Check the connection message above, then Refresh."});
    document.getElementById('amxPager').innerHTML='<button type="button" id="amxPrev" '+(state.page===1?'disabled':'')+'>Previous</button><span>'+total+' records · page '+state.page+'/'+pages+'</span><button type="button" id="amxNext" '+(state.page===pages?'disabled':'')+'>Next</button>';
    selectionStatus();
  }
  function selectionStatus(){document.querySelector('.amx-selection').hidden=state.active!=='courses'||!canManage();document.getElementById('amxSelectionCount').textContent=state.selected.size+' selected';['amxBulkDelete','amxBulkArchive','amxBulkUnuse'].forEach(function(id){var b=document.getElementById(id);b.hidden=state.active!=='courses'||!canManage();b.disabled=bulkBusy||!state.ready||!state.selected.size||state.selected.size>100;});}
  async function bulkAction(action) {
    if(bulkBusy)return;
    var ids=Array.from(state.selected),box=document.getElementById('amxUsagePreview');if(!ids.length)return;
    bulkBusy=true;selectionStatus();box.hidden=false;box.textContent='Checking usage for '+ids.length+' selected courses…';
    try {
      if(action==='FORCE_DELETE'){await forceDeleteCourses(ids,box);return;}
      var usage=unwrap(await api.post('/academic-core/workspace/courses/preview',{ids:ids}));
      box.innerHTML='<h4>Selected Course Usage</h4>'+usage.map(function(r){return '<p><strong>'+esc(r.code)+'</strong> '+esc(r.name)+' — '+(r.canDelete?'Unused; can delete':esc(Object.entries(r.references).map(function(x){return x[0]+': '+x[1];}).join(', ')))+(r.canUnuse?' · Empty setup links can be removed.':' · Protected: '+esc(Object.entries(r.blockers).map(function(x){return x[0]+': '+x[1];}).join(', ')))+'</p>';}).join('');
      if(action==='DELETE'&&usage.some(function(r){return !r.canDelete;})){
        if(usage.some(function(r){return !r.canUnuse;})){await forceDeleteCourses(ids,box);return;}
        action='UNUSE_DELETE';
      }
      if(action==='UNUSE'&&usage.some(function(r){return !r.canUnuse;})){box.insertAdjacentHTML('beforeend','<p>Unuse removes empty setup only. Delete including usage removes the selected courses and their dependent academic records after preview and backup.</p><button type="button" class="amx-btn amx-danger" data-force-course-delete>Delete including usage</button>');return;}
      var phrase=action+' SELECTED COURSES',detail=action==='UNUSE_DELETE'?'Remove empty offerings and curriculum links, then delete courses. ':action==='UNUSE'?'Remove empty offerings and curriculum links; keep the course records. ':'';
      if(window.prompt(detail+usage.length+' courses. Type '+phrase+' to confirm.')!==phrase)return;
      box.insertAdjacentHTML('beforeend','<p role="status">Applying '+esc(action)+' to '+ids.length+' courses in one transaction…</p>');
      var result=unwrap(await api.post('/academic-core/workspace/courses/action',{ids:ids,action:action,confirmation:phrase}));
      box.textContent='Committed '+result.affected+' courses. Refreshing records…';
      api.clearCache();await load();box.hidden=false;box.textContent=result.affected+' courses processed. '+(result.offeringsRemoved||0)+' empty offerings and '+(result.mappingsRemoved||0)+' curriculum links removed. Audit recorded.';
    }catch(error){box.hidden=false;box.textContent=error.message||'Course action failed. Refresh and verify before retrying.';if(error.forceJobId)box.insertAdjacentHTML('beforeend','<p><button type="button" class="amx-btn" data-force-job="'+esc(error.forceJobId)+'">Check status / retry confirmed deletion</button></p>');}
    finally{bulkBusy=false;selectionStatus();}
  }
  async function forceDeleteCourses(ids,box) {
    var stage=document.createElement('p');stage.setAttribute('role','status');stage.textContent='Preparing complete dependency preview and backup for '+ids.length+' selected courses…';box.appendChild(stage);
    var job=unwrap(await api.post('/academic-core/workspace/courses/force-preview',{ids:ids},{timeoutMs:120000}));
    var list=job.counts.map(function(row){var action={DELETE:'Delete',REFRESH_CREDITS:'Refresh credits',REVOKE_TRANSCRIPT:'Revoke transcript',INVALIDATE_IMPORT:'Invalidate import',INVALIDATE_HISTORY:'Invalidate historical import'}[row.operation]||row.operation;return action+' '+row.table+': '+row.count;});
    box.innerHTML='<h4>Delete selected courses including usage</h4><p>'+job.courses.length+' selected courses. Backup prepared: '+esc(job.jobId)+'.</p>'+job.courses.map(function(c){return '<p><strong>'+esc(c.code)+'</strong> '+esc(c.name)+'</p>';}).join('')+'<h4>Records affected</h4>'+list.map(function(line){return '<p>'+esc(line)+'</p>';}).join('')+'<p>Student accounts and programmes remain. Affected GPA summaries must be regenerated; affected transcripts are revoked. Only ADMIN/SUPER_ADMIN accounts with academic management permission can continue.</p>';
    var phrase='FORCE DELETE SELECTED COURSES';
    if(window.prompt('Delete '+job.courses.length+' courses INCLUDING the records shown?\n'+list.join('\n')+'\nType '+phrase+' to confirm.')!==phrase){box.insertAdjacentHTML('beforeend','<p>Deletion cancelled. Nothing deleted.</p>');return;}
    box.insertAdjacentHTML('beforeend','<p role="status">Deleting the reviewed records in one transaction. Waiting for commit…</p>');
    // Keep the preview ID so a timed-out request can be retried idempotently.
    var result;
    try { result=unwrap(await api.post('/academic-core/workspace/courses/force-delete',{jobId:job.jobId,confirmation:phrase},{timeoutMs:120000})); }
    catch(error){error.forceJobId=job.jobId;error.message=(error.message||'Deletion response unavailable.')+' Backup job: '+job.jobId;throw error;}
    var removed=result.affected;box.insertAdjacentHTML('beforeend','<p role="status">Deleted '+removed+' courses. Refreshing Course Master…</p>');
    api.clearCache();await load();
    box.hidden=false;box.innerHTML='<h4>Deleted '+removed+' selected courses</h4><p>Backup job: '+esc(result.backupJob)+'. Records refreshed.</p>'+list.map(function(line){return '<p>'+esc(line)+'</p>';}).join('');
  }
  async function retryCourseDelete(jobId) {
    if(bulkBusy)return;bulkBusy=true;selectionStatus();var box=document.getElementById('amxUsagePreview');
    try {
      box.textContent='Checking deletion status…';
      var status=unwrap(await api.get('/academic-core/workspace/courses/force-status/'+encodeURIComponent(jobId),{cache:'no-store',timeoutMs:120000}));
      var result=status.result;
      if(status.state!=='DONE'){box.textContent='Retrying the previously confirmed deletion with the same backup job…';result=unwrap(await api.post('/academic-core/workspace/courses/force-delete',{jobId:jobId,confirmation:'FORCE DELETE SELECTED COURSES'},{timeoutMs:120000}));}
      api.clearCache();await load();box.hidden=false;box.textContent=result.affected+' courses deleted. Backup job: '+jobId;
    }catch(error){box.textContent=error.message||'Could not check deletion status.';box.insertAdjacentHTML('beforeend','<p><button type="button" class="amx-btn" data-force-job="'+esc(jobId)+'">Check status / retry confirmed deletion</button></p>');}
    finally{bulkBusy=false;selectionStatus();}
  }
  function exportOfferings(){var fields=importFields('offerings'),data=filteredRows().map(function(row){var raw={};fields.forEach(function(field){var name=field[0],db=name.replace(/[A-Z]/g,c=>'_'+c.toLowerCase()),value=row[db];if(name==='level')value=byId('courses',row.course_id).level;if(name==='yearNumber'){var curricula=new Set((state.lookups.curricula||[]).filter(c=>c.programme_version_id===row.programme_version_id).map(c=>c.id)),semester=byId('semesters',row.semester_id),years=Array.from(new Set((state.lookups.curriculumCourses||[]).filter(m=>curricula.has(m.curriculum_id)&&m.course_id===row.course_id&&Number(m.semester_number)===Number(semester.semester_number)).map(m=>m.year_number)));value=years.length===1?years[0]:offeringFilters.yearNumber;}
 if(field[2]==='select'){var source=byId(field[3],value);value=source[field[3]==='years'?'year_code':field[3]==='semesters'?'semester_code':field[3]==='programmes'?'programme_code':field[3]==='versions'?'version_code':'course_code']||source[field[3]==='years'?'year_name':field[3]==='semesters'?'semester_name':field[3]==='programmes'?'programme_name':field[3]==='versions'?'version_name':'course_name']||'';}raw[csvHeader(field)]=value??'';});return fields.map(f=>raw[csvHeader(f)]);});var csv=[fields.map(csvHeader)].concat(data).map(row=>row.map(v=>csvEscape(/^[=+@]/.test(String(v))?"'"+v:v)).join(',')).join('\r\n'),a=document.createElement('a');a.href=URL.createObjectURL(new Blob(['\ufeff'+csv],{type:'text/csv;charset=utf-8'}));a.download='IDMS-offerings-names.csv';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),500);}
  function exportVisible(){if(state.active==='offerings'){exportOfferings();return;}var def=registry[state.active],rows=filteredRows(),columns=def.columns.slice();if(state.active==='courses'||state.active==='programmes')columns.push(['Department Name','department_id','department']);var csv=[columns.map(function(c){return c[0];})].concat(rows.map(function(r){return columns.map(function(c){return c[2]==='department'?(byId('departments',r[c[1]]).department_name||''):String(display(r[c[1]],c[2])).replace(/<[^>]+>/g,'').replace(/&amp;/g,'&');});})).map(function(r){return r.map(function(v){var text=String(v||'');if(/^[=+@-]/.test(text))text="'"+text;return csvEscape(text);}).join(',');}).join('\r\n');var a=document.createElement('a');a.href=URL.createObjectURL(new Blob(['\ufeff'+csv],{type:'text/csv;charset=utf-8'}));a.download='IDMS-'+state.active+'-'+state.courseView+'.csv';a.click();setTimeout(function(){URL.revokeObjectURL(a.href);},500);}

  function display(value, mode) {
    if (mode === "badge") return '<span class="amx-badge">' + esc(human(value)) + "</span>";
    if (mode === "yesno") return value ? "Yes" : "No";
    if (mode === "course") return esc(courseLabel(byId("courses", value)) || value);
    if (mode === "programme") return esc(programmeLabel(byId("programmes", value)) || value);
    if (mode === "version") return esc(versionLabel(byId("versions", value)) || value);
    if (mode === "curriculum") return esc(curriculumLabel(byId("curricula", value)) || value);
    return esc(value);
  }
  function appendCellValue(cell,value,mode){
    if(mode==="badge"){var badge=document.createElement("span");badge.className="amx-badge";badge.textContent=human(value);cell.appendChild(badge);return;}
    if(mode==="yesno"){cell.textContent=value?"Yes":"No";return;}
    if(mode==="course"){cell.textContent=courseLabel(byId("courses",value))||value||"—";return;}
    if(mode==="programme"){cell.textContent=programmeLabel(byId("programmes",value))||value||"—";return;}
    if(mode==="version"){cell.textContent=versionLabel(byId("versions",value))||value||"—";return;}
    if(mode==="curriculum"){cell.textContent=curriculumLabel(byId("curricula",value))||value||"—";return;}
    cell.textContent=value==null||value===""?"—":String(value);
  }

  function importFields(key) { return csvFields(key, forms[registry[key].form].fields); }
  function csvEscape(value) { var text=String(value==null?"":value); return /[",\n]/.test(text)?'"'+text.replace(/"/g,'""')+'"':text; }
  function downloadTemplate() {
    var key=document.getElementById("amxImportType").value, fields=importFields(key);
    var csv=fields.map(function(f){return csvEscape(csvHeader(f));}).join(",")+"\r\n";
    var blob=new Blob(["\ufeff"+csv],{type:"text/csv;charset=utf-8"}), link=document.createElement("a"); link.href=URL.createObjectURL(blob); link.download="IDMS-"+key+"-template.csv"; link.click(); URL.revokeObjectURL(link.href);
  }
  async function validateImport() {
    var key=document.getElementById("amxImportType").value,file=document.getElementById("amxImportFile").files[0],status=document.getElementById("amxImportStatus"),preview=document.getElementById("amxPreview"),confirmButton=document.getElementById("amxConfirmImport");state.importRows=[];state.importValid=false;confirmButton.disabled=true;
    if(!file){status.textContent="Select a CSV file first.";return;}if(!/\.csv$/i.test(file.name)){status.textContent="Open the Excel file and Save As CSV UTF-8, then upload it.";return;}
    var matrix, fields=importFields(key);
    try { matrix=parseNamedCsv(await file.text()); } catch(error){status.textContent=error.message;return;}
    if(matrix.length<2){status.textContent="The file has no data rows.";return;}
    var headers=matrix[0],allowed=fields.flatMap(function(f){return [csvHeader(f),f[0]];}),unknown=headers.filter(function(h){return !allowed.includes(h);});
    if(unknown.length){status.textContent="Unknown columns: "+unknown.join(", ");return;}
    if(fields.some(function(f){return csvHeader(f)!==f[0]&&headers.includes(f[0])&&headers.includes(csvHeader(f));})){status.textContent="Use either the name column or legacy ID column, not both.";return;}
    state.importRows=matrix.slice(1).map(function(cells,index){var raw={};headers.forEach(function(h,i){raw[h]=cells[i]||"";});var checked=validateNamedRow(key,fields,raw,state.lookups);return{line:index+2,payload:checked.payload,errors:checked.errors,names:raw};});
    var invalid=state.importRows.filter(function(row){return row.errors.length;});state.importValid=invalid.length===0&&state.importRows.length>0;confirmButton.disabled=!state.importValid;status.textContent=state.importRows.length+" row(s): "+(state.importRows.length-invalid.length)+" valid, "+invalid.length+" invalid.";preview.hidden=false;preview.innerHTML='<table><thead><tr><th>Row</th><th>Status</th><th>Details</th></tr></thead><tbody>'+state.importRows.slice(0,100).map(function(row){return'<tr><td>'+row.line+'</td><td class="'+(row.errors.length?'amx-invalid':'')+'">'+(row.errors.length?'INVALID':'VALID')+'</td><td>'+esc(row.errors.join("; ")||JSON.stringify(row.names))+'</td></tr>';}).join("")+'</tbody></table>';
  }
  async function confirmImport() {
    if(importBusy||!state.importValid||!state.importRows.length)return;
    var key=document.getElementById("amxImportType").value,status=document.getElementById("amxImportStatus"),rows=state.importRows.slice();
    if(!window.confirm("Import "+rows.length+" validated "+registry[key].label+" records?"))return;
    importBusy=true;var job=window.IDMCProgress?.start("Import "+registry[key].label,{stage:"Preparing records"});
    ["amxConfirmImport","amxImportType","amxImportFile","amxValidate","amxTemplate"].forEach(function(id){document.getElementById(id).disabled=true;});
    try {
      status.textContent="Importing 0/"+rows.length+" (0%)…";
      var outcomes=await runAcademicImport(api,key,registry[key].endpoint,rows,function(done,total){var percent=Math.floor(done/total*100);status.textContent="Processed "+done+"/"+total+" ("+percent+"%). Refresh follows after completion.";window.IDMCProgress?.update(job,"Import "+registry[key].label,done,total,{stage:"Records received from the server"});});
      var completed=outcomes.filter(function(r){return r.ok;}).length,failed=outcomes.filter(function(r){return !r.ok;});
      state.importValid=false;state.importRows=[];api.clearCache();window.IDMCProgress?.update(job,null,null,null,{stage:"Refreshing saved records"});await load();
      status.textContent=completed+" imported; "+failed.length+" failed / not sent."+(failed.length?" "+failed.slice(0,5).map(function(r){return "Row "+r.line+": "+(r.error?.message||"failed");}).join(" | "):"");
      if(failed.length){document.getElementById("amxPreview").hidden=false;document.getElementById("amxPreview").innerHTML='<p>Successful rows are already committed. Use a corrected file containing only failed rows; check uncertain timeout outcomes before repeating.</p><table><thead><tr><th>Row</th><th>Error</th></tr></thead><tbody>'+failed.map(function(r){return '<tr><td>'+r.line+'</td><td>'+esc(r.error?.message||'failed')+'</td></tr>';}).join('')+'</tbody></table>';}
      window.IDMCProgress?.finish(job,!failed.length,completed+" saved; "+failed.length+" failed / not sent.");job=null;
    }catch(error){status.textContent=error.message||"Import failed; check saved records before repeating.";window.IDMCProgress?.finish(job,false,status.textContent);job=null;}
    finally{if(job!==null)window.IDMCProgress?.finish(job,false);importBusy=false;["amxImportType","amxImportFile","amxValidate","amxTemplate"].forEach(function(id){document.getElementById(id).disabled=false;});document.getElementById("amxConfirmImport").disabled=true;}
  }

  function fieldHtml(field) {
    var name = field[0], label = field[1], type = field[2], source = field[3], required = field[4], placeholder = field[5] || "";
    var requiredText = required ? " required" : "";
    var labelClass = required ? "amx-required" : "";
    var control;
    if (type === "institution") {
      var institution = state.lookups.institution || {};
      control = '<input class="amx-locked" name="' + name + '" type="hidden" value="' + esc(institution.id || "") + '"><input class="amx-locked" value="' + esc(institution.institution_name || "Institute of Development and Medical Sciences") + '" readonly>';
    } else if (type === "select" || type === "selectOptional") {
      var rows = state.lookups[source] || [];
      var options = rows.map(function (row) { return '<option value="' + esc(row.id) + '">' + esc(labelFor(source, row)) + "</option>"; }).join("");
      control = '<select name="' + name + '"' + (type === "select" ? requiredText : "") + '><option value="">' + (type === "select" ? "Select " : "Optional: ") + esc(label) + "</option>" + options + "</select>";
    } else if (type === "courseChecklist") {
      var courseRows = (state.lookups.courses || []).filter(function (row) { return row.status === "ACTIVE"; });
      control = '<div class="amx-checklist amx-course-checklist" role="group" aria-label="Select courses">' + (courseRows.length ? courseRows.map(function (row) {
        var existing = (state.lookups.curriculumCourses || []).find(function (mapping) { return mapping.curriculum_id === formValue("curriculumId") && mapping.course_id === row.id; });
        var units = existing && existing.credit_units != null ? existing.credit_units : row.credit_units;
        var category = existing && existing.course_category || row.course_type || "CORE";
        return '<div class="amx-course-row"><label class="amx-course-name"><input type="checkbox" name="courseIds" value="' + esc(row.id) + '"><span>' + esc(courseLabel(row)) + '</span></label><label><span>Category</span><select data-course-category="' + esc(row.id) + '">' + categoryOptions(category) + '</select></label><label><span>Year</span><input type="number" min="1" step="1" data-course-year="' + esc(row.id) + '" value="' + esc(existing && existing.year_number || 1) + '"></label><label><span>Semester</span><input type="number" min="1" step="1" data-course-semester="' + esc(row.id) + '" value="' + esc(existing && existing.semester_number || 1) + '"></label><label><span>Class credits</span><input type="number" min="0" step="0.01" data-course-credit="' + esc(row.id) + '" value="' + esc(units == null ? "" : units) + '"></label></div>';
      }).join("") : '<p class="amx-picker-empty">No active courses are available.</p>') + '</div>';
    } else if (type === "crossCuttingChecklist") {
      var sharedCourseRows = (state.lookups.courses || []).filter(function (row) { return row.status === "ACTIVE"; });
      control = '<div class="amx-checklist" id="amxCrossCourses" role="group" aria-label="Select cross-cutting courses">' + (sharedCourseRows.length ? sharedCourseRows.map(function (row) {
        var category = row.course_type || "CORE";
        return '<div class="amx-course-row amx-cross-course-row"><label class="amx-course-name"><input type="checkbox" name="courseIds" value="' + esc(row.id) + '"><span>' + esc(courseLabel(row)) + (row.cross_cutting ? ' <b class="amx-badge">Shared</b>' : '') + '</span></label><label><span>Category</span><select data-course-category="' + esc(row.id) + '">' + categoryOptions(category) + '</select></label><label><span>Year</span><input type="number" min="1" step="1" data-course-year="' + esc(row.id) + '" value="1"></label><label><span>Semester</span><input type="number" min="1" step="1" data-course-semester="' + esc(row.id) + '" value="1"></label></div>';
      }).join("") : '<p class="amx-picker-empty">No active courses are available.</p>') + '</div><small class="amx-field-help">Tick one or more courses. Category, study year and semester start from each course setup and can be changed before saving.</small>';
    } else if (type === "curriculumChecklist") {
      var targetRows = (state.lookups.curricula || []).filter(function (row) {
        var version = byId("versions", row.programme_version_id);
        return row.status === "ACTIVE" && String(version.status || "").toUpperCase() === "ACTIVE";
      });
      control = '<div class="amx-checklist" id="amxCurriculumTargets" role="group" aria-label="Target curricula">' + (targetRows.length ? targetRows.map(function (row) {
        var version = byId("versions", row.programme_version_id), programme = byId("programmes", version.programme_id);
        return '<div class="amx-check-row"><label><input type="checkbox" name="curriculumTargets" value="' + esc(row.id) + '"><span>' + esc(programmeLabel(programme) + " · " + curriculumLabel(row)) + '</span></label></div>';
      }).join("") : '<p class="amx-picker-empty">No active curricula with active programme versions. Activate the curriculum/version first.</p>') + '</div>';
    } else if (type === "crossCreditMatrix") {
      control = '<div class="amx-checklist" id="amxCrossCreditMatrix"><p class="amx-picker-empty">Tick courses and target curricula to set credits for each course in each class.</p></div>';
    } else if (type === "choices") {
      control = '<select name="' + name + '"' + requiredText + '><option value="">Select ' + esc(label) + "</option>" + source.map(function (value) { return '<option value="' + esc(value) + '">' + esc(human(value)) + "</option>"; }).join("") + "</select>";
    } else if (type === "checkbox") {
      control = '<input name="' + name + '" type="checkbox" value="true">';
    } else if (type === "textarea") {
      control = '<textarea name="' + name + '" placeholder="' + esc(placeholder) + '"' + requiredText + "></textarea>";
    } else {
      var step = type === "number" ? ' step="any" min="0"' : "";
      control = '<input name="' + name + '" type="' + type + '" placeholder="' + esc(placeholder) + '"' + step + requiredText + ">";
    }
    if (["courseChecklist", "crossCuttingChecklist", "curriculumChecklist", "crossCreditMatrix"].includes(type)) return '<div class="amx-field ' + labelClass + ' wide"><span class="amx-field-title">' + esc(label) + '</span>' + control + '</div>';
    return '<label class="' + labelClass + (type === "textarea" ? " wide" : "") + '"><span>' + esc(label) + "</span>" + control + "</label>";
  }

  function formValue(name) {
    var field = document.querySelector('#amxForm [name="' + name + '"]');
    return field ? field.value : "";
  }
  function categoryOptions(selected) {
    var categories = ["CORE", "ELECTIVE", "OPTIONAL", "GENERAL", "PRACTICAL", "FIELD", "CLINICAL", "PROJECT", "OTHER"];
    selected = normalizeCategory(selected);
    return categories.map(function (category) { return '<option value="' + category + '"' + (category === selected ? " selected" : "") + '>' + esc(human(category)) + "</option>"; }).join("");
  }
  function normalizeCategory(value) {
    var categories = ["CORE", "ELECTIVE", "OPTIONAL", "GENERAL", "PRACTICAL", "FIELD", "CLINICAL", "PROJECT", "OTHER"], normalized = String(value || "").toUpperCase();
    return categories.includes(normalized) ? normalized : "CORE";
  }
  function renderCrossCreditMatrix(form) {
    var matrix = form.querySelector("#amxCrossCreditMatrix");
    if (!matrix) return;
    var courseIds = checkedValues(form, "courseIds"), curriculumIds = checkedValues(form, "curriculumTargets");
    if (!courseIds.length || !curriculumIds.length) {
      matrix.innerHTML = '<p class="amx-picker-empty">Tick courses and target curricula to set credits for each course in each class.</p>';
      return;
    }
    var oldCategories={},oldCompulsory={};matrix.querySelectorAll("[data-cross-category-course]").forEach(function(input){oldCategories[input.dataset.crossCategoryCourse+":"+input.dataset.crossCategoryCurriculum]=input.value;});matrix.querySelectorAll("[data-cross-compulsory-course]").forEach(function(input){oldCompulsory[input.dataset.crossCompulsoryCourse+":"+input.dataset.crossCompulsoryCurriculum]=input.value;});
    var oldCredits={};matrix.querySelectorAll("[data-cross-credit-course]").forEach(function(input){oldCredits[input.dataset.crossCreditCourse+":"+input.dataset.crossCreditCurriculum]=input.value;});
    matrix.innerHTML = courseIds.map(function (courseId) {
      var course = byId("courses", courseId);
      return '<section class="amx-credit-matrix-course"><h4>' + esc(courseLabel(course)) + '</h4>' + curriculumIds.map(function (curriculumId) {
        var curriculum = byId("curricula", curriculumId), existing = (state.lookups.curriculumCourses || []).find(function (row) { return row.course_id === courseId && row.curriculum_id === curriculumId; });
        var creditKey=courseId+":"+curriculumId;
        var units = Object.prototype.hasOwnProperty.call(oldCredits,creditKey)?oldCredits[creditKey]:(existing && existing.credit_units != null ? existing.credit_units : course.credit_units);
        return '<label class="amx-matrix-credit"><span>' + esc(curriculumLabel(curriculum)) + ' credits</span><input type="number" min="0" step="0.01" data-cross-credit-course="' + esc(courseId) + '" data-cross-credit-curriculum="' + esc(curriculumId) + '" value="' + esc(units == null ? "" : units) + '"></label><label><span>Programme category</span><select data-cross-category-course="' + esc(courseId) + '" data-cross-category-curriculum="' + esc(curriculumId) + '">' + categoryOptions(oldCategories[creditKey] || existing && existing.course_category || course.course_type) + '</select></label><label><span>Compulsory</span><select data-cross-compulsory-course="' + esc(courseId) + '" data-cross-compulsory-curriculum="' + esc(curriculumId) + '"><option value="true"' + ((oldCompulsory[creditKey] || String(existing ? existing.is_compulsory : (existing && existing.course_category || course.course_type)==="CORE")) === "true" ? ' selected' : '') + '>Yes</option><option value="false"' + ((oldCompulsory[creditKey] || String(existing ? existing.is_compulsory : (existing && existing.course_category || course.course_type)==="CORE")) === "false" ? ' selected' : '') + '>No</option></select></label>';
      }).join("") + '</section>';
    }).join("");
  }

  function openForm(code, existing) {
    if (!canManage()) return;
    var def = forms[code];
    if (!def) return;
    if (!state.ready) { window.alert("Academic reference data is still loading. Try again in a moment."); return; }
    modalTrigger=document.activeElement;
    var form = document.getElementById("amxForm");
    form.dataset.code = code;
    form.dataset.recordId = existing ? existing.id : "";
    form.dataset.endpoint = def.endpoint;
    document.getElementById("amxTitle").textContent = def.title;
    var initialMessage=document.getElementById("amxFormMessage");if(initialMessage){initialMessage.textContent="";initialMessage.className="amx-form-message wide";}
    form.innerHTML = '<div class="amx-form-message wide" id="amxFormMessage" role="alert"></div>' + (code === "curriculum" && !existing ? def.fields.concat([["courseId","Courses to add together (optional)","courseChecklist","courses",false],["isCompulsory","Compulsory","choices",["true","false"],true]]) : code === "offering" && !existing ? def.fields.map(function(f){return f[0]==="courseId"?["courseId","Select mapped courses","courseChecklist","courses",false]:f;}) : def.fields).map(fieldHtml).join("") + '<div class="amx-form-actions"><button class="amx-btn" type="button" id="amxCancel">Cancel</button><button class="amx-btn primary" type="submit">Save Record</button></div>';
    document.getElementById("amxCancel").onclick = closeForm;
    bindDependencies(code, form);
    installBulkPickers(form);
    if(existing) {
      def.fields.forEach(function(field){var control=form.elements[field[0]],dbKey=field[0].replace(/[A-Z]/g,function(c){return '_'+c.toLowerCase();});if(control&&existing[dbKey]!=null)control.value=String(existing[dbKey]);});
      document.getElementById("amxTitle").textContent=def.title.replace(/^Add /,'Edit ');
    }else{
      ['status','courseType','crossCutting','isCompulsory','deliveryMode'].forEach(function(key){if(form.elements[key])form.elements[key].value={status:code==='offering'?'OPEN':(code==='version'||code==='curriculum'?'DRAFT':'ACTIVE'),courseType:'CORE',crossCutting:'false',isCompulsory:'true',deliveryMode:'ON_CAMPUS'}[key];});
      ['capacity','minimumStudents','contactHours'].forEach(function(key){if(form.elements[key])form.elements[key].value='0';});
      if(form.elements.departmentId && ['social','project'].includes(state.courseView)){var candidates=(state.lookups.departments||[]).filter(function(d){return d.academic_group===(state.courseView==='social'?'SOCIAL':'PROJECT');});if(candidates.length===1)form.elements.departmentId.value=candidates[0].id;}
    }
    if(form.elements.departmentId && form.elements.schoolId)form.elements.departmentId.addEventListener('change',function(){var d=byId('departments',this.value);if(d.school_id)form.elements.schoolId.value=d.school_id;});
    if(code==='offering' && existing){
      var autoCode=function(){if(existing)return;form.elements.offeringCode.value=offeringCode(byId('courses',form.elements.courseId.value),byId('years',form.elements.academicYearId.value),byId('semesters',form.elements.semesterId.value),byId('programmes',form.elements.programmeId.value));};
      ['courseId','academicYearId','semesterId','programmeId'].forEach(function(key){form.elements[key].addEventListener('change',autoCode);});
      form.elements.programmeId.addEventListener('change',function(){var versions=(state.lookups.versions||[]).filter(function(v){return v.programme_id===this.value&&v.status==='ACTIVE';},this);if(versions.length===1)form.elements.programmeVersionId.value=versions[0].id;});
    }
    document.getElementById('amxModal').onkeydown=function(e){if(e.key==='Escape')closeForm();if(e.key==='Tab'){var nodes=Array.from(form.parentElement.querySelectorAll('button,input,select,textarea')).filter(function(n){return !n.disabled&&n.type!=='hidden'&&n.offsetParent!==null;});var first=nodes[0],last=nodes[nodes.length-1];if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}}};
    setTimeout(function(){var first=form.querySelector('input:not([type=hidden]):not([readonly]),select');if(first)first.focus();},0);
    if (code === "crossCutting" && !existing) {
      var activeYear = (state.lookups.years || []).find(function (row) { return String(row.status).toUpperCase() === "ACTIVE"; }) || (state.lookups.years || [])[0];
      if (activeYear) { form.elements.academicYearId.value = activeYear.id; form.elements.academicYearId.dispatchEvent(new Event("change")); }
      var activeSemester = (state.lookups.semesters || []).find(function (row) { return row.academic_year_id === form.elements.academicYearId.value && String(row.status).toUpperCase() === "ACTIVE"; }) || (state.lookups.semesters || []).find(function (row) { return row.academic_year_id === form.elements.academicYearId.value; });
      if (activeSemester) form.elements.semesterId.value = activeSemester.id;
    }
    if(code === "course") { form.elements.autoMap.value=existing?"false":"true";form.elements.departmentId.dispatchEvent(new Event("change")); }
    if (code === "curriculumCourse" && form.elements.curriculumId) form.elements.curriculumId.dispatchEvent(new Event("change"));
    if (code === "curriculum" && !existing) {
      form.elements.programmeVersionId.addEventListener("change", function(){var version=byId("versions",this.value),programme=byId("programmes",version.programme_id);form.querySelectorAll(".amx-course-row").forEach(function(row){var check=row.querySelector("input[name=courseIds]"),course=byId("courses",check.value),allowed=!!version.id&&(course.cross_cutting===true||course.department_id===programme.department_id);row.hidden=!allowed;check.disabled=!allowed;if(!allowed)check.checked=false;});updatePickerCounts(form);});
      form.elements.programmeVersionId.dispatchEvent(new Event("change"));
      form.addEventListener("change",function(e){if(e.target.name==="courseIds"&&checkedValues(form,"courseIds").length)form.elements.status.value="ACTIVE";});
    }
    if(code==='offering'&&existing){form.elements.level.value=String(byId('courses',existing.course_id).level||'');var semester=byId('semesters',existing.semester_id),curricula=new Set((state.lookups.curricula||[]).filter(c=>c.programme_version_id===existing.programme_version_id&&c.status==='ACTIVE').map(c=>c.id));var years=Array.from(new Set((state.lookups.curriculumCourses||[]).filter(m=>curricula.has(m.curriculum_id)&&m.course_id===existing.course_id&&Number(m.semester_number)===Number(semester.semester_number)).map(m=>m.year_number)));if(years.length===1)form.elements.yearNumber.value=years[0];form.elements.level.dispatchEvent(new Event('change'));form.elements.courseId.value=existing.course_id;}
    document.getElementById("amxModal").classList.add("open");
  }

  function bindDependencies(code, form) {
    function filterSelect(name, rows, labelKey) {
      var select = form.elements[name];
      if (!select) return;
      var current = select.value;
      select.innerHTML = '<option value="">Select ' + esc(select.closest("label").querySelector("span").textContent.replace(" *", "")) + "</option>" + rows.map(function (row) { return '<option value="' + esc(row.id) + '">' + esc(labelFor(labelKey, row)) + "</option>"; }).join("");
      if (rows.some(function (row) { return row.id === current; })) select.value = current;
    }
    if (code === "course") {
      var refreshCurricula=function(){var programmeId=form.elements.programmeId.value;var rows=(state.lookups.curricula||[]).filter(function(c){var v=byId("versions",c.programme_version_id);return c.status==="ACTIVE"&&v.status==="ACTIVE"&&v.programme_id===programmeId;});filterSelect("curriculumId",rows,"curricula");if(rows.length===1)form.elements.curriculumId.value=rows[0].id;};
      var refreshProgrammes=function(){var rows=(state.lookups.programmes||[]).filter(function(p){return p.status==="ACTIVE"&&(form.elements.crossCutting.value==="true"||p.department_id===form.elements.departmentId.value);});filterSelect("programmeId",rows,"programmes");if(rows.length===1)form.elements.programmeId.value=rows[0].id;refreshCurricula();};
      form.elements.departmentId.addEventListener("change",refreshProgrammes);form.elements.crossCutting.addEventListener("change",refreshProgrammes);form.elements.programmeId.addEventListener("change",refreshCurricula);
      form.elements.academicYearId.onchange=function(){filterSelect("semesterId",(state.lookups.semesters||[]).filter(function(s){return s.academic_year_id===form.elements.academicYearId.value;}),"semesters");};
    }
    if (code === "offering") {
      function refreshOffering(){var payload={};['academicYearId','semesterId','programmeId','programmeVersionId','level','yearNumber'].forEach(function(k){payload[k]=form.elements[k].value;});var allowed=new Set(eligibleOfferingCourses(state.lookups,payload).map(c=>c.id));
       if(form.elements.courseId)filterSelect('courseId',(state.lookups.courses||[]).filter(c=>allowed.has(c.id)),'courses');
       form.querySelectorAll('.amx-course-row').forEach(function(row){var check=row.querySelector('input[name=courseIds]'),ok=allowed.has(check.value);row.hidden=!ok;check.disabled=!ok;if(!ok)check.checked=false;row.querySelectorAll('label:not(.amx-course-name)').forEach(function(n){n.hidden=true;});});updatePickerCounts(form);
      }
      ['academicYearId','semesterId','programmeId','programmeVersionId','level','yearNumber'].forEach(function(k){form.elements[k].addEventListener('change',function(){if(k==='programmeId'){var versions=(state.lookups.versions||[]).filter(v=>v.programme_id===this.value&&v.status==='ACTIVE');if(versions.length===1)form.elements.programmeVersionId.value=versions[0].id;}refreshOffering();});});
      refreshOffering();
      form.elements.academicYearId.onchange = function () { filterSelect("semesterId", (state.lookups.semesters || []).filter(function (row) { return row.academic_year_id === form.elements.academicYearId.value; }), "semesters"); refreshOffering(); };
      form.elements.programmeId.onchange = function () { filterSelect("programmeVersionId", (state.lookups.versions || []).filter(function (row) { return row.programme_id === form.elements.programmeId.value; }), "versions");var active=(state.lookups.versions||[]).filter(v=>v.programme_id===form.elements.programmeId.value&&v.status==="ACTIVE");if(active.length===1)form.elements.programmeVersionId.value=active[0].id;refreshOffering(); };
    }
    if (code === "crossCutting") {
      form.elements.academicYearId.onchange = function () { filterSelect("semesterId", (state.lookups.semesters || []).filter(function (row) { return row.academic_year_id === form.elements.academicYearId.value; }), "semesters"); };
      form.querySelectorAll('#amxCrossCourses input[name="courseIds"], #amxCurriculumTargets input[name="curriculumTargets"]').forEach(function (input) { input.onchange = function () { renderCrossCreditMatrix(form); }; });
    }
    if (code === "curriculumCourse" && form.elements.curriculumId) {
      form.elements.curriculumId.onchange = function () {
        form.querySelectorAll('[data-course-credit]').forEach(function (input) {
          var courseId = input.dataset.courseCredit, course = byId("courses", courseId), targetDepartment = departmentFor("curricula",byId("curricula",form.elements.curriculumId.value));
          var allowed=!!form.elements.curriculumId.value && (course.cross_cutting===true || course.department_id===targetDepartment.id);
          var row=input.closest(".amx-course-row"), check=row.querySelector("input[name=courseIds]"); row.hidden=!allowed;check.disabled=!allowed;if(!allowed)check.checked=false;
          var mapping = (state.lookups.curriculumCourses || []).find(function (row) { return row.curriculum_id === form.elements.curriculumId.value && row.course_id === courseId; });
          input.value = mapping && mapping.credit_units != null ? mapping.credit_units : (course.credit_units == null ? "" : course.credit_units);
          var category = form.querySelector('[data-course-category="' + courseId + '"]'), year = form.querySelector('[data-course-year="' + courseId + '"]'), semester = form.querySelector('[data-course-semester="' + courseId + '"]');
          if (category) category.value = normalizeCategory(mapping && mapping.course_category || course.course_type);
          if (year) year.value = mapping && mapping.year_number || 1;
          if (semester) semester.value = mapping && mapping.semester_number || 1;
        });
      };
    }
  }

  function closeForm() { document.getElementById("amxModal").classList.remove("open"); if(modalTrigger&&modalTrigger.isConnected)modalTrigger.focus();else document.getElementById("amxReload").focus(); }
  function formMessage(text, type) {
    var box = document.getElementById("amxFormMessage");
    if (!box) return;
    box.className = "amx-form-message wide show " + (type || "error");
    box.textContent = text;
  }

  async function submitForm(event) {
    event.preventDefault();
    var form = event.currentTarget;
    var code = form.dataset.code;
    if (code === "offering" && !form.dataset.recordId) { await saveSelectedOfferings(form); return; }
    if (code === "curriculumCourse") { await saveCurriculumCourseSelections(form); return; }
    if (code === "crossCutting") { await saveCrossCuttingCourse(form); return; }
    if (code === "curriculum" && !form.dataset.recordId && checkedValues(form,"courseIds").length) { await saveNewCurriculum(form); return; }
    var payload = {};
    new FormData(form).forEach(function (value, key) { if (String(value).trim() !== "") payload[key] = value; });
    ["semesterNumber", "durationYears", "creditUnits", "contactHours", "totalCredits", "yearNumber", "capacity", "minimumStudents", "mappingCredits"].forEach(function (key) { if (Object.prototype.hasOwnProperty.call(payload, key)) payload[key] = Number(payload[key]); });
    if (Object.prototype.hasOwnProperty.call(payload, "crossCutting")) payload.crossCutting = payload.crossCutting === "true";
    if (Object.prototype.hasOwnProperty.call(payload, "isCompulsory")) payload.isCompulsory = payload.isCompulsory === "true";
    if (Object.prototype.hasOwnProperty.call(payload, "autoMap")) payload.autoMap = payload.autoMap === "true";
    if(code === "course" && payload.autoMap === false){["programmeId","curriculumId","yearNumber","semesterNumber","mappingCredits","courseCategory","academicYearId","semesterId"].forEach(function(k){delete payload[k];});}
    if (payload.registrationOpenAt) payload.registrationOpenAt = new Date(payload.registrationOpenAt).toISOString();
    if (payload.registrationCloseAt) payload.registrationCloseAt = new Date(payload.registrationCloseAt).toISOString();
    if (code === "prerequisite" && payload.courseId === payload.prerequisiteCourseId) { formMessage("A course cannot be its own prerequisite.", "error"); return; }
    var submit = form.querySelector('[type="submit"]');
    submit.disabled = true;
    submit.textContent = "Saving…";
    try {
      if(code==='departmentGroup')await api.patch('/academic-core/workspace/departments/'+encodeURIComponent(payload.departmentId)+'/group',{group:payload.group});
      else if(form.dataset.recordId){await api.patch(form.dataset.endpoint+'/'+encodeURIComponent(form.dataset.recordId),payload);if(code==='course')formMessage(payload.autoMap?'Course and requested programme placement updated. Refreshing…':'Course Master updated. Existing programme mappings and saved student credits preserved. Refreshing…','success');}
      else {
        var saved=unwrap(await api.post(form.dataset.endpoint, payload));
        if(code === "course")formMessage("Course Master saved; "+(saved.mapped||0)+" programme mapping(s) committed"+(saved.offeringId?" and delivery offering ready":"")+". Refreshing department/programme views…","success");
      }
      if(code!=="course")formMessage("Record saved successfully.", "success");
      api.clearCache();
      await load();
      window.setTimeout(closeForm, 550);
    } catch (error) {
      formMessage(error.message || "The record could not be saved.", "error");
    } finally {
      submit.disabled = false;
      submit.textContent = "Save Record";
    }
  }

  function updatePickerCounts(form) {
    form.querySelectorAll('.amx-checklist').forEach(function(group){var count=group.querySelector('[data-picker-count]');if(count)count.textContent=group.querySelectorAll('input[type=checkbox]:checked:not(:disabled)').length+' selected';});
  }
  function installBulkPickers(form) {
    form.querySelectorAll('.amx-checklist').forEach(function(group){
      if(!group.querySelector('input[type=checkbox]'))return;
      var toolbar=document.createElement('div');toolbar.className='amx-picker-toolbar';toolbar.innerHTML='<button type="button" class="amx-btn" data-pick-all>Select all</button> <button type="button" class="amx-btn" data-pick-none>Clear selection</button> <span data-picker-count role="status">0 selected</span>';group.prepend(toolbar);
      toolbar.addEventListener('click',function(event){var all=event.target.closest('[data-pick-all]'),none=event.target.closest('[data-pick-none]');if(!all&&!none)return;group.querySelectorAll('input[type=checkbox]:not(:disabled)').forEach(function(check){if(check.closest('[hidden]'))return;check.checked=!!all;});renderCrossCreditMatrix(form);updatePickerCounts(form);if(form.dataset.code==='curriculum'&&checkedValues(form,'courseIds').length)form.elements.status.value='ACTIVE';});
    });
    form.addEventListener('change',function(){updatePickerCounts(form);});
  }
  async function saveNewCurriculum(form) {
    try {
      var selected=checkedValues(form,'courseIds'),payload={};
      ['programmeVersionId','curriculumCode','curriculumName','effectiveFrom','effectiveTo','totalCredits','status'].forEach(function(key){if(form.elements[key].value!=='')payload[key]=form.elements[key].value;});
      if(payload.status!=='ACTIVE')throw new Error('Choose ACTIVE status when adding courses to the new curriculum.');
      var items=selected.map(function(id){return mappingItem(form,id,null,false);});
      setSaving(form,true,'Saving '+items.length+' courses…');formMessage('Saving curriculum and '+items.length+' mappings together. Waiting for transaction commit…','success');
      var result=unwrap(await api.post('/academic-core/workspace/curricula-with-courses',{curriculum:payload,items:items}));
      api.clearCache();await load();formMessage('Curriculum and '+result.mapped+' courses saved together.','success');setTimeout(closeForm,1000);
    }catch(error){formMessage(error.message||'Curriculum transaction failed.','error');}finally{setSaving(form,false);}
  }
  function checkedValues(form, name) {
    return Array.from(form.querySelectorAll('input[name="' + name + '"]:checked:not(:disabled)')).map(function (input) { return input.value; });
  }
  function positiveOrZero(value, label) {
    if (value == null || String(value).trim() === "") throw new Error(label + " is required.");
    var number = Number(value);
    if (!Number.isFinite(number) || number < 0) throw new Error(label + " must be zero or greater.");
    return number;
  }
  function setSaving(form, busy, label) {
    var submit = form.querySelector('[type="submit"]');
    submit.disabled = busy;
    submit.textContent = busy ? label : "Save Record";
  }
  function mappingItem(form,courseId,curriculumId,shared) {
    var credit=shared?form.querySelector('[data-cross-credit-course="'+courseId+'"][data-cross-credit-curriculum="'+curriculumId+'"]'):form.querySelector('[data-course-credit="'+courseId+'"]');
    var studyYear=Number(form.querySelector('[data-course-year="'+courseId+'"]').value),semesterNumber=Number(form.querySelector('[data-course-semester="'+courseId+'"]').value);
    if(!Number.isInteger(studyYear)||studyYear<1||!Number.isInteger(semesterNumber)||semesterNumber<1)throw new Error('Study year and semester must be positive whole numbers.');
    return {courseId:courseId,curriculumId:curriculumId,creditUnits:positiveOrZero(credit&&credit.value,'Class credits'),yearNumber:Number(form.querySelector('[data-course-year="'+courseId+'"]').value),semesterNumber:Number(form.querySelector('[data-course-semester="'+courseId+'"]').value),courseCategory:(shared?form.querySelector('[data-cross-category-course="'+courseId+'"][data-cross-category-curriculum="'+curriculumId+'"]'):form.querySelector('[data-course-category="'+courseId+'"]')).value,isCompulsory:shared?form.querySelector('[data-cross-compulsory-course="'+courseId+'"][data-cross-compulsory-curriculum="'+curriculumId+'"]').value==='true':form.elements.isCompulsory.value==='true' };
  }
  async function saveCurriculumCourseSelections(form) {
    try{var selected=checkedValues(form,'courseIds');formMessage("Validating "+selected.length+" selected courses…","success");if(!selected.length)throw new Error('Select courses first.');setSaving(form,true,'Saving all '+selected.length+' courses…');formMessage('Saving '+selected.length+' mappings in one transaction. Waiting for commit…','success');
      var result=unwrap(await api.post('/academic-core/workspace/mappings',{items:selected.map(function(id){return mappingItem(form,id,form.elements.curriculumId.value,false);}),shared:false}));
      api.clearCache();await load();formMessage(result.mapped+' mappings saved together. Existing student credits unchanged.','success');setTimeout(closeForm,900);
    }catch(error){formMessage(error.message||'Mappings were not saved.','error');}finally{setSaving(form,false);}
  }
  async function saveSelectedOfferings(form){
    var job=null;try{var ids=checkedValues(form,'courseIds'),payload={};new FormData(form).forEach(function(v,k){if(k!=='courseIds')payload[k]=v;});var allowed=new Set(eligibleOfferingCourses(state.lookups,payload).map(c=>c.id));if(!ids.length||ids.some(id=>!allowed.has(id)))throw Error('Select mapped courses for the chosen level, study year, semester and academic year.');if(ids.length>100)throw Error('Select at most 100 courses.');
     ['capacity','minimumStudents','yearNumber'].forEach(k=>payload[k]=Number(payload[k]));['registrationOpenAt','registrationCloseAt'].forEach(k=>{if(payload[k])payload[k]=new Date(payload[k]).toISOString();else delete payload[k];});
     var items=ids.map(function(id){var row=Object.assign({},payload,{courseId:id});var generated=offeringCode(byId('courses',id),byId('years',payload.academicYearId),byId('semesters',payload.semesterId),byId('programmes',payload.programmeId));row.offeringCode=[payload.offeringCode||generated,payload.offeringCode?byId('courses',id).course_code:null,payload.sectionName].filter(Boolean).join('-').replace(/\s+/g,'-');return row;});
     setSaving(form,true,'Saving selected courses…');job=window.IDMCProgress?.start('Course Offerings',{stage:'Validating selected courses'});var result=unwrap(await api.post('/academic-core/course-offerings/bulk',{items},{timeoutMs:120000}));window.IDMCProgress?.update(job,null,result.created,items.length,{stage:'Offerings committed'});formMessage(result.created+' course offerings saved together.','success');api.clearCache();await load();window.IDMCProgress?.finish(job,true);job=null;setTimeout(closeForm,900);
    }catch(error){formMessage(error.message,'error');window.IDMCProgress?.finish(job,false,error.message);job=null;}finally{setSaving(form,false);}
  }

  function offeringCode(course, year, semester, programme) {
    return [course.course_code, year.year_code, semester.semester_code, programme.programme_code].filter(Boolean).join("-").toUpperCase().replace(/[^A-Z0-9-]/g, "-").replace(/-+/g, "-").slice(0, 80);
  }
  async function saveCrossCuttingCourse(form) {
    try{var courses=checkedValues(form,'courseIds'),targets=checkedValues(form,'curriculumTargets');if(!courses.length||!targets.length)throw new Error('Select courses and target curricula.');
      var items=[];courses.forEach(function(c){targets.forEach(function(t){items.push(mappingItem(form,c,t,true));});});setSaving(form,true,'Saving shared setup transaction…');
      var result=unwrap(await api.post('/academic-core/workspace/mappings',{items:items,shared:true,academicYearId:form.elements.academicYearId.value,semesterId:form.elements.semesterId.value}));
      var syncMessages=[],syncFailures=[];
      for(var i=0;i<courses.length;i++){
        formMessage('Setup committed. Synchronising roster '+(i+1)+'/'+courses.length+'…','success');
        var course=byId('courses',courses[i]);
        try{
          var sync=unwrap(await api.post('/academic-core/cross-cutting/sync-roster',{courseId:courses[i],academicYearId:form.elements.academicYearId.value,semesterId:form.elements.semesterId.value}));
          var skipped=(sync.skippedPrerequisites||0)+(sync.skippedPreviouslyDropped||0)+(sync.skippedNoOffering||0)+(sync.skippedInvalidCredits||0);
          syncMessages.push(courseLabel(course)+': '+(sync.registeredNow||0)+' linked/confirmed, '+(sync.alreadyRegistered||0)+' already registered, '+skipped+' skipped by eligibility');
        }catch(error){syncFailures.push(courseLabel(course)+': '+(error.message||'Roster sync failed'));}
      }
      await load();
      var summary=result.mapped+' target mappings and '+result.offerings+' shared offerings saved. '+syncMessages.join('; ');
      if(syncFailures.length)formMessage(summary+' Roster sync incomplete: '+syncFailures.join(' | ')+'. Mappings/offering are already saved. Check the existing roster-sync SQL function and student eligibility before retrying.','error');
      else{formMessage(summary,'success');setTimeout(closeForm,1200);}
    }catch(error){formMessage(error.message||'Shared setup failed; verify no changes before retry.','error');}finally{setSaving(form,false);}
  }

  installUi();
  (async function () {
    var user = await auth.requireAuth();
    if (user) { state.user=auth.getUser(); await load(); }
  })().catch(function (error) {
    var note = document.getElementById("amxNote");
    if (note) note.textContent = error.message || "Unable to initialise Academic Structure Setup.";
  });
})();

