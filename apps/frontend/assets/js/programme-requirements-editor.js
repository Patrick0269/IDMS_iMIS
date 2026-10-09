(function () {
  "use strict";
  var panel = document.getElementById("programmeRequirementsPanel");
  if (!panel) return;
  var table = panel.querySelector("tbody"), message = panel.querySelector("[role=status]"), dirty = new Set();
  function esc(v) { return String(v == null ? "" : v).replace(/[&<>"']/g, function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];}); }
  async function load() {
    if (dirty.size && !window.confirm("You have unsaved programme requirements. Discard those edits and reload?")) return;
    dirty.clear();
    try {
      var rows = [], page = 1, pageRows, total = 0;
      do {
        var result = await IDMCAPI.get("/academic-core/programmes?limit=100&page=" + page), payload = result && result.data != null ? result.data : result || [];
        pageRows = Array.isArray(payload) ? payload : payload.items || [];
        rows = rows.concat(pageRows); total = Number(result && result.meta && result.meta.total) || 0; page++;
      } while (pageRows.length === 100 && (!total || rows.length < total));
      rows = rows.filter(function(row){
        var award=String((row.award_level||"")+" "+(row.programme_type||"")).toUpperCase(), name=String(row.programme_name||"").toUpperCase();
        return /CERTIFICATE|DIPLOMA/.test(award) && !/TECHNICIAN|BACHELOR|DEGREE|MASTER|POSTGRAD|PHD|DOCTOR|SHORT.?COURSE/.test(award+" "+name) && (/SOCIAL\s*WORK/.test(name)||(/PROJECT/.test(name)&&/BUSINESS\s+ADMINISTRATION/.test(name)));
      });
      table.innerHTML = rows.map(function(row){return '<tr><td>'+esc(row.programme_code)+'</td><td>'+esc(row.programme_name)+'</td><td>'+esc(row.award_level)+'</td><td><input data-specialization="'+esc(row.id)+'" value="'+esc(row.specialization)+'" maxlength="2000"></td><td><textarea data-requirements="'+esc(row.id)+'" maxlength="5000">'+esc(row.direct_entry_requirements)+'</textarea></td><td><button type="button" data-save="'+esc(row.id)+'">Save requirements</button></td></tr>';}).join("") || '<tr><td colspan="6">No programmes found.</td></tr>';
      table.querySelectorAll("input,textarea").forEach(function(field){field.addEventListener("input",function(){dirty.add(field.dataset.specialization||field.dataset.requirements);});});
      message.textContent="Applicants see these requirements when selecting a programme.";
    } catch(error) { message.textContent=error.message||"Could not load programme requirements."; }
  }
  table.addEventListener("click", async function(event) {
    var button=event.target.closest("[data-save]"); if(!button)return;
    var id=CSS.escape(button.dataset.save), specialization=table.querySelector('[data-specialization="'+id+'"]'), requirements=table.querySelector('[data-requirements="'+id+'"]');
    try {button.disabled=true;await IDMCAPI.patch("/academic-core/programmes/"+encodeURIComponent(button.dataset.save)+"/admission-requirements",{specialization:specialization.value,directEntryRequirements:requirements.value});dirty.delete(button.dataset.save);message.textContent="Programme requirements saved.";}
    catch(error){message.textContent=error.message||"Could not save programme requirements.";}finally{button.disabled=false;}
  });
  document.addEventListener("academic:refresh-requirements",load);
  window.addEventListener("beforeunload",function(event){if(dirty.size){event.preventDefault();event.returnValue="";}});
  load();
})();
