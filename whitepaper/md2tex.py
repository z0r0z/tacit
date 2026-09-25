# Regenerates the body of WHITEPAPER.tex from WHITEPAPER.md, keeping the TeX preamble and references.
# Usage: python3 whitepaper/md2tex.py whitepaper/WHITEPAPER.md whitepaper/WHITEPAPER.tex
import re, sys

MD, TEX = sys.argv[1], sys.argv[2]
md = open(MD).read()
tex = open(TEX).read()

def esc_code(s):
    s = s.replace('\\', '\\textbackslash{}')
    # break only at underscores after an OP_/T_ prefix, never right after the prefix
    head, sep, rest = s.partition('_') if s.split('_')[0] in ('OP', 'T') else ('', '', s)
    rest = rest.replace('_', '\\_\\allowbreak{}')
    return (head + '\\_' if sep else '') + rest.replace('#', '\\#').replace('%', '\\%').replace('&', '\\&')

def inline(s):
    out = []
    # split into math, code, text
    for part in re.split(r'(\$[^$]+\$|`[^`]+`)', s):
        if not part:
            continue
        if part.startswith('$'):
            out.append(part)
        elif part.startswith('`'):
            out.append('\\op{' + esc_code(part[1:-1]) + '}')
        else:
            t = part
            t = t.replace('\\', '\\textbackslash{}')
            for a, b in [('&', '\\&'), ('%', '\\%'), ('#', '\\#'), ('_', '\\_')]:
                t = t.replace(a, b)
            t = re.sub(r'\*\*(.+?)\*\*', r'\\textbf{\1}', t)
            t = re.sub(r'\*(.+?)\*', r'\\emph{\1}', t)
            t = t.replace('§', '\\S').replace('—', '---').replace('–', '--').replace('×', '$\\times$')
            out.append(t)
    return ''.join(out)

def table(rows):
    cells = [[c.strip() for c in r.strip().strip('|').split('|')] for r in rows]
    head, body = cells[0], cells[2:]
    n = len(head)
    if n == 2:
        spec = '@{}ll@{}'
    else:
        spec = '@{}l>{\\raggedright}p{0.36\\linewidth}>{\\raggedright\\arraybackslash}p{0.38\\linewidth}@{}'
    L = ['\\begin{center}\\small', '\\begin{tabular}{' + spec + '}', '\\toprule']
    L.append(' & '.join('\\textbf{' + inline(h) + '}' if h else '' for h in head) + ' \\\\')
    L.append('\\midrule')
    for r in body:
        L.append(' & '.join(inline(c) for c in r) + ' \\\\')
    L += ['\\bottomrule', '\\end{tabular}', '\\end{center}']
    return '\n'.join(L)

def blocks(text):
    lines = text.split('\n')
    out, i, glue_next = [], 0, False
    def emit(x, glue=False):
        out.append(('\n' if glue else '\n\n', x))
    while i < len(lines):
        ln = lines[i]
        if not ln.strip():
            i += 1; glue_next = False; continue
        g = glue_next; glue_next = False
        if ln.startswith('## '):
            title = re.sub(r'^## \d+\.\s*', '', ln)
            emit('\\section{' + inline(title) + '}'); i += 1; continue
        if ln.startswith('$$'):
            j = i + 1; body = []
            while not lines[j].startswith('$$'):
                body.append(lines[j]); j += 1
            before = i > 0 and lines[i-1].strip() != ''
            emit('\\[\n' + '\n'.join(body) + '\n\\]', glue=before)
            glue_next = j + 1 < len(lines) and lines[j+1].strip() != ''
            i = j + 1; continue
        if ln.startswith('|'):
            rows = []
            while i < len(lines) and lines[i].startswith('|'):
                rows.append(lines[i]); i += 1
            emit(table(rows)); continue
        m = re.match(r'^(- |\d+\. )', ln)
        if m:
            env = 'itemize' if ln.startswith('- ') else 'enumerate'
            items = []
            while i < len(lines) and (re.match(r'^(- |\d+\. )', lines[i]) or lines[i].startswith('  ')):
                if re.match(r'^(- |\d+\. )', lines[i]):
                    items.append(re.sub(r'^(- |\d+\. )', '', lines[i]))
                else:
                    items[-1] += '\n  ' + lines[i].strip()
                i += 1
            emit('\\begin{' + env + '}\n' + '\n'.join('\\item ' + inline(x) for x in items) + '\n\\end{' + env + '}', glue=g)
            continue
        para = []
        while i < len(lines) and lines[i].strip() and not re.match(r'^(- |\d+\. |\||\$\$|## )', lines[i]):
            para.append(lines[i]); i += 1
        k = i
        while k < len(lines) and not lines[k].strip(): k += 1
        keep = para[-1].rstrip().endswith(':') and k < len(lines) and lines[k].startswith('|')
        emit(('\\needspace{9\\baselineskip}\n' if keep else '') + inline('\n'.join(para)), glue=g)
    return ''.join(sep + x for sep, x in out).lstrip('\n')

# abstract
abs_lines = [l[2:] if l.startswith('> ') else l[1:] for l in md.split('\n') if l.startswith('>')]
abstract = '\n'.join(abs_lines).replace('**Abstract.** ', '')
abstract_tex = '\\begin{abstract}\n\\noindent\n' + blocks(abstract) + '\n\\end{abstract}'

body_md = md[md.index('## 1.'):md.index('\n---\n\n### References')]
body_tex = blocks(body_md)

pre = tex[:tex.index('\\begin{abstract}')]
refs = tex[tex.index('\\section*{References}'):]
open(TEX, 'w').write(pre + abstract_tex + '\n\n' + body_tex + '\n\n' + refs)
