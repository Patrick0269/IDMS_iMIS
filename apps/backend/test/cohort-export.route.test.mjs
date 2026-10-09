import assert from "node:assert/strict";
import test from "node:test";

Object.assign(process.env, {
  NODE_ENV: "test", SUPABASE_URL: "http://127.0.0.1:9", SUPABASE_SERVICE_ROLE_KEY: "test-key-only",
  JWT_SECRET: "test-secret-at-least-sixteen", SMTP_HOST: "localhost", SMTP_USER: "test@example.com",
  SMTP_PASSWORD: "test-only", SMTP_FROM_EMAIL: "test@example.com",
});
const { default: app } = await import("../dist/app.js");
const { getSupabase } = await import("../dist/config/database.js");

class FakeQuery {
  constructor(table,state){this.table=table;this.state=state;this.filters=[];this.start=0;this.end=999;this.inserted=null;}
  select(){return this;} eq(k,v){this.filters.push([k,v]);if(this.table==="student_cohorts"&&k==="institution_id"&&v==="idms-tenant")this.state.tenantFilterSeen=true;return this;} neq(k,v){this.filters.push([k,{neq:v}]);return this;}
  is(k,v){this.filters.push([k,{is:v}]);return this;} order(){return this;} or(){return this;} limit(){return this;}
  in(k,v){this.filters.push([k,{in:v}]);return this;} range(a,b){this.start=a;this.end=b;return this;}
  insert(v){this.inserted=v;return this;} maybeSingle(){return Promise.resolve(this.resolve(true));}
  single(){return Promise.resolve(this.resolve(true));} then(ok,bad){return Promise.resolve(this.resolve()).then(ok,bad);}
  resolve(single=false){
    if(this.inserted){this.state.audit.push(this.inserted);return {data:this.inserted,error:null};}
    let rows=[];
    if(this.table==="institutions")rows=[{id:"idms-tenant",institution_code:"IDMS"}];
    else if(this.table==="users")rows=[{id:"user-1",auth_user_id:"auth-1",user_number:"U1",email:"test@example.com",first_name:"Test",last_name:"User",status:"ACTIVE"}];
    else if(this.table==="user_roles")rows=[{user_id:"user-1",status:"ACTIVE",expires_at:null,roles:{status:"ACTIVE",role_permissions:[{permissions:{status:"ACTIVE",permission_code:this.state.permission}}]}}];
    else if(this.table==="student_cohorts"){
      if(this.state.large){rows=Array.from({length:Math.min(1000,this.end-this.start+1)},(_,i)=>({id:`large-${this.start+i}`,institution_id:"idms-tenant",cohort_code:`C-${this.start+i}`,cohort_name:"Large export",entry_year:2026,status:"ACTIVE"}));return {data:rows,count:10001,error:null};}
      rows=this.state.cohorts;
    } else if(this.table==="students")rows=this.state.students;
    else if(this.table==="programmes")rows=[{id:"programme-1",programme_code:"CS",programme_name:"Computer Science"}];
    for(const [key,value] of this.filters)rows=rows.filter(row=>{
      if(value&&typeof value==="object"&&"neq"in value)return row[key]!==value.neq;
      if(value&&typeof value==="object"&&"is"in value)return row[key]===value.is;
      if(value&&typeof value==="object"&&"in"in value)return value.in.includes(row[key]);
      return row[key]===value;
    });
    const count=rows.length;rows=rows.slice(this.start,this.end+1);return {data:single?(rows[0]??null):rows,count,error:null};
  }
}
async function withExportServer(large,callback){
  const db=getSupabase(),oldFrom=db.from,oldRpc=db.rpc,oldGetUser=db.auth.getUser;
  const state={large,audit:[],queries:[],rpcCalls:[],permission:"cohorts.view",tenantFilterSeen:false,cohorts:[
    {id:"55555555-5555-4555-8555-555555555555",institution_id:"idms-tenant",cohort_code:"CSV-1",cohort_name:"=SUM(1,2)",programme_id:"programme-1",entry_year:2026,intake_code:"MARCH",study_mode:"FULL_TIME",max_capacity:30,status:"ACTIVE",notes:'note, "quoted"',programme_version_id:null},
    {id:"66666666-6666-4666-8666-666666666666",institution_id:"other-tenant",cohort_code:"OTHER-1",cohort_name:"must-not-leak",programme_id:"programme-1",entry_year:2026,intake_code:"MARCH",study_mode:"FULL_TIME",max_capacity:30,status:"ACTIVE"},
  ],students:[{id:"77777777-7777-4777-8777-777777777777",institution_id:"idms-tenant",cohort_id:null,archived_at:null,student_number:"IDMS/2026/0001",student_status:"ACTIVE",programme_id:"programme-1",programme_version_id:null}]};
  db.auth.getUser=async()=>({data:{user:{id:"auth-1",email:"test@example.com"}},error:null});
  db.from=table=>{state.queries.push(table);return new FakeQuery(table,state);};
  db.rpc=async(name,args)=>{state.rpcCalls.push({name,args});if(name==="get_cohort_student_counts")return {data:(args.p_cohort_ids||[]).map(cohort_id=>({cohort_id,student_count:4})),error:null};if(name==="assign_students_to_cohort")return {data:args.p_student_ids.length,error:null};return {data:null,error:{message:`Unexpected RPC ${name}`}};};
  const server=app.listen(0,"127.0.0.1");await new Promise(resolve=>server.once("listening",resolve));
  try{await callback(`http://127.0.0.1:${server.address().port}`,state);}
  finally{await new Promise(resolve=>server.close(resolve));db.from=oldFrom;db.rpc=oldRpc;db.auth.getUser=oldGetUser;}
}
test("cohort CSV endpoint exports escaped rows only for IDMS and records the export",async()=>{
  await withExportServer(false,async(base,state)=>{
    const response=await fetch(`${base}/api/v1/cohorts/export.csv?programmeId=programme-1&admissionYear=2026&status=ACTIVE`,{headers:{Authorization:"Bearer test-token"}});
    assert.equal(response.status,200,await response.clone().text());assert.match(response.headers.get("content-type"),/text\/csv; charset=utf-8/);assert.match(response.headers.get("content-disposition"),/idmc-cohorts\.csv/);
    const bytes=new Uint8Array(await response.arrayBuffer());
    assert.deepEqual([...bytes.subarray(0,3)],[0xef,0xbb,0xbf]);
    const csv=new TextDecoder().decode(bytes.subarray(3));
    assert.ok(csv.startsWith("cohort_code,cohort_name,programme,programme_version,entry_year,intake_code,intake_name,academic_year,start_date,expected_completion_date,study_mode,campus,max_capacity,status,student_count,notes"));
    assert.match(csv,/"CSV-1","'=SUM\(1,2\)","CS · Computer Science"/);assert.match(csv,/"4","note, ""quoted"""/);assert.doesNotMatch(csv,/OTHER-1|must-not-leak/);
    assert.equal(state.tenantFilterSeen,true);assert.equal(state.audit.length,1);assert.equal(state.audit[0].action_code,"COHORT_EXPORT");assert.equal(state.audit[0].new_values.count,1);
  });
});
test("cohort CSV endpoint rejects exports above 10,000 rows instead of truncating",async()=>{
  await withExportServer(true,async(base,state)=>{
    const response=await fetch(`${base}/api/v1/cohorts/export.csv`,{headers:{Authorization:"Bearer test-token"}});
    assert.equal(response.status,413,await response.clone().text());assert.match((await response.json()).message,/exceeds 10,000 cohorts/i);assert.equal(state.audit.length,0);
  });
});

