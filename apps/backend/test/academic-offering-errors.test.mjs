import test from 'node:test';import assert from 'node:assert/strict';import express from 'express';
import {errorHandler} from '../dist/middleware/errorHandler.js';
test('plain Supabase failures retain useful safe codes instead of becoming opaque 500 errors',async()=>{
 const cases=[['23505',409],['23503',409],['23514',400],['42703',503],['PGRST204',503],['PGRST202',503],['P0001',400]];
 const app=express();app.get('/:code',(req,_res,next)=>next({code:req.params.code,message:'private database details password=do-not-expose',details:'private row',hint:'private hint'}));app.use(errorHandler);
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 try{for(const [code,status] of cases){const response=await fetch('http://127.0.0.1:'+server.address().port+'/'+code);const body=await response.json();assert.equal(response.status,status,code);assert.equal(body.errorCode,code);assert.doesNotMatch(body.message,/private|do-not-expose/);}
 const response=await fetch('http://127.0.0.1:'+server.address().port+'/UNKNOWN');assert.equal(response.status,500);assert.doesNotMatch((await response.json()).message,/private|do-not-expose/);
 }finally{await new Promise(r=>server.close(r));}
});
