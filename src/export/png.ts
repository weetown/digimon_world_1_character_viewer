// ImageData -> PNG bytes via a canvas. Browser only.

export async function imageDataToPng(image: ImageData): Promise<Uint8Array> {
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;

  const context = canvas.getContext("2d");
  if (!context) throw Error("Could not get a 2d canvas context");

  context.putImageData(image, 0, 0);

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/png"),
  );
  if (!blob) throw Error("PNG encoding failed");

  return new Uint8Array(await blob.arrayBuffer());
}

// Cheap content hash for de-duplicating texture states (FNV-1a over the pixel bytes)
export function hashPixels(image: ImageData) {
  let hash = 0x811c9dc5;
  const data = image.data;

  for (let i = 0; i < data.length; i++) {
    hash ^= data[i];
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }

  return `${image.width}x${image.height}:${hash.toString(16)}`;
}
