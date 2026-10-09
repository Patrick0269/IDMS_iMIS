(async function(){
  "use strict";
  const host=document.getElementById("academicSummary");
  const esc=value=>String(value??"—").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  try{
    if(!await IDMCAuth.requireAuth())return;
    const response=await IDMCAPI.get("/staff-workspace/registry/summary"),d=response.data||{};
    const cards=[["Students",d.students],["Active students",d.admitted],["Pending activation",d.newStudents],["Registration records",d.registrations],["Results in workflow",d.results],["Awaiting publication",d.pendingResults],["Open student requests",d.requests]];
    host.innerHTML=cards.map(item=>`<article class="idmc-portal-card"><small>${item[0]}</small><h3>${esc(item[1])}</h3></article>`).join("");
  }catch(error){host.innerHTML=`<article class="idmc-portal-card"><h3>Academic overview unavailable</h3><p>${esc(error.message||"Refresh and try again.")}</p></article>`;}
})();
