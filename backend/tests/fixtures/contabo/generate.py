"""Regenerate the synthetic outline-only fixture: uv run --no-project --with fonttools generate.py.

Uses the locally installed DejaVu Sans font. No source invoice is read.
"""
from pathlib import Path
import zlib
from fontTools.ttLib import TTFont
from fontTools.pens.basePen import BasePen

font = TTFont('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf')
glyphs = font.getGlyphSet()
cmap = font.getBestCmap()
units = font['head'].unitsPerEm
commands = []

class Pen(BasePen):
    def _moveTo(self, p): commands.append(f'{p[0]:.2f} {p[1]:.2f} m')
    def _lineTo(self, p): commands.append(f'{p[0]:.2f} {p[1]:.2f} l')
    def _curveToOne(self, a, b, c): commands.append(' '.join(f'{v:.2f}' for p in (a,b,c) for v in p)+' c')
    def _closePath(self): commands.append('h')
    def _endPath(self): pass

def text(x, y, value, size=9):
    for char in value:
        name = cmap[ord(char)]
        commands.append(f'q {size/units:.6f} 0 0 {size/units:.6f} {x:.2f} {y:.2f} cm')
        glyphs[name].draw(Pen(glyphs))
        commands.append('f Q')
        x += font['hmtx'][name][0] * size / units

# Positions follow the one-page Contabo layout, with invented customer/number.
text(56, 760, 'CONTABO', 28)
text(340, 790, 'Proforma-Rechnung: 900001000P261021')
text(340, 776, 'Kundennummer:     900001')
text(340, 762, 'Datum:           21.10.2026')
text(340, 748, 'Seite:           1 von 1')
text(56, 710, 'Contabo GmbH', 8)
text(56, 686, 'Synthetic Customer GmbH')
text(56, 672, 'Example Person')
text(56, 658, 'Example Street 1')
text(56, 644, '12345 Example City')
# The only extractable text, matching the reference PDF's failure mode.
commands.append('BT /F1 9 Tf 56 630 Td (VAT-ID: DE123456789) Tj ET')
commands.append('0.92 g 56 548 483 16 re f 0 g')
text(226, 553, 'Wiederkehrende Zahlungen', 10)
text(56, 527, 'Leistung')
text(328, 527, 'Zeitraum')
text(400, 527, 'Anzahl')
text(456, 527, 'Einzelpreis')
text(510, 527, 'Betrag')
text(56, 484, 'Cloud VPS 16 NVMe (2026) (ohne Setup)')
text(335, 484, '1 Monat')
text(411, 484, '2')
text(464, 484, '35,22 €')
text(513, 484, '70,44 €')
text(56, 460, 'Zwischensumme')
text(56, 443, '(Wiederkehrende Zahlungen)', 8)
text(513, 443, '70,44 €')
text(56, 405, 'Gesamt netto')
text(513, 405, '59,19 €')
text(56, 388, '19.0% Umsatzsteuer')
text(513, 388, '11,25 €')
commands.append('56 380 m 539 380 l S')
text(56, 365, 'Gesamt brutto')
text(510, 365, '70,44 €')
text(56, 330, 'Bitte beachten Sie, dass bereits geleistete Zahlungen nicht berücksichtigt sind.', 10)
commands.append('56 108 m 539 108 l S')
text(56, 94, 'Contabo GmbH', 7)
text(56, 83, 'USt-IdNr: DE267602842', 7)
text(380, 94, 'Bank details omitted (synthetic fixture)', 7)
stream = zlib.compress('\n'.join(commands).encode('ascii'), 9)
objects = [b'<< /Type /Catalog /Pages 2 0 R >>', b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    f'<< /Filter /FlateDecode /Length {len(stream)} >>\nstream\n'.encode()+stream+b'\nendstream']
pdf = b'%PDF-1.4\n'
offsets = []
for i, obj in enumerate(objects):
    offsets.append(len(pdf))
    pdf += f'{i+1} 0 obj\n'.encode()+obj+b'\nendobj\n'
xref = len(pdf)
pdf += b'xref\n0 6\n0000000000 65535 f \n'
pdf += ''.join(f'{offset:010d} 00000 n \n' for offset in offsets).encode()
pdf += f'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n'.encode()
Path(__file__).with_name('outline-invoice.pdf').write_bytes(pdf)
