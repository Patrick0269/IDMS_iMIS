(function () {
  'use strict';
  const script=document.currentScript;
  if(!script?.dataset.logo)return;
  const assetURL=new URL(script.dataset.logo,script.src);
  assetURL.searchParams.set("v",new URL(script.src).searchParams.get("v")||"1");
  const asset=assetURL.href;
  const marks='.brand-mark,.brand-logo,.portal-brand-mark,.iw-mark,.hs-mark,.institution-mark,.health-brand__mark,.welcome-mark,.academic-side-mark,.ipd-seal,.logo,.ha-brand > span:first-child';
  const style=document.createElement('style');style.textContent='.idmc-logo-ready{background:transparent!important;border:0!important;padding:0!important;display:inline-flex!important;align-items:center!important;justify-content:center!important;flex-shrink:0}.idmc-official-logo{display:block;width:100%;height:100%;min-width:32px;min-height:32px;max-width:80px;max-height:80px;object-fit:contain;box-sizing:border-box;background:#fff;border-radius:8px;padding:3px}.idmc-lead-logo{width:42px;height:42px;vertical-align:middle;margin-right:10px;display:inline-block}.idmc-logo-ready .idmc-official-logo{pointer-events:none}';document.head.append(style);
  function replace(mark){
    if(mark.dataset.idmcLogo)return;
    mark.dataset.idmcLogo='loading';const img=new Image();img.alt='IDMC institutional logo';img.className='idmc-official-logo';
    img.onload=()=>{const box=mark.getBoundingClientRect();if(box.width<32)mark.style.width='48px';if(box.height<32)mark.style.height='48px';mark.replaceChildren(img);mark.classList.add('idmc-logo-ready');mark.dataset.idmcLogo='ready';};
    img.onerror=()=>{mark.dataset.idmcLogo='failed';};img.src=asset;
  }
  function apply(){document.querySelectorAll(marks).forEach(replace);document.querySelectorAll('.lead-brand').forEach(mark=>{if(mark.dataset.idmcLogo)return;mark.dataset.idmcLogo='ready';const img=new Image();img.alt='IDMC institutional logo';img.className='idmc-official-logo idmc-lead-logo';img.src=asset;mark.prepend(img);});document.querySelectorAll('img[alt*="IDMC logo" i],img[data-institution-logo]').forEach(img=>{if(img.classList.contains('idmc-official-logo'))return;img.src=asset;});}
  apply();let pending=false;new MutationObserver(()=>{if(pending)return;pending=true;queueMicrotask(()=>{pending=false;apply();});}).observe(document.body,{childList:true,subtree:true});
})();
