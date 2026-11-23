/** Read an uploaded image file as a data: URL (browser File or test double). */
function bytesToDataUrl(bytes, mimeType = "image/png") {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  const base64 = typeof globalThis.btoa === "function"
    ? globalThis.btoa(binary)
    : globalThis.Buffer ? globalThis.Buffer.from(bytes).toString("base64") : "";
  return `data:${mimeType || "image/png"};base64,${base64}`;
}

export async function readVisualFileAsDataUrl(file) {
  if (!file) return "";
  if (typeof file.dataUrl === "string" && file.dataUrl) return file.dataUrl;
  if (typeof file.arrayBuffer === "function") {
    const buffer = await file.arrayBuffer();
    return bytesToDataUrl(new Uint8Array(buffer), file.type || "image/png");
  }
  if (typeof globalThis.FileReader === "function") {
    return new Promise((resolve, reject) => {
      const reader = new globalThis.FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error("Could not read image file"));
      reader.readAsDataURL(file);
    });
  }
  return "";
}
