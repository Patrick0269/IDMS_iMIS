(function () {
  "use strict";
  var panel = document.getElementById("programmeTuitionPanel");
  if (!panel) return;
  var table = panel.querySelector("tbody"), message = panel.querySelector("[role=status]");
  function esc(v) { return String(v == null ? "" : v).replace(/[&<>"']/g, function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];}); }
  async function load() {
    try {
      var result = await IDMCAPI.get("/finance/programme-tuition"), rows = result && result.data || result || [];
      rows = rows.filter(function(row){
        var award=String((row.award_level||"")+" "+(row.programme_type||"")).toUpperCase(), name=String(row.programme_name||"").toUpperCase();
        return /CERTIFICATE|DIPLOMA/.test(award) && !/TECHNICIAN|BACHELOR|DEGREE|MASTER|POSTGRAD|PHD|DOCTOR|SHORT.?COURSE/.test(award+" "+name) && (/SOCIAL\s*WORK/.test(name)||(/PROJECT/.test(name)&&/BUSINESS\s+ADMINISTRATION/.test(name)));
      });
      table.innerHTML = rows.map(function(row){var source=row.fee_source==="MANUAL"?"Manual override":row.fee_source==="FEE_STRUCTURE"?(row.fee_structure_name||"Active fee structure"):"No active fee structure";return '<tr><td>'+esc(row.programme_code)+'</td><td>'+esc(row.programme_name)+'</td><td>'+esc(row.award_level)+'</td><td>'+esc(row.duration_years || "—")+'</td><td><input type="number" min="0" step="1" data-fee="'+esc(row.id)+'" value="'+esc(row.tuition_fee == null ? "" : row.tuition_fee)+'" placeholder="Fee unavailable"></td><td>'+esc(source)+'</td><td><button type="button" data-save="'+esc(row.id)+'">Save manual fee</button> '+(row.fee_source==="MANUAL"?'<button type="button" data-reset="'+esc(row.id)+'">Use fee structure</button>':"")+'</td></tr>';}).join("") || '<tr><td colspan="7">No programmes found.</td></tr>';
      message.textContent = "Programme fees use the active fee structure unless Finance saves a manual override.";
    } catch(error) { message.textContent = error.message || "Could not load programme fees."; }
  }
  table.addEventListener("click", async function(event) {
    var button = event.target.closest("[data-save], [data-reset]"); if (!button) return;
    var input = table.querySelector('input[data-fee="'+CSS.escape(button.dataset.save)+'"]');
    var id=button.dataset.save||button.dataset.reset;
    try { button.disabled=true; await IDMCAPI.patch("/finance/programme-tuition/"+encodeURIComponent(id), {tuitionFee:button.dataset.reset?null:(input.value===""?null:Number(input.value))}); await load(); message.textContent=button.dataset.reset?"Manual override cleared; fee structure amount restored.":"Manual programme tuition fee saved."; }
    catch(error) { message.textContent=error.message||"Could not save tuition fee."; } finally {button.disabled=false;}
  });
  panel.querySelector("[data-refresh]").addEventListener("click", load); load();
})();
