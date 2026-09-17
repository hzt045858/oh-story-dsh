import DOMPurify from "dompurify";
import { marked } from "marked";
import { useEffect, useState } from "react";
import { wechatImagePath } from "../wechat-files.js";
import { endpoint } from "./workbench-ui.js";

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_IMAGES = 24;
const RASTER_DATA = /^data:image\/(?:png|jpeg|webp|gif);base64,[a-z0-9+/=\s]+$/iu;

function imageData(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => { reject(new Error("图片读取失败")); };
    reader.onload = () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("图片读取失败"));
    };
    reader.readAsDataURL(blob);
  });
}

interface PreviewFile { readonly path: string; readonly version: string; readonly mimeType?: string | undefined }

/** Render user-authored HTML in an opaque, offline iframe, never in the application's DOM. */
async function previewDocument(content: string, path: string, sessionId: string, files: readonly PreviewFile[], signal: AbortSignal): Promise<{ html: string; missingImages: number }> {
  const html = path.toLowerCase().endsWith(".html") ? content : marked.parse(content, { async: false });
  const fragment = DOMPurify.sanitize(html, {
    RETURN_DOM_FRAGMENT: true,
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["style", "link", "meta", "base", "iframe", "object", "embed", "form", "input", "button", "textarea", "select", "video", "audio", "source"],
    FORBID_ATTR: ["srcset", "poster", "background", "action", "formaction", "ping"]
  });
  for (const link of fragment.querySelectorAll("a")) link.removeAttribute("href");
  let missingImages = 0;
  const available = new Map(files.map((file) => [file.path, file]));
  const images = Array.from(fragment.querySelectorAll("img"));
  await Promise.all(images.map(async (image, index) => {
    const source = image.getAttribute("src") ?? "";
    image.removeAttribute("src");
    try {
      if (index >= MAX_IMAGES) throw new Error("图片数量超出预览限制");
      if (RASTER_DATA.test(source) && source.length <= MAX_IMAGE_BYTES) {
        image.setAttribute("src", source);
        return;
      }
      const imagePath = wechatImagePath(source, path);
      const file = imagePath === undefined ? undefined : available.get(imagePath);
      if (file === undefined || !/^image\/(?:png|jpeg|webp|gif)$/u.test(file.mimeType ?? "")) throw new Error("图片不在当前账号中");
      const response = await fetch(endpoint("media", sessionId, file.path), { signal });
      if (!response.ok || Number(response.headers.get("content-length") ?? 0) > MAX_IMAGE_BYTES) throw new Error("图片无法读取");
      const blob = await response.blob();
      if (blob.size > MAX_IMAGE_BYTES || !/^image\/(?:png|jpeg|webp|gif)$/u.test(blob.type)) throw new Error("图片格式或大小不支持");
      const data = await imageData(blob);
      if (!signal.aborted) image.setAttribute("src", data);
    } catch {
      missingImages += 1;
      const placeholder = document.createElement("p");
      placeholder.className = "missing-image";
      placeholder.textContent = image.alt ? `图片未载入：${image.alt}` : "图片未载入";
      image.replaceWith(placeholder);
    }
  }));
  const body = document.createElement("div");
  body.append(fragment);
  return {
    missingImages,
    html: `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
      *{box-sizing:border-box}html{color:#222;background:#fff}body{margin:0;padding:24px 20px;font:16px/1.8 system-ui,sans-serif;overflow-wrap:anywhere}h1{font-size:24px;line-height:1.45;margin:0 0 24px}h2{font-size:20px}h3{font-size:18px}h1,h2,h3{letter-spacing:0}img{max-width:100%;height:auto}p{margin:0 0 18px}blockquote{margin:20px 0;padding:8px 14px;border-left:3px solid #16845b;background:#f3f7f5}pre{overflow:auto;padding:12px;background:#f4f5f6;font-size:13px}table{display:block;max-width:100%;overflow:auto;border-collapse:collapse}td,th{border:1px solid #ddd;padding:6px 10px}.missing-image{padding:12px;border:1px dashed #aaa;color:#666;font-size:13px}
    </style></head><body>${body.innerHTML}</body></html>`
  };
}

export function WechatPreview({ content, path, sessionId, files }: {
  readonly content: string;
  readonly path: string;
  readonly sessionId: string;
  readonly files: readonly PreviewFile[];
}) {
  const [width, setWidth] = useState<"phone" | "desktop">("phone");
  const [result, setResult] = useState<{ html: string; missingImages: number }>();
  const [error, setError] = useState<string>();
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setResult(undefined);
    setError(undefined);
    void previewDocument(content, path, sessionId, files, controller.signal).then((next) => {
      if (!controller.signal.aborted) setResult(next);
    }).catch((reason: unknown) => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => { controller.abort(); };
  }, [content, path, sessionId, files, revision]);
  return <div className="oh-wechat-preview">
    <div className="oh-wechat-preview-toolbar">
      <span>文章预览</span>
      <div role="group" aria-label="公众号预览宽度">
        {(["phone", "desktop"] as const).map((value) => <button key={value} type="button" aria-pressed={width === value} onClick={() => { setWidth(value); }}>{value === "phone" ? "手机" : "桌面"}</button>)}
      </div>
    </div>
    {error !== undefined ? <div className="oh-story-error" role="alert">{error}<button type="button" onClick={() => { setRevision((value) => value + 1); }}>重试预览</button></div>
      : result === undefined ? <div className="oh-story-empty" role="status">正在生成预览…</div>
      : <>
        {result.missingImages > 0 && <div className="oh-story-warning" role="status">{result.missingImages} 张图片未载入<button type="button" onClick={() => { setRevision((value) => value + 1); }}>重新载入</button></div>}
        <div className="oh-wechat-preview-stage" data-width={width}><iframe title="公众号文章预览" sandbox="" referrerPolicy="no-referrer" srcDoc={result.html} /></div>
      </>}
  </div>;
}
