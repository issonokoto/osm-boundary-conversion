#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const USER_AGENT = 'Codex osm-boundary-conversion/2.0';
const REQUEST_TIMEOUT_MS = 15_000;
const EARTH_RADIUS_M = 6_371_008.8;

function fail(message) { throw new Error(message); }

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    if (key === 'help' || key === 'deep' || key === 'no-svg' || key === 'keep-raw' || key === 'reuse-cache') args[key] = true;
    else args[key] = argv[++i];
  }
  return args;
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) fail(`HTTP ${response.status} from ${url}: ${text.slice(0, 240)}`);
    return { json: JSON.parse(text), text };
  } finally { clearTimeout(timer); }
}

function sha256(text) { return crypto.createHash('sha256').update(text).digest('hex'); }
function samePoint(a, b) { return a[0] === b[0] && a[1] === b[1]; }

function cleanClosedRing(points) {
  if (!Array.isArray(points) || points.length < 3) fail('A way has fewer than three nodes');
  const ring = [];
  for (const point of points) {
    if (!point) fail('A way references a missing node');
    if (!ring.length || !samePoint(ring[ring.length - 1], point)) ring.push(point);
  }
  if (!samePoint(ring[0], ring[ring.length - 1])) ring.push([...ring[0]]);
  if (ring.length < 4) fail('A ring has fewer than four coordinates');
  return ring;
}

function cleanOpenLine(points) {
  if (!Array.isArray(points) || points.length < 2) fail('A line has fewer than two nodes');
  const line = [];
  for (const point of points) {
    if (!point) fail('A line references a missing node');
    if (!line.length || !samePoint(line[line.length - 1], point)) line.push(point);
  }
  if (line.length < 2) fail('A line has fewer than two distinct coordinates');
  return line;
}

function signedArea(ring) {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i += 1) sum += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  return sum / 2;
}

function reverseRing(ring) {
  const open = ring.slice(0, -1).reverse();
  return [...open, [...open[0]]];
}

function normalizeOrientation(ring, outer) {
  return (signedArea(ring) > 0) === outer ? ring : reverseRing(ring);
}

function pointInRing(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    const crosses = ((a[1] > point[1]) !== (b[1] > point[1])) && point[0] < ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0];
    if (crosses) inside = !inside;
  }
  return inside;
}

function orientation(a, b, c) {
  const value = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  if (Math.abs(value) < 1e-12) return 0;
  return value > 0 ? 1 : -1;
}

function onSegment(a, b, point) {
  return point[0] >= Math.min(a[0], b[0]) - 1e-12 && point[0] <= Math.max(a[0], b[0]) + 1e-12 && point[1] >= Math.min(a[1], b[1]) - 1e-12 && point[1] <= Math.max(a[1], b[1]) + 1e-12;
}

function segmentsIntersect(a, b, c, d) {
  const abC = orientation(a, b, c);
  const abD = orientation(a, b, d);
  const cdA = orientation(c, d, a);
  const cdB = orientation(c, d, b);
  if (abC === 0 && onSegment(a, b, c)) return true;
  if (abD === 0 && onSegment(a, b, d)) return true;
  if (cdA === 0 && onSegment(c, d, a)) return true;
  if (cdB === 0 && onSegment(c, d, b)) return true;
  return abC !== abD && cdA !== cdB;
}

function selfIntersectionCount(ring, closed = true) {
  let count = 0;
  const segmentCount = ring.length - 1;
  for (let i = 0; i < segmentCount; i += 1) {
    for (let j = i + 1; j < segmentCount; j += 1) {
      if (j === i + 1 || (closed && i === 0 && j === segmentCount - 1)) continue;
      if (segmentsIntersect(ring[i], ring[i + 1], ring[j], ring[j + 1])) count += 1;
    }
  }
  return count;
}

function reverseSegment(segment) {
  return { ...segment, nodes: segment.nodes.slice().reverse(), coords: segment.coords.slice().reverse() };
}

