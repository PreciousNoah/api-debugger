import assert from 'node:assert/strict';
import { analyze } from './debugger.js';

const run = (s) => analyze(s).summary;

assert.equal(run('{"a":1}').verdict, 'valid');
assert.equal(run("{'a': True, b: [1,2,],}").verdict, 'repaired');
assert.equal(run('{"a": {"b": [1, 2').verdict, 'repaired');
assert.equal(run('Error: connect ECONNREFUSED 127.0.0.1:3000').verdict, 'error-text');
assert.equal(run('').verdict, 'empty');
assert.deepEqual(run('HTTP 404 Not Found').statusCodes, [404]);
console.log('All tests passed');
