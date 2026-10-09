(function () {
  'use strict';
  function start() {
    const main = document.querySelector('main.idmc-deep-shell');
    const grid = main && main.querySelector('.idmc-portal-grid');
    const header = main && main.querySelector('.idmc-deep-head');
    if (!main || !grid || !header || document.getElementById('idmcPortalSidebar')) return;
    const title = header.querySelector('h2')?.textContent.trim() || 'Portal';
    const el = (tag, cls, text) => { const n=document.createElement(tag); if(cls)n.className=cls; if(text)n.textContent=text; return n; };
    const descriptions = {
      'Academics':'Curriculum, programmes and academic information.', 'Attendance':'Class attendance and attendance records.',
      'Assessment':'Course assessments and marks entry.', 'Examinations':'Examination papers and schedules.',
      'Results':'Published results and result workflows.', 'Timetable':'Teaching schedules and allocated sessions.',
      'Admissions':'Applications, offers and admission progress.', 'Students':'Student records and academic profiles.',
      'Registration':'Student registration and course enrolment.', 'Reports':'Institutional reports and summaries.',
      'Finance':'Student accounts, invoices and payment records.', 'HR':'Staff information and human resources.',
      'Human Resources':'Staff information and human resources.', 'System':'System administration and configuration.',
      'Dashboard':'Return to the main institutional dashboard.', 'My Profile':'Your personal and employment information.',
      'Profile':'Your profile and contact information.', 'Student Requests':'Department requests and review workflows.',
      'Research':'Research activities and academic contributions.', 'Communications':'Institutional messages and notices.',
      'Library Workspace':'Library services, resources and records.', 'Alumni Workspace':'Alumni records and institutional connections.',
      'Graduation':'Graduation records and completion workflows.', 'Transcripts':'Academic transcripts and student records.'
    };
    document.body.classList.add('idmc-portal-dashboard');
    main.classList.add('ipd-main');
    const sidebar=el('aside','ipd-sidebar');sidebar.id='idmcPortalSidebar';sidebar.setAttribute('aria-label','Portal navigation');
    const brand=el('a','ipd-brand');brand.href='dashboard.html';brand.append(el('span','ipd-seal','IDMC'));
    const brandText=el('span','ipd-brand-text');brandText.append(el('strong','','IDMC iMIS'),el('small','','Institutional workspace'));brand.append(brandText);sidebar.append(brand);
    sidebar.append(el('p','ipd-institution','Institute of Development and Medical Sciences'));
    const home=el('a','ipd-home','Main dashboard');home.href='dashboard.html';sidebar.append(home);
    sidebar.append(el('p','ipd-nav-label',title));const nav=el('nav','ipd-nav');nav.setAttribute('aria-label',title+' modules');sidebar.append(nav);
    const sideFoot=el('div','ipd-side-foot');sideFoot.append(el('span','','IDMC · Integrated Management'),el('small','','Academic and administrative services'));sidebar.append(sideFoot);
    document.body.prepend(sidebar);
    const backdrop=el('button','ipd-backdrop');backdrop.type='button';backdrop.tabIndex=-1;backdrop.setAttribute('aria-label','Close navigation');backdrop.hidden=true;document.body.append(backdrop);
    const topbar=el('div','ipd-topbar');const toggle=el('button','ipd-menu','Menu');toggle.type='button';toggle.setAttribute('aria-controls',sidebar.id);toggle.setAttribute('aria-expanded','false');
    const trail=el('div','ipd-breadcrumb');trail.append(el('span','','IDMC iMIS'),el('span','','/'),el('strong','',title));
    const date=el('time','ipd-date');date.dateTime=new Date().toISOString().slice(0,10);date.textContent=new Date().toLocaleDateString('en-GB',{day:'2-digit',month:'long',year:'numeric'});
    topbar.append(toggle,trail,date);main.prepend(topbar);
    header.classList.add('ipd-page-header');header.querySelector('h2')?.classList.add('ipd-page-title');
    const headerText=header.querySelector('h2')?.parentElement;if(headerText)headerText.prepend(el('span','ipd-eyebrow','PORTAL WORKSPACE'));
    const tools=el('section','ipd-workspace-tools');tools.setAttribute('aria-label','Find a workspace');
    const heading=el('div');heading.append(el('h2','','Your workspaces'),el('p','','Choose a module to continue your work.'));
    const label=el('label','ipd-search');label.append(el('span','','Find a module'));const input=el('input');input.type='search';input.placeholder='Search modules…';input.autocomplete='off';input.setAttribute('aria-label','Find a module');label.append(input);tools.append(heading,label);grid.before(tools);
    const empty=el('p','ipd-empty','No matching modules. Try another search.');empty.hidden=true;empty.setAttribute('role','status');grid.after(empty);
    const footer=el('footer','ipd-footer',title+' · IDMC iMIS');main.append(footer);
    let records=[];
    function permitted(card,link) {
      for(let n=link;n&&n!==document.body;n=n.parentElement){
        if(n.hidden||n.getAttribute('aria-hidden')==='true'||n.getAttribute('data-rbac-hidden')==='true')return false;
        // Search filtering is separate from existing permission visibility.
        if(n===card&&card.hasAttribute('data-ipd-filtered'))continue;
        const css=getComputedStyle(n);if(css.display==='none'||css.visibility==='hidden')return false;
      }
      return true;
    }
    function closeMenu(focus){document.body.classList.remove('ipd-menu-open');toggle.setAttribute('aria-expanded','false');backdrop.hidden=true;if(focus)toggle.focus();}
    function update() {
      const term=input.value.trim().toLocaleLowerCase();let count=0;
      for(const r of records){
        const matches=!term||r.title.toLocaleLowerCase().includes(term)||r.description.toLocaleLowerCase().includes(term);
        // Never remove hidden/aria-hidden/data-rbac-hidden attributes owned by other scripts.
        r.card.toggleAttribute('data-ipd-filtered',!matches);
        const allowed=permitted(r.card,r.link);r.button.hidden=!allowed||!matches;if(allowed&&matches)count++;
      }
      empty.hidden=count!==0||!term;
    }
    function collect(){
      for(const card of grid.querySelectorAll('.idmc-portal-card')){
        if(records.some(r=>r.card===card))continue;
        const link=card.querySelector('a[href]');if(!link)continue;
        const name=card.querySelector('h3')?.textContent.trim()||link.textContent.trim();
        const desc=descriptions[name]||'Open this workspace to view the available services.';
        const icon=el('span','ipd-module-icon',name.split(/\s+/).map(x=>x[0]).join('').slice(0,2).toUpperCase());icon.setAttribute('aria-hidden','true');card.prepend(icon);
        if(!card.querySelector('p')){const d=el('p','ipd-description',desc);link.before(d);}
        const button=el('button','ipd-nav-item',name);button.type='button';nav.append(button);
        button.addEventListener('click',()=>{if(permitted(card,link)){closeMenu(false);link.click();}});
        // The existing link node, href, permission attributes and listeners are retained.
        records.push({card,link,button,title:name,description:desc});
      }
      update();
    }
    collect();input.addEventListener('input',update);
    toggle.addEventListener('click',()=>{const open=!document.body.classList.contains('ipd-menu-open');document.body.classList.toggle('ipd-menu-open',open);toggle.setAttribute('aria-expanded',String(open));backdrop.hidden=!open;if(open)(nav.querySelector('button:not([hidden])')||home).focus();});
    backdrop.addEventListener('click',()=>closeMenu(true));document.addEventListener('keydown',e=>{if(e.key==='Escape')closeMenu(true);});
    // Observe only existing module cards. Sidebar mutations cannot cause an observer loop.
    const observer=new MutationObserver(()=>{records=records.filter(r=>{if(grid.contains(r.card))return true;r.button.remove();return false;});collect();});
    observer.observe(grid,{childList:true,subtree:true,attributes:true,attributeFilter:['hidden','style','class','aria-hidden','data-rbac-hidden','href']});
    window.addEventListener('pagehide',()=>observer.disconnect(),{once:true});
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();
})();
