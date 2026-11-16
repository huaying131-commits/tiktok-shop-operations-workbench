import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {authorizedImageType} from '../scripts/upload-image-type.mjs';

test('Recognizes this run real PNG and source JPEG without re-encoding',()=>{
  assert.equal(authorizedImageType(fs.readFileSync('outputs/product-sourcing-2026-10-10/products/keyboard26/images/01-hero.png')),'image/png');
  assert.equal(authorizedImageType(fs.readFileSync('outputs/product-sourcing-2026-10-10/products/ghost/images/05-white.jpg')),'image/jpeg');
});
test('Rejects plain text, unsupported GIF, truncated JPEG and oversized bytes',()=>{
  for(const b of [Buffer.from('not an image'),Buffer.from('GIF89a'),Buffer.from([0xff,0xd8,0xff,0,0]),Buffer.alloc(5*1024*1024+1)])
    assert.throws(()=>authorizedImageType(b));
});
