/* IDMC_PORTAL_ENHANCEMENTS v1: existing links and accessibility only. */
(function(){
  "use strict";
  var page=location.pathname.split("/").pop().toLowerCase();
  var quick={
    "student-results.html":{title:"Related student services",note:"Continue to your transcript, timetable or finance page.",links:[["Academic transcript","student-transcript.html"],["Timetable","student-timetable.html"],["Fees and finance","student-fees.html"]]}
  };
  function panel(target,config){
    if(!target||document.getElementById("idmcUpgradeQuickAccess"))return;
    var section=document.createElement("section");section.id="idmcUpgradeQuickAccess";section.className="idmc-upgrade-panel";section.setAttribute("aria-labelledby","idmcUpgradeTitle");
    var head=document.createElement("div");head.className="idmc-upgrade-panel__head";var copy=document.createElement("div");var h=document.createElement("h2");h.id="idmcUpgradeTitle";h.textContent=config.title;copy.appendChild(h);
    var p=document.createElement("p");p.textContent=config.note;copy.appendChild(p);head.appendChild(copy);section.appendChild(head);
    var nav=document.createElement("nav");nav.className="idmc-upgrade-links";nav.setAttribute("aria-label",config.title);
    config.links.forEach(function(item){var a=document.createElement("a");a.className="idmc-upgrade-link";a.href=item[1];a.textContent=item[0];nav.appendChild(a)});
    section.appendChild(nav);target.insertAdjacentElement("afterend",section);
  }
  function anchorNav(target,label,items){
    if(!target||document.getElementById("idmcUpgradeSectionNav"))return;
    var nav=document.createElement("nav");nav.id="idmcUpgradeSectionNav";nav.className="idmc-upgrade-nav";nav.setAttribute("aria-label",label);
    items.forEach(function(item){var a=document.createElement("a");a.href=item[1];a.textContent=item[0];nav.appendChild(a)});target.insertAdjacentElement("afterend",nav);
  }
  function markStep(){var list=document.getElementById("applicationSteps");if(!list)return;list.querySelectorAll("li").forEach(function(x){if(x.classList.contains("active"))x.setAttribute("aria-current","step");else x.removeAttribute("aria-current")})}
  function run(){
    document.body.classList.add("idmc-portal-polished");var main=document.querySelector("main");
    if(quick[page]){var h=main&&main.querySelector(".page-heading, h1");panel(h||main,quick[page])}
    if(page==="staff-portal.html"){
      var grid=document.querySelector(".idmc-portal-grid");
      [["My Employment Services","staff-self-service.html"],["Operational Workbench","staff-operations.html"]].forEach(function(item){if(!grid||grid.querySelector('a[href="'+item[1]+'"]'))return;var card=document.createElement("article");card.className="idmc-portal-card";var h=document.createElement("h3");h.textContent=item[0];var a=document.createElement("a");a.className="idmc-portal-link";a.href=item[1];a.textContent="Open";card.appendChild(h);card.appendChild(a);grid.appendChild(card)})
    }
    if(page==="staff-self-service.html")anchorNav(document.querySelector("main .intro"),"Staff self-service sections",[["Profile","#profile"],["Leave","#leave"],["Expenses","#expenses"],["Payslips","#payroll"],["Attendance","#attendance"],["Security","#security"]]);
    if(page==="staff-operations.html")anchorNav(document.querySelector("main .intro"),"Staff workbench links",[["Student requests","student-requests.html"],["My self-service","staff-self-service.html"],["Dashboard","dashboard.html"]]);
    if(page==="applicant-portal.html"){
      markStep();var steps=document.getElementById("applicationSteps");if(steps&&!steps.dataset.idmcObserved){steps.dataset.idmcObserved="true";new MutationObserver(markStep).observe(steps,{subtree:true,attributes:true,attributeFilter:["class"]})}
    }
  }
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",run,{once:true});else run();
})();
