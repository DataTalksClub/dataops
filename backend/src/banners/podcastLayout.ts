import type { BannerTemplate } from './model';

/**
 * One-speaker podcast covers (square 2000x2000, landscape 2400x1350).
 *
 * Flow layout, not absolute coordinates: the earlier template pinned the title at a
 * fixed top and the portrait at a fixed y, so a one- or two-line title left a huge
 * empty gap and the portrait + name pill sat against the bottom edge. Here the title
 * block sizes to its text and the portrait takes whatever height remains, so the gap
 * is only the date line, and every element is inside the canvas by construction.
 * Fields: title, titleFontSize, eventLabel, eventWhen (date · time), speaker1Name,
 * speaker1Portrait, assetFont, assetTexture, assetLogo.
 */
const MIC = '<svg class="mic" viewBox="0 0 150 150"><rect x="52" y="10" width="46" height="85" rx="23" fill="black" stroke="#285d9d" stroke-width="9"/><path d="M32 67v15a43 43 0 0086 0V67M75 126v18M48 144h54" fill="none" stroke="#285d9d" stroke-width="9" stroke-linecap="round"/></svg>';

const BASE_CSS = `*{box-sizing:border-box}html,body{margin:0;overflow:hidden}
body{background:white url('{{assetTexture}}') repeat;font-family:Ubuntu,sans-serif;color:#285d9d;font-weight:700}
.canvas{display:flex}.badge{display:flex;align-items:center;gap:34px}.mic{width:150px;height:150px}
.badge span{font-size:72px;line-height:1.2;padding:20px 26px;background:#285d9d;color:white;border-radius:25px;text-transform:uppercase}
.logo{height:110px;width:auto;display:block}
.title{font-size:{{titleFontSize}}px;line-height:1.14;overflow-wrap:break-word;margin:0}
.when{font-size:64px;line-height:1.2;color:#285d9d;white-space:nowrap}
.when:empty{display:none}
.stage{display:flex;flex-direction:column;align-items:center;min-height:0}
.portrait{flex:1 1 0;min-height:0;aspect-ratio:1/1;border:9px solid #285d9d;border-radius:50%;object-fit:cover;background:white}
.name{position:relative;margin-top:-78px;max-width:100%;background:#285d9d;color:white;border-radius:25px;padding:16px 60px;font-size:68px;line-height:1.12;text-align:center;overflow-wrap:break-word}`;

const SQUARE_CSS = `html,body{width:2000px;height:2000px}
.canvas{flex-direction:column;width:2000px;height:2000px;padding:110px 140px 120px}
.head{display:flex;align-items:center;justify-content:space-between}
.title{margin-top:60px;text-align:center}
.when{margin-top:36px;text-align:center}
.stage{flex:1 1 0;margin-top:40px}`;

const LANDSCAPE_CSS = `html,body{width:2400px;height:1350px}
.canvas{flex-direction:row;width:2400px;height:1350px;padding:110px 140px 100px;gap:80px}
.left{flex:1 1 0;min-width:0;display:flex;flex-direction:column}
.title{flex:1 1 0;min-height:0;display:flex;align-items:center;overflow:hidden}
.foot{display:flex;align-items:center;justify-content:space-between;gap:40px}
.stage{flex:0 0 820px;align-self:center}.stage .portrait{flex:none;width:100%}`;

function podcastOneSpeakerHtml(layout: 'square' | 'landscape'): string {
  const css = BASE_CSS + (layout === 'square' ? SQUARE_CSS : LANDSCAPE_CSS);
  const person = '<div class="stage"><img class="portrait" src="{{speaker1Portrait}}" alt=""><div class="name">{{speaker1Name}}</div></div>';
  const badge = `<div class="badge">${MIC}<span>{{eventLabel}}</span></div>`;
  const logo = '<img class="logo" src="{{assetLogo}}" alt="DataTalks.Club">';
  const when = '<div class="when">{{eventWhen}}</div>';
  const body = layout === 'square'
    ? `<div class="canvas"><div class="head">${badge}${logo}</div><div class="title">{{title}}</div>${when}${person}</div>`
    : `<div class="canvas"><div class="left">${badge}<div class="title"><span>{{title}}</span></div><div class="foot">${when}${logo}</div></div>${person}</div>`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>{{assetFont}}\n${css}</style></head><body>${body}</body></html>`;
}

export function podcastOneSpeakerTemplate(layout: 'square' | 'landscape'): BannerTemplate {
  return {
    id: `dtc-podcast-${layout}-1-v2`, eventType: 'podcast', layout, speakerCount: 1,
    width: layout === 'square' ? 2000 : 2400, height: layout === 'square' ? 2000 : 1350,
    html: podcastOneSpeakerHtml(layout),
  };
}
