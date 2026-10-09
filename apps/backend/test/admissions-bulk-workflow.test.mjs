import test from 'node:test';import assert from 'node:assert/strict';import express from 'express';
Object.assign(process.env,{NODE_ENV:'test',SUPABASE_URL:'http://127.0.0.1:9',SUPABASE_SERVICE_ROLE_KEY:'test-key-only',JWT_SECRET:'test-secret-at-least-sixteen',SMTP_HOST:'localhost',SMTP_USER:'test@example.com',SMTP_PASSWORD:'test-only',SMTP_FROM_EMAIL:'test@example.com'});
const {getSupabase}=await import('../dist/config/database.js');const {default:admissions}=await import('../dist/modules/admissions/admissions.routes.js');const {default:applicant}=await import('../dist/modules/applicant-self-service/applicant-self-service.routes.js');const {errorHandler}=await import('../dist/middleware/errorHandler.js');
test('admissions verifies, selects and issues once; rejects invalid states and unauthorized offer issuance; acceptance repairs its own student link',async()=>{
 const db=getSupabase(),oldFrom=db.from,oldAuth=db.auth.getUser,oldRpc=db.rpc,oldGetUserById=db.auth.admin.getUserById;let conversions=0,verificationCalls=0;let permissions=['applications.manage','admissions.manage'];
 const tables={users:[{id:'user',auth_user_id:'auth',email:'verified@example.edu',status:'ACTIVE'}],applicants:[{id:'person',auth_user_id:'auth',email:'unverified-recipient@external.test',first_name:'Synthetic',last_name:'Student'}],applications:[{id:'app',applicant_id:'person',status:'SUBMITTED'}],academic_qualifications:[{id:'q',applicant_id:'person',verification_status:'PENDING'}],application_documents:[{id:'d',application_id:'app',verification_status:'PENDING'}],application_choices:[{id:'choice',application_id:'app',programme_id:'programme',choice_number:1}],admission_decisions:[],admission_offers:[],students:[],roles:[{id:'student-role',role_code:'STUDENT',status:'ACTIVE'}],audit_logs:[]};
 db.auth.getUser=async()=>({data:{user:{id:'auth',email:'synthetic@example.com'}},error:null});
 db.auth.admin.getUserById=async id=>({data:{user:{id,email:'verified@example.edu',email_confirmed_at:null}},error:null});
 db.rpc=async(name,args)=>{
   assert.equal(args.p_application_id,'app');
   if(name==='verify_application_records_atomic'){
     verificationCalls++;
     if(tables.applications[0].status==='CONVERTED_TO_STUDENT')return {data:null,error:{message:'Application status CONVERTED_TO_STUDENT cannot be verified.'}};
     tables.academic_qualifications[0].verification_status='VERIFIED';tables.application_documents[0].verification_status='VERIFIED';tables.applications[0].status='VERIFIED';tables.applications[0].verification_status='VERIFIED';
     return {data:{application_id:'app',status:'VERIFIED',qualifications_verified:1,documents_verified:1},error:null};
   }
   assert.equal(name,'issue_admission_offer_atomic');
   assert.equal(args.p_select_application,true);
   if(tables.applications[0].status==='CONVERTED_TO_STUDENT')return {data:null,error:{message:'An offer can only be issued for a selected application.'}};
   const newlyIssued=tables.admission_offers.length===0;
   if(newlyIssued)tables.admission_offers.push({id:'offer',application_id:'app',programme_id:'programme',offer_number:'OFFER-TEST',offer_status:'ISSUED',expiry_date:'2026-11-06'});
   tables.applications[0].status='ADMISSION_OFFERED';tables.applications[0].eligibility_status='ELIGIBLE';tables.applications[0].selection_status='SELECTED';
   return {data:{offer:tables.admission_offers[0],newly_issued:newlyIssued,decision:{id:'decision'},choice:{programme_id:'programme'}},error:null};
 };
 db.from=table=>{
   let predicates=[],mode='select',payload=null,single=false,limit=Infinity;
   const query={select(){return this},eq(k,v){predicates.push(r=>r[k]===v);return this},neq(k,v){predicates.push(r=>r[k]!==v);return this},in(k,v){predicates.push(r=>v.includes(r[k]));return this},order(){return this},range(){return this},limit(n){limit=n;return this},update(p){mode='update';payload=p;return this},insert(p){mode='insert';payload=p;return this},upsert(p){mode='upsert';payload=p;return this},maybeSingle(){single=true;return this},single(){single=true;return this},then(resolve,reject){try{
    if(table==='user_roles'&&mode==='select')return Promise.resolve({data:[{status:'ACTIVE',roles:{status:'ACTIVE',role_permissions:permissions.map(p=>({permissions:{status:'ACTIVE',permission_code:p}}))}}],error:null}).then(resolve,reject);
    if(!tables[table])tables[table]=[];let selected=tables[table].filter(r=>predicates.every(p=>p(r))).slice(0,limit);
    if(mode==='update')selected.forEach(r=>Object.assign(r,payload));
    if(mode==='insert'||mode==='upsert'){const newRows=(Array.isArray(payload)?payload:[payload]).map(r=>({id:table+'-'+tables[table].length,...r}));tables[table].push(...newRows);selected=newRows;}
    return Promise.resolve({data:single?(selected[0]||null):selected,error:null}).then(resolve,reject);
   }catch(error){return Promise.reject(error).then(resolve,reject);}}};return query;
 };
 const app=express();app.use(express.json({limit:'10mb'}));app.use('/admissions',admissions);app.use('/applicant',applicant);app.use(errorHandler);const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;
 async function post(path,body,authorized=true){const response=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json',...(authorized?{Authorization:'Bearer test'}:{})},body:JSON.stringify(body)});return {status:response.status,body:await response.json()};}
 try{
  assert.equal((await post('/admissions/review/bulk',{action:'VERIFY_ALL',applicationIds:['app']},false)).status,401);
  let response=await post('/admissions/review/bulk',{action:'SELECT',applicationIds:['app']});assert.equal(response.status,207);assert.equal(tables.admission_offers.length,0);
  response=await post('/admissions/review/bulk',{action:'VERIFY_ALL',applicationIds:['app']});assert.equal(response.status,200);assert.equal(tables.applications[0].status,'VERIFIED');assert.equal(verificationCalls,1);
  permissions=['applications.manage'];response=await post('/admissions/review/bulk',{action:'SELECT',applicationIds:['app']});assert.equal(response.status,403);
  permissions.push('admissions.manage');response=await post('/admissions/review/bulk',{action:'SELECT',applicationIds:['app']});assert.equal(response.status,200);assert.equal(tables.applications[0].status,'ADMISSION_OFFERED');assert.equal(tables.admission_offers.length,1);assert.equal(response.body.data.completed[0].offer.emailSent,false);assert.match(response.body.data.completed[0].offer.emailError,/verified Auth email/);
  tables.applications[0].status='SELECTED';await post('/admissions/review/bulk',{action:'SELECT',applicationIds:['app']});assert.equal(tables.admission_offers.length,1);
  tables.applications[0].status='CONVERTED_TO_STUDENT';response=await post('/admissions/review/bulk',{action:'VERIFY_ALL',applicationIds:['app']});assert.equal(response.status,207);assert.equal(tables.applications[0].status,'CONVERTED_TO_STUDENT');
  tables.applications[0].status='ADMISSION_OFFERED';
  db.rpc=async(name)=>{assert.equal(name,'convert_accepted_application_to_student');conversions++;tables.applications[0].status='CONVERTED_TO_STUDENT';tables.students.push({id:'student',source_application_id:'app',applicant_id:'person',user_id:null,student_status:'PENDING_ACTIVATION'});return {data:'student',error:null};};
  response=await post('/applicant/applications/app/offer/accept',{confirmed:true});assert.equal(response.status,201);assert.equal(response.body.data.portalLinked,true);assert.equal(conversions,1);
  tables.students[0].student_status='ACTIVE';tables.students[0].user_id=null;
  response=await post('/applicant/applications/app/offer/accept',{confirmed:true});assert.equal(response.status,200);assert.equal(response.body.data.portalLinked,true);assert.equal(tables.students[0].user_id,'user');assert.equal(tables.students[0].student_status,'ACTIVE');assert.equal(conversions,1);
  tables.students.push({id:'registration-only-student',student_number:null,registration_number:'NS1179/0269/2020',first_name:'Photo',last_name:'Match'});
  response=await post('/admissions/students/photo-matches',{studentNumbers:['NS117902692020']});assert.equal(response.status,200);assert.equal(response.body.data.matches[0].students[0].id,'registration-only-student');assert.equal(response.body.data.matches[0].students[0].identifier,'NS1179/0269/2020');
  const jpegBytes=Buffer.from([255,216,255,224,0,16,74,70,73,70,0,1]);
  response=await post('/admissions/students/registration-only-student/photo',{identifier:'NS1179/0269/2020',profilePhoto:'data:image/png;base64,'+jpegBytes.toString('base64')});assert.equal(response.status,200);assert.match(tables.students[1].profile_photo_url,/^data:image\/jpeg;base64,/);
  const maxPhoto=Buffer.alloc(5*1024*1024);Buffer.from([137,80,78,71,13,10,26,10]).copy(maxPhoto);
  response=await post('/admissions/students/registration-only-student/photo',{identifier:'NS1179/0269/2020',profilePhoto:'data:image/png;base64,'+maxPhoto.toString('base64')});assert.equal(response.status,200);assert.equal(tables.students[1].profile_photo_url.length>6*1024*1024,true);
  response=await post('/admissions/students/student/photo',{identifier:'different-student',profilePhoto:'data:image/png;base64,iVBORw0KGgo='});assert.equal(response.status,409);assert.equal(tables.students[0].profile_photo_url,undefined);
  tables.students[0].user_id='other-user';response=await post('/applicant/applications/app/offer/accept',{confirmed:true});assert.equal(response.status,409);assert.equal(tables.students[0].user_id,'other-user');
  response=await post('/admissions/review/bulk',{action:'RECONCILE',applicationIds:['app']});assert.equal(response.status,207);assert.match(response.body.data.failed[0].message,/no verified email/);assert.equal(tables.students[0].user_id,'other-user');
  db.auth.admin.getUserById=async id=>({data:{user:{id,email:'verified@example.edu',email_confirmed_at:'2026-01-01T00:00:00Z'}},error:null});
  response=await post('/admissions/review/bulk',{action:'RECONCILE',applicationIds:['app']});assert.equal(response.status,207);assert.match(response.body.data.failed[0].message,/already linked to a different IDMC account/);assert.equal(tables.students[0].user_id,'other-user');
 }finally{db.from=oldFrom;db.auth.getUser=oldAuth;db.auth.admin.getUserById=oldGetUserById;db.rpc=oldRpc;await new Promise(r=>server.close(r));}
});
