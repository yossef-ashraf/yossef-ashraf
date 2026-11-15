#!/usr/bin/env node
/**
 * Render self-contained profile SVGs from GitHub's public contribution calendar.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

export const PALETTES = {
    light: {
        paper: '#ffffff',
        ink: '#27394b',
        muted: '#73869a',
        line: '#dce4ee',
        wash: '#f3f6fa',
        cells: ['#e9eef5', '#c4d3e3', '#9fb6d0', '#7e9bb9', '#5c7b9d'],
    },
    dark: {
        paper: '#0d1117',
        ink: '#d4dfea',
        muted: '#8093a8',
        line: '#2a3747',
        wash: '#131e2b',
        cells: ['#1c2b3b', '#334d68', '#516e8f', '#7998b9', '#a9c1d9'],
    },
};

export const TOOLS = [
    ['php', 'PHP', 'PHP 8+'],
    ['laravel', 'Lv', 'Laravel'],
    ['mysql', 'SQL', 'MySQL'],
    ['postgres', 'PG', 'PostgreSQL'],
    ['redis', 'Rd', 'Redis'],
    ['docker', '▤', 'Docker'],
    ['linux', 'λ', 'Linux'],
    ['git', '◇', 'Git'],
];

const MONTH_ABBR = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function escapeXml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function parseUtcDate(isoDate) {
    const [y, m, d] = isoDate.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d));
}

function formatUtcDate(d) {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

function addDays(d, days) {
    return new Date(d.getTime() + days * 86400000);
}

function getCairoTodayIso() {
    const fmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Africa/Cairo',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    });
    return fmt.format(new Date());
}

export function parseContributionHtml(html, asOfIso) {
    const cells = new Map();
    const tips = new Map();

    const tdRegex = /<td\b([^>]*)>/gi;
    let m;
    while ((m = tdRegex.exec(html)) !== null) {
        const attrsStr = m[1];
        const idMatch = /\bid=["']([^"']+)["']/i.exec(attrsStr);
        const dateMatch = /\bdata-date=["']([^"']+)["']/i.exec(attrsStr);
        const levelMatch = /\bdata-level=["']([^"']+)["']/i.exec(attrsStr);
        if (idMatch && dateMatch && levelMatch) {
            cells.set(idMatch[1], {
                date: dateMatch[1],
                level: Number(levelMatch[1]),
            });
        }
    }

    const tipRegex = /<tool-tip\b([^>]*)>([\s\S]*?)<\/tool-tip>/gi;
    while ((m = tipRegex.exec(html)) !== null) {
        const forMatch = /\bfor=["']([^"']+)["']/i.exec(m[1]);
        if (forMatch) {
            tips.set(forMatch[1], m[2].replace(/<[^>]+>/g, '').trim());
        }
    }

    const yearPrefix = `${asOfIso.slice(0, 4)}-01-01`;
    const result = [];

    for (const [id, cell] of cells.entries()) {
        if (cell.date < yearPrefix || cell.date > asOfIso) continue;
        const tip = tips.get(id) || '';
        const countMatch = /^([\d,]+)\s+contributions?\b/i.exec(tip);
        let count;
        if (countMatch) {
            count = Number(countMatch[1].replace(/,/g, ''));
        } else if (tip.startsWith('No contributions')) {
            count = 0;
        } else {
            throw new Error(`Missing or unrecognized contribution tooltip: ${cell.date}`);
        }
        if (Boolean(count) !== Boolean(cell.level)) {
            throw new Error(`Contribution level/count mismatch: ${cell.date}`);
        }
        result.push({ ...cell, count });
    }

    result.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const startUtc = parseUtcDate(yearPrefix);
    const endUtc = parseUtcDate(asOfIso);
    const expected = Math.round((endUtc.getTime() - startUtc.getTime()) / 86400000) + 1;
    const uniqueDates = new Set(result.map((d) => d.date));
    if (result.length !== expected || uniqueDates.size !== expected) {
        throw new Error(`Incomplete calendar: expected ${expected} unique dates, got ${result.length}`);
    }
    return result;
}

export function summarize(days) {
    let run = 0;
    let longest = 0;
    let longestEnd = null;
    for (const day of days) {
        run = day.count ? run + 1 : 0;
        if (run > longest) {
            longest = run;
            longestEnd = day.date;
        }
    }
    // A day still in progress does not break yesterday's active streak.
    const active = days.length && days[days.length - 1].count ? days : days.slice(0, -1);
    let current = 0;
    for (let i = active.length - 1; i >= 0; i -= 1) {
        if (!active[i].count) break;
        current += 1;
    }
    const end = active.length && current ? parseUtcDate(active[active.length - 1].date) : null;
    return {
        total: days.reduce((sum, d) => sum + d.count, 0),
        currentStreak: current,
        longestStreak: longest,
        activeDays: days.filter((d) => Boolean(d.count)).length,
        currentStart: end ? formatUtcDate(addDays(end, -(current - 1))) : null,
        currentEnd: end ? formatUtcDate(end) : null,
        longestEnd,
    };
}

async function fetchCalendar(username, asOfIso) {
    const year = asOfIso.slice(0, 4);
    const url = `https://github.com/users/${username}/contributions?from=${year}-01-01&to=${asOfIso}`;
    for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
            const res = await fetch(url, {
                headers: {
                    'User-Agent': 'Yossef-Ashraf-profile/1.0',
                    'Accept-Language': 'en-US,en;q=0.9',
                },
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const html = await res.text();
            const days = parseContributionHtml(html, asOfIso);
            return { source: url, asOf: asOfIso, days, summary: summarize(days) };
        } catch (err) {
            if (attempt === 2) throw err;
            await new Promise((r) => setTimeout(r, (attempt + 1) * 1000));
        }
    }
}

function text(x, y, value, size = 12, color = 'var(--ink)', anchor = null, extra = '') {
    const anchorAttr = anchor ? ` text-anchor="${anchor}"` : '';
    const extraAttr = extra ? ` ${extra}` : '';
    return `<text x="${x}" y="${y}" font-size="${size}" fill="${color}"${anchorAttr}${extraAttr}>${escapeXml(value)}</text>`;
}

function box(x, y, w, h, fill = 'none', stroke = 'var(--line)', radius = 5) {
    return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${radius}" fill="${fill}" stroke="${stroke}"/>`;
}

function svg(w, h, body, theme, styles = '') {
    const p = PALETTES[theme];
    const tokens = Object.entries(p)
        .filter(([k]) => k !== 'cells')
        .map(([k, v]) => `--${k}:${v}`)
        .join(';');
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img">\n<style>:root{${tokens}}text{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif}${styles}</style>${body}</svg>`;
}

export function renderHeader(theme) {
    const w = 788;
    const h = 214;
    let art = fs.readFileSync(path.join(ROOT, 'scripts', 'header-art.svg'), 'utf8').trim();
    art = art.replace(/^<svg[^>]*>|<\/svg>$/g, '');
    const x = 29;
    const y = 72;
    let title = text(x, y, 'Yossef Ashraf', 36, 'var(--ink)', null, 'class="header-name" font-weight="600" letter-spacing="-1"');
    title += text(x, y + 30, '@yossef-ashraf', 12, '#7188a2', null, 'class="header-alias" letter-spacing="1.5"');
    title += text(x + 126, y + 30, 'Senior Backend PHP / Laravel Engineer', 12, '#748ba3', null, 'class="header-role"');
    title += text(x, y + 97, 'High-concurrency commerce, ERP sync & fault-tolerant systems.', 12, '#748ba3', null, 'class="header-tagline"');
    for (const [offset, width, color] of [[0, 20, '#aec0d3'], [25, 11, '#c0b5cb'], [41, 6, '#d6b67c']]) {
        title += box(x + offset, y + 115, width, 3, color, 'none', 0);
    }
    let styles = '.flurry{animation:snow 8s linear infinite}.two{animation-delay:-3s}.three{animation-delay:-6s}.wing{transform-origin:600px 40px;animation:wing 9s ease-in-out infinite}.window-light{animation:glow 9s ease-in-out infinite}@keyframes snow{0%{transform:translate(0,-7px);opacity:0}20%,70%{opacity:.9}100%{transform:translate(-5px,15px);opacity:0}}@keyframes wing{50%{transform:translateY(-2px) rotate(-2deg)}}@keyframes glow{50%{opacity:.65}}@media(prefers-reduced-motion:reduce){*{animation:none!important}}';
    styles += '@media(max-width:480px){.header-name{font-size:48px}.header-alias{font-size:18px}.header-role{font-size:18px}.header-tagline{font-size:18px}.wing{display:none}}';
    if (theme === 'dark') {
        styles += '.scene-ground{fill:#30445a}';
    }
    return svg(w, h, box(0.5, 0.5, w - 1, h - 1, 'var(--wash)') + `<g fill="none">${art}</g>` + title, theme, styles);
}

export function renderFocus(theme) {
    const w = 788;
    const h = 80;
    let body = `<path d="M0 .5H${w}M0 ${h - 0.5}H${w}" stroke="var(--line)"/>`;
    const lanes = [
        ['PHP 8+ & Laravel', 'Octane / Horizon / Clean Domains', '#7e9bb9'],
        ['Database & Graph', 'MySQL / PostgreSQL / Redis / Neo4j', '#98a597'],
        ['ERP, Payments & DevOps', 'POS Sync / Docker / AWS / Linux', '#aa9fba'],
    ];
    lanes.forEach(([name, detail, color], i) => {
        const x = (i * w) / 3 + (i ? 17 : 0);
        const y = 33;
        if (i) body += `<path d="M${(i * w) / 3} 17V63" stroke="var(--line)"/>`;
        body += box(x, y - 9, 8, 8, 'none', color, 1);
        body += text(x + 19, y, name, 13, 'var(--ink)', null, 'class="focus-name" font-weight="600"');
        body += text(x, y + 24, detail, 10, 'var(--muted)', null, 'class="focus-detail"');
    });
    return svg(w, h, body, theme, '@media(max-width:480px){.focus-name{font-size:20px}.focus-detail{display:none}}');
}

export function toolWidth(label) {
    return Math.trunc(35 + label.length * 6.4);
}

export function renderTool(theme, mark, label) {
    const w = toolWidth(label);
    let body = box(0.5, 0.5, w - 1, 25, 'var(--paper)', 'var(--line)', 4);
    body += box(5, 5, 17, 15, 'var(--wash)', 'none', 3);
    body += text(13.5, 16, mark, 8.5, '#718ca8', 'middle', 'font-weight="600"');
    body += text(27, 16, label, 10, 'var(--muted)');
    return svg(w, 27, body, theme);
}

export function renderStats(data, theme) {
    const w = 788;
    const h = 183;
    const s = data.summary;
    const year = data.asOf.slice(0, 4);
    const asOf = parseUtcDate(data.asOf);
    const monthNum = String(asOf.getUTCMonth() + 1).padStart(2, '0');
    const dayNum = String(asOf.getUTCDate()).padStart(2, '0');

    let body = text(0, 15, 'On GitHub', 13, 'var(--ink)', null, 'class="stats-heading" font-weight="600"');
    body += text(w, 15, `${year} · As of ${monthNum}/${dayNum}`, 10, 'var(--muted)', 'end', 'class="stats-date"');
    body += box(0.5, 30.5, w - 1, h - 31, 'var(--paper)');
    const centers = [w / 6, w / 2, (w * 5) / 6];
    for (const x of [w / 3, (w * 2) / 3]) {
        body += `<path d="M${x} 51V${h - 23}" stroke="var(--line)"/>`;
    }
    for (const [x, value, label, foot] of [
        [centers[0], s.total.toLocaleString('en-US'), 'Contributions', year],
        [centers[2], s.longestStreak, 'Longest streak', `in ${year}`],
    ]) {
        body += text(x, 107, value, 24, 'var(--ink)', 'middle', 'class="stat-value"');
        body += text(x, 132, label, 11, 'var(--muted)', 'middle', 'class="stat-label"');
        body += text(x, 151, foot, 9, 'var(--muted)', 'middle', 'class="stat-foot"');
    }
    let x = centers[0];
    body += `<g stroke="#99adc2" fill="none" stroke-width="1.2" transform="translate(${x - 7},55)"><rect width="5" height="5" rx="1"/><rect x="8" width="5" height="5" rx="1"/><rect y="8" width="5" height="5" rx="1"/><rect x="8" y="8" width="5" height="5" rx="1"/></g>`;
    x = centers[2];
    body += `<path d="M${x - 3} 55H${x + 3}V59C${x + 3} 64 ${x - 3} 64 ${x - 3} 59ZM${x - 3} 56H${x - 6}V58C${x - 6} 61 ${x - 3} 61 ${x - 3} 61M${x + 3} 56H${x + 6}V58C${x + 6} 61 ${x + 3} 61 ${x + 3} 61M${x} 63V67M${x - 3} 67H${x + 3}" stroke="#99adc2" fill="none" stroke-width="1.2"/>`;
    const cx = centers[1];
    body += `<circle cx="${cx}" cy="91" r="29" fill="none" stroke="#94aac4" stroke-width="2"/><rect x="${cx - 32}" y="88" width="6" height="6" rx="1" fill="#d6b67c" stroke="var(--paper)" stroke-width="2"/>`;
    body += text(cx, 99, s.currentStreak, 24, 'var(--ink)', 'middle', 'class="stat-value"');
    body += text(cx, 132, 'Current streak', 11, '#6582a1', 'middle', 'class="stat-label"');
    let span = 'No active streak';
    if (s.currentStart) {
        const start = parseUtcDate(s.currentStart);
        const end = parseUtcDate(s.currentEnd);
        span = `${MONTH_ABBR[start.getUTCMonth() + 1]} ${String(start.getUTCDate()).padStart(2, '0')} – ${MONTH_ABBR[end.getUTCMonth() + 1]} ${String(end.getUTCDate()).padStart(2, '0')}`;
    }
    body += text(cx, 151, span, 9, 'var(--muted)', 'middle', 'class="stat-foot"');
    const styles = '@media(max-width:480px){.stat-value{font-size:40px}.stat-label{font-size:21px}.stat-foot{font-size:16px}.stats-heading{font-size:22px}.stats-date{display:none}}';
    return svg(w, h, body, theme, styles);
}

export function renderSnake(data, theme) {
    const w = 788;
    const h = 225;
    const x0 = 50;
    const y0 = 65;
    const days = data.days;
    const first = parseUtcDate(days[0].date);
    const origin = addDays(first, -first.getUTCDay());
    const last = parseUtcDate(days[days.length - 1].date);
    const weeks = Math.floor((last.getTime() - origin.getTime()) / (7 * 86400000)) + 1;
    const step = Math.min(16, (w - 90) / weeks);
    const cell = step * 0.75;

    let body = box(0.5, 0.5, w - 1, h - 1, 'var(--wash)');
    body += box(21, 24, 5, 5, '#d6b67c', 'none', 1) + text(32, 30, 'Contribution trail', 11);
    body += text(w - 21, 30, `Jan 01 — ${MONTH_ABBR[last.getUTCMonth() + 1]} ${String(last.getUTCDate()).padStart(2, '0')}, ${last.getUTCFullYear()}`, 9, 'var(--muted)', 'end');

    let styles = '';
    let month = null;
    days.forEach((day, i) => {
        const d = parseUtcDate(day.date);
        const diffDays = Math.round((d.getTime() - origin.getTime()) / 86400000);
        const col = Math.floor(diffDays / 7);
        const row = diffDays % 7;
        const x = x0 + col * step;
        const y = y0 + row * step;
        const eat = ((col * 7 + (col % 2 ? 6 - row : row)) / (weeks * 7)) * 100;
        const anim = day.count ? ` style="animation:eat${i} 34s linear infinite"` : '';
        body += `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${cell.toFixed(2)}" height="${cell.toFixed(2)}" rx="2" fill="${PALETTES[theme].cells[day.level]}"${anim}><title>${day.date}: ${day.count} contributions</title></rect>`;
        if (day.count) {
            styles += `@keyframes eat${i}{0%,${Math.max(0, eat - 0.12).toFixed(3)}%{opacity:1}${(eat + 0.12).toFixed(3)}%,91%{opacity:.17}100%{opacity:1}}`;
        }
        const m = d.getUTCMonth() + 1;
        if (m !== month) {
            month = m;
            body += text(x, 53, MONTH_ABBR[month], 9, 'var(--muted)');
        }
    });

    for (const [label, row] of [['M', 1], ['W', 3], ['F', 5]]) {
        body += text(27, y0 + row * step + 9, label, 8, 'var(--muted)');
    }

    const points = [];
    for (let col = 0; col < weeks; col += 1) {
        for (let j = 0; j < 7; j += 1) {
            const row = col % 2 ? 6 - j : j;
            points.push([x0 + col * step + cell / 2, y0 + row * step + cell / 2]);
        }
    }
    const svgPath = `M${points.map(([px, py]) => `${px.toFixed(2)},${py.toFixed(2)}`).join(' L')}`;
    for (let i = 6; i >= 0; i -= 1) {
        const fill = i === 0 ? '#726789' : '#9e94b3';
        body += `<rect class="snake" x="-5" y="-5" width="10" height="10" rx="2" fill="${fill}" opacity="${(1 - i * 0.07).toFixed(2)}"><animateMotion dur="34s" repeatCount="indefinite" path="${svgPath}" begin="${(-1 - i * 0.095).toFixed(3)}s" calcMode="linear"/></rect>`;
    }

    body += text(21, h - 17, 'Keep architecting, one commit at a time.', 9, 'var(--muted)');
    body += text(w - 124, h - 17, 'Less', 9, 'var(--muted)');
    PALETTES[theme].cells.forEach((color, i) => {
        body += box(w - 98 + i * 10, h - 24, 7, 7, color, 'none', 1);
    });
    body += text(w - 21, h - 17, 'More', 9, 'var(--muted)', 'end');
    styles += '@media(prefers-reduced-motion:reduce){*{animation:none!important}.snake{display:none}}';
    return svg(w, h, body, theme, styles);
}

export function writeAssets(data) {
    const dest = path.join(ROOT, 'assets');
    fs.mkdirSync(dest, { recursive: true });
    for (const theme of Object.keys(PALETTES)) {
        for (const [name, value] of [
            ['header', renderHeader(theme)],
            ['focus', renderFocus(theme)],
            ['stats', renderStats(data, theme)],
            ['snake', renderSnake(data, theme)],
        ]) {
            fs.writeFileSync(path.join(dest, `${name}-${theme}.svg`), `${value}\n`, 'utf8');
        }
        for (const [slug, mark, label] of TOOLS) {
            fs.writeFileSync(path.join(dest, `tool-${slug}-${theme}.svg`), `${renderTool(theme, mark, label)}\n`, 'utf8');
        }
    }
}

async function main() {
    const args = process.argv.slice(2);
    let asOf = getCairoTodayIso();
    let snapshotPath = null;
    for (let i = 0; i < args.length; i += 1) {
        if (args[i] === '--as-of' && args[i + 1]) asOf = args[++i];
        if (args[i] === '--snapshot' && args[i + 1]) snapshotPath = path.resolve(args[++i]);
    }

    let data;
    if (snapshotPath) {
        data = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
        data.asOf = data.asOf || data.days[data.days.length - 1].date;
        data.summary = summarize(data.days);
    } else {
        data = await fetchCalendar('yossef-ashraf', asOf);
    }

    writeAssets(data);
    const dataDir = path.join(ROOT, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'contributions.json'), `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    console.log(`Rendered profile assets: ${data.asOf}, ${data.summary.total} contributions`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