test("cohort view permission cannot assign students or write audit data",async()=>{
  await withExportServer(false,async(base,state)=>{
    const cohortId="55555555-5555-4555-8555-555555555555";
    const response=await fetch(`${base}/api/v1/cohorts/${cohortId}/students`,{method:"POST",headers:{Authorization:"Bearer test-token","Content-Type":"application/json"},body:JSON.stringify({studentIds:["77777777-7777-4777-8777-777777777777"],reason:"approved transfer"})});
    assert.equal(response.status,403);
    assert.match((await response.json()).message,/cohorts\.manage/);
    assert.ok(state.queries.includes("user_roles"));
    assert.ok(!state.queries.includes("student_cohorts"));
    assert.ok(!state.queries.includes("students"));
    assert.deepEqual(state.rpcCalls,[]);
    assert.deepEqual(state.audit,[]);
  });
});

test("cohort manage permission assigns an eligible IDMS student through RPC and audits the change",async()=>{
  await withExportServer(false,async(base,state)=>{
    state.permission="cohorts.manage";
    const cohortId="55555555-5555-4555-8555-555555555555";
    const studentId="77777777-7777-4777-8777-777777777777";
    const response=await fetch(`${base}/api/v1/cohorts/${cohortId}/students`,{method:"POST",headers:{Authorization:"Bearer test-token","Content-Type":"application/json"},body:JSON.stringify({studentIds:[studentId],reason:"approved cohort transfer"})});
    assert.equal(response.status,200,await response.clone().text());
    const body=await response.json();assert.equal(body.data.updated,1);assert.deepEqual(body.data.studentIds,[studentId]);
    assert.equal(state.rpcCalls.length,1);assert.equal(state.rpcCalls[0].name,"assign_students_to_cohort");
    assert.equal(state.rpcCalls[0].args.p_cohort_id,cohortId);assert.deepEqual(state.rpcCalls[0].args.p_student_ids,[studentId]);
    assert.equal(state.audit.length,1);assert.equal(state.audit[0].action_code,"COHORT_STUDENTS_ASSIGNED");
  });
});
