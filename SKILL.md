---
name: osm-boundary-conversion
description: Resolve and verify OSM-derived boundaries for islands, lakes, parks, administrative areas, and site footprints, then preserve canonical GeoJSON plus metadata and export-ready specifications for SVG, PNG masks, raster tiles, KML, or other image/data outputs. Use when a boundary must be selected from OSM, Nominatim, or Overpass, reconstructed from relations, checked against place/area/context, converted, or saved into a project catalog.
---

# OSM Boundary Conversion

## Purpose

Use a verified vector boundary as the source of truth and derive images or other formats from it. Keep the source identity, boundary meaning, geometry checks, and export transform together so the result can be reproduced later.

## Workflow

### 1. Define what the boundary means

Before querying OSM, record:

- target feature and aliases;
- boundary kind: island/landmass, lake or water surface, park, administrative area, facility footprint, or another explicitly named concept;
- whether surrounding water, territorial waters, enclaves, islands, and holes are included;
- geographic context and an expected order of magnitude for area;
- required output formats, coordinate reference system, image dimensions, and whether exact georeferencing is required.

If the request does not distinguish a natural feature from an administrative boundary, keep both as candidates and state the choice. Do not silently use whichever same-name result appears first.

### 2. Discover candidates

Use Nominatim for human-readable candidate discovery. For the initial lookup, do not request `polygon_geojson=1`: geometry in the discovery response is a large, avoidable transfer. Default to `format=jsonv2&addressdetails=1&extratags=1&namedetails=1&limit=5`, retain the returned `osm_type`, `osm_id`, display name, tags, address context, and query, and fetch complete geometry only after selecting a candidate. Request polygon geometry only when identity is still ambiguous and only for the smallest necessary candidate set.

Use Overpass or the OSM API when the task needs tagged-element discovery, a closed way, or complete relation members and geometry. Query by name plus context, coordinates, or relevant tags; do not treat a name-only match as proof of identity. Respect public-service rate limits, send a descriptive User-Agent, cache responses, and retry transient errors with backoff.

Use the direct Nominatim/OSM HTTP endpoints for this workflow. Do not use generic web search, browser page scraping, or a search result page to reach an OSM API endpoint; those add latency and make the request harder to bound.

Typical tags to inspect include `type=multipolygon`, `boundary=administrative`, `natural=coastline`, `natural=water`, `water=lake`, `place=island`, `leisure=park`, and the feature's local name tags. Tags are evidence, not a substitute for checking the actual geometry and intended definition.

Use a fast path when a verified `osmType` and `osmId` are already available: skip Nominatim name search, fetch the complete pinned object once, and validate the result locally. Treat alternate geometries such as Geolonia, Natural Earth, or WDPA as optional comparisons, not required steps on every run. Put a bounded timeout on network requests, avoid unbounded retry/sleep loops, and reuse a local response cache when the source revision has not changed.

Use three execution modes:

- **Quick (default):** one Nominatim discovery request when no ID is supplied, one complete OSM object request, local geometry checks, and canonical GeoJSON plus metadata and SVG/export specifications.
- **Deep (opt-in):** official-area lookup, alternate-source comparison, PNG preview, or visual inspection only when the user requests it, the quick checks are ambiguous, or the feature is unusually complex.
- **Fallback:** if a bounded request fails or exceeds its timeout, stop that request, report the exact stage, and use a documented alternate source only when appropriate. Do not silently start a long chain of retries.

For a new name-based request, use a total network budget of roughly 45 seconds: one discovery request and one full-object request, with at most one bounded retry for a transient failure. Once an ID is fixed, never repeat discovery for the same run.

When this skill folder contains `scripts/convert_osm_boundary.mjs`, use that bundled converter first instead of writing a new boundary-assembly script. Typical commands are:

```text
node scripts/convert_osm_boundary.mjs --name "豊中市" --context "大阪府 日本" --output-dir outputs
node scripts/convert_osm_boundary.mjs --osm-type relation --osm-id 358672 --name "豊中市" --output-dir outputs
node scripts/convert_osm_boundary.mjs --osm-type relation --osm-id 358672 --output-dir outputs --reuse-cache
```

The bundled converter performs the bounded HTTP requests, relation/way assembly, GeoJSON save, metadata save, and aspect-preserving SVG specification. `--reuse-cache` reuses a previously saved full OSM response for same-ID regeneration; omit it when a fresh source revision is required. Use `--deep` only when deeper checks are requested or the quick result is ambiguous; do not reimplement its core algorithm in the task workspace.

### 3. Select and pin the correct OSM object

Compare every viable candidate on all of the following:

1. exact or alias name and language tags;
2. country, prefecture, municipality, or nearby landmark context;
3. tags and object type appropriate to the requested boundary;
4. centroid and bounding box;
5. polygon or multipolygon shape, including holes and disconnected parts;
6. rough area and plausibility against an official or trusted reference.

