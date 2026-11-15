import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseContributionHtml, summarize } from '../scripts/generate_profile.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('parses formatted counts and ignores future dates', () => {
    const html = `
        <td id="a" data-date="2026-01-01" data-level="4"></td>
        <tool-tip for="a">1,234 contributions on January 1st.</tool-tip>
        <td id="b" data-date="2026-01-02" data-level="0"></td>
        <tool-tip for="b">No contributions on January 2nd.</tool-tip>
    `;
    assert.deepEqual(parseContributionHtml(html, '2026-01-01'), [
        { date: '2026-01-01', level: 4, count: 1234 },
    ]);
});

test('missing tooltip throws instead of defaulting to zero', () => {
    const html = '<td id="a" data-date="2026-01-01" data-level="0"></td>';
    assert.throws(() => parseContributionHtml(html, '2026-01-01'));
});

test('missing calendar date is rejected', () => {
    const html = '<td id="a" data-date="2026-01-02" data-level="0"></td><tool-tip for="a">No contributions on January 2nd.</tool-tip>';
    assert.throws(() => parseContributionHtml(html, '2026-01-02'));
});

test('unfinished day preserves yesterday streak', () => {
    const days = [1, 2, 0, 3, 4, 5, 0].map((count, i) => ({
        date: `2026-01-${String(i + 1).padStart(2, '0')}`,
        count,
    }));
    const s = summarize(days);
    assert.equal(s.currentStreak, 3);
    assert.equal(s.longestStreak, 3);
    assert.equal(s.currentStart, '2026-01-04');
    assert.equal(s.currentEnd, '2026-01-06');
    assert.equal(s.total, 15);
    assert.equal(summarize([...days, { date: '2026-01-08', count: 0 }]).currentStreak, 0);
});

test('picture sources keep the same aspect ratio and safe width', () => {
    const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    const pictures = readme.match(/<picture>[\s\S]*?<\/picture>/g) || [];
    assert.ok(pictures.length > 0);
    for (const fragment of pictures) {
        const imgMatch = /<img[^>]*src=["']([^"']+)["'][^>]*width=["'](\d+)["']|<img[^>]*width=["'](\d+)["'][^>]*src=["']([^"']+)["']/i.exec(fragment);
        assert.ok(imgMatch, 'Expected fallback <img> with src and width');
        const imgSrc = imgMatch[1] || imgMatch[4];
        const displayed = Number(imgMatch[2] || imgMatch[3]);

        const baseSvg = fs.readFileSync(path.join(ROOT, imgSrc), 'utf8');
        const baseDims = /width=["'](\d+)["'][^>]*height=["'](\d+)["']/i.exec(baseSvg);
        assert.ok(baseDims);
        const ratio = Number(baseDims[1]) / Number(baseDims[2]);

        const sources = [...fragment.matchAll(/<source[^>]*srcset=["']([^"']+)["']/gi)];
        for (const [, srcset] of sources) {
            const artSvg = fs.readFileSync(path.join(ROOT, srcset), 'utf8');
            const artDims = /width=["'](\d+)["'][^>]*height=["'](\d+)["']/i.exec(artSvg);
            assert.ok(artDims);
            assert.ok(Number(artDims[1]) >= displayed);
            assert.ok(Math.abs(Number(artDims[1]) / Number(artDims[2]) - ratio) < 0.001);
        }
    }
});
