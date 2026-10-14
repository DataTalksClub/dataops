// Video links that render as players: YouTube, Vimeo and Loom.

export function toVideoEmbed(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    if (host === "youtu.be") {
      const id = u.pathname.replace(/^\//, "");
      if (id) return { src: `https://www.youtube.com/embed/${id}`, kind: "youtube" };
    }
    if (host.endsWith("youtube.com") && u.pathname === "/watch") {
      const id = u.searchParams.get("v");
      if (id) return { src: `https://www.youtube.com/embed/${id}`, kind: "youtube" };
    }
    if (host === "vimeo.com") {
      const id = u.pathname.split("/").filter(Boolean)[0];
      if (id) return { src: `https://player.vimeo.com/video/${id}`, kind: "vimeo" };
    }
    if (host === "loom.com") {
      const match = u.pathname.match(/^\/(?:share|embed)\/([a-z0-9]+)/i);
      if (match) return { src: `https://www.loom.com/embed/${match[1]}`, kind: "loom" };
    }
  } catch {}
  return null;
}