function joinRings(segments) {
  const remaining = new Map(segments.map((segment) => [segment.id, segment]));
  const endpointIndex = new Map();
  for (const segment of segments) {
    for (const node of new Set([segment.nodes[0], segment.nodes[segment.nodes.length - 1]])) {
      if (!endpointIndex.has(node)) endpointIndex.set(node, new Set());
      endpointIndex.get(node).add(segment.id);
    }
  }
  const removeSegment = (segment) => {
    remaining.delete(segment.id);
    for (const node of new Set([segment.nodes[0], segment.nodes[segment.nodes.length - 1]])) {
      const ids = endpointIndex.get(node);
      if (!ids) continue;
      ids.delete(segment.id);
      if (!ids.size) endpointIndex.delete(node);
    }
  };
  const findAt = (node) => {
    for (const id of endpointIndex.get(node) ?? []) {
      const segment = remaining.get(id);
      if (segment) return segment;
    }
    return null;
  };
  const rings = [];
  while (remaining.size) {
    const first = remaining.values().next().value;
    removeSegment(first);
    let nodes = first.nodes.slice();
    let coords = first.coords.map((point) => [...point]);
    let steps = 0;
    while (nodes[0] !== nodes[nodes.length - 1]) {
      const head = nodes[0];
      const tail = nodes[nodes.length - 1];
      const candidate = findAt(tail) ?? findAt(head);
      if (!candidate) fail(`Open ${first.role} ring near nodes ${head}/${tail}`);
      const joinsTail = candidate.nodes[0] === tail || candidate.nodes[candidate.nodes.length - 1] === tail;
      const oriented = joinsTail
        ? (candidate.nodes[0] === tail ? candidate : reverseSegment(candidate))
        : (candidate.nodes[candidate.nodes.length - 1] === head ? candidate : reverseSegment(candidate));
      removeSegment(candidate);
      if (joinsTail) {
        nodes = nodes.concat(oriented.nodes.slice(1));
        coords = coords.concat(oriented.coords.slice(1).map((point) => [...point]));
      } else {
        nodes = oriented.nodes.slice(0, -1).concat(nodes);
        coords = oriented.coords.slice(0, -1).map((point) => [...point]).concat(coords);
      }
      steps += 1;
      if (steps > segments.length) fail(`Too many ways while joining ${first.role} ring`);
    }
    rings.push(cleanClosedRing(coords));
  }
  return rings;
}

function relationGeometry(full, relationId) {
  const elements = Array.isArray(full.elements) ? full.elements : [];
  const relation = elements.find((item) => item.type === 'relation' && String(item.id) === String(relationId));
  if (!relation) fail(`Relation ${relationId} is missing from the OSM response`);
  const nodes = new Map(elements.filter((item) => item.type === 'node').map((item) => [String(item.id), [Number(item.lon), Number(item.lat)]]));
  const ways = new Map(elements.filter((item) => item.type === 'way').map((item) => [String(item.id), item]));
  const groups = { outer: [], inner: [] };
  for (const member of relation.members ?? []) {
    if (member.type !== 'way' || !groups[member.role]) continue;
    const way = ways.get(String(member.ref));
    if (!way) fail(`Missing way ${member.ref}`);
    if (!Array.isArray(way.nodes)) fail(`Way ${member.ref} has no node list`);
    const coords = way.nodes.map((nodeId) => nodes.get(String(nodeId)));
    groups[member.role].push({ id: String(member.ref), role: member.role, nodes: way.nodes.map(String), coords });
  }
  if (!groups.outer.length) fail(`Relation ${relationId} has no outer ways`);
  const outers = joinRings(groups.outer).map((ring) => normalizeOrientation(ring, true));
  const inners = joinRings(groups.inner).map((ring) => normalizeOrientation(ring, false));
  const polygons = outers.map((outer) => [outer]);
  for (const inner of inners) {
    const owner = polygons.find((polygon) => pointInRing(inner[0], polygon[0]));
    if (!owner) fail('An inner ring is outside every outer ring');
    owner.push(inner);
  }
  return { relation, geometry: polygons.length === 1 ? { type: 'Polygon', coordinates: polygons[0] } : { type: 'MultiPolygon', coordinates: polygons } };
}

