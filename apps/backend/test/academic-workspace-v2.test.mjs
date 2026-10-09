import test from 'node:test';
import assert from 'node:assert/strict';
import {periodMappings,offeringAllowed} from '../dist/modules/academic-core/academic-eligibility.js';
test('registration uses only mappings in its semester',()=>{
 const rows=[{course_id:'a',semester_number:1,credit_units:8},{course_id:'b',semester_number:2,credit_units:10}];
 assert.deepEqual(periodMappings(rows,1).map(r=>r.course_id),['a']);
 assert.throws(()=>periodMappings(rows,0),/semester/);
});
test('conflicting active curriculum credits require explicit correction',()=>{
 assert.throws(()=>periodMappings([{course_id:'a',semester_number:1,credit_units:8},{course_id:'a',semester_number:1,credit_units:10}],1),/Conflicting/);
 assert.throws(()=>periodMappings([{course_id:'a',semester_number:1,credit_units:-1}],1),/Invalid/);
});
test('offering choice respects own version or explicit shared-course eligibility',()=>{
 assert.equal(offeringAllowed({programme_id:'p',programme_version_id:'old',course_id:'a'},'p','new',new Set()),false);
 assert.equal(offeringAllowed({programme_id:'p',programme_version_id:'new',course_id:'a'},'p','new',new Set()),true);
 assert.equal(offeringAllowed({programme_id:'other',course_id:'a'},'p','new',new Set()),false);
 assert.equal(offeringAllowed({programme_id:'other',course_id:'a'},'p','new',new Set(['a'])),true);
 assert.equal(offeringAllowed({programme_id:'p',programme_version_id:'old',course_id:'a'},'p','new',new Set(['a'])),true);
});
