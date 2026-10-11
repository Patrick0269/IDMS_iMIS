(function(){
  "use strict";
  var $=function(id){return document.getElementById(id)};
  var timer=null,busy=false;
  function localTime(value){var d=value?new Date(value):new Date();if(Number.isNaN(d.getTime()))return "Not reported";return new Intl.DateTimeFormat(undefined,{dateStyle:"medium",timeStyle:"medium"}).format(d)}
  function badge(id,state,label){var el=$(id);el.className="health-badge health-badge--"+state;el.textContent=label}
  function showOverall(state,title,message){var card=$("overallCard");card.className="health-overview health-state--"+state;$("overallIcon").textContent=state==="healthy"?"✓":state==="degraded"?"!":state==="unavailable"?"×":"…";$("overallTitle").textContent=title;$("overallMessage").textContent=message;badge("overallBadge",state,title)}
  async function refresh(){
    if(busy)return;busy=true;$("refreshButton").disabled=true;$("healthNotice").textContent="";showOverall("checking","Checking services","Waiting for both read-only health checks.");
    var checks=await Promise.allSettled([window.IDMCAPI.get("/health",{cache:"no-store"}),window.IDMCAPI.get("/ready",{cache:"no-store"})]);
    var api=checks[0].status==="fulfilled"?checks[0].value:null;var ready=checks[1].status==="fulfilled"?checks[1].value:null;
    var apiOk=!!(api&&api.success===true&&api.status==="healthy");var dbOk=!!(ready&&ready.success===true&&ready.status==="ready"&&ready.dependencies&&ready.dependencies.database==="ready");
    badge("apiBadge",apiOk?"healthy":"unavailable",apiOk?"Healthy":"Unavailable");$("apiMessage").textContent=apiOk?"The IDMS service is responding normally.":"The IDMS service could not be reached. Check the connection or try again later.";
    $("apiApplication").textContent=apiOk?(api.application||"IDMS iMIS API"):"Not available";$("apiTime").textContent=apiOk?localTime(api.timestamp):"Not reported";
    badge("databaseBadge",dbOk?"healthy":"unavailable",dbOk?"Ready":"Unavailable");$("databaseMessage").textContent=dbOk?"The readiness check confirmed a database connection.":"The readiness check could not confirm a database connection.";
    $("databaseDependency").textContent=dbOk?"Ready":"Not confirmed";$("databaseLatency").textContent=dbOk&&Number.isFinite(Number(ready.latencyMs))?Math.max(0,Math.round(Number(ready.latencyMs)))+" ms":"Not reported";
    if(apiOk&&dbOk)showOverall("healthy","All observed checks passed","The API and database readiness endpoints are responding.");
    else if(apiOk)showOverall("degraded","System is degraded","The API is responding, but database readiness was not confirmed.");
    else if(dbOk)showOverall("degraded","API health is unavailable","Database readiness responded, but the API health result was not healthy.");
    else showOverall("unavailable","Health checks unavailable","The API and database readiness checks did not confirm service health.");
    $("lastChecked").textContent="Last checked: "+localTime(new Date().toISOString());
    if(checks.some(function(x){return x.status==="rejected"}))$("healthNotice").textContent="At least one check could not be completed. The status cards show which result was not confirmed.";
    busy=false;$("refreshButton").disabled=false;
  }
  async function init(){
    try{
      var user=await window.IDMCAuth.requireAuth();if(!user)return;
      if(!window.IDMC_RBAC_API||!await window.IDMC_RBAC_API.requireRBACPage("system.view"))return;
      $("accessState").hidden=true;$("healthApp").hidden=false;
      $("logoutButton").addEventListener("click",function(){window.IDMCAuth.logout()});$("refreshButton").addEventListener("click",refresh);
      document.addEventListener("visibilitychange",function(){if(!document.hidden)refresh()});await refresh();
      timer=window.setInterval(function(){if(!document.hidden)refresh()},60000);
    }catch(error){console.error("System health page could not initialize:",error);$("accessState").textContent="System Health could not load. Check your session and connection, then sign in again."}
  }
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",init,{once:true});else init();
  window.addEventListener("pagehide",function(){if(timer)window.clearInterval(timer)});
})();
