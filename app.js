(() => {
  'use strict';

  /* ================= helpers ================= */
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const mobile = () => matchMedia('(max-width: 820px)').matches;
  const km = (a, b) => d3.geoDistance(a, b) * 6371;
  const hash = (s) => { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
  const fmtDate = (t) => new Intl.DateTimeFormat('es', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(t));
  const fmtPop = (n) => n >= 1e6 ? `${(n / 1e6).toLocaleString('es', { maximumFractionDigits: 1 })} M hab.` : n >= 1e3 ? `${Math.round(n / 1e3).toLocaleString('es')} mil hab.` : '';
  const plural = (n, one, many) => `${n.toLocaleString('es')} ${n === 1 ? one : many}`;
  const flagUrl = (iso) => /^[A-Z]{2}$/.test(iso) ? `https://flagcdn.com/w80/${iso.toLowerCase()}.png` : '';
  const TOTAL_COUNTRIES = 195;

  /* ================= storage (Supabase) ================= */
  const SB_URL = 'https://hysioxvakvldiunvhoaj.supabase.co';
  const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imh5c2lveHZha3ZsZGl1bnZob2FqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE1NTYyMzcsImV4cCI6MjEwNzEzMjIzN30.ky0o-DibWvW9m1An2mv2z-tA3xkRqtIQ7fEneoB27lc';
  const BUCKET = 'viajes';
  const MAX_UPLOAD = 50 * 1024 * 1024;
  const sb = supabase.createClient(SB_URL, SB_KEY, { auth: { persistSession: true, autoRefreshToken: true } });

  const placeFromRow = (r) => ({
    id: r.id, type: r.type, iso: r.iso, name: r.name || '', lat: r.lat, lon: r.lon, admin: r.admin || '', pop: Number(r.pop) || 0,
    coverId: r.cover_id || null, from: r.date_from || '', to: r.date_to || '', createdAt: Number(r.created_ms), createdBy: r.created_by,
  });
  const placeToRow = (p) => ({
    id: p.id, type: p.type, iso: p.iso, name: p.name ?? null, lat: p.lat ?? null, lon: p.lon ?? null, admin: p.admin ?? null, pop: p.pop ?? null,
    cover_id: p.coverId ?? null, date_from: p.from || null, date_to: p.to || null, created_ms: Math.round(p.createdAt || Date.now()),
  });
  const mediaFromRow = (r) => ({
    id: r.id, placeId: r.place_id, kind: r.kind, path: r.path, thumbPath: r.thumb_path, w: r.w, h: r.h, duration: r.duration || 0,
    name: r.name || '', type: r.type || '', size: Number(r.size) || 0, title: r.title || '', text: r.body || '', featured: !!r.featured,
    takenAt: Number(r.taken_ms), createdAt: Number(r.created_ms), createdBy: r.created_by,
  });
  const mediaToRow = (m) => ({
    id: m.id, place_id: m.placeId, kind: m.kind, path: m.path ?? null, thumb_path: m.thumbPath ?? null, w: m.w ?? null, h: m.h ?? null,
    duration: m.duration ?? null, name: m.name ?? null, type: m.type ?? null, size: m.size ?? null, title: m.title ?? null, body: m.text ?? null,
    featured: !!m.featured, taken_ms: Math.round(m.takenAt || Date.now()), created_ms: Math.round(m.createdAt || Date.now()),
  });

  const DB = {
    async all(store) {
      const out = [];
      for (let from = 0; ; from += 1000) {
        const { data, error } = await sb.from(store).select('*').range(from, from + 999);
        if (error) throw error;
        out.push(...data);
        if (data.length < 1000) break;
      }
      return out.map(store === 'places' ? placeFromRow : mediaFromRow);
    },
    async put(store, ...vals) {
      const { error } = await sb.from(store).upsert(vals.map(store === 'places' ? placeToRow : mediaToRow));
      if (error) throw error;
    },
    async del(store, ...ids) {
      if (!ids.length) return;
      if (store === 'media') {
        const paths = ids.flatMap((id) => { const m = S.media.get(id); return m ? [m.path, m.thumbPath].filter(Boolean) : []; });
        if (paths.length) await sb.storage.from(BUCKET).remove(paths);
      }
      const { error } = await sb.from(store).delete().in('id', ids);
      if (error) throw error;
    },
    async upload(path, blob) {
      const { error } = await sb.storage.from(BUCKET).upload(path, blob, { contentType: blob.type || 'application/octet-stream', upsert: true, cacheControl: '31536000' });
      if (error) throw error;
    },
  };

  /* signed URLs for the private bucket, cached by path */
  const urlCache = new Map();
  async function sign(paths) {
    const need = [...new Set(paths.filter((x) => x && !urlCache.has(x)))];
    for (let i = 0; i < need.length; i += 400) {
      const { data, error } = await sb.storage.from(BUCKET).createSignedUrls(need.slice(i, i + 400), 60 * 60 * 24);
      if (error) continue;
      data.forEach((d) => d.signedUrl && urlCache.set(d.path, d.signedUrl));
    }
  }
  const signMedia = (list, full = false) => sign(list.flatMap((m) => (full ? [m.thumbPath, m.path] : [m.thumbPath || (m.kind === 'image' ? m.path : null)])));

  /* ================= state ================= */
  const S = {
    places: new Map(),
    media: new Map(),
    focus: null,
    tempCity: null,
    album: null,
    k: 1,
  };

  const FEATURES = COUNTRIES.features;
  const byIso = new Map();
  for (const f of FEATURES) if (!byIso.has(f.properties.iso)) byIso.set(f.properties.iso, f);
  const CITY = CITIES.map((c, i) => ({ key: 'ne' + i, name: c[0], iso: c[1], lat: c[2], lon: c[3], pop: c[4], cap: c[5], admin: c[6] }));
  const citiesByIso = d3.group(CITY, (c) => c.iso);
  const countryName = (iso) => byIso.get(iso)?.properties.name || iso;

  const cityPlaces = (iso) => [...S.places.values()].filter((p) => p.type === 'city' && (!iso || p.iso === iso));
  const countryPlace = (iso) => S.places.get('c:' + iso);
  const isVisited = (iso) => !!countryPlace(iso) || cityPlaces(iso).length > 0;
  const visitedIsos = () => [...new Set([...S.places.values()].map((p) => p.iso))].filter((iso) => byIso.has(iso));
  const mediaOf = (placeId) => [...S.media.values()].filter((m) => m.placeId === placeId);
  const placeIdsOfCountry = (iso) => ['c:' + iso, ...cityPlaces(iso).map((p) => p.id)];
  const mediaOfCountry = (iso) => { const ids = new Set(placeIdsOfCountry(iso)); return [...S.media.values()].filter((m) => ids.has(m.placeId)); };
  const firstVisit = (iso) => Math.min(...[...S.places.values()].filter((p) => p.iso === iso).map((p) => p.from ? Date.parse(p.from) : p.createdAt));

  function countLabel(list) {
    const ph = list.filter((m) => m.kind === 'image').length;
    const vi = list.filter((m) => m.kind === 'video').length;
    const no = list.filter((m) => m.kind === 'note').length;
    const parts = [];
    if (ph) parts.push(plural(ph, 'foto', 'fotos'));
    if (vi) parts.push(plural(vi, 'vídeo', 'vídeos'));
    if (no) parts.push(plural(no, 'recuerdo', 'recuerdos'));
    return parts.join(' · ');
  }

  function coverOf(placeIds) {
    const ids = Array.isArray(placeIds) ? placeIds : [placeIds];
    for (const id of ids) {
      const p = S.places.get(id);
      if (p?.coverId && S.media.get(p.coverId)?.thumbPath) return S.media.get(p.coverId);
    }
    const list = [...S.media.values()].filter((m) => ids.includes(m.placeId) && m.thumbPath);
    return list.find((m) => m.featured) || list.sort((a, b) => a.takenAt - b.takenAt)[0] || null;
  }

  function urlOf(rec, which = 'thumb') {
    const path = which === 'thumb' ? rec.thumbPath || rec.path : rec.path;
    return urlCache.get(path) || '';
  }

  /* ================= stamps ================= */
  let stampSeq = 0;
  function stampSVG({ top, bottom, center, seed = top, shape }) {
    const n = ++stampSeq;
    const h = hash(seed);
    const kind = shape || (h % 3 === 0 ? 'rect' : 'circle');
    const rot = ((h % 23) - 11);
    const T = esc(String(top).toUpperCase().slice(0, 18));
    const B = esc(String(bottom || '').toUpperCase().slice(0, 18));
    const C = esc(center);
    const fs = T.length > 13 ? 8 : T.length > 9 ? 9.2 : 10.5;
    if (kind === 'rect') {
      return `<svg viewBox="0 0 120 120" role="img" aria-label="Sello de ${esc(top)}" style="transform:rotate(${rot}deg)">
        <g filter="url(#ink)" fill="none" stroke="currentColor">
          <rect x="7" y="26" width="106" height="68" rx="11" stroke-width="4"/>
          <rect x="14" y="33" width="92" height="54" rx="6" stroke-width="1.2"/>
          <line x1="20" y1="70" x2="100" y2="70" stroke-width="1" stroke-dasharray="2 2"/>
          <g fill="currentColor" stroke="none" text-anchor="middle">
            <text x="60" y="47" font-family="Bricolage Grotesque, sans-serif" font-weight="800" font-size="${fs}" letter-spacing="1.2">${T}</text>
            <text x="60" y="66" font-family="Bricolage Grotesque, sans-serif" font-weight="800" font-size="19" letter-spacing="1">${C}</text>
            <text x="60" y="81" font-family="JetBrains Mono, monospace" font-weight="700" font-size="7.6" letter-spacing="1">${B}</text>
          </g>
        </g></svg>`;
    }
    return `<svg viewBox="0 0 120 120" role="img" aria-label="Sello de ${esc(top)}" style="transform:rotate(${rot}deg)">
      <defs>
        <path id="st${n}" d="M 23,60 A 37,37 0 0,1 97,60"/>
        <path id="sb${n}" d="M 16,60 A 44,44 0 0,0 104,60"/>
      </defs>
      <g filter="url(#ink)" fill="none" stroke="currentColor">
        <circle cx="60" cy="60" r="55" stroke-width="4"/>
        <circle cx="60" cy="60" r="48" stroke-width="1.2"/>
        <circle cx="60" cy="60" r="31" stroke-width="1.2" stroke-dasharray="2.4 2.4"/>
        <g fill="currentColor" stroke="none">
          <circle cx="19.5" cy="60" r="2.2"/><circle cx="100.5" cy="60" r="2.2"/>
          <text font-family="Bricolage Grotesque, sans-serif" font-weight="800" font-size="${fs}" letter-spacing="1.4"><textPath href="#st${n}" startOffset="50%" text-anchor="middle">${T}</textPath></text>
          <text font-family="JetBrains Mono, monospace" font-weight="700" font-size="7.6" letter-spacing="1.2"><textPath href="#sb${n}" startOffset="50%" text-anchor="middle" dominant-baseline="hanging">${B}</textPath></text>
          <text x="60" y="67" text-anchor="middle" font-family="Bricolage Grotesque, sans-serif" font-weight="800" font-size="21" letter-spacing="0.5">${C}</text>
        </g>
      </g></svg>`;
  }

  function countryStamp(iso, opts = {}) {
    const year = new Date(firstVisit(iso) || Date.now()).getFullYear();
    const nc = cityPlaces(iso).length;
    return stampSVG({ top: countryName(iso), bottom: nc ? `${plural(nc, 'ciudad', 'ciudades')} · ${year}` : `visitado · ${year}`, center: iso.slice(0, 3), seed: iso, ...opts });
  }

  function thump(svg, caption = '') {
    const stage = $('#stampStage');
    const drops = reduceMotion ? '' : Array.from({ length: 9 }, (_, i) => {
      const a = (i / 9) * Math.PI * 2 + Math.random() * 0.6;
      const r = 40 + Math.random() * 20;
      return `<i class="drop" style="--x:${(Math.cos(a) * r).toFixed(1)}%;--y:${(Math.sin(a) * r).toFixed(1)}%;--s:${(3 + Math.random() * 8).toFixed(1)}px;--d:${Math.round(Math.random() * 70)}ms"></i>`;
    }).join('');
    stage.innerHTML = `<div class="thump stamp-ink">${svg}${drops}</div>${caption ? `<p class="milestone">${esc(caption)}</p>` : ''}`;
    playThunk();
    clearTimeout(thump.t);
    thump.t = setTimeout(() => (stage.innerHTML = ''), caption ? 2700 : 1600);
  }

  const MILESTONES = new Set([3, 5, 10, 15, 20, 25, 30, 40, 50, 60, 75, 100]);
  const milestone = (before, after) => after <= before ? '' : after === 1 ? 'Primer sello del pasaporte' : MILESTONES.has(after) ? `${after} países juntos` : '';

  /* a soft rubber-stamp thunk, synthesized; off unless the couple turns it on */
  let audioCtx = null;
  const soundOn = () => { try { return localStorage.getItem('pasaporte.sound') === '1'; } catch { return false; } };
  function playThunk() {
    if (!soundOn()) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const t = audioCtx.currentTime + (reduceMotion ? 0 : 0.26);
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = 'sine';
      o.frequency.setValueAtTime(150, t);
      o.frequency.exponentialRampToValueAtTime(52, t + 0.13);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.55, t + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
      o.connect(g).connect(audioCtx.destination);
      o.start(t);
      o.stop(t + 0.22);
      const len = Math.floor(audioCtx.sampleRate * 0.07);
      const buf = audioCtx.createBuffer(1, len, audioCtx.sampleRate);
      const ch = buf.getChannelData(0);
      for (let i = 0; i < len; i++) ch[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
      const n = audioCtx.createBufferSource(), f = audioCtx.createBiquadFilter(), ng = audioCtx.createGain();
      n.buffer = buf;
      f.type = 'lowpass';
      f.frequency.value = 1700;
      ng.gain.value = 0.3;
      n.connect(f).connect(ng).connect(audioCtx.destination);
      n.start(t);
    } catch { /* no audio, no problem */ }
  }

  /* ================= toast & confirm ================= */
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toast.t);
    toast.t = setTimeout(() => el.classList.remove('show'), 3200);
  }
  function confirmBox(text, okLabel = 'Borrar') {
    const dlg = $('#confirmDialog');
    $('#confirmText').textContent = text;
    $('#confirmOk').textContent = okLabel;
    dlg.returnValue = '';
    dlg.showModal();
    return new Promise((res) => dlg.addEventListener('close', () => res(dlg.returnValue === 'ok'), { once: true }));
  }

  /* ================= map ================= */
  const mapEl = $('#map');
  const svg = d3.select(mapEl).append('svg').attr('role', 'presentation');
  const zoomLayer = svg.append('g');
  const seaPath = zoomLayer.append('path').attr('class', 'sea');
  const gratPath = zoomLayer.append('path').attr('class', 'graticule');
  const landG = zoomLayer.append('g');
  const edgePath = zoomLayer.append('path').attr('class', 'sphere-edge');
  const routesG = zoomLayer.append('g').attr('class', 'routes');
  const pinsG = zoomLayer.append('g');
  const citiesG = zoomLayer.append('g');
  const labelsG = zoomLayer.append('g');
  const planeG = zoomLayer.append('g');

  const projection = d3.geoNaturalEarth1();
  const path = d3.geoPath(projection);
  const graticule = d3.geoGraticule10();

  // d3 expects clockwise outer rings; flip any polygon that would cover the whole globe
  for (const f of FEATURES) {
    const g = f.geometry;
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
    for (const p of polys) if (d3.geoArea({ type: 'Polygon', coordinates: p }) > 2 * Math.PI) p.forEach((ring) => ring.reverse());
  }

  const landSel = landG.selectAll('path').data(FEATURES).join('path')
    .attr('class', 'land')
    .attr('data-iso', (d) => d.properties.iso);

  const zoom = d3.zoom()
    .scaleExtent([0.8, 220])
    .clickDistance(5)
    .on('zoom', (e) => {
      zoomLayer.attr('transform', e.transform);
      S.k = e.transform.k;
      scaleMarks();
      hideCityPop();
    })
    .on('end', () => placeLabels());
  svg.call(zoom).on('dblclick.zoom', null);

  function freeArea() {
    const w = innerWidth, h = innerHeight;
    const top = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--top')) || 72;
    if (mobile()) return { l: 10, t: top + 30, r: w - 10, b: h * 0.42 };
    const panel = S.focus ? 380 + 32 : 360 + 32;
    return S.focus ? { l: 24, t: top + 36, r: w - panel, b: h - 24 } : { l: panel, t: top, r: w - 20, b: h - 20 };
  }

  function layout() {
    const w = innerWidth, h = innerHeight;
    svg.attr('viewBox', `0 0 ${w} ${h}`);
    const top = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--top')) || 72;
    const ext = mobile() ? [[8, top], [w - 8, h - 150]] : [[360 + 40, top], [w - 24, h - 24]];
    projection.fitExtent(ext, { type: 'FeatureCollection', features: FEATURES.filter((f) => f.properties.iso !== 'AQ') });
    seaPath.attr('d', path({ type: 'Sphere' }));
    edgePath.attr('d', path({ type: 'Sphere' }));
    gratPath.attr('d', path(graticule));
    landSel.attr('d', path);
    renderPins();
    renderRoutes();
    if (S.focus) { renderCities(); svg.call(zoom.transform, transformFor(S.focus)); }
  }

  function focusBounds(iso) {
    const f = byIso.get(iso);
    const g = f.geometry;
    const polys = (g.type === 'Polygon' ? [g.coordinates] : g.coordinates).map((c) => {
      const poly = { type: 'Polygon', coordinates: c };
      return { a: path.area(poly), b: path.bounds(poly) };
    }).sort((a, b) => b.a - a.a);
    const main = polys[0];
    const [[mx0, my0], [mx1, my1]] = main.b;
    const reach = Math.max(mx1 - mx0, my1 - my0) * 1.2 + 6;
    const cx = (mx0 + mx1) / 2, cy = (my0 + my1) / 2;
    let [x0, y0, x1, y1] = [mx0, my0, mx1, my1];
    for (const p of polys.slice(1)) {
      const [[a0, b0], [a1, b1]] = p.b;
      const near = Math.hypot((a0 + a1) / 2 - cx, (b0 + b1) / 2 - cy) < reach;
      if (near && p.a > main.a * 0.02) { x0 = Math.min(x0, a0); y0 = Math.min(y0, b0); x1 = Math.max(x1, a1); y1 = Math.max(y1, b1); }
    }
    return [[x0, y0], [x1, y1]];
  }

  function transformFor(iso) {
    const [[x0, y0], [x1, y1]] = focusBounds(iso);
    const a = freeArea();
    const fw = a.r - a.l, fh = a.b - a.t;
    const k = Math.max(1, Math.min(160, 0.84 / Math.max((x1 - x0) / fw, (y1 - y0) / fh)));
    return d3.zoomIdentity.translate(a.l + fw / 2, a.t + fh / 2).scale(k).translate(-(x0 + x1) / 2, -(y0 + y1) / 2);
  }

  function flyTo(t) {
    const dur = reduceMotion ? 0 : 1250;
    return svg.transition().duration(dur).ease(d3.easeCubicInOut).call(zoom.transform, t).end().catch(() => {});
  }

  function paintLand(flashIso) {
    landSel.classed('visited', (d) => isVisited(d.properties.iso))
      .classed('focused', (d) => d.properties.iso === S.focus);
    svg.classed('focusing', !!S.focus);
    if (flashIso) {
      const el = landSel.filter((d) => d.properties.iso === flashIso).classed('flash', false);
      requestAnimationFrame(() => el.classed('flash', true));
      setTimeout(() => el.classed('flash', false), 950);
    }
  }

  /* visited city pins on the world view */
  function renderPins() {
    const data = cityPlaces().filter((p) => p.iso !== S.focus);
    pinsG.selectAll('circle').data(data, (d) => d.id).join('circle')
      .attr('class', 'world-pin')
      .attr('cx', (d) => projection([d.lon, d.lat])[0])
      .attr('cy', (d) => projection([d.lon, d.lat])[1]);
    scaleMarks();
  }

  /* ---- flight routes between trips, in the order they happened ---- */
  const centroids = new Map();
  function centroidOf(iso) {
    if (!centroids.has(iso)) {
      const g = byIso.get(iso).geometry;
      const polys = (g.type === 'Polygon' ? [g.coordinates] : g.coordinates).map((c) => ({ type: 'Polygon', coordinates: c }));
      polys.sort((a, b) => d3.geoArea(b) - d3.geoArea(a));
      centroids.set(iso, d3.geoCentroid(polys[0]));
    }
    return centroids.get(iso);
  }
  const tripTime = (p) => (p.from ? Date.parse(p.from) : p.createdAt);
  function routeLegs() {
    const stops = [...S.places.values()]
      .filter((p) => byIso.has(p.iso) && (p.type === 'city' || !cityPlaces(p.iso).length))
      .map((p) => ({ id: p.id, t: tripTime(p), c: p.type === 'city' ? [p.lon, p.lat] : centroidOf(p.iso) }))
      .sort((a, b) => a.t - b.t);
    const legs = [];
    for (let i = 1; i < stops.length; i++) {
      const a = stops[i - 1], b = stops[i];
      if (km(a.c, b.c) > 80) legs.push({ id: a.id + '>' + b.id, a: a.c, b: b.c });
    }
    return legs;
  }

  const PLANE = 'M9 0C9-.9 8-1.4 6.8-1.4H2.5L-2.2-7.5H-4L-1.4-1.4H-5.5L-7-3.6H-8.3L-7.3 0-8.3 3.6H-7L-5.5 1.4H-1.4L-4 7.5H-2.2L2.5 1.4H6.8C8 1.4 9 .9 9 0Z';
  let routesSeen = false, pendingLegs = [];
  function renderRoutes({ animate = false } = {}) {
    const sel = routesG.selectAll('path').data(routeLegs(), (d) => d.id);
    sel.exit().remove();
    const entered = sel.enter().append('path').attr('class', 'route');
    const all = entered.merge(sel).attr('d', (d) => path({ type: 'LineString', coordinates: [d.a, d.b] }));
    scaleMarks();
    if (!animate || reduceMotion) { routesSeen = routesSeen || animate; return; }
    const fresh = routesSeen ? entered.nodes() : all.nodes();
    routesSeen = true;
    if (!fresh.length) return;
    if (S.focus) {
      fresh.forEach((el) => { const L = el.getTotalLength(); el.style.strokeDasharray = `${L} ${L}`; el.style.strokeDashoffset = L; });
      pendingLegs.push(...fresh);
      return;
    }
    drawRoutes(fresh);
  }

  function drawRoutes(nodes) {
    let lastEnd = 0;
    nodes.forEach((el, i) => {
      if (!el.isConnected) return;
      const L = el.getTotalLength();
      const delay = Math.min(i * 200, 1400);
      el.style.strokeDasharray = `${L} ${L}`;
      el.style.strokeDashoffset = '';
      const a = el.animate([{ strokeDashoffset: L }, { strokeDashoffset: 0 }], { duration: 900, delay, easing: 'cubic-bezier(0.65, 0, 0.35, 1)', fill: 'backwards' });
      a.onfinish = () => { el.style.strokeDasharray = ''; };
      lastEnd = Math.max(lastEnd, delay);
    });
    const last = nodes[nodes.length - 1];
    if (last?.isConnected) flyPlane(last, lastEnd + 150);
  }

  function flyPlane(el, delay) {
    const L = el.getTotalLength();
    const g = planeG.append('g').attr('class', 'plane').attr('opacity', 0);
    g.append('path').attr('d', PLANE);
    const t0 = performance.now() + delay, dur = 1700;
    const step = (now) => {
      if (!g.node().isConnected) return;
      const t = Math.min(1, Math.max(0, (now - t0) / dur));
      const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      const s = e * L;
      const p = el.getPointAtLength(s);
      const p0 = el.getPointAtLength(Math.max(0, s - 0.6)), p1 = el.getPointAtLength(Math.min(L, s + 0.6));
      const ang = Math.atan2(p1.y - p0.y, p1.x - p0.x) * 180 / Math.PI;
      g.attr('transform', `translate(${p.x},${p.y}) rotate(${ang}) scale(${1.15 / S.k})`)
        .attr('opacity', now < t0 ? 0 : t < 0.1 ? t / 0.1 : t > 0.88 ? (1 - t) / 0.12 : 1);
      if (t < 1) requestAnimationFrame(step); else g.remove();
    };
    requestAnimationFrame(step);
  }

  /* cities of the focused country */
  function cityData(iso) {
    const all = citiesByIso.get(iso) || [];
    const top = all.slice(0, 42);
    const caps = all.filter((c) => c.cap);
    const pick = new Map([...top, ...caps].map((c) => [c.key, { ...c, place: null }]));
    for (const p of cityPlaces(iso)) {
      let best = null, bd = 16;
      for (const c of all) { const d = km([c.lon, c.lat], [p.lon, p.lat]); if (d < bd) { bd = d; best = c; } }
      if (best) pick.set(best.key, { ...best, name: p.name, place: p });
      else pick.set(p.id, { key: p.id, name: p.name, iso, lat: p.lat, lon: p.lon, pop: p.pop || 0, cap: 0, admin: p.admin || '', place: p });
    }
    const t = S.tempCity;
    if (t && t.iso === iso && ![...pick.values()].some((c) => km([c.lon, c.lat], [t.lon, t.lat]) < 16)) pick.set(t.key, { ...t, place: null });
    return [...pick.values()].sort((a, b) => (!!b.place - !!a.place) || (b.cap - a.cap) || (b.pop - a.pop));
  }

  function renderCities() {
    const data = S.focus ? cityData(S.focus) : [];
    const groups = citiesG.selectAll('g.city').data(data, (d) => d.key).join(
      (enter) => {
        const g = enter.append('g').attr('class', 'city');
        g.append('circle').attr('class', 'aura');
        g.append('circle').attr('class', 'hit');
        g.append('circle').attr('class', 'ring');
        g.append('circle').attr('class', 'dot');
        g.on('click', (e, d) => { e.stopPropagation(); openCityPop(d); });
        return g;
      });
    groups.classed('visited', (d) => !!d.place)
      .attr('transform', (d) => `translate(${projection([d.lon, d.lat])})`);
    labelsG.selectAll('text').data(data, (d) => d.key).join('text')
      .attr('class', (d) => 'city-label' + (d.place ? ' visited' : d.cap || d.pop > 1e6 ? '' : ' minor'))
      .attr('x', (d) => projection([d.lon, d.lat])[0])
      .attr('y', (d) => projection([d.lon, d.lat])[1])
      .text((d) => d.name);
    scaleMarks();
    placeLabels();
  }

  function scaleMarks() {
    const k = S.k;
    pinsG.selectAll('circle').attr('r', 2.6 / k);
    routesG.selectAll('path').attr('stroke-width', 1.4 / k);
    const cs = citiesG.selectAll('g.city');
    cs.select('.dot').attr('r', (d) => (d.place ? 5.2 : d.cap ? 3.8 : 3) / k);
    cs.select('.ring').attr('r', (d) => (d.place ? 9.5 : 0) / k);
    cs.select('.hit').attr('r', 13 / k);
    cs.select('.aura').attr('r', (d) => (d.place ? 46 : 0) / k);
    labelsG.selectAll('text')
      .attr('font-size', (d) => (d.place ? 13 : 11.5) / k)
      .attr('stroke-width', 3.2 / k)
      .attr('dx', (d) => (d.place ? 12 : 7) / k)
      .attr('dy', 4 / k);
  }

  function placeLabels() {
    if (!S.focus) return;
    const t = d3.zoomTransform(svg.node());
    const boxes = [];
    labelsG.selectAll('text').each(function (d) {
      const [x, y] = t.apply(projection([d.lon, d.lat]));
      const w = d.name.length * (d.place ? 7.6 : 6.6) + 4;
      const b = { x0: x + (d.place ? 11 : 6), y0: y - 9, x1: x + (d.place ? 11 : 6) + w, y1: y + 7 };
      const hit = boxes.some((o) => b.x0 < o.x1 && b.x1 > o.x0 && b.y0 < o.y1 && b.y1 > o.y0);
      const show = d.place || !hit;
      this.style.display = show ? '' : 'none';
      if (show) boxes.push(b);
    });
  }

  /* ---- map interactions ---- */
  const tip = $('#tooltip');
  landSel
    .on('pointermove', (e, d) => {
      if (e.pointerType !== 'mouse') return;
      const iso = d.properties.iso;
      const nc = cityPlaces(iso).length;
      const v = isVisited(iso) ? `<span class="v">${nc ? plural(nc, 'ciudad', 'ciudades') : 'visitado'}</span>` : '';
      const fl = flagUrl(iso);
      tip.innerHTML = `${fl ? `<img src="${fl}" alt="">` : ''}<b>${esc(d.properties.name)}</b>${v}`;
      tip.hidden = false;
      const x = Math.min(e.clientX + 14, innerWidth - tip.offsetWidth - 8);
      tip.style.left = x + 'px';
      tip.style.top = e.clientY + 16 + 'px';
    })
    .on('pointerleave', () => (tip.hidden = true))
    .on('click', (e, d) => {
      e.stopPropagation();
      tip.hidden = true;
      const iso = d.properties.iso;
      if (S.focus === iso) { hideCityPop(); return; }
      focusCountry(iso);
    });
  seaPath.on('click', () => { if (S.focus) goWorld(); });
  svg.on('click', (e) => { if (e.target === svg.node() && S.focus) goWorld(); });

  async function focusCountry(iso, { then } = {}) {
    if (!byIso.has(iso)) return;
    hideCityPop();
    S.focus = iso;
    if (S.tempCity && S.tempCity.iso !== iso) S.tempCity = null;
    paintLand();
    renderPins();
    renderCities();
    renderCountryPanel();
    renderCrumbs();
    $('#passport').classList.add('away');
    await flyTo(transformFor(iso));
    placeLabels();
    then?.();
  }

  function goWorld() {
    hideCityPop();
    S.focus = null;
    S.tempCity = null;
    paintLand();
    renderPins();
    renderCities();
    closeCountryPanel();
    renderCrumbs();
    $('#passport').classList.remove('away');
    flyTo(d3.zoomIdentity).then(() => {
      if (S.focus || !pendingLegs.length) return;
      const nodes = pendingLegs;
      pendingLegs = [];
      drawRoutes(nodes);
    });
  }

  function renderCrumbs() {
    const el = $('#crumbs');
    if (!S.focus) { el.classList.remove('show'); return; }
    el.innerHTML = `<button type="button" data-world><i class="ph ph-globe-hemisphere-west" aria-hidden="true"></i>Mundo</button><i class="ph ph-caret-right sep" aria-hidden="true"></i><span>${esc(countryName(S.focus))}</span>`;
    el.querySelector('[data-world]').onclick = goWorld;
    el.classList.add('show');
  }

  /* ---- popover on a city dot ---- */
  const pop = $('#cityPop');
  function hideCityPop() { pop.hidden = true; }
  function openCityPop(c) {
    const t = d3.zoomTransform(svg.node());
    const [x, y] = t.apply(projection([c.lon, c.lat]));
    const meta = [c.admin, fmtPop(c.pop)].filter(Boolean).join(' · ') || countryName(c.iso);
    const n = c.place ? mediaOf(c.place.id).length : 0;
    pop.innerHTML = `<h4>${esc(c.name)}</h4><p>${esc(c.place ? (n ? countLabel(mediaOf(c.place.id)) : 'Sellada, sin fotos aún') : meta)}</p>
      <div class="row">${c.place
        ? `<button class="solid-btn" data-act="album" type="button"><i class="ph ph-images" aria-hidden="true"></i>Abrir álbum</button><button class="ghost-btn" data-act="remove" type="button" aria-label="Quitar sello"><i class="ph ph-x" aria-hidden="true"></i></button>`
        : `<button class="solid-btn" data-act="mark" type="button"><i class="ph ph-stamp" aria-hidden="true"></i>He estado aquí</button>`}</div>`;
    pop.hidden = false;
    const pw = pop.offsetWidth, ph = pop.offsetHeight;
    const above = y - ph - 18 > 70;
    const left = Math.max(10, Math.min(innerWidth - pw - 10, x - pw / 2));
    pop.style.left = left + 'px';
    pop.style.top = (above ? y - ph - 16 : y + 16) + 'px';
    pop.style.setProperty('--origin', `${x - left}px ${above ? '100%' : '0'}`);
    pop.onclick = async (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'mark') { hideCityPop(); await markCity(c); }
      if (act === 'album') { hideCityPop(); openAlbum({ placeId: c.place.id }); }
      if (act === 'remove') { hideCityPop(); await unmarkCity(c.place); }
    };
    pop.querySelector('button')?.focus({ preventScroll: true });
  }

  /* ================= marking ================= */
  async function markCity(c) {
    const p = {
      id: 'p:' + c.iso + ':' + c.lat.toFixed(3) + ',' + c.lon.toFixed(3),
      type: 'city', iso: c.iso, name: c.name, lat: c.lat, lon: c.lon, admin: c.admin || '', pop: c.pop || 0, createdAt: Date.now(),
    };
    const wasVisited = isVisited(c.iso);
    const before = visitedIsos().length;
    await DB.put('places', p);
    S.places.set(p.id, p);
    if (S.tempCity && km([S.tempCity.lon, S.tempCity.lat], [c.lon, c.lat]) < 16) S.tempCity = null;
    thump(stampSVG({ top: c.name, bottom: `${countryName(c.iso)} · ${new Date().getFullYear()}`, center: c.iso, seed: p.id, shape: 'circle' }), milestone(before, visitedIsos().length));
    refreshAll(wasVisited ? null : c.iso);
  }

  async function unmarkCity(p) {
    const media = mediaOf(p.id);
    if (media.length && !(await confirmBox(`Al quitar el sello de ${p.name} se borrarán ${countLabel(media)}. ¿Seguro?`, 'Quitar y borrar'))) return;
    await DB.del('media', ...media.map((m) => m.id));
    media.forEach((m) => S.media.delete(m.id));
    await DB.del('places', p.id);
    S.places.delete(p.id);
    refreshAll();
    toast(`${p.name} ya no está en tu pasaporte`);
  }

  async function markCountry(iso) {
    const p = { id: 'c:' + iso, type: 'country', iso, createdAt: Date.now() };
    const before = visitedIsos().length;
    await DB.put('places', p);
    S.places.set(p.id, p);
    thump(countryStamp(iso, { shape: 'circle' }), milestone(before, visitedIsos().length));
    refreshAll(iso);
  }

  async function unmarkCountry(iso) {
    const ids = placeIdsOfCountry(iso).filter((id) => S.places.has(id));
    const media = mediaOfCountry(iso);
    const nc = cityPlaces(iso).length;
    if ((media.length || nc) && !(await confirmBox(`Se quitarán ${[nc ? plural(nc, 'ciudad', 'ciudades') : '', media.length ? countLabel(media) : ''].filter(Boolean).join(' y ')} de ${countryName(iso)}. ¿Seguro?`, 'Quitar sello'))) return;
    await DB.del('media', ...media.map((m) => m.id));
    media.forEach((m) => S.media.delete(m.id));
    await DB.del('places', ...ids);
    ids.forEach((id) => S.places.delete(id));
    refreshAll();
    toast(`${countryName(iso)} ya no está en tu pasaporte`);
  }

  function refreshAll(flashIso) {
    paintLand(flashIso);
    renderPins();
    renderRoutes({ animate: true });
    renderCities();
    renderPassport();
    if (S.focus) renderCountryPanel();
  }

  /* ================= passport panel ================= */
  function ago(t) {
    const rtf = new Intl.RelativeTimeFormat('es', { numeric: 'auto' });
    const s = (t - Date.now()) / 1000;
    for (const [u, sec] of [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]]) {
      if (Math.abs(s) >= sec) return rtf.format(Math.round(s / sec), u);
    }
    return 'hace un momento';
  }

  const shown = {};
  function countUp(el, key, to) {
    const from = shown[key] ?? to;
    shown[key] = to;
    if (from === to || reduceMotion) { el.textContent = to.toLocaleString('es'); return; }
    const t0 = performance.now();
    const step = (now) => {
      const k = Math.min(1, (now - t0) / 750);
      el.textContent = Math.round(from + (to - from) * (1 - Math.pow(1 - k, 3))).toLocaleString('es');
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  let memoryId = null;
  function memoryCard() {
    const pics = [...S.media.values()].filter((m) => m.thumbPath && m.kind !== 'note');
    if (pics.length < 2) return '';
    const now = new Date();
    const today = pics.filter((m) => { const d = new Date(m.takenAt); return d.getDate() === now.getDate() && d.getMonth() === now.getMonth() && d.getFullYear() < now.getFullYear(); });
    let m, title;
    if (today.length) {
      m = today[hash(now.toDateString()) % today.length];
      title = `Un día como hoy, hace ${plural(now.getFullYear() - new Date(m.takenAt).getFullYear(), 'año', 'años')}`;
    } else {
      if (!memoryId || !S.media.has(memoryId)) memoryId = pics[Math.floor(Math.random() * pics.length)].id;
      m = S.media.get(memoryId);
      title = 'Un recuerdo al azar';
    }
    const p = S.places.get(m.placeId);
    const where = p?.type === 'city' ? p.name : countryName(p?.iso);
    return `<figure class="memory">
      <button type="button" class="memory-img" data-place="${esc(m.placeId)}" aria-label="Abrir el álbum de ${esc(where)}"><img src="${urlOf(m)}" alt=""></button>
      <figcaption><span><b>${esc(title)}</b>${esc(where)} · ${fmtDate(m.takenAt)}</span>
      ${today.length ? '' : '<button type="button" class="icon-btn small" data-shuffle aria-label="Otro recuerdo"><i class="ph ph-shuffle" aria-hidden="true"></i></button>'}</figcaption></figure>`;
  }

  function wirePlaces(scope) {
    scope.querySelectorAll('[data-place]').forEach((b) => (b.onclick = () => {
      const p = S.places.get(b.dataset.place);
      if (p) openAlbum(p.type === 'city' ? { placeId: p.id } : { iso: p.iso });
    }));
    const sh = scope.querySelector('[data-shuffle]');
    if (sh) sh.onclick = () => {
      const pics = [...S.media.values()].filter((m) => m.thumbPath && m.kind !== 'note' && m.id !== memoryId);
      if (!pics.length) return;
      memoryId = pics[Math.floor(Math.random() * pics.length)].id;
      const fig = $('#passportBody .memory');
      const tpl = document.createElement('template');
      tpl.innerHTML = memoryCard().trim();
      const next = tpl.content.firstElementChild;
      next.classList.add('swap');
      fig.replaceWith(next);
      wirePlaces(next);
      next.querySelector('[data-shuffle]')?.focus();
    };
  }

  function renderPassport() {
    const isos = visitedIsos();
    const nCities = cityPlaces().length;
    const nMedia = S.media.size;
    const hr = new Date().getHours();
    $('.passport-title').textContent = `${hr < 6 || hr >= 21 ? 'Buenas noches' : hr < 13 ? 'Buenos días' : 'Buenas tardes'}, viajeros`;
    const lastPlace = [...S.places.values()].sort((a, b) => b.createdAt - a.createdAt)[0];
    $('#passportLine').textContent = lastPlace
      ? `Último sello: ${lastPlace.type === 'city' ? lastPlace.name : countryName(lastPlace.iso)}, ${ago(lastPlace.createdAt)}`
      : 'Vuestro pasaporte está en blanco';
    if (!$('#stats [data-count]')) {
      $('#stats').innerHTML = `
        <div><dt>países</dt><dd><span data-count="c">0</span><small>/ ${TOTAL_COUNTRIES}</small></dd></div>
        <div><dt>ciudades</dt><dd><span data-count="t">0</span></dd></div>
        <div><dt>recuerdos</dt><dd><span data-count="m">0</span></dd></div>
        <div class="progress" aria-hidden="true"><span></span></div>`;
    }
    countUp($('#stats [data-count="c"]'), 'c', isos.length);
    countUp($('#stats [data-count="t"]'), 't', nCities);
    countUp($('#stats [data-count="m"]'), 'm', nMedia);
    $('#stats .progress span').style.width = `${Math.min(100, (isos.length / TOTAL_COUNTRIES) * 100)}%`;
    const body = $('#passportBody');
    if (!isos.length) {
      body.innerHTML = `<div class="blank">
        <div class="ghost-stamp stamp-ink">${stampSVG({ top: 'Tu primer viaje', bottom: 'aquí', center: '?', shape: 'circle', seed: 'x' })}</div>
        <h2>Todavía sin sellos</h2>
        <p>Toca un país del mapa o busca una ciudad para poner vuestro primer sello.</p></div>`;
      return;
    }
    const order = isos.map((iso) => ({ iso, t: Math.max(...[...S.places.values()].filter((p) => p.iso === iso).map((p) => p.createdAt)) }))
      .sort((a, b) => b.t - a.t);
    const recent = [...S.media.values()].filter((m) => m.thumbPath).sort((a, b) => b.createdAt - a.createdAt).slice(0, 6);
    const recentHtml = recent.length ? `<h2 class="p-sub">Últimos recuerdos</h2><div class="recent">${recent.map((m) => {
      const p = S.places.get(m.placeId);
      const label = p?.type === 'city' ? p.name : countryName(p?.iso);
      return `<button type="button" data-place="${esc(m.placeId)}" aria-label="Álbum de ${esc(label)}"><img src="${urlOf(m)}" alt=""><span>${esc(label)}</span></button>`;
    }).join('')}</div>` : '';
    body.innerHTML = `${memoryCard()}<h2 class="p-sub">Sellos</h2><div class="stamp-grid">${order.map(({ iso }) => {
      const nc = cityPlaces(iso).length;
      return `<button class="stamp-btn" type="button" data-iso="${esc(iso)}" title="${esc(countryName(iso))}">
        <span class="stamp-ink">${countryStamp(iso)}</span>
        <span class="cap">${nc ? plural(nc, 'ciudad', 'ciudades') : esc(countryName(iso))}</span></button>`;
    }).join('')}</div>${recentHtml}`;
    wirePlaces(body);
    body.querySelectorAll('[data-iso]').forEach((b) => (b.onclick = () => {
      $('#passport').classList.remove('open');
      focusCountry(b.dataset.iso);
    }));
  }
  $('#passportHandle').onclick = () => $('#passport').classList.toggle('open');
  $('.passport-head').addEventListener('click', () => { if (mobile()) $('#passport').classList.toggle('open'); });

  /* ================= country panel ================= */
  const cPanel = $('#countryPanel');
  function closeCountryPanel() {
    if (cPanel.hidden) return;
    cPanel.classList.add('leaving');
    setTimeout(() => { if (!S.focus) { cPanel.hidden = true; cPanel.classList.remove('leaving'); } }, 260);
  }

  function renderCountryPanel() {
    const iso = S.focus;
    if (!iso) return;
    cPanel.classList.remove('leaving');
    const f = byIso.get(iso);
    const visited = isVisited(iso);
    const cities = cityPlaces(iso).sort((a, b) => a.createdAt - b.createdAt);
    const capital = (citiesByIso.get(iso) || []).find((c) => c.cap);
    const media = mediaOfCountry(iso);
    const flag = flagUrl(iso);
    cPanel.innerHTML = `
      <div class="c-head">
        <button class="icon-btn c-close" type="button" data-act="close" aria-label="Volver al mundo"><i class="ph ph-x" aria-hidden="true"></i></button>
        ${flag ? `<img class="c-flag" src="${flag}" alt="" onerror="this.remove()">` : ''}
        <h2 class="c-name">${esc(f.properties.name)}</h2>
        <p class="c-sub">${esc([f.properties.cont, capital ? 'Capital: ' + capital.name : ''].filter(Boolean).join(' · '))}</p>
        <div class="c-status">${visited
          ? `<span class="stamp-ink">${countryStamp(iso)}</span>
             <div class="txt"><b>Sellado</b>Primer sello el ${fmtDate(firstVisit(iso))}${media.length ? '<br>' + countLabel(media) : ''}<br><button class="link-btn" type="button" data-act="unmark">Quitar sello</button></div>`
          : `<button class="solid-btn" type="button" data-act="mark"><i class="ph ph-stamp" aria-hidden="true"></i>He estado en ${esc(f.properties.name)}</button>`}
        </div>
      </div>
      <div class="c-body">
        <section class="c-section">
          <h3>Ciudades <small>${cities.length ? plural(cities.length, 'sellada', 'selladas') : ''}</small></h3>
          ${cities.length ? `<ul class="city-list">${cities.map((p) => {
            const cov = coverOf(p.id);
            const m = mediaOf(p.id);
            return `<li><button class="city-row" type="button" data-place="${esc(p.id)}">
              <span class="thumb">${cov ? `<img src="${urlOf(cov)}" alt="">` : '<i class="ph ph-camera" aria-hidden="true"></i>'}</span>
              <span><b>${esc(p.name)}</b><small>${m.length ? countLabel(m) : 'Añade las fotos del viaje'}</small></span>
              <i class="ph ph-caret-right" aria-hidden="true"></i></button></li>`;
          }).join('')}</ul>` : ''}
        </section>
        <div class="inline-search">
          <i class="ph ph-map-pin-plus" aria-hidden="true"></i>
          <input type="search" id="citySearch" autocomplete="off" placeholder="Añadir una ciudad de ${esc(f.properties.name)}" aria-label="Añadir ciudad">
          <ul class="search-results" id="citySearchResults" role="listbox" hidden></ul>
        </div>
        <p class="hint"><i class="ph ph-hand-tap" aria-hidden="true"></i>También puedes tocar los puntos del mapa para sellar una ciudad.</p>
      </div>
      ${visited ? `<div class="c-foot"><button class="solid-btn wide" type="button" data-act="album"><i class="ph ph-images" aria-hidden="true"></i>Álbum de ${esc(f.properties.name)}</button></div>` : ''}`;
    cPanel.hidden = false;
    cPanel.onclick = (e) => {
      const b = e.target.closest('[data-act],[data-place]');
      if (!b) return;
      if (b.dataset.place) return openAlbum({ placeId: b.dataset.place });
      const act = b.dataset.act;
      if (act === 'close') goWorld();
      if (act === 'mark') markCountry(iso);
      if (act === 'unmark') unmarkCountry(iso);
      if (act === 'album') openAlbum({ iso });
    };
    wireSearch($('#citySearch'), $('#citySearchResults'), { iso, onPick: async (item) => {
      if (item.type !== 'city') return;
      const existing = cityPlaces(iso).find((p) => km([p.lon, p.lat], [item.lon, item.lat]) < 16);
      if (existing) { openAlbum({ placeId: existing.id }); return; }
      await markCity(item);
    } });
  }

  /* ================= search ================= */
  function localSearch(q, iso) {
    const nq = norm(q);
    if (!nq) return [];
    const out = [];
    if (!iso) {
      const cs = FEATURES.filter((f) => norm(f.properties.name).includes(nq))
        .sort((a, b) => norm(a.properties.name).indexOf(nq) - norm(b.properties.name).indexOf(nq)).slice(0, 4);
      cs.forEach((f) => out.push({ type: 'country', iso: f.properties.iso, name: f.properties.name, sub: f.properties.cont }));
    }
    const pool = iso ? citiesByIso.get(iso) || [] : CITY;
    let n = 0;
    for (const c of pool) {
      if (norm(c.name).startsWith(nq)) { out.push({ type: 'city', ...c, sub: [c.admin, countryName(c.iso)].filter(Boolean).join(', ') }); if (++n >= 6) break; }
    }
    return out;
  }

  async function remoteSearch(q, iso, signal) {
    const u = new URL('https://geocoding-api.open-meteo.com/v1/search');
    u.searchParams.set('name', q);
    u.searchParams.set('count', '10');
    u.searchParams.set('language', 'es');
    if (iso) u.searchParams.set('countryCode', iso);
    const r = await fetch(u, { signal });
    const j = await r.json();
    return (j.results || []).filter((x) => x.country_code && byIso.has(x.country_code) && /^PPL/.test(x.feature_code || 'PPL'))
      .map((x) => ({ type: 'city', key: 'om' + x.id, name: x.name, iso: x.country_code, lat: +x.latitude.toFixed(4), lon: +x.longitude.toFixed(4), pop: x.population || 0, cap: 0, admin: x.admin1 || '', sub: [x.admin1, x.country].filter(Boolean).join(', ') }));
  }

  function wireSearch(input, list, { iso = null, onPick }) {
    let items = [], sel = -1, ctrl = null, timer = 0;
    const draw = (loading) => {
      if (!input.value.trim()) { list.hidden = true; input.setAttribute('aria-expanded', 'false'); return; }
      const countries = items.filter((i) => i.type === 'country');
      const cities = items.filter((i) => i.type === 'city');
      let idx = 0;
      const row = (i) => {
        const my = idx++;
        const lead = i.type === 'country' && flagUrl(i.iso) ? `<img src="${flagUrl(i.iso)}" alt="">` : `<i class="ph ${i.type === 'country' ? 'ph-flag' : 'ph-map-pin'}" aria-hidden="true"></i>`;
        const tag = i.type === 'city' && cityPlaces(i.iso).some((p) => km([p.lon, p.lat], [i.lon, i.lat]) < 16) ? '<span class="tag">sellada</span>'
          : i.type === 'country' && isVisited(i.iso) ? '<span class="tag">sellado</span>' : '';
        return `<li role="option" data-i="${my}" aria-selected="${my === sel}"><span class="ico">${lead}</span><span><b>${esc(i.name)}</b><small>${esc(i.sub || '')}</small></span>${tag}</li>`;
      };
      let html = '';
      if (countries.length) html += `<li class="group" role="presentation">Países</li>${countries.map(row).join('')}`;
      if (cities.length) html += `${countries.length ? '<li class="group" role="presentation">Ciudades</li>' : ''}${cities.map(row).join('')}`;
      if (!items.length) html = `<li class="empty" role="presentation">${loading ? 'Buscando…' : 'Sin resultados. Prueba con otro nombre.'}</li>`;
      list.innerHTML = html;
      items = [...countries, ...cities];
      list.hidden = false;
      input.setAttribute('aria-expanded', 'true');
    };
    const pick = (i) => {
      const it = items[i];
      if (!it) return;
      input.value = '';
      list.hidden = true;
      input.blur();
      onPick(it);
    };
    input.oninput = () => {
      const q = input.value.trim();
      sel = -1;
      items = localSearch(q, iso);
      draw(true);
      clearTimeout(timer);
      ctrl?.abort();
      if (q.length < 2) { draw(false); return; }
      timer = setTimeout(async () => {
        ctrl = new AbortController();
        try {
          const remote = await remoteSearch(q, iso, ctrl.signal);
          const local = items.filter((i) => i.type === 'city');
          for (const r of remote) {
            if (!local.some((l) => l.iso === r.iso && km([l.lon, l.lat], [r.lon, r.lat]) < 20) && items.filter((x) => x.type === 'city').length < 9) items.push(r);
          }
        } catch (err) { if (err.name === 'AbortError') return; }
        draw(false);
      }, 260);
    };
    input.onkeydown = (e) => {
      if (list.hidden) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(items.length - 1, sel + 1); draw(false); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); draw(false); }
      else if (e.key === 'Enter') { e.preventDefault(); pick(sel < 0 ? 0 : sel); }
      else if (e.key === 'Escape') { e.stopPropagation(); list.hidden = true; }
    };
    list.onpointerdown = (e) => { const li = e.target.closest('[data-i]'); if (li) { e.preventDefault(); pick(+li.dataset.i); } };
    input.onblur = () => setTimeout(() => { list.hidden = true; input.setAttribute('aria-expanded', 'false'); }, 120);
    input.onfocus = () => { if (input.value.trim()) draw(false); };
  }

  wireSearch($('#searchInput'), $('#searchResults'), {
    onPick: (item) => {
      if (item.type === 'country') return focusCountry(item.iso);
      S.tempCity = { ...item, key: item.key || 'tmp' };
      focusCountry(item.iso, {
        then: () => {
          const d = cityData(item.iso).find((c) => km([c.lon, c.lat], [item.lon, item.lat]) < 16);
          if (d) openCityPop(d);
        },
      });
    },
  });

  /* ================= album ================= */
  const albumEl = $('#album');
  const collage = $('#collage');

  function albumScope() {
    const a = S.album;
    if (a.placeId) {
      const p = S.places.get(a.placeId);
      return { title: p.name, iso: p.iso, ids: [p.id], uploadTo: p.id, place: p };
    }
    const ids = placeIdsOfCountry(a.iso);
    return { title: countryName(a.iso), iso: a.iso, ids, uploadTo: a.filter && a.filter !== 'all' ? a.filter : 'c:' + a.iso, place: countryPlace(a.iso), country: true };
  }

  function albumItems() {
    const sc = albumScope();
    const f = S.album.filter;
    const ids = sc.country && f && f !== 'all' ? [f] : sc.ids;
    return [...S.media.values()].filter((m) => ids.includes(m.placeId)).sort((a, b) => a.takenAt - b.takenAt || a.createdAt - b.createdAt);
  }

  async function openAlbum(scope) {
    hideCityPop();
    const ids = scope.placeId ? [scope.placeId] : placeIdsOfCountry(scope.iso);
    await signMedia([...S.media.values()].filter((m) => ids.includes(m.placeId)), true);
    S.album = { ...scope, filter: 'all' };
    renderAlbum();
    albumEl.hidden = false;
    $('#albumScroll').scrollTop = 0;
    if (!reduceMotion) {
      albumEl.classList.add('entering');
      void albumEl.offsetHeight;
      albumEl.classList.remove('entering');
    }
    $('#albumHead button')?.focus({ preventScroll: true });
  }

  function closeAlbum() {
    if (albumEl.hidden) return;
    const done = () => {
      albumEl.hidden = true;
      albumEl.classList.remove('closing');
      collage.innerHTML = '';
      S.album = null;
      refreshAll();
    };
    if (reduceMotion) return done();
    albumEl.classList.add('closing');
    setTimeout(done, 320);
  }

  function renderAlbum() {
    const sc = albumScope();
    const all = [...S.media.values()].filter((m) => sc.ids.includes(m.placeId));
    const place = sc.place;
    const flag = flagUrl(sc.iso);
    const days = place?.from && place?.to ? Math.round((Date.parse(place.to) - Date.parse(place.from)) / 864e5) + 1 : 0;
    const trip = days > 0 ? plural(days, 'día', 'días') : '';
    const sub = sc.country
      ? [cityPlaces(sc.iso).length ? plural(cityPlaces(sc.iso).length, 'ciudad', 'ciudades') : '', trip, countLabel(all)]
      : [esc(place.admin), trip, countLabel(all)];
    const stamp = sc.country ? countryStamp(sc.iso, { shape: 'circle' }) : stampSVG({ top: sc.title, bottom: `${countryName(sc.iso)} · ${new Date(place.createdAt).getFullYear()}`, center: sc.iso, seed: place.id, shape: 'circle' });
    const cov = coverOf(sc.ids);
    const head = $('#albumHead');
    head.classList.toggle('has-cover', !!cov);
    head.style.setProperty('--cover', cov ? `url("${urlOf(cov)}")` : 'none');
    $('#albumHead').innerHTML = `
      <div class="album-top">
        <button class="ghost-btn" type="button" data-act="close"><i class="ph ph-arrow-left" aria-hidden="true"></i>Mapa</button>
        ${sc.country ? '' : `<button class="ghost-btn" type="button" data-act="country">${flag ? `<img src="${flag}" alt="" style="width:20px;height:14px;border-radius:2px;object-fit:cover">` : ''}Todo ${esc(countryName(sc.iso))}</button>`}
      </div>
      <div>
        <h2 class="album-title">${esc(sc.title)}</h2>
        <div class="album-sub">
          <span>${flag && !sc.country ? `<img src="${flag}" alt="">` : ''}${esc(sc.country ? (byIso.get(sc.iso).properties.cont || '') : countryName(sc.iso))}</span>
          ${sub.filter(Boolean).map((s) => `<span>${s}</span>`).join('')}
          <span class="trip-dates"><i class="ph ph-calendar-blank" aria-hidden="true"></i>
            <input type="date" data-date="from" value="${esc(place?.from || '')}" aria-label="Fecha de ida">
            <span>a</span>
            <input type="date" data-date="to" value="${esc(place?.to || '')}" aria-label="Fecha de vuelta"></span>
        </div>
      </div>
      <div class="album-badge stamp-ink">${stamp}</div>
      <div class="album-actions">
        <button class="solid-btn" type="button" data-act="add"><i class="ph ph-plus" aria-hidden="true"></i>Añadir fotos y vídeos</button>
        <button class="ghost-btn" type="button" data-act="note"><i class="ph ph-pen-nib" aria-hidden="true"></i>Escribir un recuerdo</button>
      </div>`;
    $('#albumHead').onclick = (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'close') closeAlbum();
      if (act === 'add') $('#mediaInput').click();
      if (act === 'note') openNote();
      if (act === 'country') { S.album = { iso: sc.iso, filter: sc.place.id }; renderAlbum(); }
    };
    $('#albumHead').querySelectorAll('[data-date]').forEach((inp) => (inp.onchange = async () => {
      let p = sc.place;
      if (!p) { p = { id: 'c:' + sc.iso, type: 'country', iso: sc.iso, createdAt: Date.now() }; }
      p[inp.dataset.date] = inp.value;
      await DB.put('places', p);
      S.places.set(p.id, p);
      toast('Fechas guardadas');
      renderAlbum();
    }));

    const fil = $('#albumFilters');
    if (sc.country) {
      const chips = [['all', 'Todo', all.length]];
      for (const p of cityPlaces(sc.iso)) chips.push([p.id, p.name, mediaOf(p.id).length]);
      const gen = mediaOf('c:' + sc.iso).length;
      if (gen) chips.push(['c:' + sc.iso, 'General', gen]);
      fil.innerHTML = chips.length > 2 || gen ? chips.map(([id, label, n]) => `<button class="chip" type="button" data-f="${esc(id)}" aria-pressed="${S.album.filter === id}">${esc(label)}<small>${n}</small></button>`).join('') : '';
      fil.onclick = (e) => { const b = e.target.closest('[data-f]'); if (b) { S.album.filter = b.dataset.f; renderAlbum(); } };
    } else fil.innerHTML = '';

    renderCollage();
  }

  function sizeFor(m, i) {
    if (m.kind === 'note') return (m.text || '').length > 420 ? 'xl' : (m.text || '').length > 110 ? 'wide' : '';
    if (m.featured) return 'xl';
    const r = (m.w || 1) / (m.h || 1);
    if (r >= 1.65) return 'wide';
    if (r <= 0.72) return 'tall';
    if (r > 1.2 && i % 5 === 2) return 'wide';
    if (i % 11 === 0 && i > 0) return 'xl';
    return '';
  }

  function renderCollage(pending = 0) {
    const items = albumItems();
    const sc = albumScope();
    const showWhere = sc.country && S.album.filter === 'all';
    const where = (m) => { const p = S.places.get(m.placeId); return p?.type === 'city' ? p.name : ''; };
    let html = items.map((m, i) => {
      const cls = sizeFor(m, i);
      const st = `style="--i:${Math.min(i, 24)}"`;
      if (m.kind === 'note') {
        const len = (m.text || '').length;
        return `<article class="tile note ${cls}" ${st} tabindex="0" role="button" data-id="${m.id}" aria-label="Recuerdo: ${esc(m.title || 'sin título')}">
          ${m.title ? `<h4>${esc(m.title)}</h4>` : ''}<p style="--lines:${cls === 'xl' ? 12 : m.title ? (cls ? 4 : 3) : 5}">${esc(m.text)}</p>
          <time>${fmtDate(m.takenAt)}${showWhere && where(m) ? ' · ' + esc(where(m)) : ''}</time></article>`;
      }
      const media = m.kind === 'video'
        ? `<video src="${urlOf(m, 'blob')}" ${m.thumbPath ? `poster="${urlOf(m)}"` : ''} muted loop playsinline preload="none"></video>
           <span class="badge"><i class="ph-fill ph-play" aria-hidden="true"></i>${m.duration >= 1 ? `${Math.floor(m.duration / 60)}:${String(Math.round(m.duration % 60)).padStart(2, '0')}` : 'Vídeo'}</span>`
        : `<img src="${urlOf(m)}" alt="${esc(m.name || '')}" decoding="async">`;
      return `<button class="tile ${cls}" ${st} type="button" data-id="${m.id}" aria-label="Abrir ${m.kind === 'video' ? 'vídeo' : 'foto'}">${media}
        ${m.featured ? '<i class="ph-fill ph-star star" aria-hidden="true"></i>' : ''}
        ${showWhere && where(m) && m.kind !== 'video' ? `<span class="where">${esc(where(m))}</span>` : ''}</button>`;
    }).join('');
    html += Array.from({ length: pending }, () => '<div class="tile loading" aria-hidden="true"></div>').join('');
    if (!items.length && !pending) {
      html = `<div class="album-empty">
        <i class="ph ph-images" aria-hidden="true"></i>
        <h3>Aquí va el álbum de ${esc(sc.title)}</h3>
        <p>Arrastra las fotos y vídeos del viaje a esta pantalla o elígelos desde tu ordenador. Se ordenan solos en un collage.</p>
        <button class="solid-btn" type="button" data-empty-add><i class="ph ph-plus" aria-hidden="true"></i>Elegir fotos y vídeos</button></div>`;
    }
    collage.innerHTML = html;
    collage.querySelector('[data-empty-add]')?.addEventListener('click', () => $('#mediaInput').click());
  }

  collage.addEventListener('click', (e) => {
    const t = e.target.closest('[data-id]');
    if (t) openLightbox(t.dataset.id);
  });
  collage.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('article[data-id]')) { e.preventDefault(); openLightbox(e.target.dataset.id); }
  });
  collage.addEventListener('pointerover', (e) => {
    const v = e.target.closest('.tile')?.querySelector('video');
    if (v && e.pointerType === 'mouse') { v.play().catch(() => {}); }
  });
  collage.addEventListener('pointerout', (e) => {
    const tile = e.target.closest('.tile');
    if (tile && !tile.contains(e.relatedTarget)) tile.querySelector('video')?.pause();
  });

  /* ---- uploads ---- */
  function canvasThumb(src, w, h, max = 960) {
    const s = Math.min(1, max / Math.max(w, h));
    const c = document.createElement('canvas');
    c.width = Math.round(w * s);
    c.height = Math.round(h * s);
    c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
    return new Promise((res) => c.toBlob(res, 'image/jpeg', 0.84));
  }

  async function processImage(file) {
    const bmp = await createImageBitmap(file);
    const thumb = await canvasThumb(bmp, bmp.width, bmp.height);
    // small JPEGs stay as they are; big photos shrink so the shared space lasts
    const full = file.type === 'image/jpeg' && file.size < 1.6e6 ? file : await canvasThumb(bmp, bmp.width, bmp.height, 2560);
    const out = { w: bmp.width, h: bmp.height, thumb, full };
    bmp.close?.();
    return out;
  }

  function processVideo(file) {
    return new Promise((res) => {
      const v = document.createElement('video');
      const u = URL.createObjectURL(file);
      let settled = false;
      const finish = async (ok) => {
        if (settled) return;
        settled = true;
        let thumb = null;
        if (ok && v.videoWidth) thumb = await canvasThumb(v, v.videoWidth, v.videoHeight).catch(() => null);
        res({ w: v.videoWidth || 16, h: v.videoHeight || 9, thumb, duration: isFinite(v.duration) ? v.duration : 0 });
        URL.revokeObjectURL(u);
      };
      v.muted = true;
      v.playsInline = true;
      v.preload = 'auto';
      v.onloadeddata = () => { v.currentTime = Math.min(1, (v.duration || 2) / 3); };
      v.onseeked = () => finish(true);
      v.onerror = () => finish(false);
      setTimeout(() => finish(false), 9000);
      v.src = u;
    });
  }

  const extOf = (blob, name = '') => (blob.type.split('/')[1] || name.split('.').pop() || 'bin').replace('jpeg', 'jpg').replace(/[^a-z0-9]/gi, '').slice(0, 5);

  async function storeMedia(rec, full, thumb) {
    const base = `${rec.placeId.replace(/[^a-zA-Z0-9]/g, '_')}/${rec.id}`;
    if (full) {
      rec.path = `${base}.${extOf(full, rec.name)}`;
      await DB.upload(rec.path, full);
      urlCache.set(rec.path, URL.createObjectURL(full));
    }
    if (thumb) {
      rec.thumbPath = `${base}_t.jpg`;
      await DB.upload(rec.thumbPath, thumb);
      urlCache.set(rec.thumbPath, URL.createObjectURL(thumb));
    }
    await DB.put('media', rec);
    S.media.set(rec.id, rec);
  }

  async function addFiles(files) {
    if (!S.album) return;
    const list = [...files].filter((f) => /^(image|video)\//.test(f.type) || /\.(heic|heif)$/i.test(f.name));
    if (!list.length) { toast('Solo se pueden añadir fotos y vídeos'); return; }
    const sc = albumScope();
    const target = sc.uploadTo;
    if (!S.places.has(target)) {
      const p = { id: target, type: 'country', iso: sc.iso, createdAt: Date.now() };
      await DB.put('places', p);
      S.places.set(p.id, p);
    }
    let pending = list.length, added = 0;
    const failed = [], tooBig = [];
    renderCollage(pending);
    const now = Date.now();
    for (const file of list) {
      try {
        const isVideo = file.type.startsWith('video/');
        if (isVideo && file.size > MAX_UPLOAD) { tooBig.push(file.name); throw new Error('big'); }
        const info = isVideo ? await processVideo(file) : await processImage(file);
        const full = isVideo ? file : info.full;
        const rec = {
          id: uid(), placeId: target, kind: isVideo ? 'video' : 'image', w: info.w, h: info.h,
          duration: info.duration || 0, name: file.name, type: full.type, size: full.size,
          takenAt: file.lastModified || now, createdAt: now + added, featured: false,
        };
        await storeMedia(rec, full, info.thumb);
        added++;
      } catch (err) {
        if (err.message !== 'big') failed.push(file.name);
      }
      pending--;
      renderCollage(pending);
    }
    renderAlbum();
    if (tooBig.length) toast(`${tooBig.length === 1 ? tooBig[0] + ' pesa' : tooBig.length + ' vídeos pesan'} más de 50 MB. Recórtalo o pásalo en menor calidad.`);
    else if (failed.length) toast(`No se pudo subir ${failed.length === 1 ? failed[0] : failed.length + ' archivos'}. Revisa la conexión; si son HEIC del iPhone, pásalos a JPG.`);
    else toast(`${plural(added, 'archivo añadido', 'archivos añadidos')} a ${S.places.get(target)?.name || countryName(sc.iso)}`);
  }

  $('#mediaInput').onchange = (e) => { addFiles(e.target.files); e.target.value = ''; };

  let dragDepth = 0;
  albumEl.addEventListener('dragenter', (e) => {
    if (![...e.dataTransfer.types].includes('Files')) return;
    e.preventDefault();
    dragDepth++;
    const sc = albumScope();
    $('#dropText').textContent = `Suelta para añadir a ${S.places.get(sc.uploadTo)?.name || sc.title}`;
    $('#dropVeil').hidden = false;
  });
  albumEl.addEventListener('dragover', (e) => e.preventDefault());
  albumEl.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#dropVeil').hidden = true; } });
  albumEl.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    $('#dropVeil').hidden = true;
    addFiles(e.dataTransfer.files);
  });
  // dropping files on the map opens nothing by accident
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  /* ---- notes ---- */
  function openNote() {
    const dlg = $('#noteDialog');
    const form = $('#noteForm');
    form.reset();
    form.date.value = new Date().toISOString().slice(0, 10);
    dlg.returnValue = '';
    dlg.showModal();
    form.text.focus();
  }
  $('#noteDialog').addEventListener('close', async () => {
    const dlg = $('#noteDialog');
    if (dlg.returnValue !== 'save' || !S.album) return;
    const form = $('#noteForm');
    const text = form.text.value.trim();
    if (!text) return;
    const sc = albumScope();
    const target = sc.uploadTo;
    if (!S.places.has(target)) {
      const p = { id: target, type: 'country', iso: sc.iso, createdAt: Date.now() };
      await DB.put('places', p);
      S.places.set(p.id, p);
    }
    const rec = { id: uid(), placeId: target, kind: 'note', title: form.title.value.trim(), text, takenAt: form.date.value ? Date.parse(form.date.value) : Date.now(), createdAt: Date.now() };
    await DB.put('media', rec);
    S.media.set(rec.id, rec);
    renderAlbum();
    toast('Recuerdo guardado');
  });

  /* ================= lightbox ================= */
  const lb = $('#lightbox');
  let lbList = [], lbIndex = 0;
  function openLightbox(id) {
    lbList = albumItems();
    lbIndex = Math.max(0, lbList.findIndex((m) => m.id === id));
    drawLightbox();
    if (!lb.open) lb.showModal();
  }
  function drawLightbox() {
    const m = lbList[lbIndex];
    if (!m) { lb.close(); return; }
    const stage = $('#lbStage');
    stage.querySelector('video')?.pause();
    if (m.kind === 'image') stage.innerHTML = `<img src="${urlOf(m, 'blob')}" alt="${esc(m.name || '')}">`;
    else if (m.kind === 'video') stage.innerHTML = `<video src="${urlOf(m, 'blob')}" controls autoplay playsinline></video>`;
    else stage.innerHTML = `<div class="lb-note">${m.title ? `<h3>${esc(m.title)}</h3>` : ''}<p>${esc(m.text)}</p></div>`;
    const p = S.places.get(m.placeId);
    const placeName = p?.type === 'city' ? p.name : countryName(p?.iso);
    $('#lbMeta').innerHTML = `<b>${esc(placeName)}</b><time>${fmtDate(m.takenAt)}</time> <span>· ${lbIndex + 1} de ${lbList.length}</span>`;
    const star = $('#lbStar');
    star.hidden = m.kind === 'note';
    star.classList.toggle('on', !!m.featured);
    star.querySelector('i').className = m.featured ? 'ph-fill ph-star' : 'ph ph-star';
    star.querySelector('span').textContent = m.featured ? 'Destacada' : 'Destacar';
    const cover = $('#lbCover');
    cover.hidden = m.kind === 'note' || !m.thumbPath;
    const isCover = p?.coverId === m.id;
    cover.classList.toggle('on', isCover);
    cover.querySelector('span').textContent = isCover ? 'Es la portada' : 'Portada';
    $('#lbPrev').disabled = lbList.length < 2;
    $('#lbNext').disabled = lbList.length < 2;
  }
  const lbStep = (d) => { if (lbList.length < 2) return; lbIndex = (lbIndex + d + lbList.length) % lbList.length; drawLightbox(); };
  $('#lbPrev').onclick = () => lbStep(-1);
  $('#lbNext').onclick = () => lbStep(1);
  $('#lbClose').onclick = () => lb.close();
  lb.addEventListener('close', () => { $('#lbStage').innerHTML = ''; });
  lb.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') lbStep(-1);
    if (e.key === 'ArrowRight') lbStep(1);
  });
  lb.addEventListener('click', (e) => { if (e.target === lb || e.target === $('#lbStage')) lb.close(); });
  let swipeX = null;
  $('#lbStage').addEventListener('pointerdown', (e) => { if (e.pointerType !== 'mouse') swipeX = e.clientX; });
  $('#lbStage').addEventListener('pointerup', (e) => {
    if (swipeX == null) return;
    const dx = e.clientX - swipeX;
    swipeX = null;
    if (Math.abs(dx) > 50) lbStep(dx < 0 ? 1 : -1);
  });
  $('#lbStar').onclick = async () => {
    const m = lbList[lbIndex];
    m.featured = !m.featured;
    await DB.put('media', m);
    drawLightbox();
    renderCollage();
  };
  $('#lbCover').onclick = async () => {
    const m = lbList[lbIndex];
    const p = S.places.get(m.placeId);
    if (!p) return;
    p.coverId = m.id;
    await DB.put('places', p);
    drawLightbox();
    toast('Portada actualizada');
  };
  $('#lbDelete').onclick = async () => {
    const m = lbList[lbIndex];
    const what = m.kind === 'note' ? 'este recuerdo' : m.kind === 'video' ? 'este vídeo' : 'esta foto';
    lb.close();
    if (!(await confirmBox(`¿Borrar ${what}? No se puede deshacer.`))) { lb.showModal(); drawLightbox(); return; }
    await DB.del('media', m.id);
    S.media.delete(m.id);
    lbList.splice(lbIndex, 1);
    lbIndex = Math.min(lbIndex, lbList.length - 1);
    renderAlbum();
    if (lbList.length) { lb.showModal(); drawLightbox(); }
  };

  /* ================= backup ================= */
  const backupMenu = $('#backupMenu');
  $('#backupBtn').onclick = (e) => {
    e.stopPropagation();
    backupMenu.hidden = !backupMenu.hidden;
    $('#backupBtn').setAttribute('aria-expanded', String(!backupMenu.hidden));
  };
  document.addEventListener('click', (e) => {
    if (!backupMenu.hidden && !backupMenu.contains(e.target)) { backupMenu.hidden = true; $('#backupBtn').setAttribute('aria-expanded', 'false'); }
  });

  $('#exportBtn').onclick = async () => {
    backupMenu.hidden = true;
    if (!S.places.size) { toast('Aún no hay nada que guardar'); return; }
    toast('Preparando la copia… puede tardar si hay muchos vídeos');
    const files = {};
    const meta = [];
    await signMedia([...S.media.values()], true);
    const grab = async (path) => { const u = urlCache.get(path); if (!u) return null; const r = await fetch(u); return r.ok ? r.blob() : null; };
    for (const m of S.media.values()) {
      const { path, thumbPath, createdBy, ...rest } = m;
      const blob = path ? await grab(path) : null;
      const thumb = thumbPath ? await grab(thumbPath) : null;
      if (blob) files[`media/${m.id}`] = [new Uint8Array(await blob.arrayBuffer()), { level: 0 }];
      if (thumb) files[`thumbs/${m.id}`] = [new Uint8Array(await thumb.arrayBuffer()), { level: 0 }];
      meta.push({ ...rest, hasBlob: !!blob, hasThumb: !!thumb, blobType: blob?.type || '' });
    }
    files['data.json'] = fflate.strToU8(JSON.stringify({ app: 'pasaporte', version: 1, places: [...S.places.values()], media: meta }));
    const zip = fflate.zipSync(files);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([zip], { type: 'application/zip' }));
    a.download = `pasaporte-${new Date().toISOString().slice(0, 10)}.zip`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    toast('Copia descargada');
  };

  $('#importBtn').onclick = () => { backupMenu.hidden = true; $('#importInput').click(); };
  $('#importInput').onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const z = fflate.unzipSync(new Uint8Array(await file.arrayBuffer()));
      const data = JSON.parse(fflate.strFromU8(z['data.json']));
      if (data.app !== 'pasaporte') throw new Error('formato');
      toast('Subiendo la copia a vuestro mapa…');
      const places = data.places.map(({ createdBy, ...p }) => p);
      if (places.length) await DB.put('places', ...places);
      places.forEach((p) => S.places.set(p.id, p));
      let i = 0;
      for (const m of data.media) {
        if (S.media.has(m.id)) continue;
        const { hasBlob, hasThumb, blobType, path, thumbPath, createdBy, ...rec } = m;
        const full = hasBlob && z[`media/${m.id}`] ? new Blob([z[`media/${m.id}`]], { type: blobType || m.type || '' }) : null;
        const thumb = hasThumb && z[`thumbs/${m.id}`] ? new Blob([z[`thumbs/${m.id}`]], { type: 'image/jpeg' }) : null;
        if (full && full.size > MAX_UPLOAD) continue;
        await storeMedia(rec, full, thumb);
        if (++i % 5 === 0) toast(`Subiendo la copia… ${i} de ${data.media.length}`);
      }
      refreshAll();
      toast(`Copia restaurada: ${plural(visitedIsos().length, 'país', 'países')}, ${plural(S.media.size, 'recuerdo', 'recuerdos')}`);
    } catch (err) {
      toast(err?.message === 'formato' || err instanceof SyntaxError || !err?.message ? 'Ese archivo no parece una copia de Pasaporte' : 'La copia se cortó a medias. Vuelve a intentarlo: no se duplica nada.');
    }
  };

  /* ================= global keys ================= */
  document.addEventListener('keydown', (e) => {
    const typing = /INPUT|TEXTAREA/.test(document.activeElement?.tagName);
    if (e.key === '/' && !typing && albumEl.hidden) { e.preventDefault(); $('#searchInput').focus(); return; }
    if (e.key !== 'Escape' || document.querySelector('dialog[open]')) return;
    if (!pop.hidden) { hideCityPop(); return; }
    if (!backupMenu.hidden) { backupMenu.hidden = true; return; }
    if (!albumEl.hidden) { closeAlbum(); return; }
    if (S.focus && !typing) goWorld();
  });
  $('#brandBtn').onclick = () => { closeAlbum(); if (S.focus) goWorld(); };

  let rt = 0;
  addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(layout, 140); });

  /* ================= account, sharing, live sync ================= */
  addEventListener('unhandledrejection', () => toast('No se pudo guardar. Revisa tu conexión.'));

  async function loadAll() {
    const [places, media] = await Promise.all([DB.all('places'), DB.all('media')]);
    S.places = new Map(places.map((p) => [p.id, p]));
    S.media = new Map(media.map((m) => [m.id, m]));
    await signMedia(media);
  }

  let liveTimer = 0;
  function liveRefresh() {
    clearTimeout(liveTimer);
    liveTimer = setTimeout(() => {
      refreshAll();
      if (S.album) {
        if (S.album.placeId && !S.places.has(S.album.placeId)) { closeAlbum(); return; }
        if (!lb.open) renderAlbum();
      }
    }, 350);
  }

  function goLive() {
    sb.channel('pasaporte')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'places' }, (e) => {
        if (e.eventType === 'DELETE') S.places.delete(e.old.id);
        else S.places.set(e.new.id, placeFromRow(e.new));
        liveRefresh();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'media' }, async (e) => {
        if (e.eventType === 'DELETE') S.media.delete(e.old.id);
        else { const m = mediaFromRow(e.new); await signMedia([m], true); S.media.set(m.id, m); }
        liveRefresh();
      })
      .subscribe();
  }

  /* who shares this map, inside the box menu */
  async function renderShare() {
    const box = $('#shareBox');
    const [{ data }, { data: u }] = await Promise.all([sb.from('members').select('email').order('created_at'), sb.auth.getUser()]);
    const me = u?.user?.email || '';
    box.innerHTML = `<p class="menu-label">Compartido con</p>
      <ul class="members">${(data || []).map((r) => `<li><i class="ph ph-user" aria-hidden="true"></i>${esc(r.email)}${r.email === me ? ' <small>(tú)</small>' : ''}</li>`).join('')}</ul>
      <form id="inviteForm" class="invite"><input type="email" name="email" required placeholder="Email de tu pareja" aria-label="Email a invitar"><button class="solid-btn" type="submit">Invitar</button></form>`;
    $('#inviteForm').onsubmit = async (e) => {
      e.preventDefault();
      const email = e.target.email.value.trim().toLowerCase();
      const { error } = await sb.from('members').insert({ email });
      if (error && error.code !== '23505') { toast('No se pudo invitar. Inténtalo de nuevo.'); return; }
      toast(`Listo: ${email} ya puede crear su cuenta y entrar`);
      renderShare();
    };
  }
  $('#backupBtn').addEventListener('click', () => { if (!backupMenu.hidden) renderShare(); });
  $('#backupMenu').addEventListener('click', (e) => e.stopPropagation());
  $('#logoutBtn').onclick = async () => { await sb.auth.signOut(); location.reload(); };
  function paintSound() {
    const on = soundOn();
    const b = $('#soundBtn');
    b.setAttribute('aria-checked', String(on));
    b.querySelector('i').className = on ? 'ph ph-speaker-high' : 'ph ph-speaker-simple-slash';
    b.querySelector('small').textContent = on ? 'activado' : 'apagado';
  }
  $('#soundBtn').onclick = () => {
    try { localStorage.setItem('pasaporte.sound', soundOn() ? '0' : '1'); } catch { /* private mode */ }
    paintSound();
    if (soundOn()) playThunk();
  };
  paintSound();

  /* login screen */
  const authEl = $('#auth');
  function showAuth(mode, info = '') {
    authEl.hidden = false;
    $('#app').inert = true;
    const f = $('#authForm');
    f.dataset.mode = mode;
    $('#authTitle').textContent = mode === 'signup' ? 'Crea tu cuenta' : mode === 'wait' ? 'Casi está' : 'Vuestro mapa de viajes';
    $('#authFields').hidden = mode === 'wait';
    $('#authSubmit').hidden = mode === 'wait';
    $('#authSubmit').textContent = mode === 'signup' ? 'Crear cuenta' : 'Entrar';
    $('#authSwitch').hidden = mode === 'wait';
    $('#authSwitch').textContent = mode === 'signup' ? 'Ya tengo cuenta' : 'Es mi primera vez: crear cuenta';
    $('#authLogout').hidden = mode !== 'wait';
    f.password.autocomplete = mode === 'signup' ? 'new-password' : 'current-password';
    $('#authMsg').textContent = info;
  }
  $('#authSwitch').onclick = () => showAuth($('#authForm').dataset.mode === 'signup' ? 'login' : 'signup');
  $('#authLogout').onclick = async () => { await sb.auth.signOut(); showAuth('login'); };
  $('#authForm').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    const email = f.email.value.trim().toLowerCase();
    const password = f.password.value;
    const btn = $('#authSubmit');
    btn.disabled = true;
    $('#authMsg').textContent = '';
    try {
      if (f.dataset.mode === 'signup') {
        const { data, error } = await sb.auth.signUp({ email, password, options: { emailRedirectTo: location.href.split('#')[0] } });
        if (error) throw error;
        if (!data.session) { showAuth('login', `Te hemos enviado un email a ${email}. Pulsa el enlace para confirmar y vuelve aquí para entrar (mira en spam si no llega).`); return; }
      } else {
        const { error } = await sb.auth.signInWithPassword({ email, password });
        if (error) throw error;
      }
      await enter();
    } catch (err) {
      const msg = String(err?.message || '');
      $('#authMsg').textContent = /Invalid login/i.test(msg) ? 'Email o contraseña incorrectos.'
        : /not confirmed/i.test(msg) ? 'Falta confirmar el email: busca el correo de Supabase (mira en spam).'
        : /already registered/i.test(msg) ? 'Ese email ya tiene cuenta: entra con él.'
        : /rate limit/i.test(msg) ? 'Demasiados intentos seguidos. Espera unos minutos.'
        : /password/i.test(msg) ? 'La contraseña debe tener al menos 6 caracteres.'
        : 'No se pudo conectar. Revisa tu conexión.';
    } finally {
      btn.disabled = false;
    }
  };

  let started = false;
  async function enter() {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) { showAuth('login'); return; }
    const { data: mine } = await sb.from('members').select('email').limit(1);
    if (!mine?.length) {
      showAuth('wait', `Tu cuenta (${session.user.email}) aún no tiene acceso a este mapa. Pide que te inviten desde el botón de personas (arriba a la derecha) y recarga la página.`);
      return;
    }
    authEl.hidden = true;
    $('#app').inert = false;
    if (started) return;
    started = true;
    await loadAll();
    paintLand();
    renderPins();
    renderPassport();
    renderRoutes({ animate: true });
    goLive();
  }

  /* ================= boot ================= */
  layout();
  paintLand();
  renderPassport();
  enter().catch(() => showAuth('login', 'No se pudo conectar. Revisa tu conexión y recarga.'));
})();