Accept only a candidate that passes the checks. Store the stable `osmType` and `osmId` (for example, `relation:123` or `way:456`) with the output. If no candidate passes, report the ambiguity and request a better identifier or use an explicitly documented alternate source.

### 4. Fetch and normalize complete geometry

For a relation, fetch the full relation and its members, preserve `outer` and `inner` roles, and reconstruct the multipolygon from complete ways. For a closed way, confirm that the first and last coordinates match. Never use a bounding box or a simplified search preview as the final boundary.

Normalize all coordinates to GeoJSON order `[longitude, latitude]`. Handle antimeridian crossings deliberately, preserve holes, remove only exact duplicate consecutive points, and keep enough vertices for the intended scale. Do not simplify before the unsimplified geometry has been saved or checksummed.

For large or complex relations that time out or return an unusable polygon, try a bounded alternate OSM endpoint or a smaller, explicitly scoped query. If OSM remains unusable, a source such as Natural Earth or WDPA may be used only as a documented fallback; record the reason, source identity, and changed boundary definition, and never label the fallback as OSM geometry.

### 5. Validate before saving derivatives

Run checks appropriate to the feature and output scale:

- valid JSON and GeoJSON structure;
- `Polygon` or `MultiPolygon` geometry with non-empty, closed rings;
- correct outer/inner winding or library-normalized winding;
- no self-intersections, broken relation joins, accidental duplicate rings, or holes outside their outer ring;
- plausible bounding box, centroid, and coordinate range;
- geodesic or equal-area projected area, with holes subtracted;
- comparison with official/reference area and the intended boundary meaning;
- area preservation after any simplification, with a stated tolerance;
- visual overlay or rendered preview at the target scale.

In Quick mode, perform the structural, ring, coordinate, area-plausibility, and aspect-ratio checks locally. Do not block the save on a fresh official website, Geolonia, or raster-renderer request when those references are not already cached; record them as optional checks instead.

For global features, do not calculate area with a flat longitude/latitude shoelace formula without accounting for projection and antimeridian behavior. A large area mismatch is a signal to revisit the candidate and definition, not something to hide by changing metadata.

Keep ratio meanings separate. `areaRatio = geometryArea / referenceArea` and `areaDifferencePercent` describe area agreement; they do not describe an image's shape. For an image, record at least `coordinateBboxAspectRatio = longitudeSpan / latitudeSpan`, `projectedAspectRatio = longitudeSpan * cos(centerLatitude) / latitudeSpan`, and the actual canvas ratio. Never answer a visual "比率" question with an area ratio.

### 6. Save a canonical, reproducible data record

Save the canonical vector feature first. Prefer one detailed geometry file plus a lightweight catalog entry when a project has a catalog/detail split. Use stable names based on the pinned source ID, such as `R123.geojson` for a relation and `W456.geojson` for a way, unless the host project has a stronger naming convention.

At minimum, preserve these properties alongside the geometry:

```json
{
  "id": "stable-project-id",
  "name": "display name",
  "kind": "island",
  "context": "country or regional context",
  "aliases": ["alternate name"],
  "osmType": "relation",
  "osmId": 123,
  "boundaryDefinition": "land area excluding surrounding water",
  "boundarySourceLabel": "OpenStreetMap",
  "boundarySourceUrl": "https://www.openstreetmap.org/relation/123",
  "sourceQuery": "name and context used for discovery",
  "fetchedAt": "ISO-8601 timestamp",
  "geometryAreaKm2": 0,
  "officialAreaKm2": null,
  "geometryFile": "path/to/detail.geojson",
  "coordinateSystem": "WGS84 / EPSG:4326",
  "license": "OpenStreetMap contributors, ODbL"
}
```

Add `geometryAreaKm2`, `bbox`, validation status, simplification tolerance, and reference-area source when available. Preserve raw API responses or a checksum in a research cache when reproducibility matters, but keep large caches out of the public catalog unless they are intentionally part of the project.

For Dokodemo Nauru, inspect the current nested `github-dokodemo-nauru` repository before writing. The established pattern is a catalog under `data/` with detailed files under a feature-specific directory, metadata such as `osmType`, `osmId`, `geometryFile`, and source attribution, and local audit scripts under `scripts/`. Re-check current paths and schema rather than assuming an old revision is unchanged.

### 7. Derive image and other outputs from the vector

Treat GeoJSON or another validated vector as canonical; never make a screenshot the only saved boundary. For each derivative, save the transform specification with the output:

- **SVG:** choose a projection or planar transform, map the target bounds to the viewBox, preserve holes as subpaths, and document whether y-axis inversion was applied.
- **PNG/TIFF mask:** choose width, height, bounds, background, fill/alpha convention, antialiasing, and pixel-to-coordinate transform. Use transparency or a documented mask value outside the boundary. If exact geographic placement is needed, use GeoTIFF or a world-file/sidecar rather than an unreferenced PNG.
- **Raster tiles or MBTiles:** record zoom range, tile scheme, projection, source geometry version, and simplification rule.
- **KML, GeoPackage, TopoJSON, or other formats:** preserve CRS, holes, feature identity, attribution, and the conversion tool/version.