function wayGeometry(full, wayId) {
  const elements = Array.isArray(full.elements) ? full.elements : [];
  const way = elements.find((item) => item.type === 'way' && String(item.id) === String(wayId));
  if (!way) fail(`Way ${wayId} is missing from the OSM response`);
  const nodes = new Map(elements.filter((item) => item.type === 'node').map((item) => [String(item.id), [Number(item.lon), Number(item.lat)]]));
  if (!Array.isArray(way.nodes)) fail(`Way ${wayId} has no node list`);
  const points = way.nodes.map((nodeId) => nodes.get(String(nodeId)));
  const closed = way.nodes.length >= 2 && String(way.nodes[0]) === String(way.nodes[way.nodes.length - 1]);
  if (!closed) return { relation: null, tags: way.tags ?? {}, geometry: { type: 'LineString', coordinates: cleanOpenLine(points) } };
  if (way.nodes.length < 4) fail(`Way ${wayId} is closed but has fewer than four node references`);
  const ring = cleanClosedRing(points);
  return { relation: null, tags: way.tags ?? {}, geometry: { type: 'Polygon', coordinates: [normalizeOrientation(ring, true)] } };
}

function isAreaGeometry(geometry) { return geometry.type === 'Polygon' || geometry.type === 'MultiPolygon'; }

function allRings(geometry) {
  if (geometry.type === 'LineString') return [geometry.coordinates];
  if (geometry.type === 'Polygon') return geometry.coordinates;
  if (geometry.type === 'MultiPolygon') return geometry.coordinates.flat();
  fail(`Unsupported geometry type: ${geometry.type}`);
}

function bboxOf(geometry) {
  const points = allRings(geometry).flat();
  if (!points.length) fail('Geometry has no coordinates');
  return [Math.min(...points.map((point) => point[0])), Math.min(...points.map((point) => point[1])), Math.max(...points.map((point) => point[0])), Math.max(...points.map((point) => point[1]))];
}

function sphericalAreaKm2(geometry) {
  if (!isAreaGeometry(geometry)) return null;
  let area = 0;
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  for (const polygon of polygons) {
    const rings = [polygon[0], ...polygon.slice(1)];
    for (const ring of rings) {
      let sum = 0;
      for (let i = 0; i < ring.length - 1; i += 1) {
        const lon1 = ring[i][0] * Math.PI / 180;
        const lon2 = ring[i + 1][0] * Math.PI / 180;
        const lat1 = ring[i][1] * Math.PI / 180;
        const lat2 = ring[i + 1][1] * Math.PI / 180;
        let delta = lon2 - lon1;
        if (delta > Math.PI) delta -= 2 * Math.PI;
        if (delta < -Math.PI) delta += 2 * Math.PI;
        sum += delta * (Math.sin(lat1) + Math.sin(lat2));
      }
      const ringArea = Math.abs(sum * EARTH_RADIUS_M ** 2 / 2);
      area += ring === polygon[0] ? ringArea : -ringArea;
    }
  }
  return Math.abs(area) / 1e6;
}

function haversineKm(a, b) {
  const lat1 = a[1] * Math.PI / 180;
  const lat2 = b[1] * Math.PI / 180;
  const dLat = lat2 - lat1;
  let dLon = (b[0] - a[0]) * Math.PI / 180;
  if (dLon > Math.PI) dLon -= 2 * Math.PI;
  if (dLon < -Math.PI) dLon += 2 * Math.PI;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h))) / 1000;
}

function lineLengthKm(geometry) {
  if (geometry.type !== 'LineString') return null;
  let length = 0;
  for (let i = 0; i < geometry.coordinates.length - 1; i += 1) length += haversineKm(geometry.coordinates[i], geometry.coordinates[i + 1]);
  return length;
}

function coordinatesAreValid(geometry) {
  return allRings(geometry).flat().every(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat) && lon >= -180 && lon <= 180 && lat >= -90 && lat <= 90);
}

const WATER_TYPES = new Set(['bay', 'channel', 'coastline', 'estuary', 'fjord', 'gulf', 'inlet', 'lagoon', 'lake', 'ocean', 'pond', 'reservoir', 'river', 'riverbank', 'sea', 'sound', 'strait', 'water', 'wetland']);

