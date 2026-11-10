"""Injects audit enrichment into the phase sources.

Usage: python enrich.py            (reads src/enrich/*.txt, edits src/*.html in place)
Idempotent: a field is only added when the card doesn't have that kind of section yet
(follow-ups are skipped if the same question text is already present).

File format (one file per phase, e.g. src/enrich/p02.txt):
  @Q 2.2                 question card n="2.2"
  S: detailed explanation (HTML allowed, may continue on following lines)
  H: how it works
  E: real-world example
  C js:                  code block (raw text, escaped automatically) until the next field
  Q: follow-up question  (plain text)
  A: follow-up answer
  N: common wrong answers
  @SCN <title prefix>    scenario card
  Y: symptoms  U: causes  I: investigation  F: fix  G js: code change (or G: text)
  @L <title prefix>      lesson
  W: execution walkthrough   M: extra "going further" section   K js: extra code (goes in M)
"""
import html, re, sys, glob, os

SRC = os.path.join(os.path.dirname(__file__), 'src')
FIELD = re.compile(r'^([SHECQANYUIFGWMK])( [a-z]+)?:\s?(.*)$')


def parse(text):
    blocks = []
    cur = None
    field = None
    for line in text.splitlines():
        if line.startswith('@'):
            kind, _, key = line[1:].partition(' ')
            cur = {'kind': kind, 'key': key.strip(), 'fields': []}
            blocks.append(cur)
            field = None
            continue
        if cur is None:
            continue
        m = FIELD.match(line)
        if m:
            field = [m.group(1), (m.group(2) or '').strip(), m.group(3)]
            cur['fields'].append(field)
        elif field is not None:
            field[2] += '\n' + line
    return blocks


def code_html(lang, body):
    return f'<pre data-l="{lang or "text"}">{html.escape(body.strip(chr(10)), quote=False)}</pre>'


def val(f):
    k, lang, v = f
    if k in 'CGK' and lang:
        return code_html(lang, v)
    return v.strip()


def insert_before_any(block, tags, snippet):
    for t in tags:
        i = block.find(t)
        if i != -1:
            return block[:i] + snippet + block[i:]
    return None


def enrich_q(block, fields):
    changed = False
    tagmap = {'S': 'x-simple', 'H': 'x-how', 'E': 'x-eg'}
    # explanation + how-it-works go right after the short answer (or the existing explanation)
    early = ''
    for k in 'SH':
        for f in fields:
            if f[0] == k and f'<{tagmap[k]}>' not in block:
                early += f'\n<{tagmap[k]}>{val(f)}</{tagmap[k]}>'
    if early:
        ends = [block.rfind(t) + len(t) for t in ('</x-say>', '</x-simple>', '</x-how>') if t in block]
        pos = max(ends) if ends else block.find('>') + 1
        block = block[:pos] + early + block[pos:]
        changed = True
    # examples and code go after the last explanation/example section
    late = ''
    for f in fields:
        if f[0] == 'E' and '<x-eg>' not in block:
            late += f'\n<x-eg>{val(f)}</x-eg>'
        if f[0] == 'C' and val(f) not in block:
            late += f'\n<x-code>{val(f)}</x-code>'
    if late:
        ends = [block.rfind(t) + len(t) for t in ('</x-say>', '</x-simple>', '</x-how>', '</x-eg>', '</x-code>') if t in block]
        pos = max(ends) if ends else block.find('>') + 1
        block = block[:pos] + late + block[pos:]
        changed = True
    # follow-ups (Q then A)
    tail = ''
    qs = [f for f in fields if f[0] in 'QA']
    for i in range(0, len(qs) - 1, 2):
        q, a = qs[i][2].strip(), val(qs[i + 1])
        if html.escape(q) in block or q in block:
            continue
        tail += f'\n<x-fu q="{html.escape(q, quote=True)}">{a}</x-fu>'
    for f in fields:
        if f[0] == 'N' and '<x-no>' not in block:
            tail += f'\n<x-no>{val(f)}</x-no>'
    if tail:
        nb = insert_before_any(block, ['<x-no>', '<x-ev>'], tail + '\n') if '<x-no>' not in tail else insert_before_any(block, ['<x-ev>'], tail + '\n')
        block = nb if nb else block[:-len('</x-q>')] + tail + '\n</x-q>'
        changed = True
    return block, changed


def enrich_scn(block, fields):
    tagmap = {'Y': 'x-sym', 'U': 'x-cause', 'I': 'x-inv', 'F': 'x-fix', 'G': 'x-change'}
    add = ''
    for k in 'YUIFG':
        for f in fields:
            if f[0] == k and f'<{tagmap[k]}>' not in block:
                add += f'\n<{tagmap[k]}>{val(f)}</{tagmap[k]}>'
    if not add:
        return block, False
    i = block.find('</x-sit>')
    i = i + len('</x-sit>') if i != -1 else block.find('>') + 1
    return block[:i] + add + block[i:], True


def enrich_l(block, fields):
    add_w = ''.join(f'\n<x-walk>{val(f)}</x-walk>' for f in fields if f[0] == 'W') if '<x-walk>' not in block else ''
    more = ''
    ms = [f for f in fields if f[0] in 'MK']
    if ms and '<x-more>' not in block:
        more = '\n<x-more>' + ''.join(val(f) for f in ms) + '</x-more>'
    if not add_w and not more:
        return block, False
    if add_w:
        nb = insert_before_any(block, ['<x-mist>', '<x-dm>'], add_w + '\n')
        block = nb if nb else block[:-len('</x-lesson>')] + add_w + '\n</x-lesson>'
    if more:
        block = block[:-len('</x-lesson>')] + more + '\n</x-lesson>'
    return block, True


def main():
    total = {'Q': 0, 'SCN': 0, 'L': 0}
    missing = []
    files = {os.path.basename(p)[:-5]: open(p, encoding='utf-8').read()
             for p in glob.glob(os.path.join(SRC, '*.html'))}
    changed_files = set()
    for ef in sorted(glob.glob(os.path.join(SRC, 'enrich', '*.txt'))):
        phase = os.path.basename(ef)[:-4].split('_')[0]
        # p00_*.txt = search every phase file for the key
        targets = [phase] if phase in files else sorted(files)
        for b in parse(open(ef, encoding='utf-8').read()):
            if b['kind'] == 'Q':
                pat, fn = r'<x-q n="' + re.escape(b['key']) + r'"[^>]*>.*?</x-q>', enrich_q
            elif b['kind'] == 'SCN':
                pat, fn = r'<x-scn t="' + re.escape(b['key']) + r'[^"]*"[^>]*>.*?</x-scn>', enrich_scn
            else:
                pat, fn = r'<x-lesson t="' + re.escape(b['key']) + r'[^"]*"[^>]*>.*?</x-lesson>', enrich_l
            for t in targets:
                m = re.search(pat, files[t], re.S)
                if m:
                    break
            if not m:
                missing.append(f"{phase} {b['kind']} {b['key']}")
                continue
            nb, ch = fn(m.group(0), b['fields'])
            if ch:
                files[t] = files[t][:m.start()] + nb + files[t][m.end():]
                changed_files.add(t)
                total[b['kind']] += 1
    for t in changed_files:
        open(os.path.join(SRC, t + '.html'), 'w', encoding='utf-8').write(files[t])
    print('enriched', total)
    if missing:
        print('NOT FOUND:', *missing, sep='\n  ')
        sys.exit(1)


if __name__ == '__main__':
    main()
