import { XMLParser } from "fast-xml-parser";
import type {
  DocumentExtractedImage,
  DocumentExtractionRequest,
  DocumentExtractionResult,
  DocumentExtractorPlugin,
} from "openclaw/plugin-sdk/document-extractor";

type CanvasLike = {
  toBuffer(type: "image/png"): Buffer;
};

type CanvasModule = {
  createCanvas(width: number, height: number): CanvasLike;
};

type PdfTextItem = {
  str: string;
};

type PdfTextContent = {
  items: Array<PdfTextItem | object>;
};

type PdfViewport = {
  width: number;
  height: number;
};

type PdfPage = {
  getTextContent(): Promise<PdfTextContent>;
  getViewport(params: { scale: number }): PdfViewport;
  render(params: { canvas: unknown; viewport: PdfViewport }): { promise: Promise<void> };
};

type PdfDocument = {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPage>;
};

type PdfJsModule = {
  getDocument(params: { data: Uint8Array; disableWorker?: boolean }): {
    promise: Promise<PdfDocument>;
  };
};

const CANVAS_MODULE = "@napi-rs/canvas";
const PDFJS_MODULE = "pdfjs-dist/legacy/build/pdf.mjs";
const JSZIP_MODULE = "jszip";
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const MAX_EXTRACTED_TEXT_CHARS = 200_000;
const MAX_RENDER_DIMENSION = 10_000;

let canvasModulePromise: Promise<CanvasModule> | null = null;
let pdfJsModulePromise: Promise<PdfJsModule> | null = null;
let jsZipModulePromise: Promise<typeof import("jszip").default> | null = null;

async function loadCanvasModule(): Promise<CanvasModule> {
  if (!canvasModulePromise) {
    canvasModulePromise = (import(CANVAS_MODULE) as Promise<CanvasModule>).catch((err) => {
      canvasModulePromise = null;
      throw new Error("Optional dependency @napi-rs/canvas is required for PDF image extraction", {
        cause: err,
      });
    });
  }
  return canvasModulePromise;
}

async function loadPdfJsModule(): Promise<PdfJsModule> {
  if (!pdfJsModulePromise) {
    pdfJsModulePromise = (import(PDFJS_MODULE) as Promise<PdfJsModule>).catch((err) => {
      pdfJsModulePromise = null;
      throw new Error("Optional dependency pdfjs-dist is required for PDF extraction", {
        cause: err,
      });
    });
  }
  return pdfJsModulePromise;
}

async function loadJsZipModule(): Promise<typeof import("jszip").default> {
  if (!jsZipModulePromise) {
    jsZipModulePromise = import(JSZIP_MODULE)
      .then((mod) => mod.default)
      .catch((err) => {
        jsZipModulePromise = null;
        throw new Error("Optional dependency jszip is required for DOCX extraction", {
          cause: err,
        });
      });
  }
  return jsZipModulePromise;
}

function appendTextWithinLimit(parts: string[], pageText: string, currentLength: number): number {
  if (!pageText) {
    return currentLength;
  }
  const remaining = MAX_EXTRACTED_TEXT_CHARS - currentLength;
  if (remaining <= 0) {
    return currentLength;
  }
  const nextText = pageText.length > remaining ? pageText.slice(0, remaining) : pageText;
  parts.push(nextText);
  return currentLength + nextText.length;
}

function resolveRenderPlan(
  viewport: PdfViewport,
  remainingPixels: number,
): { scale: number; width: number; height: number; pixels: number } | null {
  if (
    remainingPixels <= 0 ||
    !Number.isFinite(viewport.width) ||
    !Number.isFinite(viewport.height) ||
    viewport.width <= 0 ||
    viewport.height <= 0
  ) {
    return null;
  }

  const pagePixels = Math.max(1, viewport.width * viewport.height);
  const maxScale = Math.min(
    1,
    Math.sqrt(remainingPixels / pagePixels),
    MAX_RENDER_DIMENSION / viewport.width,
    MAX_RENDER_DIMENSION / viewport.height,
  );
  if (!Number.isFinite(maxScale) || maxScale <= 0) {
    return null;
  }

  let best: { scale: number; width: number; height: number; pixels: number } | null = null;
  let low = 0;
  let high = maxScale;
  for (let i = 0; i < 32; i += 1) {
    const scale = (low + high) / 2;
    const width = Math.max(1, Math.ceil(viewport.width * scale));
    const height = Math.max(1, Math.ceil(viewport.height * scale));
    const pixels = width * height;
    if (
      width <= MAX_RENDER_DIMENSION &&
      height <= MAX_RENDER_DIMENSION &&
      pixels <= remainingPixels
    ) {
      best = { scale, width, height, pixels };
      low = scale;
    } else {
      high = scale;
    }
  }
  return best;
}

