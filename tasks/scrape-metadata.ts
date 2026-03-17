import { task } from "@reload-dev/sdk/task";

interface ScrapePayload {
  url: string;
}

interface PageMetadata {
  url: string;
  title: string | null;
  description: string | null;
  ogImage: string | null;
  ogTitle: string | null;
  ogDescription: string | null;
  favicon: string | null;
  linkCount: number;
  imageCount: number;
  wordCount: number;
  contentLengthBytes: number;
  loadTimeMs: number;
  scrapedAt: string;
}

function extractMeta(html: string, name: string): string | null {
  // Match both name="" and property="" variants
  const nameRe = new RegExp(
    `<meta[^>]*(?:name|property)=["']${name}["'][^>]*content=["']([^"']*)["']`,
    "i",
  );
  const match = html.match(nameRe);
  if (match?.[1]) return match[1];

  // Try reverse attribute order: content before name
  const reverseRe = new RegExp(
    `<meta[^>]*content=["']([^"']*)["'][^>]*(?:name|property)=["']${name}["']`,
    "i",
  );
  const reverseMatch = html.match(reverseRe);
  return reverseMatch?.[1] ?? null;
}

export const scrapeMetadata = task<ScrapePayload, PageMetadata>({
  id: "scrape-metadata",
  queue: "scraping",
  retry: { maxAttempts: 2, minTimeout: 3000, maxTimeout: 10000, factor: 2 },
  run: async (payload) => {
    const { url } = payload;
    console.log(`[scraper] Fetching ${url}...`);

    const start = performance.now();
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; reload-dev-scraper/1.0; +https://reload.dev)",
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(20000),
    });

    if (!res.ok) {
      throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
    }

    const html = await res.text();
    const loadTimeMs = Math.round(performance.now() - start);

    // Extract title
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch?.[1] ? titleMatch[1].trim() : null;

    // Extract meta tags
    const description =
      extractMeta(html, "description") || extractMeta(html, "Description");
    const ogImage = extractMeta(html, "og:image");
    const ogTitle = extractMeta(html, "og:title");
    const ogDescription = extractMeta(html, "og:description");

    // Extract favicon
    const faviconMatch = html.match(
      /<link[^>]*rel=["'](?:shortcut )?icon["'][^>]*href=["']([^"']*)["']/i,
    );
    const favicon = faviconMatch?.[1] ?? null;

    // Count links and images
    const linkCount = (html.match(/<a\s/gi) || []).length;
    const imageCount = (html.match(/<img\s/gi) || []).length;

    // Word count (strip tags, count words)
    const textContent = html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const wordCount = textContent.split(/\s+/).filter(Boolean).length;

    console.log(
      `[scraper] ${url} → "${title}" | ${linkCount} links, ${imageCount} images, ${wordCount} words (${loadTimeMs}ms)`,
    );

    return {
      url,
      title,
      description,
      ogImage,
      ogTitle,
      ogDescription,
      favicon,
      linkCount,
      imageCount,
      wordCount,
      contentLengthBytes: html.length,
      loadTimeMs,
      scrapedAt: new Date().toISOString(),
    };
  },
});