function normalizedText(value) {
  return String(value ?? '').normalize('NFKC').trim().toLocaleLowerCase();
}

function canonicalKind(value) {
  const kind = normalizedText(value).replace(/[_\s]+/g, '-');
  if (['administrative', 'administrative-area', 'admin', 'boundary'].includes(kind)) return 'administrative-area';
  if (['island', 'islet', 'archipelago', 'landmass'].includes(kind)) return 'island';
  if (['water', 'water-body', 'waterbody', 'lake', 'pond', 'reservoir', 'river', 'sea', 'bay'].includes(kind) || WATER_TYPES.has(kind)) return 'water';
  if (['park', 'protected-area'].includes(kind)) return 'park';
  if (['facility', 'site', 'footprint'].includes(kind)) return 'facility';
  return kind;
}

function candidateKind(item) {
  const category = normalizedText(item.category ?? item.class);
  const type = normalizedText(item.type);
  const tags = Object.fromEntries(Object.entries(item.extratags ?? {}).map(([key, value]) => [normalizedText(key), normalizedText(value)]));
  if (category === 'boundary' || type === 'administrative' || tags.boundary === 'administrative') return 'administrative-area';
  if (type === 'island' || type === 'islet' || type === 'archipelago' || tags.place === 'island') return 'island';
  if (category === 'water' || WATER_TYPES.has(type) || tags.natural === 'water' || Boolean(tags.water)) return 'water';
  if (type === 'park' || tags.leisure === 'park') return 'park';
  if (category === 'amenity' || category === 'building' || category === 'leisure') return 'facility';
  return null;
}

function kindFromTags(tags = {}) {
  return candidateKind({
    category: tags.boundary === 'administrative' ? 'boundary' : null,
    type: tags.natural ?? tags.place ?? tags.water ?? tags.leisure ?? null,
    extratags: tags,
  });
}

function candidateNames(item) {
  return [item.name, item.display_name?.split(',')[0], ...Object.values(item.namedetails ?? {})].filter(Boolean).map(normalizedText);
}

function candidateNameScore(item, targetName) {
  const target = normalizedText(targetName);
  if (normalizedText(item.name) === target) return 4;
  if (normalizedText(item.display_name?.split(',')[0]) === target) return 3;
  if (candidateNames(item).includes(target)) return 2;
  return 0;
}

function candidateContextScore(item, context) {
  const tokens = String(context ?? '').split(/[\s,、，/]+/).map(normalizedText).filter((token) => token.length >= 2);
  if (!tokens.length) return 0;
  const haystack = normalizedText([item.display_name, ...Object.values(item.address ?? {})].join(' '));
  return tokens.reduce((score, token) => score + (haystack.includes(token) ? 1 : 0), 0);
}

function candidateMatchesKind(item, requestedKind) {
  const actual = candidateKind(item);
  return actual != null && (!requestedKind || actual === canonicalKind(requestedKind));
}

function selectCandidate(items, name, context, requestedKind) {
  const ranked = items
    .filter((item) => (item.osm_type === 'relation' || item.osm_type === 'way') && candidateNameScore(item, name) > 0 && candidateMatchesKind(item, requestedKind))
    .map((item) => ({ item, score: candidateNameScore(item, name) * 100 + candidateContextScore(item, context) * 10 + (requestedKind ? 5 : 0) }))
    .sort((a, b) => b.score - a.score);
  if (!ranked.length) return null;
  const topScore = ranked[0].score;
  const top = ranked.filter((entry) => entry.score === topScore);
  const uniqueTop = new Map(top.map((entry) => [`${entry.item.osm_type}:${entry.item.osm_id}`, entry.item]));
  if (uniqueTop.size > 1) {
    const ids = [...uniqueTop.keys()].join(', ');
    fail(`Ambiguous OSM candidates for ${name}${context ? `, ${context}` : ''}: ${ids}; provide --context or --osm-type/--osm-id`);
  }
  return top[0].item;
}

function candidateContext(item) {
  return [...new Set(Object.entries(item.address ?? {})
    .filter(([key]) => !key.toLowerCase().startsWith('iso3166') && key !== 'country_code' && key !== 'island' && key !== 'lake')
    .map(([, value]) => value)
    .filter(Boolean))].join(' ');
}

