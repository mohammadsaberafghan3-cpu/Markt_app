'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateCommission, canRequestSettlement, canRequestRefund } = require('../lib/finance');
test('commission uses integer-cent rounding and returns seller net',()=>{
  assert.deepEqual(calculateCommission(100,10),{gross:100,commission:10,net:90});
  assert.deepEqual(calculateCommission(19.99,12.5),{gross:19.99,commission:2.5,net:17.49});
});
test('commission rejects invalid amounts and rates',()=>{
  assert.throws(()=>calculateCommission(-1,10),/gross/);
  assert.throws(()=>calculateCommission(10,51),/commission rate/);
  assert.throws(()=>calculateCommission(NaN,10),/gross/);
});
test('settlement cannot exceed balance after pending holds',()=>{
  assert.equal(canRequestSettlement(100,20,80),true);
  assert.equal(canRequestSettlement(100,20,80.01),false);
  assert.equal(canRequestSettlement(10,11,1),false);
  assert.equal(canRequestSettlement(10,0,-1),false);
});

test('refund eligibility requires paid order and no previous request',()=>{
  assert.equal(canRequestRefund('paid','new',false),true);
  assert.equal(canRequestRefund('pending','new',false),false);
  assert.equal(canRequestRefund('paid','cancelled',false),false);
  assert.equal(canRequestRefund('paid','completed',true),false);
});
