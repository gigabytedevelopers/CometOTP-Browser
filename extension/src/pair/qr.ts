// Draws a QR code on a canvas: dark modules on light with a four-module quiet zone, sharp at any
// pixel ratio. Error correction M copes with the glare of a screen.
import qrcode from 'qrcode-generator';

export function drawQr(canvas: HTMLCanvasElement, text: string): void {
  const code = qrcode(0, 'M');
  code.addData(text, 'Byte');
  code.make();
  const modules = code.getModuleCount();
  const quiet = 4;
  const size = canvas.clientWidth || canvas.width;
  const cell = Math.max(1, Math.floor((size * devicePixelRatio) / (modules + 2 * quiet)));
  const side = cell * (modules + 2 * quiet);
  canvas.width = side;
  canvas.height = side;
  const context = canvas.getContext('2d');
  if (!context) return;
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, side, side);
  context.fillStyle = '#000000';
  for (let row = 0; row < modules; row++) {
    for (let col = 0; col < modules; col++) {
      if (code.isDark(row, col)) context.fillRect((col + quiet) * cell, (row + quiet) * cell, cell, cell);
    }
  }
}
