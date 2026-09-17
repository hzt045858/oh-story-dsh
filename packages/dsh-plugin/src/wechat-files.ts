export function isWechatReferencePath(path: string): boolean {
  const parts = path.split("/");
  return parts[0] === "公众号" && parts[2] === "参考文章";
}

/** Article images may reference only raster files belonging to the same account. */
export function wechatImagePath(source: string, article: string): string | undefined {
  if (/^(?:[a-z][\w+.-]*:|[/\\])/iu.test(source.trim()) || source.includes("\\")) return undefined;
  const parts = article.split("/");
  if (parts[0] !== "公众号" || !parts[1]) return undefined;
  try {
    const base = new URL(parts.map(encodeURIComponent).join("/"), "https://wechat.invalid/");
    const path = decodeURIComponent(new URL(source, base).pathname).slice(1);
    if (!path.startsWith(`公众号/${parts[1]}/`) || path.includes("\\")
      || path.split("/").some((part) => part === ".." || part === "." || part === "")
      || !/\.(?:png|jpe?g|webp|gif)$/iu.test(path)) return undefined;
    return path;
  } catch { return undefined; }
}
