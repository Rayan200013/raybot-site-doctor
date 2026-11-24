import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodePng, luminance, contrast } from '../../src/core/png.ts';
import { imageSize } from '../../src/core/image-size.ts';
import { noisePng, solidPng } from '../helpers/fixture-server.ts';

test('decodes the PNGs it is given, pixel for pixel', () => {
  const solid = decodePng(solidPng(5, 3, [10, 200, 30]));
  assert.equal(solid.width, 5);
  assert.equal(solid.height, 3);
  assert.deepEqual([...solid.rgb.slice(0, 3)], [10, 200, 30]);
  assert.deepEqual([...solid.rgb.slice(-3)], [10, 200, 30]);
  const noise = decodePng(noisePng(40, 20));
  assert.equal(noise.rgb.length, 40 * 20 * 3);
});

test('WCAG contrast: black on white is 21:1, grey #767676 on white is 4.54:1', () => {
  assert.equal(contrast(luminance(0, 0, 0), luminance(255, 255, 255)).toFixed(0), '21');
  assert.equal(contrast(luminance(118, 118, 118), luminance(255, 255, 255)).toFixed(2), '4.54');
});

test('picture sizes from their first bytes', () => {
  assert.deepEqual(imageSize(solidPng(1200, 630, [0, 0, 0])), {
    width: 1200,
    height: 630,
    type: 'png',
  });
  const gif = Buffer.from('474946383961' + '2c01' + 'c800' + '00'.repeat(20), 'hex');
  assert.deepEqual(imageSize(gif), { width: 300, height: 200, type: 'gif' });
  // A JPEG: SOI, an APP0 segment (16 bytes long), then an SOF0 frame header of 640×480.
  const jpeg = Buffer.from(
    'ffd8' + 'ffe00010' + '00'.repeat(14) + 'ffc0001108' + '01e0' + '0280' + '03' + '00'.repeat(12),
    'hex',
  );
  assert.deepEqual(imageSize(jpeg), { width: 640, height: 480, type: 'jpeg' });
  assert.equal(imageSize(Buffer.from('not a picture at all, just text')), null);
});
