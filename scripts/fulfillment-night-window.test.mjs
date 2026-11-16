import test from 'node:test';
import assert from 'node:assert/strict';
import {withinWorkWindow} from './ziniao-cdp.mjs';
test('normal window remains 09:00 inclusive to 23:00 exclusive Beijing',()=>{
 for(const [time,expected] of [['00:59:59',false],['01:00:00',true],['14:59:59',true],['15:00:00',false]])assert.equal(withinWorkWindow(new Date('2026-10-13T'+time+'Z')),expected);
});
test('night round is date-bound and fulfillment-module-only, closes at midnight',()=>{
 const args=['exec','--module','procurement_fulfillment'];
 assert.equal(withinWorkWindow(new Date('2026-10-13T15:00:00Z'),args,'2026-10-13'),true);
 assert.equal(withinWorkWindow(new Date('2026-10-13T15:59:59Z'),args,'2026-10-13'),true);
 assert.equal(withinWorkWindow(new Date('2026-10-13T16:00:00Z'),args,'2026-10-13'),false);
 assert.equal(withinWorkWindow(new Date('2026-10-14T15:00:00Z'),args,'2026-10-13'),false);
 for(const denied of [[],['--module','ads'],['--module','procurement_fulfillment','--module','ads'],['--module=ads']])assert.equal(withinWorkWindow(new Date('2026-10-13T15:00:00Z'),denied,'2026-10-13'),false);
 assert.equal(withinWorkWindow(new Date('2026-10-13T15:00:00Z'),args,''),false);
});
