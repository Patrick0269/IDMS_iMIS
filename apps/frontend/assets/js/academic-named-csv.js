import { eligibleOfferingCourses } from "./offering-selection.js?v=20261008-offering-hr";
const referenceTypes = new Set(['select','selectOptional','courseChecklist']);
const fieldsBySource = {years:['year_name','year_code'],semesters:['semester_name','semester_code'],programmes:['programme_name','programme_code'],versions:['version_name','version_code'],courses:['course_name','course_code'],curricula:['curriculum_name','curriculum_code'],schools:['school_name','school_code'],departments:['department_name','department_code']};
export function csvHeader(field){ return referenceTypes.has(field[2]) ? field[0].replace(/Id$/, 'Name') : field[0]; }
export function csvFields(key, fields){
  let result=fields.filter(f=>f[2]!=='institution');
  if(key==='curricula')result=[['programmeId','Programme (for repeated version names)','selectOptional','programmes',false],...result];
  if(key==='curriculumCourses')result=[['programmeId','Programme (for repeated curriculum names)','selectOptional','programmes',false],['programmeVersionId','Programme Version (optional)','selectOptional','versions',false],...result];
  if(key==='curriculumCourses') result=result.concat([['yearNumber','Study Year','number',null,true],['semesterNumber','Semester Number','number',null,true],['courseCategory','Category','choices',['CORE','ELECTIVE','OPTIONAL','GENERAL','PRACTICAL','FIELD','CLINICAL','PROJECT','OTHER'],true],['creditUnits','Programme Credits','number',null,true]]);
  return result;
}
const norm=value=>String(value??'').trim().replace(/\s+/g,' ').toLowerCase();
export function resolveReference(source,value,payload,lookups){
 const wanted=norm(value); let rows=lookups[source]||[];
 if(source==='semesters'&&payload.academicYearId)rows=rows.filter(r=>r.academic_year_id===payload.academicYearId);
 if(source==='programmes'&&payload.departmentId&&payload.crossCutting!==true)rows=rows.filter(r=>r.department_id===payload.departmentId);
 if(source==='versions'&&payload.programmeId)rows=rows.filter(r=>r.programme_id===payload.programmeId);
 if(source==='curricula'&&(payload.programmeVersionId||payload.programmeId))rows=rows.filter(r=>{const v=(lookups.versions||[]).find(v=>v.id===r.programme_version_id);return v&&(payload.programmeVersionId?v.id===payload.programmeVersionId:v.programme_id===payload.programmeId);});
 let matches=rows.filter(r=>['id',...(fieldsBySource[source]||[])].some(f=>norm(r[f])===wanted));
 if(!matches.length&&source==='departments')matches=rows.filter(r=>norm(r.academic_group)===wanted);
 return matches.length===1 ? matches[0].id : null;
}
export function validateNamedRow(key,fields,raw,lookups){
 const payload={},errors=[];
 // Resolve parent names first, regardless of CSV column order.
 const referenceOrder=['academicYearId','departmentId','programmeId','programmeVersionId','curriculumId','semesterId','schoolId','courseId','prerequisiteCourseId'];
 const ordered=[...fields.filter(f=>!referenceTypes.has(f[2])),...fields.filter(f=>referenceTypes.has(f[2])).sort((a,b)=>referenceOrder.indexOf(a[0])-referenceOrder.indexOf(b[0]))];
 for(const field of ordered){const [name,label,type,source,required]=field;const header=csvHeader(field);const value=String(raw[header]??raw[name]??'').trim();
  if(!value){if(required)errors.push(header+' is required');continue;}
  if(referenceTypes.has(type)){const id=resolveReference(source,value,payload,lookups);if(!id)errors.push(header+' name/code is missing or ambiguous; select a unique name/code');else payload[name]=id;}
  else if(type==='number'){const n=Number(value);if(!Number.isFinite(n)||n<0)errors.push(header+' must be a non-negative number');else payload[name]=n;}
  else if(type==='checkbox'||['crossCutting','isCompulsory','autoMap'].includes(name)){if(!['true','false'].includes(value.toLowerCase()))errors.push(header+' must be true or false');else payload[name]=value.toLowerCase()==='true';}
  else if(type==='choices'){const choice=source.find(x=>String(x).toLowerCase()===value.toLowerCase());if(!choice)errors.push(header+' must be one of '+source.join(', '));else payload[name]=choice;}
  else payload[name]=value;
 }
 if(['courses','programmes'].includes(key))payload.institutionId=lookups.institution?.id;
 if(key==='courses'&&payload.autoMap!==false){payload.autoMap=true;if(!payload.yearNumber||!Number.isInteger(payload.yearNumber)||!payload.semesterNumber||!Number.isInteger(payload.semesterNumber))errors.push('yearNumber and semesterNumber are required positive whole numbers for automatic mapping');
  if(!payload.programmeId&&payload.curriculumId){const curriculum=(lookups.curricula||[]).find(r=>r.id===payload.curriculumId),v=(lookups.versions||[]).find(r=>r.id===curriculum?.programme_version_id);if(v)payload.programmeId=v.programme_id;}
  if(!payload.programmeId){const p=(lookups.programmes||[]).filter(p=>p.department_id===payload.departmentId&&p.status==='ACTIVE');if(p.length===1)payload.programmeId=p[0].id;else errors.push('programmeName is required: department has '+p.length+' active programmes');}
  if(!payload.curriculumId){const cs=(lookups.curricula||[]).filter(c=>{const v=(lookups.versions||[]).find(v=>v.id===c.programme_version_id);return c.status==='ACTIVE'&&v?.status==='ACTIVE'&&v.programme_id===payload.programmeId;});if(cs.length===1)payload.curriculumId=cs[0].id;else errors.push('curriculumName is required: programme has '+cs.length+' active curricula');}
 }
 if(['curriculumCourses','courses'].includes(key))for(const name of ['yearNumber','semesterNumber'])if(payload[name]!=null&&(!Number.isInteger(payload[name])||payload[name]<1))errors.push(name+' must be a positive whole number');
 if(key==='courses'&&payload.autoMap===false)for(const k of ['programmeId','curriculumId','yearNumber','semesterNumber','mappingCredits','courseCategory','academicYearId','semesterId'])delete payload[k];
 if(key==='offerings'){
  if(!eligibleOfferingCourses(lookups,payload).some(c=>c.id===payload.courseId))errors.push('courseName must match programme version, level, study year and selected semester/academic year');
  if(!payload.offeringCode&&payload.courseId){const course=(lookups.courses||[]).find(c=>c.id===payload.courseId),year=(lookups.years||[]).find(y=>y.id===payload.academicYearId),sem=(lookups.semesters||[]).find(s=>s.id===payload.semesterId),programme=(lookups.programmes||[]).find(p=>p.id===payload.programmeId);payload.offeringCode=[course?.course_code,year?.year_code||year?.year_name,sem?.semester_code||sem?.semester_name,programme?.programme_code,payload.sectionName].filter(Boolean).join('-').replace(/\s+/g,'-').slice(0,80);}
 }
 return {payload,errors};
}
export function parseNamedCsv(text){
 const rows=[];let row=[],cell='',quoted=false;
 text=String(text).replace(/^\ufeff/,'');
 for(let i=0;i<text.length;i++){const ch=text[i],next=text[i+1];if(quoted&&ch==='"'&&next==='"'){cell+='"';i++;}else if(ch==='"')quoted=!quoted;else if(ch===','&&!quoted){row.push(cell.trim());cell='';}else if((ch==='\n'||ch==='\r')&&!quoted){if(ch==='\r'&&next==='\n')i++;row.push(cell.trim());if(row.some(Boolean))rows.push(row);row=[];cell='';}else cell+=ch;}
 if(quoted)throw Error('CSV has an unclosed quoted value');row.push(cell.trim());if(row.some(Boolean))rows.push(row);
 if(rows.length&&new Set(rows[0]).size!==rows[0].length)throw Error('CSV contains duplicate column headers');
 if(rows.some((r,i)=>i&&r.length!==rows[0].length))throw Error('CSV row column count differs from header');
 if(rows.length>501)throw Error('Import at most 500 records per file');return rows;
}
