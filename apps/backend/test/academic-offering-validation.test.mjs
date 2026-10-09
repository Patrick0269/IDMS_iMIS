import test from 'node:test';import assert from 'node:assert/strict';
Object.assign(process.env,{NODE_ENV:'test',SUPABASE_URL:'http://127.0.0.1:9',SUPABASE_SERVICE_ROLE_KEY:'test-key-only',JWT_SECRET:'test-secret-at-least-sixteen',SMTP_HOST:'localhost',SMTP_USER:'test@example.com',SMTP_PASSWORD:'test-only',SMTP_FROM_EMAIL:'test@example.com'});
const {validateOffering}=await import('../dist/modules/academic-core/academic-validation.js');
const {getSupabase}=await import('../dist/config/database.js');
const row={offering_code:'BAD-04101-2026-S1-SW',capacity:0,minimum_students:0,academic_year_id:'year',semester_id:'sem',programme_id:'sw',programme_version_id:'v',course_id:'bad'};
test('offering rejects impossible minimum/capacity and date ordering before writing',async()=>{
 await assert.rejects(()=>validateOffering({...row,capacity:100,minimum_students:300}),/Minimum students/);
 await assert.rejects(()=>validateOffering({...row,registration_open_at:'2026-10-06',registration_close_at:'2026-10-05'}),/closing time/);
});
test('offering retains zero-capacity semantics, requires mapping and handles duplicate codes explicitly',async()=>{
 const db=getSupabase(),old=db.from;let mapped=true,duplicate=null;
 db.from=table=>{const data=table==='semesters'?{academic_year_id:'year',semester_number:1}:table==='programme_versions'?{programme_id:'sw',status:'ACTIVE'}:table==='courses'?{id:'bad',status:'ACTIVE'}:table==='curricula'?[{id:'cu'}]:table==='curriculum_courses'?(mapped?{id:'mapping'}:null):duplicate;const result={data,error:null};return{select(){return this},eq(){return this},in(){return this},limit(){return this},maybeSingle(){return Promise.resolve(result)},then(resolve,reject){return Promise.resolve(result).then(resolve,reject)}};};
 try{await validateOffering(row);mapped=false;await assert.rejects(()=>validateOffering(row),/Map this course/);mapped=true;duplicate={id:'existing'};await assert.rejects(()=>validateOffering(row),error=>error.statusCode===409);await validateOffering(row,{id:'existing'});}finally{db.from=old;}
});
