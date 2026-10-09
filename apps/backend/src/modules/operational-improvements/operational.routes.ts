import express, { Router, type Request } from 'express';
import { randomUUID } from 'node:crypto';
import { getSupabase } from '../../config/database.js';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission, requireRole } from '../../middleware/rbac.js';
import { rolesGrantPermission, rolesGrantRole, scopeRoleAssignments } from '../../utils/security.js';
import { linkStudentPortalAccount } from '../../services/student-portal-link.service.js';
import { sendApplicationReceivedEmail } from '../../services/email.service.js';
import { MAX_STAFF_UPLOAD_BYTES, validateStaffUpload } from '../../utils/staff-upload-validation.js';
import { privateDocumentMatchesMime } from '../../utils/private-document-validation.js';
const router=Router(); router.use(authenticate);
type Row=Record<string,any>;
const wrap=(fn:(req:Request)=>Promise<any>)=>async(req:any,res:any,next:any)=>{try{res.json({success:true,data:await fn(req)});}catch(e){next(e);}};
function fail(message:string,statusCode=400):never {throw Object.assign(new Error(message),{statusCode});}
async function checked(q:any):Promise<any>{const r=await q;if(r.error)fail(r.error.message,400);return r.data;}
async function all(table:string,columns='*',filter?:[string,any]) {const out:Row[]=[];for(let start=0;;start+=500){let q=getSupabase().from(table).select(columns).order(table==='idmc_admission_registration_queue'?'student_id':table==='idmc_result_windows'?'course_offering_id':'id').range(start,start+499);if(filter)q=q.eq(filter[0],filter[1]);const rows=await checked(q);out.push(...rows);if(rows.length<500)return out;}}
async function identity(req:Request){const rows=await checked(getSupabase().from('user_roles').select('role_id,assigned_at,status,expires_at,roles!inner(role_code,status,role_permissions(permissions(permission_code,status)))').eq('user_id',req.user!.id).eq('status','ACTIVE'));const scoped=scopeRoleAssignments(rows,req.user!.activeRoleId);if(scoped[0]?.role_id)req.user!.activeRoleId=scoped[0].role_id;return scoped;}
async function offeringAccess(req:Request,id:string){const roles=await identity(req);if(rolesGrantRole(roles,['LECTURER'])&&!rolesGrantRole(roles,['ADMIN','SUPER_ADMIN','HOD','ACADEMIC_OFFICER','EXAMINATION_OFFICER','EXAM_OFFICER'])){const a=await checked(getSupabase().from('lecturer_assignments').select('id').eq('lecturer_user_id',req.user!.id).eq('course_offering_id',id).eq('assignment_status','ACTIVE'));if(!a.length)fail('This course is not assigned to you.',403);}}
function readAccess(...permissions:string[]){return async(req:Request,_res:any,next:any)=>{try{const roles=await identity(req);if(rolesGrantRole(roles,['ADMIN','SUPER_ADMIN','ADMISSIONS_OFFICER'])||permissions.some(p=>rolesGrantPermission(roles,p)))return next();fail('Permission denied',403);}catch(error){next(error);}};}
router.get('/capabilities',wrap(async req=>{const roles=await identity(req);const codes=roles.filter((r:Row)=>rolesGrantRole([r],[r.roles.role_code])).map((r:Row)=>r.roles.role_code);const permissions=[...new Set<string>(roles.flatMap((r:Row)=>(r.roles.role_permissions||[]).map((p:Row)=>p.permissions.permission_code)).filter((p:string)=>rolesGrantPermission(roles,p)))];return {roles:codes,permissions};}));
router.get('/references',wrap(async req=>{const roles=await identity(req);const readable=['admissions.view','admissions.manage','applications.view','applications.manage','registration.view','registration.manage','timetable.view','timetable.manage','examinations.view','examinations.manage','assessment.view','assessment.manage','results.view','staff.view','portal.lecturer','results.window.manage','students.withdrawal.view','academics.view'];if(!rolesGrantRole(roles,['ADMIN','SUPER_ADMIN','ADMISSIONS_OFFICER'])&&!readable.some(p=>rolesGrantPermission(roles,p)))fail('Workspace access denied',403);const [offerings,courses,years,semesters,programmes]=await Promise.all([all('course_offerings'),all('courses','id,course_code,course_name,credit_units'),all('academic_years'),all('semesters'),all('programmes','id,programme_code,programme_name,department_id,award_level')]);let allowed=offerings;if(rolesGrantRole(roles,['LECTURER'])&&!rolesGrantRole(roles,['ADMIN','SUPER_ADMIN','HOD','ACADEMIC_OFFICER'])){const assignments=await all('lecturer_assignments','course_offering_id,id,assignment_status',['lecturer_user_id',req.user!.id]);allowed=offerings.filter(o=>assignments.some(a=>a.course_offering_id===o.id&&a.assignment_status==='ACTIVE'));}return {offerings:allowed.map(o=>{const course=courses.find(c=>c.id===o.course_id),year=years.find(y=>y.id===o.academic_year_id),semester=semesters.find(s=>s.id===o.semester_id);return {...o,course,year,semester,label:`${course?.course_code||o.offering_code||'NO-CODE'} — ${course?.course_name||'Course not linked'} | ${year?.year_name||year?.year_code||'No year'} / ${semester?.semester_name||semester?.semester_code||'No semester'}`};}),years,semesters,programmes};}));
router.get('/students',readAccess('registration.view','registration.manage'),wrap(()=>all('students')));
router.post('/admissions/register',readAccess('registration.manage'),wrap(async req=>{
  const ids=[...new Set<string>(req.body?.studentIds||[])];
  if(!ids.length||ids.length>500)fail('Select 1 to 500 students');
  const completed:Row[]=[],failed:Row[]=[],portalFailures:Row[]=[];
  for(const id of ids){
    try{
      const registration=await checked(getSupabase().rpc('idmc_register_admitted',{p_student:id,p_year:req.body.academicYearId,p_semester:req.body.semesterId,p_actor:req.user!.id}));
      const activation=await getSupabase().from('students').update({student_status:'ACTIVE',activated_at:new Date().toISOString(),enrollment_date:new Date().toISOString().slice(0,10),updated_at:new Date().toISOString()}).eq('id',id).in('student_status',['PENDING_ACTIVATION','ACTIVE']).select('id').maybeSingle();
      if(activation.error)throw new Error(`Registration completed, but student activation failed: ${activation.error.message}`);
      if(!activation.data)throw new Error('Registration completed, but the student record could not be activated. Retry registration to finish portal access.');
      const queueUpdate=await getSupabase().from('idmc_admission_registration_queue').update({status:'REGISTERED',last_error:null,updated_at:new Date().toISOString()}).eq('student_id',id);
      if(queueUpdate.error&&!['PGRST205','42P01'].includes(String(queueUpdate.error.code)))console.warn('Admission registration succeeded, but its optional queue status could not be updated:',queueUpdate.error.message);
      try{
        const portal=await linkStudentPortalAccount(id,req.user!.id);
        completed.push({studentId:id,registration,portalAccount:portal});
      }catch(error:any){
        const detail=String(error?.message||'Portal account linking failed.');
        portalFailures.push({studentId:id,error:detail,registrationCompleted:true});
        const update=await getSupabase().from('idmc_admission_registration_queue').update({last_error:`REGISTERED; portal link: ${detail}`.slice(0,1000),updated_at:new Date().toISOString()}).eq('student_id',id);
        if(update.error&&!['PGRST205','42P01'].includes(String(update.error.code)))console.warn('Student registration succeeded, but portal-link status could not be saved:',update.error.message);
      }
    }catch(e:any){
      let detail=String(e?.message||'Registration failed.');
      const missingOffering=detail.match(/Course\s+([0-9a-f-]{36})\s+needs exactly one open\/closed offering; found 0/i);
      if(missingOffering){
        const course=await getSupabase().from('courses').select('course_code,course_name').eq('id',missingOffering[1]).maybeSingle();
        if(!course.error&&course.data)detail=`${detail}. Missing offering: ${course.data.course_code||''} ${course.data.course_name||''}. In Academic Management > Course Offerings, create exactly one offering for this programme, academic year and semester, then set its status to OPEN or CLOSED and retry.`;
        else detail=`${detail}. Create exactly one OPEN or CLOSED course offering for this programme, academic year and semester, then retry.`;
      }
      failed.push({studentId:id,error:detail});
      const queueFailure=await getSupabase().from('idmc_admission_registration_queue').update({status:'PENDING',last_error:detail.slice(0,1000),updated_at:new Date().toISOString()}).eq('student_id',id);
      if(queueFailure.error&&!['PGRST205','42P01'].includes(String(queueFailure.error.code)))console.warn('Registration issue could not be saved to the Admissions queue:',queueFailure.error.message);
    }
  }
  return {completed,failed,portalFailures};
}));
router.get('/admissions/queue',readAccess('registration.view','registration.manage'),wrap(async()=>{const q=await getSupabase().from('idmc_admission_registration_queue').select('*').order('student_id');if(!q.error)return q.data||[];if(['PGRST205','42P01'].includes(String(q.error.code))||/idmc_admission_registration_queue.*(schema cache|does not exist)/i.test(q.error.message||'')){console.warn('Admission registration queue is not installed; returning an empty queue until its migration is applied.');return [];}fail(q.error.message,400);}));
router.post('/examinations/combined',requirePermission('examinations.manage'),wrap(req=>checked(getSupabase().rpc('idmc_exam_bundle',{p_data:req.body,p_actor:req.user!.id}))));
router.post('/timetable/import',requirePermission('timetable.manage'),wrap(req=>checked(getSupabase().rpc('idmc_timetable_named_rows',{p_timetable:req.body.timetableId,p_rows:req.body.rows,p_actor:req.user!.id}))));
router.get('/windows',requirePermission('results.window.manage'),wrap(()=>all('idmc_result_windows')));
router.post('/windows/:id',requirePermission('results.window.manage'),wrap(async req=>{if(typeof req.body?.isOpen!=='boolean')fail('isOpen must be true or false');const roles=await identity(req);if(!rolesGrantRole(roles,['ADMIN','SUPER_ADMIN'])){const offering=await checked(getSupabase().from('course_offerings').select('programmes(department_id)').eq('id',req.params.id).single());const dep=Array.isArray(offering.programmes)?offering.programmes[0]?.department_id:offering.programmes?.department_id;const scopes=await checked(getSupabase().from('user_scopes').select('*').eq('user_id',req.user!.id).eq('department_id',dep));if(!scopes.length)fail('This offering is outside your department scope.',403);}return checked(getSupabase().rpc('idmc_set_result_window',{p_offering:req.params.id,p_open:req.body.isOpen,p_actor:req.user!.id}));}));
router.get('/offerings/:id/export',wrap(async req=>{
  const roles=await identity(req);
  if(!rolesGrantRole(roles,['ADMIN','SUPER_ADMIN'])&&!['results.view','assessment.view','portal.lecturer'].some(p=>rolesGrantPermission(roles,p)))fail('Permission denied',403);
  const id=String(req.params.id); await offeringAccess(req,id); const db=getSupabase();
  const offering=await checked(db.from('course_offerings').select('*').eq('id',id).single());
  const course=await checked(db.from('courses').select('id,course_code,course_name,cross_cutting').eq('id',offering.course_id).single());
  let offeringRows=[offering];
  if(course.cross_cutting){
    const siblings=await checked(db.from('course_offerings').select('id,programme_id,programme_version_id').eq('course_id',course.id).eq('academic_year_id',offering.academic_year_id).eq('semester_id',offering.semester_id).neq('status','CANCELLED').limit(500));
    offeringRows=siblings.length?siblings:[offering];
  }
  const offeringIds=[...new Set(offeringRows.map((row:Row)=>String(row.id)))];
  const [registrationResult,students,results,assessments,window,programmes]=await Promise.all([
    db.from('course_registrations').select('*').in('course_offering_id',offeringIds).in('registration_status',['REGISTERED','APPROVED']).limit(10000),
    all('students','id,student_number,first_name,middle_name,last_name,programme_id,student_status'),
    db.from('course_results').select('*').in('course_offering_id',offeringIds).limit(10000),
    db.from('assessments').select('*').in('course_offering_id',offeringIds).limit(5000),
    checked(db.from('idmc_result_windows').select('is_open').eq('course_offering_id',id).maybeSingle()),
    all('programmes','id,programme_code,programme_name'),
  ]);
  for(const result of [registrationResult,results,assessments])if(result.error)throw result.error;
  const studentMap=new Map(students.map((student:Row)=>[String(student.id),student]));
  const programmeMap=new Map(programmes.map((programme:Row)=>[String(programme.id),programme]));
  const courseRegs=registrationResult.data??[], resultRows=results.data??[];
  const unique=new Map<string,Row>();
  for(const registration of courseRegs){
    const student=studentMap.get(String(registration.student_id)); if(!student)continue;
    const programme=programmeMap.get(String(student.programme_id));
    const candidate={...student,course_registration_id:registration.id,course_offering_id:registration.course_offering_id,credits:registration.credits,programme_code:programme?.programme_code,programme_name:programme?.programme_name,result:resultRows.find((row:Row)=>row.student_id===registration.student_id&&row.course_registration_id===registration.id)||null};
    if(!unique.has(String(registration.student_id)))unique.set(String(registration.student_id),candidate);
  }
  const roster=[...unique.values()].sort((a,b)=>String(a.student_number).localeCompare(String(b.student_number)));
  return {isOpen:window?.is_open===true,course,offering,sharedRoster:course.cross_cutting===true,offeringCount:offeringIds.length,assessments:assessments.data??[],students:roster};
}));
router.get('/staff-user-lookup',requireRole('ADMIN','SUPER_ADMIN'),wrap(async req=>{const email=String(req.query.email||'').trim().toLowerCase();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))fail('Enter a valid email address.');const user=await checked(getSupabase().from('users').select('id,email,first_name,middle_name,last_name,display_name,phone,status,auth_user_id').eq('email',email).maybeSingle());if(!user)fail('No IDMC user matches this email. Create the user account first, then return to HR.',404);if(String(user.status||'').toUpperCase()!=='ACTIVE')fail('This user account is not active. Activate it in User Management before registering staff.',409);if(!user.auth_user_id)fail('This user has no login identity. Complete account setup in User Management first.',409);return {id:user.id,email:user.email,firstName:user.first_name,middleName:user.middle_name,lastName:user.last_name,displayName:user.display_name,phone:user.phone,status:user.status};}));
router.get('/staff/:id',requirePermission('staff.view'),wrap(async req=>{const id=String(req.params.id);const [staff,history,qualifications,documents,files]=await Promise.all([checked(getSupabase().from('staff').select('*').eq('id',id).single()),all('staff_employment_history','*',['staff_id',id]),all('staff_qualifications','*',['staff_id',id]),all('staff_documents','*',['staff_id',id]),all('idmc_staff_files','id,staff_id,file_name,mime_type,document_type,verification_status,uploaded_at',['staff_id',id])]);return {staff,history,qualifications,documents,files};}));
router.get('/staff-files/:id',requirePermission('staff.view'),wrap(req=>checked(getSupabase().from('idmc_staff_files').select('*').eq('id',req.params.id).single())));
router.post('/staff/:id/files',requirePermission('staff.manage'),wrap(async req=>{const files=req.body?.files;if(!Array.isArray(files)||files.length>12||!files.length)fail('Upload 1 to 12 files');const validated=files.map((f:Row)=>validateStaffUpload(f));if(validated.reduce((sum:number,file:ReturnType<typeof validateStaffUpload>)=>sum+file.bytes.length,0)>MAX_STAFF_UPLOAD_BYTES)fail('Combined staff file size must not exceed 7 MB');const payload=files.map((f:Row,index:number)=>({staff_id:req.params.id,file_name:validated[index]!.name,mime_type:validated[index]!.mimeType,document_type:String(f.documentType||'OTHER').slice(0,50),content_base64:validated[index]!.bytes.toString('base64'),uploaded_by:req.user!.id}));return checked(getSupabase().from('idmc_staff_files').insert(payload).select('id,file_name,document_type'));}));
router.post('/staff/:id/verify',requirePermission('staff.manage'),wrap(async req=>{const id=String(req.params.id);if(!['VERIFIED','REJECTED'].includes(req.body?.status))fail('Choose VERIFIED or REJECTED');const db=getSupabase();await checked(db.from('staff').select('id').eq('id',id).single());const qualifications=await checked(db.from('staff_qualifications').update({verification_status:req.body.status,verification_notes:String(req.body.notes||'Reviewed by HR')}).eq('staff_id',id).select('id'));await checked(db.from('idmc_staff_files').update({verification_status:req.body.status,reviewed_by:req.user!.id,reviewed_at:new Date().toISOString()}).eq('staff_id',id));const documents=await checked(db.from('staff_documents').update({verification_status:req.body.status,verification_notes:String(req.body.notes||'Reviewed by HR')}).eq('staff_id',id).select('id'));await checked(db.from('idmc_workflow_events').insert({entity_id:id,action:'STAFF_'+req.body.status,actor_id:req.user!.id,details:{qualifications,documents}}));return {qualifications,documents};}));
router.post('/withdrawals',requirePermission('admissions.manage'),wrap(req=>{const reason=String(req.body.reason||'').trim();if(!reason)fail('Reason is required');return checked(getSupabase().from('idmc_student_withdrawals').insert({student_id:req.body.studentId,reason,requested_by:req.user!.id}).select().single());}));
router.get('/withdrawals',requirePermission('students.withdrawal.view'),wrap(()=>all('idmc_student_withdrawals')));
router.post('/withdrawals/:id/decide',requirePermission('students.withdrawal.approve'),wrap(req=>{if(typeof req.body?.approve!=='boolean')fail('approve must be true or false');return checked(getSupabase().rpc('idmc_decide_withdrawal',{p_id:req.params.id,p_approve:req.body.approve,p_actor:req.user!.id}));}));
router.post('/academic-year/ensure',requireRole('ADMIN','SUPER_ADMIN','ACADEMIC_OFFICER'),wrap(()=>checked(getSupabase().rpc('idmc_roll_academic_year'))));

