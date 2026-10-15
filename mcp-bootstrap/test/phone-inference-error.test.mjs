import test from 'node:test';
import assert from 'node:assert/strict';
import {inferenceFailure,PhoneInferenceError} from '../dist/phone-inference-error.js';
test('429 is not quota exhaustion and diagnostic output excludes secret response bodies',()=>{
 const r=inferenceFailure(new PhoneInferenceError('429 Too Many Requests secret-token',{responseStreamDisconnected:{httpStatusCode:429,body:'secret-token'}}));
 assert.equal(r.code,'rate_limit');assert.equal(r.http_status,429);assert.equal(r.provider_code,'responseStreamDisconnected');
 assert.ok(!JSON.stringify(r).includes('secret-token'));
 assert.equal(inferenceFailure(new Error("You’ve hit your usage limit")).code,'quota');
});