async function findReusableTarget(outputDir, name, requestedKind, context) {
  const entries = await fs.readdir(outputDir, { withFileTypes: true });
  const matches = new Map();
  const normalizedName = normalizedText(name);
  const normalizedContext = normalizedText(context);
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.metadata.json')) continue;
    try {
      const metadata = JSON.parse(await fs.readFile(path.join(outputDir, entry.name), 'utf8'));
      const source = metadata.source ?? {};
      const osmType = source.osmType ?? metadata.osmType;
      const osmId = source.osmId ?? metadata.osmId;
      if (!osmType || !osmId || normalizedText(metadata.name) !== normalizedName) continue;
      if (requestedKind && canonicalKind(metadata.kind) !== canonicalKind(requestedKind)) continue;
      if (normalizedContext && metadata.context && !normalizedText(metadata.context).includes(normalizedContext)) continue;
      const key = `${osmType}:${osmId}`;
      if (!matches.has(key)) matches.set(key, { metadata, osmType, osmId: String(osmId) });
    } catch {
      // Ignore unrelated or incomplete metadata files while looking for a reusable target.
    }
  }
  if (matches.size > 1) fail(`Ambiguous reusable targets for ${name}; provide --osm-type/--osm-id`);
  return matches.values().next().value ?? null;
}

function svgViewport(bbox, padding) {
  const lonScale = Math.cos(((bbox[1] + bbox[3]) / 2) * Math.PI / 180);
  const contentWidth = (bbox[2] - bbox[0]) * lonScale;
  const contentHeight = bbox[3] - bbox[1];
  return { lonScale, contentWidth, contentHeight, viewWidth: contentWidth + padding * 2, viewHeight: contentHeight + padding * 2 };
}

function rasterDimensions(aspectRatio) {
  const safeRatio = Number.isFinite(aspectRatio) && aspectRatio > 0 ? aspectRatio : 1;
  return safeRatio >= 1
    ? { width: 2048, height: Math.max(1, Math.round(2048 / safeRatio)) }
    : { width: Math.max(1, Math.round(2048 * safeRatio)), height: 2048 };
}

function svgText(geometry, bbox, width, height, padding) {
  const { lonScale, viewWidth, viewHeight } = svgViewport(bbox, padding);
  const mapPoint = ([lon, lat]) => [padding + (lon - bbox[0]) * lonScale, padding + (bbox[3] - lat)];
  const ringPath = (ring) => ring.map((point, index) => { const [x, y] = mapPoint(point); return `${index ? 'L' : 'M'}${x.toFixed(3)},${y.toFixed(3)}`; }).join(' ') + (isAreaGeometry(geometry) ? ' Z' : '');
  const d = allRings(geometry).map(ringPath).join(' ');
  const pathStyle = isAreaGeometry(geometry)
    ? 'fill="#6c9f84" fill-rule="evenodd"'
    : 'fill="none" stroke="#2b6cb0" stroke-width="0.15" stroke-linecap="round" stroke-linejoin="round"';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${viewWidth.toFixed(6)} ${viewHeight.toFixed(6)}" preserveAspectRatio="xMidYMid meet"><path d="${d}" ${pathStyle}/></svg>\n`;
}