router.post('/assessments/batch',requirePermission('assessment.manage'),wrap(async req=>{for(const id of req.body.courseOfferingIds||[])await offeringAccess(req,String(id));return checked(getSupabase().rpc('idmc_assessment_batch',{p_data:req.body,p_actor:req.user!.id}));}));
router.post('/staff/register',requireRole('ADMIN','SUPER_ADMIN'),wrap(async req=>{const body=req.body;for(const key of ['userId','employeeNumber'])if(!String(body[key]||'').trim())fail(key+' is required');if(body.files!==undefined&&!Array.isArray(body.files))fail('Staff files must be an array');if((body.files||[]).length>12)fail('Upload up to 12 files');const validated:ReturnType<typeof validateStaffUpload>[]=((body.files||[]) as Row[]).map((f:Row)=>validateStaffUpload(f));if(validated.reduce((sum:number,file:ReturnType<typeof validateStaffUpload>)=>sum+file.bytes.length,0)>MAX_STAFF_UPLOAD_BYTES)fail('Combined staff file size must not exceed 7 MB');body.files=(body.files||[]).map((f:Row,index:number)=>({...f,fileName:validated[index]!.name,mimeType:validated[index]!.mimeType,contentBase64:validated[index]!.bytes.toString('base64')}));return checked(getSupabase().rpc('idmc_staff_bundle',{p_data:body,p_actor:req.user!.id}));}));
router.get('/lecturer/curriculum/:id',requirePermission('portal.lecturer'),wrap(async req=>{await offeringAccess(req,String(req.params.id));const o=await checked(getSupabase().from('course_offerings').select('*').eq('id',req.params.id).single());const curricula=await all('curricula','*',['programme_version_id',o.programme_version_id]);const active=curricula.filter(c=>c.status==='ACTIVE');const courses=await all('courses','id,course_code,course_name,credit_units');const rows:Row[]=[];for(const c of active){const entries=await all('curriculum_courses','*',['curriculum_id',c.id]);rows.push(...entries.map(e=>({...e,curriculum:c.curriculum_name,course:courses.find(x=>x.id===e.course_id)})));}return rows;}));
router.post('/admissions/application',readAccess('applications.manage'),wrap(async req=>{
  const result=await checked(getSupabase().rpc('idmc_officer_application',{p_data:req.body,p_actor:req.user!.id}));
  let emailSent:boolean|null=null,emailError:string|null=null;
  try{
    const programme=await checked(getSupabase().from('programmes').select('programme_code,programme_name').eq('id',req.body.programmeId).maybeSingle());
    await sendApplicationReceivedEmail({recipientEmail:String(result.email),recipientName:String(result.applicantName||'Applicant'),applicationNumber:String(result.applicationNumber),programmeName:programme?`${programme.programme_code||''} ${programme.programme_name||''}`.trim():'selected programme'});
    emailSent=true;
  }catch(error:any){emailSent=false;emailError=String(error?.message||'Email delivery failed.').slice(0,400);console.error(`[admissions] Application ${result.applicationNumber} was saved, but its receipt email failed: ${emailError}`);}
  return {...result,emailSent,emailError};
}));
router.post('/admissions/application/:id/documents',readAccess('applications.manage'),express.raw({type:'application/octet-stream',limit:'6mb'}),wrap(async req=>{
  const db=getSupabase(),id=String(req.params.id),body=req.body;
  const application=await checked(db.from('applications').select('id,status').eq('id',id).maybeSingle());
  if(!application)fail('Application not found',404);
  if(!['SUBMITTED','UNDER_REVIEW','CORRECTION_REQUIRED'].includes(String(application.status)))fail('Documents cannot be added while this application is '+application.status,409);
  const mime=String(req.headers['x-mime-type']||''),type=String(req.headers['x-document-type']||'ACADEMIC_CERTIFICATE').toUpperCase();
  if(!['application/pdf','image/jpeg','image/png','image/webp'].includes(mime))fail('Only PDF, JPEG, PNG and WebP documents are allowed');
  if(!['RESULT_SLIP','CERTIFICATE','ACADEMIC_CERTIFICATE','BIRTH_CERTIFICATE','IDENTITY','OTHER'].includes(type))fail('Choose a valid document type');
  const name=String(req.headers['x-file-name']||'').replace(/[^a-zA-Z0-9._-]/g,'_').slice(0,180);
  if(!Buffer.isBuffer(body)||body.length<100||!name)fail('Select a valid document file under 5 MB');
  if(!privateDocumentMatchesMime(body,mime))fail('Document contents do not match the selected file type');
  const path=`admissions/${id}/${Date.now()}-${randomUUID()}-${name}`;
  const upload=await db.storage.from('idmc-private-documents').upload(path,body,{contentType:mime,upsert:false});
  if(upload.error)fail(upload.error.message,400);
  const saved=await db.from('application_documents').insert({application_id:id,document_type:type,document_name:name,file_url:path,file_size:body.length,mime_type:mime,verification_status:'PENDING',uploaded_at:new Date().toISOString()}).select('id,document_name,document_type,verification_status').single();
  if(saved.error){await db.storage.from('idmc-private-documents').remove([path]);fail(saved.error.message,400);}
  return saved.data;
}));
export default router;
