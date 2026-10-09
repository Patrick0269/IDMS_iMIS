export async function runAcademicImport(api,key,endpoint,rows,progress){
 const outcomes=[];let done=0;
 if(key==='curriculumCourses'||key==='offerings'){
  // Each chunk commits atomically. Never auto-retry mutations after a timeout.
  for(let start=0;start<rows.length;start+=50){const chunk=rows.slice(start,start+50);try{await api.post(key==='offerings'?'/academic-core/course-offerings/bulk':'/academic-core/workspace/mappings',{items:chunk.map(r=>r.payload),shared:false},{timeoutMs:120000});chunk.forEach(row=>outcomes.push({line:row.line,ok:true}));}catch(error){chunk.forEach(row=>outcomes.push({line:row.line,ok:false,error}));if([401,403].includes(error.status)){rows.slice(start+50).forEach(row=>outcomes.push({line:row.line,ok:false,error:new Error('Not sent after access/session error')}));done+=chunk.length;if(progress)progress(done,rows.length);break;}}
   done+=chunk.length;if(progress)progress(done,rows.length);
  }
 }else{
  const concurrency=key==='courses'||key==='prerequisites'?4:1;
  async function worker(row){await api.post(endpoint,row.payload);return row.line;}
  if(window.IDMCProgress&&window.IDMCProgress.mapLimited){const results=await window.IDMCProgress.mapLimited(rows,concurrency,worker,(n,total)=>{done=n;if(progress)progress(n,total);});results.forEach((item,i)=>outcomes.push({line:rows[i].line,ok:item.ok,error:item.error}));}
  else{for(const row of rows){try{await worker(row);outcomes.push({line:row.line,ok:true});}catch(error){outcomes.push({line:row.line,ok:false,error});}if(progress)progress(++done,rows.length);}}
 }
 return outcomes;
}
