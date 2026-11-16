// Current rendered media controls current footer metadata. Parent manifests remain history.
export function normalizeFooterMetadata(manifest, render, renderEvidence) {
  if (!manifest || render.output?.sha256 !== manifest.sha256) throw new Error('Footer metadata must bind this exact final SHA');
  const ys = render.positions ?? render.footer_layout?.ys;
  const sizes = render.font_sizes ?? render.footer_layout?.sizes;
  const windows = render.footer_windows ?? render.footer_display_windows_seconds;
  if (!Array.isArray(ys) || ys.length !== 3 || ys.some(y => !Number.isFinite(y) || y < 1728 || y > 1860)) throw new Error('Footer must use verified bottom positions');
  if (!Array.isArray(sizes) || sizes.length !== 3 || sizes.some(n => !Number.isFinite(n) || n <= 0)) throw new Error('Current font sizes required');
  if (!Array.isArray(windows) || !windows.length || windows.some(x => !Array.isArray(x) || x.length !== 2 || !Number.isFinite(x[0]) || !Number.isFinite(x[1]) || x[0] < 0 || x[1] <= x[0] || x[1] > render.duration_seconds + 0.05)) throw new Error('Actual display windows required');
  if (!Array.isArray(render.footer_lines) || render.footer_lines.length !== 3 || !renderEvidence?.path || !/^[a-f0-9]{64}$/.test(renderEvidence.sha256 ?? '')) throw new Error('Actual text and render receipt binding required');
  const out = Object.fromEntries(Object.entries(manifest).filter(([k]) => !k.startsWith('footer_')));
  return {
    ...out,
    footer_lines: [...render.footer_lines],
    footer_display_windows_seconds: windows.map(x => [...x]),
    footer_timing_segments: windows.map(([start, end]) => ({start, end})),
    footer_layout: {x: '(w-text_w)/2', ys: [...ys], sizes: [...sizes], pure_white: true, outline_width: 0, shadow: false, background_box: false},
    footer_timing_reason: `Current exact rendered version: bottom-center y=${ys.join('/')}; visible ${windows.map(x => x.join('–')).join(', ')} seconds. Actual frame readability remains a separate QA gate.`,
    footer_metadata_source: renderEvidence,
    footer_parent_metadata_inherited: false
  };
}
