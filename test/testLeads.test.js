/**
 * Checks "Mark as test" without a server or API keys (uses a throwaway DB):
 *   node test/testLeads.test.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'testleads-'));
const db = require('../src/store/db');

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`ok - ${name}`); }

const brand = 'gfg-agency';
const real = db.insertLead({ brand, firstName: 'Real', lastName: 'Lead', status: 'active', ghlContactId: 'c-real' });
const fake = db.insertLead({ brand, firstName: 'Agency Test', lastName: 'Person', status: 'active', ghlContactId: 'c-test' });
db.updateLeadStatus(fake, 'needs_human');

test('both leads listed before marking', () => assert.strictEqual(db.listLeads({ brand }).length, 2));
test('marking needs the right brand', () => assert.strictEqual(db.setLeadTest(fake, 'grove-financial', true), 0));
test('marking the test lead changes it', () => assert.ok(db.setLeadTest(fake, brand, true) >= 1));
test('test lead hidden from the lead list (and scheduler)', () => {
  const ids = db.listLeads({ brand }).map((l) => l.id);
  assert.deepStrictEqual(ids, [real]);
});
test('still in the database', () => assert.strictEqual(db.listLeads({ brand, includeTest: true }).length, 2));
test('left out of "waiting on you"', () => assert.strictEqual(db.leadsNeedingHuman(brand).length, 0));
test('left out of the briefing', () => assert.ok(db.leadsSince(brand, '2000-01-01 00:00:00').every((l) => l.id !== fake)));
test('left out of pipeline stats', () => assert.strictEqual(db.pipelineStats(brand, 30).totalLeads, 1));
test('a re-send of the same contact stays a test', () => {
  const again = db.insertLead({ brand, firstName: 'Agency Test', lastName: 'Person', status: 'new', ghlContactId: 'c-test' });
  assert.strictEqual(db.getLead(again).is_test, 1);
});
test('undo brings it back', () => {
  db.setLeadTest(fake, brand, false);
  assert.ok(db.listLeads({ brand }).some((l) => l.id === fake));
});

console.log(`\n${passed} checks passed`);
