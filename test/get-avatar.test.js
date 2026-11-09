'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { downloadAvatar, checkGlb } = require('../scripts/get-avatar');

const fakeGlb = () => Buffer.concat([Buffer.from('glTF'), Buffer.alloc(80000, 7)]);

function serve(routes) {
  const server = http.createServer((req, res) => {
    const r = routes[req.url.split('/').pop()];
    if (!r) { res.writeHead(404); return res.end(); }
    res.writeHead(200); res.end(r);
  });
  return new Promise(ok => server.listen(0, () => ok({ server, base: `http://localhost:${server.address().port}/avatars/` })));
}

test('checkGlb accepts a GLB and rejects junk, HTML and LFS pointers', () => {
  assert.equal(checkGlb(fakeGlb()), null);
  assert.match(checkGlb(Buffer.from('<html>' + 'x'.repeat(100000))), /not a \.glb/);
  assert.match(checkGlb(Buffer.from('version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 123456\n' + ' '.repeat(2000))), /LFS/);
  assert.match(checkGlb(Buffer.alloc(10)), /too small/);
});

test('downloadAvatar saves a valid model as avatar.glb', async () => {
  const { server, base } = await serve({ 'avatar.glb': fakeGlb(), 'mpfb.glb': fakeGlb() });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'av-'));
  try {
    const r = await downloadAvatar({ choice: 'mpfb', baseUrl: base, outDir: dir });
    assert.equal(fs.readFileSync(path.join(dir, 'avatar.glb')).toString('ascii', 0, 4), 'glTF');
    assert.ok(r.bytes > 50000);
  } finally { server.close(); }
});

test('downloadAvatar refuses bad downloads and unknown names', async () => {
  const { server, base } = await serve({ 'avatar.glb': Buffer.from('<html>not found</html>'.repeat(5000)) });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'av-'));
  try {
    await assert.rejects(downloadAvatar({ choice: 'avaturn', baseUrl: base, outDir: dir }), /not a \.glb/);
    await assert.rejects(downloadAvatar({ choice: 'brunette', baseUrl: base, outDir: dir }), /HTTP 404/);
    await assert.rejects(downloadAvatar({ choice: 'nope', baseUrl: base, outDir: dir }), /Unknown avatar/);
    assert.ok(!fs.existsSync(path.join(dir, 'avatar.glb')), 'no file must be written on failure');
  } finally { server.close(); }
});
