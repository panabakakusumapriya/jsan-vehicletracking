// AI-powered OCR using Google Gemini Flash Lite (free tier, fastest model)

const GEMINI_API_KEY = import.meta.env.VITE_GEMINI_API_KEY || '';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${GEMINI_API_KEY}`;

export interface OcrResult {
  ssdNumber: string;
  dataUnit: string;
  trackingNumber: string;
  shippingCompany: string;
}

// Compress image to max 800px and JPEG quality 0.7 — much smaller base64, faster upload
function compressImage(file: File): Promise<{ base64: string; mimeType: string }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const MAX = 800;
      let w = img.width, h = img.height;
      if (w > MAX || h > MAX) {
        const scale = MAX / Math.max(w, h);
        w = Math.round(w * scale);
        h = Math.round(h * scale);
      }
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d')!.drawImage(img, 0, 0, w, h);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.7);
      resolve({ base64: dataUrl.split(',')[1], mimeType: 'image/jpeg' });
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

const PROMPT = `Extract from this image. Return ONLY JSON, no explanation.
{"ssdNumber":"","dataUnit":"","trackingNumber":"","shippingCompany":""}
Rules:
- ssdNumber: ONLY if you see the text "SN" or "S/N" printed on a label, capture the alphanumeric code immediately after it. If there is no "SN" or "S/N" text visible, return empty string. Do NOT capture model numbers, brand names, or any other text.
- dataUnit: The number printed directly below the text "SSHD Data Unit #". Typically a 4-6 digit number. Do NOT return zip codes, phone numbers, or address numbers.
- trackingNumber: The number printed next to "TRK#" or above/below a barcode on a shipping label. Return WITHOUT spaces. Do NOT return the small sub-number (like "0430") that appears directly under the TRK# text.
- shippingCompany: "UPS", "FedEx", or "AU Post" only.
Return empty string for any field not visible.`;

async function callGemini(base64: string, mimeType: string): Promise<OcrResult> {
  const response = await fetch(GEMINI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [
        { inlineData: { mimeType, data: base64 } },
        { text: PROMPT },
      ]}],
      generationConfig: { temperature: 0, maxOutputTokens: 200 },
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini OCR failed (${response.status}): ${errText}`);
  }

  const data = await response.json();
  const content = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';

  const jsonStr = content.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  const raw = JSON.parse(jsonStr.match(/\{[\s\S]*\}/)?.[0] || jsonStr);
  return {
    ssdNumber: raw.ssdNumber || '',
    dataUnit: raw.dataUnit || '',
    trackingNumber: (raw.trackingNumber || '').replace(/\s+/g, ''),
    shippingCompany: raw.shippingCompany || '',
  };
}

// Single image extraction
export async function extractFromImage(
  file: File,
  onProgress?: (pct: number) => void,
): Promise<OcrResult> {
  onProgress?.(20);
  const { base64, mimeType } = await compressImage(file);
  onProgress?.(50);
  const result = await callGemini(base64, mimeType);
  onProgress?.(100);
  return result;
}

// Process multiple images in parallel — much faster than sequential
export async function extractFromImages(
  files: File[],
  onProgress?: (pct: number) => void,
): Promise<OcrResult> {
  onProgress?.(10);

  // Compress all images in parallel
  const compressed = await Promise.all(files.map(f => compressImage(f)));
  onProgress?.(30);

  // Call Gemini for all images in parallel
  const results = await Promise.all(compressed.map(c => callGemini(c.base64, c.mimeType)));
  onProgress?.(90);

  // Merge: first non-empty value wins for each field
  const merged: OcrResult = { ssdNumber: '', dataUnit: '', trackingNumber: '', shippingCompany: '' };
  for (const r of results) {
    if (!merged.ssdNumber && r.ssdNumber) merged.ssdNumber = r.ssdNumber;
    if (!merged.dataUnit && r.dataUnit) merged.dataUnit = r.dataUnit;
    if (!merged.trackingNumber && r.trackingNumber) merged.trackingNumber = r.trackingNumber;
    if (!merged.shippingCompany && r.shippingCompany) merged.shippingCompany = r.shippingCompany;
  }
  onProgress?.(100);
  return merged;
}
