/** Client-safe URL helpers for clips that play in YouTube's official embedded player. */

/** start/end are whole seconds; end is measured from the beginning of the video (YouTube player parameters). */
export function embedUrl(videoId: string, start: number, end: number) {
  return `https://www.youtube.com/embed/${videoId}?start=${Math.floor(start)}&end=${Math.ceil(end)}`;
}

export function watchUrl(videoId: string, start: number) {
  return `https://www.youtube.com/watch?v=${videoId}&t=${Math.floor(start)}s`;
}

export function embedCode(videoId: string, start: number, end: number, title: string) {
  const safe = title.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  return `<iframe width="560" height="315" src="${embedUrl(videoId, start, end)}" title="${safe}" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>`;
}
