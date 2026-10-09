import test from 'node:test';
import assert from 'node:assert/strict';
Object.assign(process.env,{
 NODE_ENV:'test',SUPABASE_URL:'http://127.0.0.1:9',SUPABASE_SERVICE_ROLE_KEY:'test-key-only',
 JWT_SECRET:'test-secret-at-least-sixteen',SMTP_HOST:'localhost',SMTP_USER:'test@example.com',SMTP_PASSWORD:'test-only',SMTP_FROM_EMAIL:'test@example.com'
});
const {default:app}=await import('../dist/app.js');
const {getSupabase}=await import('../dist/config/database.js');
test('built academic router exposes expected patch marker and retains protected context',async()=>{
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 try{
  const base='http://127.0.0.1:'+server.address().port;
  const marker=await fetch(base+'/api/v1/academic-core/workspace/version');
  assert.equal(marker.status,200);assert.equal(marker.headers.get('cache-control'),'no-store');
  assert.equal((await marker.json()).data.patch,'20261006-v3');
  const context=await fetch(base+'/api/v1/academic-core/workspace/context');
  assert.equal(context.status,401);assert.match((await context.json()).message,/Authorization/);
  const db=getSupabase(),oldFrom=db.from,oldAuth=db.auth.getUser;
  let allowed=true;
  db.auth.getUser=async()=>({data:{user:{id:'auth-test',email:'test@example.com'}},error:null});
  db.from=table=>{
   const data=table==='users'?{id:'user-test',auth_user_id:'auth-test',status:'ACTIVE'}:table==='user_roles'?(allowed?[{status:'ACTIVE',roles:{status:'ACTIVE',role_permissions:[{permissions:{status:'ACTIVE',permission_code:'academics.view'}}]}}]:[]):table==='institutions'?[{id:'institution-test'}]:table==='departments'?[{id:'social-test',academic_group:'SOCIAL'}]:[];
   const result={data,error:null},query={select(){return this},eq(){return this},limit(){return this},order(){return this},maybeSingle(){return Promise.resolve(result)},then(resolve,reject){return Promise.resolve(result).then(resolve,reject)}};return query;
  };
  try{
   const response=await fetch(base+'/api/v1/academic-core/workspace/context',{headers:{Authorization:'Bearer test-token'}});
   assert.equal(response.status,200);const body=await response.json();assert.equal(body.data.departments[0].academic_group,'SOCIAL');
   allowed=false;
   const denied=await fetch(base+'/api/v1/academic-core/workspace/context',{headers:{Authorization:'Bearer test-token'}});
   assert.equal(denied.status,403);
  }finally{db.from=oldFrom;db.auth.getUser=oldAuth;}

 }finally{await new Promise(r=>server.close(r));}
});
