// Adaptation: include job IDs and common native_source spelling; no per-video exceptions.
import fs from 'node:fs';
import {readJSON} from './common.mjs';
export function publicationIdentifiers(p){
 const l=p.production_lineage??{},pl=p.platform??{},list=x=>Array.isArray(x)?x:[];
 const v=[p.video_id,p.job_id,p.sha256,p.file?.sha256,p.upload_sha256,p.native_sha256,p.source_sha256,p.generation_id,p.generation_task_id,p.correction_of_exact_rejected_sha256,pl.task_id,pl.preview_asset_id,...list(pl.native_task_ids),...list(l.native_task_ids),...list(l.consumed_original_video_ids),...list(l.known_final_sha256),l.source_native?.sha256,l.native_source?.sha256,l.additional_source_native?.sha256,...list(l.native_sources).map(x=>x.sha256),...list(l.source_segments).map(x=>x.task),...list(pl.preview_urls).flatMap(x=>[x.task_id,x.active_id])];
 v.push(...list(p.identifiers),...list(p.known_lineage_identifiers),...list(l.all_lineage_identifiers),...list(l.preview_asset_ids),...list(l.local_versions_not_independent_creatives).map(x=>x.sha256),l.source_native?.platformTaskId,l.source_native?.previewAssetId,l.native_source?.platformTaskId,l.native_source?.previewAssetId);
 for(const e of p.qa?.evidence??[])if(e.path?.endsWith('overlay-render-receipt.json')&&fs.existsSync(e.path)){const r=readJSON(e.path);v.push(r.source?.sha256,r.input?.sha256);}
 return [...new Set(v.filter(Boolean).map(String))];
}
