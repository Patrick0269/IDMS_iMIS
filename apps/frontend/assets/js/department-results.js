(function(){
 'use strict';
 var mode=document.body.dataset.resultsMode,api=window.IDMCAPI,offset=0,limit=50,rows=[],total=0,busy=false;
 var message=document.getElementById('resultMessage'),table=document.getElementById('resultsTable');
 function esc(value){return String(value==null?'':value).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
 function note(text){message.textContent=text;}
 function setBusy(value){busy=value;document.querySelectorAll('#resultsToolbar button,#resultsTable button,#resultsTable input,#resultsTable textarea').forEach(function(n){n.disabled=value;});document.getElementById('previousResults').disabled=value||offset===0;document.getElementById('nextResults').disabled=value||offset+limit>=total;}
 async function load(){
  setBusy(true);note('Loading '+mode.toLowerCase()+' results and comment history…');
  try{var response=await api.get('/workflows/course-results/'+mode.toLowerCase()+'-workspace?offset='+offset+'&limit='+limit,{cache:'no-store'}),data=response.data||response;rows=data.items||[];total=data.total||0;render();note('Loaded '+rows.length+' of '+total+' results. '+(mode==='HOD'?'Publish submitted results directly; Principal comments appear here.':'View published results and send comments to the department HOD.'));}
  catch(error){note(error.message||'Results could not be loaded.');}finally{setBusy(false);}
 }
 function render(){
  table.innerHTML='<thead><tr>'+(mode==='HOD'?'<th><input type="checkbox" id="selectResultsPage" aria-label="Select all publishable results on this page"></th>':'')+'<th>Student</th><th>Course / period</th><th>Mark / grade</th><th>Status</th><th>Principal comments</th><th>Action</th></tr></thead><tbody>'+rows.map(function(r){var published=['PUBLISHED','LOCKED'].includes(r.result_status),calculated=r.result_status==='CALCULATED';return '<tr data-row="'+esc(r.id)+'">'+(mode==='HOD'?'<td>'+(published||calculated?'':'<input type="checkbox" data-publish-id="'+esc(r.id)+'" aria-label="Select '+esc(r.student_number)+' result">')+'</td>':'')+'<td>'+esc(r.student_number)+'<br>'+esc(r.student_name)+'</td><td>'+esc(r.course_label)+'<br>'+esc(r.academic_year)+' · '+esc(r.semester_name)+'</td><td>'+esc(r.total_mark)+' / '+esc(r.grade_code)+'</td><td>'+esc(r.result_status)+'</td><td>'+(r.comments||[]).map(function(c){return '<p><strong>'+esc(c.principal)+'</strong> · '+esc(new Date(c.createdAt).toLocaleString())+'<br>'+esc(c.comment)+'</p>';}).join('')+'</td><td>'+(mode==='PRINCIPAL'?'<textarea data-comment="'+esc(r.id)+'" maxlength="2000" aria-label="Comment to HOD" placeholder="Comment to HOD"></textarea><button type="button" data-comment-id="'+esc(r.id)+'">Send comment to HOD</button>':published?'Published':calculated?'Awaiting submission. <button type="button" data-review-calculated="'+esc(r.id)+'">Review & prepare for publication</button>':'<button type="button" data-publish-one="'+esc(r.id)+'">Publish</button>')+'</td></tr>';}).join('')+'</tbody>';
  document.getElementById('resultPage').textContent='Page '+(Math.floor(offset/limit)+1)+' · '+total+' results';
  var page=document.getElementById('selectResultsPage');if(page)page.onchange=function(){table.querySelectorAll('[data-publish-id]').forEach(function(c){c.checked=page.checked;});};
  var target=new URLSearchParams(location.search).get('result');if(target){var row=Array.from(table.querySelectorAll('[data-row]')).find(function(r){return r.dataset.row===target;});if(row)row.scrollIntoView({block:'center'});}
 }
 async function publish(ids){
  if(busy||!ids.length)return;
  if(!window.confirm('Publish '+ids.length+' submitted result(s) to students now?'))return;
  setBusy(true);var succeeded=0,failures=[],progress=window.IDMCProgress&&window.IDMCProgress.start('Publishing selected results');
  try{for(var i=0;i<ids.length;i++){note('Publishing result '+(i+1)+'/'+ids.length+' · '+succeeded+' committed…');if(progress)window.IDMCProgress.update(progress,'Publishing result',i,ids.length);try{await api.post('/workflows/course-results/'+encodeURIComponent(ids[i])+'/hod-publish',{});succeeded++;}catch(error){failures.push(error.message||'Publication failed');}}
   api.clearCache();await load();note(succeeded+'/'+ids.length+' published. '+(failures.length?failures.length+' failed: '+failures.join(' | '):'Principal can now view and comment.'));
  }finally{setBusy(false);if(progress)window.IDMCProgress.finish(progress,!failures.length,succeeded+'/'+ids.length+' results published');}
 }
 table.addEventListener('click',async function(event){
  var reviewButton=event.target.closest('[data-review-calculated]');if(reviewButton){if(!confirm('Confirm this calculation and prepare this result for HOD publication?'))return;setBusy(true);try{await api.post('/workflows/course-results/'+reviewButton.dataset.reviewCalculated+'/hod-review-calculated',{});api.clearCache();await load();note('HOD review saved. Select Publish to release this result.');}catch(error){note(error.message);}finally{setBusy(false);}return;}
  var publishButton=event.target.closest('[data-publish-one]');if(publishButton){await publish([publishButton.dataset.publishOne]);return;}
  var button=event.target.closest('[data-comment-id]');if(!button||busy)return;
  var id=button.dataset.commentId,input=Array.from(table.querySelectorAll('[data-comment]')).find(function(n){return n.dataset.comment===id;}),text=input.value.trim();
  if(!text){note('Enter a comment first.');input.focus();return;}
  // Keep the same request ID for retries of an unchanged comment.
  if(button.dataset.commentText!==text){button.dataset.commentRequest=crypto.randomUUID();button.dataset.commentText=text;}
  setBusy(true);note('Saving comment and queuing HOD notification…');
  try{var response=await api.post('/workflows/course-results/'+encodeURIComponent(id)+'/principal-comment',{commentId:button.dataset.commentRequest,comment:text}),data=response.data||response;api.clearCache();await load();note('Comment saved in HOD history. '+(data.alreadySaved?'Already saved; no duplicate created.':data.recipients+' HOD notification(s) queued.'));}
  catch(error){note(error.message||'Comment could not be saved. Retry the unchanged text.');}finally{setBusy(false);}
 });
 document.getElementById('refreshResults').onclick=load;
 document.getElementById('publishResults').hidden=mode!=='HOD';document.getElementById('publishResults').onclick=function(){publish(Array.from(table.querySelectorAll('[data-publish-id]:checked')).map(function(c){return c.dataset.publishId;}));};
 document.getElementById('previousResults').onclick=function(){offset=Math.max(0,offset-limit);load();};document.getElementById('nextResults').onclick=function(){offset+=limit;load();};
 document.addEventListener('DOMContentLoaded',async function(){if(await window.IDMCAuth.requireAuth())await load();});
})();