async function extractPdfContent(
  request: DocumentExtractionRequest,
): Promise<DocumentExtractionResult> {
  const pdfJsModule = await loadPdfJsModule();
  const pdf = await pdfJsModule.getDocument({
    data: new Uint8Array(request.buffer),
    disableWorker: true,
  }).promise;

  const effectivePages: number[] = request.pageNumbers
    ? request.pageNumbers.filter((p) => p >= 1 && p <= pdf.numPages).slice(0, request.maxPages)
    : Array.from({ length: Math.min(pdf.numPages, request.maxPages) }, (_, i) => i + 1);

  const textParts: string[] = [];
  let extractedTextLength = 0;
  for (const pageNum of effectivePages) {
    const page = await pdf.getPage(pageNum);
    const textContent = await page.getTextContent();
    const pageText = textContent.items
      .map((item) => ("str" in item ? item.str : ""))
      .filter(Boolean)
      .join(" ");
    if (pageText) {
      extractedTextLength = appendTextWithinLimit(textParts, pageText, extractedTextLength);
      if (extractedTextLength >= MAX_EXTRACTED_TEXT_CHARS) {
        break;
      }
    }
  }

  const text = textParts.join("\n\n");
  if (text.trim().length >= request.minTextChars) {
    return { text, images: [] };
  }

  let canvasModule: CanvasModule;
  try {
    canvasModule = await loadCanvasModule();
  } catch (err) {
    request.onImageExtractionError?.(err);
    return { text, images: [] };
  }

  const images: DocumentExtractedImage[] = [];
  let remainingPixels = Math.max(1, Math.floor(request.maxPixels));

  for (const pageNum of effectivePages) {
    if (remainingPixels <= 0) {
      break;
    }
    const page = await pdf.getPage(pageNum);
    const viewport = page.getViewport({ scale: 1 });
    const plan = resolveRenderPlan(viewport, remainingPixels);
    if (!plan) {
      break;
    }
    const scaled = page.getViewport({ scale: plan.scale });
    const canvas = canvasModule.createCanvas(plan.width, plan.height);
    await page.render({
      canvas: canvas as unknown as HTMLCanvasElement,
      viewport: scaled,
    }).promise;
    const png = canvas.toBuffer("image/png");
    images.push({ type: "image", data: png.toString("base64"), mimeType: "image/png" });
    remainingPixels -= plan.pixels;
  }

  return { text, images };
}

function normalizeDocxText(text: string): string {
  return text
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function localName(name: string): string {
  return name.includes(":") ? (name.split(":").pop() ?? name) : name;
}

function pushDocxRunText(value: unknown, parts: string[]): void {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    parts.push(String(value));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      pushDocxRunText(item, parts);
    }
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    switch (localName(key)) {
      case "t":
        pushDocxRunText(child, parts);
        break;
      case "tab":
        parts.push("\t");
        break;
      case "br":
      case "cr":
        parts.push("\n");
        break;
      default:
        pushDocxRunText(child, parts);
        break;
    }
  }
}

function collectDocxParagraphs(value: unknown, paragraphs: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectDocxParagraphs(item, paragraphs);
    }
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (localName(key) === "p") {
      const paragraphNodes = Array.isArray(child) ? child : [child];
      for (const paragraphNode of paragraphNodes) {
        const parts: string[] = [];
        pushDocxRunText(paragraphNode, parts);
        const paragraph = normalizeDocxText(parts.join(""));
        if (paragraph) {
          paragraphs.push(paragraph);
        }
      }
      continue;
    }
    collectDocxParagraphs(child, paragraphs);
  }
}

async function extractDocxContent(
  request: DocumentExtractionRequest,
): Promise<DocumentExtractionResult> {
  const JSZip = await loadJsZipModule();
  const zip = await JSZip.loadAsync(request.buffer);
  const documentXml = zip.file("word/document.xml");
  if (!documentXml) {
    throw new Error("DOCX missing word/document.xml");
  }

  const xml = await documentXml.async("string");
  const parser = new XMLParser({
    ignoreAttributes: false,
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: false,
  });
  const parsed = parser.parse(xml);
  const paragraphs: string[] = [];
  collectDocxParagraphs(parsed, paragraphs);
  const text = normalizeDocxText(paragraphs.join("\n\n"));
  return { text: text.slice(0, MAX_EXTRACTED_TEXT_CHARS), images: [] };
}

export function createPdfDocumentExtractor(): DocumentExtractorPlugin {
  return {
    id: "pdf",
    label: "PDF",
    mimeTypes: ["application/pdf"],
    autoDetectOrder: 10,
    extract: extractPdfContent,
  };
}

export function createDocxDocumentExtractor(): DocumentExtractorPlugin {
  return {
    id: "docx",
    label: "DOCX",
    mimeTypes: [DOCX_MIME],
    autoDetectOrder: 20,
    extract: extractDocxContent,
  };
}
