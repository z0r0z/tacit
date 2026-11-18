#!/usr/bin/env node
// The forwarder starts with the ids the route uses: a chain's, a pool's, or the multi-keeper service's "k". Run: node worker-relay/tests/evm-pool-forwarder-config.test.mjs
import assert from 'node:assert';
import { gatewaysOf } from '../src/evm-pool-forwarder.js';

const URL1 = 'https://keepers.example/sealed';
assert.deepStrictEqual(gatewaysOf(JSON.stringify({ k: URL1 })), { k: URL1 }, 'the service id the pages use starts');
assert.ok(gatewaysOf(JSON.stringify({ 1: URL1, '1-xdac17f958d': URL1, k: URL1 })), 'chain, pool and service ids together');
assert.throws(() => gatewaysOf(JSON.stringify({ 'a b': URL1 })), /not an id/, 'a bad id is refused');
assert.throws(() => gatewaysOf(JSON.stringify({ k: 'http://keepers.example/sealed' })), /https/, 'a plain-http gateway is refused');
assert.throws(() => gatewaysOf('nope'), /not JSON/, 'not JSON is refused');
console.log('  ok - the forwarder takes chain, pool and service ids, refuses bad ones\n1 passed');
