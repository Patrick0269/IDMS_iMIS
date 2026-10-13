(function () {
  "use strict";
  var panel = document.getElementById("programmeRequirementsPanel");
  if (!panel) return;
  var requirementsDetails = document.getElementById("programmeRequirementsDetails");
  var openRequirements = document.getElementById("openProgrammeRequirements");
  if (openRequirements && requirementsDetails) openRequirements.addEventListener("click", function () {
    requirementsDetails.open = true;
    requirementsDetails.scrollIntoView({ behavior: "smooth", block: "start" });
  });
  var table = panel.querySelector("tbody"), message = panel.querySelector("[role=status]"), dirty = new Set(), ruleTypes = ["PRIMARY","SECONDARY","ADVANCED_LEVEL","CERTIFICATE","TECHNICIAN_CERTIFICATE","DIPLOMA","ADVANCED_DIPLOMA","BACHELOR","POSTGRADUATE_DIPLOMA","MASTERS","PHD","PROFESSIONAL","OTHER"];
  function esc(v) { return String(v == null ? "" : v).replace(/[&<>"']/g, function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];}); }
  async function load() {
    if (dirty.size && !window.confirm("You have unsaved programme requirements. Discard those edits and reload?")) return;
    dirty.clear();
    try {
      var rows = [], page = 1, pageRows, total = 0, rulesResult;
      rulesResult = await IDMCAPI.get("/academic-core/admission-eligibility");
      var rules = (rulesResult && rulesResult.data != null ? rulesResult.data : rulesResult || []).reduce(function(map, rule){map[rule.programme_id]=rule;return map;},{});
      do {
        var result = await IDMCAPI.get("/academic-core/programmes?limit=100&page=" + page), payload = result && result.data != null ? result.data : result || [];
        pageRows = Array.isArray(payload) ? payload : payload.items || [];
        rows = rows.concat(pageRows); total = Number(result && result.meta && result.meta.total) || 0; page++;
      } while (pageRows.length === 100 && (!total || rows.length < total));
      rows = rows.filter(function(row){return row.status === "ACTIVE";});
      table.innerHTML = rows.map(function(row){var rule=rules[row.id]||{},accepted=Array.isArray(rule.accepted_qualification_types)?rule.accepted_qualification_types:[];return '<tr><td>'+esc(row.programme_code)+'</td><td>'+esc(row.programme_name)+'</td><td>'+esc(row.award_level)+'</td><td><input data-specialization="'+esc(row.id)+'" value="'+esc(row.specialization)+'" maxlength="2000"></td><td><textarea data-requirements="'+esc(row.id)+'" maxlength="5000">'+esc(row.direct_entry_requirements)+'</textarea></td><td><select multiple size="5" data-types="'+esc(row.id)+'" aria-label="Accepted qualification types">'+ruleTypes.map(function(type){return '<option value="'+type+'" '+(accepted.includes(type)?'selected':'')+'>'+type.replaceAll('_',' ')+'</option>';}).join('')+'</select><label>Minimum qualification level <input data-level="'+esc(row.id)+'" type="number" min="1" max="10" step="1" value="'+esc(rule.minimum_qualification_level??'')+'"></label><label><input data-verified="'+esc(row.id)+'" type="checkbox" '+(rule.require_verified_qualification?'checked':'')+'> Must be verified</label><input data-reason="'+esc(row.id)+'" placeholder="Approved policy/reference (required)" value="'+esc(rule.reason||'')+'" maxlength="1000"></td><td><button type="button" data-save="'+esc(row.id)+'">Save requirements</button></td></tr>';}).join("") || '<tr><td colspan="7">No active programmes found.</td></tr>';
      table.querySelectorAll("input,textarea,select").forEach(function(field){field.addEventListener("input",function(){dirty.add(field.dataset.specialization||field.dataset.requirements||field.dataset.types||field.dataset.level||field.dataset.verified||field.dataset.reason);});field.addEventListener("change",function(){dirty.add(field.dataset.types||field.dataset.verified||field.dataset.specialization);});});
      message.textContent="Only qualification types and the optional minimum level are checked automatically. Admissions must review other published grade or subject requirements before deciding an application.";
    } catch(error) { message.textContent=error.message||"Could not load programme requirements."; }
  }
  table.addEventListener("click", async function(event) {
    var button=event.target.closest("[data-save]"); if(!button)return;
    var id=CSS.escape(button.dataset.save), specialization=table.querySelector('[data-specialization="'+id+'"]'), requirements=table.querySelector('[data-requirements="'+id+'"]'), types=table.querySelector('[data-types="'+id+'"]'), level=table.querySelector('[data-level="'+id+'"]'), verified=table.querySelector('[data-verified="'+id+'"]'), reason=table.querySelector('[data-reason="'+id+'"]');
    try {var accepted=Array.from(types.selectedOptions).map(function(option){return option.value;});if(!accepted.length)throw new Error("Select at least one accepted qualification type before saving eligibility.");if(!reason.value.trim())throw new Error("Enter the approved policy or reference for this eligibility rule.");button.disabled=true;await IDMCAPI.put("/academic-core/programmes/"+encodeURIComponent(button.dataset.save)+"/admission-eligibility",{acceptedQualificationTypes:accepted,minimumQualificationLevel:level.value?Number(level.value):null,requireVerifiedQualification:verified.checked,reason:reason.value.trim()});await IDMCAPI.patch("/academic-core/programmes/"+encodeURIComponent(button.dataset.save)+"/admission-requirements",{specialization:specialization.value,directEntryRequirements:requirements.value});dirty.delete(button.dataset.save);message.textContent="Admission information and qualification type/level rule saved. Grade and subject criteria remain in the approved source text for staff review.";}
    catch(error){message.textContent=error.message||"Could not save programme requirements.";}finally{button.disabled=false;}
  });
  document.addEventListener("academic:refresh-requirements",load);
  window.addEventListener("beforeunload",function(event){if(dirty.size){event.preventDefault();event.returnValue="";}});
  load();
})();
