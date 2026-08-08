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

function selfIntersectionCount(ring) {
  let count = 0;
  const segmentCount = ring.length - 1;
  for (let i = 0; i < segmentCount; i += 1) {
    for (let j = i + 1; j < segmentCount; j += 1) {
      if (j === i + 1 || (i === 0 && j === segmentCount - 1)) continue;
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
  const ring = cleanClosedRing(way.nodes.map((nodeId) => nodes.get(String(nodeId))));
  return { relation: null, geometry: { type: 'Polygon', coordinates: [normalizeOrientation(ring, true)] } };
}

function allRings(geometry) { return geometry.type === 'Polygon' ? geometry.coordinates : geometry.coordinates.flat(); }

function bboxOf(geometry) {
  const points = allRings(geometry).flat();
  if (!points.length) fail('Geometry has no coordinates');
  return [Math.min(...points.map((point) => point[0])), Math.min(...points.map((point) => point[1])), Math.max(...points.map((point) => point[0])), Math.max(...points.map((point) => point[1]))];
}

function sphericalAreaKm2(geometry) {
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

function coordinatesAreValid(geometry) {
  return allRings(geometry).flat().every(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat) && lon >= -180 && lon <= 180 && lat >= -90 && lat <= 90);
}

function svgText(geometry, bbox, width, height, padding) {
  const lonScale = Math.cos(((bbox[1] + bbox[3]) / 2) * Math.PI / 180);
  const mapPoint = ([lon, lat]) => [padding + (lon - bbox[0]) * lonScale, padding + (bbox[3] - lat)];
  const ringPath = (ring) => ring.map((point, index) => { const [x, y] = mapPoint(point); return `${index ? 'L' : 'M'}${x.toFixed(3)},${y.toFixed(3)}`; }).join(' ') + ' Z';
  const contentWidth = (bbox[2] - bbox[0]) * lonScale;
  const contentHeight = bbox[3] - bbox[1];
  const viewWidth = contentWidth + padding * 2;
  const viewHeight = contentHeight + padding * 2;
  const d = allRings(geometry).map(ringPath).join(' ');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${viewWidth.toFixed(6)} ${viewHeight.toFixed(6)}" preserveAspectRatio="xMidYMid meet"><path d="${d}" fill="#6c9f84" fill-rule="evenodd"/></svg>\n`;
}

function usage() { console.error('Usage: node convert_osm_boundary.mjs --name NAME --context CONTEXT [--osm-type relation --osm-id ID] --output-dir DIR [--deep] [--reuse-cache]'); }

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outputDir = path.resolve(args['output-dir'] ?? 'outputs');
  const explicitType = args['osm-type'] ? String(args['osm-type']) : null;
  const explicitId = args['osm-id'] ? String(args['osm-id']) : null;
  const name = args.name ? String(args.name) : null;
  const context = args.context ? String(args.context) : '';
  if (args.help) { usage(); return; }
  if (!explicitId && !name) { usage(); fail('Provide --name or both --osm-type and --osm-id'); }
  if (explicitType && explicitType !== 'relation' && explicitType !== 'way') fail('--osm-type must be relation or way');
  await fs.mkdir(outputDir, { recursive: true });

  let discovery = null;
  let osmType = explicitType;
  let osmId = explicitId;
  if (!osmId) {
    const query = [name, context].filter(Boolean).join(', ');
    const url = new URL('https://nominatim.openstreetmap.org/search');
    url.search = new URLSearchParams({ format: 'jsonv2', addressdetails: '1', extratags: '1', namedetails: '1', limit: '5', q: query }).toString();
    const response = await fetchJson(url);
    discovery = { url: url.toString(), query, candidates: response.json, responseSha256: sha256(response.text) };
    const candidate = response.json.find((item) => {
      const label = `${item.category ?? item.class ?? ''} ${item.type ?? ''}`;
      return (item.name === name || item.display_name?.startsWith(`${name},`)) && (item.osm_type === 'relation' || item.osm_type === 'way') && (label.includes('boundary') || label.includes('administrative'));
    });
    if (!candidate) fail(`No OSM boundary candidate found for ${query}`);
    osmType = candidate.osm_type;
    osmId = String(candidate.osm_id);
  }

  const apiType = osmType === 'relation' ? 'relation' : 'way';
  const objectUrl = `https://api.openstreetmap.org/api/0.6/${apiType}/${osmId}/full.json`;
  const stem = `${osmType === 'relation' ? 'R' : 'W'}${osmId}`;
  let priorMetadata = null;
  if (args['reuse-cache']) {
    try {
      priorMetadata = JSON.parse(await fs.readFile(path.join(outputDir, `${stem}.metadata.json`), 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') priorMetadata = null;
    }
  }
  const kind = args.kind ? String(args.kind) : priorMetadata?.kind ?? 'boundary';
  const resolvedContext = context || priorMetadata?.context || '';
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
  const geometry = built.geometry;
  const bbox = bboxOf(geometry);
  if (!coordinatesAreValid(geometry)) fail('Geometry contains invalid or out-of-range coordinates');
  if (bbox[2] - bbox[0] > 180) fail('Antimeridian-crossing geometry requires an antimeridian-aware transform; refusing an incorrect ratio');
  if (bbox[3] <= bbox[1]) fail('Geometry has no positive latitude span');
  const areaKm2 = sphericalAreaKm2(geometry);
  const centerLat = (bbox[1] + bbox[3]) / 2;
  const projectedAspectRatio = ((bbox[2] - bbox[0]) * Math.cos(centerLat * Math.PI / 180)) / (bbox[3] - bbox[1]);
  const rasterWidth = projectedAspectRatio >= 1 ? 2048 : Math.max(1, Math.round(2048 * projectedAspectRatio));
  const rasterHeight = projectedAspectRatio >= 1 ? Math.max(1, Math.round(2048 / projectedAspectRatio)) : 2048;
  const rings = allRings(geometry);
  const deepChecks = args.deep ? { selfIntersectionCount: rings.reduce((sum, ring) => sum + selfIntersectionCount(ring), 0) } : null;
  if (deepChecks && deepChecks.selfIntersectionCount > 0) fail(`Self-intersections found: ${deepChecks.selfIntersectionCount}`);
  const resolvedName = name ?? priorMetadata?.name ?? built.relation?.tags?.name ?? `${osmType}:${osmId}`;
  const areaRatio = Number.isFinite(referenceAreaKm2) && referenceAreaKm2 > 0 ? areaKm2 / referenceAreaKm2 : null;
  const areaDifferencePercent = areaRatio == null ? null : (areaRatio - 1) * 100;
  const geojson = { type: 'Feature', properties: { name: resolvedName, kind, context: resolvedContext, boundaryDefinition, osmType, osmId: Number(osmId), boundarySourceUrl: `https://www.openstreetmap.org/${osmType}/${osmId}`, license: 'OpenStreetMap contributors, ODbL 1.0' }, geometry };
  await fs.writeFile(path.join(outputDir, `${stem}.geojson`), `${JSON.stringify(geojson, null, 2)}\n`, 'utf8');
  if (!args['no-svg']) {
    const padding = Math.max(bbox[2] - bbox[0], bbox[3] - bbox[1]) * 0.04;
    await fs.writeFile(path.join(outputDir, `${stem}.preview.svg`), svgText(geometry, bbox, rasterWidth, rasterHeight, padding), 'utf8');
  }
  if (args['keep-raw'] || args['reuse-cache']) await fs.writeFile(rawCachePath, fetched.text, 'utf8');
  const metadata = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    name: resolvedName,
    kind,
    context: resolvedContext,
    boundaryDefinition,
    source: { osmType, osmId: Number(osmId), objectUrl, responseSha256: sha256(fetched.text), discovery, fromCache, rawResponseFile: (args['keep-raw'] || args['reuse-cache']) ? `${stem}.osm-full.json` : null },
    geometry: { type: geometry.type, bbox, areaKm2: Number(areaKm2.toFixed(8)), vertexCount: rings.reduce((sum, ring) => sum + ring.length, 0), ringCount: rings.length },
    referenceComparison: { referenceAreaKm2: Number.isFinite(referenceAreaKm2) ? referenceAreaKm2 : null, areaRatio, areaDifferencePercent },
    export: { svg: args['no-svg'] ? null : { file: `${stem}.preview.svg`, aspectRatio: Number(projectedAspectRatio.toFixed(8)), projection: 'local equirectangular, one x/y scale' }, pngMask: { recommendedWidth: rasterWidth, recommendedHeight: rasterHeight, aspectRatio: Number(projectedAspectRatio.toFixed(8)), rendered: false } },
    validation: { status: 'passed', checks: ['GeoJSON structure', 'closed rings', 'coordinate range', 'outer/inner assignment', 'aspect-preserving dimensions'], deepChecksRequested: Boolean(args.deep), deepChecks },
    files: { geojson: `${stem}.geojson`, metadata: `${stem}.metadata.json`, previewSvg: args['no-svg'] ? null : `${stem}.preview.svg` },
  };
  await fs.writeFile(path.join(outputDir, `${stem}.metadata.json`), `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ osm: `${osmType}:${osmId}`, geometry: geometry.type, areaKm2: Number(areaKm2.toFixed(6)), aspectRatio: Number(projectedAspectRatio.toFixed(6)), fromCache, outputDir }, null, 2));
}

main().catch((error) => { console.error(error.stack || error.message || String(error)); process.exitCode = 1; });