function usage() { console.error('Usage: node convert_osm_boundary.mjs --name NAME --context CONTEXT [--kind KIND] [--osm-type relation|way --osm-id ID] --output-dir DIR [--deep] [--no-svg] [--keep-raw] [--reuse-cache]'); }

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outputDir = path.resolve(args['output-dir'] ?? 'outputs');
  const explicitType = args['osm-type'] ? String(args['osm-type']) : null;
  const explicitId = args['osm-id'] ? String(args['osm-id']) : null;
  const name = args.name ? String(args.name) : null;
  const context = args.context ? String(args.context) : '';
  const requestedKind = args.kind ? String(args.kind) : null;
  if (args.help) { usage(); return; }
  if (!explicitId && !name) { usage(); fail('Provide --name or both --osm-type and --osm-id'); }
  if (explicitId && !explicitType) fail('--osm-type is required with --osm-id');
  if (explicitId && (!/^\d+$/.test(explicitId) || Number(explicitId) <= 0)) fail('--osm-id must be a positive integer');
  if (explicitType && explicitType !== 'relation' && explicitType !== 'way') fail('--osm-type must be relation or way');
  await fs.mkdir(outputDir, { recursive: true });

  let discovery = null;
  let osmType = explicitType;
  let osmId = explicitId;
  let inferredKind = null;
  let discoveredContext = '';
  let discoveryCacheFile = null;
  let priorMetadata = null;
  if (!osmId && args['reuse-cache']) {
    const reusable = await findReusableTarget(outputDir, name, requestedKind, context);
    if (reusable) {
      priorMetadata = reusable.metadata;
      osmType = reusable.osmType;
      osmId = reusable.osmId;
      inferredKind = priorMetadata.kind ?? null;
      discoveredContext = priorMetadata.context ?? '';
      discovery = priorMetadata.source?.discovery ?? null;
      discoveryCacheFile = priorMetadata.source?.discoveryCacheFile ?? null;
    }
  }
  if (!osmId) {
    const query = [name, context].filter(Boolean).join(', ');
    const url = new URL('https://nominatim.openstreetmap.org/search');
    url.search = new URLSearchParams({ format: 'jsonv2', addressdetails: '1', extratags: '1', namedetails: '1', limit: '5', q: query }).toString();
    discoveryCacheFile = path.join(outputDir, `.nominatim-${sha256(query).slice(0, 16)}.json`);
    if (args['reuse-cache']) {
      try {
        const cachedDiscovery = JSON.parse(await fs.readFile(discoveryCacheFile, 'utf8'));
        if (cachedDiscovery.query === query && Array.isArray(cachedDiscovery.candidates)) {
          discovery = cachedDiscovery;
          discovery.fromCache = true;
        }
      } catch (error) {
        if (error.code !== 'ENOENT') discovery = null;
      }
    }
    if (!discovery) {
      const response = await fetchJson(url);
      discovery = { url: url.toString(), query, candidates: response.json, responseSha256: sha256(response.text), fromCache: false };
      await fs.writeFile(discoveryCacheFile, `${JSON.stringify(discovery, null, 2)}\n`, 'utf8');
    }
    const candidate = selectCandidate(discovery.candidates, name, context, requestedKind);
    if (!candidate) fail(`No OSM ${requestedKind ? `${requestedKind} ` : ''}boundary candidate found for ${query}`);
    osmType = candidate.osm_type;
    osmId = String(candidate.osm_id);
    inferredKind = candidateKind(candidate);
    discoveredContext = candidateContext(candidate);
    discovery.selection = { requestedKind, inferredKind, selectedCandidate: { osmType, osmId: Number(osmId), name: candidate.name, displayName: candidate.display_name, category: candidate.category ?? candidate.class ?? null, type: candidate.type } };
  }

  const apiType = osmType === 'relation' ? 'relation' : 'way';
  const objectUrl = `https://api.openstreetmap.org/api/0.6/${apiType}/${osmId}/full.json`;
  const stem = `${osmType === 'relation' ? 'R' : 'W'}${osmId}`;
  if (args['reuse-cache'] && !priorMetadata) {
    try {
      priorMetadata = JSON.parse(await fs.readFile(path.join(outputDir, `${stem}.metadata.json`), 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') priorMetadata = null;
    }
  }
  let kind = requestedKind ?? priorMetadata?.kind ?? inferredKind ?? 'boundary';
  const resolvedContext = context || priorMetadata?.context || discoveredContext;
  const boundaryDefinition = args['boundary-definition'] ? String(args['boundary-definition']) : priorMetadata?.boundaryDefinition ?? null;
  const priorReferenceArea = priorMetadata?.referenceComparison?.referenceAreaKm2;
  const referenceAreaKm2 = args['reference-area-km2'] ? Number(args['reference-area-km2']) : (Number.isFinite(priorReferenceArea) ? priorReferenceArea : null);
  const rawCachePath = path.join(outputDir, `${stem}.osm-full.json`);
  let fetched;
  let fromCache = false;
  if (args['reuse-cache']) {
    try {
      const text = await fs.readFile(rawCachePath, 'utf8');
      fetched = { text, json: JSON.parse(text) };
      fromCache = true;
    } catch (error) {
      if (error.code !== 'ENOENT') fetched = null;
    }
  }
  if (!fetched) fetched = await fetchJson(objectUrl);
  const built = apiType === 'relation' ? relationGeometry(fetched.json, osmId) : wayGeometry(fetched.json, osmId);
  if (!requestedKind && !priorMetadata?.kind && kind === 'boundary') {
    kind = kindFromTags(built.relation?.tags ?? built.tags ?? {}) ?? kind;
  }
  const geometry = built.geometry;
  const areaGeometry = isAreaGeometry(geometry);
  const lineGeometry = geometry.type === 'LineString';
  const bbox = bboxOf(geometry);
  if (!coordinatesAreValid(geometry)) fail('Geometry contains invalid or out-of-range coordinates');
  if (bbox[2] - bbox[0] > 180) fail('Antimeridian-crossing geometry requires an antimeridian-aware transform; refusing an incorrect ratio');
  if (areaGeometry && bbox[3] <= bbox[1]) fail('Area geometry has no positive latitude span');
  if (!areaGeometry && bbox[2] <= bbox[0] && bbox[3] <= bbox[1]) fail('Line geometry has no extent');
  const areaKm2 = sphericalAreaKm2(geometry);
  const lineLength = lineLengthKm(geometry);
  const longitudeSpan = bbox[2] - bbox[0];
  const latitudeSpan = bbox[3] - bbox[1];
  const centerLat = (bbox[1] + bbox[3]) / 2;
  const coordinateBboxAspectRatio = latitudeSpan > 0 ? longitudeSpan / latitudeSpan : null;
  const projectedAspectRatio = longitudeSpan > 0 && latitudeSpan > 0
    ? (longitudeSpan * Math.cos(centerLat * Math.PI / 180)) / latitudeSpan
    : null;
  const projectedWidth = longitudeSpan * Math.cos(centerLat * Math.PI / 180);
  const projectedHeight = latitudeSpan;
  const svgPadding = Math.max(projectedWidth, projectedHeight) * 0.04;
  const svgBounds = svgViewport(bbox, svgPadding);
  const svgCanvasAspectRatio = svgBounds.viewHeight > 0 ? svgBounds.viewWidth / svgBounds.viewHeight : 1;
  const svgDimensions = rasterDimensions(svgCanvasAspectRatio);
  const maskDimensions = rasterDimensions(projectedAspectRatio);
  const rings = allRings(geometry);
  const deepChecks = args.deep ? { selfIntersectionCount: rings.reduce((sum, ring) => sum + selfIntersectionCount(ring, areaGeometry), 0) } : null;
  if (deepChecks && deepChecks.selfIntersectionCount > 0) fail(`Self-intersections found: ${deepChecks.selfIntersectionCount}`);
  const resolvedName = name ?? priorMetadata?.name ?? built.relation?.tags?.name ?? built.tags?.name ?? `${osmType}:${osmId}`;
  const areaRatio = areaKm2 != null && Number.isFinite(referenceAreaKm2) && referenceAreaKm2 > 0 ? areaKm2 / referenceAreaKm2 : null;
  const areaDifferencePercent = areaRatio == null ? null : (areaRatio - 1) * 100;
  const geometryAreaKm2 = areaKm2 == null ? null : Number(areaKm2.toFixed(8));
  const lineLengthKmValue = lineLength == null ? null : Number(lineLength.toFixed(8));
  const projectedAspectRatioValue = projectedAspectRatio == null ? null : Number(projectedAspectRatio.toFixed(8));
  const coordinateBboxAspectRatioValue = coordinateBboxAspectRatio == null ? null : Number(coordinateBboxAspectRatio.toFixed(8));
  const svgCanvasAspectRatioValue = Number(svgCanvasAspectRatio.toFixed(8));
  const geometrySummary = {
    type: geometry.type,
    bbox,
    areaKm2: geometryAreaKm2,
    lineLengthKm: lineLengthKmValue,
    vertexCount: rings.reduce((sum, ring) => sum + ring.length, 0),
    ringCount: areaGeometry ? rings.length : 0,
    closed: areaGeometry,
    boundaryStatus: areaGeometry ? 'closed-area-boundary' : 'open-linear-feature',
    coordinateBboxAspectRatio: coordinateBboxAspectRatioValue,
    projectedAspectRatio: projectedAspectRatioValue,
  };
  const geojson = { type: 'Feature', properties: { name: resolvedName, kind, context: resolvedContext, boundaryDefinition, geometryType: geometry.type, boundaryStatus: geometrySummary.boundaryStatus, osmType, osmId: Number(osmId), boundarySourceUrl: `https://www.openstreetmap.org/${osmType}/${osmId}`, license: 'OpenStreetMap contributors, ODbL 1.0' }, geometry };
  await fs.writeFile(path.join(outputDir, `${stem}.geojson`), `${JSON.stringify(geojson, null, 2)}\n`, 'utf8');
  if (!args['no-svg']) {
    await fs.writeFile(path.join(outputDir, `${stem}.preview.svg`), svgText(geometry, bbox, svgDimensions.width, svgDimensions.height, svgPadding), 'utf8');
  }
  if (args['keep-raw'] || args['reuse-cache']) await fs.writeFile(rawCachePath, fetched.text, 'utf8');
  const svgExport = args['no-svg'] ? null : { file: `${stem}.preview.svg`, width: svgDimensions.width, height: svgDimensions.height, aspectRatio: svgCanvasAspectRatioValue, contentAspectRatio: projectedAspectRatioValue, projection: 'local equirectangular, one x/y scale', mode: lineGeometry ? 'line' : 'area' };
  const pngMaskExport = lineGeometry
    ? { supported: false, reason: 'An open LineString has no area to rasterize as a mask' }
    : { supported: true, recommendedWidth: maskDimensions.width, recommendedHeight: maskDimensions.height, aspectRatio: projectedAspectRatioValue, rendered: false };
  const validationChecks = areaGeometry
    ? ['GeoJSON structure', 'closed rings', 'coordinate range', 'outer/inner assignment', 'aspect-preserving dimensions']
    : ['GeoJSON structure', 'coordinate range', 'OSM way node order preserved', 'open linear feature preserved', 'line preview dimensions recorded'];
  const metadata = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    name: resolvedName,
    kind,
    context: resolvedContext,
    boundaryDefinition,
    source: { osmType, osmId: Number(osmId), objectUrl, responseSha256: sha256(fetched.text), discovery, discoveryCacheFile: discoveryCacheFile ? path.basename(discoveryCacheFile) : null, fromCache, rawResponseFile: (args['keep-raw'] || args['reuse-cache']) ? `${stem}.osm-full.json` : null },
    geometry: geometrySummary,
    referenceComparison: { referenceAreaKm2: Number.isFinite(referenceAreaKm2) ? referenceAreaKm2 : null, areaRatio, areaDifferencePercent },
    export: { svg: svgExport, pngMask: pngMaskExport },
    validation: { status: lineGeometry ? 'passed-with-note' : 'passed', checks: validationChecks, deepChecksRequested: Boolean(args.deep), deepChecks },
    files: { geojson: `${stem}.geojson`, metadata: `${stem}.metadata.json`, previewSvg: args['no-svg'] ? null : `${stem}.preview.svg`, discoveryCache: discoveryCacheFile ? path.basename(discoveryCacheFile) : null },
  };
  await fs.writeFile(path.join(outputDir, `${stem}.metadata.json`), `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ osm: `${osmType}:${osmId}`, geometry: geometry.type, areaKm2: areaKm2 == null ? null : Number(areaKm2.toFixed(6)), lineLengthKm: lineLength == null ? null : Number(lineLength.toFixed(6)), projectedAspectRatio: projectedAspectRatioValue, canvasAspectRatio: svgCanvasAspectRatioValue, fromCache, outputDir }, null, 2));
}

main().catch((error) => { console.error(error.stack || error.message || String(error)); process.exitCode = 1; });