Render a preview and inspect it for flipped latitude, cropped edges, missing holes, antimeridian seams, disconnected pieces, and geometry extending outside the expected bounds when a visual preview is requested or needed. Keep vector and raster filenames/version identifiers linked. Do not generate a PNG merely to validate an SVG or GeoJSON structure; a PNG preview is Deep mode unless the user explicitly asks for a raster image.

For aspect-preserving output, use one projected x/y scale and derive dimensions from the projected ratio. Make the SVG canvas ratio agree with the projected content ratio within rounding tolerance. If a square canvas is explicitly required, letterbox or pad it while keeping one scale; never map longitude and latitude independently to the full square. Derive raster dimensions from the same ratio, for example a projected ratio of `1.3919` with a long edge of `2048` becomes approximately `2048×1471`, not `2048×2048`.

### 8. Report provenance and hand off

Return a compact receipt containing the accepted OSM object, rejected or ambiguous candidates, source URLs and retrieval time, boundary definition, validation results, output paths, export settings, and any fallback or manual correction. If publication is requested, stage only the reviewed files, preserve unrelated worktree changes, and verify the remote raw files and live site separately from local validation.

## Decision rules

- Prefer an explicit verified OSM ID over a fresh name search.
- Prefer full OSM relation/member geometry over a Nominatim preview for the final vector.
- Use area as a plausibility check, never as the sole identity criterion.
- When an explicit ID is pinned, do not repeat discovery or unrelated reference downloads during ordinary regeneration.
- In Quick mode, keep network work to one discovery request plus one complete-object request; do not add official-site, Geolonia, or PNG requests unless they are needed or requested.
- Distinguish natural land, water surface, administrative territory, protected-area designation, and facility footprint; they are not interchangeable.
- Use Natural Earth, WDPA, or another source only as a declared fallback or composite source, with its own attribution and metadata.
- Save vector first, then rasterize or convert; preserve the conversion settings.
- Report area ratio, coordinate-bbox ratio, projected content ratio, and canvas ratio as separate named values.
- Do not delete an old geometry or overwrite a raw cache until the replacement, catalog references, and rendered preview have passed validation.

## Failure handling

- **Same-name wrong object:** repeat with context, coordinates, aliases, and explicit OSM IDs; reject the result instead of accepting the first polygon.
- **Island includes a country or territorial water:** inspect tags and area definition, compare the shape with a trusted reference, and choose a landmass relation or documented alternate source.
- **Lake or park is missing or split:** query `natural=water`, `water=*`, relation members, and nearby coordinates; keep separate features separate unless the requested definition is a group boundary.
- **Relation/API timeout:** retry a bounded endpoint/query with backoff, then document a fallback; do not silently replace the source.
- **Geometry looks plausible but renders wrong:** check `[lon, lat]` order, ring closure, projection, y-axis direction, antimeridian handling, and hole winding before changing the data.
- **The output is square or too narrow:** inspect the actual SVG `width`, `height`, and `viewBox`, then compare canvas ratio with projected content ratio; remove independent x/y normalization and recompute raster dimensions from one projected scale.
- **A ratio answer seems contradictory:** label whether it is area, coordinate-bbox, projected-content, or canvas ratio before making a conclusion.
- **Simplification changes the result:** reduce tolerance or retain the detailed geometry and generate a scale-specific derivative; record the measured area ratio.
- **Attribution is missing:** stop the export handoff and restore OSM/ODbL or alternate-source attribution in the data and receipt.

## Keep execution bounded

- Prefer an existing reusable converter or one compact deterministic helper. Do not build a long bespoke reconstruction, rasterization, and audit script in several exploratory stages when the canonical OSM response can be processed directly.
- After one successful fetch and one successful local validation, save the outputs and report them. Do not fetch the same relation again solely to recalculate a hash, redraw a preview, or repeat a check already recorded in metadata.
- If a required step is still running after its budget, stop and report the stage and elapsed time; do not continue silently or ask the user to wait without a concrete diagnostic.

## Final checklist

- [ ] Boundary definition and inclusion/exclusion rules are written down.
- [ ] Candidate identity is pinned by verified `osmType` and `osmId`, or the alternate source is explicit.
- [ ] Complete polygon/multipolygon geometry is saved in GeoJSON coordinate order.
- [ ] Geometry, area, bounds, holes, and target-scale rendering have been checked.
- [ ] Canonical metadata, provenance, license, and retrieval time are present.
- [ ] SVG/PNG/raster/export settings and georeferencing sidecars are saved where needed.
- [ ] Catalog references and output paths are consistent.
- [ ] Only reviewed files are handed off for publication; unrelated changes remain untouched.
