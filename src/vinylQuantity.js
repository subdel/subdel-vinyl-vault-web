export const VINYL_QUANTITIES = Object.freeze([1, 2, 3]);

export function getVinylQuantity(record) {
  return 1 + (Array.isArray(record?.extraDiscs) ? record.extraDiscs.length : 0);
}

export function resizeExtraDiscsForQuantity(record, quantity) {
  const targetLength = Math.max(0, Number(quantity) - 1);
  const existing = Array.isArray(record?.extraDiscs) ? record.extraDiscs : [];

  if (existing.length >= targetLength) return existing.slice(0, targetLength);

  const additions = Array.from({ length: targetLength - existing.length }, () => ({
    colorLabel: record?.finish === "Picture disc" || record?.finish === "Zoetrope" ? "" : record?.colorLabel || "Black",
    colorHex: record?.finish === "Picture disc" || record?.finish === "Zoetrope" ? "" : record?.colorHex || "#161616",
    finish: record?.finish || "Standard (opaque)",
    discImageUrl: "",
    discImageX: 50,
    discImageY: 50,
    discImageZoom: 100,
  }));

  return [...existing, ...additions];
}
