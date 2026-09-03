function hexToRgb(hex) {
  const normalized = String(hex || "").trim().replace(/^#/, "");
  const expanded = normalized.length === 3
    ? normalized.split("").map((character) => character + character).join("")
    : normalized;

  if (!/^[0-9a-f]{6}$/i.test(expanded)) return null;

  return {
    r: Number.parseInt(expanded.slice(0, 2), 16),
    g: Number.parseInt(expanded.slice(2, 4), 16),
    b: Number.parseInt(expanded.slice(4, 6), 16),
  };
}

function rgbToHsl({ r, g, b }) {
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const delta = max - min;
  const lightness = (max + min) / 2;

  if (delta === 0) return { hue: 0, saturation: 0, lightness: lightness * 100 };

  let hue;
  if (max === red) hue = ((green - blue) / delta) % 6;
  else if (max === green) hue = (blue - red) / delta + 2;
  else hue = (red - green) / delta + 4;

  hue = Math.round(hue * 60);
  if (hue < 0) hue += 360;

  const saturation = delta / (1 - Math.abs(2 * lightness - 1));
  return { hue, saturation: saturation * 100, lightness: lightness * 100 };
}

function neutralName(lightness) {
  if (lightness <= 8) return "Black";
  if (lightness <= 22) return "Charcoal";
  if (lightness <= 40) return "Dark Gray";
  if (lightness <= 68) return "Gray";
  if (lightness <= 86) return "Light Gray";
  if (lightness <= 96) return "Off-White";
  return "White";
}

function hueName(hue) {
  if (hue < 15 || hue >= 355) return "Red";
  if (hue < 40) return "Orange";
  if (hue < 68) return "Yellow";
  if (hue < 92) return "Lime Green";
  if (hue < 165) return "Green";
  if (hue < 190) return "Teal";
  if (hue < 205) return "Cyan";
  if (hue < 255) return "Blue";
  if (hue < 290) return "Purple";
  if (hue < 330) return "Magenta";
  return "Pink";
}

export function getColorName(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) return "Custom color";

  const { hue, saturation, lightness } = rgbToHsl(rgb);

  if (lightness <= 3) return "Black";
  if (lightness >= 98) return "White";
  if (saturation < 9) return neutralName(lightness);

  if (hue >= 35 && hue < 65 && lightness > 82 && saturation < 66) return "Beige";
  if (hue >= 40 && hue < 54 && lightness >= 38 && lightness <= 66 && saturation >= 45) return "Gold";
  if (hue >= 18 && hue < 48 && lightness < 34 && saturation >= 20) return "Dark Brown";
  if (hue >= 18 && hue < 48 && lightness < 45 && saturation >= 20) return "Brown";
  if (hue >= 205 && hue < 255 && lightness <= 28 && saturation >= 35) return "Navy Blue";
  if (hue >= 48 && hue < 82 && lightness < 34 && saturation < 72) return "Olive";

  const base = hueName(hue);
  if (lightness < 18) return `Very Dark ${base}`;
  if (lightness < 36) return `Dark ${base}`;
  if (lightness < 44) return `Deep ${base}`;
  if (lightness > 86) return `Pale ${base}`;
  if (lightness > 70) return `Light ${base}`;
  if (saturation < 28) return `Muted ${base}`;
  return base;
}
