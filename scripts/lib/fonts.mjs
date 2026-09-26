/**
 * Fetch a Google Fonts stylesheet and inline every font file as a data URL,
 * so headless renders don't depend on the browser having network access.
 */
export async function inlineFonts(cssUrl) {
  const css = await (await fetch(cssUrl)).text();
  const urls = [...new Set(css.match(/https:\/\/[^)]+/g) ?? [])];
  let out = css;
  for (const url of urls) {
    const bytes = Buffer.from(await (await fetch(url)).arrayBuffer());
    const type = url.endsWith(".woff2") ? "font/woff2" : "font/ttf";
    out = out.replaceAll(
      url,
      `data:${type};base64,${bytes.toString("base64")}`,
    );
  }
  return out;
}
